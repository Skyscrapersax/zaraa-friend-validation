import type { Candle } from "../data/candle-store.js";
import type { IndicatorValues } from "./strategy.js";
import * as ind from "../indicators/index.js";

/**
 * Compute all standard indicators for a set of candles.
 * Candles must be sorted ascending by openTime.
 */
export function computeIndicators(
	candles: Candle[],
	smaPeriods: number[] = [20, 50, 200],
	emaPeriods: number[] = [9, 12, 20, 21, 26, 50],
): IndicatorValues {
	const closes = candles.map((c) => c.close);
	const highs = candles.map((c) => c.high);
	const lows = candles.map((c) => c.low);
	const volumes = candles.map((c) => c.volume);

	const sma: Record<number, number[]> = {};
	for (const p of smaPeriods) {
		sma[p] = ind.sma(closes, p);
	}

	const ema: Record<number, number[]> = {};
	for (const p of emaPeriods) {
		ema[p] = ind.ema(closes, p);
	}

	return {
		closes,
		highs,
		lows,
		volumes,
		sma,
		ema,
		rsi: ind.rsi(closes, 14),
		macd: ind.macd(closes, 12, 26, 9),
		bollingerBands: ind.bollingerBands(closes, 20, 2),
		atr: ind.atr(highs, lows, closes, 14),
		vwap: ind.vwap(highs, lows, closes, volumes),
		stochRsi: ind.stochRsi(closes, 14, 14),
		obv: ind.obv(closes, volumes),
	};
}

/**
 * Lazily-evaluated indicator set: each indicator is computed on first access and
 * memoized. Untouched indicators are never computed. Numerically identical to
 * computeIndicators — all values are derived from the same pure indicator functions.
 *
 * The raw price arrays (closes/highs/lows/volumes) are eagerly extracted because
 * every indicator depends on at least one of them and extracting them once is cheaper
 * than deferring four tiny array maps.
 *
 * Strategies opt in by calling computeIndicatorsLazy instead of computeIndicators.
 * The existing computeIndicators shim is unaffected.
 *
 * @param candles Candles sorted ascending by openTime.
 * @param smaPeriods SMA periods (default: [20, 50, 200])
 * @param emaPeriods EMA periods (default: [9, 12, 20, 21, 26, 50])
 */
export function computeIndicatorsLazy(
	candles: Candle[],
	smaPeriods: number[] = [20, 50, 200],
	emaPeriods: number[] = [9, 12, 20, 21, 26, 50],
): IndicatorValues {
	// Eagerly extract price arrays — shared by all indicator computations below.
	const closes = candles.map((c) => c.close);
	const highs = candles.map((c) => c.high);
	const lows = candles.map((c) => c.low);
	const volumes = candles.map((c) => c.volume);

	// --- Memoization caches ---
	// SMA and EMA are Record<number, number[]> — each period is memoized separately.
	const smaCache: Record<number, number[]> = {};
	const emaCache: Record<number, number[]> = {};

	// Scalar indicator caches (undefined = not yet computed).
	let _rsi: number[] | undefined;
	let _macd: { macd: number[]; signal: number[]; histogram: number[] } | undefined;
	let _bb: { upper: number[]; middle: number[]; lower: number[] } | undefined;
	let _atr: number[] | undefined;
	let _vwap: number[] | undefined;
	let _stochRsi: number[] | undefined;
	let _obv: number[] | undefined;

	// Lazy SMA proxy: accessing sma[period] computes only that period.
	const smaProxy = new Proxy(smaCache, {
		get(target, prop: string | symbol) {
			const p = Number(prop);
			if (!Number.isInteger(p)) return (target as Record<string | symbol, unknown>)[prop];
			if (target[p] === undefined) {
				target[p] = ind.sma(closes, p);
			}
			return target[p];
		},
	});

	// Lazy EMA proxy: accessing ema[period] computes only that period.
	const emaProxy = new Proxy(emaCache, {
		get(target, prop: string | symbol) {
			const p = Number(prop);
			if (!Number.isInteger(p)) return (target as Record<string | symbol, unknown>)[prop];
			if (target[p] === undefined) {
				target[p] = ind.ema(closes, p);
			}
			return target[p];
		},
	});

	// Build the IndicatorValues object with lazy getters for heavy indicators.
	// closes/highs/lows/volumes are plain values (no getter overhead).
	return {
		closes,
		highs,
		lows,
		volumes,
		sma: smaProxy as Record<number, number[]>,
		ema: emaProxy as Record<number, number[]>,
		get rsi() {
			if (_rsi === undefined) _rsi = ind.rsi(closes, 14);
			return _rsi;
		},
		get macd() {
			if (_macd === undefined) _macd = ind.macd(closes, 12, 26, 9);
			return _macd;
		},
		get bollingerBands() {
			if (_bb === undefined) _bb = ind.bollingerBands(closes, 20, 2);
			return _bb;
		},
		get atr() {
			if (_atr === undefined) _atr = ind.atr(highs, lows, closes, 14);
			return _atr;
		},
		get vwap() {
			if (_vwap === undefined) _vwap = ind.vwap(highs, lows, closes, volumes);
			return _vwap;
		},
		get stochRsi() {
			if (_stochRsi === undefined) _stochRsi = ind.stochRsi(closes, 14, 14);
			return _stochRsi;
		},
		get obv() {
			if (_obv === undefined) _obv = ind.obv(closes, volumes);
			return _obv;
		},
	};
}

// Pre-warm all periods in the proxy caches so they behave like eager Record
// when all periods are accessed (no missing-key surprises for callers iterating
// over smaPeriods/emaPeriods explicitly).
// Note: this is intentionally NOT called here — the whole point is lazy evaluation.
// Callers that need all periods eagerly should use computeIndicators.
