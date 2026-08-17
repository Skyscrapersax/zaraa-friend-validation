/**
 * LeaderboardStore — tracks per-strategy performance over time.
 *
 * Uses the same SQLite database as TradeJournal so all strategy_trades data
 * is available without a separate file. It adds one new table:
 *   strategy_performance_snapshots — one row per strategy per calendar day
 *
 * Key concepts for beginners:
 *   - "Sharpe ratio" measures return vs. risk. Higher = better risk-adjusted gains.
 *   - "Max drawdown" is the biggest loss from a peak in cumulative P&L.
 *   - "Win rate" is the % of closed trades that ended with a positive P&L.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

/** How far back to look when computing metrics. */
export type LeaderboardPeriod = "7d" | "30d" | "90d" | "all";

/** Performance metrics for a single strategy in a given period. */
export interface StrategyMetrics {
	/** 1-based position in the ranked table (best to worst by total P&L). */
	rank: number;
	/** Strategy name, e.g. "trend-following". */
	strategyName: string;
	/** Number of fully closed trades in the period. */
	numTrades: number;
	/** Fraction of trades that made money (0–1, e.g. 0.6 = 60%). */
	winRate: number;
	/** Sum of all trade P&Ls in the period (USD). */
	totalPnl: number;
	/** Average P&L per trade (USD). */
	avgReturn: number;
	/** Maximum peak-to-trough decline in cumulative P&L (USD, negative or 0). */
	maxDrawdown: number;
	/** Risk-adjusted return — annualised Sharpe ratio (higher is better). */
	sharpeRatio: number;
	/**
	 * Daily P&L series for the sparkline chart.
	 * Always covers the last 30 calendar days, using 0 for days with no trades.
	 */
	pnlHistory: number[];
}

/** A single recent closing loss — feeds the autonomy loop's lesson generator. */
export interface RecentClosedLoss {
	symbol: string;
	strategy: string;
	/** Realised P&L in USD (always < 0 for these rows). */
	pnl: number;
}

/** Per-symbol rolling performance — feeds the lesson generator. winRate is 0–1. */
export interface SymbolPerformance {
	symbol: string;
	trades: number;
	wins: number;
	losses: number;
	winRate: number;
	totalPnl: number;
}

/** A daily snapshot saved to the database for historical trend analysis. */
export interface DailySnapshot {
	id: string;
	strategyName: string;
	/** ISO date string YYYY-MM-DD. */
	date: string;
	numTrades: number;
	winRate: number;
	totalPnl: number;
	avgReturn: number;
	maxDrawdown: number;
	sharpeRatio: number;
	createdAt: string;
}

// ── LeaderboardStore ─────────────────────────────────────────────────────────

export class LeaderboardStore {
	private db: Database.Database;
	/**
	 * When true, shadow trades (isShadow=1) are included in leaderboard/snapshot
	 * queries. Set via `setIncludeShadow()` when the runtime is in paperMode —
	 * paper trades are tagged isShadow=1 by ShadowModeExecutor, and excluding
	 * them leaves the leaderboard empty for the entire paper book. The behaviour
	 * is opt-in so live mode (real capital) keeps the strict exclusion that
	 * prevents shadow simulations from polluting real performance metrics.
	 */
	private includeShadow = false;

	/**
	 * @param db - The same better-sqlite3 Database instance used by TradeJournal.
	 *             Sharing the instance avoids locking conflicts and keeps all
	 *             trading data in one file (trade-journal.db).
	 */
	constructor(db: Database.Database) {
		this.db = db;
		this.initTables();
	}

	/** Expose the underlying DB so adjacent stores (e.g. StrategyRanker) can
	 * read from the same trade-journal file without re-opening it. */
	getDb(): Database.Database {
		return this.db;
	}

	/** When `on` is true, shadow trades are included in leaderboard/snapshot
	 * queries — required when paperMode is true (paper trades are shadow). */
	setIncludeShadow(on: boolean): void {
		this.includeShadow = on;
	}

	private shadowFilter(): string {
		return this.includeShadow ? "" : " AND isShadow = 0";
	}

	// ── Schema ──────────────────────────────────────────────────────────────

	private initTables(): void {
		this.db.exec(`
			-- Stores one performance snapshot per strategy per day.
			-- Snapshotted after each trade closes so history accumulates over time.
			CREATE TABLE IF NOT EXISTS strategy_performance_snapshots (
				id          TEXT PRIMARY KEY,
				strategyName TEXT NOT NULL,
				date        TEXT NOT NULL,    -- YYYY-MM-DD (UTC)
				numTrades   INTEGER NOT NULL,
				winRate     REAL NOT NULL,
				totalPnl    REAL NOT NULL,
				avgReturn   REAL NOT NULL,
				maxDrawdown REAL NOT NULL,
				sharpeRatio REAL NOT NULL,
				createdAt   TEXT NOT NULL,
				UNIQUE(strategyName, date)    -- one row per strategy per day
			);
			CREATE INDEX IF NOT EXISTS idx_snapshots_strategy_date
				ON strategy_performance_snapshots (strategyName, date DESC);
		`);
	}

	// ── Public API ───────────────────────────────────────────────────────────

	/**
	 * Compute and return the leaderboard for all strategies in the given period.
	 * Strategies are ranked by total P&L (highest first).
	 *
	 * @param period - Time window to include. "all" uses all historical trades.
	 */
	getLeaderboard(period: LeaderboardPeriod = "30d"): StrategyMetrics[] {
		// Convert period to a SQLite datetime expression for WHERE filtering.
		const since = periodToSince(period);

		// 1. Get per-strategy aggregate stats from closed strategy_trades.
		const rows = this.getAggregates(since);

		if (rows.length === 0) return [];

		// 2. For each strategy, compute Sharpe ratio (needs individual trades).
		// 3. For each strategy, compute max drawdown (needs ordered trades).
		// 4. For each strategy, build the 30-day daily P&L sparkline.
		const metrics: StrategyMetrics[] = rows.map((row) => {
			const trades = this.getClosedTrades(row.strategyName, since);
			const sharpe = computeSharpe(trades.map((t) => t.pnl));
			const maxDrawdown = computeMaxDrawdown(trades.map((t) => t.pnl));
			const pnlHistory = this.getDailyPnlHistory(row.strategyName, 30);

			return {
				rank: 0,             // filled in below after sorting
				strategyName: row.strategyName,
				numTrades: row.numTrades,
				winRate: row.winRate,
				totalPnl: round2(row.totalPnl),
				avgReturn: round2(row.numTrades > 0 ? row.totalPnl / row.numTrades : 0),
				maxDrawdown: round2(maxDrawdown),
				sharpeRatio: round2(sharpe),
				pnlHistory,
			};
		});

		// Sort best→worst by total P&L and assign ranks.
		metrics.sort((a, b) => b.totalPnl - a.totalPnl);
		metrics.forEach((m, i) => { m.rank = i + 1; });

		return metrics;
	}

	/**
	 * Take a performance snapshot for ALL known strategies as of today.
	 * Call this after any trade closes. Uses UPSERT so calling it multiple
	 * times in the same day just overwrites the existing row.
	 */
	snapshotToday(): void {
		const today = utcDateString();
		// Get every strategy that has at least one closed trade.
		// In live mode shadow trades (isShadow = 1) are excluded so the leaderboard
		// reflects only outcomes that affected real or paper capital. In paperMode
		// every paper trade is itself marked isShadow=1 (ShadowModeExecutor), so we
		// flip the filter via includeShadow to avoid an empty leaderboard.
		const strategies = (this.db
			.prepare(
				`SELECT DISTINCT strategyName FROM strategy_trades WHERE exitedAt IS NOT NULL${this.shadowFilter()}`,
			)
			.all() as { strategyName: string }[])
			.map((r) => r.strategyName);

		for (const name of strategies) {
			const trades = this.getClosedTrades(name, null); // all-time for snapshot
			if (trades.length === 0) continue;

			const wins = trades.filter((t) => t.pnl > 0).length;
			const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
			const winRate = wins / trades.length;
			const avgReturn = totalPnl / trades.length;
			const maxDrawdown = computeMaxDrawdown(trades.map((t) => t.pnl));
			const sharpeRatio = computeSharpe(trades.map((t) => t.pnl));

			this.db
				.prepare(`
					INSERT INTO strategy_performance_snapshots
						(id, strategyName, date, numTrades, winRate, totalPnl, avgReturn, maxDrawdown, sharpeRatio, createdAt)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(strategyName, date) DO UPDATE SET
						numTrades   = excluded.numTrades,
						winRate     = excluded.winRate,
						totalPnl    = excluded.totalPnl,
						avgReturn   = excluded.avgReturn,
						maxDrawdown = excluded.maxDrawdown,
						sharpeRatio = excluded.sharpeRatio,
						createdAt   = excluded.createdAt
				`)
				.run(
					randomUUID(), name, today,
					trades.length, round2(winRate), round2(totalPnl),
					round2(avgReturn), round2(maxDrawdown), round2(sharpeRatio),
					new Date().toISOString(),
				);
		}
	}

	/**
	 * Retrieve stored daily snapshots for one strategy (for history charting).
	 * Returns at most `days` rows, most-recent last.
	 */
	getSnapshots(strategyName: string, days = 30): DailySnapshot[] {
		return this.db
			.prepare(`
				SELECT * FROM strategy_performance_snapshots
				WHERE strategyName = ?
				ORDER BY date ASC
				LIMIT ?
			`)
			.all(strategyName, days) as DailySnapshot[];
	}

	/**
	 * Recent closed losing trades (pnl < 0), most-recent-first, for the autonomy
	 * loop's trading-loss lesson generator. Each row carries the (strategy, symbol)
	 * pairing the lesson analyzer groups on to detect recurring mistakes.
	 *
	 * Shadow-aware via `shadowFilter()`: in paperMode every paper trade is tagged
	 * isShadow=1, so excluding shadow would hide the entire paper book from the
	 * learning loop. Live mode keeps the strict isShadow=0 exclusion.
	 */
	getRecentClosedLosses(limit = 50): RecentClosedLoss[] {
		const rows = this.db
			.prepare(`
				SELECT symbol, strategyName, pnl
				FROM strategy_trades
				WHERE exitedAt IS NOT NULL AND pnl < 0${this.shadowFilter()}
				ORDER BY exitedAt DESC
				LIMIT ?
			`)
			.all(limit) as { symbol: string; strategyName: string; pnl: number }[];
		return rows.map((r) => ({ symbol: r.symbol, strategy: r.strategyName, pnl: r.pnl }));
	}

	/**
	 * Per-symbol rolling performance over `period`, for the trading-loss lesson
	 * generator's persistent-losing-symbol signal. winRate is 0–1.
	 *
	 * Shadow-aware (see getRecentClosedLosses) — sources the same strategy_trades
	 * universe as getLeaderboard() so per-symbol and per-strategy views agree.
	 */
	getSymbolPerformance(period: LeaderboardPeriod = "30d"): SymbolPerformance[] {
		const since = periodToSince(period);
		const whereClause = since
			? `WHERE exitedAt IS NOT NULL${this.shadowFilter()} AND exitedAt >= ?`
			: `WHERE exitedAt IS NOT NULL${this.shadowFilter()}`;
		const sql = `
			SELECT
				symbol,
				COUNT(*) AS trades,
				COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
				COALESCE(SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
				COALESCE(SUM(pnl), 0) AS totalPnl
			FROM strategy_trades
			${whereClause}
			GROUP BY symbol
		`;
		const rows = (since
			? this.db.prepare(sql).all(since)
			: this.db.prepare(sql).all()) as {
			symbol: string;
			trades: number;
			wins: number;
			losses: number;
			totalPnl: number;
		}[];
		return rows.map((r) => ({
			symbol: r.symbol,
			trades: r.trades,
			wins: r.wins,
			losses: r.losses,
			winRate: r.trades > 0 ? r.wins / r.trades : 0,
			totalPnl: round2(r.totalPnl),
		}));
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	/** Fetch per-strategy aggregate stats for closed trades since `since`. */
	private getAggregates(since: string | null): {
		strategyName: string;
		numTrades: number;
		winRate: number;
		totalPnl: number;
	}[] {
		const whereClause = since
			? `WHERE exitedAt IS NOT NULL${this.shadowFilter()} AND exitedAt >= ?`
			: `WHERE exitedAt IS NOT NULL${this.shadowFilter()}`;

		const rows = since
			? this.db.prepare(`
				SELECT
					strategyName,
					COUNT(*)  AS numTrades,
					COALESCE(SUM(pnl), 0) AS totalPnl,
					COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 0) AS winRate
				FROM strategy_trades
				${whereClause}
				GROUP BY strategyName
			`).all(since) as { strategyName: string; numTrades: number; winRate: number; totalPnl: number }[]
			: this.db.prepare(`
				SELECT
					strategyName,
					COUNT(*)  AS numTrades,
					COALESCE(SUM(pnl), 0) AS totalPnl,
					COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 0) AS winRate
				FROM strategy_trades
				${whereClause}
				GROUP BY strategyName
			`).all() as { strategyName: string; numTrades: number; winRate: number; totalPnl: number }[];

		return rows;
	}

	/** Fetch individual closed trades for a strategy (for Sharpe & drawdown). */
	private getClosedTrades(strategyName: string, since: string | null): { pnl: number; exitedAt: string }[] {
		if (since) {
			return this.db.prepare(`
				SELECT pnl, exitedAt FROM strategy_trades
				WHERE strategyName = ? AND exitedAt IS NOT NULL${this.shadowFilter()} AND exitedAt >= ?
				ORDER BY exitedAt ASC
			`).all(strategyName, since) as { pnl: number; exitedAt: string }[];
		}
		return this.db.prepare(`
			SELECT pnl, exitedAt FROM strategy_trades
			WHERE strategyName = ? AND exitedAt IS NOT NULL${this.shadowFilter()}
			ORDER BY exitedAt ASC
		`).all(strategyName) as { pnl: number; exitedAt: string }[];
	}

	/**
	 * Build a daily P&L array for sparkline charts covering the last `days` days.
	 * Missing days (no trades) are represented as 0.
	 */
	private getDailyPnlHistory(strategyName: string, days: number): number[] {
		// Query: group closed trades by calendar day for the last N days.
		const rows = this.db.prepare(`
			SELECT
				DATE(exitedAt) AS day,
				SUM(pnl)       AS dailyPnl
			FROM strategy_trades
			WHERE strategyName = ?
			  AND exitedAt IS NOT NULL${this.shadowFilter()}
			  AND exitedAt >= datetime('now', ?)
			GROUP BY day
			ORDER BY day ASC
		`).all(strategyName, `-${days} days`) as { day: string; dailyPnl: number }[];

		// Build a map from day string to P&L.
		const byDay = new Map<string, number>(rows.map((r) => [r.day, r.dailyPnl]));

		// Fill in the full date range so the sparkline has a consistent length.
		const result: number[] = [];
		const now = new Date();
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(now);
			d.setUTCDate(d.getUTCDate() - i);
			const key = d.toISOString().slice(0, 10); // "YYYY-MM-DD"
			result.push(round2(byDay.get(key) ?? 0));
		}
		return result;
	}
}

// ── Pure math helpers ─────────────────────────────────────────────────────────

/**
 * Compute the annualised Sharpe ratio from a list of trade P&Ls.
 * Assumes crypto trades 24/7 so uses sqrt(365) annualisation.
 * Returns 0 when there's no variance (e.g. all trades identical or only 1 trade).
 */
function computeSharpe(pnls: number[]): number {
	if (pnls.length < 2) return 0;

	const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
	const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1);
	const std = Math.sqrt(variance);

	if (std === 0) return 0;
	// Annualise by treating each trade as one "period" and assuming 365 periods/year.
	return (mean / std) * Math.sqrt(365);
}

/**
 * Compute the maximum drawdown from a list of trade P&Ls (in entry order).
 * Drawdown = biggest drop from a running cumulative-P&L peak.
 * Returns 0 if no drawdown occurred (all P&Ls non-negative).
 */
function computeMaxDrawdown(pnls: number[]): number {
	if (pnls.length === 0) return 0;

	let peak = 0;
	let cumulative = 0;
	let maxDD = 0;

	for (const pnl of pnls) {
		cumulative += pnl;
		if (cumulative > peak) peak = cumulative;
		const drawdown = cumulative - peak; // negative or 0
		if (drawdown < maxDD) maxDD = drawdown;
	}

	return maxDD; // 0 or negative
}

/**
 * Convert a period string to a SQLite-compatible ISO timestamp string,
 * or null for "all" (meaning no date filter).
 */
function periodToSince(period: LeaderboardPeriod): string | null {
	if (period === "all") return null;
	const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString();
}

/** Current UTC date as "YYYY-MM-DD". */
function utcDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Round to 2 decimal places. */
function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
