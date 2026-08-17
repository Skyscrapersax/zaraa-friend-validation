-- Migration 004: Circuit breaker persistence and stop-monitor checkpointing
--
-- circuit_breaker_state      — persists trip state for each trading risk breaker
--                              so breakers survive process restarts / crashes.
--
-- stop_monitor_checkpoints   — per-position checkpoint updated every monitoring
--                              cycle; used on startup to detect and act on gaps.

-- UP

-- One row per logical breaker. Trips, counters, and cooldowns survive restarts.
-- peak_equity is meaningful for the 'drawdown' and 'velocity' breakers.
-- consecutive_losses is meaningful for the 'consecutive_loss' breaker.
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	breaker_type       TEXT    NOT NULL UNIQUE,
	trip_count         INTEGER NOT NULL DEFAULT 0,
	is_tripped         INTEGER NOT NULL DEFAULT 0,
	trip_reason        TEXT,
	tripped_at         TEXT,
	cooldown_until     TEXT,
	peak_equity        REAL    NOT NULL DEFAULT 0,
	consecutive_losses INTEGER NOT NULL DEFAULT 0,
	last_updated       TEXT    NOT NULL
);

-- Pre-populate rows so runtime UPDATE statements always find a target row.
INSERT OR IGNORE INTO circuit_breaker_state
	(breaker_type, trip_count, is_tripped, peak_equity, consecutive_losses, last_updated)
VALUES ('consecutive_loss', 0, 0, 0, 0, datetime('now'));

INSERT OR IGNORE INTO circuit_breaker_state
	(breaker_type, trip_count, is_tripped, peak_equity, consecutive_losses, last_updated)
VALUES ('drawdown', 0, 0, 0, 0, datetime('now'));

INSERT OR IGNORE INTO circuit_breaker_state
	(breaker_type, trip_count, is_tripped, peak_equity, consecutive_losses, last_updated)
VALUES ('policy_volume', 0, 0, 0, 0, datetime('now'));

INSERT OR IGNORE INTO circuit_breaker_state
	(breaker_type, trip_count, is_tripped, peak_equity, consecutive_losses, last_updated)
VALUES ('velocity', 0, 0, 0, 0, datetime('now'));

-- Index for efficient velocity-window queries on the existing equity_snapshots table.
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_ts
	ON equity_snapshots (timestamp DESC);

-- Per-position checkpoints for stop-monitor crash recovery.
-- Updated after every monitoring cycle; read on startup to detect unmonitored gaps.
CREATE TABLE IF NOT EXISTS stop_monitor_checkpoints (
	position_id        TEXT    NOT NULL PRIMARY KEY,
	last_checked_price REAL,
	last_check_time    TEXT,
	retry_count        INTEGER NOT NULL DEFAULT 0,
	status             TEXT    NOT NULL DEFAULT 'monitoring'
);

-- DOWN

DROP TABLE IF EXISTS stop_monitor_checkpoints;
DROP INDEX IF EXISTS idx_equity_snapshots_ts;
DROP TABLE IF EXISTS circuit_breaker_state;
