import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
// Use local copy to avoid circular dep: @zaraa/core → plugin-trading → @zaraa/core
import { MigrationRunner } from "./db/migration-runner.js";
import { TRADING_MIGRATIONS } from "./migrations.js";

// Lightweight summary row stored in the DB for each completed backtest.
// The full result JSON is stored in resultJson for detailed queries.
export interface BacktestSummary {
	id: string;
	strategy: string;
	symbol: string;
	timeframe: string;
	startDate: string;
	endDate: string;
	startingEquity: number;
	finalEquity: number;
	totalPnl: number;
	totalReturnPct: number;
	winRate: number;
	sharpeRatio: number;
	maxDrawdownPct: number;
	totalTrades: number;
	resultJson: string; // full BacktestResult serialized as JSON
	createdAt: string;
}

export interface Position {
	id: string;
	symbol: string;
	side: "long" | "short";
	entryPrice: number;
	qty: number;
	currentPrice: number | null;
	pnl: number | null;
	status: "open" | "closed";
	openedAt: string;
	closedAt: string | null;
	/** true = paper/simulated, false = live real-money. Returned by SQLite as 0|1. */
	isPaper?: boolean | number;
	/** e.g. dex_solana for Jupiter; null/undefined for CEX */
	executionVenue?: string | null;
	chain?: string | null;
	txSignature?: string | null;
	slippageBps?: number | null;
	routeJson?: string | null;
	/** Exchange identifier (e.g. "crypto_com"), if tracked. */
	exchange?: string | null;
}

export interface PositionWithStops extends Position {
	stopLoss: number | null;
	takeProfit: number | null;
	trailingStopPct: number | null;
	trailingStopHigh: number | null;
}

export interface EquitySnapshot {
	timestamp: string;
	equity: number;
}

export interface LiveEquitySnapshot extends EquitySnapshot {
	source: string;
}

export interface RiskMonitorEvent {
	id: string;
	createdAt: string;
	fromState: string;
	toState: string;
	reason: string;
	detailJson: string | null;
}

export interface PriceAlert {
	id: string;
	symbol: string;
	condition: "above" | "below";
	targetPrice: number;
	triggered: boolean;
	createdAt: string;
	triggeredAt: string | null;
}

export interface TradeLog {
	id: string;
	symbol: string;
	side: "BUY" | "SELL";
	type: "MARKET" | "LIMIT";
	qty: number;
	price: number;
	total: number;
	orderId: string | null;
	createdAt: string;
	isPaper: boolean; // true = paper/simulated trade, false = live real-money trade
	executionVenue?: string | null;
	chain?: string | null;
	txSignature?: string | null;
	slippageBps?: number | null;
	routeJson?: string | null;
}

/** One currency slot in the virtual paper portfolio (e.g. USDT, BTC, ETH) */
export interface PaperBalance {
	currency: string;
	balance: number;
}

/** Per-position line in the daily P&L report */
export interface DailyPnLPosition {
	positionId: string;
	symbol: string;
	side: "long" | "short";
	entryPrice: number;
	exitPrice: number;
	qty: number;
	pnl: number; // dollar P&L
	pnlPct: number; // % gain/loss vs entry cost
	openedAt: string;
	closedAt: string;
}

/** Daily P&L summary — shown by the trade_paper_summary handler */
export interface DailyPnLSummary {
	date: string; // YYYY-MM-DD (UTC)
	mode: "PAPER" | "LIVE";
	totalPnl: number;
	totalTrades: number;
	winningTrades: number;
	losingTrades: number;
	winRate: number; // 0-100
	positions: DailyPnLPosition[];
	paperPortfolio?: {
		// only present in paper mode
		balances: PaperBalance[];
		startingUsd: number;
		currentUsd: number; // USDT balance
		totalReturn: number; // vs starting balance
		totalReturnPct: number;
	};
}

export interface TradingStoreConfig {
	path: string;
	/**
	 * Interval (ms) for periodic WAL checkpoints. Keeps trading.db readable by
	 * out-of-process tooling (mirror DBs, monitors) even when the writer is
	 * idle. Set to 0 to disable. Default: 60_000.
	 */
	walCheckpointIntervalMs?: number;
}

export class TradingStore {
	private db: Database.Database;
	private walCheckpointTimer: NodeJS.Timeout | null = null;
	/** Cache of prepared statements keyed by SQL string. */
	private _stmtCache = new Map<string, Database.Statement>();

	/** Return a cached prepared statement, creating it on first use. */
	private _stmt(sql: string): Database.Statement {
		let stmt = this._stmtCache.get(sql);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this._stmtCache.set(sql, stmt);
		}
		return stmt;
	}

	constructor(config: TradingStoreConfig) {
		this.db = new Database(config.path);
		this.db.pragma("journal_mode = WAL");
		// synchronous=NORMAL is the recommended WAL pairing — durable across crashes
		// but skips full fsync per write. Matches memory/db.ts.
		this.db.pragma("synchronous = NORMAL");
		// Wait up to 8s for the writer lock before SQLITE_BUSY. Without this, the
		// live daemon + validation-daemon mirror + read-only monitors racing the
		// same file can fail with transient lock contention.
		this.db.pragma("busy_timeout = 8000");

		// Run any pending schema migrations on startup (safe no-op if up to date).
		// Migration 001 also inserts default safety settings via INSERT OR IGNORE.
		new MigrationRunner(this.db, TRADING_MIGRATIONS, "trading").runPending();

		// Periodic PASSIVE checkpoint so external readers (validation-daemon
		// mirror DB, monitors querying trading.db directly) see fresh data even
		// when the writer is idle. PASSIVE never blocks writers.
		const intervalMs = config.walCheckpointIntervalMs ?? 60_000;
		if (intervalMs > 0 && config.path !== ":memory:") {
			this.walCheckpointTimer = setInterval(() => {
				try {
					this.db.pragma("wal_checkpoint(PASSIVE)");
				} catch (err) {
					// Surface checkpoint failures at debug level — chronic failures
					// indicate an unbounded WAL file, which causes disk pressure.
					console.debug(
						"[trading-store] wal_checkpoint(PASSIVE) failed:",
						err instanceof Error ? err.message : err,
					);
				}
			}, intervalMs);
			this.walCheckpointTimer.unref?.();
		}
	}

	// ── Database access ──

	/**
	 * Returns the underlying SQLite database instance.
	 * Used by the JournalReporter to run complex cross-table queries.
	 */
	getDb(): Database.Database {
		return this.db;
	}

	// ── Positions ──

	openPosition(input: {
		symbol: string;
		side: "long" | "short";
		entryPrice: number;
		qty: number;
		stopLoss?: number;
		takeProfit?: number;
		trailingStopPct?: number;
		isPaper?: boolean; // true = paper trade (default), false = live trade
		feeRate?: number; // exchange fee rate (e.g. 0.00075 for 0.075%)
		executionVenue?: string | null;
		chain?: string | null;
		txSignature?: string | null;
		slippageBps?: number | null;
		routeJson?: string | null;
		/**
		 * Opt out of automatic paper_balances reconciliation. Set to true when
		 * the caller already debits/credits paper_balances itself (e.g. legacy
		 * handlers.ts paper trade flow that manages balances separately).
		 * Default: false — long paper opens debit quote and credit base.
		 */
		skipPaperBalanceReconcile?: boolean;
	}): Position {
		const id = randomUUID();
		const now = new Date().toISOString();
		const isPaperInt = (input.isPaper ?? true) ? 1 : 0;
		const entryFee = (input.feeRate ?? 0) * input.qty * input.entryPrice;
		const txn = this.db.transaction(() => {
			this._stmt(
				"INSERT INTO positions (id, symbol, side, entryPrice, qty, status, openedAt, stopLoss, takeProfit, trailingStopPct, trailingStopHigh, isPaper, entryFee, executionVenue, chain, txSignature, slippageBps, routeJson) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				id,
				input.symbol,
				input.side,
				input.entryPrice,
				input.qty,
				now,
				input.stopLoss ?? null,
				input.takeProfit ?? null,
				input.trailingStopPct ?? null,
				input.trailingStopPct ? input.entryPrice : null,
				isPaperInt,
				entryFee,
				input.executionVenue ?? null,
				input.chain ?? null,
				input.txSignature ?? null,
				input.slippageBps ?? null,
				input.routeJson ?? null,
			);
			if (isPaperInt === 1 && !input.skipPaperBalanceReconcile) {
				this._reconcilePaperOpen(input.symbol, input.side, input.qty, input.entryPrice);
			}
		});
		txn();
		return {
			id,
			symbol: input.symbol,
			side: input.side,
			entryPrice: input.entryPrice,
			qty: input.qty,
			currentPrice: null,
			pnl: null,
			status: "open",
			openedAt: now,
			closedAt: null,
		};
	}

	closePosition(
		id: string,
		exitPrice: number,
		feeRate?: number,
		options?: { skipPaperBalanceReconcile?: boolean },
	): Position | null {
		// Use IMMEDIATE transaction to acquire a write-lock up front,
		// preventing two concurrent callers from both reading the position
		// as "open" before either commits.
		const txn = this.db.transaction(() => {
			const pos = this._stmt("SELECT * FROM positions WHERE id = ? AND status = 'open'").get(id) as
				| Record<string, unknown>
				| undefined;
			if (!pos) return null;

			const qty = pos.qty as number;
			const entryPrice = pos.entryPrice as number;
			const side = pos.side as "long" | "short";
			const isPaperInt = (pos.isPaper as number | undefined) ?? 1;
			const rawPnl =
				side === "long" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
			const storedEntryFee = (pos.entryFee as number) ?? 0;
			const exitFee = (feeRate ?? 0) * qty * exitPrice;
			const pnl = rawPnl - storedEntryFee - exitFee;
			const now = new Date().toISOString();

			const result = this._stmt(
				"UPDATE positions SET currentPrice = ?, pnl = ?, exitFee = ?, status = 'closed', closedAt = ? WHERE id = ? AND status = 'open'",
			).run(exitPrice, pnl, exitFee, now, id);

			// Race condition: another caller already closed this position
			if (result.changes === 0) {
				console.warn(
					`[trading-store] closePosition skipped — position ${id} already closed (race condition avoided)`,
				);
				return null;
			}

			if (isPaperInt === 1 && !options?.skipPaperBalanceReconcile) {
				this._reconcilePaperClose(pos.symbol as string, side, qty, exitPrice);
			}

			return {
				id,
				symbol: pos.symbol as string,
				side,
				entryPrice,
				qty,
				currentPrice: exitPrice,
				pnl,
				status: "closed",
				openedAt: pos.openedAt as string,
				closedAt: now,
			} as Position;
		});
		return txn.immediate();
	}

	/**
	 * Close a fraction of an open position.
	 * Reduces qty on the existing position and creates a new closed record for the exited portion.
	 * Returns the closed portion as a Position, or null if the position doesn't exist.
	 */
	closePartial(
		id: string,
		exitQty: number,
		exitPrice: number,
		options?: { skipPaperBalanceReconcile?: boolean },
	): Position | null {
		// Use IMMEDIATE transaction to prevent concurrent partial closes
		// from both reading the same qty and double-reducing it.
		const txn = this.db.transaction(() => {
			const pos = this._stmt("SELECT * FROM positions WHERE id = ? AND status = 'open'").get(id) as
				| Record<string, unknown>
				| undefined;
			if (!pos) {
				console.warn(
					`[trading-store] closePartial skipped — position ${id} not found or already closed (race condition avoided)`,
				);
				return null;
			}

			const currentQty = pos.qty as number;
			const entryPrice = pos.entryPrice as number;
			const side = pos.side as "long" | "short";
			const isPaperInt = (pos.isPaper as number | undefined) ?? 1;

			// Clamp to available qty
			const closeQty = Math.min(exitQty, currentQty);
			if (closeQty <= 0) return null;

			const pnl =
				side === "long" ? (exitPrice - entryPrice) * closeQty : (entryPrice - exitPrice) * closeQty;
			const now = new Date().toISOString();
			const remainingQty = currentQty - closeQty;

			if (remainingQty <= 1e-12) {
				// Fully closed — same as closePosition (forward reconcile opt-out)
				return this.closePosition(id, exitPrice, undefined, options);
			}

			// Reduce qty on the existing position — guard on status='open'
			// so a concurrent full close can't be overwritten
			const result = this._stmt(
				"UPDATE positions SET qty = ? WHERE id = ? AND status = 'open'",
			).run(remainingQty, id);

			if (result.changes === 0) {
				console.warn(
					`[trading-store] closePartial UPDATE skipped — position ${id} was closed between SELECT and UPDATE (race condition avoided)`,
				);
				return null;
			}

			// Create a closed record for the exited portion
			const closedId = randomUUID();
			this._stmt(
				"INSERT INTO positions (id, symbol, side, entryPrice, qty, currentPrice, pnl, status, openedAt, closedAt, stopLoss, takeProfit, isPaper) VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)",
			).run(
				closedId,
				pos.symbol as string,
				side,
				entryPrice,
				closeQty,
				exitPrice,
				pnl,
				pos.openedAt as string,
				now,
				null,
				null,
				pos.isPaper ?? 1,
			);

			if (isPaperInt === 1 && !options?.skipPaperBalanceReconcile) {
				this._reconcilePaperClose(pos.symbol as string, side, closeQty, exitPrice);
			}

			return {
				id: closedId,
				symbol: pos.symbol as string,
				side,
				entryPrice,
				qty: closeQty,
				currentPrice: exitPrice,
				pnl,
				status: "closed",
				openedAt: pos.openedAt as string,
				closedAt: now,
			} as Position;
		});
		return txn.immediate();
	}

	/**
	 * Split a "BASE_QUOTE" symbol into its currency pair. Returns null for
	 * non-spot symbols (e.g. solana:* DEX symbols which the DEX-aware caller
	 * handles separately).
	 */
	private _extractSpotCurrencies(symbol: string): { base: string; quote: string } | null {
		const parts = symbol.split("_");
		if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
		return { base: parts[0], quote: parts[1] };
	}

	/**
	 * Debit quote and credit base when a paper long opens. Skips shorts
	 * (paper spot balances don't model margin) and non-spot symbols.
	 * Must be called inside a transaction.
	 */
	private _reconcilePaperOpen(
		symbol: string,
		side: "long" | "short",
		qty: number,
		entryPrice: number,
	): void {
		if (side !== "long") return;
		const cur = this._extractSpotCurrencies(symbol);
		if (!cur) return;
		this.updatePaperBalance(cur.quote, -qty * entryPrice);
		this.updatePaperBalance(cur.base, qty);
	}

	/**
	 * Credit quote and debit base when a paper long closes. Mirror of
	 * `_reconcilePaperOpen`. The base debit is clamped at zero by
	 * `updatePaperBalance` so positions opened pre-fix can't drive
	 * balances negative on close.
	 */
	private _reconcilePaperClose(
		symbol: string,
		side: "long" | "short",
		qty: number,
		exitPrice: number,
	): void {
		if (side !== "long") return;
		const cur = this._extractSpotCurrencies(symbol);
		if (!cur) return;
		this.updatePaperBalance(cur.quote, qty * exitPrice);
		this.updatePaperBalance(cur.base, -qty);
	}

	getOpenPositions(): Position[] {
		return this._stmt(
			"SELECT * FROM positions WHERE status = 'open' ORDER BY openedAt DESC",
		).all() as Position[];
	}

	getAllPositions(): Position[] {
		return this._stmt(
			"SELECT * FROM positions ORDER BY openedAt DESC LIMIT 50",
		).all() as Position[];
	}

	// ── Risk: stop-loss / take-profit ──

	getPositionsWithStops(): PositionWithStops[] {
		return this._stmt(
			"SELECT * FROM positions WHERE status = 'open' AND (stopLoss IS NOT NULL OR takeProfit IS NOT NULL OR trailingStopPct IS NOT NULL) ORDER BY openedAt DESC",
		).all() as PositionWithStops[];
	}

	/**
	 * Returns open positions that have NO stop-loss set (or an invalid one ≤ 0).
	 * Used by the safety sweep in trade_risk_status to flag unprotected positions.
	 *
	 * Note: a position can have a take-profit but still be missing a stop-loss —
	 * this query catches that case, unlike getPositionsWithStops() which includes
	 * positions that have only a take-profit.
	 */
	getOpenPositionsMissingStopLoss(): Position[] {
		return this._stmt(
			"SELECT * FROM positions WHERE status = 'open' AND (stopLoss IS NULL OR stopLoss <= 0) ORDER BY openedAt DESC",
		).all() as Position[];
	}

	updateStops(
		id: string,
		stops: {
			stopLoss?: number | null;
			takeProfit?: number | null;
			trailingStopPct?: number | null;
		},
	): boolean {
		const parts: string[] = [];
		const values: (number | null)[] = [];

		if (stops.stopLoss !== undefined) {
			parts.push("stopLoss = ?");
			values.push(stops.stopLoss);
		}
		if (stops.takeProfit !== undefined) {
			parts.push("takeProfit = ?");
			values.push(stops.takeProfit);
		}
		if (stops.trailingStopPct !== undefined) {
			parts.push("trailingStopPct = ?");
			values.push(stops.trailingStopPct);
			// Initialize trailing stop high to current entry if setting up trailing stop
			if (stops.trailingStopPct != null) {
				const pos = this._stmt("SELECT entryPrice FROM positions WHERE id = ?").get(id) as
					| { entryPrice: number }
					| undefined;
				if (pos) {
					parts.push("trailingStopHigh = ?");
					values.push(pos.entryPrice);
				}
			}
		}

		if (parts.length === 0) return false;
		values.push(id as unknown as number); // id for WHERE clause

		const result = this._stmt(
			`UPDATE positions SET ${parts.join(", ")} WHERE id = ? AND status = 'open'`,
		).run(...values);
		return result.changes > 0;
	}

	/** Update the live currentPrice and unrealized P&L on an open position. */
	updatePositionPrice(id: string, currentPrice: number, pnl: number): void {
		this._stmt(
			"UPDATE positions SET currentPrice = ?, pnl = ? WHERE id = ? AND status = 'open'",
		).run(currentPrice, pnl, id);
	}

	updateTrailingStopHigh(id: string, price: number): void {
		this._stmt("UPDATE positions SET trailingStopHigh = ? WHERE id = ? AND status = 'open'").run(
			price,
			id,
		);
	}

	/** Update stop-loss on an open position (e.g., move to breakeven after partial TP). */
	updateStopLoss(id: string, stopLoss: number): void {
		this._stmt("UPDATE positions SET stopLoss = ? WHERE id = ? AND status = 'open'").run(
			stopLoss,
			id,
		);
	}

	/** Enable or update trailing stop on an open position. */
	updateTrailingStop(id: string, trailingStopPct: number, currentPrice: number): void {
		this._stmt(
			"UPDATE positions SET trailingStopPct = ?, trailingStopHigh = ? WHERE id = ? AND status = 'open'",
		).run(trailingStopPct, currentPrice, id);
	}

	// ── Scale-out milestones ──

	/** Record that a profit milestone was hit for a position. */
	recordMilestoneHit(positionId: string, profitPct: number): void {
		this._stmt(
			"INSERT OR IGNORE INTO position_milestones (positionId, profitPct, firedAt) VALUES (?, ?, ?)",
		).run(positionId, profitPct, new Date().toISOString());
	}

	/** Get all milestone profitPct values that have fired for a given position. */
	getMilestoneHits(positionId: string): number[] {
		const rows = this._stmt("SELECT profitPct FROM position_milestones WHERE positionId = ?").all(
			positionId,
		) as { profitPct: number }[];
		return rows.map((r) => r.profitPct);
	}

	/**
	 * Load all milestone hits for all open positions.
	 * Returns a Map<positionId, Set<profitPct>> suitable for restoring
	 * StopMonitor.scaledOutMilestones on startup.
	 */
	getAllOpenMilestoneHits(): Map<string, Set<number>> {
		const rows = this._stmt(
			`SELECT pm.positionId, pm.profitPct
				 FROM position_milestones pm
				 INNER JOIN positions p ON p.id = pm.positionId
				 WHERE p.status = 'open'`,
		).all() as { positionId: string; profitPct: number }[];

		const result = new Map<string, Set<number>>();
		for (const row of rows) {
			const set = result.get(row.positionId) ?? new Set<number>();
			set.add(row.profitPct);
			result.set(row.positionId, set);
		}
		return result;
	}

	/** Clean up milestone records for closed positions. */
	cleanupClosedMilestones(): number {
		const result = this._stmt(
			`DELETE FROM position_milestones
				 WHERE positionId NOT IN (SELECT id FROM positions WHERE status = 'open')`,
		).run();
		return result.changes;
	}

	// ── Equity snapshots ──

	recordEquity(equity: number): void {
		if (!Number.isFinite(equity) || equity <= 0) {
			if (equity < 0) {
				console.warn("[trading-store] Ignoring negative equity snapshot:", equity);
			}
			return;
		}
		const timestamp = new Date().toISOString();
		this._stmt("INSERT OR REPLACE INTO equity_snapshots (timestamp, equity) VALUES (?, ?)").run(
			timestamp,
			equity,
		);
	}

	getPeakEquity(): number {
		const row = this._stmt(
			"SELECT MAX(equity) as peak FROM equity_snapshots WHERE equity > 0",
		).get() as { peak: number | null } | undefined;
		return row?.peak ?? 0;
	}

	/**
	 * Reset peak equity to current equity level, accepting the drawdown as a new baseline.
	 * This clears old equity snapshots above the new baseline so getPeakEquity() returns
	 * the reset level. Used after a drawdown recovery decision — the portfolio manager
	 * acknowledges the loss and resumes trading from the new baseline.
	 */
	resetPeakEquity(): { oldPeak: number; newBaseline: number } {
		// Wrap the read→delete→insert in a single transaction. Without this, a
		// concurrent recordEquity() could land a higher snapshot between
		// getLatestEquity() and the DELETE, leaving the peak above the new
		// baseline and re-poisoning the circuit breaker (see memories:
		// project_peak_equity_drift, project_re_poisoning_cycle, project_poisoned_peak_safety_net).
		const txn = this.db.transaction(() => {
			const oldRow = this._stmt(
				"SELECT MAX(equity) as peak FROM equity_snapshots WHERE equity > 0",
			).get() as { peak: number | null } | undefined;
			const oldPeak = oldRow?.peak ?? 0;
			const latestRow = this._stmt(
				"SELECT equity FROM equity_snapshots WHERE equity > 0 ORDER BY timestamp DESC LIMIT 1",
			).get() as { equity: number } | undefined;
			const current = latestRow?.equity ?? 0;
			const baseline = current > 0 ? current : oldPeak;
			this._stmt("DELETE FROM equity_snapshots WHERE equity > ?").run(baseline);
			this._stmt("INSERT OR REPLACE INTO equity_snapshots (timestamp, equity) VALUES (?, ?)").run(
				new Date().toISOString(),
				baseline,
			);
			return { oldPeak, newBaseline: baseline };
		});
		return txn();
	}

	/**
	 * Get the most recent equity snapshot value.
	 * Unlike getPeakEquity() (which returns the all-time high), this returns
	 * the latest recorded equity — the best proxy for current account value.
	 * Ignores non-positive rows so a stale zero snapshot cannot mask the last good point.
	 * Returns 0 if no positive snapshots exist.
	 */
	getLatestEquity(): number {
		const row = this._stmt(
			"SELECT equity FROM equity_snapshots WHERE equity > 0 ORDER BY timestamp DESC LIMIT 1",
		).get() as { equity: number } | undefined;
		return row?.equity ?? 0;
	}

	/**
	 * Operator-facing equity: latest snapshot, else peak, else configured initial.
	 * Use this when `getLatestEquity()` is 0 — that value is often a "no snapshot yet"
	 * sentinel, not literal account equity.
	 */
	resolveReportEquity(isPaper: boolean): number {
		const latest = this.getLatestEquity();
		if (latest > 0) return latest;
		const peak = this.getPeakEquity();
		if (peak > 0) return peak;
		return this.getInitialEquity(isPaper);
	}

	getEquityHistory(limit = 100): EquitySnapshot[] {
		return this._stmt(
			"SELECT * FROM equity_snapshots WHERE equity > 0 ORDER BY timestamp DESC LIMIT ?",
		).all(limit) as EquitySnapshot[];
	}

	/** Persist authenticated exchange NAV separately from paper/model equity. */
	recordLiveEquity(equity: number, source: string, timestamp = new Date().toISOString()): void {
		if (!Number.isFinite(equity) || equity <= 0 || !source.trim()) {
			throw new Error("live equity snapshot requires positive equity and source");
		}
		if (!Number.isFinite(Date.parse(timestamp))) {
			throw new Error("live equity snapshot timestamp is invalid");
		}
		this._stmt(
			"INSERT OR REPLACE INTO live_equity_snapshots (timestamp, equity, source) VALUES (?, ?, ?)",
		).run(timestamp, equity, source);
	}

	getLatestLiveEquitySnapshot(): LiveEquitySnapshot | null {
		const row = this._stmt(
			"SELECT timestamp, equity, source FROM live_equity_snapshots ORDER BY timestamp DESC LIMIT 1",
		).get() as LiveEquitySnapshot | undefined;
		return row ?? null;
	}

	getPeakLiveEquity(): number {
		const row = this._stmt("SELECT MAX(equity) AS peak FROM live_equity_snapshots").get() as
			| { peak: number | null }
			| undefined;
		return row?.peak ?? 0;
	}

	getInitialLiveEquity(): number {
		const row = this._stmt(
			"SELECT equity FROM live_equity_snapshots ORDER BY timestamp ASC LIMIT 1",
		).get() as { equity: number } | undefined;
		return row?.equity ?? 0;
	}

	getInitialEquity(isPaper = true): number {
		if (isPaper) {
			const n = Number(this.getSetting("virtual_balance_usd") || "1000");
			// Misconfigured "0" would poison daily-loss thresholds and risk copy.
			return Number.isFinite(n) && n > 0 ? n : 1000;
		}

		const explicit = Number(this.getSetting("live_initial_equity_usd") || "");
		if (Number.isFinite(explicit) && explicit > 0) return explicit;

		const earliest = this._stmt(
			"SELECT equity FROM equity_snapshots ORDER BY timestamp ASC LIMIT 1",
		).get() as { equity: number } | undefined;
		if (earliest?.equity && earliest.equity > 0) return earliest.equity;

		const latest = this.getLatestEquity();
		if (latest > 0) return latest;

		return Number(this.getSetting("virtual_balance_usd") || "1000");
	}

	getTradingState(): string {
		return this.getSetting("trading_status") || this.getSetting("trading_state") || "ACTIVE";
	}

	setTradingState(state: "ACTIVE" | "LOCKED" | "HALTED"): void {
		this.setSetting("trading_state", state);
		this.setSetting("trading_status", state);
	}

	logRiskMonitorEvent(input: {
		fromState: string;
		toState: string;
		reason: string;
		detailJson?: string | null;
	}): RiskMonitorEvent {
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		this._stmt(
			"INSERT INTO risk_monitor (id, createdAt, fromState, toState, reason, detailJson) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, createdAt, input.fromState, input.toState, input.reason, input.detailJson ?? null);
		return {
			id,
			createdAt,
			fromState: input.fromState,
			toState: input.toState,
			reason: input.reason,
			detailJson: input.detailJson ?? null,
		};
	}

	getRiskMonitorEvents(limit = 50): RiskMonitorEvent[] {
		return this._stmt("SELECT * FROM risk_monitor ORDER BY createdAt DESC LIMIT ?").all(
			limit,
		) as RiskMonitorEvent[];
	}

	// ── Price Alerts ──

	createAlert(input: {
		symbol: string;
		condition: "above" | "below";
		targetPrice: number;
	}): PriceAlert {
		// Dedup: check for existing active alert with same symbol+condition+targetPrice
		const existing = this._stmt(
			"SELECT id FROM price_alerts WHERE symbol = ? AND condition = ? AND targetPrice = ? AND triggered = 0 LIMIT 1",
		).get(input.symbol, input.condition, input.targetPrice) as { id: string } | undefined;
		if (existing) {
			// Return existing alert instead of creating a duplicate
			return this._stmt("SELECT * FROM price_alerts WHERE id = ?").get(existing.id) as PriceAlert;
		}

		const id = randomUUID();
		const now = new Date().toISOString();
		this._stmt(
			"INSERT INTO price_alerts (id, symbol, condition, targetPrice, triggered, createdAt) VALUES (?, ?, ?, ?, 0, ?)",
		).run(id, input.symbol, input.condition, input.targetPrice, now);
		return {
			id,
			symbol: input.symbol,
			condition: input.condition,
			targetPrice: input.targetPrice,
			triggered: false,
			createdAt: now,
			triggeredAt: null,
		};
	}

	getActiveAlerts(): PriceAlert[] {
		return (
			this._stmt(
				"SELECT * FROM price_alerts WHERE triggered = 0 ORDER BY createdAt DESC",
			).all() as (Omit<PriceAlert, "triggered"> & { triggered: number })[]
		).map((a) => ({ ...a, triggered: !!a.triggered }));
	}

	/** Price alerts that fired on or after `sinceIso` (for morning / overnight briefing). */
	getTriggeredAlertsSince(sinceIso: string): PriceAlert[] {
		return (
			this._stmt(
				`SELECT * FROM price_alerts
					 WHERE triggered = 1 AND triggeredAt IS NOT NULL AND triggeredAt >= ?
					 ORDER BY triggeredAt DESC`,
			).all(sinceIso) as (Omit<PriceAlert, "triggered"> & { triggered: number })[]
		).map((a) => ({ ...a, triggered: !!a.triggered }));
	}

	triggerAlert(id: string): void {
		this._stmt("UPDATE price_alerts SET triggered = 1, triggeredAt = ? WHERE id = ?").run(
			new Date().toISOString(),
			id,
		);
	}

	deleteAlert(id: string): boolean {
		const result = this._stmt("DELETE FROM price_alerts WHERE id = ?").run(id);
		return result.changes > 0;
	}

	// ── Trade Log ──

	logTrade(input: {
		symbol: string;
		side: "BUY" | "SELL";
		type: "MARKET" | "LIMIT";
		qty: number;
		price: number;
		orderId?: string;
		isPaper?: boolean; // true = paper trade (default), false = live trade
		executionVenue?: string | null;
		chain?: string | null;
		txSignature?: string | null;
		slippageBps?: number | null;
		routeJson?: string | null;
	}): TradeLog {
		const id = randomUUID();
		const now = new Date().toISOString();
		const total = input.qty * input.price;
		const isPaper = input.isPaper ?? true;
		const isPaperInt = isPaper ? 1 : 0;

		// Validate paper/live trade classification against orderId
		if (
			isPaper &&
			input.orderId &&
			input.orderId.length > 0 &&
			!looksLikePaperOrderId(input.orderId)
		) {
			console.warn(
				`[trading-store] Paper trade logged with real-looking orderId "${input.orderId}" ` +
					`for ${input.symbol} — possible paper/live classification error`,
			);
		}
		if (!isPaper && (!input.orderId || input.orderId.length === 0)) {
			console.warn(
				`[trading-store] Live trade logged WITHOUT orderId for ${input.symbol} ` +
					`— audit trail incomplete`,
			);
		}

		this._stmt(
			"INSERT INTO trade_log (id, symbol, side, type, qty, price, total, orderId, createdAt, isPaper, executionVenue, chain, txSignature, slippageBps, routeJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			id,
			input.symbol,
			input.side,
			input.type,
			input.qty,
			input.price,
			total,
			input.orderId ?? null,
			now,
			isPaperInt,
			input.executionVenue ?? null,
			input.chain ?? null,
			input.txSignature ?? null,
			input.slippageBps ?? null,
			input.routeJson ?? null,
		);
		return {
			id,
			symbol: input.symbol,
			side: input.side,
			type: input.type,
			qty: input.qty,
			price: input.price,
			total,
			orderId: input.orderId ?? null,
			createdAt: now,
			isPaper: input.isPaper ?? true,
			executionVenue: input.executionVenue ?? null,
			chain: input.chain ?? null,
			txSignature: input.txSignature ?? null,
			slippageBps: input.slippageBps ?? null,
			routeJson: input.routeJson ?? null,
		};
	}

	getRecentTrades(limit = 20): TradeLog[] {
		// Map SQLite integer (0/1) back to boolean for isPaper
		const rows = this._stmt("SELECT * FROM trade_log ORDER BY createdAt DESC LIMIT ?").all(
			limit,
		) as (Omit<TradeLog, "isPaper"> & { isPaper: number })[];
		return rows.map((r) => ({ ...r, isPaper: !!r.isPaper }));
	}

	/**
	 * Total USD spent on all trades (BUY and SELL) today (UTC).
	 * Pass isPaper=true to count only paper trades, false for only live trades.
	 * This keeps paper trading limits separate from live trading limits.
	 * Counts both entry costs (BUY/short-SELL) and exit proceeds/fees (SELL/short-BUY).
	 */
	getDailySpend(isPaper = true): number {
		// Use UTC date to be consistent regardless of local timezone
		const now = new Date();
		const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
		const paperFilter = isPaper ? 1 : 0;
		// Only count CEX trades (symbol contains '_', e.g. BTC_USDT).
		// Exclude DEX/arb practice trades (symbol contains '/' or ':') which
		// have their own budget and should not block CEX signal execution.
		const row = this._stmt(
			"SELECT COALESCE(SUM(total), 0) as total FROM trade_log WHERE isPaper = ? AND createdAt LIKE ? AND symbol LIKE '%\\_%' ESCAPE '\\'",
		).get(paperFilter, `${today}%`) as { total: number };
		return row.total;
	}

	/**
	 * Solana DEX (`solana:*`) notional summed for today (UTC), same paper/live split as getDailySpend.
	 * Used with getDailySpend to enforce daily_limit_usd across CEX + Jupiter paths.
	 */
	getDexSolanaDailySpend(isPaper = true): number {
		const now = new Date();
		const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
		const paperFilter = isPaper ? 1 : 0;
		const row = this._stmt(
			"SELECT COALESCE(SUM(total), 0) as total FROM trade_log WHERE isPaper = ? AND createdAt LIKE ? AND symbol LIKE 'solana:%'",
		).get(paperFilter, `${today}%`) as { total: number };
		return row.total;
	}

	// ── Risk: consecutive losses ──

	/**
	 * Count consecutive losing closed positions (newest first).
	 *
	 * When `isPaper` is provided, only counts positions in that mode.
	 * This prevents paper losses from tripping live circuit breakers and
	 * vice versa. When omitted, counts all positions (legacy behavior)
	 * and filters by the current paper_mode setting.
	 */
	getConsecutiveLosses(isPaper?: boolean): number {
		// Default to current mode so the right breaker fires
		const modeFilter = isPaper ?? this.getSetting("paper_mode") !== "false";
		const modeInt = modeFilter ? 1 : 0;
		// Use rowid as tiebreaker when multiple positions close at the same timestamp
		// (common in tests, also possible in production during batch closes).
		const recent = this._stmt(
			"SELECT pnl FROM positions WHERE status = 'closed' AND isPaper = ? ORDER BY closedAt DESC, rowid DESC LIMIT 20",
		).all(modeInt) as { pnl: number | null }[];
		let count = 0;
		for (const row of recent) {
			if (row.pnl != null && row.pnl < 0) {
				count++;
			} else {
				break; // Streak broken by a win or breakeven
			}
		}
		return count;
	}

	getTradeCount(): number {
		const row = this._stmt(
			"SELECT COUNT(*) as count FROM positions WHERE status = 'closed'",
		).get() as { count: number };
		return row.count;
	}

	getWinRate(): number {
		const rows = this._stmt(
			"SELECT pnl FROM positions WHERE status = 'closed' AND pnl IS NOT NULL",
		).all() as { pnl: number }[];
		if (rows.length === 0) return 0;
		const winners = rows.filter((r) => r.pnl > 0).length;
		return (winners / rows.length) * 100;
	}

	// ── Settings ──

	getSetting(key: string): string | undefined {
		const row = this._stmt("SELECT value FROM settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	setSetting(key: string, value: string): void {
		this._stmt("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
	}

	// ── Paper portfolio (virtual balances) ──

	/**
	 * Initialize the paper portfolio with starting USDT balance.
	 * Only sets the balance if USDT has never been set before.
	 * Called automatically on startup.
	 */
	initPaperPortfolio(): void {
		const startingUsd = Number(this.getSetting("virtual_balance_usd") || "1000");
		this._stmt("INSERT OR IGNORE INTO paper_balances (currency, balance) VALUES ('USDT', ?)").run(
			startingUsd,
		);
	}

	/** Get the balance of a single currency in the paper portfolio. Returns 0 if not held. */
	getPaperBalance(currency: string): number {
		const row = this._stmt("SELECT balance FROM paper_balances WHERE currency = ?").get(currency) as
			| { balance: number }
			| undefined;
		return row?.balance ?? 0;
	}

	/** Get all non-zero currency balances in the paper portfolio. */
	getAllPaperBalances(): PaperBalance[] {
		return this._stmt(
			"SELECT currency, balance FROM paper_balances WHERE balance > 0 ORDER BY currency",
		).all() as PaperBalance[];
	}

	/**
	 * Adjust a currency balance by delta (positive = credit, negative = debit).
	 * Creates the row if it doesn't exist yet (e.g. first time holding a coin).
	 *
	 * Safety: clamps the resulting balance at zero. paper_balances rows must
	 * never go negative — a debit larger than the held balance produces 0,
	 * not a negative number. Closing a position whose open didn't credit
	 * (legacy state, ghost balances) can't drive the asset below zero.
	 */
	updatePaperBalance(currency: string, delta: number): void {
		const txn = this.db.transaction(() => {
			const row = this._stmt("SELECT balance FROM paper_balances WHERE currency = ?").get(
				currency,
			) as { balance: number } | undefined;
			const next = Math.max((row?.balance ?? 0) + delta, 0);
			this._stmt(
				"INSERT INTO paper_balances (currency, balance) VALUES (?, ?) " +
					"ON CONFLICT(currency) DO UPDATE SET balance = excluded.balance",
			).run(currency, next);
		});
		txn();
	}

	/**
	 * Reset the paper portfolio to its starting balance.
	 *
	 * Wipes paper balances, paper positions, paper trade log, equity history,
	 * and circuit-breaker peak/trip state in one transaction. Equity history
	 * and CB state must reset together: leaving stale `equity_snapshots` rows
	 * lets `MAX(equity_snapshots)` re-poison the drawdown CB peak the next
	 * time the daemon syncs from disk (the recurring phantom-equity bug).
	 *
	 * If `mirrorDbPath` is supplied, the same reset is applied to a second
	 * trading.db file (the validation-daemon's mirror). Daemons writing to
	 * the same file are coordinated by SQLite WAL; this is safe to call from
	 * the live daemon while the validation daemon is also running.
	 */
	resetPaperPortfolio(options?: { mirrorDbPath?: string | null | undefined }): void {
		const startingUsd = Number(this.getSetting("virtual_balance_usd") || "1000");
		TradingStore.applyPaperReset(this.db, startingUsd);
		const mirrorPath = options?.mirrorDbPath;
		if (mirrorPath && mirrorPath !== ":memory:") {
			let mirrorDb: Database.Database | null = null;
			try {
				mirrorDb = new Database(mirrorPath);
				mirrorDb.pragma("journal_mode = WAL");
				mirrorDb.pragma("synchronous = NORMAL");
				mirrorDb.pragma("busy_timeout = 8000");
				TradingStore.applyPaperReset(mirrorDb, startingUsd);
			} finally {
				mirrorDb?.close();
			}
		}
	}

	private static applyPaperReset(db: Database.Database, startingUsd: number): void {
		const nowIso = new Date().toISOString();
		const reset = db.transaction(() => {
			db.prepare("DELETE FROM paper_balances").run();
			db.prepare("INSERT INTO paper_balances (currency, balance) VALUES ('USDT', ?)").run(
				startingUsd,
			);
			db.prepare("DELETE FROM positions WHERE isPaper = 1").run();
			db.prepare("DELETE FROM trade_log WHERE isPaper = 1").run();
			db.prepare("DELETE FROM equity_snapshots").run();
			db.prepare(
				`UPDATE circuit_breaker_state
				   SET trip_count = 0,
				       is_tripped = 0,
				       trip_reason = NULL,
				       tripped_at = NULL,
				       cooldown_until = NULL,
				       peak_equity = ?,
				       consecutive_losses = 0,
				       last_updated = ?`,
			).run(startingUsd, nowIso);
		});
		reset();
	}

	/**
	 * Sanity-check paper-mode equity state to catch poison-cycle bugs early.
	 * Returns human-readable warnings; emits nothing on a clean state.
	 *
	 * Triggers:
	 *   - drawdown CB peak_equity > paper USDT * 2 and no open paper
	 *     positions ⇒ peak almost certainly stale (the phantom-equity
	 *     pattern documented in project_phantom_equity_drain).
	 *   - dead `shadow_equity` setting key still present ⇒ leftover from
	 *     pre-rewrite state; self-healed by DELETE (no readers in codebase).
	 *     Live 2026-07-25: warn-only left the key in place and thrash-warned
	 *     every daemon boot.
	 */
	validatePaperEquityInvariants(): string[] {
		const warnings: string[] = [];
		const usdt = this.getPaperBalance("USDT");
		const openPaper = this._stmt(
			"SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND isPaper = 1",
		).get() as { c: number };
		const cbRow = this._stmt(
			"SELECT peak_equity FROM circuit_breaker_state WHERE breaker_type = 'drawdown'",
		).get() as { peak_equity: number } | undefined;
		const peak = cbRow?.peak_equity ?? 0;
		if (openPaper.c === 0 && peak > usdt * 2 && peak > 0) {
			warnings.push(
				`drawdown CB peak_equity=$${peak.toFixed(2)} but paper USDT=$${usdt.toFixed(2)} with 0 open positions — likely stale peak from before a reset (phantom-equity pattern). Run trade_paper_reset to rebase.`,
			);
		}
		const orphanShadowEquity = this._stmt(
			"SELECT 1 FROM settings WHERE key = 'shadow_equity' LIMIT 1",
		).get();
		if (orphanShadowEquity) {
			// Self-heal once so subsequent boots stay quiet.
			this._stmt("DELETE FROM settings WHERE key = 'shadow_equity'").run();
			warnings.push(
				"deleted orphan settings.shadow_equity (pre-rewrite shadow-mode leftover; no readers)",
			);
		}
		return warnings;
	}

	// ── Daily P&L summary ──

	/**
	 * Build a daily P&L summary for a given UTC date (format: YYYY-MM-DD).
	 * Looks at positions that were CLOSED on that date.
	 */
	getDailyPnLSummary(date: string, isPaper: boolean): DailyPnLSummary {
		const paperFilter = isPaper ? 1 : 0;

		// Closed positions for the given date and mode
		const rawPositions = this._stmt(
			"SELECT * FROM positions WHERE status = 'closed' AND closedAt LIKE ? AND isPaper = ? ORDER BY closedAt ASC",
		).all(`${date}%`, paperFilter) as (Position & {
			isPaper: number;
			entryPrice: number;
			pnl: number;
			closedAt: string;
		})[];

		const positions: DailyPnLPosition[] = rawPositions.map((p) => {
			const cost = p.entryPrice * p.qty;
			const pnlPct = cost > 0 ? (p.pnl / cost) * 100 : 0;
			return {
				positionId: p.id,
				symbol: p.symbol,
				side: p.side,
				entryPrice: r2(p.entryPrice),
				exitPrice: r2(p.currentPrice ?? 0),
				qty: p.qty,
				pnl: r2(p.pnl ?? 0),
				pnlPct: r2(pnlPct),
				openedAt: p.openedAt,
				closedAt: p.closedAt ?? "",
			};
		});

		const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
		const winners = positions.filter((p) => p.pnl > 0);
		const losers = positions.filter((p) => p.pnl < 0);
		const winRate = positions.length > 0 ? (winners.length / positions.length) * 100 : 0;

		const summary: DailyPnLSummary = {
			date,
			mode: isPaper ? "PAPER" : "LIVE",
			totalPnl: r2(totalPnl),
			totalTrades: positions.length,
			winningTrades: winners.length,
			losingTrades: losers.length,
			winRate: r2(winRate),
			positions,
		};

		// In paper mode, include the virtual portfolio state
		if (isPaper) {
			const startingUsd = Number(this.getSetting("virtual_balance_usd") || "1000");
			const balances = this.getAllPaperBalances();
			const currentUsd = this.getPaperBalance("USDT");
			const totalReturn = currentUsd - startingUsd;
			summary.paperPortfolio = {
				balances,
				startingUsd,
				currentUsd: r2(currentUsd),
				totalReturn: r2(totalReturn),
				totalReturnPct: r2((totalReturn / startingUsd) * 100),
			};
		}

		return summary;
	}

	// ── Backtest Results ──

	/**
	 * Save a completed backtest result to the database.
	 * The full result is stored in resultJson so we can reconstruct it later.
	 * Returns the generated ID for the stored record.
	 */
	saveBacktestResult(input: {
		strategy: string;
		symbol: string;
		timeframe: string;
		startDate: string;
		endDate: string;
		startingEquity: number;
		finalEquity: number;
		totalPnl: number;
		totalReturnPct: number;
		winRate: number;
		sharpeRatio: number;
		maxDrawdownPct: number;
		totalTrades: number;
		resultJson: string;
	}): string {
		const id = randomUUID();
		const now = new Date().toISOString();
		this._stmt(`
			INSERT INTO backtest_results
				(id, strategy, symbol, timeframe, startDate, endDate,
				 startingEquity, finalEquity, totalPnl, totalReturnPct,
				 winRate, sharpeRatio, maxDrawdownPct, totalTrades, resultJson, createdAt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			input.strategy,
			input.symbol,
			input.timeframe,
			input.startDate,
			input.endDate,
			input.startingEquity,
			input.finalEquity,
			input.totalPnl,
			input.totalReturnPct,
			input.winRate,
			input.sharpeRatio,
			input.maxDrawdownPct,
			input.totalTrades,
			input.resultJson,
			now,
		);
		return id;
	}

	/**
	 * List recent backtest summaries (newest first).
	 * Pass strategy/symbol to filter, or leave blank for all.
	 */
	listBacktestResults(
		opts: { strategy?: string; symbol?: string; limit?: number } = {},
	): BacktestSummary[] {
		const { strategy, symbol, limit = 20 } = opts;
		let query = "SELECT * FROM backtest_results";
		const params: unknown[] = [];

		if (strategy || symbol) {
			const conditions: string[] = [];
			if (strategy) {
				conditions.push("strategy = ?");
				params.push(strategy);
			}
			if (symbol) {
				conditions.push("symbol = ?");
				params.push(symbol);
			}
			query += ` WHERE ${conditions.join(" AND ")}`;
		}

		query += " ORDER BY createdAt DESC LIMIT ?";
		params.push(limit);

		return this._stmt(query).all(...params) as BacktestSummary[];
	}

	/**
	 * Fetch a single stored backtest result by its ID.
	 * Returns null if not found.
	 */
	getBacktestResult(id: string): BacktestSummary | null {
		return (
			(this._stmt("SELECT * FROM backtest_results WHERE id = ?").get(
				id,
			) as BacktestSummary | null) ?? null
		);
	}

	// ── Order Idempotency ──

	/**
	 * Check whether an order with this idempotency key was already submitted.
	 * Returns the existing record if found (and not expired), or null.
	 *
	 * The key is a SHA-256 hash of (symbol + side + qty + type + time-window).
	 * Callers must generate this before attempting to submit an order.
	 */
	getSubmittedOrder(key: string): {
		key: string;
		orderId: string | null;
		status: string;
		symbol: string;
		createdAt: string;
	} | null {
		const row = this._stmt("SELECT * FROM submitted_orders WHERE key = ?").get(key) as
			| { key: string; orderId: string | null; status: string; symbol: string; createdAt: string }
			| undefined;
		if (!row) return null;

		// Check 24-hour TTL — expired orders are treated as non-existent
		const age = Date.now() - new Date(row.createdAt).getTime();
		if (age > 24 * 60 * 60 * 1000) {
			this._stmt("DELETE FROM submitted_orders WHERE key = ?").run(key);
			return null;
		}

		return row;
	}

	/**
	 * Record a new order submission attempt with status 'pending'.
	 * Returns false if the key already exists (duplicate detected).
	 */
	markOrderSubmitted(key: string, symbol: string): boolean {
		try {
			this._stmt(
				"INSERT INTO submitted_orders (key, status, symbol, createdAt) VALUES (?, 'pending', ?, ?)",
			).run(key, symbol, new Date().toISOString());
			return true;
		} catch (err) {
			// Expected: UNIQUE constraint violation → duplicate order; unexpected errors logged
			if (!(err instanceof Error && err.message.includes("UNIQUE"))) {
				console.warn(
					"[trading-store] markOrderSubmitted unexpected error:",
					err instanceof Error ? err.message : err,
				);
			}
			return false;
		}
	}

	/**
	 * Update a submitted order's status and optionally set the exchange orderId.
	 * Called after order confirmation ('confirmed') or failure ('failed').
	 */
	updateSubmittedOrder(
		key: string,
		status: "confirmed" | "failed" | "cancelled",
		orderId?: string,
	): void {
		this._stmt("UPDATE submitted_orders SET status = ?, orderId = ? WHERE key = ?").run(
			status,
			orderId ?? null,
			key,
		);
	}

	listSubmittedOrdersByStatus(status: "pending" | "confirmed" | "failed" | "cancelled"): Array<{
		key: string;
		orderId: string | null;
		status: string;
		symbol: string;
		createdAt: string;
	}> {
		return this._stmt(
			"SELECT * FROM submitted_orders WHERE status = ? ORDER BY createdAt DESC",
		).all(status) as Array<{
			key: string;
			orderId: string | null;
			status: string;
			symbol: string;
			createdAt: string;
		}>;
	}

	cancelPendingSubmittedOrders(): number {
		const result = this._stmt(
			"UPDATE submitted_orders SET status = 'cancelled' WHERE status = 'pending'",
		).run();
		return result.changes;
	}

	/**
	 * Clean up expired submitted orders (older than 24 hours).
	 * Called periodically to prevent table bloat.
	 */
	cleanupExpiredOrders(): number {
		const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const result = this._stmt("DELETE FROM submitted_orders WHERE createdAt < ?").run(cutoff);
		return result.changes;
	}

	// ── Opus grind log ──

	logOpusGrind(entry: {
		id: string;
		startedAt: string;
		completedAt?: string;
		durationMs?: number;
		status: string;
		marketRegime?: string;
		bestOpportunity?: string;
		portfolioEquity?: number;
		portfolioPnl?: number;
		drawdownPct?: number;
		riskViolations?: number;
		tradeExecuted?: number;
		alertsSet?: number;
		memoriesStored?: number;
		parameterTweaks?: number;
		stepsCompleted?: number;
		stepsSkipped?: number;
		actionsTaken?: number;
		summaryJson?: string;
		errorMessage?: string;
	}): void {
		if (entry.status === "completed") {
			const raw = entry.summaryJson;
			if (raw == null || String(raw).trim() === "") {
				throw new Error("opus_grind_log: status 'completed' requires non-empty summaryJson");
			}
		}
		this._stmt(
			`INSERT INTO opus_grind_log (
					id, startedAt, completedAt, durationMs, status,
					marketRegime, bestOpportunity, portfolioEquity, portfolioPnl, drawdownPct,
					riskViolations, tradeExecuted, alertsSet, memoriesStored, parameterTweaks,
					stepsCompleted, stepsSkipped, actionsTaken, summaryJson, errorMessage
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			entry.id,
			entry.startedAt,
			entry.completedAt ?? null,
			entry.durationMs ?? null,
			entry.status,
			entry.marketRegime ?? null,
			entry.bestOpportunity ?? null,
			entry.portfolioEquity ?? null,
			entry.portfolioPnl ?? null,
			entry.drawdownPct ?? null,
			entry.riskViolations ?? 0,
			entry.tradeExecuted ?? 0,
			entry.alertsSet ?? 0,
			entry.memoriesStored ?? 0,
			entry.parameterTweaks ?? 0,
			entry.stepsCompleted ?? 0,
			entry.stepsSkipped ?? 0,
			entry.actionsTaken ?? 0,
			entry.summaryJson ?? null,
			entry.errorMessage ?? null,
		);
	}

	getRecentOpusGrinds(limit = 24): Array<Record<string, unknown>> {
		return this._stmt("SELECT * FROM opus_grind_log ORDER BY startedAt DESC LIMIT ?").all(
			limit,
		) as Array<Record<string, unknown>>;
	}

	close(): void {
		if (this.walCheckpointTimer) {
			clearInterval(this.walCheckpointTimer);
			this.walCheckpointTimer = null;
		}
		// Finalize all cached prepared statements before closing
		this._stmtCache.clear();
		this.db.pragma("wal_checkpoint(TRUNCATE)");
		this.db.close();
	}
}

// Round to 2 decimal places — used for display in P&L reports
function r2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Returns true if the orderId looks like a paper/simulated trade ID.
 * Paper trade IDs are typically UUIDs (v4) generated by randomUUID() or
 * strings prefixed with "paper-" or "sim-".
 */
function looksLikePaperOrderId(orderId: string): boolean {
	// UUID v4 pattern: 8-4-4-4-12 hex chars
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuidPattern.test(orderId)) return true;
	// Common paper/sim prefixes
	if (orderId.startsWith("paper-") || orderId.startsWith("paper:") || orderId.startsWith("sim-"))
		return true;
	return false;
}
