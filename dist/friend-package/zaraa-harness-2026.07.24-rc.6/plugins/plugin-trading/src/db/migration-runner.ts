/**
 * MigrationRunner for plugin-trading.
 * This is a copy of packages/core/src/db/migration-runner.ts to avoid
 * a circular dependency: @zaraa/core → plugin-trading → @zaraa/core.
 *
 * Keep this in sync with the core version when making changes.
 * See packages/core/src/db/migration-runner.ts for full documentation.
 */

import type Database from "better-sqlite3";

export interface MigrationDef {
	version: number;
	name: string;
	up: string;
	down?: string;
}

export interface MigrationStatus {
	version: number;
	name: string;
	status: "applied" | "pending";
	appliedAt?: string;
}

export class MigrationRunner {
	private db: Database.Database;
	private migrations: MigrationDef[];
	private dbName: string;

	constructor(
		db: Database.Database,
		migrations: MigrationDef[],
		dbName: string,
	) {
		this.db = db;
		this.migrations = [...migrations].sort((a, b) => a.version - b.version);
		this.dbName = dbName;
		this.ensureMigrationsTable();
	}

	private ensureMigrationsTable(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS _migrations (
				version    INTEGER PRIMARY KEY,
				name       TEXT    NOT NULL,
				applied_at TEXT    NOT NULL
			)
		`);
	}

	private getAppliedVersions(): Set<number> {
		const rows = this.db
			.prepare("SELECT version FROM _migrations ORDER BY version")
			.all() as { version: number }[];
		return new Set(rows.map((r) => r.version));
	}

	private applyMigration(migration: MigrationDef): void {
		console.log(
			`[db:${this.dbName}] Applying migration ${migration.version}: ${migration.name}`,
		);

		const run = this.db.transaction(() => {
			this.db.exec(migration.up);
			this.db
				.prepare(
					"INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
				)
				.run(migration.version, migration.name, new Date().toISOString());
		});

		try {
			run();
			console.log(
				`[db:${this.dbName}] Migration ${migration.version} applied successfully.`,
			);
		} catch (err) {
			throw new Error(
				`[db:${this.dbName}] Migration ${migration.version} (${migration.name}) failed — ` +
					(err instanceof Error ? err.message : String(err)),
			);
		}
	}

	runPending(): void {
		const applied = this.getAppliedVersions();
		const pending = this.migrations.filter((m) => !applied.has(m.version));

		if (pending.length === 0) return;

		console.log(
			`[db:${this.dbName}] Running ${pending.length} pending migration(s)...`,
		);
		for (const migration of pending) {
			this.applyMigration(migration);
		}
		console.log(`[db:${this.dbName}] All migrations up to date.`);
	}

	rollbackLast(): void {
		const last = this.db
			.prepare(
				"SELECT version, name FROM _migrations ORDER BY version DESC LIMIT 1",
			)
			.get() as { version: number; name: string } | undefined;

		if (!last) {
			console.log(`[db:${this.dbName}] No migrations to roll back.`);
			return;
		}

		const migration = this.migrations.find((m) => m.version === last.version);
		if (!migration) {
			throw new Error(
				`[db:${this.dbName}] Migration ${last.version} not found in migration list.`,
			);
		}
		if (!migration.down) {
			throw new Error(
				`[db:${this.dbName}] Migration ${last.version} has no "down" SQL — cannot roll back.`,
			);
		}

		const rollback = this.db.transaction(() => {
			this.db.exec(migration.down!);
			this.db
				.prepare("DELETE FROM _migrations WHERE version = ?")
				.run(last.version);
		});

		try {
			rollback();
			console.log(
				`[db:${this.dbName}] Migration ${last.version} rolled back successfully.`,
			);
		} catch (err) {
			throw new Error(
				`[db:${this.dbName}] Rollback of migration ${last.version} failed — ` +
					(err instanceof Error ? err.message : String(err)),
			);
		}
	}

	getStatus(): MigrationStatus[] {
		const applied = this.db
			.prepare(
				"SELECT version, name, applied_at FROM _migrations ORDER BY version",
			)
			.all() as { version: number; name: string; applied_at: string }[];

		const appliedMap = new Map(applied.map((m) => [m.version, m]));
		return this.migrations.map((m) => {
			const record = appliedMap.get(m.version);
			return {
				version: m.version,
				name: m.name,
				status: record ? "applied" : "pending",
				appliedAt: record?.applied_at,
			};
		});
	}
}
