import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues, MarketContext } from "../strategy.js";
import { applyTpCap } from "../tp-cap.js";
import { computeADX } from "../market-regime.js";
import {
	classifyAdxRegime,
	classifyPatternRegime,
	reconcileRegime,
} from "../regime-reconciler.js";

// ADX regime thresholds — match the audit's data-driven gate spec.
//   < ADX_RANGING_MAX     → ranging (mean-reversion thrives)
//   ≥ ADX_TRENDING_MIN    → trending (mean-reversion fights the trend)
//   between               → ambiguous (no adjustment)
export const ADX_RANGING_MAX = 20;
export const ADX_TRENDING_MIN = 25;
const ADX_RANGING_BOOST = 1.1;
const ADX_TRENDING_DAMPEN = 0.7;
const ADX_TRENDING_HARD_REJECT = 35;

/** Apply the ADX-based regime gate to a mean-reversion confidence. */
export function applyMeanReversionRegimeGate(
	confidence: number,
	adx: number | null,
): { confidence: number; reject: boolean } {
	if (adx == null || !Number.isFinite(adx)) return { confidence, reject: false };
	if (adx >= ADX_TRENDING_HARD_REJECT) return { confidence: 0, reject: true };
	if (adx >= ADX_TRENDING_MIN) {
		return { confidence: Math.min(confidence * ADX_TRENDING_DAMPEN, 0.95), reject: false };
	}
	if (adx < ADX_RANGING_MAX) {
		return { confidence: Math.min(confidence * ADX_RANGING_BOOST, 0.95), reject: false };
	}
	return { confidence, reject: false };
}

const REGIME_GATE_MIN_CONFIDENCE = 0.7;
const RANGING_CONFIDENCE_BOOST = 0.1;

/**
 * Mean Reversion Strategy
 *
 * Logic: Buy when price touches the lower Bollinger Band and RSI is in oversold zone (<40).
 * Sell/short when price touches the upper Bollinger Band and RSI is in overbought zone (>60).
 *
 * Best in: Ranging/sideways markets.
 * Weak in: Strong trending markets (will fight the trend).
 */
export const meanReversionStrategy: Strategy = {
	name: "mean-reversion",
	description:
		"Bollinger Band bounce with RSI confirmation. Buys oversold dips at lower band, sells overbought rallies at upper band.",
	timeframe: "1h",
	minCandles: 30,
	riskParams: {
		// 2.5× ATR (~1.25% on crypto) keeps the stop outside intraday noise.
		// Earlier 1.5× sat ~0.75% — well inside normal candle range, so virtually
		// every entry stopped out before mean reversion could play out.
		stopLossAtrMultiplier: 2.5,
		// 1.3× RR — mean reversion rarely covers 2× the SL distance before
		// reverting; tightening to 1.3 captures profits earlier.
		takeProfitRatio: 1.3,
		// 1.5× per-trade risk in Phase 2. Workstream-C audit showed MR was the
		// 30d earner (+$1.59 / +6.63 R / 46% wins) at 1.0%; scaling to 1.5%
		// stays inside the dynamic-sizer's hard 5%-of-equity cap and the 7%
		// drawdown circuit breaker. Worst-case 5-stop day = 7.5% of equity,
		// which trips the CB by design.
		riskPerTradePct: 1.5,
		maxRiskRewardRatio: 3.0,
		maxTpPercent: 4.0,
	},

	evaluate(
		candles: Candle[],
		indicators: IndicatorValues,
		context?: MarketContext | null,
	): Signal | null {
		const { closes, volumes, highs, lows, bollingerBands: bb, rsi, atr, sma, ema } = indicators;
		if (rsi.length < 2 || bb.middle.length === 0 || atr.length === 0 || closes.length < 3) return null;

		// ── Data-driven regime gate (from MarketLearner patterns) ────────
		// Mean reversion fights the trend, so we skip entries when the
		// learned-pattern regime says we'd be entering against a strong
		// trend at this hour. The static SMA50 trend filter below still
		// runs as a fallback when context is absent.
		const regimeSkipsLong = context
			&& context.regime === "trending_down"
			&& context.regimeConfidence > REGIME_GATE_MIN_CONFIDENCE;
		const regimeSkipsShort = context
			&& context.regime === "trending_up"
			&& context.regimeConfidence > REGIME_GATE_MIN_CONFIDENCE;
		const regimeBoosts = !!context
			&& context.regime === "ranging"
			&& context.regimeConfidence > REGIME_GATE_MIN_CONFIDENCE;

		const price = closes[closes.length - 1];
		const prevPrice = closes[closes.length - 2];
		const currentRsi = rsi[rsi.length - 1];
		const prevRsi = rsi[rsi.length - 2];
		const lowerBand = bb.lower[bb.lower.length - 1];
		const upperBand = bb.upper[bb.upper.length - 1];
		const middleBand = bb.middle[bb.middle.length - 1];
		const currentAtr = atr[atr.length - 1];
		const lastCandle = candles[candles.length - 1];

		// ADX regime gate — see applyMeanReversionRegimeGate above.
		// Computed once and reused for both long and short branches.
		const adxSeries = computeADX(highs, lows, closes, 14);
		const currentAdx = adxSeries.length > 0 ? adxSeries[adxSeries.length - 1] : null;

		// ── Regime reconciliation ────────────────────────────────────────
		// ADX (mathematical, per-bar) and the learner's pattern regime
		// (hour-bucketed) can disagree. When they do we apply a confidence
		// discount — a conflicted regime is a thinner edge than aligned
		// signals, regardless of which one we trust.
		const reconciled = reconcileRegime(
			classifyAdxRegime(currentAdx),
			classifyPatternRegime(context, REGIME_GATE_MIN_CONFIDENCE),
		);
		const reconciliationDiscount = reconciled.confidenceMultiplier;

		// ── Trend filter: reject signals against a strong trend ──────────
		// Mean reversion only works in ranging/sideways markets.
		// Threshold raised from 1% to 1.5% for downtrends — the original -0.01
		// rejected valid MR setups during normal BTC/ETH pullbacks, resulting in
		// zero MR executions across multiple sessions.
		// Override: deeply oversold (RSI < 30) + below-average volume bypasses
		// the filter, as these conditions strongly favor mean reversion.
		const sma50 = sma[50];
		if (sma50 && sma50.length >= 10) {
			const recentSlope = (sma50[sma50.length - 1] - sma50[sma50.length - 10]) / sma50[sma50.length - 10];
			// Strong uptrend: don't short into it
			if (recentSlope > 0.01 && price >= upperBand) return null;
			// Strong downtrend: don't buy into it — unless deeply oversold with low volume
			if (recentSlope < -0.015 && price <= lowerBand) {
				const isOversoldOverride = currentRsi < 30 && volumes.length >= 20 &&
					volumes[volumes.length - 1] < (volumes.slice(-20).reduce((a, b) => a + b, 0) / 20);
				if (!isOversoldOverride) return null;
			}
		}

		// Volume filter: reject entries on extreme volume (suggests breakout, not reversion)
		let volumeOk = true;
		if (volumes.length >= 20) {
			const recentVols = volumes.slice(-20);
			const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
			const currentVol = volumes[volumes.length - 1];
			if (currentVol > avgVol * 2.0) {
				volumeOk = false;
			}
		}

		if (!volumeOk) return null;

		// ── Long signal ──────────────────────────────────────────────────
		// Two tiers:
		//   1. Band touch (price at/below lower BB) + RSI < 40 → full confidence
		//   2. Band proximity (within 1.0 ATR of lower BB) + RSI < 40 → discounted confidence
		// Restored from 45 → 40: the looser 45 threshold contributed to the 97-position
		// pile-up in the shadow soak by firing on weak setups. Tightening back to 40
		// trades fewer entries for higher quality (true oversold).
		const distToLower = price - lowerBand;
		const nearLowerBand = distToLower >= 0 && distToLower <= currentAtr * 1.0;
		const touchedLowerBand = prevPrice <= lowerBand || price <= lowerBand;
		const longRsiOk = touchedLowerBand ? currentRsi < 40 : (nearLowerBand && currentRsi < 40);
		const bouncing = price > prevPrice;

		if ((touchedLowerBand || nearLowerBand) && longRsiOk && bouncing) {
			if (regimeSkipsLong) return null;
			const hasDivergence = closes.length >= 3
				&& prevPrice < closes[closes.length - 3]
				&& prevRsi > (rsi.length >= 3 ? rsi[rsi.length - 3] : prevRsi);

			const refPrice = touchedLowerBand ? (prevPrice <= lowerBand ? prevPrice : price) : price;
			const stopLoss = refPrice - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			const atrTP = price + riskDistance * this.riskParams.takeProfitRatio;
			const rawTakeProfit = Math.max(middleBand, atrTP);
			const takeProfit = applyTpCap(price, stopLoss, rawTakeProfit, {
				maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
				maxTpPercent: this.riskParams.maxTpPercent,
				context: `mean-reversion long ${lastCandle.symbol}`,
			}).takeProfit;

			// Proximity signals get a confidence discount — they're weaker setups
			const proximityDiscount = touchedLowerBand ? 0 : -0.08;
			const baseConf = calculateConfidence(currentRsi, 40, refPrice, lowerBand, "long");
			const rawConf = Math.min(baseConf + (hasDivergence ? 0.1 : 0) + proximityDiscount, 0.95);
			const regimeGate = applyMeanReversionRegimeGate(rawConf, currentAdx);
			if (regimeGate.reject) return null;
			const rangingBoost = regimeBoosts ? RANGING_CONFIDENCE_BOOST : 0;
			const gatedConf = Math.min(regimeGate.confidence + rangingBoost, 0.95);
			const conf = Math.min(gatedConf * reconciliationDiscount, 0.95);
			const adxTag = currentAdx != null ? ` [ADX ${currentAdx.toFixed(1)}]` : "";
			const reconcileTag = reconciled.agreed ? "" : ` [regime disagree → ${reconciled.regime}]`;

			const label = touchedLowerBand ? "Bounce off" : "Approaching";
			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence: conf,
				reason: `${label} lower Bollinger Band ($${lowerBand.toFixed(2)}), RSI ${currentRsi.toFixed(1)}${hasDivergence ? " + bullish divergence" : ""}${nearLowerBand && !touchedLowerBand ? " [proximity]" : ""}${rangingBoost ? " [ranging regime +10% conf]" : ""}${adxTag}${reconcileTag}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				// Audit (May 2026): only 8% of MR trades reached the static TP;
				// 67% expired on time inside the 0–0.5R bucket with unrealized gains.
				// Re-tune (May 30): 1.5% was pre-empting the ~2.5×ATR stop, force-
				// closing MR positions before mean-reversion played out (only ~12 TP
				// hits system-wide vs 113 stops). Widen to 2.5% so the trail sits at/
				// outside the ATR stop and lets winners reach the mid-band TP. Wider
				// trail is the SAFE direction — it can never bind a loser tighter.
				trailingStopPct: 2.5,
				timestamp: lastCandle.openTime,
			};
		}

		// ── Short signal ─────────────────────────────────────────────────
		// Mirror: band touch RSI > 60, proximity (within 1.0 ATR) RSI > 60
		// Restored from 55 → 60: see long-side note above. Higher RSI ceiling means
		// fewer but higher-quality (truly overbought) short setups.
		const distToUpper = upperBand - price;
		const nearUpperBand = distToUpper >= 0 && distToUpper <= currentAtr * 1.0;
		const touchedUpperBand = prevPrice >= upperBand || price >= upperBand;
		const shortRsiOk = touchedUpperBand ? currentRsi > 60 : (nearUpperBand && currentRsi > 60);
		const dropping = price < prevPrice;

		if ((touchedUpperBand || nearUpperBand) && shortRsiOk && dropping) {
			if (regimeSkipsShort) return null;
			const hasDivergence = closes.length >= 3
				&& prevPrice > closes[closes.length - 3]
				&& prevRsi < (rsi.length >= 3 ? rsi[rsi.length - 3] : prevRsi);

			const refPriceShort = touchedUpperBand ? (prevPrice >= upperBand ? prevPrice : price) : price;
			const stopLoss = refPriceShort + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistanceShort = stopLoss - price;
			const atrTPShort = price - riskDistanceShort * this.riskParams.takeProfitRatio;
			const rawTakeProfitShort = Math.min(middleBand, atrTPShort);
			const takeProfitShort = applyTpCap(price, stopLoss, rawTakeProfitShort, {
				maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
				maxTpPercent: this.riskParams.maxTpPercent,
				context: `mean-reversion short ${lastCandle.symbol}`,
			}).takeProfit;

			const proximityDiscount = touchedUpperBand ? 0 : -0.08;
			const baseConf = calculateConfidence(currentRsi, 60, refPriceShort, upperBand, "short");
			const rawConfShort = Math.min(baseConf + (hasDivergence ? 0.1 : 0) + proximityDiscount, 0.95);
			const regimeGateShort = applyMeanReversionRegimeGate(rawConfShort, currentAdx);
			if (regimeGateShort.reject) return null;
			const rangingBoost = regimeBoosts ? RANGING_CONFIDENCE_BOOST : 0;
			const gatedConf = Math.min(regimeGateShort.confidence + rangingBoost, 0.95);
			const conf = Math.min(gatedConf * reconciliationDiscount, 0.95);
			const adxTagShort = currentAdx != null ? ` [ADX ${currentAdx.toFixed(1)}]` : "";
			const reconcileTag = reconciled.agreed ? "" : ` [regime disagree → ${reconciled.regime}]`;

			const label = touchedUpperBand ? "Rejection from" : "Approaching";
			return {
				symbol: lastCandle.symbol,
				direction: "short",
				confidence: conf,
				reason: `${label} upper Bollinger Band ($${upperBand.toFixed(2)}), RSI ${currentRsi.toFixed(1)}${hasDivergence ? " + bearish divergence" : ""}${nearUpperBand && !touchedUpperBand ? " [proximity]" : ""}${rangingBoost ? " [ranging regime +10% conf]" : ""}${adxTagShort}${reconcileTag}`,
				entryPrice: price,
				stopLoss,
				takeProfit: takeProfitShort,
				// Mirror of long side — see audit note on trailing stop above (2.5%).
				trailingStopPct: 2.5,
				timestamp: lastCandle.openTime,
			};
		}

		return null;
	},
};

function calculateConfidence(
	rsi: number,
	threshold: number,
	price: number,
	band: number,
	direction: "long" | "short",
): number {
	// RSI distance from threshold (further = stronger signal)
	const rsiStrength = direction === "long"
		? Math.min((threshold - rsi) / threshold, 1)
		: Math.min((rsi - threshold) / (100 - threshold), 1);

	// Price penetration past band (further = stronger signal)
	const penetration = direction === "long"
		? Math.min(Math.abs(band - price) / band, 0.05) / 0.05
		: Math.min(Math.abs(price - band) / band, 0.05) / 0.05;

	return Math.min(0.5 + rsiStrength * 0.3 + penetration * 0.2, 1);
}
