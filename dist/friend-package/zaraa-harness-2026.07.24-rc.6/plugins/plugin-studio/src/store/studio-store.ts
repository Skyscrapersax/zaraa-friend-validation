import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** Input for recording a single render into the learning log. */
export interface RecordRenderInput {
	/** Serialized render spec (JSON string). */
	specJson: string;
	/** Quality-gate verdict, e.g. "pass" | "escalate". */
	verdict: string;
	/** Confidence score in [0, 1]. */
	confidence: number;
	/** Output file paths produced by the render. */
	files: string[];
	/** pHash hex strings of the render's key frames (novelty history). */
	keyHashes?: string[];
}

/** A render row as returned by the store, with `files` parsed back to an array. */
export interface RenderRow {
	id: string;
	specJson: string;
	verdict: string;
	confidence: number;
	files: string[];
	createdAt: number;
	/** Performance feedback (JSON string), populated later; null until then. */
	performance: string | null;
	/** Key-frame pHashes recorded with the render; [] when none were stored. */
	keyHashes: string[];
}

/** Raw shape of a renders row as SQLite returns it (files/performance/keyHashes unparsed). */
interface RawRenderRow {
	id: string;
	specJson: string;
	verdict: string;
	confidence: number;
	files: string;
	createdAt: number;
	performance: string | null;
	keyHashes: string | null;
}

/**
 * Learning-log store for Studio renders. Records every render Zaraa produces so
 * performance can later be fed back. Backed by a single `renders` table in
 * `studio.db` (or `:memory:` for tests).
 */
export class StudioStore {
	private db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS renders (id TEXT PRIMARY KEY, specJson TEXT NOT NULL, verdict TEXT NOT NULL, confidence REAL NOT NULL, files TEXT NOT NULL, createdAt INTEGER NOT NULL, performance TEXT, keyHashes TEXT)",
		);
		// Defensive upgrade for dev/test dbs created before keyHashes existed
		// (mirrors the trace-store migration pattern in core).
		try {
			this.db.exec("ALTER TABLE renders ADD COLUMN keyHashes TEXT");
		} catch { /* column already exists */ }
	}

	/** Record a render and return its generated id. */
	recordRender(input: RecordRenderInput): string {
		const id = randomUUID();
		this.db
			.prepare(
				"INSERT INTO renders (id, specJson, verdict, confidence, files, createdAt, performance, keyHashes) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			)
			.run(
				id,
				input.specJson,
				input.verdict,
				input.confidence,
				JSON.stringify(input.files),
				Date.now(),
				input.keyHashes ? JSON.stringify(input.keyHashes) : null,
			);
		return id;
	}

	/** List the most recent renders, newest first. */
	listRenders(limit: number): RenderRow[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM renders ORDER BY createdAt DESC, rowid DESC LIMIT ?",
			)
			.all(limit) as RawRenderRow[];
		return rows.map((row) => ({
			...row,
			files: JSON.parse(row.files) as string[],
			keyHashes: row.keyHashes ? (JSON.parse(row.keyHashes) as string[]) : [],
		}));
	}

	/**
	 * Flattened key-frame hashes from the most recent `limit` renders (same
	 * ordering as listRenders), newest first — the novelty history the quality
	 * gate compares fresh renders against, durable across daemon restarts.
	 */
	listRecentKeyHashes(limit: number): string[] {
		const rows = this.db
			.prepare(
				"SELECT keyHashes FROM renders ORDER BY createdAt DESC, rowid DESC LIMIT ?",
			)
			.all(limit) as Array<{ keyHashes: string | null }>;
		return rows.flatMap((row) =>
			row.keyHashes ? (JSON.parse(row.keyHashes) as string[]) : [],
		);
	}
}
