/**
 * Opportunity Trader — converts DEX/CEX watcher opportunities into paper trades.
 *
 * Works with ANY price source (XRPL DEX, Stellar DEX, Solana DEX, Flare DEX, CEX).
 * The watchers detect opportunities; this engine sizes positions, manages risk,
 * opens paper trades, and monitors for exits.
 *
 * Paper equity starts at $1,000 by default and compounds from there.
 */

import type { RiskManager } from "../risk/risk-manager.js";
import type { TradingStore } from "../trading-store.js";
import { AsyncMutex } from "./execution-manager.js";

/** Optional deps — `riskManager` enables `validateTrade` before paper opens. */
export interface OpportunityTraderDeps {
	riskManager?: RiskManager;
}

export type OpportunityTraderInit = Partial<OpportunityTraderConfig> & OpportunityTraderDeps;

let warnedMissingRiskManager = false;

export interface OpportunitySignal {
	source: string; // e.g., "xrpl", "stellar", "solana", "flare", "cex"
	pair: string;
	type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "buy_sell_ratio" | "depth_gap" | "liquidity_shift";
	direction: "long" | "short";
	confidence: number;
	entryPrice: number;
	description: string;
}

export interface PaperPosition {
	id: string;
	source: string;
	pair: string;
	strategyType: string;
	direction: "long" | "short";
	entryPrice: number;
	qty: number;
	currentPrice: number;
	pnl: number;
	pnlPct: number;
	stopLoss: number;
	takeProfit: number;
	openedAt: number;
	/** Max age in ms before forced exit (default: 4h for momentum, 1h for spread) */
	maxAgeMs: number;
	/** UUID returned by store.openPosition — set when the position is also
	 * persisted to the `positions` table so it can be closed via the store on
	 * exit and rehydrated after a daemon restart. Optional because in-memory-
	 * only positions (failed persist, legacy callers) still need to function. */
	dbId?: string;
	/** Signal confidence at entry time (0..1) */
	confidence?: number;
	/** Sizing multiplier applied based on confidence tier (0..1) */
	sizingMultiplier?: number;
}

/** Marker stored in `positions.executionVenue` so we can identify which open
 * paper rows belong to OpportunityTrader and rehydrate only those on restart
 * without colliding with positions opened by other engines. */
const OPP_TRADER_VENUE = "opp-trader";

/**
 * Callback fired immediately after a position is opened and persisted,
 * so consumers (e.g. StopMonitor) can pick it up without waiting for
 * the next polling tick — closing the R7 stop-loss arming gap.
 */
export interface PositionOpenedEvent {
	dbId: string;
	symbol: string;
	side: "long" | "short";
	entryPrice: number;
	qty: number;
	stopLoss: number;
	takeProfit: number;
}

export interface OpportunityTraderConfig {
	/** Starting paper equity in USD */
	startingEquity: number;
	/** Max % of equity per trade */
	maxPositionPct: number;
	/** Max open positions */
	maxPositions: number;
	/** Min confidence to trade */
	minConfidence: number;
	/** Default stop loss % */
	defaultStopPct: number;
	/** Default take profit % */
	defaultTakeProfitPct: number;
	/** Cooldown between trades on same pair (ms) */
	cooldownMs: number;
	/** Max drawdown % from peak equity before halting new trades (default: 15) */
	maxDrawdownPct: number;
	/** Max consecutive losses before halting (default: 6) */
	maxConsecutiveLosses: number;
	/**
	 * If true, a consecutive-loss halt is permanent and requires
	 * `resetCircuitBreaker()`. If false (default), the halt becomes a timed
	 * pause that auto-resumes after a cooldown that escalates with each halt.
	 */
	haltOnStreakPermanently: boolean;
	/**
	 * Escalating cooldown durations in ms, indexed by halt count.
	 * Index 0 = first halt, index 1 = second halt, etc. The last entry is
	 * reused for any subsequent halts. Default: [30 min, 2h, 6h].
	 */
	streakHaltCooldownsMs: number[];
	/**
	 * Confidence-based position-sizing tiers. Each tier specifies a minimum
	 * confidence (inclusive) and the fraction of the max position size to use.
	 * Tiers are evaluated highest minConfidence first; the first match wins.
	 * Defaults to the same tiers used by ShadowModeExecutor:
	 *   >= 0.7 → 100%, >= 0.6 → 75%, >= 0.5 → 50%, below → 0 (rejected).
	 */
	confidenceSizingTiers?: { minConfidence: number; sizePct: number }[];
	/**
	 * Called immediately after a position is opened and persisted to the
	 * trading store. Use this to notify StopMonitor so it can begin
	 * monitoring the position without waiting for the next polling cycle.
	 */
	onPositionOpened?: (event: PositionOpenedEvent) => void;
}

const DEFAULT_CONFIG: OpportunityTraderConfig = {
	startingEquity: 1000,
	maxPositionPct: 10,
	maxPositions: 8,
	minConfidence: 0.4,
	defaultStopPct: 3,
	defaultTakeProfitPct: 5,
	cooldownMs: 15 * 60 * 1000, // 15 min
	maxDrawdownPct: 15,
	maxConsecutiveLosses: 6,
	haltOnStreakPermanently: false,
	streakHaltCooldownsMs: [
		30 * 60 * 1000, // 1st halt: 30 min
		2 * 60 * 60 * 1000, // 2nd halt: 2 h
		6 * 60 * 60 * 1000, // 3rd+ halt: 6 h
	],
};

/** Snapshot of the trades that triggered a streak halt — picked up by the
 * learning system to detect regime mismatches. */
export interface StreakAnalysis {
	trippedAt: number;
	haltCount: number;
	cooldownMs: number;
	resumeAt: number;
	lossCount: number;
	losingTrades: {
		pair: string;
		source: string;
		strategyType: string;
		direction: "long" | "short";
		pnlPct: number;
		exitReason: string;
		durationMs: number;
	}[];
	byStrategy: Record<string, number>;
	bySource: Record<string, number>;
	byPair: Record<string, number>;
}

/** Strategy-specific overrides for stop/TP/timeout */
const STRATEGY_PARAMS: Record<string, { stopPct: number; tpPct: number; maxAgeMs: number }> = {
	spread_capture: { stopPct: 1.5, tpPct: 2, maxAgeMs: 60 * 60 * 1000 }, // 1h
	momentum: { stopPct: 3, tpPct: 6, maxAgeMs: 4 * 60 * 60 * 1000 }, // 4h
	imbalance: { stopPct: 2.5, tpPct: 5, maxAgeMs: 2 * 60 * 60 * 1000 }, // 2h
	volatility: { stopPct: 4, tpPct: 8, maxAgeMs: 6 * 60 * 60 * 1000 }, // 6h
	buy_sell_ratio: { stopPct: 3, tpPct: 5, maxAgeMs: 3 * 60 * 60 * 1000 }, // 3h
	depth_gap: { stopPct: 2, tpPct: 4, maxAgeMs: 1 * 60 * 60 * 1000 }, // 1h
	liquidity_shift: { stopPct: 3, tpPct: 5, maxAgeMs: 2 * 60 * 60 * 1000 }, // 2h
};

/**
 * Default confidence-based sizing tiers — matches ShadowModeExecutor:
 *   >= 0.7 → 100% of max position size
 *   >= 0.6 → 75%
 *   >= 0.5 → 50%
 *   below  → 0 (rejected by minConfidence or sizing)
 */
const DEFAULT_CONFIDENCE_SIZING_TIERS: { minConfidence: number; sizePct: number }[] = [
	{ minConfidence: 0.7, sizePct: 1.0 },
	{ minConfidence: 0.6, sizePct: 0.75 },
	{ minConfidence: 0.5, sizePct: 0.5 },
];

export class OpportunityTrader {
	private config: OpportunityTraderConfig;
	private store: TradingStore;
	private positions = new Map<string, PaperPosition>();
	private lastTradeTime = new Map<string, number>();
	private equity: number;
	private peakEquity: number;
	private totalPnl = 0;
	private closedTrades: {
		pair: string; source: string; strategyType: string;
		direction: "long" | "short"; entryPrice: number; exitPrice: number;
		pnl: number; pnlPct: number; exitReason: string; duration: number;
	}[] = [];
	private tradeCount = 0;
	private winCount = 0;
	private consecutiveLosses = 0;
	private halted = false;
	private haltReason = "";
	/** ms epoch when a streak cooldown ends; 0 means no active cooldown
	 * (i.e. either not halted or halted permanently). Mirrors the
	 * `cooldown_until` column on `circuit_breaker_state`. */
	private pausedUntil = 0;
	/** How many times the streak halt has tripped — the index into
	 * `streakHaltCooldownsMs` for cooldown escalation. Mirrors `trip_count`
	 * on the trading circuit breaker rows. */
	private haltCount = 0;
	/**
	 * Per-pair mutex that serializes evaluate() so the
	 * `positions.has(pair)` → `positions.set(pair)` window is atomic.
	 * Fixes R6 TOCTOU: two concurrent async callers can no longer both
	 * pass the has-check before either writes the position.
	 */
	private pairMutexes = new Map<string, AsyncMutex>();
	/** Callback to notify consumers (StopMonitor) the instant a position
	 * is opened — closes the R7 stop-loss arming gap. */
	private onPositionOpened?: (event: PositionOpenedEvent) => void;
	private riskManager?: RiskManager;

	constructor(store: TradingStore, init: OpportunityTraderInit = {}) {
		const { riskManager, ...config } = init;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.store = store;
		this.equity = this.config.startingEquity;
		this.peakEquity = this.equity;
		this.onPositionOpened = this.config.onPositionOpened;
		this.riskManager = riskManager;
		this.restoreHaltStateFromStore();
		this.restorePositionsFromStore();
	}

	/** Get or create a per-pair mutex for serializing position creation. */
	private getPairMutex(pair: string): AsyncMutex {
		let mx = this.pairMutexes.get(pair);
		if (!mx) {
			mx = new AsyncMutex();
			this.pairMutexes.set(pair, mx);
		}
		return mx;
	}

	/**
	 * Rebuild the in-memory positions Map from the trading store on startup.
	 * Without this, a daemon restart silently drops every in-flight practice
	 * position — `trade_log` keeps the entry row but no exit ever fires, so
	 * stop-loss / take-profit stop being enforced on those orphans.
	 *
	 * Only rows tagged `executionVenue = OPP_TRADER_VENUE` and `isPaper = 1`
	 * are pulled, so positions opened by other engines stay isolated. Strategy
	 * metadata that doesn't have a column on `positions` (source, strategyType,
	 * maxAgeMs) is round-tripped through `routeJson`.
	 */
	private restorePositionsFromStore(): void {
		try {
			const rows = this.store.getOpenPositions();
			for (const positionRow of rows) {
				// `Position` (the public type) doesn't surface every column on
				// the `positions` table — executionVenue, isPaper, stopLoss,
				// routeJson live on the row but aren't typed. Read them via
				// an index-signature view of the same row.
				const row = positionRow as unknown as Record<string, unknown>;
				if (row.executionVenue !== OPP_TRADER_VENUE) continue;
				if (Number(row.isPaper ?? 0) !== 1) continue;

				let meta: { source?: string; strategyType?: string; maxAgeMs?: number } = {};
				const routeRaw = row.routeJson;
				if (typeof routeRaw === "string" && routeRaw.length > 0) {
					try {
						meta = JSON.parse(routeRaw) as typeof meta;
					} catch {
						// Malformed routeJson — fall back to defaults below.
					}
				}

				const direction = (row.side as "long" | "short") ?? "long";
				const entryPrice = Number(row.entryPrice ?? 0);
				const qty = Number(row.qty ?? 0);
				const stopLoss = Number(row.stopLoss ?? 0);
				const takeProfit = Number(row.takeProfit ?? 0);
				const openedAtIso = String(row.openedAt ?? new Date().toISOString());
				const openedAt = Date.parse(openedAtIso);

				const restored: PaperPosition = {
					id: String(row.id),
					source: meta.source ?? "unknown",
					pair: String(row.symbol ?? ""),
					strategyType: meta.strategyType ?? "momentum",
					direction,
					entryPrice,
					qty,
					currentPrice: entryPrice,
					pnl: 0,
					pnlPct: 0,
					stopLoss,
					takeProfit,
					openedAt: Number.isFinite(openedAt) ? openedAt : Date.now(),
					maxAgeMs: meta.maxAgeMs ?? 4 * 60 * 60 * 1000,
					dbId: String(row.id),
				};

				// Defense: positions whose forced-exit deadline already elapsed
				// (because a daemon restart, missing DEX price feed, or signal-scan
				// stall meant `update()` never saw a price for this pair) get
				// auto-closed at entry price on rehydrate. Without this, a paper
				// position with a 1h maxAge can sit "open" for days, spamming
				// crash-recovery and stop-monitor with errors for an exchange that
				// doesn't list the symbol.
				if (Date.now() - restored.openedAt > restored.maxAgeMs) {
					try {
						this.store.closePosition(restored.id, restored.entryPrice);
						console.info(
							`[opportunity-trader] auto-closed stale rehydrated position ${restored.pair} ` +
								`(age=${Math.round((Date.now() - restored.openedAt) / 60000)}min > maxAge=${Math.round(restored.maxAgeMs / 60000)}min)`,
						);
					} catch (err) {
						console.debug(
							"[opportunity-trader] failed to auto-close stale rehydrated position:",
							err instanceof Error ? err.message : err,
						);
					}
					continue;
				}

				this.positions.set(restored.pair, restored);
			}
		} catch (err) {
			console.debug(
				"[opportunity-trader] could not restore positions from store:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	/**
	 * Restore halted/consecutiveLosses from the trading store settings.
	 * Without this, a daemon restart silently wipes a real 6-consecutive-
	 * losses halt and the trader resumes trading after a ~2-minute outage —
	 * which is exactly what hid the HALT seen in daemon-error.log on
	 * 2026-04-18. Cooldown halts auto-clear via `maybeAutoResume()` once
	 * `pausedUntil` elapses; permanent halts still need explicit
	 * `resetCircuitBreaker()`.
	 */
	private restoreHaltStateFromStore(): void {
		try {
			const persistedLosses = Number(this.store.getSetting("opp_trader_consecutive_losses") ?? "0");
			if (Number.isFinite(persistedLosses) && persistedLosses > 0) {
				this.consecutiveLosses = persistedLosses;
			}
			const persistedHaltCount = Number(this.store.getSetting("opp_trader_halt_count") ?? "0");
			if (Number.isFinite(persistedHaltCount) && persistedHaltCount > 0) {
				this.haltCount = persistedHaltCount;
			}
			const persistedPausedUntil = Number(this.store.getSetting("opp_trader_paused_until") ?? "0");
			if (Number.isFinite(persistedPausedUntil) && persistedPausedUntil > 0) {
				this.pausedUntil = persistedPausedUntil;
			}
			const persistedHalt = this.store.getSetting("opp_trader_halted");
			if (persistedHalt === "true") {
				this.halted = true;
				this.haltReason =
					this.store.getSetting("opp_trader_halt_reason") ??
					`Restored halt from prior run (${this.consecutiveLosses} consecutive losses)`;
			}
		} catch (err) {
			console.debug(
				"[opportunity-trader] could not restore halt state:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	private persistHaltState(): void {
		try {
			this.store.setSetting("opp_trader_consecutive_losses", String(this.consecutiveLosses));
			this.store.setSetting("opp_trader_halted", this.halted ? "true" : "false");
			this.store.setSetting("opp_trader_halt_reason", this.haltReason);
			this.store.setSetting("opp_trader_paused_until", String(this.pausedUntil));
			this.store.setSetting("opp_trader_halt_count", String(this.haltCount));
		} catch (err) {
			console.debug(
				"[opportunity-trader] could not persist halt state:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	/** Cooldown duration for the Nth halt — last entry is reused once we run
	 * past the configured ladder. */
	private cooldownForHaltCount(count: number): number {
		const ladder = this.config.streakHaltCooldownsMs;
		if (!ladder.length) return 0;
		return ladder[Math.min(count, ladder.length - 1)];
	}

	/** If a streak cooldown has elapsed, auto-resume: clear halt, reset the
	 * loss counter, and persist. Returns true if the trader was resumed. */
	private maybeAutoResume(now: number = Date.now()): boolean {
		if (!this.halted || this.pausedUntil <= 0 || now < this.pausedUntil) {
			return false;
		}
		const lastCooldownMs = this.cooldownForHaltCount(Math.max(0, this.haltCount - 1));
		console.warn(
			`[opportunity-trader] AUTO-RESUME after streak halt #${this.haltCount} (cooldown ${Math.round(lastCooldownMs / 60000)}min elapsed) — resetting consecutive-loss counter`,
		);
		this.halted = false;
		this.haltReason = "";
		this.pausedUntil = 0;
		this.consecutiveLosses = 0;
		this.persistHaltState();
		return true;
	}

	/** Compose the streak analysis snapshot from recent losing trades and
	 * persist it to settings so the learning system can detect regime
	 * mismatches (e.g. "every loss was a momentum long during ranging
	 * regime"). */
	private recordStreakAnalysis(cooldownMs: number, now: number): StreakAnalysis {
		const losingTrades = this.closedTrades
			.filter((t) => t.pnl <= 0)
			.slice(-this.consecutiveLosses)
			.map((t) => ({
				pair: t.pair,
				source: t.source,
				strategyType: t.strategyType,
				direction: t.direction,
				pnlPct: Math.round(t.pnlPct * 100) / 100,
				exitReason: t.exitReason,
				durationMs: t.duration,
			}));

		const byStrategy: Record<string, number> = {};
		const bySource: Record<string, number> = {};
		const byPair: Record<string, number> = {};
		for (const t of losingTrades) {
			byStrategy[t.strategyType] = (byStrategy[t.strategyType] ?? 0) + 1;
			bySource[t.source] = (bySource[t.source] ?? 0) + 1;
			byPair[t.pair] = (byPair[t.pair] ?? 0) + 1;
		}

		const analysis: StreakAnalysis = {
			trippedAt: now,
			haltCount: this.haltCount,
			cooldownMs,
			resumeAt: now + cooldownMs,
			lossCount: this.consecutiveLosses,
			losingTrades,
			byStrategy,
			bySource,
			byPair,
		};

		try {
			this.store.setSetting("opp_trader_streak_analysis", JSON.stringify(analysis));
		} catch (err) {
			console.debug(
				"[opportunity-trader] could not persist streak analysis:",
				err instanceof Error ? err.message : err,
			);
		}

		const topStrategy = Object.entries(byStrategy).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "n/a";
		const topPair = Object.entries(byPair).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "n/a";
		console.warn(
			`[opportunity-trader] streak analysis: ${this.consecutiveLosses} losses, top strategy=${topStrategy}, top pair=${topPair}, cooldown=${Math.round(cooldownMs / 60000)}min`,
		);
		return analysis;
	}

	/**
	 * Evaluate an opportunity and open a paper trade if it passes filters.
	 * Serialized per-pair via AsyncMutex so concurrent callers cannot
	 * double-open the same pair (R6 TOCTOU fix).
	 *
	 * Returns the paper position if opened, null if filtered out.
	 */
	evaluate(signal: OpportunitySignal): Promise<PaperPosition | null> {
		return this.getPairMutex(signal.pair).run(async () => {
			return this.evaluateInner(signal);
		});
	}

	/**
	 * Synchronous evaluate for callers that already hold the mutex or
	 * are in a context where concurrency is not possible (e.g. tests).
	 * Prefer `evaluate()` in production code.
	 */
	evaluateSync(signal: OpportunitySignal): PaperPosition | null {
		return this.evaluateInner(signal);
	}

	/**
	 * Resolve the sizing multiplier for a given confidence by walking the
	 * configured tiers (sorted descending by minConfidence). Returns a value
	 * in [0,1], or 0 when confidence falls below every tier.
	 */
	private getConfidenceSizeMultiplier(confidence: number): number {
		const tiers = [...(this.config.confidenceSizingTiers ?? DEFAULT_CONFIDENCE_SIZING_TIERS)]
			.sort((a, b) => b.minConfidence - a.minConfidence);
		for (const tier of tiers) {
			if (confidence >= tier.minConfidence) {
				return Math.max(0, Math.min(1, tier.sizePct));
			}
		}
		return 0;
	}

	/** Core evaluate logic — callers must ensure mutual exclusion per pair. */
	private evaluateInner(signal: OpportunitySignal): PaperPosition | null {
		const now = Date.now();
		// Auto-resume if a streak cooldown has elapsed; only happens when the
		// halt was a timed pause (pausedUntil > 0). Permanent halts are
		// untouched and still require resetCircuitBreaker().
		this.maybeAutoResume(now);

		// Circuit breaker: halt new trades when drawdown or consecutive losses exceed limits
		if (this.halted) return null;

		// Check drawdown from peak equity (drawdown halts are permanent —
		// equity loss of this magnitude warrants operator review, not a timed
		// pause)
		if (this.peakEquity > 0) {
			const drawdownPct = ((this.peakEquity - this.equity) / this.peakEquity) * 100;
			if (drawdownPct >= this.config.maxDrawdownPct) {
				this.halted = true;
				this.haltReason = `Drawdown ${drawdownPct.toFixed(1)}% exceeds max ${this.config.maxDrawdownPct}%`;
				this.pausedUntil = 0;
				console.warn(`[opportunity-trader] HALTED: ${this.haltReason}`);
				this.persistHaltState();
				return null;
			}
		}

		// Check consecutive losses
		if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
			this.halted = true;
			if (this.config.haltOnStreakPermanently) {
				this.haltReason = `${this.consecutiveLosses} consecutive losses (max: ${this.config.maxConsecutiveLosses}) — permanent halt, operator must reset`;
				this.pausedUntil = 0;
				console.warn(`[opportunity-trader] HALTED: ${this.haltReason}`);
			} else {
				const cooldownMs = this.cooldownForHaltCount(this.haltCount);
				this.pausedUntil = now + cooldownMs;
				this.haltCount += 1;
				this.haltReason = `${this.consecutiveLosses} consecutive losses (max: ${this.config.maxConsecutiveLosses}) — paused for ${Math.round(cooldownMs / 60000)}min, auto-resume at ${new Date(this.pausedUntil).toISOString()}`;
				console.warn(`[opportunity-trader] PAUSED: ${this.haltReason}`);
				this.recordStreakAnalysis(cooldownMs, now);
			}
			this.persistHaltState();
			return null;
		}

		// Filter: confidence
		if (signal.confidence < this.config.minConfidence) return null;

		// Filter: cooldown
		const lastTrade = this.lastTradeTime.get(signal.pair);
		if (lastTrade && Date.now() - lastTrade < this.config.cooldownMs) return null;

		// Filter: max positions
		if (this.positions.size >= this.config.maxPositions) return null;

		// Filter: already in a position for this pair
		if (this.positions.has(signal.pair)) return null;

		// Filter: price sanity
		if (!Number.isFinite(signal.entryPrice) || signal.entryPrice <= 0) return null;

		// Size the position
		const params = STRATEGY_PARAMS[signal.type] ?? {
			stopPct: this.config.defaultStopPct,
			tpPct: this.config.defaultTakeProfitPct,
			maxAgeMs: 2 * 60 * 60 * 1000,
		};

		let maxPositionValue = this.equity * (this.config.maxPositionPct / 100);
		// Clamp to max_trade_usd so equity-% sizing never exceeds the safety cap
		const maxTradeRaw = this.store.getSetting("max_trade_usd");
		if (maxTradeRaw) {
			const maxTradeUsd = Number(maxTradeRaw);
			if (Number.isFinite(maxTradeUsd) && maxTradeUsd > 0) {
				maxPositionValue = Math.min(maxPositionValue, maxTradeUsd);
			}
		}
		const sizingMultiplier = this.getConfidenceSizeMultiplier(signal.confidence);
		if (sizingMultiplier <= 0) return null;
		const qty = (maxPositionValue / signal.entryPrice) * sizingMultiplier;

		const stopLoss = signal.direction === "long"
			? signal.entryPrice * (1 - params.stopPct / 100)
			: signal.entryPrice * (1 + params.stopPct / 100);

		const takeProfit = signal.direction === "long"
			? signal.entryPrice * (1 + params.tpPct / 100)
			: signal.entryPrice * (1 - params.tpPct / 100);

		const id = `opp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const position: PaperPosition = {
			id,
			source: signal.source,
			pair: signal.pair,
			strategyType: signal.type,
			direction: signal.direction,
			entryPrice: signal.entryPrice,
			qty,
			currentPrice: signal.entryPrice,
			pnl: 0,
			pnlPct: 0,
			stopLoss,
			takeProfit,
			openedAt: Date.now(),
			maxAgeMs: params.maxAgeMs,
			confidence: signal.confidence,
			sizingMultiplier,
		};

		if (this.riskManager) {
			const validation = this.riskManager.validateTrade({
				entryPrice: signal.entryPrice,
				qty,
				side: signal.direction,
				accountEquity: this.equity,
				peakEquity: this.peakEquity,
				openPositions: this.store.getOpenPositions(),
				symbol: signal.pair,
				consecutiveLosses: this.consecutiveLosses,
			});
			if (!validation.allowed) {
				return null;
			}
		} else if (!warnedMissingRiskManager) {
			warnedMissingRiskManager = true;
			console.warn(
				"[opportunity-trader] riskManager is not wired; skipping validateTrade for paper opens. Pass { riskManager } to enforce portfolio-level checks.",
			);
		}

		// Persist the position to the trading store so it survives daemon
		// restarts and shows up alongside other open positions in /positions.
		// Strategy metadata that doesn't have a dedicated column rides on
		// routeJson and is read back in restorePositionsFromStore().
		try {
			const stored = this.store.openPosition({
				symbol: signal.pair,
				side: signal.direction,
				entryPrice: signal.entryPrice,
				qty,
				stopLoss,
				takeProfit,
				isPaper: true,
				executionVenue: OPP_TRADER_VENUE,
				routeJson: JSON.stringify({
					source: signal.source,
					strategyType: signal.type,
					maxAgeMs: params.maxAgeMs,
				}),
			});
			position.dbId = stored.id;
		} catch (err) {
			console.debug(
				"[opportunity-trader] store.openPosition failed (running in-memory only):",
				err instanceof Error ? err.message : err,
			);
		}

		this.positions.set(signal.pair, position);
		this.lastTradeTime.set(signal.pair, Date.now());

		// Log to trading store — always paper since OpportunityTrader is paper-only
		this.store.logTrade({
			symbol: signal.pair,
			side: signal.direction === "long" ? "BUY" : "SELL",
			type: "MARKET",
			qty,
			price: signal.entryPrice,
			isPaper: true,
		});

		// R7 fix: Notify StopMonitor (or any consumer) immediately so stop-loss
		// monitoring begins with zero gap. The store row already has stopLoss
		// and takeProfit set from openPosition() above, but the StopMonitor
		// only discovers new positions on its next polling tick. This callback
		// closes that window.
		if (this.onPositionOpened && position.dbId) {
			try {
				this.onPositionOpened({
					dbId: position.dbId,
					symbol: signal.pair,
					side: signal.direction,
					entryPrice: signal.entryPrice,
					qty,
					stopLoss,
					takeProfit,
				});
			} catch (err) {
				console.debug(
					"[opportunity-trader] onPositionOpened callback error:",
					err instanceof Error ? err.message : err,
				);
			}
		}

		return position;
	}

	/**
	 * Update all open positions with current prices and check for exits.
	 * Call this on each scanner tick with a price map.
	 */
	update(prices: Map<string, number>): {
		updated: number;
		closed: { pair: string; reason: string; pnl: number }[];
	} {
		let updated = 0;
		const closed: { pair: string; reason: string; pnl: number }[] = [];

		for (const [pair, pos] of this.positions) {
			const price = prices.get(pair);
			if (price == null || price <= 0) continue;

			// Update current price and P&L
			pos.currentPrice = price;
			pos.pnl = pos.direction === "long"
				? (price - pos.entryPrice) * pos.qty
				: (pos.entryPrice - price) * pos.qty;
			pos.pnlPct = pos.direction === "long"
				? ((price - pos.entryPrice) / pos.entryPrice) * 100
				: ((pos.entryPrice - price) / pos.entryPrice) * 100;
			updated++;

			// Check exit conditions
			let exitReason: string | null = null;

			if (pos.direction === "long") {
				if (price <= pos.stopLoss) exitReason = "stop_loss";
				else if (price >= pos.takeProfit) exitReason = "take_profit";
			} else {
				if (price >= pos.stopLoss) exitReason = "stop_loss";
				else if (price <= pos.takeProfit) exitReason = "take_profit";
			}

			// Time-based exit
			if (!exitReason && Date.now() - pos.openedAt > pos.maxAgeMs) {
				exitReason = "timeout";
			}

			if (exitReason) {
				this.closePosition(pair, price, exitReason);
				closed.push({ pair, reason: exitReason, pnl: pos.pnl });
			}
		}

		return { updated, closed };
	}

	/** Force close a specific position */
	closePosition(pair: string, exitPrice: number, reason: string): void {
		const pos = this.positions.get(pair);
		if (!pos) return;

		const pnl = pos.direction === "long"
			? (exitPrice - pos.entryPrice) * pos.qty
			: (pos.entryPrice - exitPrice) * pos.qty;
		const pnlPct = pos.direction === "long"
			? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
			: ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;

		this.totalPnl += pnl;
		this.equity += pnl;
		if (this.equity > this.peakEquity) this.peakEquity = this.equity;
		this.tradeCount++;
		if (pnl > 0) {
			this.winCount++;
			this.consecutiveLosses = 0; // Reset streak on a win
		} else {
			this.consecutiveLosses++;
		}
		this.persistHaltState();

		this.closedTrades.push({
			pair,
			source: pos.source,
			strategyType: pos.strategyType,
			direction: pos.direction,
			entryPrice: pos.entryPrice,
			exitPrice,
			pnl,
			pnlPct,
			exitReason: reason,
			duration: Date.now() - pos.openedAt,
		});

		// Log exit to trading store — always paper since OpportunityTrader is paper-only
		this.store.logTrade({
			symbol: pair,
			side: pos.direction === "long" ? "SELL" : "BUY",
			type: "MARKET",
			qty: pos.qty,
			price: exitPrice,
			isPaper: true,
		});

		// Mirror the close on the persisted row so /positions reports it as
		// closed and rehydration after restart doesn't bring it back. Best-
		// effort: a missing or already-closed row is fine — the in-memory
		// state remains the source of truth for the engine.
		if (pos.dbId) {
			try {
				this.store.closePosition(pos.dbId, exitPrice);
			} catch (err) {
				console.debug(
					"[opportunity-trader] store.closePosition failed:",
					err instanceof Error ? err.message : err,
				);
			}
		}

		this.positions.delete(pair);
	}

	/** Get all open paper positions */
	getOpenPositions(): PaperPosition[] {
		return Array.from(this.positions.values());
	}

	/** Get practice trading performance stats */
	getStats(): {
		equity: number;
		startingEquity: number;
		totalReturn: number;
		totalReturnPct: number;
		peakEquity: number;
		drawdownPct: number;
		totalTrades: number;
		openPositions: number;
		winRate: number;
		avgWin: number;
		avgLoss: number;
		profitFactor: number;
		bestTrade: { pair: string; pnl: number; pnlPct: number } | null;
		worstTrade: { pair: string; pnl: number; pnlPct: number } | null;
		bySource: { source: string; trades: number; pnl: number; winRate: number }[];
		byStrategy: { type: string; trades: number; pnl: number; winRate: number }[];
		recentTrades: {
			pair: string; source: string; strategyType: string;
			direction: "long" | "short"; entryPrice: number; exitPrice: number;
			pnl: number; pnlPct: number; exitReason: string; duration: number;
		}[];
	} {
		const wins = this.closedTrades.filter((t) => t.pnl > 0);
		const losses = this.closedTrades.filter((t) => t.pnl <= 0);
		const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
		const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
		const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
		const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
		const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

		const best = this.closedTrades.length > 0
			? this.closedTrades.reduce((b, t) => t.pnl > b.pnl ? t : b)
			: null;
		const worst = this.closedTrades.length > 0
			? this.closedTrades.reduce((b, t) => t.pnl < b.pnl ? t : b)
			: null;

		// Group by source
		const sourceMap = new Map<string, { trades: number; pnl: number; wins: number }>();
		for (const t of this.closedTrades) {
			const s = sourceMap.get(t.source) ?? { trades: 0, pnl: 0, wins: 0 };
			s.trades++;
			s.pnl += t.pnl;
			if (t.pnl > 0) s.wins++;
			sourceMap.set(t.source, s);
		}
		const bySource = Array.from(sourceMap.entries()).map(([source, s]) => ({
			source, trades: s.trades, pnl: Math.round(s.pnl * 100) / 100,
			winRate: s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0,
		}));

		// Group by strategy type
		const stratMap = new Map<string, { trades: number; pnl: number; wins: number }>();
		for (const t of this.closedTrades) {
			const s = stratMap.get(t.strategyType) ?? { trades: 0, pnl: 0, wins: 0 };
			s.trades++;
			s.pnl += t.pnl;
			if (t.pnl > 0) s.wins++;
			stratMap.set(t.strategyType, s);
		}
		const byStrategy = Array.from(stratMap.entries()).map(([type, s]) => ({
			type, trades: s.trades, pnl: Math.round(s.pnl * 100) / 100,
			winRate: s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0,
		}));

		return {
			equity: Math.round(this.equity * 100) / 100,
			startingEquity: this.config.startingEquity,
			totalReturn: Math.round(this.totalPnl * 100) / 100,
			totalReturnPct: Math.round(((this.equity - this.config.startingEquity) / this.config.startingEquity) * 10000) / 100,
			peakEquity: Math.round(this.peakEquity * 100) / 100,
			drawdownPct: this.peakEquity > 0
				? Math.round(((this.peakEquity - this.equity) / this.peakEquity) * 10000) / 100
				: 0,
			totalTrades: this.tradeCount,
			openPositions: this.positions.size,
			winRate: this.tradeCount > 0 ? Math.round((this.winCount / this.tradeCount) * 100) : 0,
			avgWin: Math.round(avgWin * 100) / 100,
			avgLoss: Math.round(avgLoss * 100) / 100,
			profitFactor: Math.round(profitFactor * 100) / 100,
			bestTrade: best ? { pair: best.pair, pnl: Math.round(best.pnl * 100) / 100, pnlPct: Math.round(best.pnlPct * 100) / 100 } : null,
			worstTrade: worst ? { pair: worst.pair, pnl: Math.round(worst.pnl * 100) / 100, pnlPct: Math.round(worst.pnlPct * 100) / 100 } : null,
			bySource,
			byStrategy,
			recentTrades: this.closedTrades.slice(-20).reverse(),
		};
	}

	/** Whether new trades are halted (drawdown or consecutive loss limit).
	 * Auto-resumes elapsed streak cooldowns as a side-effect so callers see a
	 * truthful answer without having to call evaluate() first. */
	isHalted(): boolean {
		this.maybeAutoResume();
		return this.halted;
	}

	/** Get halt reason (empty string if not halted). */
	getHaltReason(): string {
		this.maybeAutoResume();
		return this.haltReason;
	}

	/** ms remaining on the active streak cooldown, or 0 if none. */
	getCooldownRemainingMs(): number {
		if (!this.halted || this.pausedUntil <= 0) return 0;
		const remaining = this.pausedUntil - Date.now();
		return remaining > 0 ? remaining : 0;
	}

	/** Number of times the streak halt has tripped this run (or since reset). */
	getHaltCount(): number {
		return this.haltCount;
	}

	/** Most recent streak analysis snapshot, or null if none was recorded. */
	getStreakAnalysis(): StreakAnalysis | null {
		try {
			const raw = this.store.getSetting("opp_trader_streak_analysis");
			if (!raw) return null;
			return JSON.parse(raw) as StreakAnalysis;
		} catch {
			return null;
		}
	}

	/** Manually reset the circuit breaker after review.
	 * Clears halt state, cooldown, and the escalation counter so the next
	 * streak halt starts at the shortest cooldown again. */
	resetCircuitBreaker(): void {
		this.halted = false;
		this.haltReason = "";
		this.consecutiveLosses = 0;
		this.pausedUntil = 0;
		this.haltCount = 0;
		this.persistHaltState();
	}

	getConfig(): OpportunityTraderConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<OpportunityTraderConfig>): void {
		Object.assign(this.config, updates);
	}
}
