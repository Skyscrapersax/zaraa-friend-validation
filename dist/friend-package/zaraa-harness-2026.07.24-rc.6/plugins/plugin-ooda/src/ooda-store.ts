import type Database from "better-sqlite3";

export interface StoredCycle {
	id: string;
	preset: string;
	context: string | null;
	phases: {
		observe: { data: Record<string, unknown>; summary: string; durationMs: number };
		orient: { analysis: string; patterns: string[]; durationMs: number };
		decide: { decision: string; confidence: number; risk: "low" | "medium" | "high"; alternatives: string[]; durationMs: number };
		act: { action: string; executed: boolean; result: string | null; durationMs: number };
	};
	outcome: "success" | "partial" | "failed" | "pending" | null;
	totalDurationMs: number;
	createdAt?: string;
}

/** Raw row shape as stored in ooda_cycles (phases is a JSON string; outcome holds
 *  one of the StoredCycle outcome literals). Only the fields rowToCycle reads. */
interface OodaCycleRow {
	id: string;
	preset: string;
	context: string | null;
	phases: string;
	outcome: StoredCycle["outcome"];
	totalDurationMs: number;
	createdAt: string;
}

export class OODAStore {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		db.pragma("journal_mode = WAL");
		this.initSchema();
	}

	private initSchema(): void {
		const createTable = `
			CREATE TABLE IF NOT EXISTS ooda_cycles (
				id TEXT PRIMARY KEY,
				preset TEXT NOT NULL,
				context TEXT,
				phases TEXT NOT NULL,
				decision TEXT,
				confidence REAL,
				risk TEXT,
				action TEXT,
				executed INTEGER DEFAULT 0,
				outcome TEXT,
				totalDurationMs INTEGER,
				createdAt TEXT NOT NULL
			)
		`;
		const createPresetIdx = `CREATE INDEX IF NOT EXISTS idx_ooda_preset ON ooda_cycles(preset)`;
		const createCreatedIdx = `CREATE INDEX IF NOT EXISTS idx_ooda_created ON ooda_cycles(createdAt)`;
		this.db.prepare(createTable).run();
		this.db.prepare(createPresetIdx).run();
		this.db.prepare(createCreatedIdx).run();
	}

	saveCycle(cycle: StoredCycle): void {
		const decide = cycle.phases?.decide;
		const act = cycle.phases?.act;
		this.db.prepare(`
			INSERT OR REPLACE INTO ooda_cycles (id, preset, context, phases, decision, confidence, risk, action, executed, outcome, totalDurationMs, createdAt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			cycle.id, cycle.preset, cycle.context ?? null, JSON.stringify(cycle.phases),
			decide?.decision ?? null, decide?.confidence ?? null, decide?.risk ?? null,
			act?.action ?? null, act?.executed ? 1 : 0, cycle.outcome ?? null,
			cycle.totalDurationMs, cycle.createdAt ?? new Date().toISOString(),
		);
	}

	getCycle(id: string): StoredCycle | null {
		const row = this.db.prepare("SELECT * FROM ooda_cycles WHERE id = ?").get(id) as OodaCycleRow | undefined;
		return row ? this.rowToCycle(row) : null;
	}

	getRecentCycles(preset?: string, limit: number = 5): StoredCycle[] {
		const sql = preset
			? "SELECT * FROM ooda_cycles WHERE preset = ? ORDER BY createdAt DESC LIMIT ?"
			: "SELECT * FROM ooda_cycles ORDER BY createdAt DESC LIMIT ?";
		const rows = preset
			? this.db.prepare(sql).all(preset, limit) as OodaCycleRow[]
			: this.db.prepare(sql).all(limit) as OodaCycleRow[];
		return rows.map(r => this.rowToCycle(r));
	}

	updateOutcome(id: string, outcome: "success" | "partial" | "failed" | "pending"): void {
		this.db.prepare("UPDATE ooda_cycles SET outcome = ? WHERE id = ?").run(outcome, id);
	}

	private rowToCycle(row: OodaCycleRow): StoredCycle {
		return {
			id: row.id, preset: row.preset, context: row.context,
			phases: JSON.parse(row.phases), outcome: row.outcome,
			totalDurationMs: row.totalDurationMs, createdAt: row.createdAt,
		};
	}
}
