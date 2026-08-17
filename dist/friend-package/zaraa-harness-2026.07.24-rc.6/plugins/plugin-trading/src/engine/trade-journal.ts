import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Signal } from "../strategies/strategy.js";
import type { TradeValidation } from "../risk/risk-manager.js";

export interface SignalRecord {
	id: string;
	strategyName: string;
	symbol: string;
	direction: "long" | "short";
	confidence: number;
	reason: string;
	entryPrice: number;
	qty: number;
	stopLoss: number;
	takeProfit: number;
	status: "generated" | "pending" | "executed" | "rejected" | "failed";
	rejectionReasons: string[] | null;
	createdAt: string;
	/** Market regime at signal time (e.g. "trending_up", "ranging") */
	regime: string | null;
	/** Regime detection confidence (0-1) */
	regimeConfidence: number | null;
	/** Trading session at signal time (e.g. "us", "european") */
	session: string | null;
	/** Session fitness score for the strategy (0-1) */
	sessionFitness: number | null;
}

export interface StrategyTradeRecord {
	id: string;
	signalId: string;
	strategyName: string;
	symbol: string;
	direction: "long" | "short";
	entryPrice: number;
	exitPrice: number | null;
	qty: number;
	pnl: number | null;
	rMultiple: number | null;
	exitReason: string | null;
	enteredAt: string;
	exitedAt: string | null;
	/** Market regime at trade entry (carried from signal) */
	regime: string | null;
	/** Trading session at trade entry (carried from signal) */
	session: string | null;
	/** True when this row was produced by the shadow execution path. Excluded
	 * from learning-loop aggregates by default — set isShadow=true on lookups
	 * if you specifically want shadow rows. */
	isShadow: boolean;
}

/**
 * Per-strategy closed-trade stats keyed by strategyName. Embedded into each
 * shadow P&L snapshot so consumers can see which strategies are winning/losing
 * without re-querying the journal. `flagged` marks a chronic loser that's a
 * candidate for disable (see STRATEGY_FLAG_THRESHOLDS).
 */
export interface PerStrategyStat {
	trades: number;
	pnl: number;
	winRate: number;
	/** True when trades >= 20 AND winRate < 0.35 AND cumulative pnl < -$1.00. */
	flagged: boolean;
}

/**
 * Thresholds for flagging a chronically-losing strategy for *potential*
 * disable. A strategy is flagged only when ALL three hold simultaneously, so a
 * small sample or a near-breakeven strategy is never flagged. Flagging is
 * advisory — nothing is auto-disabled; the flag is logged and surfaced in the
 * snapshot for an operator (or a future auto-disable pass) to act on.
 */
export const STRATEGY_FLAG_THRESHOLDS = {
	/** Minimum closed trades before the win-rate sample is trustworthy. */
	minClosedTrades: 20,
	/** Win rate must be below this (exclusive) to flag. */
	maxWinRate: 0.35,
	/** Cumulative P&L must be below this (exclusive, USD) to flag. */
	maxCumulativePnl: -1.0,
} as const;

/**
 * Audit-only zero-P&L closes used to move never-exited orphan rows out of the
 * "open" set without deleting them (see reconcileOrphanedTrades). They represent
 * housekeeping, NOT real trades, so every performance aggregate (trade count,
 * win rate, per-strategy stats) MUST exclude them — otherwise each orphan close
 * is counted as a non-win and silently deflates win-rate / "risk proof" stats.
 * Kept as one constant so the cumulative and per-strategy queries stay consistent.
 */
const AUDIT_CLOSE_EXIT_REASONS = ["orphaned", "reconcile_orphan", "shadow_orphan"] as const;
const AUDIT_CLOSE_EXCLUSION_SQL = `AND (exitReason IS NULL OR exitReason NOT IN (${AUDIT_CLOSE_EXIT_REASONS.map((r) => `'${r}'`).join(", ")}))`;

export interface ReturnAttributionBucket {
	strategyName: string;
	symbol: string;
	regime: string | null;
	session: string | null;
	tradeCount: number;
	winRate: number;
	totalPnl: number;
	avgPnl: number;
	sharpeRatio: number;
	lastExitedAt: string | null;
}

export class TradeJournal {
	private db: Database.Database;
	/** Optional callback fired after a trade is closed with the full record. */
	onTradeClose: ((record: StrategyTradeRecord) => void) | null = null;

	constructor(db: Database.Database) {
		// NOTE: Tables for this class (signal_log, strategy_trades) are created
		// by the TradingStore migration runner since they share the same database.
		// Do not add initTables() here — run migrations through TradingStore.
		this.db = db;
	}

	recordSignal(input: {
		strategyName: string;
		signal: Signal;
		qty: number;
		stopLoss: number;
		takeProfit: number;
		riskValidation: TradeValidation;
		/** Market regime context at signal time */
		regime?: string;
		regimeConfidence?: number;
		/** Trading session context at signal time */
		session?: string;
		sessionFitness?: number;
	}): SignalRecord {
		const id = randomUUID();
		const now = new Date().toISOString();
		const status = input.riskValidation.allowed ? "generated" : "rejected";
		const rejectionReasons = input.riskValidation.allowed ? null : input.riskValidation.reasons;

		this.db
			.prepare(
				`INSERT INTO signal_log (id, strategyName, symbol, direction, confidence, reason, entryPrice, qty, stopLoss, takeProfit, status, rejectionReasons, createdAt, regime, regimeConfidence, session, sessionFitness)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.strategyName,
				input.signal.symbol,
				input.signal.direction,
				input.signal.confidence,
				input.signal.reason,
				input.signal.entryPrice,
				input.qty,
				input.stopLoss,
				input.takeProfit,
				status,
				rejectionReasons ? JSON.stringify(rejectionReasons) : null,
				now,
				input.regime ?? null,
				input.regimeConfidence ?? null,
				input.session ?? null,
				input.sessionFitness ?? null,
			);

		return {
			id,
			strategyName: input.strategyName,
			symbol: input.signal.symbol,
			direction: input.signal.direction,
			confidence: input.signal.confidence,
			reason: input.signal.reason,
			entryPrice: input.signal.entryPrice,
			qty: input.qty,
			stopLoss: input.stopLoss,
			takeProfit: input.takeProfit,
			status,
			rejectionReasons,
			createdAt: now,
			regime: input.regime ?? null,
			regimeConfidence: input.regimeConfidence ?? null,
			session: input.session ?? null,
			sessionFitness: input.sessionFitness ?? null,
		};
	}

	updateSignalStatus(id: string, status: SignalRecord["status"]): void {
		this.db.prepare("UPDATE signal_log SET status = ? WHERE id = ?").run(status, id);
	}

	/**
	 * Fetch the regime + session tags from a persisted signal. Used by the
	 * execution path to carry context from signal_log into strategy_trades
	 * without needing the caller to round-trip those fields through tool payloads.
	 */
	getSignalContext(id: string): { regime: string | null; session: string | null } | null {
		const row = this.db
			.prepare("SELECT regime, session FROM signal_log WHERE id = ?")
			.get(id) as { regime: string | null; session: string | null } | undefined;
		return row ?? null;
	}

	recordTrade(input: {
		signalId: string;
		strategyName: string;
		symbol: string;
		direction: "long" | "short";
		entryPrice: number;
		qty: number;
		/** Carried from signal — market regime at entry */
		regime?: string;
		/** Carried from signal — trading session at entry */
		session?: string;
		/** Mark row as a shadow trade. Default false — keeps real/paper behavior unchanged. */
		isShadow?: boolean;
	}): StrategyTradeRecord {
		const id = randomUUID();
		const now = new Date().toISOString();
		const isShadow = input.isShadow === true;

		this.db
			.prepare(
				`INSERT INTO strategy_trades (id, signalId, strategyName, symbol, direction, entryPrice, qty, enteredAt, regime, session, isShadow)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, input.signalId, input.strategyName, input.symbol, input.direction, input.entryPrice, input.qty, now, input.regime ?? null, input.session ?? null, isShadow ? 1 : 0);

		return {
			id,
			signalId: input.signalId,
			strategyName: input.strategyName,
			symbol: input.symbol,
			direction: input.direction,
			entryPrice: input.entryPrice,
			exitPrice: null,
			qty: input.qty,
			pnl: null,
			rMultiple: null,
			exitReason: null,
			enteredAt: now,
			exitedAt: null,
			regime: input.regime ?? null,
			session: input.session ?? null,
			isShadow,
		};
	}

	closeTrade(
		id: string,
		exitPrice: number,
		exitReason: string,
	): void {
		const trade = this.db
			.prepare("SELECT * FROM strategy_trades WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		if (!trade) return;

		const entryPrice = trade.entryPrice as number;
		const qty = trade.qty as number;
		const direction = trade.direction as "long" | "short";
		const pnl = direction === "long"
			? (exitPrice - entryPrice) * qty
			: (entryPrice - exitPrice) * qty;

		// Get signal to compute R-multiple
		const signal = this.db
			.prepare("SELECT stopLoss FROM signal_log WHERE id = ?")
			.get(trade.signalId as string) as { stopLoss: number } | undefined;
		const riskDistance = signal ? Math.abs(entryPrice - signal.stopLoss) : 0;
		const rMultiple = riskDistance > 0 ? pnl / (riskDistance * qty) : 0;

		const exitedAt = new Date().toISOString();
		this.db
			.prepare(
				"UPDATE strategy_trades SET exitPrice = ?, pnl = ?, rMultiple = ?, exitReason = ?, exitedAt = ? WHERE id = ?",
			)
			.run(exitPrice, pnl, rMultiple, exitReason, exitedAt, id);

		if (this.onTradeClose) {
			try {
				this.onTradeClose({
					id,
					signalId: trade.signalId as string,
					strategyName: trade.strategyName as string,
					symbol: trade.symbol as string,
					direction,
					entryPrice,
					exitPrice,
					qty,
					pnl,
					rMultiple,
					exitReason,
					enteredAt: trade.enteredAt as string,
					exitedAt,
					regime: (trade.regime as string) ?? null,
					session: (trade.session as string) ?? null,
					isShadow: Number(trade.isShadow ?? 0) === 1,
				});
			} catch (err) {
				console.warn("[trade-journal] onTradeClose callback error:", err instanceof Error ? err.message : err);
			}
		}
	}

	getRecentSignals(limit = 20): SignalRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM signal_log ORDER BY createdAt DESC LIMIT ?")
			.all(limit) as (Omit<SignalRecord, "rejectionReasons"> & { rejectionReasons: string | null })[];

		return rows.map((r) => {
			let rejectionReasons: string[] | null = null;
			if (r.rejectionReasons) { try { rejectionReasons = JSON.parse(r.rejectionReasons); } catch { console.warn("Failed to parse rejectionReasons JSON:", r.rejectionReasons); rejectionReasons = []; } }
			return { ...r, rejectionReasons, regime: r.regime ?? null, regimeConfidence: r.regimeConfidence ?? null, session: r.session ?? null, sessionFitness: r.sessionFitness ?? null };
		});
	}

	getSignalsByStrategy(strategyName: string, limit = 20): SignalRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM signal_log WHERE strategyName = ? ORDER BY createdAt DESC LIMIT ?")
			.all(strategyName, limit) as (Omit<SignalRecord, "rejectionReasons"> & { rejectionReasons: string | null })[];

		return rows.map((r) => {
			let rejectionReasons: string[] | null = null;
			if (r.rejectionReasons) { try { rejectionReasons = JSON.parse(r.rejectionReasons); } catch { console.warn("Failed to parse rejectionReasons JSON:", r.rejectionReasons); rejectionReasons = []; } }
			return { ...r, rejectionReasons, regime: r.regime ?? null, regimeConfidence: r.regimeConfidence ?? null, session: r.session ?? null, sessionFitness: r.sessionFitness ?? null };
		});
	}

	getStrategyTrades(strategyName: string, limit = 50): StrategyTradeRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM strategy_trades WHERE strategyName = ? AND isShadow = 0 ORDER BY enteredAt DESC LIMIT ?")
			.all(strategyName, limit) as (Omit<StrategyTradeRecord, "isShadow"> & { isShadow?: number })[];
		return rows.map((r) => ({
			...r,
			regime: r.regime ?? null,
			session: r.session ?? null,
			isShadow: Number(r.isShadow ?? 0) === 1,
		}));
	}

	/** Shadow-only counterpart to getStrategyTrades — for diagnostics dashboards. */
	getShadowStrategyTrades(strategyName: string, limit = 50): StrategyTradeRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM strategy_trades WHERE strategyName = ? AND isShadow = 1 ORDER BY enteredAt DESC LIMIT ?")
			.all(strategyName, limit) as (Omit<StrategyTradeRecord, "isShadow"> & { isShadow?: number })[];
		return rows.map((r) => ({
			...r,
			regime: r.regime ?? null,
			session: r.session ?? null,
			isShadow: true,
		}));
	}

	/**
	 * Cumulative count + total realized P&L across every closed row in
	 * `strategy_trades`. Used as a baseline so consumers (shadow status,
	 * snapshot logging) keep the lifetime totals across daemon restarts
	 * instead of resetting to whatever closes happened since boot.
	 */
	getCumulativeStats(): { trades: number; wins: number; totalPnl: number } {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as trades, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) as wins, COALESCE(SUM(pnl), 0) as totalPnl FROM strategy_trades WHERE exitPrice IS NOT NULL ${AUDIT_CLOSE_EXCLUSION_SQL}`,
			)
			.get() as { trades: number | bigint; wins: number | bigint; totalPnl: number | bigint };
		return {
			trades: Number(row.trades),
			wins: Number(row.wins),
			totalPnl: Number(row.totalPnl),
		};
	}

	/**
	 * Per-strategy breakdown of closed trades (count, realized P&L, win rate),
	 * keyed by strategyName. Computed from `strategy_trades` in a single grouped
	 * query so a shadow P&L snapshot can carry the breakdown without each
	 * consumer re-querying the journal. Each entry also carries a `flagged` bit
	 * (see STRATEGY_FLAG_THRESHOLDS) marking a chronic loser for potential
	 * disable — nothing is auto-disabled here, the flag is purely advisory.
	 *
	 * Mirrors `getCumulativeStats` in NOT filtering on isShadow: the same
	 * snapshot's aggregate totals come from that method, so the per-strategy
	 * rows must sum to the same population to stay consistent.
	 */
	getPerStrategyStats(): Record<string, PerStrategyStat> {
		const rows = this.db
			.prepare(
				`SELECT strategyName,
					COUNT(*) as trades,
					ROUND(SUM(pnl), 4) as pnl,
					ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) as winRate
				 FROM strategy_trades WHERE exitPrice IS NOT NULL ${AUDIT_CLOSE_EXCLUSION_SQL} GROUP BY strategyName`,
			)
			.all() as Array<{
				strategyName: string;
				trades: number | bigint;
				pnl: number | null;
				winRate: number | null;
			}>;

		const out: Record<string, PerStrategyStat> = {};
		for (const r of rows) {
			const trades = Number(r.trades);
			const pnl = Number(r.pnl ?? 0);
			const winRate = Number(r.winRate ?? 0);
			const flagged =
				trades >= STRATEGY_FLAG_THRESHOLDS.minClosedTrades &&
				winRate < STRATEGY_FLAG_THRESHOLDS.maxWinRate &&
				pnl < STRATEGY_FLAG_THRESHOLDS.maxCumulativePnl;
			out[r.strategyName] = { trades, pnl, winRate, flagged };
		}
		return out;
	}

	/**
	 * Persist a shadow-trade exit when no matching open `strategy_trades` row
	 * exists. Synthesizes a placeholder `signal_log` row (status='executed',
	 * reason='shadow_orphan') so the FK on `strategy_trades.signalId` is
	 * satisfied, then INSERTs a fully-populated trade row (entry + exit
	 * fields, isShadow=1) in a single transaction.
	 *
	 * Used by the shadow `onPositionClose` callback as a fallback when
	 * `closeTradeBySymbol` returns false — without this, time-expiry closes
	 * (and any close where the entry didn't land in strategy_trades) silently
	 * disappear and the soak shows zero closed shadow trades despite N closes
	 * in shadow_pnl_snapshots.
	 */
	recordShadowExit(input: {
		symbol: string;
		direction: "long" | "short";
		entryPrice: number;
		exitPrice: number;
		qty: number;
		pnl: number;
		exitReason: string;
		enteredAt: string | number;
		exitedAt: string | number;
		strategyName?: string;
		stopLoss?: number;
		takeProfit?: number;
		confidence?: number;
	}): StrategyTradeRecord {
		const tradeId = randomUUID();
		const signalId = randomUUID();
		const enteredAtIso = typeof input.enteredAt === "number"
			? new Date(input.enteredAt).toISOString()
			: input.enteredAt;
		const exitedAtIso = typeof input.exitedAt === "number"
			? new Date(input.exitedAt).toISOString()
			: input.exitedAt;
		const strategyName = input.strategyName ?? "shadow";
		const stopLoss = input.stopLoss ?? input.entryPrice;
		const takeProfit = input.takeProfit ?? input.entryPrice;
		const riskDistance = Math.abs(input.entryPrice - stopLoss);
		const rMultiple = riskDistance > 0 && input.qty > 0
			? input.pnl / (riskDistance * input.qty)
			: 0;

		const tx = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO signal_log (id, strategyName, symbol, direction, confidence, reason, entryPrice, qty, stopLoss, takeProfit, status, rejectionReasons, createdAt)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'executed', NULL, ?)`,
				)
				.run(
					signalId,
					strategyName,
					input.symbol,
					input.direction,
					input.confidence ?? 0,
					"shadow_orphan",
					input.entryPrice,
					input.qty,
					stopLoss,
					takeProfit,
					enteredAtIso,
				);

			this.db
				.prepare(
					`INSERT INTO strategy_trades (id, signalId, strategyName, symbol, direction, entryPrice, exitPrice, qty, pnl, rMultiple, exitReason, enteredAt, exitedAt, isShadow)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
				)
				.run(
					tradeId,
					signalId,
					strategyName,
					input.symbol,
					input.direction,
					input.entryPrice,
					input.exitPrice,
					input.qty,
					input.pnl,
					rMultiple,
					input.exitReason,
					enteredAtIso,
					exitedAtIso,
				);
		});
		tx();

		return {
			id: tradeId,
			signalId,
			strategyName,
			symbol: input.symbol,
			direction: input.direction,
			entryPrice: input.entryPrice,
			exitPrice: input.exitPrice,
			qty: input.qty,
			pnl: input.pnl,
			rMultiple,
			exitReason: input.exitReason,
			enteredAt: enteredAtIso,
			exitedAt: exitedAtIso,
			regime: null,
			session: null,
			isShadow: true,
		};
	}

	/**
	 * Close the most recent open strategy_trade for a symbol+direction at the
	 * given exit price. Returns true when a row was found and closed; false when
	 * there was no matching open trade (silently — many positions are opened
	 * outside the strategy framework, e.g. manual `trade_buy` without a signalId).
	 *
	 * This is the bridge from position close (TP, SL, manual, time-stop,
	 * emergency-flatten) into the strategy learning loop: without a populated
	 * `strategy_trades.exitedAt + pnl`, StrategyGrader silently grades 0% of
	 * outcomes and the regime-weight feedback loop (signal-engine wireTradeCloseFeedback)
	 * never fires.
	 */
	closeTradeBySymbol(
		symbol: string,
		direction: "long" | "short",
		exitPrice: number,
		exitReason: string,
		opts: { isShadow?: boolean } = {},
	): boolean {
		const open = this.findOpenTrade(symbol, direction, { isShadow: opts.isShadow });
		if (!open) return false;
		this.closeTrade(open.id, exitPrice, exitReason);
		return true;
	}

	/**
	 * Every open (exitedAt IS NULL) shadow-tagged row in strategy_trades, oldest
	 * first. Used by the startup reconciliation pass to compare against the
	 * `shadow_open_positions` settings blob and detect phantom-opens (journal
	 * has it open but settings doesn't, or vice versa).
	 */
	getOpenShadowTrades(): StrategyTradeRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM strategy_trades WHERE isShadow = 1 AND exitedAt IS NULL ORDER BY enteredAt ASC",
			)
			.all() as (Omit<StrategyTradeRecord, "isShadow"> & { isShadow?: number })[];
		return rows.map((r) => ({
			...r,
			regime: r.regime ?? null,
			session: r.session ?? null,
			isShadow: true,
		}));
	}

	/**
	 * Every open (exitedAt IS NULL) row in strategy_trades — REGARDLESS of the
	 * isShadow flag — that has been open longer than `olderThanMs`, oldest first.
	 *
	 * This is the isShadow-agnostic counterpart to `getOpenShadowTrades` (which
	 * only ever returned isShadow=1 rows). Both the shadow close path
	 * (`closeTradeBySymbol({ isShadow: true })`) and the startup reconcile
	 * (`getOpenShadowTrades`) filter on isShadow=1, so an isShadow=0 entry whose
	 * exit never landed — a shadow signal recorded before the entry-flagging fix,
	 * or a real/paper trade whose close path never fired — is invisible to every
	 * one of them and stays open forever. This surfaces those orphans for the
	 * reconcile pass.
	 *
	 * The age gate is mandatory: only rows open *implausibly* long (well past any
	 * legitimate hold time — shadow positions time-expire in minutes/hours, not
	 * days) are returned, so a freshly-opened, still-live position is never
	 * mistaken for an orphan. `now` is injectable for deterministic tests.
	 */
	getOrphanedOpenTrades(olderThanMs: number, now: number = Date.now()): StrategyTradeRecord[] {
		const cutoffIso = new Date(now - olderThanMs).toISOString();
		const rows = this.db
			.prepare(
				"SELECT * FROM strategy_trades WHERE exitedAt IS NULL AND enteredAt < ? ORDER BY enteredAt ASC",
			)
			.all(cutoffIso) as (Omit<StrategyTradeRecord, "isShadow"> & { isShadow?: number })[];
		return rows.map((r) => ({
			...r,
			regime: r.regime ?? null,
			session: r.session ?? null,
			isShadow: Number(r.isShadow ?? 0) === 1,
		}));
	}

	/**
	 * Detect and MARK orphaned open trades (see `getOrphanedOpenTrades`). Each
	 * orphan is closed at its OWN entry price — a zero-realized-P&L close so it
	 * never pollutes lifetime stats (the performance aggregates exclude the
	 * `AUDIT_CLOSE_EXIT_REASONS`) — with exitReason `orphaned` (overridable). The
	 * entry data (entryPrice, qty, signalId, enteredAt) is left untouched and the
	 * isShadow flag is preserved: nothing is deleted, the row is simply moved out
	 * of the "open" set and audit-tagged, mirroring the existing zero-P&L
	 * `reconcile_orphan` convention.
	 *
	 * `protectedPositions` is an optional set of (symbol, direction) pairs known
	 * to still be live (e.g. positions just restored at startup, or open exchange
	 * positions in live mode). Any orphan matching one is SKIPPED — `closeTrade`
	 * only mutates the journal, not the real/paper position, so closing a row that
	 * is genuinely still open would desync the journal from reality and discard
	 * the eventual realized P&L when that position truly closes.
	 *
	 * Returns the reconciled records (and a count) so callers can log exactly
	 * what was marked. Idempotent: once a row is closed it no longer matches.
	 */
	reconcileOrphanedTrades(opts: {
		olderThanMs: number;
		now?: number;
		exitReason?: string;
		protectedPositions?: Array<{ symbol: string; direction: string }>;
	}): { reconciled: StrategyTradeRecord[]; count: number } {
		const now = opts.now ?? Date.now();
		const exitReason = opts.exitReason ?? "orphaned";
		const protectedKeys = new Set(
			(opts.protectedPositions ?? []).map((p) => `${p.symbol}|${p.direction}`),
		);
		const orphans = this.getOrphanedOpenTrades(opts.olderThanMs, now);
		const reconciled: StrategyTradeRecord[] = [];
		for (const orphan of orphans) {
			// Never close a row that matches a still-live position — the journal close
			// does not touch the real position, so this would desync the two.
			if (protectedKeys.has(`${orphan.symbol}|${orphan.direction}`)) continue;
			// Close at entry price → realized P&L is exactly 0 (long or short).
			this.closeTrade(orphan.id, orphan.entryPrice, exitReason);
			reconciled.push({
				...orphan,
				exitPrice: orphan.entryPrice,
				pnl: 0,
				rMultiple: 0,
				exitReason,
				exitedAt: new Date(now).toISOString(),
			});
		}
		return { reconciled, count: reconciled.length };
	}

	/**
	 * Find the most recent open (unclosed) strategy trade for a given symbol and direction.
	 * Used by the StopMonitor close path to record exits in the journal.
	 * Returns null if no matching open trade is found.
	 *
	 * Filters by isShadow flag so the real-position close path cannot accidentally
	 * grab a shadow row, and the shadow close path cannot grab a real row.
	 */
	findOpenTrade(
		symbol: string,
		direction: "long" | "short",
		opts: { isShadow?: boolean } = {},
	): StrategyTradeRecord | null {
		const isShadow = opts.isShadow === true ? 1 : 0;
		const row = this.db
			.prepare(
				"SELECT * FROM strategy_trades WHERE symbol = ? AND direction = ? AND exitedAt IS NULL AND isShadow = ? ORDER BY enteredAt DESC LIMIT 1",
			)
			.get(symbol, direction, isShadow) as (Omit<StrategyTradeRecord, "isShadow"> & { isShadow?: number }) | undefined;
		return row
			? {
				...row,
				regime: row.regime ?? null,
				session: row.session ?? null,
				isShadow: Number(row.isShadow ?? 0) === 1,
			}
			: null;
	}

	getStrategyStats(): {
		strategy: string;
		signals: number;
		executed: number;
		rejected: number;
		trades: number;
		totalPnl: number;
		avgRMultiple: number;
	}[] {
		const rows = this.db
			.prepare(`
				SELECT
					s.strategyName as strategy,
					COUNT(*) as signals,
					SUM(CASE WHEN s.status = 'executed' THEN 1 ELSE 0 END) as executed,
					SUM(CASE WHEN s.status = 'rejected' THEN 1 ELSE 0 END) as rejected
				FROM signal_log s
				GROUP BY s.strategyName
			`)
			.all() as { strategy: string; signals: number; executed: number; rejected: number }[];

		return rows.map((r) => {
			const trades = this.db
				.prepare(
					`SELECT COUNT(*) as cnt, COALESCE(SUM(pnl), 0) as totalPnl, COALESCE(AVG(rMultiple), 0) as avgR FROM strategy_trades WHERE strategyName = ? AND exitedAt IS NOT NULL AND isShadow = 0 ${AUDIT_CLOSE_EXCLUSION_SQL}`,
				)
				.get(r.strategy) as { cnt: number; totalPnl: number; avgR: number };

			return {
				...r,
				trades: trades.cnt,
				totalPnl: Math.round(trades.totalPnl * 100) / 100,
				avgRMultiple: Math.round(trades.avgR * 100) / 100,
			};
		});
	}

	getReturnAttribution(strategyName?: string, lookbackDays = 30): ReturnAttributionBucket[] {
		const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
		const rows = strategyName
			? this.db.prepare(`
				SELECT strategyName, symbol, regime, session, pnl, exitedAt
				FROM strategy_trades
				WHERE exitedAt IS NOT NULL AND isShadow = 0 AND exitedAt >= ? AND strategyName = ?
				ORDER BY exitedAt ASC
			`).all(since, strategyName) as Array<{
				strategyName: string;
				symbol: string;
				regime: string | null;
				session: string | null;
				pnl: number;
				exitedAt: string;
			}>
			: this.db.prepare(`
				SELECT strategyName, symbol, regime, session, pnl, exitedAt
				FROM strategy_trades
				WHERE exitedAt IS NOT NULL AND isShadow = 0 AND exitedAt >= ?
				ORDER BY exitedAt ASC
			`).all(since) as Array<{
				strategyName: string;
				symbol: string;
				regime: string | null;
				session: string | null;
				pnl: number;
				exitedAt: string;
			}>;

		const grouped = new Map<string, typeof rows>();
		for (const row of rows) {
			const key = [row.strategyName, row.symbol, row.regime ?? "", row.session ?? ""].join("|");
			const bucket = grouped.get(key) ?? [];
			bucket.push(row);
			grouped.set(key, bucket);
		}

		const result: ReturnAttributionBucket[] = [];
		for (const bucket of grouped.values()) {
			const pnls = bucket.map((row) => row.pnl);
			const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
			const wins = pnls.filter((pnl) => pnl > 0).length;
			result.push({
				strategyName: bucket[0].strategyName,
				symbol: bucket[0].symbol,
				regime: bucket[0].regime ?? null,
				session: bucket[0].session ?? null,
				tradeCount: bucket.length,
				winRate: bucket.length > 0 ? wins / bucket.length : 0,
				totalPnl: round2(totalPnl),
				avgPnl: round2(bucket.length > 0 ? totalPnl / bucket.length : 0),
				sharpeRatio: round2(computeSharpe(pnls)),
				lastExitedAt: bucket.at(-1)?.exitedAt ?? null,
			});
		}

		return result.sort((a, b) => {
			if (a.tradeCount !== b.tradeCount) return b.tradeCount - a.tradeCount;
			return a.totalPnl - b.totalPnl;
		});
	}
}

function computeSharpe(pnls: number[]): number {
	if (pnls.length < 2) return 0;
	const mean = pnls.reduce((sum, value) => sum + value, 0) / pnls.length;
	const variance = pnls.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pnls.length - 1);
	const std = Math.sqrt(variance);
	if (std === 0) return 0;
	return (mean / std) * Math.sqrt(365);
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
