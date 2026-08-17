import type { CryptoClient } from "../crypto-client.js";
import type { TradingStore, PositionWithStops } from "../trading-store.js";
import { PriceFreshnessGuard, StalePriceError } from "./price-freshness-guard.js";

/**
 * Minimal surface of ShadowModeExecutor that StopMonitor needs.
 * Defined as an interface to keep StopMonitor decoupled from the executor's concrete shape.
 *
 * `id` and `enteredAt` are optional so existing test mocks that only return
 * `{ symbol }` continue to compile; the time-expiry path skips entries that
 * lack either field.
 */
export interface ShadowExitFeed {
	getOpenPositions(): Array<{ symbol: string; id?: string; enteredAt?: number }>;
	updatePrice(symbol: string, currentPrice: number, slippageBps?: number): void;
	/** Optional — when present, StopMonitor will close positions that exceed shadowMaxHoldMs. */
	closeShadowPositionByTimeExpiry?: (positionId: string, exitPrice: number) => boolean;
}

export interface StopEvent {
	positionId: string;
	symbol: string;
	type: "stop-loss" | "take-profit" | "trailing-stop" | "time-expiry" | "stale-monitor";
	triggerPrice: number;
	currentPrice: number;
	side: "long" | "short";
	qty: number;
	pnl: number;
}

export interface ScaleOutMilestone {
	/** Profit % threshold to trigger scale-out (e.g., 5 = 5% profit) */
	profitPct: number;
	/** Fraction of remaining position to close at this milestone (0-1) */
	closeFraction: number;
}

export interface StopMonitorDeps {
	client: CryptoClient;
	store: TradingStore;
	onStopTriggered?: (event: StopEvent) => void;
	/** Called when a stop-loss sell fails after all retries — critical alert */
	onStopFailed?: (event: StopEvent, error: string) => void;
	/** If provided, executes sell orders on stop triggers */
	executeSell?: (symbol: string, qty: number, positionId: string) => Promise<void>;
	/**
	 * Maximum time a position can be held before automatic close (in ms).
	 * Default: 48 hours. Set to 0 to disable time-based exits.
	 */
	maxHoldMs?: number;
	/**
	 * Maximum time a SHADOW position can be held before forced close (in ms).
	 * Default: 8 hours (28800000ms) — aggressive enough to recycle the oldest
	 * shadow positions during the Phase 1 soak so the close-count clock can
	 * advance, while still giving fast strategies room to hit TP. Set to 0 to
	 * disable shadow time-based exits.
	 */
	shadowMaxHoldMs?: number;
	/**
	 * When take-profit is hit, close this fraction (0-1) and trail the rest.
	 * Default: 1.0 (close 100% at TP — legacy behavior).
	 * Set to 0.5 to close 50% at TP and move the remaining stop to breakeven.
	 */
	takeProfitCloseFraction?: number;
	/** Trailing stop % to apply to the remainder after partial TP close. Default: 3% */
	remainderTrailingPct?: number;
	/**
	 * Profit milestones at which to scale out a fraction of the position.
	 * Applied during trailing stop updates. Default: [{profitPct: 5, closeFraction: 0.3}]
	 * (close 30% of position when profit hits 5%).
	 * Set to empty array to disable scale-out.
	 */
	scaleOutMilestones?: ScaleOutMilestone[];
	/**
	 * Called after a position is successfully closed (full close, not partial TP).
	 * Provides PnL and position info so consumers (e.g., StrategyAdaptor) can
	 * update weights incrementally based on individual trade outcomes.
	 */
	onTradeClose?: (event: StopEvent & { isWin: boolean }) => void;
	/**
	 * Optional TradeJournal handle. When provided, every successful position
	 * close fires `journal.closeTradeBySymbol(symbol, side, exitPrice, exitReason)`
	 * so `strategy_trades.exitedAt + pnl` get populated for the learning loop.
	 * Without this, StrategyGrader has no closed-trade rows to grade.
	 */
	tradeJournal?: { closeTradeBySymbol: (symbol: string, direction: "long" | "short", exitPrice: number, exitReason: string) => boolean };
	/** Mark price for `solana:*` (Jupiter path); CEX symbols still use `client.getTicker`. */
	getDexUsdPrice?: (symbol: string) => Promise<number | null>;
	/** Optional freshness guard — rejects stale fallback prices in conservative mode */
	priceFreshnessGuard?: PriceFreshnessGuard;
	/**
	 * Optional ShadowModeExecutor handle. When provided, StopMonitor adds
	 * shadow-position symbols to the price-fetch set and calls
	 * `shadowModeExecutor.updatePrice(symbol, price)` on every cycle so
	 * shadow positions auto-close on SL/TP — without this, shadow positions
	 * accumulate forever because `updatePrice` would never be called.
	 */
	shadowModeExecutor?: ShadowExitFeed;
}

export class StopMonitor {
	private client: CryptoClient;
	private store: TradingStore;
	private onStopTriggered?: (event: StopEvent) => void;
	private onStopFailed?: (event: StopEvent, error: string) => void;
	private executeSell?: (symbol: string, qty: number, positionId: string) => Promise<void>;
	/** Maximum hold time before forced close. Default: 48 hours. 0 = disabled. */
	private maxHoldMs: number;
	/** Maximum hold time for shadow positions before forced close. Default: 8 hours. 0 = disabled. */
	private shadowMaxHoldMs: number;
	/** Fraction of position to close at TP (0-1). Default: 1.0 */
	private takeProfitCloseFraction: number;
	/** Trailing stop % for remainder after partial TP. Default: 3% */
	private remainderTrailingPct: number;
	/** Track positions currently being closed to prevent double-execution */
	private closingPositions = new Set<string>();
	/** Prevent concurrent checkStops() execution */
	private isChecking = false;
	/** Last known prices per symbol — fallback when live fetch fails */
	private lastKnownPrices = new Map<string, number>();
	/** Track consecutive failures per position for exponential backoff */
	private failureCounts = new Map<string, { count: number; nextRetryAt: number }>();
	/** Track consecutive price fetch failures per symbol for escalated logging */
	private priceFetchFailures = new Map<string, number>();
	/** Profit milestones for scale-out during trailing stop updates */
	private scaleOutMilestones: ScaleOutMilestone[];
	/** Track which milestones have already been hit per position to avoid double-scaling */
	private scaledOutMilestones = new Map<string, Set<number>>();
	/** Callback fired after a position is fully closed — for event-driven strategy adaptation */
	private onTradeClose?: (event: StopEvent & { isWin: boolean }) => void;
	/** Optional journal handle — closes the matching strategy_trades row on every successful close. */
	private tradeJournal?: { closeTradeBySymbol: (symbol: string, direction: "long" | "short", exitPrice: number, exitReason: string) => boolean };
	private getDexUsdPrice?: (symbol: string) => Promise<number | null>;
	/** Optional freshness guard for fallback prices */
	private priceFreshnessGuard?: PriceFreshnessGuard;
	/** Optional shadow-mode executor — drives shadow exits via the same price feed as real positions */
	private shadowModeExecutor?: ShadowExitFeed;
	/** Timestamp of last successful price fetch per symbol */
	private lastPriceFetchTime = new Map<string, number>();
	/** Number of consecutive checkStops() calls skipped due to isChecking guard */
	private consecutiveSkips = 0;
	/** Timestamp (ms) of last successful checkStops() completion */
	lastCheckAt = 0;

	constructor(deps: StopMonitorDeps) {
		this.client = deps.client;
		this.store = deps.store;
		this.onStopTriggered = deps.onStopTriggered;
		this.onStopFailed = deps.onStopFailed;
		this.executeSell = deps.executeSell;
		this.maxHoldMs = deps.maxHoldMs ?? 48 * 60 * 60 * 1000; // Default: 48 hours
		this.shadowMaxHoldMs = deps.shadowMaxHoldMs ?? 8 * 60 * 60 * 1000; // Default: 8 hours
		this.takeProfitCloseFraction = deps.takeProfitCloseFraction ?? 1.0;
		this.remainderTrailingPct = deps.remainderTrailingPct ?? 3;
		this.scaleOutMilestones = deps.scaleOutMilestones ?? [{ profitPct: 5, closeFraction: 0.3 }];
		this.onTradeClose = deps.onTradeClose;
		this.tradeJournal = deps.tradeJournal;
		this.getDexUsdPrice = deps.getDexUsdPrice;
		this.priceFreshnessGuard = deps.priceFreshnessGuard;
		this.shadowModeExecutor = deps.shadowModeExecutor;

		// Restore milestone state from database to survive process restarts.
		// Without this, milestones would re-fire after a crash, causing double-scaling.
		if (typeof this.store.getAllOpenMilestoneHits === "function") {
			this.scaledOutMilestones = this.store.getAllOpenMilestoneHits();
		}
	}

	/**
	 * Late-bind the shadow-mode executor. ShadowModeExecutor is constructed
	 * after StopMonitor in the boot sequence, so this setter lets the wiring
	 * happen once both objects exist.
	 */
	setShadowModeExecutor(executor: ShadowExitFeed | undefined): void {
		this.shadowModeExecutor = executor;
	}

	/**
	 * Check all open positions against stops and time expiry.
	 * Returns triggered stop events.
	 * Skips execution if already running (prevents race conditions).
	 */
	async checkStops(): Promise<StopEvent[]> {
		if (this.isChecking) {
			this.consecutiveSkips++;
			if (this.consecutiveSkips >= 3 && this.onStopTriggered) {
				this.onStopTriggered({
					positionId: "system",
					symbol: "MONITOR",
					type: "stale-monitor" as StopEvent["type"],
					triggerPrice: 0,
					currentPrice: 0,
					side: "long",
					qty: 0,
					pnl: 0,
				});
			}
			return [];
		}

		this.isChecking = true;
		try {
			const events = await this.performCheckStops();
			this.consecutiveSkips = 0;
			this.lastCheckAt = Date.now();
			return events;
		} finally {
			this.isChecking = false;
		}
	}

	private async performCheckStops(): Promise<StopEvent[]> {
		const positions = this.store.getPositionsWithStops();

		// Also check for time-expired positions that may not have stops set
		let allPositions: PositionWithStops[] = positions;
		if (this.maxHoldMs > 0 && typeof this.store.getOpenPositions === "function") {
			const allOpen = this.store.getOpenPositions();
			const positionIds = new Set(positions.map(p => p.id));
			const now = Date.now();
			for (const pos of allOpen) {
				if (!positionIds.has(pos.id)) {
					const openedAtMs = new Date(pos.openedAt).getTime();
					const age = Number.isNaN(openedAtMs) ? 0 : now - openedAtMs;
					if (age >= this.maxHoldMs) {
						allPositions = [...allPositions, { ...pos, stopLoss: null, takeProfit: null, trailingStopPct: null, trailingStopHigh: null }];
					}
				}
			}
		}

		// Collect symbols from shadow positions so they get the same price-fetch
		// pass as real positions. Without this, shadow-only symbols never get a
		// current price and shadow stops never trigger.
		const shadowSymbols = new Set<string>();
		if (this.shadowModeExecutor) {
			for (const pos of this.shadowModeExecutor.getOpenPositions()) {
				shadowSymbols.add(pos.symbol);
			}
		}

		if (allPositions.length === 0 && shadowSymbols.size === 0) return [];

		// Count shadow positions for diagnostics. Without this, a log that says
		// "Checking 0 position(s) across 0 symbol(s)" looks like the monitor is
		// idle — when in reality it's actively driving shadow exits. That
		// misleading log triggered a wrong-root-cause investigation in May 2026.
		const shadowPositionCount = this.shadowModeExecutor
			? this.shadowModeExecutor.getOpenPositions().length
			: 0;
		console.log(
			`[stop-monitor] Checking ${allPositions.length} real position(s) across ${new Set(allPositions.map(p => p.symbol)).size} symbol(s)` +
			(shadowPositionCount > 0 || shadowSymbols.size > 0
				? ` + ${shadowPositionCount} shadow position(s) across ${shadowSymbols.size} symbol(s)`
				: ""),
		);

		const events: StopEvent[] = [];

		// Group by symbol to minimize API calls
		const bySymbol = new Map<string, PositionWithStops[]>();
		for (const pos of allPositions) {
			const list = bySymbol.get(pos.symbol) || [];
			list.push(pos);
			bySymbol.set(pos.symbol, list);
		}

		// Ensure shadow-only symbols are in the price-fetch set even if they
		// have no real positions attached.
		for (const symbol of shadowSymbols) {
			if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
		}

		// Fetch all symbol prices concurrently (with per-symbol retry + fallback)
		const priceResults = await Promise.allSettled(
			Array.from(bySymbol.keys()).map(async (symbol) => {
				if (this.getDexUsdPrice && symbol.toLowerCase().startsWith("solana:")) {
					try {
						const dexPx = await this.getDexUsdPrice(symbol);
						if (dexPx != null && Number.isFinite(dexPx) && dexPx > 0) {
							this.lastKnownPrices.set(symbol, dexPx);
							this.lastPriceFetchTime.set(symbol, Date.now());
							this.priceFetchFailures.delete(symbol);
							return { symbol, price: dexPx, ok: true as const };
						}
					} catch {
						// fall through to CEX ticker
					}
				}
				for (let attempt = 1; attempt <= 3; attempt++) {
					try {
						const ticker = await this.client.getTicker(symbol);
						this.lastKnownPrices.set(symbol, ticker.last);
						this.lastPriceFetchTime.set(symbol, Date.now());
						this.priceFetchFailures.delete(symbol);
						return { symbol, price: ticker.last, ok: true as const };
					} catch (err) {
						if (attempt < 3) {
							await new Promise((r) => setTimeout(r, 300 * attempt));
						} else {
							const fallback = this.lastKnownPrices.get(symbol);
							const failCount = (this.priceFetchFailures.get(symbol) ?? 0) + 1;
							this.priceFetchFailures.set(symbol, failCount);

							// Check freshness of fallback price if guard is configured
							if (fallback && this.priceFreshnessGuard) {
								const fetchTime = this.lastPriceFetchTime.get(symbol) ?? 0;
								try {
									this.priceFreshnessGuard.check(symbol, { price: fallback, timestamp: fetchTime });
								} catch (freshErr) {
									if (freshErr instanceof StalePriceError) {
										console.warn(`[stop-monitor] Skipping ${symbol}: fallback price too stale (age: ${freshErr.ageMs}ms, max: ${freshErr.maxAgeMs}ms)`);
										for (const pos of bySymbol.get(symbol) ?? []) {
											this.onStopFailed?.(
												{ positionId: pos.id, symbol, type: "stop-loss", triggerPrice: 0, currentPrice: 0, side: pos.side, qty: pos.qty, pnl: 0 },
												`Fallback price for ${symbol} is stale (${freshErr.ageMs}ms old, max ${freshErr.maxAgeMs}ms) — skipping stop evaluation`,
											);
										}
										return { symbol, price: 0, ok: false as const };
									}
								}
							}

							// Rate-limit thrash when a shadow/real symbol stays offline for a long outage.
							// Live 2026-07-27: SOL_USDT shadow + dead CEX ticker logged every ~1m to
							// daemon-error (consecutive 75+) and re-fired onStopFailed each cycle.
							// Log + alert on first 3 fails, then every 15th; stop eval still uses stale.
							const shouldReportOutage = failCount <= 3 || failCount % 15 === 0;
							if (fallback && shouldReportOutage) {
								const logFn = failCount > 3 ? console.error : console.warn;
								logFn(`[stop-monitor] Using stale price for ${symbol}: $${fallback} (live fetch failed 3x, consecutive: ${failCount})`);
							}
							if (shouldReportOutage) {
								for (const pos of bySymbol.get(symbol) ?? []) {
									this.onStopFailed?.(
										{ positionId: pos.id, symbol, type: "stop-loss", triggerPrice: 0, currentPrice: fallback ?? 0, side: pos.side, qty: pos.qty, pnl: 0 },
										`Price fetch failed for ${symbol} after 3 attempts${fallback ? " (using stale price)" : ""}: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
							}
							return fallback
								? { symbol, price: fallback, ok: true as const }
								: { symbol, price: 0, ok: false as const };
						}
					}
				}
				return { symbol, price: 0, ok: false as const }; // unreachable but satisfies TS
			}),
		);

		// Build price map from concurrent results
		const symbolPrices = new Map<string, number>();
		for (const result of priceResults) {
			if (result.status === "fulfilled" && result.value.ok) {
				symbolPrices.set(result.value.symbol, result.value.price);
			}
		}

		// Drive shadow exits from the same price feed. Shadow positions only
		// auto-close when `updatePrice` is called — without this loop, the
		// 50+ shadow positions accumulate forever even with SL/TP set.
		if (this.shadowModeExecutor) {
			for (const symbol of shadowSymbols) {
				const price = symbolPrices.get(symbol);
				if (!price) continue;
				try {
					this.shadowModeExecutor.updatePrice(symbol, price);
				} catch (err) {
					console.warn(
						`[stop-monitor] shadow updatePrice failed for ${symbol}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}

			// Force-close shadow positions that exceeded shadowMaxHoldMs. Without
			// this, shadow positions whose SL/TP never trigger linger for days and
			// the close-count clock for the Phase 1 soak never advances. Always
			// re-fetch open positions after the updatePrice loop so we don't try
			// to expire something that just closed via SL/TP.
			if (
				this.shadowMaxHoldMs > 0 &&
				typeof this.shadowModeExecutor.closeShadowPositionByTimeExpiry === "function"
			) {
				const closeFn = this.shadowModeExecutor.closeShadowPositionByTimeExpiry.bind(
					this.shadowModeExecutor,
				);
				const now = Date.now();
				const remaining = this.shadowModeExecutor.getOpenPositions();
				for (const pos of remaining) {
					if (!pos.id || !pos.enteredAt) continue;
					const age = now - pos.enteredAt;
					if (age < this.shadowMaxHoldMs) continue;
					const price = symbolPrices.get(pos.symbol);
					if (!price || price <= 0) continue;
					try {
						closeFn(pos.id, price);
						console.log(
							`[stop-monitor] shadow time-expiry: closed ${pos.id} ${pos.symbol} ` +
							`(age=${Math.round(age / 60000)}min, max=${Math.round(this.shadowMaxHoldMs / 60000)}min) @ $${price}`,
						);
					} catch (err) {
						console.warn(
							`[stop-monitor] shadow time-expiry close failed for ${pos.symbol}:`,
							err instanceof Error ? err.message : err,
						);
					}
				}
			}
		}

		for (const [symbol, symbolPositions] of bySymbol) {
			if (symbolPositions.length === 0) continue; // shadow-only symbol — already handled above
			const currentPrice = symbolPrices.get(symbol);
			if (!currentPrice) continue;

			for (const pos of symbolPositions) {
				// Prevent double-execution if this position is already being closed
				if (this.closingPositions.has(pos.id)) continue;

				// Exponential backoff: skip if previous close attempts failed recently
				const failInfo = this.failureCounts.get(pos.id);
				if (failInfo && Date.now() < failInfo.nextRetryAt) continue;

				// Update live price and unrealized P&L on the position so the
				// dashboard always shows fresh values — not stale 0.00s.
				const unrealizedPnl = pos.side === "long"
					? (currentPrice - pos.entryPrice) * pos.qty
					: (pos.entryPrice - currentPrice) * pos.qty;
				try {
					this.store.updatePositionPrice(pos.id, currentPrice, unrealizedPnl);
				} catch (err) {
					console.debug("[stop-monitor] price update failed for", pos.symbol, err instanceof Error ? err.message : err);
				}

				// Check price-based stops first
				let event = this.evaluatePosition(pos, currentPrice);

				// Check time-based expiry if no price-based stop triggered
				if (!event && this.maxHoldMs > 0) {
					const openedAtMs = new Date(pos.openedAt).getTime();
				const age = Number.isNaN(openedAtMs) ? 0 : Date.now() - openedAtMs;
					if (age >= this.maxHoldMs) {
						const pnl = pos.side === "long"
							? (currentPrice - pos.entryPrice) * pos.qty
							: (pos.entryPrice - currentPrice) * pos.qty;
						event = {
							positionId: pos.id,
							symbol: pos.symbol,
							type: "time-expiry",
							triggerPrice: pos.entryPrice,
							currentPrice,
							side: pos.side,
							qty: pos.qty,
							pnl,
						};
					}
				}

				if (event) {
					events.push(event);
					console.log(
						`[stop-monitor] Stop armed for execution: symbol=${event.symbol} type=${event.type} ` +
						`positionId=${event.positionId} qty=${event.qty} triggerPrice=$${event.triggerPrice} currentPrice=$${event.currentPrice}`,
					);
					this.onStopTriggered?.(event);

					// Determine sell quantity — partial close on take-profit
					const isPartialTP = event.type === "take-profit"
						&& this.takeProfitCloseFraction > 0
						&& this.takeProfitCloseFraction < 1;
					const sellQty = isPartialTP
						? Math.max(pos.qty * this.takeProfitCloseFraction, 1e-8)
						: pos.qty;

					this.closingPositions.add(pos.id);

					// Execute sell with retry — stop-loss execution is critical
					let success = false;
					let alreadyClosed = false; // Track if position was closed by another caller
					const maxRetries = 3;
					const SELL_TIMEOUT_MS = 30_000; // 30s per attempt; prevents permanent lock if exchange hangs
					for (let attempt = 1; attempt <= maxRetries; attempt++) {
						try {
							// Default to paper when isPaper is undefined — never risk a live order
							// for a position whose mode is unknown
							const isPaper = pos.isPaper === true || (pos as { isPaper?: boolean | number }).isPaper === 1
								|| pos.isPaper === undefined;
							if (!isPaper && this.executeSell) {
								await Promise.race([
									this.executeSell(pos.symbol, sellQty, pos.id),
									new Promise<never>((_, reject) =>
										setTimeout(() => reject(new Error(`executeSell timed out after ${SELL_TIMEOUT_MS}ms`)), SELL_TIMEOUT_MS),
									),
								]);
							} else {
								const closeFeeRate = isPaper ? 0 : Number(this.store.getSetting("fee_rate") || "0.00075");
								let closeResult: unknown;
								if (isPartialTP && typeof this.store.closePartial === "function") {
									closeResult = this.store.closePartial(pos.id, sellQty, currentPrice);
								} else {
									closeResult = this.store.closePosition(pos.id, currentPrice, closeFeeRate);
								}
								// closePosition/closePartial return null when position is
								// already closed — another caller (manual close, concurrent
								// stop) beat us to it. Stop retrying; this is a no-op, not
								// a failure. P&L was already calculated by the first closer.
								if (closeResult === null) {
									console.warn(
										`[stop-monitor] Position ${pos.id} (${pos.symbol}) already closed by another caller — skipping`,
									);
									alreadyClosed = true;
									success = true;
									break;
								}
							}
							success = true;

							// After partial TP close, move stop to breakeven + enable trailing on remainder
							if (isPartialTP) {
								try {
									// Move stop-loss to breakeven (entry price) — locked in profit
									this.store.updateStopLoss(pos.id, pos.entryPrice);
									// Enable trailing stop on the remainder
									this.store.updateTrailingStop(pos.id, this.remainderTrailingPct, currentPrice);
								} catch (err) {
									console.warn("[stop-monitor] post-partial-close update failed for", pos.symbol, err instanceof Error ? err.message : err);
								}
							}
							break;
						} catch (err) {
							if (attempt < maxRetries) {
								console.warn(
									`[stop-monitor] Sell attempt ${attempt}/${maxRetries} failed for ${pos.symbol}: ` +
									`${err instanceof Error ? err.message : String(err)} — retrying`,
								);
								// Exponential backoff: 500ms, 1s, 2s
								await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
							} else {
								// All retries exhausted — this is a CRITICAL failure
								console.error(
									`[stop-monitor] CRITICAL: Sell FAILED after ${maxRetries} attempts for ${pos.symbol} ` +
									`positionId=${pos.id}: ${err instanceof Error ? err.message : String(err)}`,
								);
								this.onStopFailed?.(
									event,
									`Stop-loss sell FAILED after ${maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
					}

					// Always release the closing lock so the position can be
					// retried on the next monitoring cycle. Without this, a failed
					// stop-sell permanently orphans the position in closingPositions.
					this.closingPositions.delete(pos.id);

					if (success) {
						this.failureCounts.delete(pos.id);
						// Skip journal + callback side-effects if the position was
						// already closed by another caller — P&L is already recorded,
						// firing these again would corrupt records or double-count.
						if (!alreadyClosed) {
							// Close the matching strategy_trades row so StrategyGrader can
							// score this outcome. Without this hop, exitedAt + pnl never get
							// populated for stop-driven exits and the learning loop is blind.
							// Only fires on full close — partial TPs continue holding the open trade.
							if (!isPartialTP && this.tradeJournal) {
								try {
									this.tradeJournal.closeTradeBySymbol(pos.symbol, pos.side, currentPrice, event.type);
								} catch (err) {
									// Raised from console.debug → console.error: when this throws,
									// the matching strategy_trades row never gets exitedAt/pnl and
									// StrategyGrader cannot score the outcome. Silent failure was
									// blinding the learning loop (see memory: reference_strategy_trades_db).
									console.error(
										"[stop-monitor] strategy_trades close FAILED — learning loop blind for",
										pos.symbol,
										pos.side,
										err instanceof Error ? err.message : err,
									);
									this.onStopFailed?.(event, `strategy_trades.close_failed: ${err instanceof Error ? err.message : String(err)}`);
								}
							}
							// Fire trade close callback for event-driven strategy adaptation.
							// Only fires on full close (not partial TP) so the adaptor gets
							// the final trade outcome, not intermediate partial-close noise.
							if (!isPartialTP && this.onTradeClose) {
								try {
									this.onTradeClose({ ...event, isWin: event.pnl > 0 });
								} catch (err) {
									console.debug("[stop-monitor] onTradeClose callback error:", err instanceof Error ? err.message : err);
								}
							}
						}
					} else {
						// Track failure count for logging/alerting, but do NOT block
						// the next cycle from retrying. Each cycle already has its own
						// 3-attempt retry with exponential backoff -- inter-cycle backoff
						// would leave positions unprotected for 30s+ if the exchange
						// recovers between cycles.
						const prev = this.failureCounts.get(pos.id);
						const failCount = (prev?.count ?? 0) + 1;
						this.failureCounts.set(pos.id, { count: failCount, nextRetryAt: 0 });
					}
				} else if (pos.trailingStopPct && pos.trailingStopPct > 0) {
					// Update trailing stop high-water mark
					this.updateTrailingStop(pos, currentPrice);
					// Scale out at profit milestones — lock in partial gains while letting the rest ride
					await this.checkScaleOut(pos, currentPrice);
				}
			}
		}

		return events;
	}

	private evaluatePosition(pos: PositionWithStops, currentPrice: number): StopEvent | null {
		const pnl = pos.side === "long"
			? (currentPrice - pos.entryPrice) * pos.qty
			: (pos.entryPrice - currentPrice) * pos.qty;

		// Check stop-loss
		if (pos.stopLoss != null) {
			const hit = pos.side === "long"
				? currentPrice <= pos.stopLoss
				: currentPrice >= pos.stopLoss;

			if (hit) {
				console.log(
					`[stop-monitor] Stop-loss TRIGGERED: symbol=${pos.symbol} positionId=${pos.id} ` +
					`side=${pos.side} currentPrice=$${currentPrice} stopPrice=$${pos.stopLoss} pnl=$${pnl.toFixed(2)}`,
				);
				return {
					positionId: pos.id,
					symbol: pos.symbol,
					type: "stop-loss",
					triggerPrice: pos.stopLoss,
					currentPrice,
					side: pos.side,
					qty: pos.qty,
					pnl,
				};
			}
		}

		// Check take-profit
		if (pos.takeProfit != null) {
			const hit = pos.side === "long"
				? currentPrice >= pos.takeProfit
				: currentPrice <= pos.takeProfit;

			if (hit) {
				console.log(
					`[stop-monitor] Take-profit TRIGGERED: symbol=${pos.symbol} positionId=${pos.id} ` +
					`side=${pos.side} currentPrice=$${currentPrice} takeProfit=$${pos.takeProfit} pnl=$${pnl.toFixed(2)}`,
				);
				return {
					positionId: pos.id,
					symbol: pos.symbol,
					type: "take-profit",
					triggerPrice: pos.takeProfit,
					currentPrice,
					side: pos.side,
					qty: pos.qty,
					pnl,
				};
			}
		}

		// Check trailing stop
		if (pos.trailingStopPct && pos.trailingStopPct > 0 && pos.trailingStopHigh) {
			const trailingStopPrice = pos.side === "long"
				? pos.trailingStopHigh * (1 - pos.trailingStopPct / 100)
				: pos.trailingStopHigh * (1 + pos.trailingStopPct / 100);

			const hit = pos.side === "long"
				? currentPrice <= trailingStopPrice
				: currentPrice >= trailingStopPrice;

			if (hit) {
				console.log(
					`[stop-monitor] Trailing-stop TRIGGERED: symbol=${pos.symbol} positionId=${pos.id} ` +
					`side=${pos.side} currentPrice=$${currentPrice} trailingStopPrice=$${trailingStopPrice.toFixed(4)} ` +
					`high=$${pos.trailingStopHigh} pct=${pos.trailingStopPct}% pnl=$${pnl.toFixed(2)}`,
				);
				return {
					positionId: pos.id,
					symbol: pos.symbol,
					type: "trailing-stop",
					triggerPrice: trailingStopPrice,
					currentPrice,
					side: pos.side,
					qty: pos.qty,
					pnl,
				};
			}
		}

		return null;
	}

	private updateTrailingStop(pos: PositionWithStops, currentPrice: number): void {
		if (!pos.trailingStopPct || pos.trailingStopPct <= 0) return;

		if (pos.side === "long") {
			// For longs, track the highest price
			if (!pos.trailingStopHigh || currentPrice > pos.trailingStopHigh) {
				console.debug(
					`[stop-monitor] Trailing-stop updated: symbol=${pos.symbol} side=long ` +
					`newHigh=$${currentPrice} prevHigh=$${pos.trailingStopHigh ?? "none"}`,
				);
				this.store.updateTrailingStopHigh(pos.id, currentPrice);
			}
		} else {
			// For shorts, track the lowest price
			if (!pos.trailingStopHigh || currentPrice < pos.trailingStopHigh) {
				console.debug(
					`[stop-monitor] Trailing-stop updated: symbol=${pos.symbol} side=short ` +
					`newLow=$${currentPrice} prevLow=$${pos.trailingStopHigh ?? "none"}`,
				);
				this.store.updateTrailingStopHigh(pos.id, currentPrice);
			}
		}
	}

	/**
	 * Scale out at profit milestones during trailing stop updates.
	 * When a position reaches a configured profit %, close a fraction to lock in gains.
	 * Each milestone fires once per position (tracked in scaledOutMilestones).
	 */
	private async checkScaleOut(pos: PositionWithStops, currentPrice: number): Promise<void> {
		if (this.scaleOutMilestones.length === 0 || pos.qty <= 0) return;
		if (this.closingPositions.has(pos.id)) return;

		const profitPct = pos.side === "long"
			? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
			: ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

		if (profitPct <= 0) return;

		const hitMilestones = this.scaledOutMilestones.get(pos.id) ?? new Set<number>();

		// Track remaining qty locally so that when multiple milestones fire in
		// one cycle (e.g., price gaps past both 5% and 10%), each subsequent
		// milestone operates on the position size AFTER prior closures.
		let remainingQty = pos.qty;

		// Sort milestones ascending so lower thresholds fire first
		const sorted = [...this.scaleOutMilestones].sort((a, b) => a.profitPct - b.profitPct);

		for (const milestone of sorted) {
			if (profitPct < milestone.profitPct) continue;
			if (hitMilestones.has(milestone.profitPct)) continue;
			if (remainingQty <= 1e-8) break;

			const scaleQty = remainingQty * milestone.closeFraction;
			if (scaleQty < 1e-8) continue;

			// Mark milestone as hit before attempting close (prevents re-entry)
			hitMilestones.add(milestone.profitPct);
			this.scaledOutMilestones.set(pos.id, hitMilestones);

			try {
				if (this.executeSell) {
					// Route through exchange execution — ensures the exchange
					// actually closes the partial position before we update local state
					await this.executeSell(pos.symbol, scaleQty, pos.id);
				}
				// Update local store after exchange confirms (or directly for paper mode)
				if (typeof this.store.closePartial === "function") {
					this.store.closePartial(pos.id, scaleQty, currentPrice);
				}

				// Persist milestone hit to database so it survives restarts
				if (typeof this.store.recordMilestoneHit === "function") {
					this.store.recordMilestoneHit(pos.id, milestone.profitPct);
				}

				// Decrement remaining qty for subsequent milestones in this cycle
				remainingQty -= scaleQty;

				// Move stop to breakeven after first scale-out to protect remaining position
				if (hitMilestones.size === 1) {
					this.store.updateStopLoss(pos.id, pos.entryPrice);
				}
				console.log(
					`[stop-monitor] Scale-out: closed ${scaleQty.toFixed(6)} of ${pos.symbol} ` +
					`at ${milestone.profitPct}% profit (${milestone.closeFraction * 100}% of remaining), ` +
					`${remainingQty.toFixed(6)} remaining`,
				);
			} catch (err) {
				// Exchange sell failed — roll back the milestone so it retries next cycle
				hitMilestones.delete(milestone.profitPct);
				console.warn(
					`[stop-monitor] Scale-out failed for ${pos.symbol}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}
}
