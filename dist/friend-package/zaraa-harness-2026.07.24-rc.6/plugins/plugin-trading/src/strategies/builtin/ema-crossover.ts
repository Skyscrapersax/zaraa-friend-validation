import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";

/**
 * EMA Crossover (9/21) Trend-Following Strategy
 *
 * Logic:
 *   - BUY when fast EMA (9) crosses above slow EMA (21) — bullish crossover.
 *   - SELL when fast EMA (9) crosses below slow EMA (21) — bearish crossover.
 *   - Confirms with a trend-strength gate: |EMA9 - EMA21| / price must exceed
 *     0.1% to filter cross-noise during chop.
 *   - ATR stops: SL at 1.5× ATR, TP at 3× ATR (1:2 risk-reward).
 *
 * Complements the existing 4h trend-following (EMA 20/50) by reacting on a
 * faster cadence (1h, 9/21) — better suited for catching shorter trending
 * legs that the slower trend-following strategy misses while the
 * mean-reversion strategy fights them.
 *
 * Best in: Trending markets (catches direction switches early).
 * Weak in: Chop / sideways tape (the spread filter mitigates but doesn't
 *           eliminate whipsaws).
 */
export const emaCrossoverStrategy: Strategy = {
	name: "ema-crossover",
	description:
		"EMA 9/21 crossover with trend-strength filter and ATR-based stops. Faster trend signal that complements EMA 20/50 trend-following.",
	timeframe: "1h",
	minCandles: 30,
	riskParams: {
		stopLossAtrMultiplier: 1.5,
		takeProfitRatio: 2.0, // SL 1.5×ATR, TP 3×ATR → 1:2 R:R
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, volumes, ema, atr, sma } = indicators;
		const ema9 = ema[9];
		const ema21 = ema[21];

		if (!ema9 || !ema21 || ema9.length < 2 || ema21.length < 2) return null;
		if (atr.length === 0 || closes.length < 3) return null;

		const price = closes[closes.length - 1];
		const currentAtr = atr[atr.length - 1];
		const lastCandle = candles[candles.length - 1];

		const fast = ema9[ema9.length - 1];
		const fastPrev = ema9[ema9.length - 2];
		const slow = ema21[ema21.length - 1];
		const slowPrev = ema21[ema21.length - 2];

		// ── Trend-strength filter ────────────────────────────────────────
		// Spread between EMAs as a fraction of price. Below 0.1% the cross is
		// noise; above it we have meaningful separation.
		const spreadPct = Math.abs(fast - slow) / price;
		if (spreadPct < 0.001) return null;

		// ── Crossover detection ──────────────────────────────────────────
		const bullishCross = fastPrev <= slowPrev && fast > slow;
		const bearishCross = fastPrev >= slowPrev && fast < slow;

		if (!bullishCross && !bearishCross) return null;

		// ── Long signal ──────────────────────────────────────────────────
		if (bullishCross) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			const takeProfit = price + riskDistance * this.riskParams.takeProfitRatio;

			const confidence = calculateConfidence({
				fast,
				fastPrev,
				slow,
				slowPrev,
				price,
				volumes,
				higherTf: sma[50],
				direction: "long",
			});

			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence,
				reason: `EMA 9/21 bullish crossover (spread ${(spreadPct * 100).toFixed(2)}%), fast ${fast.toFixed(2)} > slow ${slow.toFixed(2)}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				timestamp: lastCandle.openTime,
			};
		}

		// ── Short signal ─────────────────────────────────────────────────
		const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
		const riskDistance = stopLoss - price;
		const takeProfit = price - riskDistance * this.riskParams.takeProfitRatio;

		const confidence = calculateConfidence({
			fast,
			fastPrev,
			slow,
			slowPrev,
			price,
			volumes,
			higherTf: sma[50],
			direction: "short",
		});

		return {
			symbol: lastCandle.symbol,
			direction: "short",
			confidence,
			reason: `EMA 9/21 bearish crossover (spread ${(spreadPct * 100).toFixed(2)}%), fast ${fast.toFixed(2)} < slow ${slow.toFixed(2)}`,
			entryPrice: price,
			stopLoss,
			takeProfit,
			timestamp: lastCandle.openTime,
		};
	},
};

interface ConfidenceInputs {
	fast: number;
	fastPrev: number;
	slow: number;
	slowPrev: number;
	price: number;
	volumes: number[];
	higherTf: number[] | undefined;
	direction: "long" | "short";
}

function calculateConfidence(inputs: ConfidenceInputs): number {
	const { fast, fastPrev, slow, slowPrev, price, volumes, higherTf, direction } = inputs;

	// 1. Crossover freshness: how decisive is the cross?
	// Bigger gap between (fast - slow) now vs. (fastPrev - slowPrev) = stronger cross.
	const nowGap = fast - slow;
	const prevGap = fastPrev - slowPrev;
	const crossMagnitude = Math.abs(nowGap - prevGap) / price;
	// Saturate at 0.5% gap-change → full freshness score.
	const freshness = Math.min(crossMagnitude / 0.005, 1);

	// 2. Volume confirmation: current vol vs. 20-bar average.
	let volumeScore = 0.5;
	if (volumes.length >= 20) {
		const recent = volumes.slice(-20);
		const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
		const currentVol = volumes[volumes.length - 1];
		if (avg > 0) {
			// 1.0× avg → 0.5; 2.0× avg → 1.0; below avg → <0.5.
			volumeScore = Math.min(currentVol / avg / 2, 1);
		}
	}

	// 3. Higher-timeframe alignment: SMA50 slope agrees with cross direction?
	let alignmentScore = 0.5;
	if (higherTf && higherTf.length >= 10) {
		const recentSlope =
			(higherTf[higherTf.length - 1] - higherTf[higherTf.length - 10]) /
			higherTf[higherTf.length - 10];
		if (direction === "long") {
			// Long aligned with up-slope (positive). Saturate at +1% over 10 bars.
			alignmentScore = recentSlope >= 0 ? Math.min(recentSlope / 0.01, 1) : 0.2;
		} else {
			alignmentScore = recentSlope <= 0 ? Math.min(-recentSlope / 0.01, 1) : 0.2;
		}
	}

	// Weights: freshness 40%, volume 30%, HTF alignment 30%; floor at 0.4.
	const raw = 0.4 + freshness * 0.3 + volumeScore * 0.15 + alignmentScore * 0.15;
	return Math.min(Math.max(raw, 0.4), 0.95);
}
