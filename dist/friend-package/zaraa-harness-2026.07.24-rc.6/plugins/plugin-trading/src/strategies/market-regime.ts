/**
 * Market Regime Detector
 *
 * Classifies current market conditions into one of four regimes:
 *   - trending_up:    Strong directional upward movement
 *   - trending_down:  Strong directional downward movement
 *   - ranging:        Sideways oscillation within bounds
 *   - volatile:       High volatility without clear direction (transition/chaos)
 *
 * The regime determines which strategies should be weighted higher:
 *   - trending_up/down  -> trend-following gets boosted, mean-reversion suppressed
 *   - ranging            -> mean-reversion boosted, trend-following/breakout suppressed
 *   - volatile           -> breakout boosted (compression->expansion), others cautious
 *
 * Detection uses three independent signals that vote:
 *   1. ADX (Average Directional Index) — trend strength
 *   2. Bollinger Band Width — volatility compression/expansion
 *   3. Price-SMA relationship — directional bias
 *
 * This is pure computation — no side effects, no dependencies beyond indicator data.
 */

import type { IndicatorValues } from "./strategy.js";

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "volatile";

export interface RegimeAnalysis {
	/** Current detected regime */
	regime: MarketRegime;
	/** Confidence in the classification (0-1) */
	confidence: number;
	/** ADX value (trend strength, >25 = trending) */
	adx: number;
	/** Bollinger bandwidth percentile (0-1, low = squeeze) */
	bandwidthPercentile: number;
	/** Directional bias: positive = bullish, negative = bearish, near zero = neutral */
	directionalBias: number;
	/** ATR as % of price — normalized volatility */
	volatilityPct: number;
	/** Per-strategy weight multipliers based on detected regime */
	strategyWeights: Record<string, number>;
}

/**
 * Strategy weights per regime.
 *
 * IMPORTANT: These weights multiply strategy confidence BEFORE the 0.50
 * threshold check. A weight of 0.3x on a typical 0.55-0.65 confidence
 * signal produces 0.16-0.20 — an effective kill shot. That is intentional
 * for some combinations (trend-following in a ranging market is genuinely
 * dangerous), but mean-reversion already has an internal SMA-slope trend
 * filter that rejects signals against strong trends. Double-filtering
 * at both strategy AND regime level made mean-reversion unable to fire
 * in ANY trending market, even on legitimate overbought/oversold extremes.
 *
 * Revised: Raise mean-reversion floor from 0.3 to 0.6 in trending regimes.
 * The strategy's own trend filter handles the dangerous cases (fighting a
 * strong linear trend). The regime weight should reduce confidence for
 * marginal setups without completely eliminating the strategy.
 *
 * Similarly, trend-following in ranging markets was 0.3 — raised to 0.5.
 * The strategy requires a crossover or established trend to fire, so
 * ranging markets naturally produce fewer signals. The weight should
 * penalize, not extinguish.
 */
const REGIME_WEIGHTS: Record<MarketRegime, Record<string, number>> = {
	trending_up: {
		"trend-following": 1.4,
		"breakout": 1.0,
		"mean-reversion": 0.6, // reduced but not killed — strategy has own trend filter
		"rsi-divergence": 0.85,
	},
	trending_down: {
		"trend-following": 1.4,
		"breakout": 1.0,
		"mean-reversion": 0.6, // same reasoning — overbought conditions still valid
		"rsi-divergence": 0.85,
	},
	ranging: {
		"trend-following": 0.5, // whipsaws in ranges, but don't extinguish
		"breakout": 0.6,        // false breakouts likely
		"mean-reversion": 1.4,  // thrives in ranges
		"rsi-divergence": 1.2,  // reversals common in ranges
	},
	volatile: {
		"trend-following": 0.6,
		"breakout": 1.4,        // volatility expansion = breakout territory
		"mean-reversion": 0.6,  // risky but not impossible
		"rsi-divergence": 1.0,  // neutral — can detect exhaustion
	},
};

/**
 * Compute the Average Directional Index (ADX) from indicator data.
 *
 * ADX measures trend strength regardless of direction:
 *   < 20: weak/no trend (ranging)
 *   20-25: emerging trend
 *   25-50: strong trend
 *   > 50: very strong trend
 *
 * Uses +DI/-DI from highs/lows/closes and smoothed with Wilder's method.
 */
export function computeADX(
	highs: number[],
	lows: number[],
	closes: number[],
	period: number = 14,
): number[] {
	const len = Math.min(highs.length, lows.length, closes.length);
	if (len < period + 1) return [];

	// Step 1: Calculate +DM, -DM, and True Range
	const plusDM: number[] = [];
	const minusDM: number[] = [];
	const tr: number[] = [];

	for (let i = 1; i < len; i++) {
		const upMove = highs[i] - highs[i - 1];
		const downMove = lows[i - 1] - lows[i];

		plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
		minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

		const hl = highs[i] - lows[i];
		const hc = Math.abs(highs[i] - closes[i - 1]);
		const lc = Math.abs(lows[i] - closes[i - 1]);
		tr.push(Math.max(hl, hc, lc));
	}

	if (plusDM.length < period) return [];

	// Step 2: Smooth with Wilder's method (period-smoothed)
	const smooth = (arr: number[], p: number): number[] => {
		let sum = 0;
		for (let i = 0; i < p; i++) sum += arr[i];
		const result = [sum];
		for (let i = p; i < arr.length; i++) {
			result.push(result[result.length - 1] - result[result.length - 1] / p + arr[i]);
		}
		return result;
	};

	const smoothPlusDM = smooth(plusDM, period);
	const smoothMinusDM = smooth(minusDM, period);
	const smoothTR = smooth(tr, period);

	// Step 3: Calculate +DI, -DI
	const minLen = Math.min(smoothPlusDM.length, smoothMinusDM.length, smoothTR.length);
	const dx: number[] = [];

	for (let i = 0; i < minLen; i++) {
		const plusDI = smoothTR[i] > 0 ? (smoothPlusDM[i] / smoothTR[i]) * 100 : 0;
		const minusDI = smoothTR[i] > 0 ? (smoothMinusDM[i] / smoothTR[i]) * 100 : 0;
		const diSum = plusDI + minusDI;
		dx.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
	}

	if (dx.length < period) return [];

	// Step 4: Smooth DX to get ADX
	let adxSum = 0;
	for (let i = 0; i < period; i++) adxSum += dx[i];
	const adx: number[] = [adxSum / period];
	for (let i = period; i < dx.length; i++) {
		adx.push((adx[adx.length - 1] * (period - 1) + dx[i]) / period);
	}

	return adx;
}

/**
 * Detect the current market regime from indicator data.
 *
 * The algorithm works by voting across three independent signals:
 *   1. ADX for trend strength
 *   2. Bollinger bandwidth for volatility state
 *   3. Price position relative to SMA-50 for directional bias
 *
 * Each signal contributes evidence toward a regime classification.
 */
export function detectRegime(indicators: IndicatorValues): RegimeAnalysis {
	const { closes, highs, lows, bollingerBands: bb, atr, sma } = indicators;

	if (closes.length < 30 || highs.length < 30 || lows.length < 30) {
		return defaultAnalysis();
	}

	// 1. ADX — trend strength
	const adxValues = computeADX(highs, lows, closes, 14);
	const currentADX = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 20;

	// 2. Bollinger bandwidth — volatility state
	let bandwidthPercentile = 0.5;
	if (bb.upper.length >= 20 && bb.lower.length >= 20 && bb.middle.length >= 20) {
		const bandwidths: number[] = [];
		for (let i = 0; i < bb.middle.length; i++) {
			if (bb.middle[i] > 0) {
				bandwidths.push((bb.upper[i] - bb.lower[i]) / bb.middle[i]);
			}
		}
		if (bandwidths.length >= 2) {
			// Percentile rank of the latest bandwidth = fraction of samples strictly
			// below it. Single O(N) count pass; equivalent to the prior copy+sort+
			// findIndex but without the array allocation or O(N log N) sort.
			const currentBW = bandwidths[bandwidths.length - 1];
			let below = 0;
			for (let i = 0; i < bandwidths.length; i++) {
				if (bandwidths[i] < currentBW) below++;
			}
			bandwidthPercentile = below / bandwidths.length;
		}
	}

	// 3. Directional bias — price vs SMA-50
	const sma50 = sma[50];
	let directionalBias = 0;
	if (sma50 && sma50.length >= 10) {
		const price = closes[closes.length - 1];
		const smaValue = sma50[sma50.length - 1];
		// Percentage above/below SMA
		directionalBias = smaValue > 0 ? (price - smaValue) / smaValue : 0;

		// SMA slope contributes to directional strength
		const smaSlope = (sma50[sma50.length - 1] - sma50[sma50.length - 10]) / sma50[sma50.length - 10];
		directionalBias = directionalBias * 0.6 + smaSlope * 10 * 0.4; // weighted blend
	}

	// 4. Normalized volatility (ATR as % of price)
	const price = closes[closes.length - 1];
	const currentATR = atr.length > 0 ? atr[atr.length - 1] : 0;
	const volatilityPct = price > 0 ? (currentATR / price) * 100 : 0;

	// ── Classification voting ──
	// Each dimension votes for a regime.

	let trendingScore = 0;    // evidence for trending
	let rangingScore = 0;     // evidence for ranging
	let volatileScore = 0;    // evidence for high volatility

	// ADX vote
	if (currentADX >= 30) {
		trendingScore += 0.5;
	} else if (currentADX >= 22) {
		trendingScore += 0.25;
		rangingScore += 0.1;
	} else if (currentADX < 18) {
		rangingScore += 0.4;
	} else {
		// 18-22: ambiguous
		rangingScore += 0.2;
		trendingScore += 0.1;
	}

	// Bandwidth vote
	if (bandwidthPercentile < 0.2) {
		// Squeeze — typically precedes breakout
		volatileScore += 0.3;
		rangingScore += 0.2; // squeezes happen in ranges
	} else if (bandwidthPercentile > 0.8) {
		// Wide bands — high vol
		volatileScore += 0.4;
		trendingScore += 0.1; // can indicate strong trend
	} else {
		// Normal bandwidth
		rangingScore += 0.15;
	}

	// Directional bias vote
	const absBias = Math.abs(directionalBias);
	if (absBias > 0.03) {
		trendingScore += 0.3;
	} else if (absBias > 0.01) {
		trendingScore += 0.15;
		rangingScore += 0.1;
	} else {
		rangingScore += 0.25;
	}

	// Volatility magnitude vote
	if (volatilityPct > 4) {
		volatileScore += 0.3;
	} else if (volatilityPct > 2) {
		volatileScore += 0.1;
	} else if (volatilityPct < 0.5) {
		rangingScore += 0.15;
	}

	// ── Determine winner ──
	const scores: [MarketRegime, number][] = [];

	if (directionalBias > 0) {
		scores.push(["trending_up", trendingScore]);
	} else {
		scores.push(["trending_down", trendingScore]);
	}
	scores.push(["ranging", rangingScore]);
	scores.push(["volatile", volatileScore]);

	scores.sort((a, b) => b[1] - a[1]);
	const [regime, score] = scores[0];

	// Confidence: how much the winner leads the runner-up
	const totalScore = trendingScore + rangingScore + volatileScore;
	const confidence = totalScore > 0
		? Math.min(score / totalScore + 0.2, 1.0)
		: 0.5;

	// Get strategy weights for this regime, with blending from the runner-up
	const primaryWeights = REGIME_WEIGHTS[regime];
	const [secondRegime, secondScore] = scores[1];
	const secondWeights = REGIME_WEIGHTS[secondRegime];

	// Blend weights: if winner is strong, use mostly its weights;
	// if close, blend more with runner-up
	const blendRatio = totalScore > 0
		? Math.min(Math.max((score - secondScore) / totalScore, 0), 0.5) + 0.5
		: 1.0;

	const strategyWeights: Record<string, number> = {};
	for (const key of Object.keys(primaryWeights)) {
		const primary = primaryWeights[key];
		const secondary = secondWeights[key] ?? 1.0;
		strategyWeights[key] = round3(primary * blendRatio + secondary * (1 - blendRatio));
	}

	return {
		regime,
		confidence: round3(confidence),
		adx: round3(currentADX),
		bandwidthPercentile: round3(bandwidthPercentile),
		directionalBias: round3(directionalBias),
		volatilityPct: round3(volatilityPct),
		strategyWeights,
	};
}

/**
 * Apply regime-based weights to an ensemble vote's confidence.
 * This modulates strategy confidence based on whether the current regime
 * favors or disfavors that strategy.
 *
 * Example: In a trending_up regime, a trend-following signal with confidence 0.7
 * gets boosted to 0.7 * 1.5 = 1.05, capped at 0.95.
 * A mean-reversion signal with confidence 0.7 gets reduced to 0.7 * 0.3 = 0.21.
 */
export function applyRegimeWeight(
	confidence: number,
	strategyName: string,
	analysis: RegimeAnalysis,
): number {
	const weight = analysis.strategyWeights[strategyName] ?? 1.0;
	return Math.min(confidence * weight, 0.95);
}

function defaultAnalysis(): RegimeAnalysis {
	return {
		regime: "ranging",
		confidence: 0.3,
		adx: 20,
		bandwidthPercentile: 0.5,
		directionalBias: 0,
		volatilityPct: 0,
		strategyWeights: {
			"trend-following": 1.0,
			"breakout": 1.0,
			"mean-reversion": 1.0,
			"rsi-divergence": 1.0,
		},
	};
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
