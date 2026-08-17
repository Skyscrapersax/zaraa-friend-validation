/**
 * Sortino ratio — risk-adjusted return penalising only downside volatility.
 *
 * Unlike the Sharpe ratio, which divides by total standard deviation, the
 * Sortino ratio divides by the *downside* deviation: the RMS of returns that
 * fall below the Minimum Acceptable Return (MAR / target).  Upside volatility
 * is not penalised.
 *
 * Formula
 * ───────
 *   downsideDeviation = √[ (1/N) · Σ min(rᵢ − MAR, 0)² ]
 *   sortinoRatio      = (mean(returns) − MAR) / downsideDeviation
 *
 * The denominator uses N (total periods), not just the count of negative
 * periods.  This is the standard Sortino convention: it keeps the denominator
 * stable across different market regimes and makes the ratio comparable
 * across time windows.
 *
 * Edge cases
 * ──────────
 *   • Fewer than 2 returns   → returns null  (insufficient data)
 *   • downsideDeviation = 0  → returns Infinity  (no downside risk observed)
 *
 * Reference: Frank Sortino & Lee Price, "Performance Measurement in a
 * Downside Risk Framework", Journal of Investing, 1994.
 */

export interface SortinoResult {
	/** The computed ratio, or Infinity when downsideDeviation is zero. */
	ratio: number;
	/** Annualised or per-period mean return of the series. */
	meanReturn: number;
	/** RMS of below-MAR deviations (same units as returns). */
	downsideDeviation: number;
	/** Number of periods used. */
	n: number;
}

/**
 * Compute the Sortino ratio for a return series.
 *
 * @param returns - Array of per-period returns (e.g. 0.01 = 1%).  Must
 *                  contain at least 2 values.
 * @param mar     - Minimum Acceptable Return per period (default 0).
 *                  Use 0 for "beat zero"; use riskFree/periodsPerYear for
 *                  an annualised risk-free benchmark.
 * @returns SortinoResult, or null when the series is too short.
 */
export function sortinoRatio(returns: number[], mar = 0): SortinoResult | null {
	if (!Array.isArray(returns) || returns.length < 2) return null;

	const n = returns.length;

	// Mean return
	let sum = 0;
	for (const r of returns) sum += r;
	const meanReturn = sum / n;

	// Downside deviation: RMS of (r - MAR) when negative, zero otherwise.
	let sumSquaredDownside = 0;
	for (const r of returns) {
		const deviation = r - mar;
		if (deviation < 0) sumSquaredDownside += deviation * deviation;
	}
	const downsideDeviation = Math.sqrt(sumSquaredDownside / n);

	const ratio =
		downsideDeviation === 0 ? Infinity : (meanReturn - mar) / downsideDeviation;

	return { ratio, meanReturn, downsideDeviation, n };
}
