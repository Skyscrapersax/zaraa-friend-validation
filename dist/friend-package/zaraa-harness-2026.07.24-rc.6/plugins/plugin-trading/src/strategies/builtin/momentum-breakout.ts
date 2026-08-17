import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";

const RESISTANCE_LOOKBACK = 20;
const VOLUME_MULTIPLIER = 1.5;
const EXHAUSTION_LOOKBACK = 5;

/**
 * Momentum Breakout Strategy
 *
 * Logic: Enter when price closes above the highest high (or below the lowest low)
 * of the previous N candles, with volume expanding ≥1.5× average.
 * ATR-based stop below the broken level; trailing stop locks in gains.
 * RSI divergence exhaustion filter prevents chasing climactic moves.
 *
 * Best in: Trending markets transitioning out of consolidation.
 * Weak in: Choppy range-bound markets (produces false breakouts).
 * Complements: mean-reversion (which fades the same moves).
 */
export const momentumBreakoutStrategy: Strategy = {
	name: "momentum-breakout",
	description:
		"N-candle price-level breakout with volume confirmation and ATR trailing stop. RSI divergence filter prevents chasing exhausted moves.",
	timeframe: "1h",
	minCandles: 60,
	riskParams: {
		stopLossAtrMultiplier: 2.0,
		takeProfitRatio: 3.0,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, highs, lows, volumes, rsi, atr, ema, macd } = indicators;

		if (
			highs.length < RESISTANCE_LOOKBACK + 2 ||
			atr.length === 0 ||
			rsi.length < EXHAUSTION_LOOKBACK + 2 ||
			volumes.length < 20
		) return null;

		const lastCandle = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const prevPrice = closes[closes.length - 2];
		const currentAtr = atr[atr.length - 1];
		const currentRsi = rsi[rsi.length - 1];
		const prevRsi = rsi[rsi.length - 2];

		// Resistance = highest HIGH of the previous RESISTANCE_LOOKBACK candles (excludes current)
		// Support = lowest LOW of the previous RESISTANCE_LOOKBACK candles (excludes current)
		const lookbackHighs = highs.slice(-(RESISTANCE_LOOKBACK + 1), -1);
		const lookbackLows = lows.slice(-(RESISTANCE_LOOKBACK + 1), -1);
		const resistance = Math.max(...lookbackHighs);
		const support = Math.min(...lookbackLows);

		// Volume gate — require expansion relative to 20-bar average
		const recentVols = volumes.slice(-20);
		const avgVolume = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
		const currentVolume = volumes[volumes.length - 1];
		if (currentVolume < avgVolume * VOLUME_MULTIPLIER) return null;

		// RSI divergence exhaustion — prevent entries into climactic exhausted moves
		const { bearishExhaustion, bullishExhaustion } = detectRsiExhaustion(closes, rsi, EXHAUSTION_LOOKBACK);

		// EMA trend alignment (null = unknown/insufficient history — treated as permissive)
		const ema20 = ema[20];
		const ema50 = ema[50];
		const trendUp =
			ema20 && ema50 && ema20.length > 0 && ema50.length > 0
				? ema20[ema20.length - 1] > ema50[ema50.length - 1]
				: null;

		// MACD histogram confirmation
		const hist = macd.histogram;
		const macdUp = hist.length >= 2 && hist[hist.length - 1] > 0 && hist[hist.length - 1] > hist[hist.length - 2];
		const macdDown = hist.length >= 2 && hist[hist.length - 1] < 0 && hist[hist.length - 1] < hist[hist.length - 2];

		// ── Long: close crosses above resistance ─────────────────────────
		const brokeAbove = prevPrice <= resistance && price > resistance;
		const rsiLongOk = currentRsi > 50 && currentRsi > prevRsi;

		if (brokeAbove && rsiLongOk && !bearishExhaustion && trendUp !== false) {
			const stopLoss = resistance - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDist = price - stopLoss;
			const takeProfit = price + riskDist * this.riskParams.takeProfitRatio;
			const conf = buildConfidence(currentRsi, currentVolume, avgVolume, macdUp, "long");
			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence: conf,
				reason: `Momentum breakout above ${RESISTANCE_LOOKBACK}-bar resistance $${resistance.toFixed(2)}. Vol ${((currentVolume / avgVolume) * 100).toFixed(0)}% avg, RSI ${currentRsi.toFixed(1)}${macdUp ? " + MACD rising" : ""}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 2.5,
				timestamp: lastCandle.openTime,
			};
		}

		// ── Short: close crosses below support ───────────────────────────
		const brokeBelow = prevPrice >= support && price < support;
		const rsiShortOk = currentRsi < 50 && currentRsi < prevRsi;

		if (brokeBelow && rsiShortOk && !bullishExhaustion && trendUp !== true) {
			const stopLoss = support + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDist = stopLoss - price;
			const takeProfit = price - riskDist * this.riskParams.takeProfitRatio;
			const conf = buildConfidence(currentRsi, currentVolume, avgVolume, macdDown, "short");
			return {
				symbol: lastCandle.symbol,
				direction: "short",
				confidence: conf,
				reason: `Momentum breakdown below ${RESISTANCE_LOOKBACK}-bar support $${support.toFixed(2)}. Vol ${((currentVolume / avgVolume) * 100).toFixed(0)}% avg, RSI ${currentRsi.toFixed(1)}${macdDown ? " + MACD declining" : ""}`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 2.5,
				timestamp: lastCandle.openTime,
			};
		}

		return null;
	},
};

/**
 * Detects RSI divergence that signals momentum exhaustion.
 * bearishExhaustion: price at recent high but RSI declining from overbought — warns longs.
 * bullishExhaustion: price at recent low but RSI recovering from oversold — warns shorts.
 */
function detectRsiExhaustion(
	closes: number[],
	rsi: number[],
	lookback: number,
): { bearishExhaustion: boolean; bullishExhaustion: boolean } {
	if (closes.length < lookback + 2 || rsi.length < lookback + 2) {
		return { bearishExhaustion: false, bullishExhaustion: false };
	}

	const windowCloses = closes.slice(-(lookback + 1), -1);
	const windowRsi = rsi.slice(-(lookback + 1), -1);
	const currentClose = closes[closes.length - 1];
	const currentRsi = rsi[rsi.length - 1];

	let maxClose = -Infinity, maxCloseRsi = 50;
	let minClose = Infinity, minCloseRsi = 50;
	for (let i = 0; i < windowCloses.length; i++) {
		if (windowCloses[i] > maxClose) { maxClose = windowCloses[i]; maxCloseRsi = windowRsi[i]; }
		if (windowCloses[i] < minClose) { minClose = windowCloses[i]; minCloseRsi = windowRsi[i]; }
	}

	// Price matching recent peak while RSI has faded from overbought
	const bearishExhaustion = currentClose >= maxClose * 0.998 && currentRsi < maxCloseRsi - 5 && maxCloseRsi > 65;
	// Price matching recent trough while RSI has bounced from oversold
	const bullishExhaustion = currentClose <= minClose * 1.002 && currentRsi > minCloseRsi + 5 && minCloseRsi < 35;

	return { bearishExhaustion, bullishExhaustion };
}

function buildConfidence(
	rsi: number,
	volume: number,
	avgVolume: number,
	macdConfirmed: boolean,
	direction: "long" | "short",
): number {
	// RSI distance from midline (50) — further = stronger momentum
	const rsiStrength = direction === "long"
		? Math.min((rsi - 50) / 50, 0.15)
		: Math.min((50 - rsi) / 50, 0.15);
	// Volume expansion on a log scale: 1.5x≈0.05, 2x≈0.09, 3x≈0.14, 5x≈0.15
	const volumeStrength = Math.min((Math.log(volume / avgVolume) / Math.log(5)) * 0.15, 0.15);
	const macdBonus = macdConfirmed ? 0.05 : 0;
	return Math.min(0.5 + rsiStrength + volumeStrength + macdBonus, 0.92);
}
