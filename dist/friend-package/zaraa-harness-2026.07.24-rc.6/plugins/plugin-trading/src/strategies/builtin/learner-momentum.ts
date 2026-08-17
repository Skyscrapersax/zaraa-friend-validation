import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";

/**
 * Learner Momentum Strategy
 *
 * Logic: Trades on patterns discovered by the MarketLearner rather than
 * traditional indicator crossovers. The learner has accumulated real
 * market observations (momentum_hour, imbalance_shift) with confidence
 * scores. This strategy checks if the current UTC hour matches a
 * high-confidence pattern for the symbol and generates signals accordingly.
 *
 * Best in: Markets where the learner has accumulated enough data to
 * surface statistically significant hourly momentum patterns.
 *
 * Filters: RSI must be in 20-80 range (avoid extreme conditions).
 * RSI alignment boosts or reduces confidence.
 */

export interface LearnerPattern {
	type: string;
	confidence: number;
	hourOfDay: number | null;
	details: Record<string, unknown>;
}

export type GetPatternsFn = (pair: string, minConf?: number) => LearnerPattern[];

export function createLearnerMomentumStrategy(
	getPatterns: GetPatternsFn,
): Strategy {
	return {
		name: "learner-momentum",
		description:
			"Trades on market learner momentum and imbalance patterns for the current hour",
		timeframe: "1h",
		minCandles: 30,
		riskParams: {
			stopLossAtrMultiplier: 1.5,
			takeProfitRatio: 2.0,
			riskPerTradePct: 0.5,
		},

		evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
			const { closes, rsi, atr } = indicators;
			if (rsi.length === 0 || atr.length === 0 || closes.length === 0) return null;

			const price = closes[closes.length - 1];
			const currentRsi = rsi[rsi.length - 1];
			const currentAtr = atr[atr.length - 1];
			const lastCandle = candles[candles.length - 1];
			const currentHour = new Date().getUTCHours();

			// RSI filter — don't trade in extreme conditions
			if (currentRsi < 20 || currentRsi > 80) return null;

			const pair = lastCandle.symbol.replace("_", "/");
			const patterns = getPatterns(pair, 0.3);

			let bestSignal: { direction: "long" | "short"; confidence: number; reason: string } | null = null;

			for (const p of patterns) {
				if (p.hourOfDay !== currentHour) continue;

				const details = p.details;

				if (p.type === "momentum_hour" && p.confidence > 0.4) {
					const dir = (details.direction as string) === "up" ? "long" : "short";
					const conf = Math.min(0.8, Math.max(0.3, p.confidence));
					if (!bestSignal || conf > bestSignal.confidence) {
						bestSignal = {
							direction: dir,
							confidence: conf,
							reason: `Learner: ${pair} tends to move ${details.direction} at ${currentHour}:00 UTC (${details.avgChangePct ? (details.avgChangePct as number).toFixed(2) : "?"}%, seen ${p.details.sampleCount || "?"} times)`,
						};
					}
				}

				if (p.type === "imbalance_shift" && p.confidence > 0.6) {
					const ratio = (details.avgImbalance || details.avgRatio) as number;
					const dir = ratio > 1.5 ? "long" : "short";
					const conf = Math.min(0.75, Math.max(0.3, p.confidence * 0.8));
					if (!bestSignal || conf > bestSignal.confidence) {
						bestSignal = {
							direction: dir,
							confidence: conf,
							reason: `Learner: ${pair} shows ${ratio > 1.5 ? "buy" : "sell"} pressure at ${currentHour}:00 UTC (ratio ${ratio?.toFixed(2)}, seen ${p.details.sampleCount || "?"} times)`,
						};
					}
				}
			}

			if (!bestSignal) return null;

			// RSI confirmation — boost if RSI agrees with direction
			const rsiAligned =
				(bestSignal.direction === "long" && currentRsi > 45) ||
				(bestSignal.direction === "short" && currentRsi < 55);
			if (!rsiAligned) bestSignal.confidence *= 0.7; // Reduce confidence if RSI disagrees

			const stopLoss =
				bestSignal.direction === "long"
					? price - currentAtr * 1.5
					: price + currentAtr * 1.5;
			const riskDistance = Math.abs(price - stopLoss);

			return {
				symbol: lastCandle.symbol,
				direction: bestSignal.direction,
				confidence: bestSignal.confidence,
				reason: bestSignal.reason + ` [RSI ${currentRsi.toFixed(1)}${rsiAligned ? " aligned" : " divergent"}]`,
				entryPrice: price,
				stopLoss,
				takeProfit:
					bestSignal.direction === "long"
						? price + riskDistance * 2
						: price - riskDistance * 2,
				trailingStopPct: 2.5,
				timestamp: lastCandle.openTime,
			};
		},
	};
}
