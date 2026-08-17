import type { Strategy, Signal, IndicatorValues } from "../strategy.js";
import type { Candle } from "../../data/candle-store.js";

const VWAP_DISTANCE_PCT = 0.004; // 0.4% deviation from VWAP
const VOLUME_SPIKE_MULT = 2.0; // 2.0x 20-bar avg volume
const VOLUME_AVG_PERIOD = 20;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 25;
const CONFIDENCE_BASE = 0.55;
const CONFIDENCE_CAP = 0.90;

/**
 * Volume-Weighted Momentum Strategy
 *
 * Logic: Enter when price closes ≥0.4% beyond VWAP on a ≥2.0× volume spike,
 * with two consecutive closes on the same side of VWAP and VWAP slope agreeing
 * with the direction. RSI guards against entries into exhausted moves.
 *
 * Best in: Intraday/short-term trend continuation with clear participation.
 * Weak in: Low-volume drift days where VWAP excursions lack follow-through.
 * Complements: mean-reversion (which fades the same extensions when RSI is stretched).
 */
export const volumeMomentumStrategy: Strategy = {
	name: "volume-momentum",
	description:
		"VWAP breakout with volume spike and slope confirmation. Requires 2 consecutive closes on the same side of VWAP; RSI exhaustion filter prevents chasing.",
	timeframe: "1h",
	minCandles: 60,
	riskParams: {
		stopLossAtrMultiplier: 2.0,
		takeProfitRatio: 2.5,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, volumes, rsi, atr, vwap } = indicators;

		if (
			closes.length < 60 ||
			vwap.length < 2 ||
			atr.length === 0 ||
			rsi.length === 0 ||
			volumes.length < VOLUME_AVG_PERIOD
		) return null;

		const lastCandle = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const prevPrice = closes[closes.length - 2];
		const currentVwap = vwap[vwap.length - 1];
		const prevVwap = vwap[vwap.length - 2];
		const currentRsi = rsi[rsi.length - 1];
		const currentAtr = atr[atr.length - 1];

		if (currentVwap <= 0 || prevVwap <= 0 || currentAtr <= 0) return null;

		// Volume gate — gates BOTH directions; cheapest check first
		const recentVols = volumes.slice(-VOLUME_AVG_PERIOD);
		const avgVolume = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
		const currentVolume = volumes[volumes.length - 1];
		if (avgVolume <= 0 || currentVolume < avgVolume * VOLUME_SPIKE_MULT) return null;

		const distancePct = (price - currentVwap) / currentVwap;
		const prevDistance = prevPrice - prevVwap;
		const slopeUp = currentVwap > prevVwap;
		const slopeDown = currentVwap < prevVwap;
		const volumeRatio = currentVolume / avgVolume;

		// ── Long: price ≥0.4% above rising VWAP, prev close also above, RSI not exhausted ──
		if (
			distancePct >= VWAP_DISTANCE_PCT &&
			prevDistance > 0 &&
			slopeUp &&
			currentRsi <= RSI_OVERBOUGHT
		) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDist = price - stopLoss;
			const takeProfit = price + riskDist * this.riskParams.takeProfitRatio;
			const confidence = buildConfidence(distancePct, volumeRatio);
			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence,
				reason: `Price ${(distancePct * 100).toFixed(2)}% above rising VWAP $${currentVwap.toFixed(2)}, vol ${volumeRatio.toFixed(2)}× avg, RSI ${currentRsi.toFixed(1)}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 2.0,
				timestamp: lastCandle.openTime,
			};
		}

		// ── Short: mirror condition ─────────────────────────────────────────
		if (
			distancePct <= -VWAP_DISTANCE_PCT &&
			prevDistance < 0 &&
			slopeDown &&
			currentRsi >= RSI_OVERSOLD
		) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDist = stopLoss - price;
			const takeProfit = price - riskDist * this.riskParams.takeProfitRatio;
			const confidence = buildConfidence(-distancePct, volumeRatio);
			return {
				symbol: lastCandle.symbol,
				direction: "short",
				confidence,
				reason: `Price ${(Math.abs(distancePct) * 100).toFixed(2)}% below falling VWAP $${currentVwap.toFixed(2)}, vol ${volumeRatio.toFixed(2)}× avg, RSI ${currentRsi.toFixed(1)}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 2.0,
				timestamp: lastCandle.openTime,
			};
		}

		return null;
	},
};

/**
 * Confidence = base + distance bonus + volume bonus, capped at 0.90.
 * Distance: 0.4% → 0.04, 1% → 0.10, capped at 0.20.
 * Volume:   2× → 0.05, 3× → 0.10, 5× → 0.15, capped at 0.15.
 */
function buildConfidence(absDistancePct: number, volumeRatio: number): number {
	const distanceBonus = Math.min(absDistancePct * 10, 0.20);
	const volumeBonus = Math.min((volumeRatio - VOLUME_SPIKE_MULT) * 0.05 + 0.05, 0.15);
	return Math.min(CONFIDENCE_BASE + distanceBonus + Math.max(volumeBonus, 0), CONFIDENCE_CAP);
}
