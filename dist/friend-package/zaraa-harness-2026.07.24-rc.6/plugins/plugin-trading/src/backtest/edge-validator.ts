/**
 * Statistical edge validation for trading strategies.
 *
 * Three tests determine whether a strategy has genuine edge:
 * 1. Binomial test — is the win rate significantly above 50%?
 * 2. Monte Carlo — does the Sharpe ratio survive random trade-order shuffling?
 * 3. Walk-forward — does performance hold on out-of-sample data?
 */
import type { Candle } from "../data/candle-store.js";
import type { Strategy } from "../strategies/strategy.js";
import { Backtester, type BacktestConfig } from "./backtester.js";
import { calculatePerformance, type BacktestTrade, type PerformanceMetrics } from "./performance.js";

// ── Result Types ──

export interface BinomialResult {
	wins: number;
	total: number;
	winRate: number;
	pValue: number;
	zScore: number;
	isSignificant: boolean;
}

export interface MonteCarloResult {
	actualSharpe: number;
	actualPnl: number;
	percentile: number;
	monteCarloSharpes: number[];
	isRobust: boolean;
	iterations: number;
}

export interface WalkForwardWindow {
	trainMetrics: PerformanceMetrics;
	testMetrics: PerformanceMetrics;
	trainCandles: number;
	testCandles: number;
}

export interface WalkForwardResult {
	windows: WalkForwardWindow[];
	avgTrainSharpe: number;
	avgTestSharpe: number;
	degradation: number;
	isStable: boolean;
}

export interface EdgeValidation {
	binomial: BinomialResult;
	monteCarlo: MonteCarloResult;
	walkForward: WalkForwardResult;
	verdict: "confirmed" | "weak" | "no-edge";
	summary: string;
}

// ── Binomial Test ──

/**
 * Exact binomial test for large n uses normal approximation.
 * H0: p = 0.5 (random coin flip). One-sided test: P(X >= wins).
 */
export function binomialTest(wins: number, total: number): BinomialResult {
	if (total === 0) {
		return { wins: 0, total: 0, winRate: 0, pValue: 1, zScore: 0, isSignificant: false };
	}

	const winRate = wins / total;

	let pValue: number;
	let zScore: number;

	if (total > 100) {
		// Normal approximation for large samples
		zScore = (wins / total - 0.5) / Math.sqrt(0.25 / total);
		pValue = 1 - normalCDF(zScore);
	} else {
		// Exact binomial CDF: P(X >= wins) = sum(C(n,k) * 0.5^n, k=wins..n)
		pValue = 0;
		for (let k = wins; k <= total; k++) {
			pValue += binomialPMF(total, k, 0.5);
		}
		zScore = (winRate - 0.5) / Math.sqrt(0.25 / total);
	}

	return {
		wins,
		total,
		winRate: round(winRate * 100, 2),
		pValue: round(pValue, 6),
		zScore: round(zScore, 4),
		isSignificant: pValue < 0.05,
	};
}

// ── Monte Carlo Trade Shuffling ──

/**
 * Shuffle trade P&L sequence 1000x using Fisher-Yates,
 * recompute Sharpe for each shuffle, report percentile.
 */
export function monteCarloShuffle(
	trades: BacktestTrade[],
	startingEquity: number,
	iterations = 1000,
): MonteCarloResult {
	if (trades.length < 5) {
		return {
			actualSharpe: 0,
			actualPnl: 0,
			percentile: 50,
			monteCarloSharpes: [],
			isRobust: false,
			iterations,
		};
	}

	// Compute actual performance
	const equityCurve = buildEquityCurve(trades, startingEquity);
	const actualMetrics = calculatePerformance(trades, equityCurve);
	const actualSharpe = actualMetrics.sharpeRatio;
	const actualPnl = actualMetrics.totalPnl;

	// Shuffle and recompute
	const pnls = trades.map((t) => t.pnl);
	const sharpes: number[] = [];

	// Only the (rounded) Sharpe of each shuffle is consumed below, so compute it
	// directly from the shuffled PnL sequence instead of rebuilding whole trade
	// objects + equity curves + full PerformanceMetrics per iteration. The helper
	// mirrors calculatePerformance's Sharpe path (tradePnlReturns + computeSharpe)
	// and applies the same r2 rounding, so the percentile/isRobust output is
	// bit-identical to the original metrics-object path.
	const buffer = [...pnls];
	for (let i = 0; i < iterations; i++) {
		fisherYatesShuffle(buffer);
		sharpes.push(sharpeFromPnls(buffer, startingEquity));
	}

	sharpes.sort((a, b) => a - b);

	// Percentile: what fraction of shuffled results are below the actual
	const belowCount = sharpes.filter((s) => s < actualSharpe).length;
	const percentile = round((belowCount / iterations) * 100, 1);

	return {
		actualSharpe: round(actualSharpe, 4),
		actualPnl: round(actualPnl, 2),
		percentile,
		monteCarloSharpes: sharpes,
		isRobust: percentile >= 60,
		iterations,
	};
}

// ── Walk-Forward Backtest ──

/**
 * Split candles into N windows, run strategy on train (70%) then test (30%) each.
 */
/**
 * Out-of-sample degradation: how much worse the test (out-of-sample) Sharpe is
 * versus the train (in-sample) Sharpe, as a percentage. Only DOWNWARD deviation
 * counts — an out-of-sample improvement (test >= train) is not degradation and
 * returns 0, so robust strategies that hold up (or improve) on unseen data are
 * not wrongly flagged unstable. A non-positive train Sharpe has no edge baseline
 * to degrade from, so it is treated as maximum degradation.
 */
export function walkForwardDegradation(avgTrainSharpe: number, avgTestSharpe: number): number {
	if (avgTrainSharpe <= 0) return 100;
	const pct = ((avgTrainSharpe - avgTestSharpe) / avgTrainSharpe) * 100;
	return round(Math.max(0, pct), 1);
}

export function walkForwardTest(
	strategy: Strategy,
	candles: Candle[],
	config?: Partial<BacktestConfig>,
	windows = 3,
): WalkForwardResult {
	if (candles.length < 100) {
		return {
			windows: [],
			avgTrainSharpe: 0,
			avgTestSharpe: 0,
			degradation: 100,
			isStable: false,
		};
	}

	const backtester = new Backtester(config);
	const windowSize = Math.floor(candles.length / windows);
	const results: WalkForwardWindow[] = [];

	for (let i = 0; i < windows; i++) {
		const start = i * windowSize;
		const end = i === windows - 1 ? candles.length : (i + 1) * windowSize;
		const windowCandles = candles.slice(start, end);

		const trainEnd = Math.floor(windowCandles.length * 0.7);
		const trainCandles = windowCandles.slice(0, trainEnd);
		const testCandles = windowCandles.slice(trainEnd);

		const trainResult = backtester.run(strategy, trainCandles);
		const testResult = backtester.run(strategy, testCandles);

		results.push({
			trainMetrics: trainResult.performance,
			testMetrics: testResult.performance,
			trainCandles: trainCandles.length,
			testCandles: testCandles.length,
		});
	}

	const avgTrainSharpe = results.length > 0
		? round(results.reduce((s, w) => s + w.trainMetrics.sharpeRatio, 0) / results.length, 4)
		: 0;
	const avgTestSharpe = results.length > 0
		? round(results.reduce((s, w) => s + w.testMetrics.sharpeRatio, 0) / results.length, 4)
		: 0;

	const degradation = walkForwardDegradation(avgTrainSharpe, avgTestSharpe);

	return {
		windows: results,
		avgTrainSharpe,
		avgTestSharpe,
		degradation,
		isStable: degradation < 50,
	};
}

// ── Main Validation ──

/**
 * Run all three statistical tests and produce a verdict.
 */
export function validateEdge(
	strategy: Strategy,
	candles: Candle[],
	config?: Partial<BacktestConfig>,
): EdgeValidation {
	const backtester = new Backtester(config);
	const result = backtester.run(strategy, candles);

	const binomial = binomialTest(
		result.performance.winningTrades,
		result.performance.totalTrades,
	);

	const monteCarlo = monteCarloShuffle(
		result.trades,
		config?.startingEquity ?? 10_000,
	);

	const walkForward = walkForwardTest(strategy, candles, config);

	// Verdict: count how many tests pass
	const passes = [
		binomial.isSignificant,
		monteCarlo.isRobust,
		walkForward.isStable,
	].filter(Boolean).length;

	const verdict: EdgeValidation["verdict"] =
		passes >= 3 ? "confirmed" :
		passes >= 2 ? "weak" :
		"no-edge";

	const summary = [
		`Binomial: ${binomial.isSignificant ? "PASS" : "FAIL"} (p=${binomial.pValue}, winRate=${binomial.winRate}%)`,
		`Monte Carlo: ${monteCarlo.isRobust ? "PASS" : "FAIL"} (percentile=${monteCarlo.percentile}%, Sharpe=${monteCarlo.actualSharpe})`,
		`Walk-Forward: ${walkForward.isStable ? "PASS" : "FAIL"} (degradation=${walkForward.degradation}%, train=${walkForward.avgTrainSharpe} test=${walkForward.avgTestSharpe})`,
		`Verdict: ${verdict.toUpperCase()}`,
	].join(" | ");

	return { binomial, monteCarlo, walkForward, verdict, summary };
}

// ── Utility Functions ──

function round(n: number, decimals: number): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

/** Standard normal CDF using Abramowitz & Stegun approximation */
function normalCDF(z: number): number {
	if (z < -8) return 0;
	if (z > 8) return 1;
	const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
	const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
	const sign = z < 0 ? -1 : 1;
	const x = Math.abs(z) / Math.sqrt(2);
	const t = 1 / (1 + p * x);
	const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
	return 0.5 * (1 + sign * y);
}

/** Binomial PMF: C(n,k) * p^k * (1-p)^(n-k) using log-space to avoid overflow */
function binomialPMF(n: number, k: number, p: number): number {
	let logPMF = 0;
	for (let i = 0; i < k; i++) {
		logPMF += Math.log(n - i) - Math.log(i + 1);
	}
	logPMF += k * Math.log(p) + (n - k) * Math.log(1 - p);
	return Math.exp(logPMF);
}

/** Fisher-Yates shuffle (in-place) */
function fisherYatesShuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/** Build equity curve from trades */
function buildEquityCurve(trades: BacktestTrade[], startingEquity: number): number[] {
	const curve = [startingEquity];
	let equity = startingEquity;
	for (const t of trades) {
		equity += t.pnl;
		curve.push(equity);
	}
	return curve;
}

/**
 * Annualized Sharpe of a PnL sequence, computed directly without rebuilding
 * trade/curve/metrics objects. Mirrors performance.ts's tradePnlReturns +
 * computeSharpe (per-trade return = pnl/equity when equity>0 else 0; sample
 * variance with n-1; (mean/stdDev)*sqrt(365); length<2 or stdDev===0 -> 0) and
 * applies the same 2-decimal rounding calculatePerformance applies to
 * sharpeRatio, so output matches the discarded-metrics-object path exactly.
 */
function sharpeFromPnls(pnls: number[], startingEquity: number): number {
	const n = pnls.length;
	if (n < 2) return 0;
	// First pass: per-trade returns + mean (single equity walk).
	let equity = startingEquity;
	let sum = 0;
	const returns = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const pnl = pnls[i];
		const ret = equity > 0 ? pnl / equity : 0;
		returns[i] = ret;
		sum += ret;
		equity += pnl;
	}
	const mean = sum / n;
	// Second pass: sample variance (n-1), matching computeSharpe.
	let sse = 0;
	for (let i = 0; i < n; i++) {
		const d = returns[i] - mean;
		sse += d * d;
	}
	const variance = sse / (n - 1);
	const stdDev = Math.sqrt(variance);
	if (stdDev === 0) return 0;
	const sharpe = (mean / stdDev) * Math.sqrt(365);
	// Same r2 rounding calculatePerformance applies before exposing sharpeRatio.
	return Math.round(sharpe * 100) / 100;
}
