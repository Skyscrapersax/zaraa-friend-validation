import type { Candle } from "../../data/candle-store.js";
import type { Strategy, Signal, IndicatorValues, MarketContext } from "../strategy.js";
import { applyTpCap } from "../tp-cap.js";
import { computeADX } from "../market-regime.js";

// Trend-following only fires when the market is genuinely trending. ADX < 30
// is "ranging or weakly directional" — exactly the condition the audit found
// produces whipsaw losses on this strategy. Was 25; bumped to 30 in Phase 2
// after workstream-C audit showed nominally-trending markets at 25 ≤ ADX < 30
// still whipsaw the 4h BTC entries that drove the bulk of TF stop-outs. Gate
// is configurable via env var so backtests can probe alternate thresholds
// without a code change.
const TREND_FOLLOWING_MIN_ADX_DEFAULT = 30;

// Confidence threshold that the learned-pattern regime must clear before its
// verdict overrides the strategy's own ADX/EMA logic. Below this we treat the
// pattern signal as too noisy and let the rest of the strategy decide. Was
// 0.6; bumped to 0.75 in Phase 2 — workstream-C audit found borderline
// regime calls (0.6 ≤ confidence < 0.75) account for most TF whipsaws even
// with the May-8 directional gate active.
export const TREND_FOLLOWING_REGIME_GATE_MIN_CONFIDENCE = 0.75;

function getTrendFollowingMinAdx(): number {
	const raw = Number(process.env.TRADING_TREND_FOLLOWING_MIN_ADX);
	return Number.isFinite(raw) && raw > 0 ? raw : TREND_FOLLOWING_MIN_ADX_DEFAULT;
}

/** Exposed so tests can verify the configured threshold without re-reading env. */
export function getTrendFollowingMinAdxThreshold(): number {
	return getTrendFollowingMinAdx();
}

/**
 * Trend Following Strategy
 *
 * Logic:
 *   1. CROSSOVER: Enter long when fast EMA (20) crosses above slow EMA (50) with RSI > 50.
 *      Enter short on death cross with RSI < 50.
 *   2. CONTINUATION: Enter when an established trend shows a pullback-and-resume pattern.
 *      In a downtrend (EMA20 < EMA50, widening gap), enter short on pullback toward EMA20
 *      that resumes downward. In an uptrend, enter long on dip to EMA20 that bounces.
 *
 * The continuation signal catches established trends that the crossover missed
 * (e.g., if the cross happened before strategies were activated, or during
 * a low-confidence period).
 *
 * Best in: Trending markets with clear directional moves.
 * Weak in: Choppy/sideways markets (whipsaws).
 */

// Audit (May 2026): trend-following ran net −$0.95 over the audit window vs.
// mean-reversion at +$1.48 (PF 4.10). Late entries — MACD-confirmation after
// EMA cross meant the strategy chased rather than rode trends. Default-gated
// off; flip via `TRADING_TREND_FOLLOWING_ENABLED=true` env var or
// `setTrendFollowingMode("enabled" | "shadow" | "off")` programmatically.
//
//   "off"      → evaluate() returns null (no signals enter the pipeline)
//   "shadow"   → evaluate() returns null today; reserved for future
//                journal-only mode once shadow scoring is wired up
//   "enabled"  → normal evaluation, signals reach live/paper execution
export type TrendFollowingMode = "enabled" | "shadow" | "off";

function readTrendFollowingMode(): TrendFollowingMode {
	const raw = process.env.TRADING_TREND_FOLLOWING_MODE?.toLowerCase();
	if (raw === "enabled" || raw === "shadow" || raw === "off") return raw;
	const enabled = process.env.TRADING_TREND_FOLLOWING_ENABLED?.toLowerCase();
	if (enabled === "true" || enabled === "1") return "enabled";
	if (enabled === "shadow") return "shadow";
	return "off";
}

let trendFollowingMode: TrendFollowingMode = readTrendFollowingMode();

export function setTrendFollowingMode(mode: TrendFollowingMode): void {
	trendFollowingMode = mode;
}

export function getTrendFollowingMode(): TrendFollowingMode {
	return trendFollowingMode;
}

/** Returns true only when signals should reach live/paper execution. */
export function isTrendFollowingLive(): boolean {
	return trendFollowingMode === "enabled";
}

// ── Phase 2 14-day re-evaluation gate ──
//
// Phase 2 (May 9, 2026) tightened TF entry criteria: ADX gate 25→30 and
// regime-confidence threshold 0.6→0.75. The agreement was to give the
// tightened logic a 14-day soak window and re-evaluate on/after
// 2026-05-23 — if TF closed-trade PnL since 2026-05-09 is still ≤ $0,
// flip the mode to "off" automatically.
//
// This function is the gate. zaraa.ts wires it to a daily 6h timer; the
// function itself is the source of truth for the cutoff and baseline
// dates so they aren't scattered.
export const TF_GATE_DEFAULT_BASELINE_ISO = "2026-05-09T00:00:00.000Z";
export const TF_GATE_DEFAULT_EVAL_AFTER_ISO = "2026-05-23T00:00:00.000Z";

export interface TrendFollowingGateJournalDb {
	prepare(sql: string): {
		get(...params: unknown[]): unknown;
	};
}

export interface EvaluateTrendFollowingGateInput {
	/** SQLite handle to trade-journal.db (the DB TradeJournal writes
	 *  strategy_trades to). */
	journalDb: TrendFollowingGateJournalDb;
	/** Earliest exitedAt (inclusive) to include in the PnL sum.
	 *  Defaults to TF_GATE_DEFAULT_BASELINE_ISO (Phase 2 ramp date). */
	baselineIso?: string;
	/** The function is a no-op until wall-clock reaches this date.
	 *  Defaults to TF_GATE_DEFAULT_EVAL_AFTER_ISO. */
	evalAfterIso?: string;
	/** Override for testing. Defaults to new Date(). */
	now?: Date;
}

export interface EvaluateTrendFollowingGateResult {
	/** False when the eval cutoff hasn't been reached yet — a no-op. */
	ran: boolean;
	/** Total trend-following PnL since baseline. null when ran=false. */
	pnl: number | null;
	/** Closed trade count contributing to the PnL sum. */
	closedTrades: number;
	/** True when this call set the mode to "off". */
	modeFlipped: boolean;
	/** Mode the gate observed before any flip. */
	previousMode: TrendFollowingMode | null;
	/** Human-readable summary suitable for logs / iMessage. */
	reason: string;
}

export function evaluateTrendFollowingGate(
	input: EvaluateTrendFollowingGateInput,
): EvaluateTrendFollowingGateResult {
	const now = input.now ?? new Date();
	const evalAfter = new Date(input.evalAfterIso ?? TF_GATE_DEFAULT_EVAL_AFTER_ISO);
	if (now < evalAfter) {
		return {
			ran: false,
			pnl: null,
			closedTrades: 0,
			modeFlipped: false,
			previousMode: null,
			reason: `TF re-eval gate not due yet (next at ${evalAfter.toISOString()})`,
		};
	}

	const baseline = input.baselineIso ?? TF_GATE_DEFAULT_BASELINE_ISO;
	const row = input.journalDb
		.prepare(
			`SELECT
				COUNT(*) AS count,
				COALESCE(SUM(pnl), 0.0) AS pnl
			 FROM strategy_trades
			 WHERE strategyName = 'trend-following'
			   AND exitedAt IS NOT NULL
			   AND exitedAt > ?
			   AND pnl IS NOT NULL`,
		)
		.get(baseline) as { count: number; pnl: number };

	const previousMode = getTrendFollowingMode();
	if (row.pnl <= 0) {
		if (previousMode !== "off") setTrendFollowingMode("off");
		return {
			ran: true,
			pnl: row.pnl,
			closedTrades: row.count,
			modeFlipped: previousMode !== "off",
			previousMode,
			reason: `TF PnL since ${baseline}: $${row.pnl.toFixed(2)} across ${row.count} trade(s) — disabling (previous mode: ${previousMode})`,
		};
	}
	return {
		ran: true,
		pnl: row.pnl,
		closedTrades: row.count,
		modeFlipped: false,
		previousMode,
		reason: `TF PnL since ${baseline}: +$${row.pnl.toFixed(2)} across ${row.count} trade(s) — keeping ${previousMode}`,
	};
}
export const trendFollowingStrategy: Strategy = {
	name: "trend-following",
	description:
		"EMA 20/50 crossover with RSI momentum filter. Enters on golden cross with RSI > 50, exits on death cross.",
	timeframe: "4h",
	minCandles: 55,
	riskParams: {
		stopLossAtrMultiplier: 2.0,
		takeProfitRatio: 3.0, // wider target for trend trades
		riskPerTradePct: 1.0, // conservative for real money
		maxRiskRewardRatio: 3.0,
		maxTpPercent: 2.0, // tightened from 4% — 4% TP unreachable in typical timeframes; was blocking shadow soak close-count progress
	},

	evaluate(
		candles: Candle[],
		indicators: IndicatorValues,
		context?: MarketContext | null,
	): Signal | null {
		// Strategy is gated off by default — see audit note above.
		// Both "off" and "shadow" suppress signals today; "shadow" is a
		// reserved mode for future journal-only evaluation.
		if (trendFollowingMode !== "enabled") return null;

		const { closes, highs, lows, ema, rsi, atr, macd } = indicators;
		const ema20 = ema[20];
		const ema50 = ema[50];

		if (!ema20 || !ema50 || ema20.length < 2 || ema50.length < 2) return null;
		if (rsi.length < 2 || atr.length === 0) return null;

		const price = closes[closes.length - 1];
		const currentRsi = rsi[rsi.length - 1];
		const currentAtr = atr[atr.length - 1];
		const lastCandle = candles[candles.length - 1];

		// ── Learned-pattern regime gate ──────────────────────────────────
		// Audit (May 2026, post-mode-flip): trend-following ran a slow
		// −$0.24 leak over 24 trades (R=−0.02) while mean-reversion earned
		// +$1.79 over 34 trades. Most of the trend-following losses came
		// from non-trending hours where EMA crosses whipsawed. The
		// MarketContext regime is derived from MarketLearner patterns at
		// the current UTC hour and labels each hour trending_up,
		// trending_down, ranging, or neutral.
		//
		// When confidence clears the threshold:
		//   - ranging / neutral  → suppress entirely (the leak case)
		//   - trending_up        → only longs allowed
		//   - trending_down      → only shorts allowed
		// Cold start (context null or low confidence) is a no-op so the
		// existing ADX/EMA pipeline still runs as the fallback.
		const regimeStrong =
			!!context &&
			context.regimeConfidence > TREND_FOLLOWING_REGIME_GATE_MIN_CONFIDENCE;
		if (
			regimeStrong &&
			context!.regime !== "trending_up" &&
			context!.regime !== "trending_down"
		) {
			return null;
		}
		const allowLongs = !regimeStrong || context!.regime === "trending_up";
		const allowShorts = !regimeStrong || context!.regime === "trending_down";

		// ADX gate: trend-following only fires in genuinely trending markets.
		// Audit (May 2026): the strategy ran net negative on whipsaws during
		// ranging conditions; this gate suppresses entries until ADX confirms
		// trend strength. Skipped only when ADX cannot be computed (cold start).
		const adxSeries = computeADX(highs, lows, closes, 14);
		const currentAdx = adxSeries.length > 0 ? adxSeries[adxSeries.length - 1] : null;
		const minAdx = getTrendFollowingMinAdx();
		if (currentAdx != null && currentAdx < minAdx) return null;

		// Current and previous values for crossover detection
		const fast = ema20[ema20.length - 1];
		const fastPrev = ema20[ema20.length - 2];
		const slow = ema50[ema50.length - 1];
		const slowPrev = ema50[ema50.length - 2];
		// Crossover uses fast/fastPrev vs slow/slowPrev directly
		const fastAligned = fast;
		const fastPrevAligned = fastPrev;

		// MACD histogram for additional confirmation
		const macdHist = macd.histogram;
		const macdConfirm = macdHist.length > 0 ? macdHist[macdHist.length - 1] : 0;
		// Also check MACD is strengthening (histogram growing in signal direction)
		const macdPrev = macdHist.length > 1 ? macdHist[macdHist.length - 2] : 0;

		// ATR-relative crossover tolerance (dynamic, not fixed 0.1%)
		const tolerance = currentAtr * 0.1; // 10% of ATR

		// Golden cross: fast EMA crosses above slow EMA
		const goldenCross = fastPrevAligned <= slowPrev + tolerance && fastAligned > slow;
		// Death cross: fast EMA crosses below slow EMA
		const deathCross = fastPrevAligned >= slowPrev - tolerance && fastAligned < slow;

		// Long signal — require MACD turning UP (rising histogram) on the cross.
		// Previously also required macdConfirm > 0 (already-positive), which on a
		// fresh golden cross is almost never true yet → 0 standalone trades in 166d
		// of backtest. RSI band + ADX>=30 + regime gate still guard quality.
		if (allowLongs && goldenCross && currentRsi > 50 && currentRsi < 75 && macdConfirm > macdPrev) {
			const stopLoss = price - currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = price - stopLoss;
			const rawTp = price + riskDistance * this.riskParams.takeProfitRatio;
			const takeProfit = applyTpCap(price, stopLoss, rawTp, {
				maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
				maxTpPercent: this.riskParams.maxTpPercent,
				context: `trend-following golden-cross long ${lastCandle.symbol}`,
			}).takeProfit;
			return {
				symbol: lastCandle.symbol,
				direction: "long",
				confidence: calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "long"),
				reason: `EMA 20/50 golden cross, RSI ${currentRsi.toFixed(1)}, MACD strengthening (${macdConfirm.toFixed(2)})`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 3, // Lock in gains as trend progresses
				timestamp: lastCandle.openTime,
			};
		}

		// Short signal — require MACD turning DOWN (falling histogram) on the cross.
		// Dropped the symmetric macdConfirm < 0 (already-negative) clause that made
		// fresh death-cross shorts almost never fire. RSI band + ADX + regime remain.
		if (allowShorts && deathCross && currentRsi < 50 && currentRsi > 25 && macdConfirm < macdPrev) {
			const stopLoss = price + currentAtr * this.riskParams.stopLossAtrMultiplier;
			const riskDistance = stopLoss - price;
			const rawTp = price - riskDistance * this.riskParams.takeProfitRatio;
			const takeProfit = applyTpCap(price, stopLoss, rawTp, {
				maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
				maxTpPercent: this.riskParams.maxTpPercent,
				context: `trend-following death-cross short ${lastCandle.symbol}`,
			}).takeProfit;
			return {
				symbol: lastCandle.symbol,
				direction: "short",
				confidence: calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "short"),
				reason: `EMA 20/50 death cross, RSI ${currentRsi.toFixed(1)}, MACD weakening (${macdConfirm.toFixed(2)})`,
				entryPrice: price,
				stopLoss,
				takeProfit,
				trailingStopPct: 3, // Lock in gains as trend progresses
				timestamp: lastCandle.openTime,
			};
		}

		// ── Trend continuation: ride established trends ──────────────────
		// The crossover-only approach misses trends that are already underway
		// (e.g., death cross happened 3 days ago but we just started scanning).
		// This catches pullback-and-resume patterns within established trends.
		//
		// Requirements for short continuation:
		//   - EMA20 < EMA50 (established downtrend)
		//   - Gap is significant (>0.5% — not a near-cross that might whipsaw)
		//   - Price pulled back toward EMA20 recently but is now resuming down
		//   - MACD confirms bearish momentum
		//   - RSI in bearish territory (<50) but not capitulation (<20)
		//
		// Requirements for long continuation: mirror image.
		const emaSeparationPct = (fast - slow) / slow;

		// Established downtrend: EMA20 well below EMA50
		if (allowShorts && emaSeparationPct < -0.005 && currentRsi < 50 && currentRsi > 20 && macdConfirm < 0) {
			// Price should be near or below EMA20 (pulled back and resuming)
			// "Near" means within 0.5 * ATR of the fast EMA
			const nearFastEma = price <= fast + currentAtr * 0.5;
			const resumingDown = price < closes[closes.length - 2]; // current candle moving down

			if (nearFastEma && resumingDown) {
				const stopLoss = fast + currentAtr * this.riskParams.stopLossAtrMultiplier;
				const riskDistance = stopLoss - price;
				const rawTp = price - riskDistance * this.riskParams.takeProfitRatio;
				const takeProfit = applyTpCap(price, stopLoss, rawTp, {
					maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
					maxTpPercent: this.riskParams.maxTpPercent,
					context: `trend-following continuation short ${lastCandle.symbol}`,
				}).takeProfit;
				// Slightly lower confidence than crossover signals — continuation is
				// a secondary pattern. But still valid and tradeable.
				const confidence = calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "short") * 0.9;
				return {
					symbol: lastCandle.symbol,
					direction: "short",
					confidence,
					reason: `Trend continuation SHORT: EMA20 (${fast.toFixed(0)}) < EMA50 (${slow.toFixed(0)}) by ${(Math.abs(emaSeparationPct) * 100).toFixed(2)}%, RSI ${currentRsi.toFixed(1)}, price resuming below fast EMA`,
					entryPrice: price,
					stopLoss,
					takeProfit,
					trailingStopPct: 3,
					timestamp: lastCandle.openTime,
				};
			}
		}

		// Established uptrend: EMA20 well above EMA50
		if (allowLongs && emaSeparationPct > 0.005 && currentRsi > 50 && currentRsi < 80 && macdConfirm > 0) {
			const nearFastEma = price >= fast - currentAtr * 0.5;
			const resumingUp = price > closes[closes.length - 2];

			if (nearFastEma && resumingUp) {
				const stopLoss = fast - currentAtr * this.riskParams.stopLossAtrMultiplier;
				const riskDistance = price - stopLoss;
				const rawTp = price + riskDistance * this.riskParams.takeProfitRatio;
				const takeProfit = applyTpCap(price, stopLoss, rawTp, {
					maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
					maxTpPercent: this.riskParams.maxTpPercent,
					context: `trend-following continuation long ${lastCandle.symbol}`,
				}).takeProfit;
				const confidence = calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "long") * 0.9;
				return {
					symbol: lastCandle.symbol,
					direction: "long",
					confidence,
					reason: `Trend continuation LONG: EMA20 (${fast.toFixed(0)}) > EMA50 (${slow.toFixed(0)}) by ${(emaSeparationPct * 100).toFixed(2)}%, RSI ${currentRsi.toFixed(1)}, price resuming above fast EMA`,
					entryPrice: price,
					stopLoss,
					takeProfit,
					trailingStopPct: 3,
					timestamp: lastCandle.openTime,
				};
			}
		}

		// ── Momentum lead: price leading the EMAs ────────────────────────
		// Handles a blind spot in the crossover and continuation patterns:
		// when price rallies strongly above BOTH EMAs while they still show
		// the old trend structure (e.g., death cross). This means price is
		// leading the indicators — the EMAs WILL cross, but haven't yet.
		//
		// This is a real pattern: after a selloff, strong buying pushes price
		// above both EMAs. The fast EMA starts bending up (it's closer to price)
		// while the slow EMA barely moves. MACD confirms the momentum shift
		// (histogram positive and growing). RSI shows genuine strength (>55).
		//
		// Requirements:
		//   - Price is above BOTH EMAs (leading the trend)
		//   - EMAs are converging (fast moving toward slow, gap narrowing)
		//   - MACD histogram positive and strengthening
		//   - RSI 55-80 (confirmed strength, not yet overheated)
		//   - Current candle is green (price still rising)
		//
		// This pattern fires with slightly lower confidence than a crossover
		// because the cross hasn't confirmed yet — it's an anticipatory entry.
		const priceAboveBoth = price > fast && price > slow;
		const emaConverging = Math.abs(fast - slow) < Math.abs(fastPrev - slowPrev);
		const fastRising = fast > fastPrev;
		const strongMomentum = macdConfirm > 0 && macdConfirm > macdPrev;
		const confirmedStrength = currentRsi > 55 && currentRsi < 80;
		const risingPrice = price > closes[closes.length - 2];

		if (allowLongs && priceAboveBoth && emaConverging && fastRising && strongMomentum && confirmedStrength && risingPrice) {
			// Price-to-EMA gap as % — how far ahead of the fast EMA is price?
			const priceLeadPct = (price - fast) / fast;
			// Don't enter if price is extended too far above EMAs (>3% over EMA20) —
			// that's mean-reversion territory, not trend entry.
			if (priceLeadPct < 0.03) {
				const stopLoss = fast - currentAtr * 0.5; // Tight stop below EMA20
				const riskDistance = price - stopLoss;
				const rawTp = price + riskDistance * this.riskParams.takeProfitRatio;
				const takeProfit = applyTpCap(price, stopLoss, rawTp, {
					maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
					maxTpPercent: this.riskParams.maxTpPercent,
					context: `trend-following momentum-lead long ${lastCandle.symbol}`,
				}).takeProfit;
				// Lower confidence than crossover — anticipatory entry
				const confidence = calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "long") * 0.85;
				return {
					symbol: lastCandle.symbol,
					direction: "long",
					confidence,
					reason: `Momentum lead LONG: price ($${price.toFixed(0)}) above both EMAs (${fast.toFixed(0)}/${slow.toFixed(0)}), ` +
						`EMAs converging, MACD strengthening (${macdConfirm.toFixed(2)}), RSI ${currentRsi.toFixed(1)}`,
					entryPrice: price,
					stopLoss,
					takeProfit,
					trailingStopPct: 2.5, // Tighter trailing — anticipatory entry needs quicker protection
					timestamp: lastCandle.openTime,
				};
			}
		}

		// Mirror: price below both EMAs, EMAs converging from above, bearish momentum
		const priceBelowBoth = price < fast && price < slow;
		const fastFalling = fast < fastPrev;
		const bearishMomentum = macdConfirm < 0 && macdConfirm < macdPrev;
		const confirmedWeakness = currentRsi > 20 && currentRsi < 45;
		const fallingPrice = price < closes[closes.length - 2];

		if (allowShorts && priceBelowBoth && emaConverging && fastFalling && bearishMomentum && confirmedWeakness && fallingPrice) {
			const priceTrailPct = (fast - price) / fast;
			if (priceTrailPct < 0.03) {
				const stopLoss = fast + currentAtr * 0.5;
				const riskDistance = stopLoss - price;
				const rawTp = price - riskDistance * this.riskParams.takeProfitRatio;
				const takeProfit = applyTpCap(price, stopLoss, rawTp, {
					maxRiskRewardRatio: this.riskParams.maxRiskRewardRatio,
					maxTpPercent: this.riskParams.maxTpPercent,
					context: `trend-following momentum-lead short ${lastCandle.symbol}`,
				}).takeProfit;
				const confidence = calculateTrendConfidence(currentRsi, fast, slow, macdConfirm, "short") * 0.85;
				return {
					symbol: lastCandle.symbol,
					direction: "short",
					confidence,
					reason: `Momentum lead SHORT: price ($${price.toFixed(0)}) below both EMAs (${fast.toFixed(0)}/${slow.toFixed(0)}), ` +
						`EMAs converging, MACD weakening (${macdConfirm.toFixed(2)}), RSI ${currentRsi.toFixed(1)}`,
					entryPrice: price,
					stopLoss,
					takeProfit,
					trailingStopPct: 2.5,
					timestamp: lastCandle.openTime,
				};
			}
		}

		return null;
	},
};

function calculateTrendConfidence(
	rsi: number,
	fastEma: number,
	slowEma: number,
	macdHist: number,
	direction: "long" | "short",
): number {
	// EMA separation strength (wider gap = stronger trend)
	const emaSeparation = Math.min(Math.abs(fastEma - slowEma) / slowEma / 0.02, 1);

	// RSI momentum
	const rsiStrength = direction === "long"
		? Math.min((rsi - 50) / 30, 1)
		: Math.min((50 - rsi) / 30, 1);

	// MACD confirmation
	const macdStrength = Math.min(Math.abs(macdHist) / (slowEma * 0.001), 1);

	return Math.min(0.4 + emaSeparation * 0.2 + rsiStrength * 0.2 + macdStrength * 0.2, 1);
}
