/**
 * Sortino ratio utility -- risk-adjusted return using only downside deviation.
 *
 * Unlike Sharpe (which penalises all volatility equally), Sortino only penalises
 * returns that fall below a configurable minimum acceptable return (MAR / target).
 * This makes it more appropriate for asymmetric crypto-strategy evaluation where
 * upside variance is desirable.
 *
 * Formula:
 *   Sortino = (meanReturn - MAR) / downsideDeviation
 *   downsideDeviation = sqrt( mean( min(r - MAR, 0)^2 ) )
 *
 * Annualisation uses sqrt(periodsPerYear) on the deviation and
 * (meanReturn - MAR) * periodsPerYear on the excess-return numerator.
 */

export interface SortinoOptions {
	/** Minimum acceptable return per period (default 0). */
	mar?: number;
	/** Periods per year for annualisation. 252 = daily, 365*24 = hourly crypto. Default 252. */
	periodsPerYear?: number;
}

export interface SortinoResult {
	/** Annualised Sortino ratio, or null when downside deviation is zero. */
	sortino: number | null;
	/** Annualised downside deviation. */
	downsideDeviation: number;
	/** Mean return per period. */
	meanReturn: number;
	/** Count of periods with returns below MAR. */
	belowMarCount: number;
	/** Total valid periods used. */
	periodCount: number;
}

/**
 * Compute the Sortino ratio for a series of per-period returns.
 *
 * @param returns  Per-period returns as decimals (e.g. 0.01 = 1%).
 *                 Returns fewer than 2 valid elements yield sortino: null.
 * @param options  MAR and annualisation knob.
 */
export function sortinoRatio(
	returns: number[],
	options: SortinoOptions = {},
): SortinoResult {
	const mar = options.mar ?? 0;
	const periodsPerYear = options.periodsPerYear ?? 252;

	const empty: SortinoResult = {
		sortino: null,
		downsideDeviation: 0,
		meanReturn: 0,
		belowMarCount: 0,
		periodCount: 0,
	};

	if (!Array.isArray(returns) || returns.length < 2) return empty;

	// Filter non-finite values defensively
	const valid = returns.filter(Number.isFinite);
	if (valid.length < 2) return empty;

	const meanReturn = valid.reduce((s, r) => s + r, 0) / valid.length;

	// Downside squares: only where return < MAR
	const downsideSquares = valid.map((r) => {
		const diff = r - mar;
		return diff < 0 ? diff * diff : 0;
	});
	const belowMarCount = downsideSquares.filter((d) => d > 0).length;
	const meanDownsideSquare = downsideSquares.reduce((s, d) => s + d, 0) / valid.length;

	// Annualised downside deviation
	const downsideDeviation = Math.sqrt(meanDownsideSquare) * Math.sqrt(periodsPerYear);

	// Zero downside means all returns >= MAR -- Sortino is undefined (+Inf);
	// return null so callers can handle the all-positive-returns edge case explicitly.
	if (downsideDeviation === 0) {
		return { sortino: null, downsideDeviation: 0, meanReturn, belowMarCount: 0, periodCount: valid.length };
	}

	const annualisedExcess = (meanReturn - mar) * periodsPerYear;
	const sortino = annualisedExcess / downsideDeviation;

	return { sortino, downsideDeviation, meanReturn, belowMarCount, periodCount: valid.length };
}
