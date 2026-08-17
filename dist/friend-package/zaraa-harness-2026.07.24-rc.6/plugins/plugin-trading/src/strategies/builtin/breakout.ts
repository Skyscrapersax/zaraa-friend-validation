import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";

/**
 * Breakout Strategy
 *
 * Logic: Detect Bollinger Band squeeze (low bandwidth) followed by a breakout
 * with volume expansion. Enter in the direction of the breakout.
 *
 * Best in: Markets transitioning from consolidation to trend.
 * Weak in: Low-liquidity markets with false breakouts.
 */
export const breakoutStrategy: Strategy = {
	name: "breakout",
	description:
		"Bollinger Band squeeze detection with volume-confirmed breakout. Enters when volatility expands after compression.",
	timeframe: "1h",
	minCandles: 30,
	riskParams: {
		stopLossAtrMultiplier: 1.5,
		takeProfitRatio: 2.5,
		riskPerTradePct: 1.0, // conservative for real money
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, volumes, bollingerBands: bb, atr, rsi, vwap } = indicators;
		if (bb.middle.length < 5 || atr.length === 0 || volumes.length < 5 || closes.length < 3) return null;

		const price = closes[closes.length - 1];
		const prevPrice = closes[closes.length - 2];
		const prevPrevPrice = closes[closes.length - 3];
		const currentAtr = atr[atr.length - 1];
		const lastCandle = candles[candles.length - 1];

		// Calculate bandwidth (measure of squeeze)
		const bandwidths: number[] = [];
		for (let i = 0; i < bb.middle.length; i++) {
			bandwidths.push((bb.upper[i] - bb.lower[i]) / bb.middle[i]);
		}

		if (bandwidths.length < 5) return null;

		const currentBandwidth = bandwidths[bandwidths.length - 1];
		const prevBandwidth = bandwidths[bandwidths.length - 2];

		// Check for squeeze: recent bandwidth should be among the lowest
		const recentBandwidths = bandwidths.slice(-20);
		const minBandwidth = Math.min(...recentBandwidths);
		const avgBandwidth = recentBandwidths.reduce((a, b) => a + b, 0) / recentBandwidths.length;

		// Squeeze detected: bandwidth was recently compressed
		const wasSqueezing = prevBandwidth < avgBandwidth * 0.8;
		// Expansion: bandwidth is now increasing
		const isExpanding = currentBandwidth > prevBandwidth * 1.1;

		if (!wasSqueezing || !isExpanding) return null;

		// Volume confirmation: current volume > 150% of average (stricter than before)
		const recentVolumes = volumes.slice(-20);
		const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
		const currentVolume = volumes[volumes.length - 1];
		const volumeExpansion = currentVolume > avgVolume * 1.5;

		if (!volumeExpansion) return null;

		const upperBand = bb.upper[bb.upper.length - 1];
		const prevUpperBand = bb.upper.length > 1 ? bb.upper[bb.upper.length - 2] : upperBand;
		const lowerBand = bb.lower[bb.lower.length - 1];
		const prevLowerBand = bb.lower.length > 1 ? bb.lower[bb.lower.length - 2] : lowerBand;
		const currentRsi = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
		const prevRsi = rsi.length > 1 ? rsi[rsi.length - 2] : currentRsi;

		// VWAP conviction filter: for upside breakouts, price should be above VWAP
		// (showing buyers have control), for downside breakouts, below VWAP.
		// A breakout above the Bollinger band while still below VWAP suggests
		// weak conviction — the "average" buyer isn't winning.
		const currentVwap = vwap.length > 0 ? vwap[vwap.length - 1] : 0;
		const hasVwap = currentVwap > 0;

		// Upside breakout with confirmation:
		// - Previous candle broke above upper band (breakout candle)
		// - Current candle STILL above band (confirmation — not just a wick)
		// - RSI aligned (above 50 and rising)
		// - Price above VWAP (conviction check)
		const prevBrokeAbove = prevPrice > prevUpperBand && prevPrevPrice <= prevUpperBand;
		const confirmedAbove = price > upperBand;
		const rsiAlignedUp = currentRsi > 50 && currentRsi > prevRsi;
		const vwapAlignedUp = !hasVwap || price > currentVwap;

		if (prevBrokeAbove && confirmedAbove && rsiAlignedUp && vwapAlignedUp) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence: calculateBreakoutConfidence(
					currentBandwidth, minBandwidth, avgBandwidth,
					currentVolume, avgVolume, currentRsi, "long",
				),
				reason: `Confirmed Bollinger squeeze breakout UP (2-candle confirmation). Vol ${((currentVolume / avgVolume) * 100).toFixed(0)}% of avg, RSI ${currentRsi.toFixed(1)}`,
				entryPrice: price,
				stopLoss,
				takeProfit: price + riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: 3, // Lock in gains as breakout extends
				timestamp: lastCandle.openTime,
			};
		}

		// Downside breakout with confirmation + VWAP conviction
		const prevBrokeBelow = prevPrice < prevLowerBand && prevPrevPrice >= prevLowerBand;
		const confirmedBelow = price < lowerBand;
		const rsiAlignedDown = currentRsi < 50 && currentRsi < prevRsi;
		const vwapAlignedDown = !hasVwap || price < currentVwap;

		if (prevBrokeBelow && confirmedBelow && rsiAlignedDown && vwapAlignedDown) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = stopLoss - price;
			return {
				symbol: lastCandle.symbol,
				direction: "short",
				confidence: calculateBreakoutConfidence(
					currentBandwidth, minBandwidth, avgBandwidth,
					currentVolume, avgVolume, currentRsi, "short",
				),
				reason: `Confirmed Bollinger squeeze breakout DOWN (2-candle confirmation). Vol ${((currentVolume / avgVolume) * 100).toFixed(0)}% of avg, RSI ${currentRsi.toFixed(1)}`,
				entryPrice: price,
				stopLoss,
				takeProfit: price - riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: 3, // Lock in gains as breakout extends
				timestamp: lastCandle.openTime,
			};
		}

		return null;
	},
};

function calculateBreakoutConfidence(
	bandwidth: number,
	minBandwidth: number,
	avgBandwidth: number,
	volume: number,
	avgVolume: number,
	rsi: number,
	direction: "long" | "short",
): number {
	// Tighter squeeze = stronger potential breakout
	const squeezeStrength = Math.min((avgBandwidth - minBandwidth) / avgBandwidth / 0.3, 1);

	// Volume confirmation — scale logarithmically so extreme volume (5-10x avg)
	// provides a meaningful confidence boost beyond the 1.5x gate threshold.
	// Log scale: 1.5x=0.18, 2x=0.35, 3x=0.55, 5x=0.80, 10x=1.0
	const volumeRatio = volume / avgVolume;
	const volumeStrength = Math.min(Math.log(volumeRatio) / Math.log(10), 1);

	// RSI alignment with direction
	const rsiAlignment = direction === "long"
		? Math.min(Math.max(rsi - 50, 0) / 30, 1)
		: Math.min(Math.max(50 - rsi, 0) / 30, 1);

	// Bandwidth expansion rate — how fast is volatility expanding?
	// Rapid expansion from a deep squeeze is a stronger signal
	const expansionRate = avgBandwidth > 0
		? Math.min((bandwidth - minBandwidth) / avgBandwidth, 1)
		: 0;

	return Math.min(0.35 + squeezeStrength * 0.2 + volumeStrength * 0.2 + rsiAlignment * 0.1 + expansionRate * 0.15, 1);
}
