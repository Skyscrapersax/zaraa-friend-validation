/**
 * Binance exchange adapter implementing the Exchange interface.
 * Uses Binance public REST API v3 for market data and HMAC-SHA256
 * signed requests for private endpoints.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { scrubSecrets } from "../util/scrub-secrets.js";
import type { Exchange, CandleData } from "./exchange.js";
import type { Ticker, OrderBook, Balance, TradeResult } from "../crypto-client.js";
import {
	TickerOutputSchema,
	OrderBookOutputSchema,
	CandleOutputSchema,
	BalanceOutputSchema,
	TradeResultOutputSchema,
	validateOutput,
} from "./exchange-schemas.js";

const BASE = "https://api.binance.com";

// ── Symbol Conversion ──

/** Known quote currencies in priority order (longest match first) */
const QUOTE_CURRENCIES = ["USDT", "USDC", "BUSD", "FDUSD", "BTC", "ETH", "BNB"];

/** Convert Binance "BTCUSDT" → Zaraa "BTC_USDT" */
export function toZaraaSymbol(binanceSymbol: string): string {
	for (const quote of QUOTE_CURRENCIES) {
		if (binanceSymbol.endsWith(quote) && binanceSymbol.length > quote.length) {
			return `${binanceSymbol.slice(0, -quote.length)}_${quote}`;
		}
	}
	return binanceSymbol;
}

/** Convert Zaraa "BTC_USDT" → Binance "BTCUSDT" */
export function toBinanceSymbol(zaraaSymbol: string): string {
	return zaraaSymbol.replace("_", "");
}

// ── Timeframe Mapping ──

const TIMEFRAME_MAP: Record<string, string> = {
	"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
	"1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h", "12h": "12h",
	"1d": "1d", "3d": "3d", "1w": "1w", "1M": "1M",
};

export function toBinanceTimeframe(timeframe: string): string {
	return TIMEFRAME_MAP[timeframe] ?? timeframe;
}

// ── Zod Schemas ──

const BinanceTickerSchema = z.object({
	symbol: z.string(),
	bidPrice: z.coerce.string(),
	askPrice: z.coerce.string(),
	lastPrice: z.coerce.string(),
	highPrice: z.coerce.string(),
	lowPrice: z.coerce.string(),
	volume: z.coerce.string(),
	priceChangePercent: z.coerce.string(),
}).passthrough();

const BinanceOrderBookSchema = z.object({
	bids: z.array(z.tuple([z.string(), z.string()])),
	asks: z.array(z.tuple([z.string(), z.string()])),
}).passthrough();

/** Kline array: [openTime, open, high, low, close, volume, closeTime, ...] */
const BinanceKlineSchema = z.tuple([
	z.number(),       // openTime
	z.string(),       // open
	z.string(),       // high
	z.string(),       // low
	z.string(),       // close
	z.string(),       // volume
	z.number(),       // closeTime
]).rest(z.any());

const BinanceAccountSchema = z.object({
	balances: z.array(z.object({
		asset: z.string(),
		free: z.coerce.string(),
		locked: z.coerce.string(),
	})),
}).passthrough();

const BinanceOrderSchema = z.object({
	orderId: z.number(),
	symbol: z.string(),
	side: z.string(),
	type: z.string(),
	executedQty: z.coerce.string(),
	price: z.coerce.string(),
	status: z.string(),
}).passthrough();

const BinanceErrorSchema = z.object({
	code: z.number(),
	msg: z.string(),
});

// ── Error Classification ──
// HTTP 429 (rate-limited, retryable) and HTTP 418 (IP-banned, must NOT be
// retried automatically) must never be conflated with each other or with a
// generic 5xx. See cgc-111 spec.

export type BinanceErrorClass =
	| "RATE_LIMITED" // HTTP 429, or body code -1003/-1015 — retryable after backoff
	| "IP_BANNED" // HTTP 418 — must NOT be retried automatically
	| "SERVER_ERROR" // HTTP 5xx — transient, bounded-retry candidate only
	| "HARD_FAILURE" // body code < 0 other than rate-limit codes, or other 4xx
	| "TRANSPORT_ERROR"; // fetch rejected before a response existed

export interface BinanceErrorClassification {
	errorClass: BinanceErrorClass;
	httpStatus: number;
	bodyCode?: number;
	/** Parsed from the Retry-After header when present, in milliseconds. Never NaN — null when absent/unparseable. */
	retryAfterMs: number | null;
	/**
	 * Parsed ban-duration signal for IP_BANNED responses. Currently sourced from Retry-After
	 * as a conservative floor — VERIFY(Binance API docs) whether the 418 body carries a more
	 * precise ban-duration field before relying on this for anything beyond "do not retry yet".
	 */
	banUntilMs: number | null;
	rawBodyExcerpt: string;
}

/** Error thrown by BinanceAdapter that carries a machine-readable classification. */
export class BinanceAdapterError extends Error {
	readonly classification: BinanceErrorClassification;
	constructor(message: string, classification: BinanceErrorClassification) {
		super(message);
		this.name = "BinanceAdapterError";
		this.classification = classification;
	}
}

/** Body-level Binance error codes that mean "rate limited" even when the HTTP status is 200. */
const RATE_LIMIT_BODY_CODES = new Set([-1003, -1015]);

function parseRetryAfterMs(headers: Headers | Record<string, string> | undefined | null): number | null {
	if (!headers) return null;
	const raw =
		headers instanceof Headers
			? headers.get("Retry-After")
			: (headers["Retry-After"] ?? headers["retry-after"]);
	if (!raw) return null;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return seconds * 1000;
}

/**
 * Classify a Binance response by HTTP status (and, when present, body-level error code)
 * into a distinct error class. Never invoked for transport-level failures (those are
 * TRANSPORT_ERROR by construction — a rejected fetch() never reaches this function).
 */
export function classifyBinanceHttpError(
	httpStatus: number,
	headers: Headers | Record<string, string> | undefined | null,
	bodyText: string,
	bodyCode?: number,
): BinanceErrorClassification {
	const retryAfterMs = parseRetryAfterMs(headers);
	const rawBodyExcerpt = bodyText.slice(0, 200);

	if (httpStatus === 429 || (bodyCode !== undefined && RATE_LIMIT_BODY_CODES.has(bodyCode))) {
		return { errorClass: "RATE_LIMITED", httpStatus, bodyCode, retryAfterMs, banUntilMs: null, rawBodyExcerpt };
	}
	if (httpStatus === 418) {
		return { errorClass: "IP_BANNED", httpStatus, bodyCode, retryAfterMs, banUntilMs: retryAfterMs, rawBodyExcerpt };
	}
	if (httpStatus >= 500) {
		return { errorClass: "SERVER_ERROR", httpStatus, bodyCode, retryAfterMs, banUntilMs: null, rawBodyExcerpt };
	}
	return { errorClass: "HARD_FAILURE", httpStatus, bodyCode, retryAfterMs, banUntilMs: null, rawBodyExcerpt };
}

// ── Adapter ──

export class BinanceAdapter implements Exchange {
	readonly name = "binance";
	readonly label = "Binance";
	private apiKey: string;
	private apiSecret: string;

	constructor(config: { apiKey?: string; apiSecret?: string } = {}) {
		this.apiKey = config.apiKey ?? "";
		this.apiSecret = config.apiSecret ?? "";
	}

	get hasCredentials(): boolean {
		return this.apiKey.length > 0 && this.apiSecret.length > 0;
	}

	private async parseResponseJson<T>(res: Response, context: string): Promise<T> {
		const text = await res.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			const creds = { apiKey: this.apiKey, apiSecret: this.apiSecret };
			const scrubbed = scrubSecrets(text.slice(0, 200), creds);
			const classification = classifyBinanceHttpError(res.status, res.headers, text);
			throw new BinanceAdapterError(`${context}: expected JSON but got: ${scrubbed}`, classification);
		}
	}

	// ── Public Endpoints ──

	async getTicker(symbol: string): Promise<Ticker> {
		const binSym = toBinanceSymbol(symbol);
		const res = await fetch(`${BASE}/api/v3/ticker/24hr?symbol=${binSym}`);
		const raw = await this.parseResponseJson<unknown>(res, "getTicker");
		this.checkError(raw, res.status, res.headers);
		const parsed = BinanceTickerSchema.parse(raw);
		const ticker = {
			symbol,
			bid: Number(parsed.bidPrice),
			ask: Number(parsed.askPrice),
			last: Number(parsed.lastPrice),
			high24h: Number(parsed.highPrice),
			low24h: Number(parsed.lowPrice),
			volume24h: Number(parsed.volume),
			change24h: Number(parsed.priceChangePercent),
		};
		return validateOutput(TickerOutputSchema, ticker, "binance:ticker") as Ticker;
	}

	async getOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
		const binSym = toBinanceSymbol(symbol);
		const res = await fetch(`${BASE}/api/v3/depth?symbol=${binSym}&limit=${depth}`);
		const raw = await this.parseResponseJson<unknown>(res, "getOrderBook");
		this.checkError(raw, res.status, res.headers);
		const parsed = BinanceOrderBookSchema.parse(raw);
		const book = {
			symbol,
			bids: parsed.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
			asks: parsed.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
		};
		return validateOutput(OrderBookOutputSchema, book, "binance:orderbook") as OrderBook;
	}

	async getCandles(symbol: string, timeframe: string): Promise<CandleData[]> {
		const binSym = toBinanceSymbol(symbol);
		const interval = toBinanceTimeframe(timeframe);
		const res = await fetch(`${BASE}/api/v3/klines?symbol=${binSym}&interval=${interval}&limit=200`);
		const raw = await this.parseResponseJson<unknown>(res, "getCandles");
		this.checkError(raw, res.status, res.headers);
		const klines = z.array(BinanceKlineSchema).parse(raw);
		const candles = klines.map((k) => ({
			openTime: k[0],
			open: Number(k[1]),
			high: Number(k[2]),
			low: Number(k[3]),
			close: Number(k[4]),
			volume: Number(k[5]),
		}));
		return candles.map((c) => validateOutput(CandleOutputSchema, c, "binance:candle") as CandleData);
	}

	// ── Private Endpoints ──

	async getBalances(): Promise<Balance[]> {
		this.requireCredentials();
		const raw = await this.signedRequest("GET", "/api/v3/account");
		const parsed = BinanceAccountSchema.parse(raw);
		return parsed.balances
			.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0)
			.map((b) => {
				const balance = {
					currency: b.asset,
					available: Number(b.free),
					locked: Number(b.locked),
					total: Number(b.free) + Number(b.locked),
				};
				return validateOutput(BalanceOutputSchema, balance, "binance:balance") as Balance;
			});
	}

	async createOrder(params: {
		symbol: string;
		side: "BUY" | "SELL";
		type: "MARKET" | "LIMIT";
		qty: number;
		price?: number;
	}): Promise<TradeResult> {
		this.requireCredentials();
		const body: Record<string, string> = {
			symbol: toBinanceSymbol(params.symbol),
			side: params.side,
			type: params.type,
			quantity: String(params.qty),
		};
		if (params.type === "LIMIT" && params.price) {
			body.price = String(params.price);
			body.timeInForce = "GTC";
		}
		const raw = await this.signedRequest("POST", "/api/v3/order", body);
		const parsed = BinanceOrderSchema.parse(raw);
		const result = {
			orderId: String(parsed.orderId),
			symbol: params.symbol,
			side: params.side,
			type: params.type,
			qty: Number(parsed.executedQty),
			price: Number(parsed.price),
			status: parsed.status,
		};
		return validateOutput(TradeResultOutputSchema, result, "binance:createOrder") as TradeResult;
	}

	async cancelOrder(symbol: string, orderId: string): Promise<{ orderId: string; status: string }> {
		this.requireCredentials();
		const raw = await this.signedRequest("DELETE", "/api/v3/order", {
			symbol: toBinanceSymbol(symbol),
			orderId,
		});
		const parsed = BinanceOrderSchema.parse(raw);
		return { orderId: String(parsed.orderId), status: parsed.status };
	}

	async getOpenOrders(symbol?: string): Promise<TradeResult[]> {
		this.requireCredentials();
		const params: Record<string, string> = {};
		if (symbol) params.symbol = toBinanceSymbol(symbol);
		const raw = await this.signedRequest("GET", "/api/v3/openOrders", params);
		const orders = z.array(BinanceOrderSchema).parse(raw);
		return orders.map((o) => {
			const result = {
				orderId: String(o.orderId),
				symbol: toZaraaSymbol(o.symbol),
				side: o.side as "BUY" | "SELL",
				type: o.type as "MARKET" | "LIMIT",
				qty: Number(o.executedQty),
				price: Number(o.price),
				status: o.status,
			};
			return validateOutput(TradeResultOutputSchema, result, "binance:openOrders") as TradeResult;
		});
	}

	// ── Signing ──

	/** Generate HMAC-SHA256 signature for Binance authenticated requests */
	signQuery(queryString: string): string {
		return createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
	}

	private async signedRequest(method: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
		params.timestamp = String(Date.now());
		params.recvWindow = "5000";
		const queryString = new URLSearchParams(params).toString();
		const signature = this.signQuery(queryString);
		const url = `${BASE}${path}?${queryString}&signature=${signature}`;

		const res = await fetch(url, {
			method,
			headers: {
				"X-MBX-APIKEY": this.apiKey,
				"Content-Type": "application/x-www-form-urlencoded",
			},
		});

		const raw = await this.parseResponseJson<unknown>(res, `signedRequest ${method} ${path}`);
		this.checkError(raw, res.status, res.headers);
		return raw;
	}

	private requireCredentials(): void {
		if (!this.hasCredentials) {
			throw new Error("Binance API credentials required for this operation");
		}
	}

	private checkError(data: unknown, httpStatus: number, headers?: Headers | Record<string, string>): void {
		if (typeof data === "object" && data !== null && "code" in data) {
			const result = BinanceErrorSchema.safeParse(data);
			if (result.success && result.data.code < 0) {
				const msg = scrubSecrets(result.data.msg, {
					apiKey: this.apiKey,
					apiSecret: this.apiSecret,
				});
				const classification = classifyBinanceHttpError(
					httpStatus,
					headers,
					JSON.stringify(data),
					result.data.code,
				);
				throw new BinanceAdapterError(`Binance API error ${result.data.code}: ${msg}`, classification);
			}
		}
	}
}
