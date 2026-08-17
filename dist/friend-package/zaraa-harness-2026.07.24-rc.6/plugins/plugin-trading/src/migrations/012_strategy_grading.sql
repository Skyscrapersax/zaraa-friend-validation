-- Migration 012: Strategy grading & lifecycle (paper/live journal closes)
-- Rolling profit factor, expectancy, drawdown-from-trades, regime mix;
-- persisted runs + current lifecycle row used as sizing multiplier gate.

-- UP

CREATE TABLE IF NOT EXISTS strategy_grade_runs (
	id TEXT PRIMARY KEY,
	strategyName TEXT NOT NULL,
	symbol TEXT NOT NULL,
	strategyVersion TEXT NOT NULL DEFAULT '1',
	paramsHash TEXT NOT NULL DEFAULT '',
	computedAt TEXT NOT NULL,
	windowStart TEXT NOT NULL,
	windowEnd TEXT NOT NULL,
	closedTradeCount INTEGER NOT NULL,
	rollingProfitFactor REAL NOT NULL,
	expectancy REAL NOT NULL,
	winRate REAL NOT NULL,
	maxEquityDrawdownPct REAL NOT NULL,
	regimeBreakdownJson TEXT NOT NULL,
	compositeScore REAL NOT NULL,
	quartile INTEGER NOT NULL,
	lifecycleState TEXT NOT NULL,
	allocationMultiplier REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_grade_runs_name_time
	ON strategy_grade_runs (strategyName, computedAt DESC);

CREATE TABLE IF NOT EXISTS strategy_lifecycle (
	strategyName TEXT NOT NULL,
	symbol TEXT NOT NULL,
	strategyVersion TEXT NOT NULL DEFAULT '1',
	paramsHash TEXT NOT NULL DEFAULT '',
	lifecycleState TEXT NOT NULL,
	allocationMultiplier REAL NOT NULL,
	lastGradeRunId TEXT,
	updatedAt TEXT NOT NULL,
	detailJson TEXT,
	PRIMARY KEY (strategyName, symbol, strategyVersion, paramsHash)
);

CREATE INDEX IF NOT EXISTS idx_strategy_lifecycle_state
	ON strategy_lifecycle (lifecycleState, updatedAt DESC);

-- DOWN

DROP INDEX IF EXISTS idx_strategy_lifecycle_state;
DROP TABLE IF EXISTS strategy_lifecycle;
DROP INDEX IF EXISTS idx_strategy_grade_runs_name_time;
DROP TABLE IF EXISTS strategy_grade_runs;
