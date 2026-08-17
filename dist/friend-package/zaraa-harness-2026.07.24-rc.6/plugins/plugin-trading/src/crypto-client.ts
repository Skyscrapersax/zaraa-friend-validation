import { createHmac } from "node:crypto";
import { z } from "zod";
import { scrubSecrets } from "./util/scrub-secrets.js";

const BASE = "https://api.crypto.com/v2";

// ── Zod validation schemas for exchange API responses ──

/** Raw ticker entry from Crypto.com API.
 *
 * SAFETY: `z.coerce.number()` alone lets NaN / Infinity through (e.g. when the
 * exchange returns `""` or `null` for a thin market). NaN bid/ask silently
 * propagates through downstream stop-loss direction checks (NaN comparisons
 * are always false), which means a corrupt feed could bypass safety gates.
 * Every numeric field must therefore be both finite and on the right side of
 * zero — prices strictly positive, volumes non-negative, change unrestricted.
 */
const RawTickerSchema = z.object({
	i: z.string().min(1),
	b: z.coerce.number().finite().positive(),
	k: z.coerce.number().finite().positive(),
	a: z.coerce.number().finite().positive(),
	h: z.coerce.number().finite().nonnegative(),
	l: z.coerce.number().finite().nonnegative(),
	v: z.coerce.number().finite().nonnegative(),
	c: z.coerce.number().finite(),
}).passthrough();

/** Ticker list response wrapper */
const TickerListResponseSchema = z.object({
	result: z.object({
		data: z.array(RawTickerSchema),
	}).passthrough(),
}).passthrough();

/** Order book entry tuple [price, quantity, ...rest].
 *
 * Coerces to strings (the exchange wire format), then validates that `Number(...)`
 * yields a finite positive value so corrupt book rows can't slip NaN/Inf into
 * downstream `executionPrice` derivations or impact estimates.
 */
const OrderBookEntryArraySchema = z
	.tuple([z.coerce.string(), z.coerce.string()])
	.rest(z.any())
	.refine(
		([priceStr, qtyStr]) => {
			const p = Number(priceStr);
			const q = Number(qtyStr);
			return Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0;
		},
		{ message: "Order book entry must be [positive price, positive qty]" },
	);

/** Order book response wrapper */
const OrderBookResponseSchema = z.object({
	result: z.object({
		data: z.array(
			z.object({
				bids: z.array(OrderBookEntryArraySchema),
				asks: z.array(OrderBookEntryArraySchema),
			}).passthrough(),
		),
	}).passthrough(),
}).passthrough();

/** Candlestick entry from API.
 *
 * Coerces to strings (wire format), then validates that the OHLCV numbers
 * round-trip to finite positive values so corrupt candles can't poison
 * indicators / ATR-derived stop sizing downstream.
 */
const CandleSchema = z.object({
	t: z.union([z.number(), z.string()]),
	o: z.coerce.string().refine((s) => {
		const n = Number(s);
		return Number.isFinite(n) && n > 0;
	}, { message: "candle open must coerce to positive finite" }),
	h: z.coerce.string().refine((s) => {
		const n = Number(s);
		return Number.isFinite(n) && n > 0;
	}, { message: "candle high must coerce to positive finite" }),
	l: z.coerce.string().refine((s) => {
		const n = Number(s);
		return Number.isFinite(n) && n > 0;
	}, { message: "candle low must coerce to positive finite" }),
	c: z.coerce.string().refine((s) => {
		const n = Number(s);
		return Number.isFinite(n) && n > 0;
	}, { message: "candle close must coerce to positive finite" }),
	v: z.coerce.string().refine((s) => {
		const n = Number(s);
		return Number.isFinite(n) && n >= 0;
	}, { message: "candle volume must coerce to non-negative finite" }),
}).passthrough();

/** Candlestick response wrapper */
const CandleResponseSchema = z.object({
	result: z.object({
		data: z.array(CandleSchema).optional(),
	}).passthrough(),
}).passthrough();

/** Balance entry from account summary.
 *
 * NaN/Infinity balances were treated as "insufficient" everywhere downstream,
 * which silently blocked trades instead of surfacing the upstream feed bug.
 * Reject non-finite values at the boundary so the operator sees the real error.
 */
const BalanceSchema = z.object({
	currency: z.string().min(1),
	available: z.coerce.number().finite().nonnegative(),
	order: z.coerce.number().finite().nonnegative(),
}).passthrough();

/** Account summary response wrapper */
const BalanceListResponseSchema = z.object({
	result: z.object({
		data: z.array(BalanceSchema),
	}).passthrough(),
}).passthrough();

/** Order creation response */
const OrderResponseSchema = z.object({
	result: z.object({
		order_id: z.string().min(1),
		status: z.string().optional(),
	}).passthrough(),
}).passthrough();

/** Cancel order response */
const CancelOrderResponseSchema = z.object({
	result: z.object({
		status: z.string(),
	}).passthrough(),
}).passthrough();

/** Order detail response (private/get-order-detail) */
const OrderDetailResponseSchema = z.object({
	result: z.object({
		order_info: z.object({
			order_id: z.string().min(1),
			status: z.string(),
			cumulative_quantity: z.coerce.string().optional(),
			filled_quantity: z.coerce.string().optional(),
			avg_price: z.coerce.string().optional(),
		}).passthrough(),
	}).passthrough(),
}).passthrough();

/** Open orders response */
const OpenOrdersResponseSchema = z.object({
	result: z.object({
		data: z.array(
			z.object({
				order_id: z.string().min(1),
				instrument_name: z.string().min(1),
				side: z.enum(["BUY", "SELL"]),
				type: z.enum(["MARKET", "LIMIT"]),
				quantity: z.coerce.string(),
				price: z.coerce.string().optional(),
				status: z.string(),
			}).passthrough(),
		).optional(),
	}).passthrough(),
}).passthrough();

/**
 * Run a schema parse and re-wrap the failure with a friendly "validation failed"
 * prefix + the operation context. Keeps the error contract that adapter-layer
 * callers expect (existing tests assert on this string) so the underlying
 * field-level Zod messages don't change the caller-visible behavior.
 *
 * Returning `parse`'s thrown error directly leaked Zod's serialized issue
 * array into the user-facing error, masking the actual symbol/op that failed.
 */
function parseWithFriendlyError<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		const details = result.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
		throw new Error(`Exchange validation failed (${context}): ${details}`);
	}
	return result.data;
}

// Inferred types for better IDE support and type safety
type RawTicker = z.infer<typeof RawTickerSchema>;
type OrderBookResponse = z.infer<typeof OrderBookResponseSchema>;
type CandleData = z.infer<typeof CandleSchema>;
type BalanceData = z.infer<typeof BalanceSchema>;
type OpenOrder = NonNullable<z.infer<typeof OpenOrdersResponseSchema>["result"]["data"]>[number];

/**
 * Simple rate limiter that enforces a minimum gap between API calls.
 *
 * Crypto.com limits:
 *   - Public endpoints:  100 req/s  → we use 1 per 15ms  (~66/s, leaves headroom)
 *   - Private endpoints:  10 req/s  → we use 1 per 120ms (~8/s, leaves headroom)
 *
 * This prevents HTTP 429 "Too Many Requests" errors when Zaraa is running
 * multiple strategies or scanning many symbols at once.
 */
class RateLimiter {
	private lastCallTime = 0;

	constructor(
		/** Minimum milliseconds to wait between consecutive calls */
		private readonly minIntervalMs: number,
	) {}

	async throttle(): Promise<void> {
		const now = Date.now();
		const wait = this.minIntervalMs - (now - this.lastCallTime);
		if (wait > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, wait));
		}
		// Update AFTER the wait so back-to-back calls each get their own slot
		this.lastCallTime = Date.now();
	}
}

export interface Ticker {
	symbol: string;
	bid: number;
	ask: number;
	last: number;
	high24h: number;
	low24h: number;
	volume24h: number;
	change24h: number;
}

export interface OrderBookEntry {
	price: number;
	qty: number;
}

export interface OrderBook {
	symbol: string;
	bids: OrderBookEntry[];
	asks: OrderBookEntry[];
}

export interface TradeResult {
	orderId: string;
	symbol: string;
	side: "BUY" | "SELL";
	type: "MARKET" | "LIMIT";
	/** Filled quantity (e.g. Binance's executedQty). May be less than requestedQty on a partial fill. */
	qty: number;
	/** Quantity originally requested. Optional for backward compatibility with adapters that don't echo it yet. */
	requestedQty?: number;
	price?: number;
	status: string;
}

export interface Balance {
	currency: string;
	available: number;
	locked: number;
	total: number;
}

/** Shape of Crypto.com Exchange API responses */
// biome-ignore lint: API responses have dynamic shapes
interface ApiResponse {
	result: any;
}

export interface CryptoClientConfig {
	apiKey?: string;
	apiSecret?: string;
}

export class CryptoClient {
	readonly exchangeId = "crypto_com";
	private apiKey: string | undefined;
	private apiSecret: string | undefined;

	// Rate limiters — keeps us well under Crypto.com's API limits
	private publicRateLimiter = new RateLimiter(15);   // ~66 req/s (limit: 100)
	private privateRateLimiter = new RateLimiter(120); // ~8 req/s  (limit: 10)

	constructor(config: CryptoClientConfig = {}) {
		this.apiKey = config.apiKey;
		this.apiSecret = config.apiSecret;
	}

	get hasCredentials(): boolean {
		return !!(this.apiKey && this.apiSecret);
	}

	/** Redact API key/secret and common patterns — safe for logs and tool output. */
	scrubError(err: unknown): string {
		const raw = err instanceof Error ? err.message : String(err);
		return scrubSecrets(raw, { apiKey: this.apiKey, apiSecret: this.apiSecret });
	}

	private scrubMsg(text: string): string {
		return scrubSecrets(text, { apiKey: this.apiKey, apiSecret: this.apiSecret });
	}

	// ── Public endpoints (no auth) ──

	async getTicker(symbol: string): Promise<Ticker> {
		const rawData = await this.publicGet("/public/get-ticker", {
			instrument_name: symbol,
		});
		const data = parseWithFriendlyError(
			TickerListResponseSchema,
			rawData,
			`crypto-com:ticker:${symbol}`,
		);
		const t = data.result.data[0];
		if (!t) {
			throw new Error(`Exchange returned no ticker data for ${symbol}`);
		}
		return {
			symbol: t.i,
			bid: t.b,
			ask: t.k,
			last: t.a,
			high24h: t.h,
			low24h: t.l,
			volume24h: t.v,
			change24h: t.c,
		};
	}

	async getTickers(): Promise<Ticker[]> {
		const rawData = await this.publicGet("/public/get-ticker");
		const data = parseWithFriendlyError(
			TickerListResponseSchema,
			rawData,
			"crypto-com:tickers",
		);
		return data.result.data.map(
			(t: RawTicker) => ({
				symbol: t.i,
				bid: t.b,
				ask: t.k,
				last: t.a,
				high24h: t.h,
				low24h: t.l,
				volume24h: t.v,
				change24h: t.c,
			}),
		);
	}

	async getOrderBook(
		symbol: string,
		depth = 10,
	): Promise<OrderBook> {
		const rawData = await this.publicGet("/public/get-book", {
			instrument_name: symbol,
			depth: String(depth),
		});
		const data = parseWithFriendlyError(
			OrderBookResponseSchema,
			rawData,
			`crypto-com:orderbook:${symbol}`,
		);
		const book = data.result.data[0];
		if (!book) {
			throw new Error(`Exchange returned no order book data for ${symbol}`);
		}
		return {
			symbol,
			bids: book.bids.map((e) => ({
				price: Number(e[0]),
				qty: Number(e[1]),
			})),
			asks: book.asks.map((e) => ({
				price: Number(e[0]),
				qty: Number(e[1]),
			})),
		};
	}

	async getCandles(
		symbol: string,
		timeframe: string,
	): Promise<
		{ openTime: number; open: number; high: number; low: number; close: number; volume: number }[]
	> {
		const rawData = await this.publicGet("/public/get-candlestick", {
			instrument_name: symbol,
			timeframe,
		});
		const data = parseWithFriendlyError(
			CandleResponseSchema,
			rawData,
			`crypto-com:candles:${symbol}:${timeframe}`,
		);
		const raw = data.result?.data;
		if (!Array.isArray(raw)) return [];
		return raw.map(
			(c: CandleData) => ({
				openTime: typeof c.t === "number" ? c.t : new Date(c.t).getTime(),
				open: Number(c.o),
				high: Number(c.h),
				low: Number(c.l),
				close: Number(c.c),
				volume: Number(c.v),
			}),
		);
	}

	// ── Private endpoints (require auth) ──

	async getBalances(): Promise<Balance[]> {
		this.requireAuth();
		const rawData = await this.privatePost(
			"/private/get-account-summary",
			{},
		);
		const data = parseWithFriendlyError(
			BalanceListResponseSchema,
			rawData,
			"crypto-com:balances",
		);
		return data.result.data.map(
			(b: BalanceData) => ({
				currency: b.currency,
				available: b.available,
				locked: b.order,
				total: b.available + b.order,
			}),
		);
	}

	async createOrder(params: {
		symbol: string;
		side: "BUY" | "SELL";
		type: "MARKET" | "LIMIT";
		qty: number;
		price?: number;
	}): Promise<TradeResult> {
		this.requireAuth();

		// Pre-flight validation — catch obviously bad orders before they hit the API
		if (!params.symbol || params.symbol.length === 0) {
			throw new Error("Order rejected: symbol is required");
		}
		if (!Number.isFinite(params.qty) || params.qty <= 0) {
			throw new Error("Order rejected: qty must be positive");
		}
		if (params.type === "LIMIT") {
			if (params.price == null || !Number.isFinite(params.price) || params.price <= 0) {
				throw new Error("Order rejected: LIMIT orders require a positive price");
			}
		}

		const body: Record<string, unknown> = {
			instrument_name: params.symbol,
			side: params.side,
			type: params.type,
			quantity: String(params.qty),
		};
		if (params.type === "LIMIT" && params.price != null) {
			body.price = String(params.price);
		}
		const rawData = await this.privatePost(
			"/private/create-order",
			body,
		);

		// Validate the exchange response
		const data = OrderResponseSchema.parse(rawData);

		// Verify the exchange accepted the order
		if (!data.result?.order_id) {
			const safeDetail = this.scrubMsg(JSON.stringify(data.result ?? rawData));
			throw new Error(`Exchange rejected order: ${safeDetail}`);
		}

		return {
			orderId: data.result.order_id,
			symbol: params.symbol,
			side: params.side,
			type: params.type,
			qty: params.qty,
			price: params.price,
			status: data.result.status || "SUBMITTED",
		};
	}

	async cancelOrder(
		symbol: string,
		orderId: string,
	): Promise<{ orderId: string; status: string }> {
		this.requireAuth();
		const rawData = await this.privatePost("/private/cancel-order", {
			instrument_name: symbol,
			order_id: orderId,
		});
		const data = CancelOrderResponseSchema.parse(rawData);
		return {
			orderId,
			status: data.result?.status || "CANCELLED",
		};
	}

	/**
	 * Fetch final status of a specific order (filled qty, avg price, status).
	 * Used for reconciliation after a limit order leaves the open-order book
	 * or after a cancel attempt fails.
	 */
	async getOrderDetail(
		symbol: string,
		orderId: string,
	): Promise<{ orderId: string; status: string; filledQty: number; avgPrice: number }> {
		this.requireAuth();
		const rawData = await this.privatePost("/private/get-order-detail", {
			instrument_name: symbol,
			order_id: orderId,
		});
		const data = OrderDetailResponseSchema.parse(rawData);
		const info = data.result.order_info;
		return {
			orderId: info.order_id,
			status: info.status,
			filledQty: Number(info.cumulative_quantity ?? info.filled_quantity ?? 0),
			avgPrice: Number(info.avg_price ?? 0),
		};
	}

	async getOpenOrders(
		symbol?: string,
	): Promise<TradeResult[]> {
		this.requireAuth();
		const params: Record<string, unknown> = {};
		if (symbol) params.instrument_name = symbol;
		const rawData = await this.privatePost(
			"/private/get-open-orders",
			params,
		);
		const data = OpenOrdersResponseSchema.parse(rawData);
		return (data.result.data || []).map(
			(o: OpenOrder) => ({
				orderId: o.order_id,
				symbol: o.instrument_name,
				side: o.side,
				type: o.type,
				qty: Number(o.quantity),
				price: o.price ? Number(o.price) : undefined,
				status: o.status,
			}),
		);
	}

	// ── Internal ──

	private requireAuth(): void {
		if (!this.apiKey || !this.apiSecret) {
			throw new Error(
				"Trading requires API credentials. Set trading.apiKey and trading.apiSecret in zaraa.config.json",
			);
		}
	}

	private async publicGet(
		path: string,
		params?: Record<string, string>,
	): Promise<ApiResponse> {
		// Throttle before sending to stay within rate limits
		await this.publicRateLimiter.throttle();

		const url = new URL(`${BASE}${path}`);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, v);
			}
		}
		const res = await fetch(url.toString(), {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(this.scrubMsg(`API error ${res.status}: ${body}`));
		}
		// biome-ignore lint: API response is untyped
		const json = (await res.json()) as { code?: number; message?: string; result?: unknown };

		// Same contract as privatePost: Crypto.com returns HTTP 200 with error codes in the body.
		// Without this check, Zod.parse blows up with "result required" instead of a clear exchange error.
		if (json.code != null && json.code !== 0) {
			const detail = json.message || JSON.stringify(json);
			throw new Error(this.scrubMsg(`Exchange error ${json.code}: ${detail}`));
		}

		// Avoid Zod's opaque "result required" when the body is HTTP-200 but incomplete.
		if (json.result === undefined || json.result === null) {
			const detail =
				typeof json.message === "string" && json.message
					? json.message
					: JSON.stringify(json).slice(0, 500);
			throw new Error(this.scrubMsg(`Exchange response missing result field: ${detail}`));
		}

		return json as ApiResponse;
	}

	/** Monotonic counter to prevent nonce collisions */
	private nonceCounter = 0;

	private async privatePost(
		path: string,
		params: Record<string, unknown>,
	): Promise<ApiResponse> {
		// Throttle before sending — private endpoints have a tighter rate limit
		await this.privateRateLimiter.throttle();

		// Use monotonic nonce to avoid collisions on rapid calls
		const now = Date.now();
		this.nonceCounter = Math.max(this.nonceCounter + 1, now);
		const id = this.nonceCounter;
		const method = path.replace("/", "").replace(/\//g, "/");
		const nonce = this.nonceCounter;

		const body = {
			id,
			method,
			params,
			nonce,
			api_key: this.apiKey,
		};

		// Sign: method + id + api_key + sorted_params + nonce
		const paramStr = Object.keys(params)
			.sort()
			.map((k) => `${k}${String(params[k])}`)
			.join("");
		const sigPayload = `${method}${id}${this.apiKey}${paramStr}${nonce}`;
		const sig = createHmac("sha256", this.apiSecret!)
			.update(sigPayload)
			.digest("hex");

		const res = await fetch(`${BASE}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, sig }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(this.scrubMsg(`API error ${res.status}: ${body}`));
		}
		// biome-ignore lint: API response is untyped
		const json = (await res.json()) as any;

		// Crypto.com API returns 200 with error codes in the body
		if (json.code && json.code !== 0) {
			const detail = json.message || JSON.stringify(json);
			throw new Error(this.scrubMsg(`Exchange error ${json.code}: ${detail}`));
		}

		return json;
	}
}
