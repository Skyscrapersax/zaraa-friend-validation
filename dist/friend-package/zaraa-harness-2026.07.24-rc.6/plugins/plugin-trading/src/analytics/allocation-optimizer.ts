/**
 * Portfolio allocation optimizer using Monte Carlo simulation of random portfolios
 * to approximate the efficient frontier — no linear algebra library dependency.
 *
 * Produces:
 * - Max-Sharpe allocation
 * - Min-Volatility allocation
 * - Max-Sortino allocation
 * - Equal-weight baseline
 * - Risk-parity allocation
 * - Per-regime optimal allocations (conditioned on RegimeConditionedPerf)
 *
 * Uses log returns for Gaussian approximation. For production, swap the
 * Monte Carlo sampler for a proper quadratic solver (cvxpy or similar).
 */

import type { AssetProfile, RegimeConditionedPerf } from "./cross-asset-analyzer.js";
import type { RegimeLabel } from "./regime-detector.js";

export interface Allocation {
	label: string;
	weights: Record<string, number>; // symbol → weight [0,1], sums to ~1
	expectedReturn: number;          // annualized
	expectedVol: number;             // annualized
	sharpe: number;
	sortino: number;
	notes?: string;
}

export interface EfficientFrontierPoint {
	expectedReturn: number;
	expectedVol: number;
	sharpe: number;
	weights: Record<string, number>;
}

export interface OptimizationReport {
	symbols: string[];
	equalWeight: Allocation;
	riskParity: Allocation;
	maxSharpe: Allocation;
	minVol: Allocation;
	maxSortino: Allocation;
	regimeOptimal: Partial<Record<RegimeLabel, Allocation>>;
	frontier: EfficientFrontierPoint[];
	generatedAt: string;
}

const RISK_FREE = 0.05;
const MC_SIMULATIONS = 8_000;

export class AllocationOptimizer {
	/**
	 * Run full optimization suite.
	 *
	 * @param profiles     AssetProfile[] from CrossAssetAnalyzer
	 * @param regimePerf   RegimeConditionedPerf[] from CrossAssetAnalyzer
	 * @param corrMatrix   Full-period correlation matrix (same symbol order as profiles)
	 */
	optimize(
		profiles: AssetProfile[],
		regimePerf: RegimeConditionedPerf[],
		corrMatrix: number[][],
	): OptimizationReport {
		const symbols = profiles.map((p) => p.symbol);
		const returns = profiles.map((p) => p.cagr);
		const vols = profiles.map((p) => p.annualizedVol);
		const covMatrix = this.buildCovMatrix(vols, corrMatrix);

		// Run Monte Carlo to approximate efficient frontier
		const portfolios = this.monteCarlo(symbols, returns, vols, covMatrix);

		const equalWeight = this.buildEqualWeight(symbols, returns, vols, covMatrix);
		const riskParity = this.buildRiskParity(symbols, returns, vols, covMatrix);
		const maxSharpe = this.findMaxSharpe(symbols, portfolios);
		const minVol = this.findMinVol(symbols, portfolios);
		const maxSortino = this.buildMaxSortino(symbols, profiles, covMatrix);

		const regimeOptimal = this.buildRegimeOptimal(symbols, regimePerf, vols, corrMatrix);

		// Sample frontier (20 points along Sharpe-sorted portfolios)
		const sorted = [...portfolios].sort((a, b) => a.expectedReturn - b.expectedReturn);
		const step = Math.max(1, Math.floor(sorted.length / 20));
		const frontier = sorted.filter((_, i) => i % step === 0);

		return {
			symbols,
			equalWeight,
			riskParity,
			maxSharpe,
			minVol,
			maxSortino,
			regimeOptimal,
			frontier,
			generatedAt: new Date().toISOString(),
		};
	}

	// ── Allocation builders ───────────────────────────────────────────────────

	private buildEqualWeight(
		symbols: string[],
		returns: number[],
		vols: number[],
		covMatrix: number[][],
	): Allocation {
		const n = symbols.length;
		const weights = Object.fromEntries(symbols.map((s) => [s, 1 / n]));
		const w = new Array(n).fill(1 / n);
		const { portReturn, portVol } = this.portfolioStats(w, returns, covMatrix);
		return {
			label: "Equal Weight",
			weights,
			expectedReturn: portReturn,
			expectedVol: portVol,
			sharpe: portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0,
			sortino: portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0,
		};
	}

	private buildRiskParity(
		symbols: string[],
		returns: number[],
		vols: number[],
		covMatrix: number[][],
	): Allocation {
		// Inverse-volatility weighting (simple risk parity approximation)
		const invVols = vols.map((v) => (v > 0 ? 1 / v : 0));
		const total = invVols.reduce((s, v) => s + v, 0);
		const w = total > 0 ? invVols.map((v) => v / total) : new Array(symbols.length).fill(1 / symbols.length);

		const { portReturn, portVol } = this.portfolioStats(w, returns, covMatrix);
		const weights = Object.fromEntries(symbols.map((s, i) => [s, w[i]]));

		return {
			label: "Risk Parity (Inv-Vol)",
			weights,
			expectedReturn: portReturn,
			expectedVol: portVol,
			sharpe: portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0,
			sortino: portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0,
			notes: "Weights proportional to 1/volatility",
		};
	}

	private findMaxSharpe(
		symbols: string[],
		portfolios: EfficientFrontierPoint[],
	): Allocation {
		const best = portfolios.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
		return {
			label: "Max Sharpe",
			weights: best.weights,
			expectedReturn: best.expectedReturn,
			expectedVol: best.expectedVol,
			sharpe: best.sharpe,
			sortino: best.sharpe, // approximation; full sortino needs return series
		};
	}

	private findMinVol(
		symbols: string[],
		portfolios: EfficientFrontierPoint[],
	): Allocation {
		const best = portfolios.reduce((a, b) => (b.expectedVol < a.expectedVol ? b : a));
		return {
			label: "Min Volatility",
			weights: best.weights,
			expectedReturn: best.expectedReturn,
			expectedVol: best.expectedVol,
			sharpe: best.sharpe,
			sortino: best.sharpe,
		};
	}

	private buildMaxSortino(
		symbols: string[],
		profiles: AssetProfile[],
		covMatrix: number[][],
	): Allocation {
		// Proxy: use sortino ratio instead of sharpe as objective in MC
		// Re-use MC but score by sortino (estimated as sharpe * skew adjustment)
		const returns = profiles.map((p) => p.cagr);
		const skews = profiles.map((p) => p.skewness);

		// Quick MC with sortino objective
		let best: { w: number[]; sortino: number; portReturn: number; portVol: number } | null = null;
		const n = symbols.length;

		for (let i = 0; i < 3000; i++) {
			const w = this.randomWeights(n);
			const { portReturn, portVol } = this.portfolioStats(w, returns, covMatrix);
			// Sortino approximation: scale by 1 / (1 - avg_skew * weight)
			const portSkew = w.reduce((s, wi, idx) => s + wi * skews[idx], 0);
			const downsideAdj = Math.max(0.5, 1 - portSkew * 0.1);
			const sortino = portVol > 0 ? (portReturn - RISK_FREE) / (portVol * downsideAdj) : 0;

			if (best === null || sortino > best.sortino) {
				best = { w, sortino, portReturn, portVol };
			}
		}

		const w = best?.w ?? new Array(n).fill(1 / n);
		const { portReturn, portVol } = best
			? { portReturn: best.portReturn, portVol: best.portVol }
			: this.portfolioStats(w, returns, covMatrix);

		return {
			label: "Max Sortino",
			weights: Object.fromEntries(symbols.map((s, i) => [s, w[i]])),
			expectedReturn: portReturn,
			expectedVol: portVol,
			sharpe: portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0,
			sortino: best?.sortino ?? 0,
			notes: "Skewness-adjusted Sortino approximation",
		};
	}

	private buildRegimeOptimal(
		symbols: string[],
		regimePerf: RegimeConditionedPerf[],
		vols: number[],
		corrMatrix: number[][],
	): Partial<Record<RegimeLabel, Allocation>> {
		const result: Partial<Record<RegimeLabel, Allocation>> = {};
		const regimeLabels: RegimeLabel[] = ["bull", "bear", "sideways", "volatile"];
		const covMatrix = this.buildCovMatrix(vols, corrMatrix);

		for (const label of regimeLabels) {
			const regimeData = regimePerf.filter((r) => r.regime === label);
			if (regimeData.length < symbols.length) continue;

			const returns = symbols.map((sym) => {
				const d = regimeData.find((r) => r.symbol === sym);
				return d?.avgAnnReturn ?? 0;
			});

			const regimeVols = symbols.map((sym) => {
				const d = regimeData.find((r) => r.symbol === sym);
				return d?.avgAnnVol ?? 0.2;
			});

			const regimeCov = this.buildCovMatrix(regimeVols, corrMatrix);
			const portfolios = this.monteCarlo(symbols, returns, regimeVols, regimeCov, 2000);

			if (portfolios.length === 0) continue;

			const best = portfolios.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
			result[label] = {
				label: `Max Sharpe (${label} regime)`,
				weights: best.weights,
				expectedReturn: best.expectedReturn,
				expectedVol: best.expectedVol,
				sharpe: best.sharpe,
				sortino: best.sharpe,
				notes: `Optimized using regime-conditioned returns during ${label} markets`,
			};
		}

		return result;
	}

	// ── Monte Carlo engine ────────────────────────────────────────────────────

	private monteCarlo(
		symbols: string[],
		returns: number[],
		vols: number[],
		covMatrix: number[][],
		n: number = MC_SIMULATIONS,
	): EfficientFrontierPoint[] {
		const portfolios: EfficientFrontierPoint[] = [];
		const k = symbols.length;

		for (let i = 0; i < n; i++) {
			const w = this.randomWeights(k);
			const { portReturn, portVol } = this.portfolioStats(w, returns, covMatrix);
			const sharpe = portVol > 0 ? (portReturn - RISK_FREE) / portVol : 0;

			portfolios.push({
				expectedReturn: portReturn,
				expectedVol: portVol,
				sharpe,
				weights: Object.fromEntries(symbols.map((s, idx) => [s, w[idx]])),
			});
		}

		return portfolios;
	}

	private randomWeights(n: number): number[] {
		// Dirichlet distribution approximation: exp-normalize uniform random vars
		const raw = Array.from({ length: n }, () => -Math.log(Math.random() + 1e-10));
		const total = raw.reduce((s, v) => s + v, 0);
		return raw.map((v) => v / total);
	}

	private portfolioStats(
		weights: number[],
		returns: number[],
		covMatrix: number[][],
	): { portReturn: number; portVol: number } {
		const portReturn = weights.reduce((s, w, i) => s + w * returns[i], 0);
		let variance = 0;
		for (let i = 0; i < weights.length; i++) {
			for (let j = 0; j < weights.length; j++) {
				variance += weights[i] * weights[j] * (covMatrix[i]?.[j] ?? 0);
			}
		}
		const portVol = Math.sqrt(Math.max(0, variance));
		return { portReturn, portVol };
	}

	private buildCovMatrix(vols: number[], corrMatrix: number[][]): number[][] {
		const n = vols.length;
		return Array.from({ length: n }, (_, i) =>
			Array.from({ length: n }, (_, j) =>
				vols[i] * vols[j] * (corrMatrix[i]?.[j] ?? (i === j ? 1 : 0)),
			),
		);
	}
}
