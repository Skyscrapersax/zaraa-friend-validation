import {
  compactHomePath
} from "./chunk-XSCLDVMG.js";
import "./chunk-F4ZXZMER.js";
import "./chunk-5Q7ELQ3Z.js";
import "./chunk-WWFZXCWT.js";
import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/db.ts
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
function formatDbDirMissing(dir, home) {
  return `Data directory not found: ${compactHomePath(dir, home)}`;
}
function formatDbNoneFound(dir, home) {
  return `No databases found in ${compactHomePath(dir, home)}`;
}
function formatDbStatusHeader(dir, home) {
  return `
Database migration status (${compactHomePath(dir, home)})
`;
}
async function dbStatus(dataDir) {
  const dir = dataDir ?? join(resolveRuntimeHomeDir(), ".zaraa", "data");
  if (!existsSync(dir)) {
    console.log(formatDbDirMissing(dir));
    console.log("Run `zaraa` at least once to initialize the databases.");
    return;
  }
  const dbFiles = readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
  if (dbFiles.length === 0) {
    console.log(formatDbNoneFound(dir));
    return;
  }
  console.log(formatDbStatusHeader(dir));
  for (const filename of dbFiles) {
    const filePath = join(dir, filename);
    const label = filename.replace(".db", "");
    console.log(`\u2500\u2500 ${label} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    let db = null;
    try {
      db = new Database(filePath, { readonly: true });
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
      ).get();
      if (!tableExists) {
        console.log("  (no migration history \u2014 run zaraa to initialize)");
        continue;
      }
      const rows = db.prepare(
        "SELECT version, name, applied_at FROM _migrations ORDER BY version"
      ).all();
      if (rows.length === 0) {
        console.log("  (no migrations applied yet)");
      } else {
        for (const row of rows) {
          const date = row.applied_at.slice(0, 19).replace("T", " ");
          console.log(
            `  \u2713 v${String(row.version).padStart(3, "0")}  ${row.name.padEnd(40)}  ${date}`
          );
        }
      }
    } catch (err) {
      console.log(
        `  Error reading database: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      db?.close();
    }
    console.log("");
  }
}
function dbNew(name) {
  if (!name) {
    console.error("Usage: zaraa db new <migration-name>");
    console.error("Example: zaraa db new add_email_to_users");
    process.exit(1);
  }
  const safeName = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const template = `-- Migration: ${safeName}
-- Description: <describe what this migration does>
--
-- To apply: add this to the store's migrations.ts array, then run pnpm build.
-- To check status: zaraa db status

-- UP

-- TODO: add your schema changes here
-- Examples:
--   CREATE TABLE IF NOT EXISTS my_table ( id TEXT PRIMARY KEY, ... );
--   ALTER TABLE existing_table ADD COLUMN new_col TEXT;


-- DOWN

-- TODO: add the reverse of the UP changes here
-- Examples:
--   DROP TABLE IF EXISTS my_table;
--   (SQLite doesn't support DROP COLUMN \u2014 if needed, recreate the table)
`;
  process.stdout.write(template);
  console.error("");
  console.error(
    `After saving, register this migration in the store's migrations.ts:`
  );
  console.error("");
  console.error(`  import sql_NNN from "./migrations/NNN_${safeName}.sql";`);
  console.error(`  const m_NNN = parseMigrationSql(sql_NNN);`);
  console.error("");
  console.error(`  export const MY_MIGRATIONS: MigrationDef[] = [`);
  console.error(`    // ... existing migrations ...`);
  console.error(
    `    { version: N, name: "${safeName}", up: m_NNN.up, down: m_NNN.down },`
  );
  console.error(`  ];`);
  console.error("");
  console.error(`Then run: pnpm build`);
}
export {
  dbNew,
  dbStatus,
  formatDbDirMissing,
  formatDbNoneFound,
  formatDbStatusHeader
};
