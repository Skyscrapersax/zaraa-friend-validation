import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Interfaces ──

export interface TradingSession {
	id: string;
	name: string;
	startTime: string; // ISO
	endTime: string | null;
	status: "active" | "closed";
	notes: string | null;
	// Computed at close
	tradesCount: number;
	winCount: number;
	lossCount: number;
	totalPnl: number;
	maxDrawdown: number;
	bestTrade: number;
	worstTrade: number;
}

export interface SessionTrade {
	id: string;
	sessionId: string;
	symbol: string;
	side: "buy" | "sell";
	price: number;
	quantity: number;
	pnl: number | null;
	tags: string | null; // JSON array
	notes: string | null;
	recordedAt: string;
}

export interface SessionStats {
	tradesCount: number;
	winRate: number;
	totalPnl: number;
	avgPnl: number;
	bestTrade: number;
	worstTrade: number;
	avgHoldTime: number;
	bySymbol: Record<string, { count: number; pnl: number }>;
	byTag: Record<string, { count: number; pnl: number }>;
}

export interface WeeklySummary {
	sessions: number;
	totalTrades: number;
	winRate: number;
	totalPnl: number;
	bestDay: string;
	worstDay: string;
}

// ── Manager ──

export class TradingSessionManager {
	private db: Database.Database;

	// Prepared statements (lazily initialized after table creation)
	private stmtInsertSession!: Database.Statement;
	private stmtUpdateSessionClose!: Database.Statement;
	private stmtGetSession!: Database.Statement;
	private stmtGetActiveSession!: Database.Statement;
	private stmtListSessions!: Database.Statement;
	private stmtInsertTrade!: Database.Statement;
	private stmtGetSessionTrades!: Database.Statement;
	private stmtGetTodaySession!: Database.Statement;
	private stmtGetWeeklySessions!: Database.Statement;
	private stmtGetWeeklyTrades!: Database.Statement;
	private stmtCountActiveSessions!: Database.Statement;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.initTables();
		this.prepareStatements();
	}

	private initTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS trading_sessions (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				startTime TEXT NOT NULL,
				endTime TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				notes TEXT,
				tradesCount INTEGER NOT NULL DEFAULT 0,
				winCount INTEGER NOT NULL DEFAULT 0,
				lossCount INTEGER NOT NULL DEFAULT 0,
				totalPnl REAL NOT NULL DEFAULT 0,
				maxDrawdown REAL NOT NULL DEFAULT 0,
				bestTrade REAL NOT NULL DEFAULT 0,
				worstTrade REAL NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_status
				ON trading_sessions (status, startTime DESC);
			CREATE INDEX IF NOT EXISTS idx_sessions_start
				ON trading_sessions (startTime DESC);

			CREATE TABLE IF NOT EXISTS session_trades (
				id TEXT PRIMARY KEY,
				sessionId TEXT NOT NULL,
				symbol TEXT NOT NULL,
				side TEXT NOT NULL,
				price REAL NOT NULL,
				quantity REAL NOT NULL,
				pnl REAL,
				tags TEXT,
				notes TEXT,
				recordedAt TEXT NOT NULL,
				FOREIGN KEY (sessionId) REFERENCES trading_sessions(id)
			);
			CREATE INDEX IF NOT EXISTS idx_session_trades_session
				ON session_trades (sessionId, recordedAt ASC);
			CREATE INDEX IF NOT EXISTS idx_session_trades_symbol
				ON session_trades (symbol, recordedAt DESC);
		`);
	}

	private prepareStatements(): void {
		this.stmtInsertSession = this.db.prepare(
			`INSERT INTO trading_sessions (id, name, startTime, status)
			 VALUES (?, ?, ?, 'active')`,
		);

		this.stmtUpdateSessionClose = this.db.prepare(
			`UPDATE trading_sessions
			 SET endTime = ?, status = 'closed', notes = ?,
			     tradesCount = ?, winCount = ?, lossCount = ?,
			     totalPnl = ?, maxDrawdown = ?, bestTrade = ?, worstTrade = ?
			 WHERE id = ? AND status = 'active'`,
		);

		this.stmtGetSession = this.db.prepare(
			"SELECT * FROM trading_sessions WHERE id = ?",
		);

		this.stmtGetActiveSession = this.db.prepare(
			"SELECT * FROM trading_sessions WHERE status = 'active' ORDER BY startTime DESC LIMIT 1",
		);

		this.stmtListSessions = this.db.prepare(
			"SELECT * FROM trading_sessions ORDER BY startTime DESC LIMIT ?",
		);

		this.stmtInsertTrade = this.db.prepare(
			`INSERT INTO session_trades (id, sessionId, symbol, side, price, quantity, pnl, tags, notes, recordedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		this.stmtGetSessionTrades = this.db.prepare(
			"SELECT * FROM session_trades WHERE sessionId = ? ORDER BY recordedAt ASC",
		);

		this.stmtGetTodaySession = this.db.prepare(
			"SELECT * FROM trading_sessions WHERE startTime LIKE ? ORDER BY startTime DESC LIMIT 1",
		);

		this.stmtGetWeeklySessions = this.db.prepare(
			"SELECT * FROM trading_sessions WHERE startTime >= ? ORDER BY startTime ASC",
		);

		this.stmtGetWeeklyTrades = this.db.prepare(
			`SELECT st.* FROM session_trades st
			 JOIN trading_sessions ts ON st.sessionId = ts.id
			 WHERE ts.startTime >= ?
			 ORDER BY st.recordedAt ASC`,
		);

		this.stmtCountActiveSessions = this.db.prepare(
			"SELECT COUNT(*) as cnt FROM trading_sessions WHERE status = 'active'",
		);
	}

	// ── Session lifecycle ──

	startSession(name?: string): TradingSession {
		// Check if there is already an active session
		const existing = this.getActiveSession();
		if (existing) {
			throw new Error(
				`Session "${existing.name}" (${existing.id}) is already active. Close it before starting a new one.`,
			);
		}

		const id = randomUUID();
		const now = new Date().toISOString();
		const sessionName = name || this.generateDefaultName();

		this.stmtInsertSession.run(id, sessionName, now);

		return {
			id,
			name: sessionName,
			startTime: now,
			endTime: null,
			status: "active",
			notes: null,
			tradesCount: 0,
			winCount: 0,
			lossCount: 0,
			totalPnl: 0,
			maxDrawdown: 0,
			bestTrade: 0,
			worstTrade: 0,
		};
	}

	closeSession(id: string, notes?: string): TradingSession {
		const session = this.stmtGetSession.get(id) as
			| Record<string, unknown>
			| undefined;
		if (!session) {
			throw new Error(`Session not found: ${id}`);
		}
		if (session.status === "closed") {
			throw new Error(
				`Session "${session.name}" is already closed (ended ${session.endTime}).`,
			);
		}

		const trades = this.stmtGetSessionTrades.all(id) as SessionTrade[];
		const stats = this.computeCloseStats(trades);
		const now = new Date().toISOString();

		const result = this.stmtUpdateSessionClose.run(
			now,
			notes ?? null,
			stats.tradesCount,
			stats.winCount,
			stats.lossCount,
			stats.totalPnl,
			stats.maxDrawdown,
			stats.bestTrade,
			stats.worstTrade,
			id,
		);

		if (result.changes === 0) {
			throw new Error(`Failed to close session ${id}. It may have already been closed.`);
		}

		return {
			id,
			name: session.name as string,
			startTime: session.startTime as string,
			endTime: now,
			status: "closed",
			notes: notes ?? null,
			tradesCount: stats.tradesCount,
			winCount: stats.winCount,
			lossCount: stats.lossCount,
			totalPnl: stats.totalPnl,
			maxDrawdown: stats.maxDrawdown,
			bestTrade: stats.bestTrade,
			worstTrade: stats.worstTrade,
		};
	}

	getActiveSession(): TradingSession | null {
		const row = this.stmtGetActiveSession.get() as
			| Record<string, unknown>
			| undefined;
		return row ? this.rowToSession(row) : null;
	}

	// ── Trade recording ──

	recordTrade(
		sessionId: string,
		trade: {
			symbol: string;
			side: "buy" | "sell";
			price: number;
			quantity: number;
			pnl?: number;
			tags?: string[];
			notes?: string;
		},
	): SessionTrade {
		// Validate session exists and is active
		const session = this.stmtGetSession.get(sessionId) as
			| Record<string, unknown>
			| undefined;
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		if (session.status !== "active") {
			throw new Error(
				`Cannot record trades on closed session "${session.name}".`,
			);
		}

		// Validate trade inputs
		if (!trade.symbol || typeof trade.symbol !== "string") {
			throw new Error("Trade symbol is required and must be a string.");
		}
		if (!["buy", "sell"].includes(trade.side)) {
			throw new Error('Trade side must be "buy" or "sell".');
		}
		if (!Number.isFinite(trade.price) || trade.price <= 0) {
			throw new Error("Trade price must be a positive finite number.");
		}
		if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) {
			throw new Error("Trade quantity must be a positive finite number.");
		}
		if (trade.pnl !== undefined && !Number.isFinite(trade.pnl)) {
			throw new Error("Trade pnl must be a finite number if provided.");
		}

		const id = randomUUID();
		const now = new Date().toISOString();
		const tagsJson = trade.tags?.length ? JSON.stringify(trade.tags) : null;

		this.stmtInsertTrade.run(
			id,
			sessionId,
			trade.symbol.toUpperCase(),
			trade.side,
			trade.price,
			trade.quantity,
			trade.pnl ?? null,
			tagsJson,
			trade.notes ?? null,
			now,
		);

		return {
			id,
			sessionId,
			symbol: trade.symbol.toUpperCase(),
			side: trade.side,
			price: trade.price,
			quantity: trade.quantity,
			pnl: trade.pnl ?? null,
			tags: tagsJson,
			notes: trade.notes ?? null,
			recordedAt: now,
		};
	}

	// ── Stats & queries ──

	getSessionStats(id: string): SessionStats {
		const session = this.stmtGetSession.get(id) as
			| Record<string, unknown>
			| undefined;
		if (!session) {
			throw new Error(`Session not found: ${id}`);
		}

		const trades = this.stmtGetSessionTrades.all(id) as SessionTrade[];
		return this.computeSessionStats(trades);
	}

	listSessions(limit = 20): TradingSession[] {
		const rows = this.stmtListSessions.all(limit) as Record<
			string,
			unknown
		>[];
		return rows.map((r) => this.rowToSession(r));
	}

	getTodaySession(): TradingSession {
		const today = new Date().toISOString().split("T")[0];
		const row = this.stmtGetTodaySession.get(`${today}%`) as
			| Record<string, unknown>
			| undefined;

		if (row) {
			return this.rowToSession(row);
		}

		// Auto-create today's session
		return this.startSession(`Session ${today}`);
	}

	getWeeklySummary(): WeeklySummary {
		const now = new Date();
		// Go back to the most recent Monday (or today if Monday)
		const dayOfWeek = now.getDay();
		const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
		const monday = new Date(now);
		monday.setDate(now.getDate() - diffToMonday);
		monday.setHours(0, 0, 0, 0);
		const weekStart = monday.toISOString();

		const sessions = this.stmtGetWeeklySessions.all(weekStart) as Record<
			string,
			unknown
		>[];
		const trades = this.stmtGetWeeklyTrades.all(weekStart) as SessionTrade[];

		if (sessions.length === 0) {
			return {
				sessions: 0,
				totalTrades: 0,
				winRate: 0,
				totalPnl: 0,
				bestDay: "N/A",
				worstDay: "N/A",
			};
		}

		// Aggregate trades by day
		const dayPnl = new Map<string, number>();
		let wins = 0;
		let total = 0;

		for (const trade of trades) {
			const day = trade.recordedAt.split("T")[0];
			dayPnl.set(day, (dayPnl.get(day) ?? 0) + (trade.pnl ?? 0));
			if (trade.pnl != null) {
				total++;
				if (trade.pnl > 0) wins++;
			}
		}

		let bestDay = "N/A";
		let worstDay = "N/A";
		let bestPnl = -Infinity;
		let worstPnl = Infinity;

		for (const [day, pnl] of dayPnl) {
			if (pnl > bestPnl) {
				bestPnl = pnl;
				bestDay = day;
			}
			if (pnl < worstPnl) {
				worstPnl = pnl;
				worstDay = day;
			}
		}

		const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

		return {
			sessions: sessions.length,
			totalTrades: trades.length,
			winRate: total > 0 ? r2((wins / total) * 100) : 0,
			totalPnl: r2(totalPnl),
			bestDay: bestPnl > -Infinity ? `${bestDay} ($${r2(bestPnl)})` : "N/A",
			worstDay: worstPnl < Infinity ? `${worstDay} ($${r2(worstPnl)})` : "N/A",
		};
	}

	// ── Detailed review for a single session ──

	getSessionReview(id: string): {
		session: TradingSession;
		stats: SessionStats;
		trades: SessionTrade[];
		timeline: string[];
	} {
		const session = this.stmtGetSession.get(id) as
			| Record<string, unknown>
			| undefined;
		if (!session) {
			throw new Error(`Session not found: ${id}`);
		}

		const trades = this.stmtGetSessionTrades.all(id) as SessionTrade[];
		const stats = this.computeSessionStats(trades);

		// Build a human-readable timeline
		const timeline: string[] = [];
		let cumPnl = 0;
		for (const t of trades) {
			cumPnl += t.pnl ?? 0;
			const pnlStr = t.pnl != null ? ` | P&L: $${r2(t.pnl)}` : "";
			let parsedTags: string[] = [];
			if (t.tags) { try { parsedTags = JSON.parse(t.tags); } catch { console.warn("Failed to parse trade tags JSON:", t.tags); } }
			const tagStr = parsedTags.length ? ` [${parsedTags.join(", ")}]` : "";
			const time = t.recordedAt.split("T")[1]?.substring(0, 8) ?? "";
			timeline.push(
				`${time} ${t.side.toUpperCase()} ${t.quantity} ${t.symbol} @ $${t.price}${pnlStr} | cumPnl: $${r2(cumPnl)}${tagStr}`,
			);
		}

		return {
			session: this.rowToSession(session),
			stats,
			trades,
			timeline,
		};
	}

	// ── Cleanup ──

	close(): void {
		this.db.pragma("wal_checkpoint(TRUNCATE)");
		this.db.close();
	}

	// ── Private helpers ──

	private computeCloseStats(trades: SessionTrade[]): {
		tradesCount: number;
		winCount: number;
		lossCount: number;
		totalPnl: number;
		maxDrawdown: number;
		bestTrade: number;
		worstTrade: number;
	} {
		if (trades.length === 0) {
			return {
				tradesCount: 0,
				winCount: 0,
				lossCount: 0,
				totalPnl: 0,
				maxDrawdown: 0,
				bestTrade: 0,
				worstTrade: 0,
			};
		}

		const pnls = trades.map((t) => t.pnl ?? 0);
		const winCount = pnls.filter((p) => p > 0).length;
		const lossCount = pnls.filter((p) => p < 0).length;
		const totalPnl = pnls.reduce((s, p) => s + p, 0);
		const bestTrade = Math.max(...pnls);
		const worstTrade = Math.min(...pnls);

		// Max drawdown from cumulative P&L
		let cumulative = 0;
		let peak = 0;
		let maxDrawdown = 0;
		for (const pnl of pnls) {
			cumulative += pnl;
			if (cumulative > peak) peak = cumulative;
			const dd = peak - cumulative;
			if (dd > maxDrawdown) maxDrawdown = dd;
		}

		return {
			tradesCount: trades.length,
			winCount,
			lossCount,
			totalPnl: r2(totalPnl),
			maxDrawdown: r2(maxDrawdown),
			bestTrade: r2(bestTrade),
			worstTrade: r2(worstTrade),
		};
	}

	private computeSessionStats(trades: SessionTrade[]): SessionStats {
		if (trades.length === 0) {
			return {
				tradesCount: 0,
				winRate: 0,
				totalPnl: 0,
				avgPnl: 0,
				bestTrade: 0,
				worstTrade: 0,
				avgHoldTime: 0,
				bySymbol: {},
				byTag: {},
			};
		}

		const pnls = trades.map((t) => t.pnl ?? 0);
		const wins = pnls.filter((p) => p > 0).length;
		const tradesWithPnl = trades.filter((t) => t.pnl != null);
		const totalPnl = pnls.reduce((s, p) => s + p, 0);

		// Average hold time: approximate from timestamps between consecutive buy/sell pairs
		let totalHoldMs = 0;
		let holdPairs = 0;
		const openTrades = new Map<string, SessionTrade>();
		for (const t of trades) {
			if (t.side === "buy") {
				openTrades.set(t.symbol, t);
			} else if (t.side === "sell" && openTrades.has(t.symbol)) {
				const open = openTrades.get(t.symbol)!;
				const holdMs =
					new Date(t.recordedAt).getTime() -
					new Date(open.recordedAt).getTime();
				totalHoldMs += holdMs;
				holdPairs++;
				openTrades.delete(t.symbol);
			}
		}
		const avgHoldTimeMs = holdPairs > 0 ? totalHoldMs / holdPairs : 0;
		// Convert to minutes
		const avgHoldTime = r2(avgHoldTimeMs / 60_000);

		// Breakdown by symbol
		const bySymbol: Record<string, { count: number; pnl: number }> = {};
		for (const t of trades) {
			if (!bySymbol[t.symbol]) {
				bySymbol[t.symbol] = { count: 0, pnl: 0 };
			}
			bySymbol[t.symbol].count++;
			bySymbol[t.symbol].pnl = r2(
				bySymbol[t.symbol].pnl + (t.pnl ?? 0),
			);
		}

		// Breakdown by tag
		const byTag: Record<string, { count: number; pnl: number }> = {};
		for (const t of trades) {
			if (!t.tags) continue;
			let parsed: string[];
			try {
				parsed = JSON.parse(t.tags);
			} catch (err) {
				console.debug("[trading-session] tag parse failed:", err instanceof Error ? err.message : err);
				continue;
			}
			for (const tag of parsed) {
				if (!byTag[tag]) {
					byTag[tag] = { count: 0, pnl: 0 };
				}
				byTag[tag].count++;
				byTag[tag].pnl = r2(byTag[tag].pnl + (t.pnl ?? 0));
			}
		}

		return {
			tradesCount: trades.length,
			winRate:
				tradesWithPnl.length > 0
					? r2((wins / tradesWithPnl.length) * 100)
					: 0,
			totalPnl: r2(totalPnl),
			avgPnl:
				tradesWithPnl.length > 0
					? r2(totalPnl / tradesWithPnl.length)
					: 0,
			bestTrade: r2(Math.max(...pnls)),
			worstTrade: r2(Math.min(...pnls)),
			avgHoldTime,
			bySymbol,
			byTag,
		};
	}

	private rowToSession(row: Record<string, unknown>): TradingSession {
		return {
			id: row.id as string,
			name: row.name as string,
			startTime: row.startTime as string,
			endTime: (row.endTime as string) ?? null,
			status: row.status as "active" | "closed",
			notes: (row.notes as string) ?? null,
			tradesCount: (row.tradesCount as number) ?? 0,
			winCount: (row.winCount as number) ?? 0,
			lossCount: (row.lossCount as number) ?? 0,
			totalPnl: (row.totalPnl as number) ?? 0,
			maxDrawdown: (row.maxDrawdown as number) ?? 0,
			bestTrade: (row.bestTrade as number) ?? 0,
			worstTrade: (row.worstTrade as number) ?? 0,
		};
	}

	private generateDefaultName(): string {
		const now = new Date();
		const hour = now.getHours();
		let period: string;
		if (hour < 12) {
			period = "Morning";
		} else if (hour < 17) {
			period = "Afternoon";
		} else {
			period = "Evening";
		}
		const dateStr = now.toISOString().split("T")[0];
		return `${period} Session ${dateStr}`;
	}
}

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
