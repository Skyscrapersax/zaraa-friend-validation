import type { Candle } from "../data/candle-store.js";
import { computeIndicators } from "../strategies/compute-indicators.js";
import {
	computeADX,
	detectRegime,
	type MarketRegime,
} from "../strategies/market-regime.js";
import type { Strategy } from "../strategies/strategy.js";
import { Backtester, type BacktestConfig, type BacktestResult } from "./backtester.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WalkForwardRegimeLabel = "TREND" | "MEAN_REVERT" | "CHOPPY";

export interface WalkForwardValidatorConfig {
	trainDays: number;
	testDays: number;
	stepDays: number;
	excludeRecentCandles: number;
	outOfSampleSharpeFloor: number;
	maxTestDrawdownPct: number;
	/** Minimum test trades a window needs to count toward the OOS aggregate —
	 * smaller windows yield degenerate per-window Sharpe ratios (±huge values). */
	minTradesPerWindow: number;
	/** Minimum total out-of-sample trades (across qualifying windows) before a
	 * Sharpe-based verdict is trustworthy; below this → INSUFFICIENT_DATA. */
	minOosTrades: number;
	backtest: Partial<BacktestConfig>;
}

export interface WalkForwardWindowMetrics {
	trades: number;
	sharpeRatio: number;
	maxDrawdownPct: number;
	profitFactor: number;
	totalPnl: number;
}

export interface WalkForwardWindow {
	trainStartDate: string;
	trainEndDate: string;
	testStartDate: string;
	testEndDate: string;
	trainCandles: number;
	testCandles: number;
	train: WalkForwardWindowMetrics;
	test: WalkForwardWindowMetrics;
	marketRegime: MarketRegime;
	regimeLabel: WalkForwardRegimeLabel;
	adx: number;
	rollingVolatilityPct: number;
}

export interface WalkForwardValidationResult {
	verdict: "VALIDATED" | "REJECTED" | "INSUFFICIENT_DATA";
	reason: string;
	trainCandles: number;
	testCandles: number;
	outOfSampleSharpe: number;
	outOfSampleTotalPnl: number;
	maxTestDrawdownPct: number;
	windows: WalkForwardWindow[];
}

const DEFAULT_CONFIG: WalkForwardValidatorConfig = {
	trainDays: 180,
	testDays: 30,
	stepDays: 30,
	excludeRecentCandles: 5,
	outOfSampleSharpeFloor: 1.2,
	maxTestDrawdownPct: 5,
	minTradesPerWindow: 3,
	minOosTrades: 10,
	backtest: {
		startingEquity: 10_000,
		slippagePct: 0.1,
		executionDelayBars: 1,
	},
};

export class WalkForwardValidator {
	private config: WalkForwardValidatorConfig;

	constructor(config: Partial<WalkForwardValidatorConfig> = {}) {
		this.config = {
			...DEFAULT_CONFIG,
			...config,
			backtest: { ...DEFAULT_CONFIG.backtest, ...config.backtest },
		};
	}

	run(strategy: Strategy, candles: Candle[]): WalkForwardValidationResult {
		const timeframeMs = timeframeToMs(strategy.timeframe);
		if (!timeframeMs) {
			return {
				verdict: "INSUFFICIENT_DATA",
				reason: `unsupported timeframe ${strategy.timeframe}`,
				trainCandles: 0,
				testCandles: 0,
				outOfSampleSharpe: 0,
				outOfSampleTotalPnl: 0,
				maxTestDrawdownPct: 0,
				windows: [],
			};
		}

		const trainCandles = Math.ceil((this.config.trainDays * DAY_MS) / timeframeMs);
		const testCandles = Math.ceil((this.config.testDays * DAY_MS) / timeframeMs);
		const stepCandles = Math.max(1, Math.ceil((this.config.stepDays * DAY_MS) / timeframeMs));
		const unbiasedCandles = candles.slice(0, -this.config.excludeRecentCandles);

		if (unbiasedCandles.length < trainCandles + testCandles) {
			return {
				verdict: "INSUFFICIENT_DATA",
				reason: `insufficient history ${unbiasedCandles.length}/${trainCandles + testCandles} candles`,
				trainCandles,
				testCandles,
				outOfSampleSharpe: 0,
				outOfSampleTotalPnl: 0,
				maxTestDrawdownPct: 0,
				windows: [],
			};
		}

		const backtester = new Backtester(this.config.backtest);
		const windows: WalkForwardWindow[] = [];

		for (
			let testStart = trainCandles;
			testStart + testCandles <= unbiasedCandles.length;
			testStart += stepCandles
		) {
			const trainWindow = unbiasedCandles.slice(testStart - trainCandles, testStart);
			const testWindow = unbiasedCandles.slice(testStart, testStart + testCandles);
			if (
				trainWindow.length < strategy.minCandles
				|| testWindow.length < strategy.minCandles
			) {
				continue;
			}

			const trainResult = backtester.run(strategy, trainWindow);
			const testResult = backtester.run(strategy, testWindow);
			const indicators = computeIndicators(testWindow);
			const regimeAnalysis = detectRegime(indicators);
			const adxValues = computeADX(indicators.highs, indicators.lows, indicators.closes, 14);
			const adx = adxValues.at(-1) ?? regimeAnalysis.adx ?? 20;
			const rollingVolatilityPct = computeRollingVolatilityPct(indicators.closes);

			windows.push({
				trainStartDate: toIso(trainWindow[0]?.openTime),
				trainEndDate: toIso(trainWindow.at(-1)?.openTime),
				testStartDate: toIso(testWindow[0]?.openTime),
				testEndDate: toIso(testWindow.at(-1)?.openTime),
				trainCandles: trainWindow.length,
				testCandles: testWindow.length,
				train: toWindowMetrics(trainResult),
				test: toWindowMetrics(testResult),
				marketRegime: regimeAnalysis.regime,
				regimeLabel: classifyRegimeLabel(adx, rollingVolatilityPct),
				adx: round2(adx),
				rollingVolatilityPct: round2(rollingVolatilityPct),
			});
		}

		if (windows.length === 0) {
			return {
				verdict: "INSUFFICIENT_DATA",
				reason: "no valid walk-forward windows",
				trainCandles,
				testCandles,
				outOfSampleSharpe: 0,
				outOfSampleTotalPnl: 0,
				maxTestDrawdownPct: 0,
				windows: [],
			};
		}

		// Only windows with enough test trades count toward the aggregate — a 1–2-trade
		// window's Sharpe is degenerate (near-zero return variance → ±huge values), so a
		// tiny window must not be able to manufacture (or veto) a verdict.
		const qualifying = windows.filter(
			(window) => window.test.trades >= this.config.minTradesPerWindow,
		);
		const oosTrades = qualifying.reduce((sum, window) => sum + window.test.trades, 0);
		if (qualifying.length === 0 || oosTrades < this.config.minOosTrades) {
			return {
				verdict: "INSUFFICIENT_DATA",
				reason:
					`insufficient out-of-sample trades ${oosTrades} (need ${this.config.minOosTrades} ` +
					`across windows with ≥${this.config.minTradesPerWindow} trades each)`,
				trainCandles,
				testCandles,
				outOfSampleSharpe: 0,
				outOfSampleTotalPnl: 0,
				maxTestDrawdownPct: 0,
				windows,
			};
		}

		const totalWeight = qualifying.reduce((sum, window) => sum + window.test.trades, 0);
		const outOfSampleSharpe = round2(
			qualifying.reduce((sum, window) => sum + window.test.sharpeRatio * window.test.trades, 0) /
				totalWeight,
		);
		const maxTestDrawdownPct = round2(
			qualifying.reduce((maxDrawdown, window) => Math.max(maxDrawdown, window.test.maxDrawdownPct), 0),
		);
		const outOfSampleTotalPnl = round2(
			qualifying.reduce((sum, window) => sum + window.test.totalPnl, 0),
		);

		if (outOfSampleSharpe < this.config.outOfSampleSharpeFloor) {
			return {
				verdict: "REJECTED",
				reason:
					`out_of_sample_sharpe ${outOfSampleSharpe.toFixed(2)} ` +
					`below ${this.config.outOfSampleSharpeFloor.toFixed(2)}`,
				trainCandles,
				testCandles,
				outOfSampleSharpe,
				outOfSampleTotalPnl,
				maxTestDrawdownPct,
				windows,
			};
		}

		if (maxTestDrawdownPct > this.config.maxTestDrawdownPct) {
			return {
				verdict: "REJECTED",
				reason:
					`test_drawdown ${maxTestDrawdownPct.toFixed(2)}% ` +
					`above ${this.config.maxTestDrawdownPct.toFixed(2)}%`,
				trainCandles,
				testCandles,
				outOfSampleSharpe,
				outOfSampleTotalPnl,
				maxTestDrawdownPct,
				windows,
			};
		}

		// A positive Sharpe with negative realized OOS PnL is the tell-tale sign of a
		// degenerate small-sample Sharpe — require the strategy to actually make money
		// out-of-sample, not just clear the Sharpe floor.
		if (outOfSampleTotalPnl <= 0) {
			return {
				verdict: "REJECTED",
				reason:
					`out_of_sample_pnl ${outOfSampleTotalPnl.toFixed(2)} not positive ` +
					`(Sharpe ${outOfSampleSharpe.toFixed(2)} likely degenerate on small windows)`,
				trainCandles,
				testCandles,
				outOfSampleSharpe,
				outOfSampleTotalPnl,
				maxTestDrawdownPct,
				windows,
			};
		}

		return {
			verdict: "VALIDATED",
			reason: "walk-forward validation passed",
			trainCandles,
			testCandles,
			outOfSampleSharpe,
			outOfSampleTotalPnl,
			maxTestDrawdownPct,
			windows,
		};
	}
}

function toWindowMetrics(result: BacktestResult): WalkForwardWindowMetrics {
	return {
		trades: result.trades.length,
		sharpeRatio: round2(result.performance.sharpeRatio),
		maxDrawdownPct: round2(result.performance.maxDrawdownPct),
		profitFactor: normalizeProfitFactor(result.performance.profitFactor),
		totalPnl: round2(result.performance.totalPnl),
	};
}

function classifyRegimeLabel(adx: number, rollingVolatilityPct: number): WalkForwardRegimeLabel {
	if (adx >= 25) return "TREND";
	if (adx < 20 && rollingVolatilityPct <= 2) return "MEAN_REVERT";
	return "CHOPPY";
}

function computeRollingVolatilityPct(closes: number[], lookback = 20): number {
	if (closes.length < 3) return 0;
	const start = Math.max(1, closes.length - lookback);
	const returns: number[] = [];
	for (let i = start; i < closes.length; i++) {
		const previous = closes[i - 1];
		if (previous <= 0) continue;
		returns.push((closes[i] - previous) / previous);
	}
	if (returns.length < 2) return 0;
	const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
	const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
	return Math.sqrt(variance) * 100;
}

function normalizeProfitFactor(profitFactor: number): number {
	if (Number.isFinite(profitFactor)) return round2(profitFactor);
	return profitFactor > 0 ? 999 : 0;
}

function timeframeToMs(timeframe: string): number | null {
	const match = timeframe.trim().toLowerCase().match(/^(\d+)(m|h|d|w)$/);
	if (!match) return null;
	const value = Number(match[1]);
	const unit = match[2];
	if (!Number.isFinite(value) || value <= 0) return null;
	switch (unit) {
		case "m": return value * 60 * 1000;
		case "h": return value * 60 * 60 * 1000;
		case "d": return value * DAY_MS;
		case "w": return value * 7 * DAY_MS;
		default: return null;
	}
}

function toIso(timestamp?: number): string {
	return timestamp ? new Date(timestamp).toISOString() : "";
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
