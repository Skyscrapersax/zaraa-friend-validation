import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";
import type { FundingRateStats } from "../../signals/funding-rate-monitor.js";
import { applyTpCap } from "../tp-cap.js";

/**
 * Funding Squeeze Fade Strategy
 *
 * Logic: When perpetual-futures funding rate gets extreme on Crypto.com
 * (annualized APR ≥ +50% short-bias, ≤ -50% long-bias) the crowd is
 * paying a heavy premium to be on one side of the trade. Historically
 * the spot price mean-reverts within 1–3 funding periods (8–24h) as
 * the carry cost forces traders to close and the order-book pressure
 * normalises. This strategy fades that crowded side on the spot pair.
 *
 * Triggers:
 *   - SHORT when annualizedPct ≥ +50% and the 24h average APR ≥ +30%
 *     (stability guard against single-spike anomalies). RSI must be
 *     below 75 (no chasing into overbought rejection that already
 *     happened) and we must NOT be at a fresh 20-bar high in the last
 *     3 candles (anti-chase).
 *   - LONG mirror image: annualizedPct ≤ -50%, 24h ≤ -30%, RSI > 25,
 *     no fresh 20-bar low in the last 3 candles.
 *
 * Confidence: base 0.85, +0.05 if RSI confirms the crowd we're fading
 * (RSI > 60 for shorts = greed; RSI < 40 for longs = fear). Capped at
 * 0.90 — the signal engine applies a 0.8× penalty to single-source
 * strategies that don't agree with multi-strategy consensus, so a
 * confidence ceiling here keeps us inside the conservative band even
 * after the bonus.
 *
 * Filters: needs current funding stats from a FundingRateMonitor; if
 * the monitor has no entries yet, we return null. The 24h average
 * stability guard prevents entry on a single freak observation.
 *
 * Risk: ATR-based 2.5× stop, 1.5 R/R take-profit (passed through
 * applyTpCap so high-ATR alts don't blow past the 4% absolute cap),
 * 1.0% risk-per-trade, 2.0% trailing stop.
 *
 * Default OFF — register-only. Operator must enable via
 * trade_deploy_strategy after live-funding pipe is verified.
 */

const ANNUALIZED_TRIGGER_PCT = 50;
const AVG24H_STABILITY_APR = 30;
const RSI_SHORT_MAX = 75;
const RSI_LONG_MIN = 25;
const RSI_SHORT_CROWD_GREED_MIN = 60;
const RSI_LONG_CROWD_FEAR_MAX = 40;
const BASE_CONFIDENCE = 0.85;
const CROWD_CONFIRM_BONUS = 0.05;
const MAX_CONFIDENCE = 0.90;
const ANTI_CHASE_LOOKBACK = 3;
const ANTI_CHASE_LOOKBACK_HIGH = 20;
const EXCHANGE = "crypto.com";

export type GetFundingStatsFn = (
	symbol: string,
	exchange: string,
) => FundingRateStats | null;

export function createFundingSqueezeFadeStrategy(
	getFundingStats: GetFundingStatsFn,
): Strategy {
	return {
		name: "funding-squeeze-fade",
		description:
			"Fades extreme perp funding rates on Crypto.com (≥+50% APR short, ≤-50% APR long) on the spot pair after stability and anti-chase confirmation",
		timeframe: "1h",
		minCandles: 30,
		riskParams: {
			stopLossAtrMultiplier: 2.5,
			takeProfitRatio: 1.5,
			riskPerTradePct: 1.0,
			maxRiskRewardRatio: 3.0,
			maxTpPercent: 4.0,
		},

		evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
			const { closes, rsi, atr } = indicators;
			if (rsi.length === 0 || atr.length === 0) return null;
			if (closes.length < ANTI_CHASE_LOOKBACK_HIGH + ANTI_CHASE_LOOKBACK) return null;

			const currentAtr = atr[atr.length - 1];
			if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

			const lastCandle = candles[candles.length - 1];
			if (!lastCandle) return null;

			const stats = getFundingStats(lastCandle.symbol, EXCHANGE);
			if (!stats || stats.entryCount === 0) return null;

			const price = closes[closes.length - 1];
			const currentRsi = rsi[rsi.length - 1];

			// Annualize the 24h average — stats only annualizes the latest tick.
			// 3 funding periods per day × 365 days.
			const avg24hAnnualized = stats.avg24h * 3 * 365;

			// 20-bar high/low for anti-chase guard. Compare the most-recent
			// 3 closes against the high/low of the prior 20 bars (so a breakout
			// in the recent window is detectable without being included in the
			// reference range).
			const refStart = -ANTI_CHASE_LOOKBACK_HIGH - ANTI_CHASE_LOOKBACK;
			const refEnd = -ANTI_CHASE_LOOKBACK;
			const lookbackCloses = closes.slice(refStart, refEnd);
			const high20 = Math.max(...lookbackCloses);
			const low20 = Math.min(...lookbackCloses);
			const recentCloses = closes.slice(-ANTI_CHASE_LOOKBACK);

			// ── SHORT trigger: extreme positive funding, fade the longs ──
			if (
				stats.annualizedPct >= ANNUALIZED_TRIGGER_PCT &&
				avg24hAnnualized >= AVG24H_STABILITY_APR &&
				currentRsi < RSI_SHORT_MAX
			) {
				// Anti-chase: don't short into a fresh breakout.
				const chasing = recentCloses.some((c) => c > high20);
				if (chasing) return null;

				let confidence = BASE_CONFIDENCE;
				const crowdConfirmed = currentRsi > RSI_SHORT_CROWD_GREED_MIN;
				if (crowdConfirmed) confidence += CROWD_CONFIRM_BONUS;
				confidence = Math.min(confidence, MAX_CONFIDENCE);

				const stopLoss = price + currentAtr * 2.5;
				const riskDistance = stopLoss - price;
				const rawTakeProfit = price - riskDistance * 1.5;
				const { takeProfit } = applyTpCap(price, stopLoss, rawTakeProfit, {
					maxRiskRewardRatio: 3.0,
					maxTpPercent: 4.0,
					context: `funding-squeeze-fade short ${lastCandle.symbol}`,
				});

				const reason =
					`Funding squeeze SHORT: APR ${stats.annualizedPct.toFixed(1)}% ` +
					`(24h avg APR ${avg24hAnnualized.toFixed(1)}%), ` +
					`RSI ${currentRsi.toFixed(1)}` +
					`${crowdConfirmed ? " [crowd-greed confirmed]" : ""}. ` +
					`Fading crowded longs paying carry. ` +
					`Note: signal engine applies 0.8× single-source penalty downstream.`;

				return {
					symbol: lastCandle.symbol,
					direction: "short",
					confidence,
					reason,
					entryPrice: price,
					stopLoss,
					takeProfit,
					trailingStopPct: 2.0,
					timestamp: lastCandle.openTime,
				};
			}

			// ── LONG trigger: extreme negative funding, fade the shorts ──
			if (
				stats.annualizedPct <= -ANNUALIZED_TRIGGER_PCT &&
				avg24hAnnualized <= -AVG24H_STABILITY_APR &&
				currentRsi > RSI_LONG_MIN
			) {
				// Anti-chase: don't long into a fresh breakdown.
				const chasing = recentCloses.some((c) => c < low20);
				if (chasing) return null;

				let confidence = BASE_CONFIDENCE;
				const crowdConfirmed = currentRsi < RSI_LONG_CROWD_FEAR_MAX;
				if (crowdConfirmed) confidence += CROWD_CONFIRM_BONUS;
				confidence = Math.min(confidence, MAX_CONFIDENCE);

				const stopLoss = price - currentAtr * 2.5;
				const riskDistance = price - stopLoss;
				const rawTakeProfit = price + riskDistance * 1.5;
				const { takeProfit } = applyTpCap(price, stopLoss, rawTakeProfit, {
					maxRiskRewardRatio: 3.0,
					maxTpPercent: 4.0,
					context: `funding-squeeze-fade long ${lastCandle.symbol}`,
				});

				const reason =
					`Funding squeeze LONG: APR ${stats.annualizedPct.toFixed(1)}% ` +
					`(24h avg APR ${avg24hAnnualized.toFixed(1)}%), ` +
					`RSI ${currentRsi.toFixed(1)}` +
					`${crowdConfirmed ? " [crowd-fear confirmed]" : ""}. ` +
					`Fading crowded shorts paying carry. ` +
					`Note: signal engine applies 0.8× single-source penalty downstream.`;

				return {
					symbol: lastCandle.symbol,
					direction: "long",
					confidence,
					reason,
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
}
