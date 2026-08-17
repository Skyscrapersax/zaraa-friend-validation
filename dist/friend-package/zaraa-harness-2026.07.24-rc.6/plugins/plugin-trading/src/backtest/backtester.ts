import type { Candle } from "../data/candle-store.js";
import type { Strategy, Signal } from "../strategies/strategy.js";
import { computeIndicators } from "../strategies/compute-indicators.js";
import { calculatePerformance } from "./performance.js";
import type { BacktestTrade, PerformanceMetrics } from "./performance.js";
import { applySlippage as sharedApplySlippage } from "../cost/trade-cost-model.js";
import {
	getDefaultFeeSchedules,
	resolveFeeRate,
	resolveVenue,
	type FeeSchedule,
} from "../cost/fee-schedule.js";

/**
 * How the strategy assumes its orders are filled.
 *  - "maker": post-only / LIMIT entries → maker fee rate (the live path we are
 *    moving limit-entry strategies toward). Default.
 *  - "taker": MARKET orders that cross the book → taker fee rate.
 */
export type BacktestFillType = "maker" | "taker";

/**
 * Minimum modeled slippage in bps. The paper execution path defaults to 5 bps
 * (`paperSlippageBps`), so a backtest must never assume LESS slippage than paper
 * — otherwise the in-sample proof is more optimistic than the live simulator.
 */
const MIN_SLIPPAGE_BPS = 5;

/**
 * Minimum execution delay. With delay 0 the backtester would fill at the signal
 * bar's own price (lookahead leak), trading on information from the bar that
 * produced the signal. Every fill must occur on a strictly LATER bar's open.
 */
const MIN_EXECUTION_DELAY_BARS = 1;

export interface BacktestConfig {
	/** Starting equity in USD */
	startingEquity: number;
	/** Risk per trade as % of equity (overrides strategy default if set) */
	riskPerTradePct?: number;
	/**
	 * @deprecated Flat USD commission is no longer the cost model — fees are now
	 * maker/taker-aware to match the live path. Retained for back-compat only and
	 * ignored by the run path.
	 */
	commission?: number;
	/** Slippage as % of price (floored to {@link MIN_SLIPPAGE_BPS} bps). Default: 0.05%. */
	slippagePct?: number;
	/**
	 * Simulated bar delay between signal and entry. Floored to
	 * {@link MIN_EXECUTION_DELAY_BARS} (1) so entries always fill at a later bar's
	 * open — never the signal bar. Default: 1.
	 */
	executionDelayBars?: number;
	/**
	 * Fill type the strategy assumes — keys the fee rate (maker vs taker) to the
	 * SAME schedule the live path uses. Default: "maker" (post-only/limit entry).
	 */
	fillType?: BacktestFillType;
	/** Optional venue fee-schedule overrides (defaults to {@link getDefaultFeeSchedules}). */
	feeSchedule?: FeeSchedule[];
}

/**
 * The effective cost configuration actually applied during the run, echoed onto
 * the result so a downstream scorecard can audit backtest↔live parity.
 */
export interface BacktestEffectiveConfig extends BacktestConfig {
	/** Maker/taker rate actually charged (fraction of notional, e.g. 0.0004). */
	feeRate: number;
	/** Effective slippage in bps (>= {@link MIN_SLIPPAGE_BPS}). */
	slippageBps: number;
	/** Effective execution delay in bars (>= {@link MIN_EXECUTION_DELAY_BARS}). */
	executionDelayBars: number;
	/** Fill type used to key the fee rate. */
	fillType: BacktestFillType;
}

export interface BacktestResult {
	strategy: string;
	symbol: string;
	timeframe: string;
	candlesUsed: number;
	startDate: string;
	endDate: string;
	config: BacktestEffectiveConfig;
	performance: PerformanceMetrics;
	trades: BacktestTrade[];
	equityCurve: number[];
	signals: number; // total signals generated
}

const DEFAULT_CONFIG: BacktestConfig = {
	startingEquity: 10_000,
	slippagePct: 0.05,
	executionDelayBars: MIN_EXECUTION_DELAY_BARS,
	fillType: "maker",
};

interface VirtualPosition {
	direction: "long" | "short";
	entryPrice: number;
	qty: number;
	stopLoss: number;
	takeProfit: number;
	entryTime: number;
	riskAmount: number;
	/** Trailing stop percentage (0 = disabled) */
	trailingStopPct: number;
	/**
	 * Trailing-stop high-water mark (long) / low-water mark (short), advanced ONLY
	 * from already-closed (prior) bars — never the same bar we trigger against.
	 * This avoids the optimistic same-candle high-set/low-fill assumption.
	 */
	trailingStopHigh: number;
	/** Maker/taker fee charged at entry (USD), already netted from equity. */
	entryFee: number;
}

interface PendingEntry {
	signal: Signal;
	/** Index of the bar that PRODUCED the signal — fill must be strictly later. */
	signalIndex: number;
	executeAtIndex: number;
	atrAtSignal: number;
}

/**
 * A market exit queued for the NEXT bar's open (symmetric with entries). Used
 * for opposing-signal closes so the exit never fills at the SIGNAL bar's own
 * close (which is computed from that bar — exit-side lookahead).
 */
interface PendingExit {
	/** Index of the signal bar that requested the close — fill must be strictly later. */
	signalIndex: number;
	executeAtIndex: number;
}

export class Backtester {
	private config: BacktestConfig;

	constructor(config: Partial<BacktestConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Run a strategy against historical candles and return performance results.
	 * Candles must be sorted ascending by openTime.
	 */
	run(strategy: Strategy, candles: Candle[]): BacktestResult {
		if (candles.length < strategy.minCandles) {
			return emptyResult(strategy, candles, this.config);
		}

		const riskPct = this.config.riskPerTradePct ?? strategy.riskParams.riskPerTradePct;
		// Slippage floor: never model slippage more optimistically than paper (5 bps).
		const requestedSlippageBps = (this.config.slippagePct ?? 0.05) * 100;
		const slippageBps = Math.max(MIN_SLIPPAGE_BPS, requestedSlippageBps);
		const slippage = slippageBps / 10_000;
		// Execution delay floor: never fill on the signal bar (lookahead leak).
		const executionDelayBars = Math.max(
			MIN_EXECUTION_DELAY_BARS,
			Math.floor(this.config.executionDelayBars ?? MIN_EXECUTION_DELAY_BARS),
		);
		// Maker/taker fee rates keyed on order type, using the SAME schedule the
		// live path uses (computeTradeCost / resolveFeeRate / fee-schedule.ts).
		// The ENTRY uses the configured fill type (maker for post-only/limit, taker
		// for market). All MARKET-style EXITS (stop-loss, trailing, opposing-signal
		// close, end-of-data) are charged the TAKER rate — they cross the book live.
		const fillType: BacktestFillType = this.config.fillType ?? "maker";
		const orderType: "MARKET" | "LIMIT" = fillType === "maker" ? "LIMIT" : "MARKET";
		const schedules = this.config.feeSchedule ?? getDefaultFeeSchedules();
		const venue = resolveVenue(candles[0]?.symbol ?? "");
		// `feeRate` is the ENTRY rate (echoed onto the result for parity audit).
		const feeRate = resolveFeeRate(venue, orderType, schedules);
		const entryFeeRate = feeRate;
		const exitTakerRate = resolveFeeRate(venue, "MARKET", schedules);

		let equity = this.config.startingEquity;
		const equityCurve: number[] = [equity];
		const trades: BacktestTrade[] = [];
		let signalCount = 0;
		let position: VirtualPosition | null = null;
		let pendingEntry: PendingEntry | null = null;
		let pendingExit: PendingExit | null = null;

		// Walk through candles one at a time.
		// Use a fixed lookback window (max 200 candles) to avoid O(n^2) complexity.
		// Previously, computeIndicators was called on candles[0..i] for each bar,
		// meaning a 1000-candle backtest would compute indicators on windows of
		// size 55, 56, 57, ... 1000 — totaling ~500k indicator computations.
		// With a 200-candle cap, each computation is bounded and the total is O(n).
		const MAX_LOOKBACK = 200;

		for (let i = strategy.minCandles; i < candles.length; i++) {
			const windowStart = Math.max(0, i + 1 - MAX_LOOKBACK);
			const window = candles.slice(windowStart, i + 1);
			const current = candles[i];
			const prev = candles[i - 1];

			// (A) A queued opposing-signal exit fills at THIS (later) bar's OPEN —
			// symmetric with entries. Never the signal bar's own close (lookahead).
			if (position && pendingExit && i >= pendingExit.executeAtIndex) {
				if (i <= pendingExit.signalIndex) {
					throw new Error(
						`backtester exit-lookahead violation: executeAtIndex ${i} <= signalIndex ${pendingExit.signalIndex}`,
					);
				}
				// Market exit at the bar open + slippage + taker fee.
				const exitPrice = applySlippage(
					current.open,
					position.direction === "long" ? "sell" : "buy",
					slippage,
				);
				const pnl = realizedPnl(position, exitPrice, exitTakerRate);
				equity += pnl;
				equityCurve.push(equity);
				trades.push(makeTrade(position, current.openTime, exitPrice, pnl, "signal-exit"));
				position = null;
				pendingExit = null;
				continue;
			}

			// (B) If we have a position, check stops/TP/trailing against THIS bar.
			// Trailing advances only from the PRIOR (already-closed) bar's extreme.
			if (position) {
				const exitResult = checkExits(position, current, prev, slippage, exitTakerRate);
				if (exitResult) {
					equity += exitResult.pnl;
					equityCurve.push(equity);
					trades.push(exitResult);
					position = null;
					pendingExit = null;
					continue;
				}
			}

			// (C) Fill a pending entry at THIS (later) bar's open.
			if (!position && pendingEntry && i >= pendingEntry.executeAtIndex && equity > 0) {
				// Lookahead guard: the fill bar must be strictly later than the bar
				// that produced the signal — otherwise we'd trade on signal-bar info.
				if (i <= pendingEntry.signalIndex) {
					throw new Error(
						`backtester lookahead violation: executeAtIndex ${i} <= signalIndex ${pendingEntry.signalIndex}`,
					);
				}
				position = openVirtualPosition({
					signal: pendingEntry.signal,
					// Fill at THIS (later) bar's OPEN — never the signal bar's price.
					fillPrice: current.open,
					current,
					equity,
					riskPct,
					slippage,
					strategy,
					feeRate: entryFeeRate,
					atr: pendingEntry.atrAtSignal,
				});
				pendingEntry = null;
				if (position) {
					// NOTE: the entry fee is NOT netted from `equity` here. It is carried
					// on the position and subtracted (alongside the exit fee) by
					// realizedPnl() when the trade closes — so `trade.pnl` accounts for
					// BOTH fees and the equity-curve delta reconciles exactly with
					// performance.totalPnl (finding #6). Interim unrealized rows net the
					// entry fee explicitly (see the equityCurve.push below).
					// (D) Fill-bar exit: the SAME bar the entry fills can also stop us
					// out (an intrabar adverse move). Check this bar's own low/high
					// against the (fill-relative, re-validated) stops/TP. Trailing has
					// no prior in-trade bar yet, so it cannot advance on the fill bar.
					const fillBarExit = checkExits(position, current, current, slippage, exitTakerRate);
					if (fillBarExit) {
						equity += fillBarExit.pnl;
						equityCurve.push(equity);
						trades.push(fillBarExit);
						position = null;
						pendingExit = null;
						continue;
					}
				}
			}

			// Evaluate strategy
			const indicators = computeIndicators(window);
			const signal = strategy.evaluate(window, indicators);

			if (signal) {
				signalCount++;

				// If we have an opposing position, QUEUE its close for the next bar's
				// open (symmetric with entries) — do NOT fill at this signal bar's
				// own close (exit-side lookahead).
				if (position && position.direction !== signal.direction && !pendingExit) {
					const executeAtIndex = i + executionDelayBars;
					if (executeAtIndex < candles.length) {
						pendingExit = { signalIndex: i, executeAtIndex };
					}
					// If no later bar exists, the end-of-data close handles it below.
				}

				// Open new position if we're flat (and not already closing). The entry
				// is queued for a later bar's open (executionDelayBars >= 1).
				if (!position && !pendingEntry && !pendingExit && equity > 0) {
					const atrValues = indicators.atr;
					const currentAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : current.close * 0.02;
					const executeAtIndex = i + executionDelayBars;
					// Only queue if a later bar actually exists to fill against.
					if (executeAtIndex < candles.length) {
						pendingEntry = {
							signal,
							signalIndex: i,
							executeAtIndex,
							atrAtSignal: currentAtr,
						};
					}
				}
			}

			// Interim mark-to-market: net the already-incurred entry fee so open-position
			// rows aren't optimistic (realized rows net both fees via realizedPnl).
			equityCurve.push(
				equity + (position ? unrealizedPnl(position, current.close) - position.entryFee : 0),
			);
		}

		// Close any remaining position at end of data. This is a forced MARKET exit,
		// so it pays slippage + the taker fee (no free, frictionless final close).
		if (position && candles.length > 0) {
			const lastCandle = candles[candles.length - 1];
			const exitPrice = applySlippage(
				lastCandle.close,
				position.direction === "long" ? "sell" : "buy",
				slippage,
			);
			const pnl = realizedPnl(position, exitPrice, exitTakerRate);
			equity += pnl;
			equityCurve.push(equity);
			trades.push(makeTrade(position, lastCandle.openTime, exitPrice, pnl, "end-of-data"));
		}

		const performance = calculatePerformance(trades, equityCurve);

		return {
			strategy: strategy.name,
			symbol: candles[0]?.symbol ?? "UNKNOWN",
			timeframe: strategy.timeframe,
			candlesUsed: candles.length,
			startDate: candles[0] ? new Date(candles[0].openTime).toISOString() : "",
			endDate: candles.length > 0 ? new Date(candles[candles.length - 1].openTime).toISOString() : "",
			// Echo the EFFECTIVE cost config (after flooring/derivation) so a
			// downstream scorecard can audit backtest↔live parity.
			config: {
				...this.config,
				feeRate,
				slippageBps,
				executionDelayBars,
				fillType,
			},
			performance,
			trades,
			equityCurve,
			signals: signalCount,
		};
	}
}

/**
 * Check stop-loss / take-profit / trailing stop against `candle`. All exits here
 * are MARKET-style and pay the TAKER fee (`takerRate`).
 *
 * Intrabar honesty rules applied:
 *  - Gap-through (#4): if the bar OPENS beyond the stop/TP, the realistic fill is
 *    the OPEN (the worse price), not the level itself.
 *  - Trailing (#5): the high/low-water mark advances ONLY from the PRIOR bar's
 *    extreme (`prevBar`), so we never use the same candle's high to both set and
 *    trigger the trail. Trigger uses the current bar's low/high.
 *
 * `prevBar` is the bar BEFORE `candle` in the walk (or `candle` itself on the
 * fill bar, where there is no prior in-trade bar — trailing simply can't advance).
 */
function checkExits(
	pos: VirtualPosition,
	candle: Candle,
	prevBar: Candle,
	slippage: number,
	takerRate: number,
): BacktestTrade | null {
	if (pos.direction === "long") {
		// Stop-loss: triggered on the candle low. If the bar OPENS at/below the stop
		// it gapped through — fill at the (worse) open, not the stop level.
		if (candle.low <= pos.stopLoss) {
			const base = candle.open <= pos.stopLoss ? candle.open : pos.stopLoss;
			const exitPrice = applySlippage(base, "sell", slippage);
			const pnl = realizedPnl(pos, exitPrice, takerRate);
			return makeTrade(pos, candle.openTime, exitPrice, pnl, "stop-loss");
		}
		// Take-profit on the candle high. If the bar OPENS at/above TP it gapped in
		// our favor — but don't hand a BETTER-than-open fill: cap at the open.
		if (candle.high >= pos.takeProfit) {
			const base = candle.open >= pos.takeProfit ? candle.open : pos.takeProfit;
			const exitPrice = applySlippage(base, "sell", slippage);
			const pnl = realizedPnl(pos, exitPrice, takerRate);
			return makeTrade(pos, candle.openTime, exitPrice, pnl, "take-profit");
		}

		// Trailing stop: advance the high-water mark from the PRIOR (closed) bar's
		// high only, then trigger against THIS bar's low.
		if (pos.trailingStopPct > 0) {
			if (prevBar !== candle && prevBar.high > pos.trailingStopHigh) {
				pos.trailingStopHigh = prevBar.high;
			}
			const trailingStopPrice = pos.trailingStopHigh * (1 - pos.trailingStopPct / 100);
			if (candle.low <= trailingStopPrice && trailingStopPrice > pos.stopLoss) {
				const base = candle.open <= trailingStopPrice ? candle.open : trailingStopPrice;
				const exitPrice = applySlippage(base, "sell", slippage);
				const pnl = realizedPnl(pos, exitPrice, takerRate);
				return makeTrade(pos, candle.openTime, exitPrice, pnl, "stop-loss");
			}
		}
	} else {
		// Short: stop-loss on high, take-profit on low.
		if (candle.high >= pos.stopLoss) {
			const base = candle.open >= pos.stopLoss ? candle.open : pos.stopLoss;
			const exitPrice = applySlippage(base, "buy", slippage);
			const pnl = realizedPnl(pos, exitPrice, takerRate);
			return makeTrade(pos, candle.openTime, exitPrice, pnl, "stop-loss");
		}
		if (candle.low <= pos.takeProfit) {
			const base = candle.open <= pos.takeProfit ? candle.open : pos.takeProfit;
			const exitPrice = applySlippage(base, "buy", slippage);
			const pnl = realizedPnl(pos, exitPrice, takerRate);
			return makeTrade(pos, candle.openTime, exitPrice, pnl, "take-profit");
		}

		// Trailing stop for shorts — track the lowest price from PRIOR bars only.
		if (pos.trailingStopPct > 0) {
			if (prevBar !== candle && prevBar.low < pos.trailingStopHigh) {
				pos.trailingStopHigh = prevBar.low;
			}
			const trailingStopPrice = pos.trailingStopHigh * (1 + pos.trailingStopPct / 100);
			if (candle.high >= trailingStopPrice && trailingStopPrice < pos.stopLoss) {
				const base = candle.open >= trailingStopPrice ? candle.open : trailingStopPrice;
				const exitPrice = applySlippage(base, "buy", slippage);
				const pnl = realizedPnl(pos, exitPrice, takerRate);
				return makeTrade(pos, candle.openTime, exitPrice, pnl, "stop-loss");
			}
		}
	}
	return null;
}

function calculatePnl(pos: VirtualPosition, exitPrice: number): number {
	return pos.direction === "long"
		? (exitPrice - pos.entryPrice) * pos.qty
		: (pos.entryPrice - exitPrice) * pos.qty;
}

/**
 * Realized PnL for a closed trade, netting BOTH the exit fee (charged here at
 * `exitFeeRate`) AND the entry fee (already paid at open). Recording the entry
 * fee on the trade keeps `performance.totalPnl` reconciled with the equity-curve
 * delta — the equity curve nets the entry fee at open, so the trade record must
 * too (otherwise totalPnl overstates by the entry fee). See finding #6.
 */
function realizedPnl(pos: VirtualPosition, exitPrice: number, exitFeeRate: number): number {
	const gross = calculatePnl(pos, exitPrice);
	const exitFee = exitFeeRate * pos.qty * exitPrice;
	return gross - exitFee - pos.entryFee;
}

function makeTrade(
	pos: VirtualPosition,
	exitTime: number,
	exitPrice: number,
	pnl: number,
	exitReason: BacktestTrade["exitReason"],
): BacktestTrade {
	return {
		entryTime: pos.entryTime,
		exitTime,
		direction: pos.direction,
		entryPrice: pos.entryPrice,
		exitPrice,
		qty: pos.qty,
		pnl,
		rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
		exitReason,
	};
}

function unrealizedPnl(pos: VirtualPosition, currentPrice: number): number {
	return pos.direction === "long"
		? (currentPrice - pos.entryPrice) * pos.qty
		: (pos.entryPrice - currentPrice) * pos.qty;
}

function applySlippage(price: number, side: "buy" | "sell", slippagePct: number): number {
	const bps = slippagePct * 10_000;
	const normalizedSide = side === "buy" ? "BUY" as const : "SELL" as const;
	return sharedApplySlippage(price, normalizedSide, bps);
}

function openVirtualPosition(input: {
	signal: Signal;
	/**
	 * The price the order actually fills at — the OPEN of a bar strictly later
	 * than the signal bar. NEVER the signal's own entryPrice/close (lookahead).
	 */
	fillPrice: number;
	current: Candle;
	equity: number;
	riskPct: number;
	slippage: number;
	strategy: Strategy;
	feeRate: number;
	atr: number;
}): (VirtualPosition & { entryFee: number }) | null {
	const { signal, fillPrice, current, equity, riskPct, slippage, strategy, feeRate, atr } = input;
	// Fill at the later bar's open + slippage — the honest, executable price.
	const entryPrice = applySlippage(
		fillPrice,
		signal.direction === "long" ? "buy" : "sell",
		slippage,
	);
	const isLong = signal.direction === "long";
	// ATR-derived fallback stop distance, anchored to the ACTUAL fill price.
	const atrStop = isLong
		? entryPrice - atr * strategy.riskParams.stopLossAtrMultiplier
		: entryPrice + atr * strategy.riskParams.stopLossAtrMultiplier;
	// Finding #3 — gapped-fill stop re-validation: the signal's stop was computed
	// from the signal-bar close, but the entry filled at a (possibly gapped) later
	// open. A stale stop on the PROFITABLE side of entry (long: stop >= entry;
	// short: stop <= entry) would let us "stop-loss" for a PROFIT. If the supplied
	// stop is invalid relative to the fill, re-derive it from the fill price using
	// the strategy's ATR risk params.
	let stopLoss: number;
	if (signal.stopLoss !== undefined) {
		const valid = isLong ? signal.stopLoss < entryPrice : signal.stopLoss > entryPrice;
		stopLoss = valid ? signal.stopLoss : atrStop;
	} else {
		stopLoss = atrStop;
	}
	const riskDistance = Math.abs(entryPrice - stopLoss);
	if (riskDistance <= 0) return null;
	const riskAmount = equity * (riskPct / 100);
	let qty = riskAmount / riskDistance;
	const maxQty = (equity * 0.1) / entryPrice;
	if (qty > maxQty) qty = maxQty;
	// Take-profit re-validation (symmetric): the TP must be on the favorable side
	// of the fill (long: TP > entry; short: TP < entry), else re-derive from the
	// fill price + risk distance.
	const ratioTp = isLong
		? entryPrice + riskDistance * strategy.riskParams.takeProfitRatio
		: entryPrice - riskDistance * strategy.riskParams.takeProfitRatio;
	let takeProfit: number;
	if (signal.takeProfit !== undefined) {
		const valid = isLong ? signal.takeProfit > entryPrice : signal.takeProfit < entryPrice;
		takeProfit = valid ? signal.takeProfit : ratioTp;
	} else {
		takeProfit = ratioTp;
	}
	const entryFee = feeRate * qty * entryPrice;
	return {
		direction: signal.direction,
		entryPrice,
		qty,
		stopLoss,
		takeProfit,
		entryTime: current.openTime,
		riskAmount,
		trailingStopPct: signal.trailingStopPct ?? 0,
		trailingStopHigh: entryPrice,
		entryFee,
	};
}

function emptyResult(strategy: Strategy, candles: Candle[], config: BacktestConfig): BacktestResult {
	const fillType: BacktestFillType = config.fillType ?? "maker";
	const orderType: "MARKET" | "LIMIT" = fillType === "maker" ? "LIMIT" : "MARKET";
	const schedules = config.feeSchedule ?? getDefaultFeeSchedules();
	const venue = resolveVenue(candles[0]?.symbol ?? "");
	const slippageBps = Math.max(MIN_SLIPPAGE_BPS, (config.slippagePct ?? 0.05) * 100);
	const executionDelayBars = Math.max(
		MIN_EXECUTION_DELAY_BARS,
		Math.floor(config.executionDelayBars ?? MIN_EXECUTION_DELAY_BARS),
	);
	return {
		strategy: strategy.name,
		symbol: candles[0]?.symbol ?? "UNKNOWN",
		timeframe: strategy.timeframe,
		candlesUsed: candles.length,
		startDate: candles[0] ? new Date(candles[0].openTime).toISOString() : "",
		endDate: candles.length > 0 ? new Date(candles[candles.length - 1].openTime).toISOString() : "",
		config: {
			...config,
			feeRate: resolveFeeRate(venue, orderType, schedules),
			slippageBps,
			executionDelayBars,
			fillType,
		},
		performance: calculatePerformance([], [config.startingEquity]),
		trades: [],
		equityCurve: [config.startingEquity],
		signals: 0,
	};
}
