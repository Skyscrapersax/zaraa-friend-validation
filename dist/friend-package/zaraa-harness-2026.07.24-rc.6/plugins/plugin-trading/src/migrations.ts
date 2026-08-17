/**
 * Trading database migrations.
 * This single migration set covers TradingStore, TradeJournal, and CandleStore
 * since they all share the same SQLite database file.
 *
 * To add a new migration:
 *   1. Create a new SQL file: src/migrations/NNN_description.sql
 *   2. Add an entry here with the next version number.
 *   3. Run `pnpm build` — tsup will inline the SQL as a string.
 *
 * Run `zara db status` to see which migrations have been applied.
 */

import type { MigrationDef } from "./db/migration-runner.js";
// Use a local copy to avoid circular dependency: @zaraa/core → plugin-trading → @zaraa/core
import { parseMigrationSql } from "./db/parse-migration-sql.js";

import sql001 from "./migrations/001_initial_schema.sql";
import sql002 from "./migrations/002_paper_trading.sql";
import sql003 from "./migrations/003_backtest_results.sql";
import sql004 from "./migrations/004_circuit_breaker_persistence.sql";
import sql005 from "./migrations/005_submitted_orders.sql";
import sql006 from "./migrations/006_regime_session_tagging.sql";
import sql007 from "./migrations/007_opus_grind_log.sql";
import sql008 from "./migrations/008_fee_columns.sql";
import sql009 from "./migrations/009_position_milestones.sql";
import sql010 from "./migrations/010_dex_execution_metadata.sql";
import sql011 from "./migrations/011_risk_monitor_and_lock_state.sql";
import sql012 from "./migrations/012_strategy_grading.sql";
import sql013 from "./migrations/013_strategy_regime_weights.sql";
import sql014 from "./migrations/014_raise_max_drawdown_threshold.sql";
import sql015 from "./migrations/015_strategy_param_tuning.sql";
import sql016 from "./migrations/016_strategy_trades_shadow_flag.sql";
import sql017 from "./migrations/017_trading_indexes.sql";
import sql018 from "./migrations/018_trials_ledger.sql";
import sql019 from "./migrations/019_live_equity_snapshots.sql";

const m001 = parseMigrationSql(sql001);
const m002 = parseMigrationSql(sql002);
const m003 = parseMigrationSql(sql003);
const m004 = parseMigrationSql(sql004);
const m005 = parseMigrationSql(sql005);
const m006 = parseMigrationSql(sql006);
const m007 = parseMigrationSql(sql007);
const m008 = parseMigrationSql(sql008);
const m009 = parseMigrationSql(sql009);
const m010 = parseMigrationSql(sql010);
const m011 = parseMigrationSql(sql011);
const m012 = parseMigrationSql(sql012);
const m013 = parseMigrationSql(sql013);
const m014 = parseMigrationSql(sql014);
const m015 = parseMigrationSql(sql015);
const m016 = parseMigrationSql(sql016);
const m017 = parseMigrationSql(sql017);
const m018 = parseMigrationSql(sql018);
const m019 = parseMigrationSql(sql019);

export const TRADING_MIGRATIONS: MigrationDef[] = [
	{
		version: 1,
		name: "initial_schema",
		up: m001.up,
		down: m001.down,
	},
	{
		version: 2,
		name: "paper_trading",
		up: m002.up,
		down: m002.down,
	},
	{
		version: 3,
		name: "backtest_results",
		up: m003.up,
		down: m003.down,
	},
	{
		version: 4,
		name: "circuit_breaker_persistence",
		up: m004.up,
		down: m004.down,
	},
	{
		version: 5,
		name: "submitted_orders",
		up: m005.up,
		down: m005.down,
	},
	{
		version: 6,
		name: "regime_session_tagging",
		up: m006.up,
		down: m006.down,
	},
	{
		version: 7,
		name: "opus_grind_log",
		up: m007.up,
		down: m007.down,
	},
	{
		version: 8,
		name: "fee_columns",
		up: m008.up,
		down: m008.down,
	},
	{
		version: 9,
		name: "position_milestones",
		up: m009.up,
		down: m009.down,
	},
	{
		version: 10,
		name: "dex_execution_metadata",
		up: m010.up,
		down: m010.down,
	},
	{
		version: 11,
		name: "risk_monitor_and_lock_state",
		up: m011.up,
		down: m011.down,
	},
	{
		version: 12,
		name: "strategy_grading",
		up: m012.up,
		down: m012.down,
	},
	{
		version: 13,
		name: "strategy_regime_weights",
		up: m013.up,
		down: m013.down,
	},
	{
		version: 14,
		name: "raise_max_drawdown_threshold",
		up: m014.up,
		down: m014.down,
	},
	{
		version: 15,
		name: "strategy_param_tuning",
		up: m015.up,
		down: m015.down,
	},
	{
		version: 16,
		name: "strategy_trades_shadow_flag",
		up: m016.up,
		down: m016.down,
	},
	{
		version: 17,
		name: "trading_indexes",
		up: m017.up,
		down: m017.down,
	},
	{
		version: 18,
		name: "trials_ledger",
		up: m018.up,
		down: m018.down,
	},
	{
		version: 19,
		name: "live_equity_snapshots",
		up: m019.up,
		down: m019.down,
	},
];
