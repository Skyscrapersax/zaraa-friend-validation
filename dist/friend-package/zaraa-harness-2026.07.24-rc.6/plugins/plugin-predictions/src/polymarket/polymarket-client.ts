/**
 * PolymarketClient — Reads market data and executes orders on Polymarket.
 *
 * Architecture:
 * - GammaClient fetches market metadata (question, outcomes, volume, etc.)
 * - CLOBClient fetches orderbook data (bid/ask/spread)
 * - CLOB write path handles order placement and cancellation (authenticated)
 * - All paths are rate-limited via TokenBucket
 * - Results are mapped to PredictionMarket via data-mapper
 *
 * Usage:
 *   const client = new PolymarketClient();
 *   const markets = await client.fetchActiveMarkets();
 *
 *   // Authenticated write operations require a private key plus optional cached API creds:
 *   const writeClient = new PolymarketClient({
 *     privateKey: "...",
 *     apiKey: "...",
 *     apiSecret: "...",
 *     apiPassphrase: "...",
 *   });
 *   const order = await writeClient.placeOrder({ ... });
 *   await writeClient.cancelOrder(order.orderID);
 */
import {
	Chain as OfficialClobChain,
	ClobClient as OfficialClobClient,
	OrderType as OfficialClobOrderType,
	Side as OfficialClobSide,
	SignatureType as OfficialSignatureType,
} from "@polymarket/clob-client";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { z } from "zod";
import type { PredictionMarket } from "../types.js";
import type { GammaMarket, CLOBOrderBook } from "./data-mapper.js";
import { toInternalMarket, toInternalBatch, extractTokenIds, getConditionId } from "./data-mapper.js";
import { TokenBucket, POLYMARKET_RATE_LIMITS, rateLimitedFetch } from "./rate-limited-fetcher.js";

// ── Zod Schemas for Polymarket API Responses ──

/** Schema for a single Gamma API market object */
const GammaMarketSchema = z.object({
	condition_id: z.string().optional(),
	conditionId: z.string().optional(),
	question: z.string(),
	slug: z.string(),
	category: z.string().optional(),
	outcomePrices: z.union([z.string(), z.array(z.string())]),
	outcomes: z.union([z.string(), z.array(z.string())]),
	volume: z.union([z.string(), z.number()]).optional(),
	volume24hr: z.union([z.string(), z.number()]).optional(),
	liquidity: z.union([z.string(), z.number()]),
	end_date_iso: z.string().optional(),
	endDate: z.string().optional(),
	active: z.boolean(),
	closed: z.boolean(),
	created_at: z.string().optional(),
	createdAt: z.string().optional(),
	updated_at: z.string().optional(),
	updatedAt: z.string().optional(),
	clob_token_ids: z.union([z.string(), z.array(z.string())]).optional(),
	clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
	description: z.string().optional(),
	new: z.boolean().optional(),
	image: z.string().optional(),
}).passthrough().refine(
	(market) => Boolean(market.condition_id || market.conditionId),
	"condition_id or conditionId is required",
);

/** Schema for an array of Gamma markets (paginated response) */
const GammaMarketsResponseSchema = z.array(GammaMarketSchema);

/** Schema for a single CLOB orderbook entry */
const CLOBOrderEntrySchema = z.object({
	price: z.string(),
	size: z.string(),
}).passthrough();

/** Schema for CLOB orderbook response */
const CLOBOrderBookSchema = z.object({
	bids: z.array(CLOBOrderEntrySchema),
	asks: z.array(CLOBOrderEntrySchema),
}).passthrough();

// ── Write Operation Types ──

/** Side of a prediction market order. */
export type OrderSide = "BUY" | "SELL";

/** Type of order. GTC = Good Til Cancelled, FOK = Fill Or Kill, GTD = Good Til Date. */
export type OrderType = "GTC" | "FOK" | "GTD";

/** Request body for placing an order on the CLOB API. */
export interface PlaceOrderRequest {
	/** CLOB token ID for the outcome (YES or NO token). */
	tokenID: string;
	/** Limit price between 0 and 1 (e.g. 0.55 = $0.55). */
	price: number;
	/** Number of shares to buy/sell. */
	size: number;
	/** BUY or SELL. */
	side: OrderSide;
	/** Order time-in-force. Defaults to GTC. */
	type?: OrderType;
	/** Expiration timestamp in seconds (required for GTD orders). */
	expiration?: number;
	/** Client-assigned nonce for onchain cancellations. */
	nonce?: number | string;
	/** Optional fee rate in basis points. */
	feeRateBps?: number;
	/** Optional taker address override. */
	taker?: string;
	/** Optional tick size hint to avoid an extra lookup. */
	tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
	/** Whether the market uses negative risk. If omitted, the SDK resolves it. */
	negRisk?: boolean;
	/** Whether to defer execution of the posted order. */
	deferExec?: boolean;
	/** Reject the order if it would cross the book immediately. */
	postOnly?: boolean;
}

/** Validated response from a successful order placement. */
export interface PlaceOrderResult {
	/** Exchange-assigned order ID. */
	orderID: string;
	/** Token ID the order was placed on. */
	tokenID: string;
	/** Order side. */
	side: OrderSide;
	/** Limit price submitted. */
	price: number;
	/** Original requested size. */
	originalSize: number;
	/** Remaining unfilled size. */
	remainingSize: number;
	/** Status returned by the exchange (e.g. "live", "matched"). */
	status: string;
	/** Timestamp of order creation (ISO string or epoch). */
	createdAt: string;
}

/** Validated response from a cancel request. */
export interface CancelOrderResult {
	/** The cancelled order ID. */
	orderID: string;
	/** Whether the cancel was acknowledged. */
	cancelled: boolean;
}

/** Validated response from a batch cancel request. */
export interface CancelOrdersResult {
	/** List of cancelled order IDs. */
	cancelledOrders: string[];
	/** List of order IDs that failed to cancel, if any. */
	failedCancellations: string[];
}

const PlaceOrderResponseSchema = z.object({
	orderID: z.string().min(1),
	tokenID: z.string().min(1),
	side: z.enum(["BUY", "SELL"]),
	price: z.union([z.string(), z.number()]).transform(Number),
	originalSize: z.union([z.string(), z.number()]).transform(Number),
	remainingSize: z.union([z.string(), z.number()]).transform(Number).optional().default(0),
	status: z.string(),
	createdAt: z.string().optional().default(() => new Date().toISOString()),
}).passthrough();

const CancelOrderResponseSchema = z.object({
	orderID: z.string().min(1),
	cancelled: z.boolean().optional().default(true),
}).passthrough();

const CancelOrdersResponseSchema = z.object({
	cancelledOrders: z.array(z.string()).optional().default([]),
	failedCancellations: z.array(z.string()).optional().default([]),
}).passthrough();

// ── Write Auth Types ──

export type ClobWriteMethod = "POST" | "DELETE";

export type PolymarketWriteErrorCode =
	| "AUTH_REQUIRED"
	| "AUTH_UNSUPPORTED"
	| "INVALID_REQUEST"
	| "NETWORK"
	| "RATE_LIMIT"
	| "HTTP_ERROR"
	| "RESPONSE_VALIDATION";

export interface ClobWriteRequestContext {
	method: ClobWriteMethod;
	path: string;
	body?: unknown;
	apiKey: string;
	apiSecret: string;
	apiPassphrase?: string;
	funder?: string;
	baseUrl: string;
}

export type ClobAuthHeaderProvider = (
	request: ClobWriteRequestContext,
) => HeadersInit | Promise<HeadersInit>;

export class PolymarketWriteError extends Error {
	code: PolymarketWriteErrorCode;
	details?: unknown;

	constructor(message: string, code: PolymarketWriteErrorCode, details?: unknown) {
		super(message);
		this.name = "PolymarketWriteError";
		this.code = code;
		this.details = details;
	}
}

export type PolymarketChainId = 137 | 80002;
export type PolymarketSignatureType = 0 | 1 | 2;

type OfficialCancelOrdersResponse = {
	canceled?: string[];
	not_canceled?: Record<string, unknown>;
};

type OfficialOrderLookup = {
	id: string;
	status: string;
	asset_id: string;
	side: string;
	original_size: string;
	size_matched: string;
	price: string;
	created_at: number;
};

function isEmptyObject(value: unknown): value is Record<string, never> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function normalizePrivateKey(privateKey: string): Hex {
	const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
	return normalized as Hex;
}

function toOfficialChain(chainId: PolymarketChainId | undefined): OfficialClobChain {
	return chainId === 80002 ? OfficialClobChain.AMOY : OfficialClobChain.POLYGON;
}

function toViemChain(chainId: OfficialClobChain) {
	return chainId === OfficialClobChain.AMOY ? polygonAmoy : polygon;
}

function toOfficialSignatureType(signatureType: PolymarketSignatureType | undefined): OfficialSignatureType {
	switch (signatureType) {
		case 1:
			return OfficialSignatureType.POLY_PROXY;
		case 2:
			return OfficialSignatureType.POLY_GNOSIS_SAFE;
		default:
			return OfficialSignatureType.EOA;
	}
}

function toOfficialOrderSide(side: OrderSide): OfficialClobSide {
	return side === "SELL" ? OfficialClobSide.SELL : OfficialClobSide.BUY;
}

function toOfficialOrderType(type: OrderType | undefined): OfficialClobOrderType {
	switch (type) {
		case "FOK":
			return OfficialClobOrderType.FOK;
		case "GTD":
			return OfficialClobOrderType.GTD;
		default:
			return OfficialClobOrderType.GTC;
	}
}

function parseOrderNonce(nonce: PlaceOrderRequest["nonce"]): number | undefined {
	if (nonce === undefined) return undefined;
	if (typeof nonce === "number" && Number.isInteger(nonce) && nonce >= 0) {
		return nonce;
	}

	const parsed = Number.parseInt(String(nonce), 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new PolymarketWriteError("nonce must be a non-negative integer", "INVALID_REQUEST");
	}
	return parsed;
}

function hasExplicitApiCreds(
	config: PolymarketClientConfig,
): config is PolymarketClientConfig & { apiKey: string; apiSecret: string; apiPassphrase: string } {
	return Boolean(config.apiKey && config.apiSecret && config.apiPassphrase);
}

function hasAnyApiCred(config: PolymarketClientConfig): boolean {
	return Boolean(config.apiKey || config.apiSecret || config.apiPassphrase);
}

function isOfficialOrderLookup(value: unknown): value is OfficialOrderLookup {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string"
		&& typeof record.asset_id === "string"
		&& typeof record.status === "string"
		&& typeof record.original_size === "string"
		&& typeof record.size_matched === "string"
		&& typeof record.price === "string"
		&& typeof record.created_at === "number";
}

function isOfficialCancelResponse(value: unknown): value is OfficialCancelOrdersResponse {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return Array.isArray(record.canceled) || typeof record.not_canceled === "object";
}

// ── Configuration ──

export interface PolymarketClientConfig {
	/** Gamma API base URL */
	gammaBaseUrl: string;
	/** CLOB API base URL */
	clobBaseUrl: string;
	/** Maximum markets to fetch per request (default: 100) */
	pageSize: number;
	/** Maximum total markets to fetch (default: 500) */
	maxMarkets: number;
	/** Whether to fetch orderbook data for each market (default: false for speed) */
	fetchOrderBooks: boolean;
	/** Maximum concurrent orderbook fetches (default: 10) */
	maxConcurrentBookFetches: number;
	/** Request timeout in ms (default: 15000) */
	timeoutMs: number;
	/** API key for authenticated CLOB write operations (order placement/cancel). */
	apiKey?: string;
	/** API secret for authenticated CLOB write operations. */
	apiSecret?: string;
	/** API passphrase paired with the API key + secret. */
	apiPassphrase?: string;
	/** Private key used for L1 auth and EIP-712 order signing. */
	privateKey?: string;
	/** Signature type for the trading wallet (0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE). */
	signatureType?: PolymarketSignatureType;
	/** Polygon mainnet or Amoy testnet. Defaults to Polygon mainnet (137). */
	chainId?: PolymarketChainId;
	/** Funder address override (defaults to signer address for EOA wallets). */
	funder?: string;
	/** Whether to sync timestamps against the Polymarket server for authenticated writes. */
	useServerTime?: boolean;
	/**
	 * Low-level override for manually signed L2 headers.
	 * Prefer `privateKey` + API creds for live trading.
	 */
	clobAuthHeaders?: ClobAuthHeaderProvider;
	/** Custom fetch function (for testing) */
	fetchFn?: typeof fetch;
}

const DEFAULT_CONFIG: PolymarketClientConfig = {
	gammaBaseUrl: "https://gamma-api.polymarket.com",
	clobBaseUrl: "https://clob.polymarket.com",
	pageSize: 100,
	maxMarkets: 500,
	fetchOrderBooks: false,
	maxConcurrentBookFetches: 10,
	timeoutMs: 15000,
};

// ── Client ──

export class PolymarketClient {
	private config: PolymarketClientConfig;
	private gammaBucket: TokenBucket;
	private clobBucket: TokenBucket;
	private clobWriteBucket: TokenBucket;
	private fetchImpl: typeof fetch;
	private officialWriteClientPromise?: Promise<OfficialClobClient>;

	private disposed = false;

	/** Metrics for monitoring */
	private metrics = {
		gammaRequests: 0,
		clobRequests: 0,
		clobWriteRequests: 0,
		errors: 0,
		rateLimitHits: 0,
		timeouts: 0,
		networkErrors: 0,
		lastFetchMs: 0,
		lastFetchMarkets: 0,
	};

	constructor(config: Partial<PolymarketClientConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.gammaBucket = new TokenBucket(POLYMARKET_RATE_LIMITS.gamma);
		this.clobBucket = new TokenBucket(POLYMARKET_RATE_LIMITS.clobRead);
		this.clobWriteBucket = new TokenBucket(POLYMARKET_RATE_LIMITS.clobWrite);
		this.fetchImpl = config.fetchFn ?? fetch;
	}

	/**
	 * Fetch active markets from Polymarket and convert to PredictionMarket[].
	 * This is the primary method for feeding the ScanPipeline.
	 *
	 * @param opts - Override fetch options for this call
	 */
	async fetchActiveMarkets(opts?: {
		maxMarkets?: number;
		fetchOrderBooks?: boolean;
		category?: string;
	}): Promise<PredictionMarket[]> {
		if (this.disposed) throw new Error("PolymarketClient has been disposed");
		const t0 = Date.now();
		const maxMarkets = opts?.maxMarkets ?? this.config.maxMarkets;
		const fetchBooks = opts?.fetchOrderBooks ?? this.config.fetchOrderBooks;

		// Fetch gamma markets (paginated)
		const gammaMarkets = await this.fetchGammaMarkets(maxMarkets, opts?.category);

		// Optionally fetch orderbooks for bid/ask data
		let books: Map<string, CLOBOrderBook> | undefined;
		if (fetchBooks && gammaMarkets.length > 0) {
			books = await this.fetchOrderBooks(gammaMarkets);
		}

		// Map to internal format
		const markets = toInternalBatch(gammaMarkets, books);

		this.metrics.lastFetchMs = Date.now() - t0;
		this.metrics.lastFetchMarkets = markets.length;

		return markets;
	}

	/**
	 * Fetch a single market by condition ID.
	 */
	async fetchMarket(conditionId: string, includeBook = false): Promise<PredictionMarket | null> {
		try {
			const raw = await this.gammaRequest<unknown>(`/markets/${conditionId}`);
			if (!raw) return null;

			const parsed = GammaMarketSchema.safeParse(raw);
			if (!parsed.success) {
				console.warn(`[predictions] Gamma /markets/${conditionId} response validation failed:`, parsed.error.message);
				return null;
			}
			const gamma = parsed.data as GammaMarket;

			let book: CLOBOrderBook | undefined;
			if (includeBook) {
				const tokenIds = extractTokenIds(gamma);
				if (tokenIds.yes) {
					book = await this.fetchSingleBook(tokenIds.yes) ?? undefined;
				}
			}

			return toInternalMarket(gamma, book);
		} catch (err) {
			console.debug("[predictions] fetchMarket failed for " + conditionId + ":", err instanceof Error ? err.message : err);
			return null;
		}
	}

	/**
	 * Fetch orderbook for a specific token ID.
	 */
	async fetchOrderBook(tokenId: string): Promise<CLOBOrderBook | null> {
		return this.fetchSingleBook(tokenId);
	}

	/**
	 * Get the best bid/ask spread for a token.
	 */
	async fetchSpread(tokenId: string): Promise<{ bid: number; ask: number; spread: number } | null> {
		try {
			const book = await this.fetchSingleBook(tokenId);
			if (!book || book.bids.length === 0 || book.asks.length === 0) return null;

			const bid = Number(book.bids[0].price);
			const ask = Number(book.asks[0].price);
			return { bid, ask, spread: ask - bid };
		} catch (err) {
			console.debug("[predictions] fetchSpread failed for token " + tokenId + ":", err instanceof Error ? err.message : err);
			return null;
		}
	}

	// ── Write Operations (authenticated) ──

	/**
	 * Place a limit order on the Polymarket CLOB.
	 * Requires a private key for EIP-712 signing and either cached L2 creds or the ability to derive them.
	 *
	 * @param req - Order parameters (tokenID, price, size, side, optional type/expiration/nonce).
	 * @returns Typed order result with exchange-assigned orderID and fill status.
	 * @throws If auth is not configured, request validation fails, or the exchange rejects the order.
	 */
	async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
		this.validateOrderRequest(req);
		this.metrics.clobWriteRequests++;

		try {
			const client = await this.getOfficialWriteClient();
			const nonce = parseOrderNonce(req.nonce);
			const signedOrder = await client.createOrder(
				{
					tokenID: req.tokenID,
					price: req.price,
					size: req.size,
					side: toOfficialOrderSide(req.side),
					...(req.feeRateBps !== undefined && { feeRateBps: req.feeRateBps }),
					...(nonce !== undefined && { nonce }),
					...(req.expiration !== undefined && { expiration: req.expiration }),
					...(req.taker && { taker: req.taker }),
				},
				{
					...(req.tickSize && { tickSize: req.tickSize }),
					...(req.negRisk !== undefined && { negRisk: req.negRisk }),
				},
			);
			const response = await client.postOrder(
				signedOrder,
				toOfficialOrderType(req.type),
				req.deferExec ?? false,
				req.postOnly ?? false,
			);

			this.assertSuccessfulOfficialOrderResponse(response);

			let orderLookup: unknown;
			try {
				orderLookup = await client.getOrder(response.orderID);
			} catch {
				orderLookup = undefined;
			}

			return this.toPlaceOrderResult(req, response, orderLookup);
		} catch (err) {
			throw this.toWriteError(err, "placeOrder", { tokenID: req.tokenID, side: req.side });
		}
	}

	/**
	 * Cancel a single open order by its exchange-assigned order ID.
	 *
	 * DELETE /order/{orderID} — requests cancellation of the specified order.
	 *
	 * @param orderID - The exchange-assigned order ID to cancel.
	 * @returns Confirmation with the cancelled order ID.
	 * @throws If auth is not configured or the exchange rejects the cancel.
	 */
	async cancelOrder(orderID: string): Promise<CancelOrderResult> {
		if (!orderID) throw new PolymarketWriteError("orderID is required", "INVALID_REQUEST");

		if (this.canUseOfficialWriteClient()) {
			this.metrics.clobWriteRequests++;
			try {
				const client = await this.getOfficialWriteClient();
				const raw = await client.cancelOrder({ orderID });
				return this.toCancelOrderResult(orderID, raw);
			} catch (err) {
				throw this.toWriteError(err, "cancelOrder", { orderID });
			}
		}

		this.requireAuth("cancelOrder");
		const raw = await this.clobWriteRequest<unknown>("DELETE", `/order/${encodeURIComponent(orderID)}`);
		return this.toCancelOrderResult(orderID, raw);
	}

	/**
	 * Cancel multiple open orders in a single request.
	 *
	 * DELETE /orders — batch cancel. The exchange may partially succeed.
	 *
	 * @param orderIDs - Array of order IDs to cancel. Must contain at least one.
	 * @returns Lists of successfully cancelled and failed order IDs.
	 * @throws If auth is not configured or the request fails entirely.
	 */
	async cancelOrders(orderIDs: string[]): Promise<CancelOrdersResult> {
		if (!orderIDs.length) throw new PolymarketWriteError("orderIDs must not be empty", "INVALID_REQUEST");

		if (this.canUseOfficialWriteClient()) {
			this.metrics.clobWriteRequests++;
			try {
				const client = await this.getOfficialWriteClient();
				const raw = await client.cancelOrders(orderIDs);
				return this.toCancelOrdersResult(orderIDs, raw);
			} catch (err) {
				throw this.toWriteError(err, "cancelOrders", { orderIDs });
			}
		}

		this.requireAuth("cancelOrders");
		const raw = await this.clobWriteRequest<unknown>("DELETE", "/orders", { orderIDs });
		return this.toCancelOrdersResult(orderIDs, raw);
	}

	/**
	 * Whether this client is configured for authenticated write operations.
	 */
	get canWrite(): boolean {
		return this.canUseOfficialWriteClient()
			&& (!hasAnyApiCred(this.config) || hasExplicitApiCreds(this.config))
			&& ((this.config.signatureType !== 1 && this.config.signatureType !== 2) || Boolean(this.config.funder));
	}

	/**
	 * Return client metrics for monitoring.
	 */
	getMetrics(): typeof this.metrics & { gammaUtilization: number; clobUtilization: number; clobWriteUtilization: number } {
		return {
			...this.metrics,
			gammaUtilization: this.gammaBucket.utilization,
			clobUtilization: this.clobBucket.utilization,
			clobWriteUtilization: this.clobWriteBucket.utilization,
		};
	}

	/**
	 * Dispose of rate limiter timers. Call on shutdown.
	 */
	dispose(): void {
		this.disposed = true;
		this.gammaBucket.dispose();
		this.clobBucket.dispose();
		this.clobWriteBucket.dispose();
	}

	// ── Private: Gamma API ──

	private async fetchGammaMarkets(maxMarkets: number, category?: string): Promise<GammaMarket[]> {
		const allMarkets: GammaMarket[] = [];
		let offset = 0;

		while (allMarkets.length < maxMarkets) {
			const limit = Math.min(this.config.pageSize, maxMarkets - allMarkets.length);
			const params = new URLSearchParams({
				active: "true",
				closed: "false",
				limit: String(limit),
				offset: String(offset),
			});
			if (category) {
				params.set("tag", category);
			}

			const raw = await this.gammaRequest<unknown>(
				`/markets?${params.toString()}`,
			);

			const parsed = GammaMarketsResponseSchema.safeParse(raw);
			if (!parsed.success) {
				console.warn(`[predictions] Gamma /markets response validation failed (offset=${offset}):`, parsed.error.message);
				break;
			}
			const response = parsed.data as GammaMarket[];

			if (!response || response.length === 0) break;

			allMarkets.push(...response);
			offset += response.length;

			// If we got fewer than requested, we've hit the end
			if (response.length < limit) break;
		}

		return allMarkets;
	}

	private async gammaRequest<T>(path: string): Promise<T> {
		this.metrics.gammaRequests++;
		return rateLimitedFetch(
			async () => {
				const url = `${this.config.gammaBaseUrl}${path}`;
				const response = await this.fetchImpl(url, {
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(this.config.timeoutMs),
				});

				if (!response.ok) {
					throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
				}

				return response.json() as Promise<T>;
			},
			this.gammaBucket,
		);
	}

	// ── Private: CLOB API ──

	private async fetchOrderBooks(gammaMarkets: GammaMarket[]): Promise<Map<string, CLOBOrderBook>> {
		const books = new Map<string, CLOBOrderBook>();
		const maxConcurrent = this.config.maxConcurrentBookFetches;

		// Extract token IDs
		const marketTokens = gammaMarkets
			.map((g) => ({ conditionId: getConditionId(g), ...extractTokenIds(g) }))
			.filter((t) => t.yes !== null);

		// Fetch in batches to respect concurrency limit
		for (let i = 0; i < marketTokens.length; i += maxConcurrent) {
			const batch = marketTokens.slice(i, i + maxConcurrent);
			const results = await Promise.allSettled(
				batch.map(async (t) => {
					const book = await this.fetchSingleBook(t.yes!);
					return { conditionId: t.conditionId, book };
				}),
			);

			for (const result of results) {
				if (result.status === "fulfilled" && result.value.book) {
					books.set(result.value.conditionId, result.value.book);
				}
			}
		}

		return books;
	}

	private async fetchSingleBook(tokenId: string): Promise<CLOBOrderBook | null> {
		this.metrics.clobRequests++;
		try {
			return await rateLimitedFetch(
				async () => {
					const url = `${this.config.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
					const response = await this.fetchImpl(url, {
						headers: { Accept: "application/json" },
						signal: AbortSignal.timeout(this.config.timeoutMs),
					});

					if (!response.ok) {
						if (response.status === 429) this.metrics.rateLimitHits++;
						throw new Error(`CLOB API error: ${response.status} ${response.statusText}`);
					}

					const raw = await response.json();
					const parsed = CLOBOrderBookSchema.safeParse(raw);
					if (!parsed.success) {
						throw new Error(`CLOB /book response validation failed for token ${tokenId}: ${parsed.error.message}`);
					}
					return parsed.data as CLOBOrderBook;
				},
				this.clobBucket,
			);
		} catch (err) {
			this.metrics.errors++;
			const msg = err instanceof Error ? err.message.toLowerCase() : "";
			if (msg.includes("timeout") || msg.includes("abort")) this.metrics.timeouts++;
			else if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("network")) this.metrics.networkErrors++;
			else if (msg.includes("429") || msg.includes("rate")) this.metrics.rateLimitHits++;
			return null;
		}
	}

	private canUseOfficialWriteClient(): boolean {
		return Boolean(this.config.privateKey);
	}

	private async getOfficialWriteClient(): Promise<OfficialClobClient> {
		this.requireOfficialWriteConfig("write operations");
		if (!this.officialWriteClientPromise) {
			this.officialWriteClientPromise = this.createOfficialWriteClient().catch((err) => {
				this.officialWriteClientPromise = undefined;
				throw err;
			});
		}
		return this.officialWriteClientPromise;
	}

	private async createOfficialWriteClient(): Promise<OfficialClobClient> {
		const chainId = toOfficialChain(this.config.chainId);
		const signer = createWalletClient({
			account: privateKeyToAccount(normalizePrivateKey(this.config.privateKey!)),
			chain: toViemChain(chainId),
			transport: http(),
		});
		const signatureType = toOfficialSignatureType(this.config.signatureType);
		const useServerTime = this.config.useServerTime ?? true;

		const creds = hasExplicitApiCreds(this.config)
			? {
				key: this.config.apiKey,
				secret: this.config.apiSecret,
				passphrase: this.config.apiPassphrase,
			}
			: await new OfficialClobClient(
				this.config.clobBaseUrl,
				chainId,
				signer,
				undefined,
				signatureType,
				this.config.funder,
				undefined,
				useServerTime,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			).createOrDeriveApiKey();

		this.config.apiKey = creds.key;
		this.config.apiSecret = creds.secret;
		this.config.apiPassphrase = creds.passphrase;

		return new OfficialClobClient(
			this.config.clobBaseUrl,
			chainId,
			signer,
			creds,
			signatureType,
			this.config.funder,
			undefined,
			useServerTime,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);
	}

	private requireOfficialWriteConfig(operation: string): void {
		if (!this.config.privateKey) {
			throw new PolymarketWriteError(
				`Polymarket ${operation} requires privateKey for L1 auth and EIP-712 order signing`,
				"AUTH_REQUIRED",
			);
		}
		if (hasAnyApiCred(this.config) && !hasExplicitApiCreds(this.config)) {
			throw new PolymarketWriteError(
				"apiKey, apiSecret, and apiPassphrase must all be provided together when supplying cached L2 credentials",
				"INVALID_REQUEST",
			);
		}
		if ((this.config.signatureType === 1 || this.config.signatureType === 2) && !this.config.funder) {
			throw new PolymarketWriteError(
				"signatureType 1 and 2 require a funder address",
				"INVALID_REQUEST",
			);
		}
	}

	private requireAuth(operation: string): void {
		if (this.config.apiKey && this.config.apiSecret && this.config.apiPassphrase) return;
		throw new PolymarketWriteError(
			`Polymarket ${operation} requires apiKey, apiSecret, and apiPassphrase`,
			"AUTH_REQUIRED",
		);
	}

	private validateOrderRequest(req: PlaceOrderRequest): void {
		if (!req.tokenID?.trim()) {
			throw new PolymarketWriteError("tokenID is required", "INVALID_REQUEST");
		}
		if (!Number.isFinite(req.price) || req.price <= 0 || req.price >= 1) {
			throw new PolymarketWriteError("price must be between 0 and 1", "INVALID_REQUEST");
		}
		if (!Number.isFinite(req.size) || req.size <= 0) {
			throw new PolymarketWriteError("size must be greater than 0", "INVALID_REQUEST");
		}
		if (req.type === "GTD" && (!Number.isFinite(req.expiration) || req.expiration === undefined)) {
			throw new PolymarketWriteError("GTD orders require a numeric expiration timestamp", "INVALID_REQUEST");
		}
		if (req.postOnly && req.type === "FOK") {
			throw new PolymarketWriteError("postOnly is not valid with FOK orders", "INVALID_REQUEST");
		}
		parseOrderNonce(req.nonce);
	}

	private assertSuccessfulOfficialOrderResponse(response: unknown): asserts response is { orderID: string; status: string } {
		const record = response as Record<string, unknown> | null;
		if (!record || typeof record !== "object" || typeof record.orderID !== "string") {
			throw new PolymarketWriteError(
				"Unexpected place-order response shape from official Polymarket client",
				"RESPONSE_VALIDATION",
				response,
			);
		}
		if (record.success === false) {
			throw new PolymarketWriteError(
				typeof record.errorMsg === "string" && record.errorMsg.length > 0
					? record.errorMsg
					: "Polymarket rejected the order",
				"HTTP_ERROR",
				response,
			);
		}
	}

	private toPlaceOrderResult(
		req: PlaceOrderRequest,
		response: { orderID: string; status: string },
		orderLookup?: unknown,
	): PlaceOrderResult {
		if (isOfficialOrderLookup(orderLookup)) {
			const originalSize = Number(orderLookup.original_size);
			const matchedSize = Number(orderLookup.size_matched);
			const remainingSize = Number.isFinite(originalSize - matchedSize)
				? Math.max(0, originalSize - matchedSize)
				: req.size;
			const createdAt = new Date(orderLookup.created_at * 1000).toISOString();
			return {
				orderID: orderLookup.id,
				tokenID: orderLookup.asset_id,
				side: orderLookup.side === "SELL" ? "SELL" : "BUY",
				price: Number(orderLookup.price),
				originalSize: Number.isFinite(originalSize) ? originalSize : req.size,
				remainingSize,
				status: orderLookup.status,
				createdAt,
			};
		}

		const fallback = {
			orderID: response.orderID,
			tokenID: req.tokenID,
			side: req.side,
			price: req.price,
			originalSize: req.size,
			remainingSize: response.status === "matched" ? 0 : req.size,
			status: response.status,
			createdAt: new Date().toISOString(),
		};
		const parsed = PlaceOrderResponseSchema.safeParse(fallback);
		if (!parsed.success) {
			throw new PolymarketWriteError(
				`Unexpected synthesized place-order response shape: ${parsed.error.message}`,
				"RESPONSE_VALIDATION",
				fallback,
			);
		}
		return parsed.data;
	}

	private toCancelOrderResult(orderID: string, raw: unknown): CancelOrderResult {
		if (isEmptyObject(raw)) {
			return { orderID, cancelled: true };
		}
		if (isOfficialCancelResponse(raw)) {
			return {
				orderID,
				cancelled: Array.isArray(raw.canceled) && raw.canceled.includes(orderID),
			};
		}
		const parsed = CancelOrderResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new PolymarketWriteError(
				`Unexpected cancel-order response shape: ${parsed.error.message}`,
				"RESPONSE_VALIDATION",
				raw,
			);
		}
		return { orderID, cancelled: parsed.data.cancelled };
	}

	private toCancelOrdersResult(orderIDs: string[], raw: unknown): CancelOrdersResult {
		if (isEmptyObject(raw)) {
			return { cancelledOrders: [...orderIDs], failedCancellations: [] };
		}
		if (isOfficialCancelResponse(raw)) {
			const cancelledOrders = Array.isArray(raw.canceled) ? raw.canceled : [];
			const failedCancellations = raw.not_canceled ? Object.keys(raw.not_canceled) : [];
			return { cancelledOrders, failedCancellations };
		}
		const parsed = CancelOrdersResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new PolymarketWriteError(
				`Unexpected cancel-orders response shape: ${parsed.error.message}`,
				"RESPONSE_VALIDATION",
				raw,
			);
		}
		return parsed.data;
	}

	private toWriteError(err: unknown, operation: string, details?: Record<string, unknown>): PolymarketWriteError {
		if (err instanceof PolymarketWriteError) {
			this.metrics.errors++;
			return err;
		}

		this.metrics.errors++;
		const msg = err instanceof Error ? err.message.toLowerCase() : "";
		if (msg.includes("timeout") || msg.includes("abort")) this.metrics.timeouts++;
		else if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("network")) this.metrics.networkErrors++;
		else if (msg.includes("429") || msg.includes("rate")) this.metrics.rateLimitHits++;

		return new PolymarketWriteError(
			`Polymarket ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
			msg.includes("429") || msg.includes("rate")
				? "RATE_LIMIT"
				: msg.includes("auth") || msg.includes("signature")
					? "AUTH_UNSUPPORTED"
					: "NETWORK",
			{ ...details, cause: err },
		);
	}

	private async clobWriteRequest<T>(method: ClobWriteMethod, path: string, body?: unknown): Promise<T> {
		this.requireAuth(`write request ${method} ${path}`);

		if (!this.config.clobAuthHeaders || !this.config.apiKey || !this.config.apiSecret || !this.config.apiPassphrase) {
			throw new PolymarketWriteError(
				"Low-level Polymarket write requests require clobAuthHeaders plus apiKey/apiSecret/apiPassphrase. Prefer privateKey-backed SDK writes for live order placement.",
				"AUTH_UNSUPPORTED",
			);
		}

		this.metrics.clobWriteRequests++;

		try {
			return await rateLimitedFetch(
				async () => {
					const url = `${this.config.clobBaseUrl}${path}`;
					const headers = new Headers(await this.config.clobAuthHeaders?.({
						method,
						path,
						body,
						apiKey: this.config.apiKey!,
						apiSecret: this.config.apiSecret!,
						apiPassphrase: this.config.apiPassphrase,
						funder: this.config.funder,
						baseUrl: this.config.clobBaseUrl,
					}));
					headers.set("Accept", "application/json");
					if (body !== undefined) {
						headers.set("Content-Type", "application/json");
					}

					const response = await this.fetchImpl(url, {
						method,
						headers,
						...(body !== undefined && { body: JSON.stringify(body) }),
						signal: AbortSignal.timeout(this.config.timeoutMs),
					});

					if (!response.ok) {
						if (response.status === 429) this.metrics.rateLimitHits++;
						const responseText = await response.text().catch(() => "");
						throw new PolymarketWriteError(
							`CLOB write error: ${response.status} ${response.statusText}`,
							response.status === 429 ? "RATE_LIMIT" : "HTTP_ERROR",
							{
								method,
								path,
								status: response.status,
								responseText,
							},
						);
					}

					if (response.status === 204) {
						return {} as T;
					}

					const contentType = response.headers.get("content-type") ?? "";
					if (contentType.includes("application/json")) {
						return response.json() as Promise<T>;
					}

					const responseText = await response.text();
					if (!responseText.trim()) {
						return {} as T;
					}

					try {
						return JSON.parse(responseText) as T;
					} catch {
						throw new PolymarketWriteError(
							"Expected JSON response from Polymarket CLOB write endpoint",
							"RESPONSE_VALIDATION",
							{ method, path, responseText },
						);
					}
				},
				this.clobWriteBucket,
			);
		} catch (err) {
			if (err instanceof PolymarketWriteError) {
				this.metrics.errors++;
				throw err;
			}

			this.metrics.errors++;
			const msg = err instanceof Error ? err.message.toLowerCase() : "";
			if (msg.includes("timeout") || msg.includes("abort")) this.metrics.timeouts++;
			else if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("network")) this.metrics.networkErrors++;
			else if (msg.includes("429") || msg.includes("rate")) this.metrics.rateLimitHits++;

			throw new PolymarketWriteError(
				`Polymarket write request failed: ${err instanceof Error ? err.message : String(err)}`,
				msg.includes("429") || msg.includes("rate") ? "RATE_LIMIT" : "NETWORK",
				{ method, path, cause: err },
			);
		}
	}
}

/**
 * Create a MarketFetcher function compatible with MarketScanner.
 * This bridges PolymarketClient to the existing scanner architecture.
 */
export function createPolymarketFetcher(client: PolymarketClient) {
	return async (_exchange: "polymarket" | "kalshi") => {
		return client.fetchActiveMarkets();
	};
}
