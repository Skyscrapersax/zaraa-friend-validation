import { z } from "zod";
import type { CryptoClient } from "../crypto-client.js";
import { scrubSecrets } from "../util/scrub-secrets.js";
import type { CandleStore, Candle } from "./candle-store.js";
import { sanitizeCandles } from "./candle-validator.js";

// ── Zod schema for Crypto.com candlestick API response ──
const RawCandleSchema = z.object({
	t: z.union([z.number(), z.string()]),
	o: z.union([z.string(), z.number()]),
	h: z.union([z.string(), z.number()]),
	l: z.union([z.string(), z.number()]),
	c: z.union([z.string(), z.number()]),
	v: z.union([z.string(), z.number()]),
});

const CandlestickResponseSchema = z.object({
	result: z.object({
		data: z.array(RawCandleSchema).nullable().optional(),
	}).passthrough(),
}).passthrough();

/** Timeframes supported by Crypto.com candlestick API */
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

/** Maps our timeframe strings to Crypto.com API period values */
const TIMEFRAME_MAP: Record<Timeframe, string> = {
	"1m": "1m",
	"5m": "5m",
	"15m": "15m",
	"30m": "30m",
	"1h": "1h",
	"4h": "4h",
	"1d": "1D",
};

/** How many milliseconds one candle of a given timeframe represents */
const TIMEFRAME_MS: Record<Timeframe, number> = {
	"1m": 60_000,
	"5m": 5 * 60_000,
	"15m": 15 * 60_000,
	"30m": 30 * 60_000,
	"1h": 60 * 60_000,
	"4h": 4 * 60 * 60_000,
	"1d": 24 * 60 * 60_000,
};

/** Maximum candles returned by a single Crypto.com API call */
const MAX_CANDLES_PER_REQUEST = 300;

const BASE = "https://api.crypto.com/v2";

export interface BackfillResult {
	symbol: string;
	timeframe: Timeframe;
	candlesFetched: number;
	requestsMade: number;
	oldestCandle: number | null;  // Unix ms of oldest fetched candle
	newestCandle: number | null;  // Unix ms of newest fetched candle
}

export interface CandleFetcherConfig {
	client: CryptoClient;
	store: CandleStore;
	/** Symbols to watch (e.g., ["BTC_USDT", "ETH_USDT"]) */
	symbols: string[];
	/** Timeframes to fetch (default: ["5m", "1h", "4h"]) */
	timeframes?: Timeframe[];
}

export class CandleFetcher {
	private client: CryptoClient;
	private store: CandleStore;
	private symbols: string[];
	private timeframes: Timeframe[];

	constructor(config: CandleFetcherConfig) {
		this.client = config.client;
		this.store = config.store;
		this.symbols = config.symbols;
		this.timeframes = config.timeframes ?? ["5m", "1h", "4h"];
	}

	/**
	 * Fetch latest candles for all configured symbols and timeframes.
	 *
	 * Runs all symbol/timeframe pairs concurrently (limited to batches of 6
	 * to avoid overwhelming the exchange API rate limits). Previously these
	 * were sequential — with 5 symbols x 3 timeframes = 15 serial HTTP calls
	 * taking ~15 seconds. Now completes in ~3 seconds.
	 */
	async fetchAll(): Promise<{ fetched: number; errors: string[] }> {
		let fetched = 0;
		const errors: string[] = [];

		// Build all jobs
		const jobs: { symbol: string; tf: Timeframe }[] = [];
		for (const symbol of this.symbols) {
			for (const tf of this.timeframes) {
				jobs.push({ symbol, tf });
			}
		}

		// Process in batches of 6 to respect rate limits
		const BATCH_SIZE = 6;
		for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
			const batch = jobs.slice(i, i + BATCH_SIZE);
			const results = await Promise.allSettled(
				batch.map(({ symbol, tf }) => this.fetchCandles(symbol, tf)),
			);
			for (let j = 0; j < results.length; j++) {
				const result = results[j];
				if (result.status === "fulfilled") {
					fetched += result.value;
				} else {
					const { symbol, tf } = batch[j];
					errors.push(`${symbol}/${tf}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
				}
			}
		}

		return { fetched, errors };
	}

	/** Fetch candles for a single symbol/timeframe pair */
	async fetchCandles(symbol: string, timeframe: Timeframe): Promise<number> {
		const period = TIMEFRAME_MAP[timeframe];
		if (!period) throw new Error(`Unsupported timeframe: ${timeframe}`);

		const url = new URL(`${BASE}/public/get-candlestick`);
		url.searchParams.set("instrument_name", symbol);
		url.searchParams.set("timeframe", period);

		const res = await fetch(url.toString(), {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(scrubSecrets(`API error ${res.status}: ${body}`));
		}

		const json = await res.json();
		const parsed = CandlestickResponseSchema.safeParse(json);
		if (!parsed.success) {
			console.warn(`[candle-fetcher] Invalid API response for ${symbol}/${timeframe}:`, parsed.error.message);
			return 0;
		}
		const rawCandles = parsed.data.result.data;
		if (!rawCandles || rawCandles.length === 0) return 0;

		const rawParsed: Candle[] = [];
		for (const c of rawCandles) {
			const open = Number(c.o);
			const high = Number(c.h);
			const low = Number(c.l);
			const close = Number(c.c);
			const volume = Number(c.v);
			const openTime = typeof c.t === "number" ? c.t : new Date(String(c.t)).getTime();
			rawParsed.push({ symbol, timeframe, openTime, open, high, low, close, volume });
		}
		const candles = sanitizeCandles(rawParsed);

		return this.store.upsert(candles);
	}

	/**
	 * Backfill historical candle data by paginating through the Crypto.com API.
	 *
	 * The API returns up to 300 candles per request. For 90 days of 1h data,
	 * that's 2160 candles = ceil(2160/300) = 8 requests. Fetches in reverse
	 * chronological order using the `end` timestamp for pagination, sleeping
	 * briefly between batches to respect rate limits.
	 *
	 * Upserts into CandleStore, so duplicate candles (same symbol+timeframe+openTime)
	 * are safely deduplicated.
	 */
	async backfill(
		symbol: string,
		timeframe: Timeframe,
		days: number,
	): Promise<BackfillResult> {
		if (days < 1 || days > 365) {
			throw new Error(`Backfill days must be between 1 and 365, got ${days}`);
		}

		const period = TIMEFRAME_MAP[timeframe];
		if (!period) throw new Error(`Unsupported timeframe: ${timeframe}`);

		const candleMs = TIMEFRAME_MS[timeframe];
		const totalCandles = Math.ceil((days * 24 * 60 * 60_000) / candleMs);
		const totalRequests = Math.ceil(totalCandles / MAX_CANDLES_PER_REQUEST);

		let endMs = Date.now();
		let totalFetched = 0;
		let requestsMade = 0;
		let oldestCandle: number | null = null;
		let newestCandle: number | null = null;

		for (let i = 0; i < totalRequests; i++) {
			const candles = await this.fetchCandlePage(symbol, timeframe, period, endMs);
			requestsMade++;

			if (candles.length === 0) break; // No more data available

			const upserted = this.store.upsert(candles);
			totalFetched += upserted;

			// Track range
			for (const c of candles) {
				if (newestCandle === null || c.openTime > newestCandle) newestCandle = c.openTime;
				if (oldestCandle === null || c.openTime < oldestCandle) oldestCandle = c.openTime;
			}

			// Move the end cursor to just before the oldest candle in this batch
			const batchOldest = Math.min(...candles.map((c) => c.openTime));
			endMs = batchOldest - 1;

			// Stop if we've reached beyond our target window
			const targetStart = Date.now() - days * 24 * 60 * 60_000;
			if (batchOldest <= targetStart) break;

			// Rate limit: brief pause between requests (200ms)
			if (i < totalRequests - 1) {
				await new Promise<void>((r) => setTimeout(r, 200));
			}
		}

		return {
			symbol,
			timeframe,
			candlesFetched: totalFetched,
			requestsMade,
			oldestCandle,
			newestCandle,
		};
	}

	/**
	 * Backfill multiple symbols and timeframes at once.
	 * Processes each symbol/timeframe pair sequentially to avoid rate limiting.
	 */
	async backfillAll(
		symbols: string[],
		timeframes: Timeframe[],
		days: number,
	): Promise<{ results: BackfillResult[]; errors: string[] }> {
		const results: BackfillResult[] = [];
		const errors: string[] = [];

		for (const symbol of symbols) {
			for (const tf of timeframes) {
				try {
					const result = await this.backfill(symbol, tf, days);
					results.push(result);
				} catch (err) {
					errors.push(
						`${symbol}/${tf}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		return { results, errors };
	}

	/**
	 * Fetch a single page of candles ending at the given timestamp.
	 * Returns parsed Candle objects sorted by openTime ascending.
	 */
	private async fetchCandlePage(
		symbol: string,
		timeframe: Timeframe,
		period: string,
		endMs: number,
	): Promise<Candle[]> {
		const url = new URL(`${BASE}/public/get-candlestick`);
		url.searchParams.set("instrument_name", symbol);
		url.searchParams.set("timeframe", period);
		// Crypto.com API uses 'end_ts' for pagination — candles before this timestamp
		url.searchParams.set("end_ts", String(endMs));

		const res = await fetch(url.toString(), {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(scrubSecrets(`API error ${res.status}: ${body}`));
		}

		const json = await res.json();
		const parsed = CandlestickResponseSchema.safeParse(json);
		if (!parsed.success) {
			console.warn(`[candle-fetcher] Invalid backfill response for ${symbol}/${timeframe}:`, parsed.error.message);
			return [];
		}
		const rawCandles = parsed.data.result.data;
		if (!rawCandles || rawCandles.length === 0) return [];

		const rawParsed: Candle[] = [];
		for (const c of rawCandles) {
			const open = Number(c.o);
			const high = Number(c.h);
			const low = Number(c.l);
			const close = Number(c.c);
			const volume = Number(c.v);
			const openTime = typeof c.t === "number" ? c.t : new Date(String(c.t)).getTime();
			rawParsed.push({ symbol, timeframe, openTime, open, high, low, close, volume });
		}
		return sanitizeCandles(rawParsed);
	}

	/** Update the watched symbols list */
	setSymbols(symbols: string[]): void {
		this.symbols = symbols;
	}

	/** Update the watched timeframes list */
	setTimeframes(timeframes: Timeframe[]): void {
		this.timeframes = timeframes;
	}

	getSymbols(): string[] {
		return [...this.symbols];
	}

	getTimeframes(): Timeframe[] {
		return [...this.timeframes];
	}
}
