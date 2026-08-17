import type { Candle } from "../data/candle-store.js";
import type { IndicatorValues } from "./strategy.js";

/**
 * Request-scoped memoizer for candle fetches and indicator computations.
 *
 * In ensemble mode, every watching strategy calls getAscending(symbol, timeframe, 200)
 * and computeIndicators independently — producing N+1 identical reads and N+1 identical
 * full indicator suite computations for the same (symbol, timeframe) per scan cycle.
 *
 * ScanCache wraps these two operations so the underlying store and computeIndicators are
 * each called AT MOST ONCE per (symbol, timeframe, limit) key per scan cycle.
 * Call clear() at the start of each scan/scanEnsemble to reset all cached state.
 *
 * Keying uses `${symbol}|${timeframe}|${limit}` — distinct limit values produce
 * separate entries (the shadow-mode getAscending(symbol, tf, 1) tick is different from
 * the 200-candle strategy read and should NOT be conflated).
 *
 * Pure perf — no behavioral change. Signals produced are byte-identical to the
 * pre-cache path because computeIndicators is a pure function of the candle array.
 */
export class ScanCache {
	private candleCache = new Map<string, Candle[]>();
	private indicatorCache = new Map<string, IndicatorValues>();

	constructor(
		private readonly getAscending: (symbol: string, timeframe: string, limit: number) => Candle[],
		private readonly computeIndicators: (candles: Candle[]) => IndicatorValues,
	) {}

	/**
	 * Return candles for (symbol, timeframe, limit), reading from the store only once
	 * per key per scan cycle.
	 */
	getCandles(symbol: string, timeframe: string, limit: number): Candle[] {
		const key = `${symbol}|${timeframe}|${limit}`;
		let candles = this.candleCache.get(key);
		if (candles === undefined) {
			candles = this.getAscending(symbol, timeframe, limit);
			this.candleCache.set(key, candles);
		}
		return candles;
	}

	/**
	 * Return IndicatorValues for (symbol, timeframe, limit), computing only once per
	 * key per scan cycle. The caller must supply the candle array (already fetched via
	 * getCandles) to avoid a second store read.
	 */
	getIndicators(symbol: string, timeframe: string, limit: number, candles: Candle[]): IndicatorValues {
		const key = `${symbol}|${timeframe}|${limit}`;
		let indicators = this.indicatorCache.get(key);
		if (indicators === undefined) {
			indicators = this.computeIndicators(candles);
			this.indicatorCache.set(key, indicators);
		}
		return indicators;
	}

	/**
	 * Clear all cached state. Must be called at the start of each scan cycle so
	 * stale candles from a prior cycle are never reused.
	 */
	clear(): void {
		this.candleCache.clear();
		this.indicatorCache.clear();
	}
}
