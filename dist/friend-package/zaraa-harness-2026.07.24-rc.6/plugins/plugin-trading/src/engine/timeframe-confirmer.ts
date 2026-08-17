/**
 * Multi-Timeframe Signal Confirmation Layer
 *
 * Checks a signal's direction against a higher timeframe trend before execution.
 * A 15m buy signal confirmed by a 4h uptrend is far more reliable than one
 * fighting the higher timeframe trend. This dramatically reduces false signals.
 *
 * Timeframe ladder: 5m→1h, 15m→4h, 1h→1d, 4h→1w
 * Uses EMA crossover (fast 12 / slow 26) on the higher timeframe to determine trend.
 */

import type { CandleStore, Candle } from "../data/candle-store.js";
import { ema } from "../indicators/index.js";

/** Timeframe ladder: maps a signal's timeframe to the confirmation timeframe */
const TIMEFRAME_LADDER: Record<string, string> = {
	"1m": "15m",
	"5m": "1h",
	"15m": "4h",
	"1h": "1d",
	"4h": "1w",
};

const DEFAULT_FAST_PERIOD = 12;
const DEFAULT_SLOW_PERIOD = 26;

/** Minimum candles needed on the higher timeframe to compute EMA crossover */
const MIN_HTF_CANDLES = 30;

export interface TimeframeConfirmation {
	confirmed: boolean;
	higherTfTrend: "bullish" | "bearish" | "neutral";
	higherTfTimeframe: string;
	confidence: number; // 0-1, strength of the higher TF trend
	reason: string;
}

export interface TimeframeConfirmerConfig {
	/** Enable multi-timeframe confirmation (default: false) */
	enabled: boolean;
	/** Fast EMA period for higher TF trend (default: 12) */
	fastPeriod: number;
	/** Slow EMA period for higher TF trend (default: 26) */
	slowPeriod: number;
}

export const DEFAULT_MTF_CONFIG: TimeframeConfirmerConfig = {
	enabled: false,
	fastPeriod: DEFAULT_FAST_PERIOD,
	slowPeriod: DEFAULT_SLOW_PERIOD,
};

/**
 * Resolve the higher timeframe for confirmation.
 * Returns null if the signal timeframe has no ladder mapping.
 */
export function getHigherTimeframe(signalTimeframe: string): string | null {
	return TIMEFRAME_LADDER[signalTimeframe.toLowerCase()] ?? null;
}

/**
 * Determine the trend on a higher timeframe using EMA crossover.
 *
 * - bullish: fast EMA > slow EMA (and diverging)
 * - bearish: fast EMA < slow EMA (and diverging)
 * - neutral: EMAs are close together (within 0.1% of price)
 *
 * Confidence is based on how far apart the EMAs are relative to price.
 */
export function assessHigherTimeframeTrend(
	candles: Candle[],
	config: TimeframeConfirmerConfig = DEFAULT_MTF_CONFIG,
): { trend: "bullish" | "bearish" | "neutral"; confidence: number } {
	const closes = candles.map((c) => c.close);
	if (closes.length < config.slowPeriod + 1) {
		return { trend: "neutral", confidence: 0 };
	}

	const fastEma = ema(closes, config.fastPeriod);
	const slowEma = ema(closes, config.slowPeriod);

	if (fastEma.length === 0 || slowEma.length === 0) {
		return { trend: "neutral", confidence: 0 };
	}

	// Align: fast EMA is longer than slow EMA
	const offset = fastEma.length - slowEma.length;
	const latestFast = fastEma[fastEma.length - 1];
	const latestSlow = slowEma[slowEma.length - 1];
	const latestPrice = closes[closes.length - 1];

	// Spread as percentage of price
	const spread = (latestFast - latestSlow) / latestPrice;
	const absSpread = Math.abs(spread);

	// Neutral zone: EMAs within 0.1% of each other
	if (absSpread < 0.001) {
		return { trend: "neutral", confidence: Math.min(absSpread / 0.001, 1) * 0.3 };
	}

	const trend = spread > 0 ? "bullish" : "bearish";
	// Confidence scales from 0.3 (just outside neutral) to 1.0 (strong trend)
	// 1% spread = max confidence
	const confidence = Math.min(0.3 + (absSpread / 0.01) * 0.7, 1.0);

	return { trend, confidence };
}

/**
 * Confirm a signal against the higher timeframe trend.
 *
 * - A buy (long) signal is confirmed if higher TF is bullish or neutral.
 * - A sell (short) signal is confirmed if higher TF is bearish or neutral.
 * - If the higher TF actively disagrees, the signal is rejected.
 *
 * @param direction - Signal direction ("long" or "short")
 * @param symbol - Trading pair symbol
 * @param signalTimeframe - The timeframe the signal was generated on
 * @param candleStore - CandleStore to fetch higher TF candles
 * @param config - Confirmer configuration
 */
export function confirmSignalTimeframe(
	direction: "long" | "short",
	symbol: string,
	signalTimeframe: string,
	candleStore: CandleStore,
	config: TimeframeConfirmerConfig = DEFAULT_MTF_CONFIG,
): TimeframeConfirmation {
	const higherTf = getHigherTimeframe(signalTimeframe);
	if (!higherTf) {
		// No ladder mapping — pass through (e.g., weekly signals have no higher TF)
		return {
			confirmed: true,
			higherTfTrend: "neutral",
			higherTfTimeframe: signalTimeframe,
			confidence: 0,
			reason: `no higher timeframe mapping for ${signalTimeframe}`,
		};
	}

	const htfCandles = candleStore.getAscending(symbol, higherTf, MIN_HTF_CANDLES + config.slowPeriod);
	if (htfCandles.length < MIN_HTF_CANDLES) {
		// Insufficient higher TF data — pass through rather than block
		return {
			confirmed: true,
			higherTfTrend: "neutral",
			higherTfTimeframe: higherTf,
			confidence: 0,
			reason: `insufficient ${higherTf} candles (${htfCandles.length}/${MIN_HTF_CANDLES})`,
		};
	}

	const { trend, confidence } = assessHigherTimeframeTrend(htfCandles, config);

	// Confirmation logic:
	// - long is confirmed by bullish or neutral higher TF
	// - short is confirmed by bearish or neutral higher TF
	const confirmed =
		trend === "neutral" ||
		(direction === "long" && trend === "bullish") ||
		(direction === "short" && trend === "bearish");

	const reason = confirmed
		? `${higherTf} trend ${trend} (conf=${confidence.toFixed(2)}) confirms ${direction}`
		: `${higherTf} trend ${trend} (conf=${confidence.toFixed(2)}) disagrees with ${direction}`;

	return {
		confirmed,
		higherTfTrend: trend,
		higherTfTimeframe: higherTf,
		confidence,
		reason,
	};
}
