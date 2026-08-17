-- Migration 019: authenticated live-account equity, isolated from paper equity

-- UP

CREATE TABLE IF NOT EXISTS live_equity_snapshots (
	timestamp TEXT PRIMARY KEY,
	equity REAL NOT NULL CHECK (equity > 0),
	source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_equity_snapshots_timestamp
	ON live_equity_snapshots (timestamp DESC);

-- DOWN

DROP INDEX IF EXISTS idx_live_equity_snapshots_timestamp;
DROP TABLE IF EXISTS live_equity_snapshots;
