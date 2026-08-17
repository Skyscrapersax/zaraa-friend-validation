/**
 * Technical indicators — pure functions, no side effects.
 * All take number arrays and return number arrays.
 * Output arrays are aligned to the END of the input:
 *   input length N, period P → output length N - P + 1
 */

/** Simple Moving Average */
export function sma(prices: number[], period: number): number[] {
	if (prices.length < period) return [];
	const result: number[] = [];
	let sum = 0;
	for (let i = 0; i < period; i++) sum += prices[i];
	result.push(sum / period);
	for (let i = period; i < prices.length; i++) {
		sum += prices[i] - prices[i - period];
		result.push(sum / period);
	}
	return result;
}

/** Exponential Moving Average */
export function ema(prices: number[], period: number): number[] {
	if (prices.length < period) return [];
	const k = 2 / (period + 1);
	// Seed with SMA of first `period` values
	let sum = 0;
	for (let i = 0; i < period; i++) sum += prices[i];
	const result: number[] = [sum / period];
	for (let i = period; i < prices.length; i++) {
		const prev = result[result.length - 1];
		result.push(prices[i] * k + prev * (1 - k));
	}
	return result;
}

export type EmaCrossType = "golden_cross" | "death_cross";

/** One confirmed EMA crossover on bar close (index = last bar of the cross bar in `prices`). */
export interface EmaCrossSignal {
	type: EmaCrossType;
	/** Index into `prices` where the crossover is detected (after both EMAs are defined). */
	index: number;
	price: number;
}

/**
 * Detect EMA crossovers (fast vs slow) on closing prices — **bar close** semantics.
 * Uses the same EMA alignment as {@link macd}: `offset = fastEma.length - slowEma.length`.
 * - **golden_cross:** prior bar fast ≤ slow **and** current fast > slow.
 * - **death_cross:** prior bar fast ≥ slow **and** current fast < slow.
 * (`index` / `price` refer to the **current** bar in `prices` where the cross is detected.)
 */
export function detectEmaCrossovers(
	prices: number[],
	fastPeriod: number,
	slowPeriod: number,
): EmaCrossSignal[] {
	if (!Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod) || fastPeriod <= 0 || slowPeriod <= 0) {
		return [];
	}
	if (fastPeriod >= slowPeriod) {
		return [];
	}
	const fastSeries = ema(prices, fastPeriod);
	const slowSeries = ema(prices, slowPeriod);
	if (fastSeries.length === 0 || slowSeries.length === 0) return [];

	const offset = fastSeries.length - slowSeries.length;
	const out: EmaCrossSignal[] = [];
	const baseBarIndex = slowPeriod - 1;

	for (let i = 1; i < slowSeries.length; i++) {
		const f0 = fastSeries[offset + i - 1];
		const f1 = fastSeries[offset + i];
		const s0 = slowSeries[i - 1];
		const s1 = slowSeries[i];
		if (![f0, f1, s0, s1].every((x) => Number.isFinite(x))) continue;

		const barIndex = baseBarIndex + i;
		const price = prices[barIndex];
		if (!Number.isFinite(price)) continue;

		if (f0 <= s0 && f1 > s1) {
			out.push({ type: "golden_cross", index: barIndex, price });
		} else if (f0 >= s0 && f1 < s1) {
			out.push({ type: "death_cross", index: barIndex, price });
		}
	}
	return out;
}

/** Relative Strength Index */
export function rsi(prices: number[], period = 14): number[] {
	if (prices.length < period + 1) return [];
	const result: number[] = [];

	// Calculate initial average gain/loss
	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 1; i <= period; i++) {
		const change = prices[i] - prices[i - 1];
		if (change > 0) avgGain += change;
		else avgLoss -= change;
	}
	avgGain /= period;
	avgLoss /= period;

	const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
	result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));

	// Smoothed for remaining values
	for (let i = period + 1; i < prices.length; i++) {
		const change = prices[i] - prices[i - 1];
		const gain = change > 0 ? change : 0;
		const loss = change < 0 ? -change : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
		const smoothRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
		result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + smoothRs));
	}

	return result;
}

/** MACD (Moving Average Convergence Divergence) */
export function macd(
	prices: number[],
	fastPeriod = 12,
	slowPeriod = 26,
	signalPeriod = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
	const fastEma = ema(prices, fastPeriod);
	const slowEma = ema(prices, slowPeriod);

	// Align: fast EMA is longer, trim its start to match slow EMA length
	const offset = fastEma.length - slowEma.length;
	const macdLine: number[] = [];
	for (let i = 0; i < slowEma.length; i++) {
		macdLine.push(fastEma[i + offset] - slowEma[i]);
	}

	const signalLine = ema(macdLine, signalPeriod);
	const sigOffset = macdLine.length - signalLine.length;
	const trimmedMacd = macdLine.slice(sigOffset);
	const histogram = trimmedMacd.map((m, i) => m - signalLine[i]);

	return { macd: trimmedMacd, signal: signalLine, histogram };
}

/** Bollinger Bands — O(N) rolling sum and sum-of-squares (variance = E[x²] − E[x]²) */
export function bollingerBands(
	prices: number[],
	period = 20,
	stdDevMultiplier = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
	const middle = sma(prices, period);
	if (middle.length === 0) return { upper: [], middle: [], lower: [] };

	const upper: number[] = [];
	const lower: number[] = [];

	// Bootstrap rolling sums for the first window
	let sumX = 0;
	let sumX2 = 0;
	for (let i = 0; i < period; i++) {
		sumX += prices[i];
		sumX2 += prices[i] * prices[i];
	}

	for (let i = 0; i < middle.length; i++) {
		if (i > 0) {
			// Slide the window: add incoming, remove outgoing
			const incoming = prices[i + period - 1];
			const outgoing = prices[i - 1];
			sumX += incoming - outgoing;
			sumX2 += incoming * incoming - outgoing * outgoing;
		}

		const mean = sumX / period;
		// Clamp at 0 to guard against tiny negatives from floating-point error
		const variance = Math.max(0, sumX2 / period - mean * mean);
		const stdDev = Math.sqrt(variance);
		upper.push(mean + stdDevMultiplier * stdDev);
		lower.push(mean - stdDevMultiplier * stdDev);
	}

	return { upper, middle, lower };
}

/** Average True Range — measures volatility */
export function atr(
	highs: number[],
	lows: number[],
	closes: number[],
	period = 14,
): number[] {
	const len = Math.min(highs.length, lows.length, closes.length);
	if (len < 2) return [];

	// True Range for each bar (starting from index 1)
	const tr: number[] = [];
	for (let i = 1; i < len; i++) {
		const hl = highs[i] - lows[i];
		const hc = Math.abs(highs[i] - closes[i - 1]);
		const lc = Math.abs(lows[i] - closes[i - 1]);
		tr.push(Math.max(hl, hc, lc));
	}

	if (tr.length < period) return [];

	// First ATR is simple average
	let sum = 0;
	for (let i = 0; i < period; i++) sum += tr[i];
	const result: number[] = [sum / period];

	// Smoothed ATR
	for (let i = period; i < tr.length; i++) {
		const prev = result[result.length - 1];
		result.push((prev * (period - 1) + tr[i]) / period);
	}

	return result;
}

/** Volume Weighted Average Price */
export function vwap(
	highs: number[],
	lows: number[],
	closes: number[],
	volumes: number[],
): number[] {
	const len = Math.min(highs.length, lows.length, closes.length, volumes.length);
	if (len === 0) return [];

	const result: number[] = [];
	let cumulativeTPV = 0;
	let cumulativeVolume = 0;

	for (let i = 0; i < len; i++) {
		const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
		cumulativeTPV += typicalPrice * volumes[i];
		cumulativeVolume += volumes[i];
		result.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
	}

	return result;
}

/**
 * Stochastic RSI — RSI applied to RSI values.
 * O(N) implementation using monotonic deques for rolling min and max,
 * eliminating per-window slice/spread allocations.
 */
export function stochRsi(
	prices: number[],
	rsiPeriod = 14,
	stochPeriod = 14,
): number[] {
	const rsiValues = rsi(prices, rsiPeriod);
	if (rsiValues.length < stochPeriod) return [];

	const result: number[] = [];

	// Monotonic deques store indices into rsiValues.
	// minDeque: ascending order of rsiValues (front = current min index)
	// maxDeque: descending order of rsiValues (front = current max index)
	const minDeque: number[] = [];
	const maxDeque: number[] = [];

	for (let i = 0; i < rsiValues.length; i++) {
		const val = rsiValues[i];

		// Evict indices that have fallen out of the window
		const windowStart = i - stochPeriod + 1;
		if (minDeque.length > 0 && minDeque[0] < windowStart) minDeque.shift();
		if (maxDeque.length > 0 && maxDeque[0] < windowStart) maxDeque.shift();

		// Maintain ascending invariant for minDeque
		while (minDeque.length > 0 && rsiValues[minDeque[minDeque.length - 1]] >= val) {
			minDeque.pop();
		}
		minDeque.push(i);

		// Maintain descending invariant for maxDeque
		while (maxDeque.length > 0 && rsiValues[maxDeque[maxDeque.length - 1]] <= val) {
			maxDeque.pop();
		}
		maxDeque.push(i);

		// Only emit once we have a full window
		if (i >= stochPeriod - 1) {
			const min = rsiValues[minDeque[0]];
			const max = rsiValues[maxDeque[0]];
			result.push(max === min ? 50 : ((val - min) / (max - min)) * 100);
		}
	}

	return result;
}

/** On-Balance Volume */
export function obv(closes: number[], volumes: number[]): number[] {
	const len = Math.min(closes.length, volumes.length);
	if (len === 0) return [];

	const result: number[] = [0];
	for (let i = 1; i < len; i++) {
		if (closes[i] > closes[i - 1]) {
			result.push(result[i - 1] + volumes[i]);
		} else if (closes[i] < closes[i - 1]) {
			result.push(result[i - 1] - volumes[i]);
		} else {
			result.push(result[i - 1]);
		}
	}

	return result;
}
