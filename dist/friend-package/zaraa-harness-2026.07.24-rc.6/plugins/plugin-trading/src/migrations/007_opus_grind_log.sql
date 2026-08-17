-- Migration 007: Opus grind session log.
--
-- Tracks what each hourly Opus grind cycle actually did:
-- which steps produced actionable output, trades executed,
-- alerts set, and findings stored. Enables auditing cycle
-- effectiveness and tuning the grind prompt over time.

-- UP

CREATE INDEX IF NOT EXISTS idx_positions_status_opened ON positions(status, openedAt DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol_created ON trade_log(symbol, createdAt);

CREATE TABLE IF NOT EXISTS opus_grind_log (
	id TEXT PRIMARY KEY,
	startedAt TEXT NOT NULL,
	completedAt TEXT,
	durationMs INTEGER,
	status TEXT NOT NULL DEFAULT 'running',
	-- What the cycle found
	marketRegime TEXT,
	bestOpportunity TEXT,
	portfolioEquity REAL,
	portfolioPnl REAL,
	drawdownPct REAL,
	riskViolations INTEGER DEFAULT 0,
	-- What the cycle did
	tradeExecuted INTEGER DEFAULT 0,
	alertsSet INTEGER DEFAULT 0,
	memoriesStored INTEGER DEFAULT 0,
	parameterTweaks INTEGER DEFAULT 0,
	-- Quality metrics
	stepsCompleted INTEGER DEFAULT 0,
	stepsSkipped INTEGER DEFAULT 0,
	actionsTaken INTEGER DEFAULT 0,
	-- Full details
	summaryJson TEXT,
	errorMessage TEXT
);

CREATE INDEX IF NOT EXISTS idx_opus_grind_log_started
	ON opus_grind_log (startedAt DESC);
CREATE INDEX IF NOT EXISTS idx_opus_grind_log_status
	ON opus_grind_log (status);

-- DOWN

DROP INDEX IF EXISTS idx_opus_grind_log_status;
DROP INDEX IF EXISTS idx_opus_grind_log_started;
DROP TABLE IF EXISTS opus_grind_log;
DROP INDEX IF EXISTS idx_trade_log_symbol_created;
DROP INDEX IF EXISTS idx_positions_status_opened;
