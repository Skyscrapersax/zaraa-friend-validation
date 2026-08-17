/**
 * regime-classifier.ts
 *
 * Pure, dependency-free classifier that maps a single ADX value plus a
 * high-volatility flag to one of three regime labels.
 *
 * This is intentionally simpler than the multi-signal MarketRegime detector
 * in strategies/market-regime.ts. Use it as a lightweight gate inside risk
 * guards and circuit-breaker logic where full indicator data is unavailable.
 *
 * Classification rules (priority order):
 *   1. isHighVolatility = true → "volatile"   (flag overrides ADX)
 *   2. adx >= ADX_TRENDING_THRESHOLD          → "trending"
 *   3. otherwise                              → "ranging"
 */

/** The three regimes this classifier can emit. */
export type RegimeLabel = "trending" | "ranging" | "volatile";

/**
 * ADX threshold above which the market is considered trending.
 * The standard DMI/ADX literature uses 25; we match that convention.
 */
export const ADX_TRENDING_THRESHOLD = 25;

/**
 * Classify the current market regime from an ADX value and a high-volatility
 * flag (e.g. from a volatility estimator or a VIX-proxy breach).
 *
 * @param adx            - Current ADX value (0–100). Values outside this range
 *                         are clamped to [0, 100] before comparison.
 * @param isHighVolatility - true when an upstream volatility signal (ATR spike,
 *                         bandwidth percentile, etc.) flags an abnormal regime.
 * @returns RegimeLabel
 */
export function classifyRegime(adx: number, isHighVolatility: boolean): RegimeLabel {
	// Clamp to valid ADX range so callers don't have to guard against NaN/Infinity.
	const clampedAdx = Math.max(0, Math.min(100, Number.isFinite(adx) ? adx : 0));

	if (isHighVolatility) return "volatile";
	if (clampedAdx >= ADX_TRENDING_THRESHOLD) return "trending";
	return "ranging";
}
