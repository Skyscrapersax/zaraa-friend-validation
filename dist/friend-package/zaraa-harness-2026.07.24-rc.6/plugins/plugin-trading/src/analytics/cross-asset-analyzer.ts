/**
 * Cross-asset comparative analytics.
 *
 * Given aligned price series for equities, precious metals, and crypto,
 * produces:
 * - Per-asset return/vol/drawdown profile
 * - Cross-asset correlation matrices (full period + per-regime)
 * - Regime-conditioned performance breakdown
 * - Rolling Sharpe and underwater equity curves
 */

import type { AssetSeries } from "./multi-asset-fetcher.js";
import type { RegimeSummary, RegimeLabel } from "./regime-detector.js";
import { CorrelationAnalyzer } from "./correlation-analyzer.js";

export interface AssetProfile {
	symbol: string;
	name: string;
	assetClass: string;
	startDate: string;
	endDate: string;
	totalDays: number;
	totalReturn: number;
	cagr: number;
	annualizedVol: number;
	sharpeRatio: number;
	sortinoRatio: number;
	maxDrawdown: number;
	maxDrawdownDurationDays: number;
	calmarRatio: number;
	skewness: number;
	kurtosis: number;
	valueAt95pct: number; // VaR (95%) daily
	bestDay: number;
	worstDay: number;
}

export interface RegimeConditionedPerf {
	regime: RegimeLabel;
	symbol: string;
	avgAnnReturn: number;
	avgAnnVol: number;
	winRate: number; // % of days with positive return in this regime
	avgDailyReturn: number;
	pctTimeInRegime: number;
}

export interface CorrelationSnapshot {
	label: string; // "full" | "bull" | "bear" | "sideways" | "volatile"
	symbols: string[];
	matrix: number[][];
}

export interface CrossAssetReport {
	generatedAt: string;
	period: { start: string; end: string; days: number };
	profiles: AssetProfile[];
	correlations: CorrelationSnapshot[];
	regimePerf: RegimeConditionedPerf[];
}

const RISK_FREE_RATE = 0.05; // ~5% annualized (approx US T-bill, 2024-26)
const TRADING_DAYS = 252;

export class CrossAssetAnalyzer {
	private corrAnalyzer = new CorrelationAnalyzer();

	/**
	 * Run full comparative analysis.
	 *
	 * @param series       Fetched asset series (may have different start dates)
	 * @param regimes      Regime detection output per symbol (optional; used for cross-regime perf)
	 * @param benchmarkSym Symbol to use as benchmark for regime detection (default: first series)
	 */
	analyze(
		series: AssetSeries[],
		regimes: RegimeSummary[] = [],
	): CrossAssetReport {
		if (series.length === 0) throw new Error("No series provided");

		// Align all series to common date range
		const aligned = this.alignSeries(series);
		const period = {
			start: aligned[0]?.dates[0] ?? "",
			end: aligned[0]?.dates[aligned[0].dates.length - 1] ?? "",
			days: aligned[0]?.prices.length ?? 0,
		};

		const profiles = aligned.map((a) => this.buildProfile(a));
		const correlations = this.buildCorrelations(aligned, regimes);
		const regimePerf = this.buildRegimePerf(aligned, regimes);

		return {
			generatedAt: new Date().toISOString(),
			period,
			profiles,
			correlations,
			regimePerf,
		};
	}

	// ── Internal helpers ──────────────────────────────────────────────────────

	private alignSeries(series: AssetSeries[]): AlignedSeries[] {
		// Find common date intersection
		const dateSets = series.map((s) => new Set(s.bars.map((b) => b.date)));
		let commonDates = [...dateSets[0]];
		for (let i = 1; i < dateSets.length; i++) {
			commonDates = commonDates.filter((d) => dateSets[i].has(d));
		}
		commonDates.sort();

		return series.map((s) => {
			const barMap = new Map(s.bars.map((b) => [b.date, b]));
			const aligned = commonDates
				.map((d) => barMap.get(d))
				.filter((b): b is NonNullable<typeof b> => b != null);

			return {
				symbol: s.symbol,
				name: s.name,
				assetClass: s.assetClass,
				dates: aligned.map((b) => b.date),
				prices: aligned.map((b) => b.adjClose),
				volumes: aligned.map((b) => b.volume),
			};
		});
	}

	private buildProfile(a: AlignedSeries): AssetProfile {
		const { prices } = a;
		const n = prices.length;
		if (n < 2) throw new Error(`Insufficient data for ${a.symbol}`);

		const logRets = this.logReturns(prices);
		const totalReturn = (prices[n - 1] - prices[0]) / prices[0];
		const cagr = (1 + totalReturn) ** (TRADING_DAYS / n) - 1;

		const meanRet = logRets.reduce((s, r) => s + r, 0) / logRets.length;
		const annVol = this.stdDev(logRets) * Math.sqrt(TRADING_DAYS);
		const rfDaily = Math.log(1 + RISK_FREE_RATE) / TRADING_DAYS;
		const sharpe = annVol > 0
			? ((meanRet - rfDaily) * TRADING_DAYS) / annVol
			: 0;

		// Sortino: downside deviation
		const downside = logRets.filter((r) => r < rfDaily);
		const downVol = downside.length > 1
			? Math.sqrt(downside.reduce((s, r) => s + (r - rfDaily) ** 2, 0) / downside.length) * Math.sqrt(TRADING_DAYS)
			: annVol;
		const sortino = downVol > 0
			? ((meanRet - rfDaily) * TRADING_DAYS) / downVol
			: 0;

		// Drawdown
		const { maxDD, maxDDDuration } = this.maxDrawdown(prices);
		const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;

		// Higher moments
		const skew = this.skewness(logRets);
		const kurt = this.kurtosis(logRets);

		// VaR 95%
		const sorted = [...logRets].sort((a, b) => a - b);
		const var95idx = Math.floor(sorted.length * 0.05);
		const var95 = sorted[var95idx] ?? 0;

		return {
			symbol: a.symbol,
			name: a.name,
			assetClass: a.assetClass,
			startDate: a.dates[0],
			endDate: a.dates[n - 1],
			totalDays: n,
			totalReturn,
			cagr,
			annualizedVol: annVol,
			sharpeRatio: sharpe,
			sortinoRatio: sortino,
			maxDrawdown: maxDD,
			maxDrawdownDurationDays: maxDDDuration,
			calmarRatio: calmar,
			skewness: skew,
			kurtosis: kurt,
			valueAt95pct: var95,
			bestDay: Math.max(...logRets),
			worstDay: Math.min(...logRets),
		};
	}

	private buildCorrelations(aligned: AlignedSeries[], regimes: RegimeSummary[]): CorrelationSnapshot[] {
		const symbols = aligned.map((a) => a.symbol);
		const snapshots: CorrelationSnapshot[] = [];

		// Full-period correlation
		snapshots.push({
			label: "full",
			symbols,
			matrix: this.corrMatrix(aligned, aligned[0].dates),
		});

		// Per-regime correlations (using first regime summary as the benchmark regime classifier)
		if (regimes.length > 0) {
			const benchmark = regimes[0];
			const regimeLabels: RegimeLabel[] = ["bull", "bear", "sideways", "volatile"];
			const regimeDateSets = new Map<RegimeLabel, Set<string>>();

			for (const label of regimeLabels) {
				const datesInRegime = new Set(
					benchmark.bars
						.filter((b) => b.regime === label)
						.map((b) => b.date),
				);
				if (datesInRegime.size >= 20) {
					regimeDateSets.set(label, datesInRegime);
				}
			}

			for (const [label, dateSet] of regimeDateSets) {
				const filteredDates = aligned[0].dates.filter((d) => dateSet.has(d));
				if (filteredDates.length >= 20) {
					snapshots.push({
						label,
						symbols,
						matrix: this.corrMatrix(aligned, filteredDates),
					});
				}
			}
		}

		return snapshots;
	}

	private corrMatrix(aligned: AlignedSeries[], dates: string[]): number[][] {
		const dateSet = new Set(dates);
		const filtered = aligned.map((a) => {
			const idxMap = new Map(a.dates.map((d, i) => [d, i]));
			return dates
				.filter((d) => dateSet.has(d) && idxMap.has(d))
				.map((d) => a.prices[idxMap.get(d)!]);
		});

		const n = filtered.length;
		const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

		for (let i = 0; i < n; i++) {
			matrix[i][i] = 1;
			for (let j = i + 1; j < n; j++) {
				const r = this.corrAnalyzer.computeCorrelation(filtered[i], filtered[j]);
				matrix[i][j] = Number.isFinite(r) ? r : 0;
				matrix[j][i] = matrix[i][j];
			}
		}

		return matrix;
	}

	private buildRegimePerf(aligned: AlignedSeries[], regimes: RegimeSummary[]): RegimeConditionedPerf[] {
		if (regimes.length === 0) return [];

		const benchmark = regimes[0];
		const regimeLabels: RegimeLabel[] = ["bull", "bear", "sideways", "volatile"];
		const result: RegimeConditionedPerf[] = [];

		const totalDates = aligned[0].dates.length;

		for (const label of regimeLabels) {
			const regimeDates = new Set(
				benchmark.bars.filter((b) => b.regime === label).map((b) => b.date),
			);
			const pctTimeInRegime = regimeDates.size / totalDates;

			for (const a of aligned) {
				const idxMap = new Map(a.dates.map((d, i) => [d, i]));
				const regimeReturns: number[] = [];

				let prevPrice: number | null = null;
				for (const date of a.dates) {
					const idx = idxMap.get(date);
					if (idx == null) continue;
					const price = a.prices[idx];
					if (prevPrice !== null && regimeDates.has(date)) {
						regimeReturns.push(Math.log(price / prevPrice));
					}
					prevPrice = price;
				}

				if (regimeReturns.length < 5) {
					result.push({
						regime: label,
						symbol: a.symbol,
						avgAnnReturn: 0,
						avgAnnVol: 0,
						winRate: 0,
						avgDailyReturn: 0,
						pctTimeInRegime,
					});
					continue;
				}

				const meanDaily = regimeReturns.reduce((s, r) => s + r, 0) / regimeReturns.length;
				const annVol = this.stdDev(regimeReturns) * Math.sqrt(TRADING_DAYS);
				const winRate = regimeReturns.filter((r) => r > 0).length / regimeReturns.length;

				result.push({
					regime: label,
					symbol: a.symbol,
					avgAnnReturn: meanDaily * TRADING_DAYS,
					avgAnnVol: annVol,
					winRate,
					avgDailyReturn: meanDaily,
					pctTimeInRegime,
				});
			}
		}

		return result;
	}

	// ── Math utilities ────────────────────────────────────────────────────────

	private logReturns(prices: number[]): number[] {
		const out: number[] = [];
		for (let i = 1; i < prices.length; i++) {
			if (prices[i - 1] > 0 && prices[i] > 0) {
				out.push(Math.log(prices[i] / prices[i - 1]));
			}
		}
		return out;
	}

	private stdDev(values: number[]): number {
		if (values.length === 0) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
		return Math.sqrt(variance);
	}

	private skewness(values: number[]): number {
		const n = values.length;
		if (n < 3) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / n;
		const s = this.stdDev(values);
		if (s === 0) return 0;
		return (values.reduce((sum, v) => sum + ((v - mean) / s) ** 3, 0) / n);
	}

	private kurtosis(values: number[]): number {
		const n = values.length;
		if (n < 4) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / n;
		const s = this.stdDev(values);
		if (s === 0) return 0;
		return (values.reduce((sum, v) => sum + ((v - mean) / s) ** 4, 0) / n) - 3; // excess kurtosis
	}

	private maxDrawdown(prices: number[]): { maxDD: number; maxDDDuration: number } {
		let peak = prices[0];
		let maxDD = 0;
		let maxDDDuration = 0;
		let inDD = false;
		let ddStartIdx = 0;

		for (let i = 1; i < prices.length; i++) {
			if (prices[i] > peak) {
				if (inDD) {
					maxDDDuration = Math.max(maxDDDuration, i - ddStartIdx);
					inDD = false;
				}
				peak = prices[i];
				ddStartIdx = i;
			} else {
				if (!inDD) {
					inDD = true;
					ddStartIdx = i;
				}
				const dd = (prices[i] - peak) / peak;
				if (dd < maxDD) {
					maxDD = dd;
					maxDDDuration = Math.max(maxDDDuration, i - ddStartIdx + 1);
				}
			}
		}

		return { maxDD, maxDDDuration };
	}
}

// ── Internal types ────────────────────────────────────────────────────────────

interface AlignedSeries {
	symbol: string;
	name: string;
	assetClass: string;
	dates: string[];
	prices: number[];
	volumes: number[];
}
