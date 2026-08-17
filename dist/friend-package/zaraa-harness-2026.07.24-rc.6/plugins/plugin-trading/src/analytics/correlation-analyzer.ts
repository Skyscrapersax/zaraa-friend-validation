/**
 * Correlation analysis for finding trading pairs, measuring diversification,
 * and identifying hedging opportunities.
 *
 * Uses Pearson correlation on log-returns (percent changes) rather than raw
 * prices, which is the standard approach for financial correlation analysis.
 *
 * Usage:
 *   const analyzer = new CorrelationAnalyzer();
 *   const r = analyzer.computeCorrelation(btcPrices, ethPrices);
 *   const matrix = analyzer.buildMatrix(priceData);
 *   const pairs = analyzer.findPairs(matrix, { minCorrelation: 0.8 });
 */

export interface CorrelationResult {
	symbolA: string;
	symbolB: string;
	correlation: number;
	period: number;
	strength: CorrelationStrength;
}

export type CorrelationStrength =
	| "strong_positive"
	| "moderate_positive"
	| "weak"
	| "moderate_negative"
	| "strong_negative";

export interface CorrelationMatrix {
	symbols: string[];
	matrix: number[][];
	generated: string;
}

export interface PairFilterOptions {
	/** Minimum correlation to include (e.g., 0.8 for highly correlated). */
	minCorrelation?: number;
	/** Maximum correlation to include (e.g., -0.5 for negatively correlated). */
	maxCorrelation?: number;
}

export class CorrelationAnalyzer {
	/**
	 * Compute Pearson correlation coefficient between two price series.
	 * Internally converts prices to log-returns before computing correlation,
	 * since raw price levels are non-stationary and produce misleading results.
	 *
	 * Returns a value in [-1, 1], or NaN if insufficient data.
	 */
	computeCorrelation(pricesA: number[], pricesB: number[]): number {
		const returnsA = this.pricesToReturns(pricesA);
		const returnsB = this.pricesToReturns(pricesB);

		// Align to the shorter series
		const len = Math.min(returnsA.length, returnsB.length);
		if (len < 3) return NaN; // Need at least 3 observations for a meaningful correlation

		const a = returnsA.slice(-len);
		const b = returnsB.slice(-len);

		return this.pearson(a, b);
	}

	/**
	 * Build a full NxN correlation matrix for multiple symbols.
	 * Each entry matrix[i][j] is the Pearson correlation between symbol i and symbol j.
	 *
	 * @param priceData Map of symbol -> closing prices (ordered chronologically).
	 */
	buildMatrix(priceData: Map<string, number[]>): CorrelationMatrix {
		const symbols = Array.from(priceData.keys());
		const n = symbols.length;
		const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

		// Pre-compute returns for each symbol
		const returnsMap = new Map<string, number[]>();
		for (const [symbol, prices] of priceData) {
			returnsMap.set(symbol, this.pricesToReturns(prices));
		}

		for (let i = 0; i < n; i++) {
			matrix[i][i] = 1; // Self-correlation is always 1
			for (let j = i + 1; j < n; j++) {
				const rA = returnsMap.get(symbols[i])!;
				const rB = returnsMap.get(symbols[j])!;

				const len = Math.min(rA.length, rB.length);
				if (len < 3) {
					matrix[i][j] = NaN;
					matrix[j][i] = NaN;
					continue;
				}

				const r = this.pearson(rA.slice(-len), rB.slice(-len));
				matrix[i][j] = r2(r);
				matrix[j][i] = r2(r);
			}
		}

		return {
			symbols,
			matrix,
			generated: new Date().toISOString(),
		};
	}

	/**
	 * Extract pairs from a correlation matrix that match the given filter criteria.
	 *
	 * Examples:
	 *   findPairs(matrix, { minCorrelation: 0.8 })    // Highly correlated pairs
	 *   findPairs(matrix, { maxCorrelation: -0.5 })    // Negatively correlated (hedges)
	 *   findPairs(matrix, { minCorrelation: -0.2, maxCorrelation: 0.2 }) // Uncorrelated
	 */
	findPairs(matrix: CorrelationMatrix, options?: PairFilterOptions): CorrelationResult[] {
		const { symbols } = matrix;
		const results: CorrelationResult[] = [];
		const minCorr = options?.minCorrelation ?? -1;
		const maxCorr = options?.maxCorrelation ?? 1;

		for (let i = 0; i < symbols.length; i++) {
			for (let j = i + 1; j < symbols.length; j++) {
				const r = matrix.matrix[i][j];
				if (Number.isNaN(r)) continue;

				if (r >= minCorr && r <= maxCorr) {
					results.push({
						symbolA: symbols[i],
						symbolB: symbols[j],
						correlation: r,
						period: 0, // Matrix doesn't carry per-pair period info; caller can enrich
						strength: this.classifyStrength(r),
					});
				}
			}
		}

		// Sort by absolute correlation descending (strongest relationships first)
		return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
	}

	/**
	 * Compute correlation between two specific symbols from a pre-built matrix.
	 * Returns null if either symbol is not in the matrix.
	 */
	lookupPair(matrix: CorrelationMatrix, symbolA: string, symbolB: string): CorrelationResult | null {
		const idxA = matrix.symbols.indexOf(symbolA);
		const idxB = matrix.symbols.indexOf(symbolB);
		if (idxA < 0 || idxB < 0) return null;

		const r = matrix.matrix[idxA][idxB];
		return {
			symbolA,
			symbolB,
			correlation: r,
			period: 0,
			strength: this.classifyStrength(r),
		};
	}

	/**
	 * Classify the strength of a correlation coefficient.
	 *
	 * Thresholds (standard in financial analysis):
	 *   |r| >= 0.7  -> strong
	 *   |r| >= 0.4  -> moderate
	 *   |r| <  0.4  -> weak
	 */
	classifyStrength(r: number): CorrelationStrength {
		const abs = Math.abs(r);
		if (abs >= 0.7) return r > 0 ? "strong_positive" : "strong_negative";
		if (abs >= 0.4) return r > 0 ? "moderate_positive" : "moderate_negative";
		return "weak";
	}

	/**
	 * Find the most diversified subset of symbols from a correlation matrix.
	 * Returns symbols sorted by average absolute correlation (lowest first),
	 * which indicates assets that provide the most diversification.
	 */
	rankByDiversification(matrix: CorrelationMatrix): Array<{ symbol: string; avgAbsCorrelation: number }> {
		const { symbols } = matrix;
		const n = symbols.length;

		return symbols
			.map((symbol, i) => {
				let sumAbs = 0;
				let count = 0;
				for (let j = 0; j < n; j++) {
					if (i === j) continue;
					const r = matrix.matrix[i][j];
					if (!Number.isNaN(r)) {
						sumAbs += Math.abs(r);
						count++;
					}
				}
				return {
					symbol,
					avgAbsCorrelation: count > 0 ? r2(sumAbs / count) : 0,
				};
			})
			.sort((a, b) => a.avgAbsCorrelation - b.avgAbsCorrelation);
	}

	/**
	 * Compute rolling correlation between two price series.
	 * Returns an array of { windowEnd, correlation } for each window position.
	 *
	 * Useful for detecting correlation regime changes over time.
	 */
	rollingCorrelation(
		pricesA: number[],
		pricesB: number[],
		windowSize: number,
	): Array<{ windowEnd: number; correlation: number }> {
		const returnsA = this.pricesToReturns(pricesA);
		const returnsB = this.pricesToReturns(pricesB);

		const len = Math.min(returnsA.length, returnsB.length);
		if (len < windowSize || windowSize < 3) return [];

		const a = returnsA.slice(-len);
		const b = returnsB.slice(-len);
		const results: Array<{ windowEnd: number; correlation: number }> = [];

		for (let end = windowSize; end <= len; end++) {
			const windowA = a.slice(end - windowSize, end);
			const windowB = b.slice(end - windowSize, end);
			results.push({
				windowEnd: end,
				correlation: r2(this.pearson(windowA, windowB)),
			});
		}

		return results;
	}

	// ── Private helpers ──

	/**
	 * Convert a price series to percent returns.
	 * return[i] = (price[i+1] - price[i]) / price[i]
	 *
	 * Output length = input length - 1.
	 */
	private pricesToReturns(prices: number[]): number[] {
		if (prices.length < 2) return [];
		const returns: number[] = [];
		for (let i = 1; i < prices.length; i++) {
			if (prices[i - 1] === 0) {
				returns.push(0);
			} else {
				returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
			}
		}
		return returns;
	}

	/**
	 * Pearson correlation coefficient for two equal-length arrays.
	 * Returns NaN if the arrays have zero variance (constant values).
	 */
	private pearson(a: number[], b: number[]): number {
		const n = a.length;
		if (n === 0) return NaN;

		let sumA = 0;
		let sumB = 0;
		for (let i = 0; i < n; i++) {
			sumA += a[i];
			sumB += b[i];
		}
		const meanA = sumA / n;
		const meanB = sumB / n;

		let cov = 0;
		let varA = 0;
		let varB = 0;
		for (let i = 0; i < n; i++) {
			const dA = a[i] - meanA;
			const dB = b[i] - meanB;
			cov += dA * dB;
			varA += dA * dA;
			varB += dB * dB;
		}

		if (varA === 0 || varB === 0) return NaN;
		return cov / Math.sqrt(varA * varB);
	}
}

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
