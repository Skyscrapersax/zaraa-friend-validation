/**
 * Multi-asset historical data fetcher.
 *
 * Primary source is Yahoo Finance daily bars. For assets whose live-friendly ticker is
 * younger than the underlying regime we want to study, older history is backfilled with
 * a normalized proxy:
 * - `SPY` <= `^GSPC`
 * - `GLD` / `IAU` <= `GC=F`
 * - `SLV` <= `SI=F`
 * - `BTC-USD` / `ETH-USD` <= CryptoCompare daily history
 */

export interface OHLCVBar {
	date: string;      // ISO-8601 date (YYYY-MM-DD)
	timestamp: number; // Unix ms
	open: number;
	high: number;
	low: number;
	close: number;
	adjClose: number;
	volume: number;
}

export interface AssetSeries {
	symbol: string;
	name: string;
	assetClass: "equity" | "precious_metal" | "crypto";
	bars: OHLCVBar[];
	currency: string;
}

export interface FetchResult {
	series: AssetSeries[];
	errors: { symbol: string; error: string }[];
	fetchedAt: string;
	sourcesUsed: string[];
	seriesSources: Record<string, string[]>;
}

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const CRYPTOCOMPARE_BASE = "https://min-api.cryptocompare.com/data/v2/histoday";
const DAY_MS = 86_400_000;
const SCALE_OVERLAP_BARS = 30;

type SourceProvider = "yahoo" | "cryptocompare";

interface SourcePlan {
	provider: SourceProvider;
	sourceSymbol: string;
}

const ASSET_META: Record<string, { name: string; assetClass: AssetSeries["assetClass"] }> = {
	"SPY": { name: "SPDR S&P 500 ETF", assetClass: "equity" },
	"QQQ": { name: "Invesco QQQ (Nasdaq-100)", assetClass: "equity" },
	"GLD": { name: "SPDR Gold Shares", assetClass: "precious_metal" },
	"SLV": { name: "iShares Silver Trust", assetClass: "precious_metal" },
	"IAU": { name: "iShares Gold Trust", assetClass: "precious_metal" },
	"BTC-USD": { name: "Bitcoin USD", assetClass: "crypto" },
	"ETH-USD": { name: "Ethereum USD", assetClass: "crypto" },
};

const EXTENDED_HISTORY_PLANS: Partial<Record<string, SourcePlan>> = {
	"SPY": {
		provider: "yahoo",
		sourceSymbol: "^GSPC",
	},
	"GLD": {
		provider: "yahoo",
		sourceSymbol: "GC=F",
	},
	"IAU": {
		provider: "yahoo",
		sourceSymbol: "GC=F",
	},
	"SLV": {
		provider: "yahoo",
		sourceSymbol: "SI=F",
	},
	"BTC-USD": {
		provider: "cryptocompare",
		sourceSymbol: "BTC",
	},
	"ETH-USD": {
		provider: "cryptocompare",
		sourceSymbol: "ETH",
	},
};

interface FetchSymbolResult {
	series: AssetSeries;
	sourcesUsed: string[];
}

function clampBarsToRange(
	bars: OHLCVBar[],
	fromDate: Date,
	toDate: Date,
): OHLCVBar[] {
	const startMs = fromDate.getTime();
	const endMs = toDate.getTime();
	return bars.filter((bar) => bar.timestamp >= startMs && bar.timestamp <= endMs);
}

function dedupeAndSortBars(bars: OHLCVBar[]): OHLCVBar[] {
	const byDate = new Map<string, OHLCVBar>();
	for (const bar of bars) byDate.set(bar.date, bar);
	return [...byDate.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function median(values: number[]): number {
	if (values.length === 0) {
		throw new Error("Cannot compute median of empty array");
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid];
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeProxyScale(
	primaryBars: OHLCVBar[],
	proxyBars: OHLCVBar[],
): number {
	const proxyByDate = new Map(proxyBars.map((bar) => [bar.date, bar]));
	const overlapRatios: number[] = [];

	for (const bar of primaryBars) {
		const proxy = proxyByDate.get(bar.date);
		if (!proxy || proxy.adjClose <= 0 || bar.adjClose <= 0) continue;
		overlapRatios.push(bar.adjClose / proxy.adjClose);
		if (overlapRatios.length >= SCALE_OVERLAP_BARS) break;
	}

	if (overlapRatios.length === 0) {
		throw new Error("No overlap between primary and proxy series");
	}

	return median(overlapRatios);
}

export function spliceExtendedHistory(
	primary: AssetSeries,
	proxy: AssetSeries,
	fromDate: Date,
	toDate: Date,
): AssetSeries {
	const primaryBars = clampBarsToRange(primary.bars, fromDate, toDate);
	if (primaryBars.length === 0) {
		throw new Error(`Primary series ${primary.symbol} has no bars in range`);
	}

	const primaryStartMs = primaryBars[0].timestamp;
	if (primaryStartMs <= fromDate.getTime()) {
		return { ...primary, bars: primaryBars };
	}

	const proxyBars = clampBarsToRange(proxy.bars, fromDate, toDate);
	if (proxyBars.length === 0) {
		return { ...primary, bars: primaryBars };
	}

	const scale = computeProxyScale(primary.bars, proxy.bars);
	const syntheticBars = proxyBars
		.filter((bar) => bar.timestamp < primaryStartMs)
		.map((bar) => ({
			date: bar.date,
			timestamp: bar.timestamp,
			open: bar.open * scale,
			high: bar.high * scale,
			low: bar.low * scale,
			close: bar.close * scale,
			adjClose: bar.adjClose * scale,
			// Proxy volume is not comparable to the target instrument.
			volume: 0,
		}));

	return {
		...primary,
		bars: dedupeAndSortBars([...syntheticBars, ...primaryBars]),
	};
}

export class MultiAssetFetcher {
	/**
	 * Fetch daily OHLCV bars for a Yahoo Finance symbol.
	 * period1/period2 are Unix timestamps in seconds.
	 */
	async fetchSymbol(
		symbol: string,
		fromDate: Date,
		toDate: Date = new Date(),
	): Promise<AssetSeries> {
		const result = await this.fetchSymbolWithSources(symbol, fromDate, toDate);
		return result.series;
	}

	private async fetchSymbolWithSources(
		symbol: string,
		fromDate: Date,
		toDate: Date = new Date(),
	): Promise<FetchSymbolResult> {
		const primary = await this.fetchYahooSymbol(symbol, fromDate, toDate);
		const sourcesUsed = ["yahoo_finance_v8"];
		const plan = EXTENDED_HISTORY_PLANS[symbol];
		const primaryStart = primary.bars[0]?.timestamp ?? Number.POSITIVE_INFINITY;

		if (!plan || primaryStart <= fromDate.getTime()) {
			return { series: primary, sourcesUsed };
		}

		try {
			let proxy: AssetSeries;
			if (plan.provider === "yahoo") {
				proxy = await this.fetchYahooSymbol(plan.sourceSymbol, fromDate, toDate);
				sourcesUsed.push(`yahoo_proxy:${plan.sourceSymbol}`);
			} else {
				proxy = await this.fetchCryptoCompareSymbol(symbol, plan.sourceSymbol, fromDate, toDate);
				sourcesUsed.push(`cryptocompare_proxy:${plan.sourceSymbol}/USD`);
			}

			const stitched = spliceExtendedHistory(primary, proxy, fromDate, toDate);
			return { series: stitched, sourcesUsed };
		} catch {
			return { series: primary, sourcesUsed };
		}
	}

	private async fetchYahooSymbol(
		symbol: string,
		fromDate: Date,
		toDate: Date = new Date(),
	): Promise<AssetSeries> {
		const period1 = Math.floor(fromDate.getTime() / 1000);
		const period2 = Math.floor(toDate.getTime() / 1000);

		const url = new URL(`${YAHOO_BASE}/${encodeURIComponent(symbol)}`);
		url.searchParams.set("period1", String(period1));
		url.searchParams.set("period2", String(period2));
		url.searchParams.set("interval", "1d");
		url.searchParams.set("events", "history");

		const res = await fetch(url.toString(), {
			headers: {
				"User-Agent": "Mozilla/5.0",
				"Accept": "application/json",
			},
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			throw new Error(`Yahoo Finance API error ${res.status} for ${symbol}`);
		}

		const json = await res.json() as YahooChartResponse;
		return this.parseYahooResponse(symbol, json);
	}

	private async fetchCryptoCompareSymbol(
		targetSymbol: string,
		sourceSymbol: string,
		fromDate: Date,
		toDate: Date = new Date(),
	): Promise<AssetSeries> {
		const url = new URL(CRYPTOCOMPARE_BASE);
		url.searchParams.set("fsym", sourceSymbol);
		url.searchParams.set("tsym", "USD");
		url.searchParams.set("allData", "true");

		const res = await fetch(url.toString(), {
			headers: {
				"User-Agent": "Mozilla/5.0",
				"Accept": "application/json",
			},
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			throw new Error(`CryptoCompare API error ${res.status} for ${sourceSymbol}/USD`);
		}

		const json = await res.json() as CryptoCompareHistoryResponse;
		return this.parseCryptoCompareResponse(targetSymbol, json, fromDate, toDate);
	}

	/**
	 * Fetch multiple symbols concurrently (up to 4 at a time to avoid rate-limiting).
	 */
	async fetchAll(
		symbols: string[],
		fromDate: Date,
		toDate: Date = new Date(),
	): Promise<FetchResult> {
		const series: AssetSeries[] = [];
		const errors: { symbol: string; error: string }[] = [];
		const sourceSet = new Set<string>();
		const seriesSources: Record<string, string[]> = {};

		const BATCH = 4;
		for (let i = 0; i < symbols.length; i += BATCH) {
			const batch = symbols.slice(i, i + BATCH);
			const results = await Promise.allSettled(
				batch.map((sym) => this.fetchSymbolWithSources(sym, fromDate, toDate)),
			);

			for (let j = 0; j < results.length; j++) {
				const r = results[j];
				if (r.status === "fulfilled") {
					series.push(r.value.series);
					seriesSources[r.value.series.symbol] = r.value.sourcesUsed;
					for (const source of r.value.sourcesUsed) sourceSet.add(source);
				} else {
					errors.push({
						symbol: batch[j],
						error: r.reason instanceof Error ? r.reason.message : String(r.reason),
					});
				}
			}

			// Brief pause between batches
			if (i + BATCH < symbols.length) {
				await new Promise<void>((r) => setTimeout(r, 300));
			}
		}

		return {
			series,
			errors,
			fetchedAt: new Date().toISOString(),
			sourcesUsed: [...sourceSet].sort(),
			seriesSources,
		};
	}

	private parseYahooResponse(symbol: string, json: YahooChartResponse): AssetSeries {
		const result = json?.chart?.result?.[0];
		if (!result) {
			throw new Error(`No data in Yahoo response for ${symbol}`);
		}

		const timestamps = result.timestamp ?? [];
		const quote = result.indicators?.quote?.[0];
		const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];

		if (!quote || timestamps.length === 0) {
			throw new Error(`Empty quote data for ${symbol}`);
		}

		const bars: OHLCVBar[] = [];
		for (let i = 0; i < timestamps.length; i++) {
			const ts = timestamps[i];
			const o = quote.open?.[i];
			const h = quote.high?.[i];
			const l = quote.low?.[i];
			const c = quote.close?.[i];
			const v = quote.volume?.[i];
			const adj = adjClose[i];

			// Skip bars with null/NaN values (market holidays etc.)
			if (o == null || h == null || l == null || c == null || !Number.isFinite(c)) continue;

			const tsMs = ts * 1000;
			bars.push({
				date: new Date(tsMs).toISOString().slice(0, 10),
				timestamp: tsMs,
				open: o,
				high: h,
				low: l,
				close: c,
				adjClose: adj ?? c,
				volume: v ?? 0,
			});
		}

		if (bars.length === 0) {
			throw new Error(`Zero valid bars parsed for ${symbol}`);
		}

		const meta = ASSET_META[symbol] ?? { name: symbol, assetClass: "equity" as const };

		return {
			symbol,
			name: meta.name,
			assetClass: meta.assetClass,
			bars,
			currency: result.meta?.currency ?? "USD",
		};
	}

	private parseCryptoCompareResponse(
		targetSymbol: string,
		json: CryptoCompareHistoryResponse,
		fromDate: Date,
		toDate: Date,
	): AssetSeries {
		const rawBars = json?.Data?.Data ?? [];
		if (json?.Response !== "Success" || rawBars.length === 0) {
			throw new Error(`No CryptoCompare history for ${targetSymbol}`);
		}

		const bars = rawBars
			.filter((bar) => {
				if (bar.time == null) return false;
				const hasPrice = [bar.open, bar.high, bar.low, bar.close].every(
					(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
				);
				return hasPrice;
			})
			.map((bar) => {
				const timestamp = bar.time * 1000;
				return {
					date: new Date(timestamp).toISOString().slice(0, 10),
					timestamp,
					open: bar.open,
					high: bar.high,
					low: bar.low,
					close: bar.close,
					adjClose: bar.close,
					volume: bar.volumeto ?? 0,
				};
			})
			.filter((bar) => bar.timestamp >= fromDate.getTime() - DAY_MS && bar.timestamp <= toDate.getTime());

		if (bars.length === 0) {
			throw new Error(`Zero valid CryptoCompare bars parsed for ${targetSymbol}`);
		}

		const meta = ASSET_META[targetSymbol] ?? { name: targetSymbol, assetClass: "crypto" as const };
		return {
			symbol: targetSymbol,
			name: meta.name,
			assetClass: meta.assetClass,
			bars: dedupeAndSortBars(bars),
			currency: "USD",
		};
	}
}

// ── Yahoo Finance API type stubs ──────────────────────────────────────────────

interface YahooChartResponse {
	chart?: {
		result?: YahooChartResult[];
		error?: unknown;
	};
}

interface YahooChartResult {
	meta?: { currency?: string; symbol?: string };
	timestamp?: number[];
	indicators?: {
		quote?: {
			open?: (number | null)[];
			high?: (number | null)[];
			low?: (number | null)[];
			close?: (number | null)[];
			volume?: (number | null)[];
		}[];
		adjclose?: { adjclose?: (number | null)[] }[];
	};
}

interface CryptoCompareHistoryResponse {
	Response?: string;
	Data?: {
		Data?: Array<{
			time: number;
			high: number;
			low: number;
			open: number;
			close: number;
			volumeto?: number;
		}>;
	};
}

/** Default universe for the comparative study */
export const DEFAULT_UNIVERSE = {
	symbols: ["SPY", "GLD", "SLV", "BTC-USD", "ETH-USD"],
	/** 10 years back balances coverage and runtime for the default report. */
	defaultLookback: (): Date => {
		const d = new Date();
		d.setFullYear(d.getFullYear() - 10);
		return d;
	},
};
