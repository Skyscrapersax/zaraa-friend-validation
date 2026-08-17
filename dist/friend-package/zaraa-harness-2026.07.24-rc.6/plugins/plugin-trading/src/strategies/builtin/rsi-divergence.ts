import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";

/**
 * RSI Divergence Strategy
 *
 * Detects classic bullish and bearish divergences between price and RSI,
 * confirmed by MACD histogram alignment and volume patterns.
 *
 * Bullish divergence: Price makes a lower low, but RSI makes a higher low.
 *   This signals exhaustion of selling pressure — sellers are losing conviction
 *   even as price continues to drop. Enter long on confirmation.
 *
 * Bearish divergence: Price makes a higher high, but RSI makes a lower high.
 *   Buyers are losing steam even as price pushes up. Enter short on confirmation.
 *
 * The strategy uses a swing detection algorithm to find pivots rather than
 * comparing adjacent bars, which produces much cleaner divergence signals.
 *
 * Best in: Pullbacks within trends, corrections, exhaustion moves.
 * Weak in: Strong linear trends with no retracements.
 *
 * Timeframe: 15m — fast enough to catch intraday reversals,
 * slow enough to filter noise.
 */

/** Minimum bars between pivots to consider them a valid divergence pair */
const MIN_PIVOT_DISTANCE = 5;
/** Maximum bars between pivots (too far apart = stale signal) */
const MAX_PIVOT_DISTANCE = 60;
/** Number of bars on each side to confirm a swing high/low */
const SWING_LOOKBACK = 3;

interface SwingPoint {
	index: number;
	price: number;
	rsi: number;
}

// ── Per-conjunct gate-failure counters ────────────────────────────────
// Phase 2 instrumentation. Workstream-C audit found ~9 ensemble(rsi-divergence)
// signals/30d but only 1–2 closed strategy_trades — the strategy is firing
// rarely enough that we don't know which conjunct is the real bottleneck.
// These counters tally which gate stopped the candle on each evaluate(),
// per branch, so an external sampler (or the operator over a 24h soak) can
// see the actual failure distribution before widening any thresholds.
//
// Counters are per-process — a separate snapshot lives in each daemon (live +
// validation/mirror). Behavior is unchanged: incrementing a counter never
// alters whether a signal is emitted.

export interface RsiDivergenceBranchCounters {
	noPivots: number;
	distanceOutOfRange: number;
	noDivergence: number;
	rsiOutOfBand: number;
	priceNotConfirming: number;
	macdNotTurning: number;
}

export interface RsiDivergenceCounters {
	evaluations: number;
	preconditionFailed: number;
	signals: { long: number; short: number };
	bullish: RsiDivergenceBranchCounters;
	bearish: RsiDivergenceBranchCounters;
}

function emptyBranchCounters(): RsiDivergenceBranchCounters {
	return {
		noPivots: 0,
		distanceOutOfRange: 0,
		noDivergence: 0,
		rsiOutOfBand: 0,
		priceNotConfirming: 0,
		macdNotTurning: 0,
	};
}

function emptyCounters(): RsiDivergenceCounters {
	return {
		evaluations: 0,
		preconditionFailed: 0,
		signals: { long: 0, short: 0 },
		bullish: emptyBranchCounters(),
		bearish: emptyBranchCounters(),
	};
}

const counters: RsiDivergenceCounters = emptyCounters();

/** Snapshot of the per-conjunct counters since the last reset. */
export function getRsiDivergenceCounters(): RsiDivergenceCounters {
	return {
		evaluations: counters.evaluations,
		preconditionFailed: counters.preconditionFailed,
		signals: { ...counters.signals },
		bullish: { ...counters.bullish },
		bearish: { ...counters.bearish },
	};
}

/** Zero out the counters. Useful at the start of a 24h soak window. */
export function resetRsiDivergenceCounters(): void {
	counters.evaluations = 0;
	counters.preconditionFailed = 0;
	counters.signals.long = 0;
	counters.signals.short = 0;
	counters.bullish = emptyBranchCounters();
	counters.bearish = emptyBranchCounters();
}

export const rsiDivergenceStrategy: Strategy = {
	name: "rsi-divergence",
	description:
		"Detects RSI divergence (price vs momentum disagreement) at swing points. " +
		"Enters on bullish divergence (oversold bounce) or bearish divergence (overbought fade) " +
		"with MACD and volume confirmation.",
	timeframe: "15m",
	minCandles: 40,
	riskParams: {
		stopLossAtrMultiplier: 1.5, // Tight stop — divergences resolve quickly
		takeProfitRatio: 2.0,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, highs, lows, volumes, rsi, macd, atr, obv } = indicators;

		counters.evaluations++;

		if (rsi.length < 20 || atr.length === 0 || closes.length < 40) {
			counters.preconditionFailed++;
			return null;
		}

		const price = closes[closes.length - 1];
		const currentRsi = rsi[rsi.length - 1];
		const currentAtr = atr[atr.length - 1];
		const lastCandle = candles[candles.length - 1];

		// We need the RSI array aligned with the closes array.
		// RSI(14) produces N - 14 values for N closes.
		// So rsi[i] corresponds to closes[i + rsiOffset] where rsiOffset = closes.length - rsi.length.
		const rsiOffset = closes.length - rsi.length;

		// ── Find swing lows (for bullish divergence) ──
		// Use lows[] instead of closes[] — wicks represent actual price extremes
		// and produce more accurate pivot detection than close prices alone.
		// A candle can close higher than its low but still represent genuine
		// selling exhaustion at the wick level.
		const swingLows = findSwingLows(lows, rsi, rsiOffset, SWING_LOOKBACK);
		// ── Find swing highs (for bearish divergence) ──
		// Similarly, use highs[] — a candle's high captures buying exhaustion
		// even if the close is lower (rejection wick).
		const swingHighs = findSwingHighs(highs, rsi, rsiOffset, SWING_LOOKBACK);

		// MACD histogram for confirmation
		const macdHist = macd.histogram;
		const currentMacdHist = macdHist.length > 0 ? macdHist[macdHist.length - 1] : 0;
		const prevMacdHist = macdHist.length > 1 ? macdHist[macdHist.length - 2] : 0;

		// Volume trend (is volume declining on the move? confirms exhaustion)
		const recentVolumes = volumes.slice(-10);
		const olderVolumes = volumes.slice(-20, -10);
		const recentAvgVol = recentVolumes.length > 0
			? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
			: 0;
		const olderAvgVol = olderVolumes.length > 0
			? olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length
			: 1;
		const volumeDeclining = recentAvgVol < olderAvgVol * 0.9;

		// OBV confirmation: is money flow disagreeing with price?
		const obvTrend = obv.length >= 10
			? obv[obv.length - 1] - obv[obv.length - 10]
			: 0;

		// ── Check for bullish divergence ──
		// Most recent swing low vs the prior swing low
		if (swingLows.length < 2) {
			counters.bullish.noPivots++;
		} else {
			const current_sw = swingLows[swingLows.length - 1];
			const prior_sw = swingLows[swingLows.length - 2];

			const distance = current_sw.index - prior_sw.index;
			if (distance < MIN_PIVOT_DISTANCE || distance > MAX_PIVOT_DISTANCE) {
				counters.bullish.distanceOutOfRange++;
			} else {
				// Bullish divergence: price lower low, RSI higher low
				const priceLowerLow = current_sw.price < prior_sw.price;
				const rsiHigherLow = current_sw.rsi > prior_sw.rsi;

				if (!priceLowerLow || !rsiHigherLow) {
					counters.bullish.noDivergence++;
				} else if (currentRsi >= 40) {
					// Must be in oversold territory (RSI < 40) for the signal to matter
					counters.bullish.rsiOutOfBand++;
				} else {
					// Confirmation: price is now bouncing (current close above the swing low)
					const bouncing = price > current_sw.price;
					// MACD turning up (histogram getting less negative or turning positive)
					const macdTurning = currentMacdHist > prevMacdHist;

					if (!bouncing) {
						counters.bullish.priceNotConfirming++;
					} else if (!macdTurning) {
						counters.bullish.macdNotTurning++;
					} else {
						const stopLoss = current_sw.price - currentAtr * this.riskParams.stopLossAtrMultiplier;
						const riskDistance = price - stopLoss;
						const confidence = calculateDivergenceConfidence(
							currentRsi, prior_sw.rsi, current_sw.rsi,
							current_sw.price, prior_sw.price, price,
							volumeDeclining, obvTrend > 0, "bullish",
						);

						counters.signals.long++;
						return {
							symbol: lastCandle.symbol,
							direction: "long",
							confidence,
							reason: buildReason("Bullish", currentRsi, current_sw, prior_sw, volumeDeclining),
							entryPrice: price,
							stopLoss,
							takeProfit: price + riskDistance * this.riskParams.takeProfitRatio,
							trailingStopPct: 2, // Tight trailing for reversal trades
							timestamp: lastCandle.openTime,
						};
					}
				}
			}
		}

		// ── Check for bearish divergence ──
		if (swingHighs.length < 2) {
			counters.bearish.noPivots++;
		} else {
			const current_sw = swingHighs[swingHighs.length - 1];
			const prior_sw = swingHighs[swingHighs.length - 2];

			const distance = current_sw.index - prior_sw.index;
			if (distance < MIN_PIVOT_DISTANCE || distance > MAX_PIVOT_DISTANCE) {
				counters.bearish.distanceOutOfRange++;
			} else {
				// Bearish divergence: price higher high, RSI lower high
				const priceHigherHigh = current_sw.price > prior_sw.price;
				const rsiLowerHigh = current_sw.rsi < prior_sw.rsi;

				if (!priceHigherHigh || !rsiLowerHigh) {
					counters.bearish.noDivergence++;
				} else if (currentRsi <= 60) {
					// Must be in overbought territory (RSI > 60) for the signal to matter
					counters.bearish.rsiOutOfBand++;
				} else {
					// Confirmation: price is now dropping
					const dropping = price < current_sw.price;
					// MACD turning down (histogram getting less positive or turning negative)
					const macdTurning = currentMacdHist < prevMacdHist;

					if (!dropping) {
						counters.bearish.priceNotConfirming++;
					} else if (!macdTurning) {
						counters.bearish.macdNotTurning++;
					} else {
						const stopLoss = current_sw.price + currentAtr * this.riskParams.stopLossAtrMultiplier;
						const riskDistance = stopLoss - price;
						const confidence = calculateDivergenceConfidence(
							currentRsi, prior_sw.rsi, current_sw.rsi,
							current_sw.price, prior_sw.price, price,
							volumeDeclining, obvTrend < 0, "bearish",
						);

						counters.signals.short++;
						return {
							symbol: lastCandle.symbol,
							direction: "short",
							confidence,
							reason: buildReason("Bearish", currentRsi, current_sw, prior_sw, volumeDeclining),
							entryPrice: price,
							stopLoss,
							takeProfit: price - riskDistance * this.riskParams.takeProfitRatio,
							trailingStopPct: 2,
							timestamp: lastCandle.openTime,
						};
					}
				}
			}
		}

		return null;
	},
};

/**
 * Find swing lows in a price series (typically lows[], not closes[]).
 * A swing low is a point lower than the `lookback` bars on each side.
 * Using lows[] captures wick extremes that closes[] misses.
 */
function findSwingLows(
	prices: number[],
	rsi: number[],
	rsiOffset: number,
	lookback: number,
): SwingPoint[] {
	const swings: SwingPoint[] = [];

	// Don't check the very last `lookback` bars (need right-side confirmation)
	for (let i = lookback; i < prices.length - lookback; i++) {
		let isSwingLow = true;
		for (let j = 1; j <= lookback; j++) {
			if (prices[i] >= prices[i - j] || prices[i] >= prices[i + j]) {
				isSwingLow = false;
				break;
			}
		}
		if (isSwingLow) {
			const rsiIdx = i - rsiOffset;
			if (rsiIdx >= 0 && rsiIdx < rsi.length) {
				swings.push({ index: i, price: prices[i], rsi: rsi[rsiIdx] });
			}
		}
	}

	return swings;
}

/**
 * Find swing highs in a price series (typically highs[], not closes[]).
 * A swing high is a point higher than the `lookback` bars on each side.
 * Using highs[] captures wick extremes that closes[] misses.
 */
function findSwingHighs(
	prices: number[],
	rsi: number[],
	rsiOffset: number,
	lookback: number,
): SwingPoint[] {
	const swings: SwingPoint[] = [];

	for (let i = lookback; i < prices.length - lookback; i++) {
		let isSwingHigh = true;
		for (let j = 1; j <= lookback; j++) {
			if (prices[i] <= prices[i - j] || prices[i] <= prices[i + j]) {
				isSwingHigh = false;
				break;
			}
		}
		if (isSwingHigh) {
			const rsiIdx = i - rsiOffset;
			if (rsiIdx >= 0 && rsiIdx < rsi.length) {
				swings.push({ index: i, price: prices[i], rsi: rsi[rsiIdx] });
			}
		}
	}

	return swings;
}

/**
 * Calculate confidence for a divergence signal.
 * Factors: RSI divergence magnitude, price divergence magnitude,
 * volume confirmation, OBV confirmation.
 */
function calculateDivergenceConfidence(
	currentRsi: number,
	priorSwingRsi: number,
	currentSwingRsi: number,
	currentSwingPrice: number,
	priorSwingPrice: number,
	currentPrice: number,
	volumeDeclining: boolean,
	obvConfirms: boolean,
	type: "bullish" | "bearish",
): number {
	// RSI divergence strength: how much did RSI disagree with price?
	const rsiDivergence = Math.abs(currentSwingRsi - priorSwingRsi);
	const rsiStrength = Math.min(rsiDivergence / 15, 1); // 15 RSI points = max strength

	// Price divergence strength: how significant was the price move?
	const priceDivergence = Math.abs(
		(currentSwingPrice - priorSwingPrice) / priorSwingPrice,
	);
	const priceStrength = Math.min(priceDivergence / 0.03, 1); // 3% = max strength

	// RSI extremity bonus: deeper into oversold/overbought = stronger signal
	const extremity = type === "bullish"
		? Math.min(Math.max(40 - currentRsi, 0) / 20, 1) // RSI 20 = max bonus
		: Math.min(Math.max(currentRsi - 60, 0) / 20, 1); // RSI 80 = max bonus

	// Confirmation bonuses
	const volumeBonus = volumeDeclining ? 0.08 : 0;
	const obvBonus = obvConfirms ? 0.07 : 0;

	return Math.min(
		0.45 + rsiStrength * 0.2 + priceStrength * 0.1 + extremity * 0.1 + volumeBonus + obvBonus,
		0.95,
	);
}

function buildReason(
	type: string,
	currentRsi: number,
	currentSw: SwingPoint,
	priorSw: SwingPoint,
	volumeDeclining: boolean,
): string {
	const parts = [
		`${type} RSI divergence:`,
		`price ${type === "Bullish" ? "lower low" : "higher high"}`,
		`($${priorSw.price.toFixed(2)} -> $${currentSw.price.toFixed(2)})`,
		`but RSI ${type === "Bullish" ? "higher low" : "lower high"}`,
		`(${priorSw.rsi.toFixed(1)} -> ${currentSw.rsi.toFixed(1)}).`,
		`Current RSI ${currentRsi.toFixed(1)}.`,
	];
	if (volumeDeclining) parts.push("Volume declining (exhaustion).");
	return parts.join(" ");
}
