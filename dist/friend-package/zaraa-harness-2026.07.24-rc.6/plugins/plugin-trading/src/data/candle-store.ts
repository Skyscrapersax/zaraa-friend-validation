import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

export interface Candle {
	symbol: string;
	timeframe: string;
	openTime: number; // Unix ms
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

const CANDLES_SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS candles (
		symbol    TEXT    NOT NULL,
		timeframe TEXT    NOT NULL,
		openTime  INTEGER NOT NULL,
		open      REAL    NOT NULL,
		high      REAL    NOT NULL,
		low       REAL    NOT NULL,
		close     REAL    NOT NULL,
		volume    REAL    NOT NULL,
		PRIMARY KEY (symbol, timeframe, openTime)
	);

	CREATE INDEX IF NOT EXISTS idx_candles_lookup
		ON candles (symbol, timeframe, openTime DESC);
`;

export class CandleStore {
	// Cached prepared statements — prepared once, reused on every call.
	private readonly stmtInsert: Statement;
	private readonly stmtGet: Statement;
	private readonly stmtGetAscending: Statement;
	private readonly stmtGetRange: Statement;
	private readonly stmtGetLatestTime: Statement;
	private readonly stmtCount: Statement;
	private readonly stmtPrune: Statement;
	private readonly stmtSymbols: Statement;

	constructor(private db: Database.Database) {
		// CandleStore is used with a standalone candles.db in the app runtime, so it
		// must bootstrap its own schema instead of relying on trading.db migrations.
		this.db.exec(CANDLES_SCHEMA_SQL);

		// Prepare all statements once upfront.
		this.stmtInsert = this.db.prepare(`
			INSERT OR REPLACE INTO candles (symbol, timeframe, openTime, open, high, low, close, volume)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.stmtGet = this.db.prepare(
			"SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY openTime DESC LIMIT ?",
		);
		this.stmtGetAscending = this.db.prepare(
			`SELECT * FROM (SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY openTime DESC LIMIT ?) ORDER BY openTime ASC`,
		);
		this.stmtGetRange = this.db.prepare(
			"SELECT * FROM candles WHERE symbol = ? AND timeframe = ? AND openTime >= ? AND openTime <= ? ORDER BY openTime ASC",
		);
		this.stmtGetLatestTime = this.db.prepare(
			"SELECT MAX(openTime) as latest FROM candles WHERE symbol = ? AND timeframe = ?",
		);
		this.stmtCount = this.db.prepare(
			"SELECT COUNT(*) as cnt FROM candles WHERE symbol = ? AND timeframe = ?",
		);
		this.stmtPrune = this.db.prepare("DELETE FROM candles WHERE openTime < ?");
		this.stmtSymbols = this.db.prepare("SELECT DISTINCT symbol FROM candles ORDER BY symbol");
	}

	upsert(candles: Candle[]): number {
		if (candles.length === 0) return 0;
		const stmt = this.stmtInsert;
		const tx = this.db.transaction((rows: Candle[]) => {
			let count = 0;
			for (const c of rows) {
				stmt.run(c.symbol, c.timeframe, c.openTime, c.open, c.high, c.low, c.close, c.volume);
				count++;
			}
			return count;
		});
		return tx(candles);
	}

	get(symbol: string, timeframe: string, limit = 200): Candle[] {
		return this.stmtGet.all(symbol, timeframe, limit) as Candle[];
	}

	/**
	 * Same as get() but returns candles in ascending (oldest-first) order.
	 * Use this when the result will be passed directly to computeIndicators()
	 * or strategy.evaluate() — eliminates the [...candles].reverse() spread
	 * copy that was the dominant per-scan allocation hotspot.
	 */
	getAscending(symbol: string, timeframe: string, limit = 200): Candle[] {
		return this.stmtGetAscending.all(symbol, timeframe, limit) as Candle[];
	}

	getRange(symbol: string, timeframe: string, fromMs: number, toMs: number): Candle[] {
		return this.stmtGetRange.all(symbol, timeframe, fromMs, toMs) as Candle[];
	}

	getLatestTime(symbol: string, timeframe: string): number | null {
		const row = this.stmtGetLatestTime.get(symbol, timeframe) as
			| { latest: number | null }
			| undefined;
		return row?.latest ?? null;
	}

	count(symbol: string, timeframe: string): number {
		const row = this.stmtCount.get(symbol, timeframe) as { cnt: number };
		return row.cnt;
	}

	prune(maxAgeMs: number): number {
		const cutoff = Date.now() - maxAgeMs;
		const result = this.stmtPrune.run(cutoff);
		return result.changes;
	}

	symbols(): string[] {
		const rows = this.stmtSymbols.all() as { symbol: string }[];
		return rows.map((r) => r.symbol);
	}
}
