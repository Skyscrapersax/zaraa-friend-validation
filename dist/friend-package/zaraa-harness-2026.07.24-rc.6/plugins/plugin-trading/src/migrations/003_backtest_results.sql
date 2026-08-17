-- Migration 003: Backtest results storage
-- Stores completed backtest runs for comparison over time.

-- UP

CREATE TABLE IF NOT EXISTS backtest_results (
	id TEXT PRIMARY KEY,
	strategy TEXT NOT NULL,
	symbol TEXT NOT NULL,
	timeframe TEXT NOT NULL,
	startDate TEXT NOT NULL,
	endDate TEXT NOT NULL,
	startingEquity REAL NOT NULL,
	finalEquity REAL NOT NULL,
	totalPnl REAL NOT NULL,
	totalReturnPct REAL NOT NULL,
	winRate REAL NOT NULL,
	sharpeRatio REAL NOT NULL,
	maxDrawdownPct REAL NOT NULL,
	totalTrades INTEGER NOT NULL,
	resultJson TEXT NOT NULL,
	createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_strategy ON backtest_results (strategy, symbol, createdAt DESC);

-- DOWN

DROP INDEX IF EXISTS idx_bt_strategy;
DROP TABLE IF EXISTS backtest_results;
