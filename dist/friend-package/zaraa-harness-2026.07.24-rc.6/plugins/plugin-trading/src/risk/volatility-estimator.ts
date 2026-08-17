export type VolRegime = "low" | "normal" | "high";

export interface VolRegimeBands {
	/** Annualized vol below this threshold is "low". Default: 0.30 (30%). */
	lowMaxAnnualizedVol: number;
	/** Annualized vol at-or-above this threshold is "high". Default: 0.80 (80%). */
	highMinAnnualizedVol: number;
	/** Multiplier applied to drawdown thresholds when regime is "low". Default: 1.4 (looser). */
	lowScale: number;
	/** Multiplier applied to drawdown thresholds when regime is "high". Default: 0.6 (tighter). */
	highScale: number;
}

export const DEFAULT_VOL_REGIME_BANDS: VolRegimeBands = {
	lowMaxAnnualizedVol: 0.3,
	highMinAnnualizedVol: 0.8,
	lowScale: 1.4,
	highScale: 0.6,
};

/**
 * Annualized realized volatility from a series of close prices using
 * exponentially-weighted moving variance of log returns.
 *
 * EWMA chosen over GARCH for MVP — same recency bias, no fitting,
 * one knob (lambda). Returns 0 for series with <2 valid points.
 *
 * @param closes Newest-last close prices (≥2)
 * @param lambda EWMA decay (0 < lambda < 1). Default 0.94 (RiskMetrics standard).
 * @param periodsPerYear Annualization factor. 24*365 for hourly, 252 for daily, etc. Default: 24*365 (hourly crypto, ~24/7).
 */
export function realizedVolEwma(
	closes: number[],
	lambda = 0.94,
	periodsPerYear = 24 * 365,
): number {
	if (!Array.isArray(closes) || closes.length < 2) return 0;
	const returns: number[] = [];
	for (let i = 1; i < closes.length; i++) {
		const a = closes[i - 1];
		const b = closes[i];
		// Skip non-finite (NaN/±Infinity) as well as non-positive prices: a guard of
		// `a <= 0 || b <= 0` lets Infinity (Infinity > 0) and NaN (NaN <= 0 is false)
		// through, which would poison the variance and emit a NaN/Infinity vol.
		if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
		returns.push(Math.log(b / a));
	}
	if (returns.length === 0) return 0;

	let variance = returns[0] * returns[0];
	for (let i = 1; i < returns.length; i++) {
		variance = lambda * variance + (1 - lambda) * returns[i] * returns[i];
	}
	const stdPerPeriod = Math.sqrt(variance);
	return stdPerPeriod * Math.sqrt(periodsPerYear);
}

export function classifyVolRegime(
	annualizedVol: number,
	bands: VolRegimeBands = DEFAULT_VOL_REGIME_BANDS,
): VolRegime {
	if (!Number.isFinite(annualizedVol) || annualizedVol < 0) return "normal";
	if (annualizedVol < bands.lowMaxAnnualizedVol) return "low";
	if (annualizedVol >= bands.highMinAnnualizedVol) return "high";
	return "normal";
}

/**
 * Returns a multiplier to apply to drawdown / loss thresholds.
 * High vol → tighter threshold (smaller multiplier).
 * Low vol → looser threshold (larger multiplier).
 * Normal vol → 1.0 (no change).
 */
export function scaleForRegime(
	regime: VolRegime,
	bands: VolRegimeBands = DEFAULT_VOL_REGIME_BANDS,
): number {
	if (regime === "low") return bands.lowScale;
	if (regime === "high") return bands.highScale;
	return 1.0;
}
