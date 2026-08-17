import { z } from "zod";
import { classifyCategory } from "../engine/market-scanner.js";
import type { MarketStatus, PredictionMarket } from "../types.js";

const DEFAULT_PAGE_SIZE = 500;

const KalshiMarketSchema = z
	.object({
		ticker: z.string().min(1),
		event_ticker: z.string().min(1).optional(),
		title: z.string().min(1),
		subtitle: z.string().nullable().optional(),
		status: z.string().optional(),
		yes_bid_dollars: z.union([z.string(), z.number()]).nullish(),
		yes_bid_size_fp: z.union([z.string(), z.number()]).nullish(),
		yes_ask_dollars: z.union([z.string(), z.number()]).nullish(),
		yes_ask_size_fp: z.union([z.string(), z.number()]).nullish(),
		no_bid_dollars: z.union([z.string(), z.number()]).nullish(),
		no_ask_dollars: z.union([z.string(), z.number()]).nullish(),
		last_price_dollars: z.union([z.string(), z.number()]).nullish(),
		volume_fp: z.union([z.string(), z.number()]).nullish(),
		volume_24h_fp: z.union([z.string(), z.number()]).nullish(),
		liquidity_dollars: z.union([z.string(), z.number()]).nullish(),
		close_time: z.string().nullish(),
		expiration_time: z.string().nullish(),
		expected_expiration_time: z.string().nullish(),
		created_time: z.string().nullish(),
		updated_time: z.string().nullish(),
	})
	.passthrough();

const KalshiMarketsResponseSchema = z
	.object({
		markets: z.array(KalshiMarketSchema),
		cursor: z.string().nullable().optional(),
	})
	.passthrough();

const KalshiSeriesSchema = z
	.object({
		ticker: z.string().min(1),
		title: z.string().min(1),
		category: z.string().optional(),
		tags: z.array(z.string()).nullable().optional(),
		volume_fp: z.union([z.string(), z.number()]).nullish(),
		last_updated_ts: z.string().nullish(),
	})
	.passthrough();

const KalshiSeriesResponseSchema = z
	.object({
		series: z.array(KalshiSeriesSchema),
	})
	.passthrough();

export interface KalshiMarket {
	ticker: string;
	event_ticker?: string;
	title: string;
	subtitle?: string | null;
	yes_sub_title?: string | null;
	no_sub_title?: string | null;
	status?: string;
	market_type?: string;
	floor_strike?: string | number | null;
	custom_strike?: Record<string, unknown> | null;
	yes_bid_dollars?: string | number | null;
	yes_bid_size_fp?: string | number | null;
	yes_ask_dollars?: string | number | null;
	yes_ask_size_fp?: string | number | null;
	no_bid_size_fp?: string | number | null;
	no_bid_dollars?: string | number | null;
	no_ask_dollars?: string | number | null;
	no_ask_size_fp?: string | number | null;
	last_price_dollars?: string | number | null;
	volume_fp?: string | number | null;
	volume_24h_fp?: string | number | null;
	liquidity_dollars?: string | number | null;
	close_time?: string | null;
	expiration_time?: string | null;
	expected_expiration_time?: string | null;
	created_time?: string | null;
	updated_time?: string | null;
	rules_primary?: string | null;
}

export interface KalshiSeries {
	ticker: string;
	title: string;
	category?: string;
	tags?: string[] | null;
	volume_fp?: string | number | null;
	last_updated_ts?: string | null;
}

export interface KalshiMarketMapOptions {
	fetchedAt?: string;
}

export interface KalshiClientConfig {
	baseUrl: string;
	pageSize: number;
	maxMarkets: number;
	discoveryMultiplier: number;
	maxDiscoveryMarkets: number;
	timeoutMs: number;
	fetchFn?: typeof fetch;
}

const DEFAULT_CONFIG: KalshiClientConfig = {
	baseUrl: "https://api.elections.kalshi.com/trade-api/v2",
	pageSize: DEFAULT_PAGE_SIZE,
	maxMarkets: 500,
	discoveryMultiplier: 4,
	maxDiscoveryMarkets: 2000,
	timeoutMs: 15000,
};

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function parseNumber(value: string | number | null | undefined, fallback = 0): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function mapStatus(status: string | undefined): MarketStatus {
	switch ((status ?? "").toLowerCase()) {
		case "active":
		case "open":
			return "open";
		case "settled":
		case "resolved":
			return "resolved";
		default:
			return "closed";
	}
}

function reciprocal(price: number): number {
	return clamp01(1 - price);
}

function deriveYesBid(market: KalshiMarket): number {
	const yesBid = parseNumber(market.yes_bid_dollars, Number.NaN);
	if (Number.isFinite(yesBid)) return clamp01(yesBid);
	const noAsk = parseNumber(market.no_ask_dollars, Number.NaN);
	if (Number.isFinite(noAsk)) return reciprocal(noAsk);
	const yesAsk = parseNumber(market.yes_ask_dollars, 0.5);
	return clamp01(yesAsk);
}

function deriveYesAsk(market: KalshiMarket): number {
	const yesAsk = parseNumber(market.yes_ask_dollars, Number.NaN);
	if (Number.isFinite(yesAsk)) return clamp01(yesAsk);
	const noBid = parseNumber(market.no_bid_dollars, Number.NaN);
	if (Number.isFinite(noBid)) return reciprocal(noBid);
	const yesBid = parseNumber(market.yes_bid_dollars, 0.5);
	return clamp01(yesBid);
}

function deriveYesPrice(market: KalshiMarket, yesBid: number, yesAsk: number): number {
	const lastPrice = parseNumber(market.last_price_dollars, Number.NaN);
	if (Number.isFinite(lastPrice) && lastPrice > 0) return clamp01(lastPrice);
	if (yesBid > 0 || yesAsk > 0) return clamp01((yesBid + yesAsk) / 2);
	return 0.5;
}

function deriveLiquidity(market: KalshiMarket, yesBid: number, yesAsk: number): number {
	const reported = parseNumber(market.liquidity_dollars, 0);
	if (reported > 0) return reported;
	const yesBidSize = parseNumber(market.yes_bid_size_fp, 0);
	const yesAskSize = parseNumber(market.yes_ask_size_fp, 0);
	return Math.max(0, yesBid * yesBidSize + yesAsk * yesAskSize);
}

function expiryIso(market: KalshiMarket): string {
	return (
		market.expiration_time ||
		market.close_time ||
		market.expected_expiration_time ||
		new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
	);
}

export function toInternalKalshiMarket(
	raw: KalshiMarket,
	options: KalshiMarketMapOptions = {},
): PredictionMarket {
	const yesBid = deriveYesBid(raw);
	const yesAsk = deriveYesAsk(raw);
	const yesPrice = deriveYesPrice(raw, yesBid, yesAsk);
	const noPrice = reciprocal(yesPrice);
	const volume24h = parseNumber(raw.volume_24h_fp, 0);
	const totalVolume = parseNumber(raw.volume_fp, volume24h);
	const liquidity = deriveLiquidity(raw, yesBid, yesAsk);
	return {
		id: raw.ticker,
		exchange: "kalshi",
		question: raw.title,
		slug: raw.ticker.toLowerCase(),
		category: classifyCategory(raw.title),
		yesPrice,
		noPrice,
		yesBid,
		yesAsk,
		volume24h,
		totalVolume,
		liquidity,
		expiresAt: expiryIso(raw),
		status: mapStatus(raw.status),
		createdAt: raw.created_time ?? undefined,
		updatedAt:
			options.fetchedAt || raw.updated_time || raw.created_time || new Date().toISOString(),
	};
}

export class KalshiClient {
	private readonly config: KalshiClientConfig;
	private readonly fetchImpl: typeof fetch;
	private metrics = {
		requests: 0,
		errors: 0,
		lastFetchMs: 0,
		lastFetchMarkets: 0,
	};

	constructor(config: Partial<KalshiClientConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.fetchImpl = config.fetchFn ?? fetch;
	}

	async fetchActiveMarkets(opts?: { maxMarkets?: number }): Promise<PredictionMarket[]> {
		const t0 = Date.now();
		const maxMarkets = Math.max(1, opts?.maxMarkets ?? this.config.maxMarkets);
		const rawMarkets = await this.fetchRawActiveMarkets({ maxMarkets });
		const allMarkets = rawMarkets.map((market) => toInternalKalshiMarket(market));

		allMarkets.sort((a, b) => {
			if (b.liquidity !== a.liquidity) return b.liquidity - a.liquidity;
			if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
			const spreadA = a.yesAsk - a.yesBid;
			const spreadB = b.yesAsk - b.yesBid;
			if (spreadA !== spreadB) return spreadA - spreadB;
			return a.id.localeCompare(b.id);
		});

		const markets = allMarkets.slice(0, maxMarkets);
		this.metrics.lastFetchMs = Date.now() - t0;
		this.metrics.lastFetchMarkets = markets.length;
		return markets;
	}

	async fetchRawActiveMarkets(opts?: { maxMarkets?: number }): Promise<KalshiMarket[]> {
		const t0 = Date.now();
		const maxMarkets = Math.max(1, opts?.maxMarkets ?? this.config.maxMarkets);
		const discoveryTarget = Math.max(
			maxMarkets,
			Math.min(this.config.maxDiscoveryMarkets, maxMarkets * this.config.discoveryMultiplier),
		);
		const allMarkets: KalshiMarket[] = [];
		let cursor: string | null | undefined;

		while (allMarkets.length < discoveryTarget) {
			const limit = Math.min(this.config.pageSize, discoveryTarget - allMarkets.length);
			const params = new URLSearchParams({
				status: "open",
				mve_filter: "exclude",
				limit: String(limit),
			});
			if (cursor) params.set("cursor", cursor);
			const response = await this.request<unknown>(`/markets?${params.toString()}`);
			const parsed = KalshiMarketsResponseSchema.safeParse(response);
			if (!parsed.success) {
				this.metrics.errors += 1;
				throw new Error(`Kalshi /markets response validation failed: ${parsed.error.message}`);
			}

			allMarkets.push(...(parsed.data.markets as KalshiMarket[]));
			cursor = parsed.data.cursor;

			if (!parsed.data.markets.length || !cursor || parsed.data.markets.length < limit) break;
		}

		const markets = allMarkets.slice(0, discoveryTarget);
		this.metrics.lastFetchMs = Date.now() - t0;
		this.metrics.lastFetchMarkets = markets.length;
		return markets;
	}

	async fetchSeriesList(opts?: {
		category?: string;
		includeProductMetadata?: boolean;
		includeVolume?: boolean;
	}): Promise<KalshiSeries[]> {
		const params = new URLSearchParams();
		if (opts?.category) params.set("category", opts.category);
		if (opts?.includeProductMetadata) params.set("include_product_metadata", "true");
		if (opts?.includeVolume) params.set("include_volume", "true");
		const query = params.toString();
		const response = await this.request<unknown>(`/series${query ? `?${query}` : ""}`);
		const parsed = KalshiSeriesResponseSchema.safeParse(response);
		if (!parsed.success) {
			this.metrics.errors += 1;
			throw new Error(`Kalshi /series response validation failed: ${parsed.error.message}`);
		}
		return parsed.data.series as KalshiSeries[];
	}

	async fetchRawActiveMarketsBySeries(opts: {
		seriesTickers: string[];
		maxMarkets?: number;
		maxMarketsPerSeries?: number;
	}): Promise<KalshiMarket[]> {
		const t0 = Date.now();
		const maxMarkets = Math.max(1, opts.maxMarkets ?? this.config.maxMarkets);
		const maxMarketsPerSeries = Math.max(1, opts.maxMarketsPerSeries ?? maxMarkets);
		const allMarkets: KalshiMarket[] = [];

		for (const seriesTicker of opts.seriesTickers) {
			if (allMarkets.length >= maxMarkets) break;
			let cursor: string | null | undefined;
			let fetchedForSeries = 0;

			while (allMarkets.length < maxMarkets && fetchedForSeries < maxMarketsPerSeries) {
				const remainingTotal = maxMarkets - allMarkets.length;
				const remainingSeries = maxMarketsPerSeries - fetchedForSeries;
				const limit = Math.min(this.config.pageSize, remainingTotal, remainingSeries);
				const params = new URLSearchParams({
					status: "open",
					mve_filter: "exclude",
					limit: String(limit),
					series_ticker: seriesTicker,
				});
				if (cursor) params.set("cursor", cursor);
				const response = await this.request<unknown>(`/markets?${params.toString()}`);
				const parsed = KalshiMarketsResponseSchema.safeParse(response);
				if (!parsed.success) {
					this.metrics.errors += 1;
					throw new Error(`Kalshi /markets response validation failed: ${parsed.error.message}`);
				}

				allMarkets.push(...(parsed.data.markets as KalshiMarket[]));
				fetchedForSeries += parsed.data.markets.length;
				cursor = parsed.data.cursor;

				if (!parsed.data.markets.length || !cursor || parsed.data.markets.length < limit) break;
			}
		}

		const markets = allMarkets.slice(0, maxMarkets);
		this.metrics.lastFetchMs = Date.now() - t0;
		this.metrics.lastFetchMarkets = markets.length;
		return markets;
	}

	async fetchRawActiveMarketsByCategories(opts: {
		categories: string[];
		maxMarkets?: number;
		maxMarketsPerSeries?: number;
		maxSeriesPerCategory?: number;
	}): Promise<KalshiMarket[]> {
		const maxMarkets = Math.max(1, opts.maxMarkets ?? this.config.maxMarkets);
		const maxSeriesPerCategory = Math.max(1, opts.maxSeriesPerCategory ?? 5);
		const seriesTickers = new Set<string>();

		for (const category of opts.categories) {
			const series = await this.fetchSeriesList({ category, includeVolume: true });
			series
				.sort((a, b) => parseNumber(b.volume_fp, 0) - parseNumber(a.volume_fp, 0))
				.slice(0, maxSeriesPerCategory)
				.forEach((item) => {
					seriesTickers.add(item.ticker);
				});
		}

		return this.fetchRawActiveMarketsBySeries({
			seriesTickers: [...seriesTickers],
			maxMarkets,
			maxMarketsPerSeries: opts.maxMarketsPerSeries,
		});
	}

	getMetrics(): typeof this.metrics {
		return { ...this.metrics };
	}

	private async request<T>(path: string): Promise<T> {
		this.metrics.requests += 1;
		const url = `${this.config.baseUrl}${path}`;
		const response = await this.fetchImpl(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});
		if (!response.ok) {
			this.metrics.errors += 1;
			throw new Error(`Kalshi API error: ${response.status} ${response.statusText}`);
		}
		return response.json() as Promise<T>;
	}
}

export function createKalshiFetcher(client: KalshiClient) {
	return async (_exchange: "polymarket" | "kalshi") => {
		return client.fetchActiveMarkets();
	};
}
