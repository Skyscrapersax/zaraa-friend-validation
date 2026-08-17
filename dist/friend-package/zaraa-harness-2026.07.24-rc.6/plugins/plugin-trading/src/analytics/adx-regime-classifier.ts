/**
 * ADX-based regime classifier - pure, side-effect-free.
 *
 * Maps a single ADX reading plus a volatility flag to one of three regime labels,
 * and derives a confidence score (0-1) from how far the ADX reading sits past
 * (or below) the trending threshold.
 *
 * Classification priority (top wins):
 *   1. volatile = true                -> "volatile"  (vol spike overrides everything)
 *   2. adx >= ADX_TREND_THRESHOLD     -> "trending"  (directional market)
 *   3. default                        -> "ranging"   (low-strength, no spike)
 *
 * Confidence formula:
 *   trending : clamp((adx - threshold) / (ADX_MAX - threshold), 0, 1)
 *   ranging  : clamp((threshold - adx) / threshold,              0, 1)
 *   volatile : 1.0  (binary signal — full confidence when triggered)
 */

/** The three labels this classifier emits. */
export type AdxRegimeLabel = "trending" | "ranging" | "volatile";

/** Result returned by classifyAdxRegimeWithConfidence. */
export interface AdxRegimeResult {
	/** Detected regime label. */
	regime: AdxRegimeLabel;
	/**
	 * Confidence that the reading belongs to this regime, in [0, 1].
	 * 0 = right at the decision boundary, 1 = maximum distance past it.
	 * Monotonically increases with distance past (or below) the threshold.
	 */
	regimeConfidence: number;
}

/**
 * Thresholds controlling the classifier boundaries.
 * Separated into a config object so callers can tune them without patching code.
 */
export interface AdxRegimeThresholds {
	/**
	 * ADX value at which the market is considered trending.
	 * Classic Wilder default is 25. Must be > 0.
	 */
	adxTrendThreshold: number;
	/**
	 * Upper bound used to normalise trending confidence.
	 * ADX rarely exceeds 100; default 100 keeps the scale intuitive.
	 */
	adxMax: number;
}

export const DEFAULT_ADX_REGIME_THRESHOLDS: AdxRegimeThresholds = {
	adxTrendThreshold: 25,
	adxMax: 100,
};

/** @internal Clamp helper. */
function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/**
 * Classify a market regime from a scalar ADX reading and a boolean volatility flag.
 *
 * @param adx          Non-negative ADX value (0-100 typical range).
 * @param isVolatile   True when realized vol or bandwidth signals a spike.
 * @param thresholds   Optional override; defaults to `DEFAULT_ADX_REGIME_THRESHOLDS`.
 * @returns            One of "trending" | "ranging" | "volatile".
 */
export function classifyAdxRegime(
	adx: number,
	isVolatile: boolean,
	thresholds: AdxRegimeThresholds = DEFAULT_ADX_REGIME_THRESHOLDS,
): AdxRegimeLabel {
	if (!Number.isFinite(adx) || adx < 0) {
		// Defensive: invalid ADX treated as zero-strength -> ranging
		return "ranging";
	}
	if (isVolatile) return "volatile";
	if (adx >= thresholds.adxTrendThreshold) return "trending";
	return "ranging";
}

/**
 * Like classifyAdxRegime but also returns a confidence score in [0, 1] that
 * measures how far the ADX reading is past (or below) the trending threshold.
 *
 * Confidence is monotonic: the further ADX is from the boundary the higher
 * the score. Right at the boundary confidence = 0; at the extremes (ADX=0
 * for ranging, ADX=adxMax for trending) confidence = 1.
 *
 * The volatile label is triggered by a binary flag, so its confidence is
 * always 1.0 (the flag is either set or it is not).
 */
export function classifyAdxRegimeWithConfidence(
	adx: number,
	isVolatile: boolean,
	thresholds: AdxRegimeThresholds = DEFAULT_ADX_REGIME_THRESHOLDS,
): AdxRegimeResult {
	if (!Number.isFinite(adx) || adx < 0) {
		// Invalid ADX -> ranging at the boundary (no confidence)
		return { regime: "ranging", regimeConfidence: 0 };
	}

	const { adxTrendThreshold: threshold, adxMax } = thresholds;

	if (isVolatile) {
		// Binary trigger -> full confidence
		return { regime: "volatile", regimeConfidence: 1 };
	}

	if (adx >= threshold) {
		// trending: confidence scales from 0 (at threshold) to 1 (at adxMax)
		const denominator = adxMax - threshold;
		const confidence = denominator > 0
			? clamp((adx - threshold) / denominator, 0, 1)
			: 1; // degenerate: threshold === adxMax, any ADX >= threshold is fully confident
		return { regime: "trending", regimeConfidence: confidence };
	}

	// ranging: confidence scales from 1 (adx=0) to 0 (adx=threshold)
	const confidence = threshold > 0
		? clamp((threshold - adx) / threshold, 0, 1)
		: 1;
	return { regime: "ranging", regimeConfidence: confidence };
}
