import type { Candle } from "../data/candle-store.js";
import type { MarketRegime } from "../strategies/market-regime.js";
import type { Strategy } from "../strategies/strategy.js";
import type { BacktestConfig } from "./backtester.js";
import {
	WalkForwardValidator,
	type WalkForwardRegimeLabel,
} from "./walk-forward-validator.js";

export interface RegimeValidationPipelineConfig {
	lookbackDays: number;
	walkForwardDays: number;
	stepDays: number;
	excludeRecentCandles: number;
	rollingSharpeFloor: number;
	fourteenDayDrawdownLimitPct: number;
	backtest: Partial<BacktestConfig>;
}

export interface RollingValidationWindow {
	startDate: string;
	endDate: string;
	trades: number;
	sharpeRatio: number;
	maxDrawdownPct: number;
	profitFactor: number;
	totalPnl: number;
	regime: MarketRegime;
	regimeLabel: WalkForwardRegimeLabel;
	volatilityPct: number;
	volatilityBucket: "low" | "normal" | "high";
}

export interface RetrainingTarget {
	strategyName: string;
	symbol: string;
	regime: MarketRegime;
	volatilityBucket: "low" | "normal" | "high";
	trades: number;
	totalPnl: number;
	sharpeRatio: number;
	weight: number;
	reason: string;
}

export interface RollingValidationResult {
	verdict: "VALIDATED" | "SUSPEND";
	reason: string;
	lookbackCandles: number;
	walkForwardCandles: number;
	rollingSharpeRatio: number;
	fourteenDayDrawdownPct: number;
	windows: RollingValidationWindow[];
	retrainingTargets: RetrainingTarget[];
}

const DEFAULT_CONFIG: RegimeValidationPipelineConfig = {
	lookbackDays: 180,
	walkForwardDays: 30,
	stepDays: 30,
	excludeRecentCandles: 5,
	rollingSharpeFloor: 1.2,
	fourteenDayDrawdownLimitPct: 5,
	backtest: {
		startingEquity: 10_000,
		slippagePct: 0.1,
		executionDelayBars: 1,
	},
};

export class RegimeValidationPipeline {
	private config: RegimeValidationPipelineConfig;

	constructor(config: Partial<RegimeValidationPipelineConfig> = {}) {
		this.config = {
			...DEFAULT_CONFIG,
			...config,
			backtest: { ...DEFAULT_CONFIG.backtest, ...config.backtest },
		};
	}

	run(strategy: Strategy, candles: Candle[]): RollingValidationResult {
		const validator = new WalkForwardValidator({
			trainDays: this.config.lookbackDays,
			testDays: this.config.walkForwardDays,
			stepDays: this.config.stepDays,
			excludeRecentCandles: this.config.excludeRecentCandles,
			outOfSampleSharpeFloor: this.config.rollingSharpeFloor,
			maxTestDrawdownPct: this.config.fourteenDayDrawdownLimitPct,
			backtest: this.config.backtest,
		});
		const validation = validator.run(strategy, candles);
		const windows: RollingValidationWindow[] = validation.windows.map((window) => ({
			startDate: window.testStartDate,
			endDate: window.testEndDate,
			trades: window.test.trades,
			sharpeRatio: window.test.sharpeRatio,
			maxDrawdownPct: window.test.maxDrawdownPct,
			profitFactor: window.test.profitFactor,
			totalPnl: window.test.totalPnl,
			regime: window.marketRegime,
			regimeLabel: window.regimeLabel,
			volatilityPct: window.rollingVolatilityPct,
			volatilityBucket: bucketVolatility(window.rollingVolatilityPct),
		}));
		const symbol = candles[0]?.symbol ?? "UNKNOWN";
		const retrainingTargets = buildRetrainingTargets(strategy.name, symbol, windows);
		const verdict = validation.verdict === "VALIDATED" ? "VALIDATED" : "SUSPEND";

		return {
			verdict,
			reason: validation.reason,
			lookbackCandles: validation.trainCandles,
			walkForwardCandles: validation.testCandles,
			rollingSharpeRatio: validation.outOfSampleSharpe,
			fourteenDayDrawdownPct: validation.maxTestDrawdownPct,
			windows,
			retrainingTargets,
		};
	}
}

function buildRetrainingTargets(
	strategyName: string,
	symbol: string,
	windows: RollingValidationWindow[],
): RetrainingTarget[] {
	const groups = new Map<string, RollingValidationWindow[]>();
	for (const window of windows) {
		const key = `${window.regime}:${window.volatilityBucket}`;
		const bucket = groups.get(key) ?? [];
		bucket.push(window);
		groups.set(key, bucket);
	}

	const targets: RetrainingTarget[] = [];
	for (const [key, bucket] of groups) {
		const trades = bucket.reduce((sum, item) => sum + item.trades, 0);
		if (bucket.length < 2 || trades < 5) continue;

		const totalPnl = round2(bucket.reduce((sum, item) => sum + item.totalPnl, 0));
		const weightedSharpe = round2(
			bucket.reduce((sum, item) => sum + item.sharpeRatio * Math.max(item.trades, 1), 0)
			/ bucket.reduce((sum, item) => sum + Math.max(item.trades, 1), 0),
		);
		if (weightedSharpe >= 1 && totalPnl >= 0) continue;

		const [regime, volatilityBucket] = key.split(":") as [MarketRegime, "low" | "normal" | "high"];
		const weight = weightedSharpe < 0 ? 0.55 : weightedSharpe < 0.5 ? 0.7 : 0.85;
		targets.push({
			strategyName,
			symbol,
			regime,
			volatilityBucket,
			trades,
			totalPnl,
			sharpeRatio: weightedSharpe,
			weight,
			reason: `${regime}/${volatilityBucket} attribution weak (Sharpe ${weightedSharpe.toFixed(2)}, PnL $${totalPnl.toFixed(2)})`,
		});
	}

	return targets.sort((a, b) => a.weight - b.weight || a.sharpeRatio - b.sharpeRatio);
}

function bucketVolatility(volatilityPct: number): "low" | "normal" | "high" {
	if (volatilityPct < 1) return "low";
	if (volatilityPct > 3) return "high";
	return "normal";
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
