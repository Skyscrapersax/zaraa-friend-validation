import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues } from "../strategy.js";
import { getCurrentSession } from "../session-filter.js";

/**
 * EDGE-EXPERIMENT STRATEGIES
 * ==========================
 * Four GENUINELY-NEW strategy mechanisms implemented for the honest edge search
 * (scripts/edge-search.mjs). These are NOT registered in StrategyRegistry and
 * are NEVER activated in the live/paper trading engine — they exist only so the
 * search harness can test whether any new mechanism has a real, OOS-significant,
 * post-cost edge.
 *
 * Each is a real, self-contained Strategy: it emits buy/sell signals with stops
 * and take-profits on the correct side of entry, reads precomputed indicators,
 * and exposes sensible default riskParams.
 *
 * Mechanisms (each distinct from the 7 existing built-ins):
 *   1. donchian-trend    — Donchian channel breakout (highest-high / lowest-low),
 *                          ATR trailing stop. Trend persistence.
 *   2. squeeze-breakout  — Bollinger bandwidth low-percentile squeeze, then enter
 *                          on band exit as width expands. Volatility regime change.
 *   3. session-orb       — Opening-range breakout: high/low of first K bars of a
 *                          session, enter on range break during session.
 *   4. connors-rsi2      — RSI(2)<5 & close>SMA200 long (exit close>SMA5); symmetric
 *                          short. Documented short-term mean-reversion.
 */

// ── 1. Donchian Channel Trend ─────────────────────────────────────────────────

const DONCHIAN_LOOKBACK = 20;

/**
 * Long when close breaks ABOVE the highest high of the prior N bars; short when it
 * breaks BELOW the lowest low of the prior N bars. Stop is an ATR-distance trailing
 * stop (trailingStopPct derived from ATR/price); take-profit set by takeProfitRatio.
 *
 * Distinct from the existing "trend-following" (which gates on MA stacks + ADX and
 * produces ~0 trades): a clean channel-breakout that fires whenever price makes a
 * new N-bar extreme, so it actually generates signals on real data.
 */
export const donchianTrendStrategy: Strategy = {
	name: "donchian-trend",
	description:
		"Donchian channel breakout: long on a new N-bar high, short on a new N-bar low, with an ATR trailing stop. Captures trend persistence.",
	timeframe: "1h",
	minCandles: DONCHIAN_LOOKBACK + 5,
	riskParams: {
		stopLossAtrMultiplier: 2.0,
		takeProfitRatio: 2.0,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { highs, lows, closes, atr } = indicators;
		const n = DONCHIAN_LOOKBACK;
		if (closes.length < n + 2 || atr.length === 0 || highs.length < n + 2 || lows.length < n + 2) {
			return null;
		}

		const last = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const currentAtr = atr[atr.length - 1];
		if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

		// Channel from the PRIOR n bars (exclude the current bar to avoid lookahead:
		// the current close is being compared against a window that ends one bar back).
		const priorHighs = highs.slice(-(n + 1), -1);
		const priorLows = lows.slice(-(n + 1), -1);
		if (priorHighs.length < n || priorLows.length < n) return null;

		const channelHigh = Math.max(...priorHighs);
		const channelLow = Math.min(...priorLows);

		// Confidence scales with how decisively price clears the channel (in ATRs).
		const trailPct = Math.min(Math.max((currentAtr / price) * 100 * this.riskParams.stopLossAtrMultiplier, 0.5), 12);

		// Long breakout: close exceeds the prior n-bar high.
		if (price > channelHigh) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			const clearance = (price - channelHigh) / currentAtr;
			return {
				symbol: last.symbol,
				direction: "long",
				confidence: Math.min(0.4 + Math.min(clearance, 1) * 0.4, 0.9),
				reason: `Donchian breakout UP: close ${price.toFixed(2)} > ${n}-bar high ${channelHigh.toFixed(2)} (${clearance.toFixed(2)} ATR clear)`,
				entryPrice: price,
				stopLoss,
				takeProfit: price + riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: trailPct,
				timestamp: last.openTime,
			};
		}

		// Short breakout: close breaks below the prior n-bar low.
		if (price < channelLow) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = stopLoss - price;
			const clearance = (channelLow - price) / currentAtr;
			return {
				symbol: last.symbol,
				direction: "short",
				confidence: Math.min(0.4 + Math.min(clearance, 1) * 0.4, 0.9),
				reason: `Donchian breakout DOWN: close ${price.toFixed(2)} < ${n}-bar low ${channelLow.toFixed(2)} (${clearance.toFixed(2)} ATR clear)`,
				entryPrice: price,
				stopLoss,
				takeProfit: price - riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: trailPct,
				timestamp: last.openTime,
			};
		}

		return null;
	},
};

// ── 2. Squeeze Breakout (volatility-percentile) ────────────────────────────────

const SQUEEZE_LOOKBACK = 50; // bandwidth-percentile window
const SQUEEZE_PERCENTILE = 0.25; // "squeeze" = recent bandwidth in bottom 25%

/**
 * Detect a volatility squeeze via Bollinger bandwidth percentile: bandwidth one bar
 * ago sits in the bottom SQUEEZE_PERCENTILE of the last SQUEEZE_LOOKBACK bars. Then
 * enter when bandwidth EXPANDS and price exits the band in the breakout direction.
 *
 * Distinct from "breakout" (which uses an 0.8×-average heuristic + a 2-candle
 * confirmation + VWAP): this anchors on a percentile-ranked squeeze over a longer
 * window and fires on the first expansion bar that closes outside the band.
 */
export const squeezeBreakoutStrategy: Strategy = {
	name: "squeeze-breakout",
	description:
		"Volatility-percentile squeeze: when Bollinger bandwidth is in a low percentile then expands, enter on the band-exit breakout.",
	timeframe: "1h",
	// Bollinger bandwidth array is trimmed by (BB period − 1)=19 bars; the squeeze
	// needs a 50-bar bandwidth window → need ~SQUEEZE_LOOKBACK + 19 + warmup candles.
	minCandles: SQUEEZE_LOOKBACK + 25,
	riskParams: {
		stopLossAtrMultiplier: 1.5,
		takeProfitRatio: 2.0,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, bollingerBands: bb, atr } = indicators;
		if (bb.middle.length < SQUEEZE_LOOKBACK + 2 || closes.length < SQUEEZE_LOOKBACK + 2 || atr.length === 0) {
			return null;
		}

		const last = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const currentAtr = atr[atr.length - 1];
		if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

		// Bandwidth series (normalized by middle band).
		const bandwidths: number[] = [];
		for (let i = 0; i < bb.middle.length; i++) {
			const mid = bb.middle[i];
			if (mid > 0) bandwidths.push((bb.upper[i] - bb.lower[i]) / mid);
			else bandwidths.push(Number.NaN);
		}
		const curBw = bandwidths[bandwidths.length - 1];
		const prevBw = bandwidths[bandwidths.length - 2];
		if (!Number.isFinite(curBw) || !Number.isFinite(prevBw)) return null;

		// Was the PRIOR bar in a squeeze? Rank prevBw within the lookback window
		// (ending at the prior bar — strictly historical, no lookahead).
		const window = bandwidths.slice(-(SQUEEZE_LOOKBACK + 1), -1).filter((b) => Number.isFinite(b));
		if (window.length < SQUEEZE_LOOKBACK * 0.6) return null;
		const sorted = [...window].sort((a, b) => a - b);
		const rank = sorted.filter((b) => b <= prevBw).length / sorted.length;
		const wasSqueezed = rank <= SQUEEZE_PERCENTILE;
		const isExpanding = curBw > prevBw * 1.05;
		if (!wasSqueezed || !isExpanding) return null;

		const upper = bb.upper[bb.upper.length - 1];
		const lower = bb.lower[bb.lower.length - 1];

		// Confidence: deeper squeeze (lower rank) + bigger expansion = higher.
		const squeezeStrength = 1 - rank / SQUEEZE_PERCENTILE; // 0..1
		const expansionStrength = Math.min((curBw / prevBw - 1) / 0.5, 1);
		const conf = Math.min(0.4 + squeezeStrength * 0.25 + expansionStrength * 0.25, 0.9);

		if (price > upper) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			return {
				symbol: last.symbol,
				direction: "long",
				confidence: conf,
				reason: `Squeeze breakout UP: bw rank ${(rank * 100).toFixed(0)}% expanding ${(curBw / prevBw).toFixed(2)}×, close above upper band`,
				entryPrice: price,
				stopLoss,
				takeProfit: price + riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: 3,
				timestamp: last.openTime,
			};
		}

		if (price < lower) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = stopLoss - price;
			return {
				symbol: last.symbol,
				direction: "short",
				confidence: conf,
				reason: `Squeeze breakout DOWN: bw rank ${(rank * 100).toFixed(0)}% expanding ${(curBw / prevBw).toFixed(2)}×, close below lower band`,
				entryPrice: price,
				stopLoss,
				takeProfit: price - riskDistance * this.riskParams.takeProfitRatio,
				trailingStopPct: 3,
				timestamp: last.openTime,
			};
		}

		return null;
	},
};

// ── 3. Session Opening-Range Breakout (ORB) ────────────────────────────────────

const ORB_OPENING_BARS = 4; // first K bars of a session define the range

/**
 * Opening-range breakout using the UTC session boundaries from session-filter.ts.
 * Within the current session, the first ORB_OPENING_BARS bars define the opening
 * range [rangeHigh, rangeLow]. After the opening window, enter on a close above
 * rangeHigh (long) or below rangeLow (short). One signal-eligible window per
 * session; flat by session end (the engine exits on stop/TP — we never hold across
 * the session via a wide TP cap and ATR stop).
 *
 * Structurally distinct from any existing built-in: it is anchored to clock-based
 * session opens, not to indicator crossovers.
 */
export const sessionOrbStrategy: Strategy = {
	name: "session-orb",
	description:
		"Session opening-range breakout: define the high/low of the first K bars of a UTC session, then enter on a range break during that session.",
	timeframe: "1h",
	minCandles: ORB_OPENING_BARS + 4,
	riskParams: {
		stopLossAtrMultiplier: 1.5,
		takeProfitRatio: 1.5,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, atr } = indicators;
		if (candles.length < ORB_OPENING_BARS + 2 || atr.length === 0) return null;

		const last = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const currentAtr = atr[atr.length - 1];
		if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

		const curSession = getCurrentSession(new Date(last.openTime)).session;

		// Walk backward to find where the CURRENT session began (contiguous run of
		// same-session bars ending at the current bar).
		let sessionStart = candles.length - 1;
		for (let i = candles.length - 2; i >= 0; i--) {
			if (getCurrentSession(new Date(candles[i].openTime)).session === curSession) {
				sessionStart = i;
			} else {
				break;
			}
		}
		const barsIntoSession = candles.length - 1 - sessionStart; // 0 on first bar

		// Need the opening window fully formed AND still be inside the session
		// (not the very first opening bars). Require at least one bar after the
		// opening range to act on a break.
		if (barsIntoSession < ORB_OPENING_BARS) return null;

		// Opening range = first ORB_OPENING_BARS bars of this session.
		const opening = candles.slice(sessionStart, sessionStart + ORB_OPENING_BARS);
		if (opening.length < ORB_OPENING_BARS) return null;
		const rangeHigh = Math.max(...opening.map((c) => c.high));
		const rangeLow = Math.min(...opening.map((c) => c.low));
		const prevClose = closes[closes.length - 2];

		// Fresh breakout only: prior close was inside the range, current close breaks out.
		const conf = 0.55;

		if (price > rangeHigh && prevClose <= rangeHigh) {
			const stopLoss = Math.min(price - currentAtr * this.riskParams.stopLossAtrMultiplier, rangeLow);
			const riskDistance = price - stopLoss;
			if (riskDistance <= 0) return null;
			return {
				symbol: last.symbol,
				direction: "long",
				confidence: conf,
				reason: `Session ORB UP (${curSession}): close ${price.toFixed(2)} > opening-range high ${rangeHigh.toFixed(2)}`,
				entryPrice: price,
				stopLoss,
				takeProfit: price + riskDistance * this.riskParams.takeProfitRatio,
				timestamp: last.openTime,
			};
		}

		if (price < rangeLow && prevClose >= rangeLow) {
			const stopLoss = Math.max(price + currentAtr * this.riskParams.stopLossAtrMultiplier, rangeHigh);
			const riskDistance = stopLoss - price;
			if (riskDistance <= 0) return null;
			return {
				symbol: last.symbol,
				direction: "short",
				confidence: conf,
				reason: `Session ORB DOWN (${curSession}): close ${price.toFixed(2)} < opening-range low ${rangeLow.toFixed(2)}`,
				entryPrice: price,
				stopLoss,
				takeProfit: price - riskDistance * this.riskParams.takeProfitRatio,
				timestamp: last.openTime,
			};
		}

		return null;
	},
};

// ── 4. Connors RSI(2) Mean-Reversion ───────────────────────────────────────────

const CRSI_RSI_LONG = 5; // RSI(2) entry threshold for longs
const CRSI_RSI_SHORT = 95; // RSI(2) entry threshold for shorts
const CRSI_TREND_SMA = 200; // trend filter
const CRSI_EXIT_SMA = 5; // exit reference

/**
 * Larry Connors' "RSI(2)" mean-reversion. Long when a short-period RSI is deeply
 * oversold (<5) while price is ABOVE the 200-SMA (i.e. buy dips in an uptrend);
 * the documented exit is "close back above the 5-SMA" — we encode that as the
 * take-profit reference. Symmetric short below the 200-SMA when RSI is overbought.
 *
 * Note: the precomputed `indicators.rsi` is RSI(14), not RSI(2). Connors uses a
 * 2-period RSI, so we compute RSI(2) locally from closes (the only way to honor
 * the actual mechanism — the shared IndicatorValues has no RSI(2) field).
 */
export const connorsRsi2Strategy: Strategy = {
	name: "connors-rsi2",
	description:
		"Connors RSI(2) mean-reversion: long when RSI(2)<5 and close>SMA200 (exit toward SMA5); symmetric short when RSI(2)>95 and close<SMA200.",
	timeframe: "1h",
	// Exactly CRSI_TREND_SMA closes are needed to form one SMA(200) value. The
	// honest Backtester caps its lookback window at 200 bars, so requiring more
	// than that would make this strategy silently produce 0 trades. We therefore
	// need just enough warmup to compute SMA(200) locally inside that window.
	minCandles: CRSI_TREND_SMA,
	riskParams: {
		stopLossAtrMultiplier: 2.0,
		takeProfitRatio: 1.0,
		riskPerTradePct: 1.0,
	},

	evaluate(candles: Candle[], indicators: IndicatorValues): Signal | null {
		const { closes, atr, sma } = indicators;
		if (closes.length < CRSI_TREND_SMA || atr.length === 0) return null;

		// The shared IndicatorValues SMA(200) array is EMPTY when the window holds
		// exactly 200 candles (and the Backtester caps windows at 200). Compute
		// SMA(200) locally in that case so the trend filter still works.
		const precomputed200 = sma[CRSI_TREND_SMA];
		const sma200 = precomputed200 && precomputed200.length > 0 ? precomputed200 : computeSma(closes, CRSI_TREND_SMA);
		const sma5Arr = sma[CRSI_EXIT_SMA] ?? computeSma(closes, CRSI_EXIT_SMA);
		if (!sma200 || sma200.length === 0) return null;

		const last = candles[candles.length - 1];
		const price = closes[closes.length - 1];
		const currentAtr = atr[atr.length - 1];
		const trend = sma200[sma200.length - 1];
		const exitSma = sma5Arr[sma5Arr.length - 1];
		if (!Number.isFinite(currentAtr) || currentAtr <= 0 || !Number.isFinite(trend) || !Number.isFinite(exitSma)) {
			return null;
		}

		const rsi2 = wilderRsi(closes, 2);
		const curRsi2 = rsi2[rsi2.length - 1];
		if (!Number.isFinite(curRsi2)) return null;

		// Long: deeply oversold dip in an uptrend (price above SMA200).
		if (curRsi2 < CRSI_RSI_LONG && price > trend) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			// TP reference: revert at least to the 5-SMA, but honor takeProfitRatio
			// as a floor so the cap/RR machinery still applies cleanly.
			const ratioTp = price + riskDistance * this.riskParams.takeProfitRatio;
			const takeProfit = Math.max(exitSma, ratioTp);
			return {
				symbol: last.symbol,
				direction: "long",
				confidence: Math.min(0.45 + (CRSI_RSI_LONG - curRsi2) / CRSI_RSI_LONG * 0.4, 0.9),
				reason: `Connors RSI(2)=${curRsi2.toFixed(1)} < 5 in uptrend (close ${price.toFixed(2)} > SMA200 ${trend.toFixed(2)})`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				timestamp: last.openTime,
			};
		}

		// Short: deeply overbought rip in a downtrend (price below SMA200).
		if (curRsi2 > CRSI_RSI_SHORT && price < trend) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = stopLoss - price;
			const ratioTp = price - riskDistance * this.riskParams.takeProfitRatio;
			const takeProfit = Math.min(exitSma, ratioTp);
			return {
				symbol: last.symbol,
				direction: "short",
				confidence: Math.min(0.45 + (curRsi2 - CRSI_RSI_SHORT) / (100 - CRSI_RSI_SHORT) * 0.4, 0.9),
				reason: `Connors RSI(2)=${curRsi2.toFixed(1)} > 95 in downtrend (close ${price.toFixed(2)} < SMA200 ${trend.toFixed(2)})`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				timestamp: last.openTime,
			};
		}

		return null;
	},
};

// ── Local indicator helpers (self-contained; no shared-state mutation) ─────────

/** Simple moving average — fallback when the requested SMA period isn't precomputed. */
function computeSma(values: number[], period: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < values.length; i++) {
		if (i < period - 1) {
			out.push(Number.NaN);
			continue;
		}
		let sum = 0;
		for (let j = i - period + 1; j <= i; j++) sum += values[j];
		out.push(sum / period);
	}
	return out;
}

/**
 * Wilder's RSI for an arbitrary (short) period — used for RSI(2), which the shared
 * IndicatorValues (RSI-14) does not provide. Returns NaN until enough data.
 */
function wilderRsi(closes: number[], period: number): number[] {
	const out: number[] = new Array(closes.length).fill(Number.NaN);
	if (closes.length <= period) return out;

	let gainSum = 0;
	let lossSum = 0;
	for (let i = 1; i <= period; i++) {
		const change = closes[i] - closes[i - 1];
		if (change >= 0) gainSum += change;
		else lossSum -= change;
	}
	let avgGain = gainSum / period;
	let avgLoss = lossSum / period;
	out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

	for (let i = period + 1; i < closes.length; i++) {
		const change = closes[i] - closes[i - 1];
		const gain = change > 0 ? change : 0;
		const loss = change < 0 ? -change : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
		out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
	}
	return out;
}

/** All four experiment strategies — consumed by scripts/edge-search.mjs. */
export const EDGE_EXPERIMENT_STRATEGIES: Strategy[] = [
	donchianTrendStrategy,
	squeezeBreakoutStrategy,
	sessionOrbStrategy,
	connorsRsi2Strategy,
];
