import type { Candle } from "../data/candle-store.js";
import type { MarketContext } from "./market-context.js";

/** Signal emitted by a strategy when it detects a trade opportunity */
export interface Signal {
	symbol: string;
	direction: "long" | "short";
	confidence: number; // 0-1
	reason: string;
	entryPrice: number;
	/** Strategy-suggested stop-loss (optional — risk manager may override) */
	stopLoss?: number;
	/** Strategy-suggested take-profit (optional) */
	takeProfit?: number;
	/** If set, enables trailing stop at this % distance from high-water mark */
	trailingStopPct?: number;
	timestamp: number;
}

/** Pre-computed indicator values passed to strategy.evaluate() */
export interface IndicatorValues {
	closes: number[];
	highs: number[];
	lows: number[];
	volumes: number[];
	sma: Record<number, number[]>; // keyed by period
	ema: Record<number, number[]>;
	rsi: number[];
	macd: { macd: number[]; signal: number[]; histogram: number[] };
	bollingerBands: { upper: number[]; middle: number[]; lower: number[] };
	atr: number[];
	vwap: number[];
	stochRsi: number[];
	obv: number[];
}

/** Risk parameters for a strategy */
export interface StrategyRiskParams {
	stopLossAtrMultiplier: number;
	takeProfitRatio: number;
	riskPerTradePct: number;
	/**
	 * Hard ceiling on effective R/R: takeProfit distance ≤ maxRiskRewardRatio × stopLoss distance.
	 * Tames high-ATR alts (SOL, XRP) that otherwise produce 8–10x R/R targets unreachable
	 * in normal conditions. Default applied by `applyTpCap`: 3.0.
	 */
	maxRiskRewardRatio?: number;
	/**
	 * Hard ceiling on |takeProfit − entry| / entry, expressed as percent (4 = 4%).
	 * Whichever of `maxRiskRewardRatio` or `maxTpPercent` produces the tighter
	 * TP wins. Default applied by `applyTpCap`: 4.0.
	 */
	maxTpPercent?: number;
}

/** Strategy interface — all strategies implement this */
export interface Strategy {
	/** Unique strategy name */
	name: string;
	/** Human-readable description */
	description: string;
	/** Preferred candle timeframe */
	timeframe: string;
	/** Minimum candles needed before strategy can evaluate */
	minCandles: number;
	/** Risk parameters */
	riskParams: StrategyRiskParams;
	/**
	 * Evaluate candles and indicators to produce a signal (or null if no opportunity).
	 * Called once per candle close.
	 *
	 * `context` is supplied by the signal engine when a MarketContextProvider
	 * is wired up — strategies should treat it as additive (graceful when
	 * null/undefined). Use it to skip signals in unfavorable regimes or
	 * to adjust confidence when patterns agree with the setup.
	 */
	evaluate(
		candles: Candle[],
		indicators: IndicatorValues,
		context?: MarketContext | null,
	): Signal | null;
}

export type { MarketContext } from "./market-context.js";
