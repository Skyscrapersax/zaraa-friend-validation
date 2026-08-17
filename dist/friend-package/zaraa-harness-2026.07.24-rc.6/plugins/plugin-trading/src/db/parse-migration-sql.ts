/**
 * Parses a migration SQL file into separate UP and DOWN sections.
 * Copied from packages/core/src/db/parse-migration-sql.ts to avoid
 * a circular dependency (plugin-trading ← @zaraa/core ← plugin-trading).
 *
 * Expected SQL file format:
 *   -- UP
 *   CREATE TABLE ...;
 *   -- DOWN
 *   DROP TABLE ...;
 */
export function parseMigrationSql(content: string): {
	up: string;
	down: string | undefined;
} {
	const downSplit = content.split(/^--\s*DOWN\s*$/im);
	const upSection = downSplit[0];
	const downSection = downSplit[1];

	const up = upSection.replace(/^--\s*UP\s*$/im, "").trim();
	const down = downSection ? downSection.trim() : undefined;

	return { up, down };
}
