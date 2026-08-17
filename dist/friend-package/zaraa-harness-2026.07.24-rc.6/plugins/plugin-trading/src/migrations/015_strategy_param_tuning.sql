-- Migration 015: Strategy parameter tuning tables
-- strategy_rankings: rolling 30d performance snapshots used for signal weight promotion/demotion
-- dynamic_risk_state: persisted dynamic risk adjuster state (per portfolio, not per strategy)
-- optimizer_results: historical optimization run results for auditing

-- UP

CREATE TABLE IF NOT EXISTS strategy_rankings (
	id TEXT PRIMARY KEY,
	strategyName TEXT NOT NULL,
	computedAt TEXT NOT NULL,
	windowStartMs INTEGER NOT NULL,
	windowEndMs INTEGER NOT NULL,
	tradeCount INTEGER NOT NULL,
	winRate REAL NOT NULL,
	sharpeRatio REAL NOT NULL,
	maxDrawdownPct REAL NOT NULL,
	totalPnl REAL NOT NULL,
	rank INTEGER NOT NULL,
	signalWeightMultiplier REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_rankings_name_time
	ON strategy_rankings (strategyName, computedAt DESC);

CREATE TABLE IF NOT EXISTS dynamic_risk_state (
	id TEXT NOT NULL DEFAULT 'portfolio',
	riskMultiplier REAL NOT NULL DEFAULT 1.0,
	stopLossMultiplier REAL NOT NULL DEFAULT 1.0,
	pausedUntilMs INTEGER NOT NULL DEFAULT 0,
	consecutiveLosses INTEGER NOT NULL DEFAULT 0,
	improvingSinceMs INTEGER,
	lastUpdatedAt TEXT NOT NULL,
	reasonJson TEXT,
	PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS optimizer_results (
	id TEXT PRIMARY KEY,
	strategyName TEXT NOT NULL,
	runAt TEXT NOT NULL,
	periodDays INTEGER NOT NULL,
	candleCount INTEGER NOT NULL,
	paramsTestedCount INTEGER NOT NULL,
	resultsJson TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_optimizer_results_name_time
	ON optimizer_results (strategyName, runAt DESC);

-- DOWN

DROP INDEX IF EXISTS idx_optimizer_results_name_time;
DROP TABLE IF EXISTS optimizer_results;
DROP TABLE IF EXISTS dynamic_risk_state;
DROP INDEX IF EXISTS idx_strategy_rankings_name_time;
DROP TABLE IF EXISTS strategy_rankings;
