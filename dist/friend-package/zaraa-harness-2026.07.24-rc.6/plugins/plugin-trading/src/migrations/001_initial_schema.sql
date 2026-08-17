-- Migration 001: Initial trading database schema
-- Sets up all tables used by TradingStore, TradeJournal, and CandleStore.
-- All three classes share the same SQLite database file.
--
-- positions       — open/closed trading positions
-- equity_snapshots — equity curve over time
-- price_alerts    — user-set price level notifications
-- trade_log       — record of every order placed
-- settings        — key/value config (max_trade_usd, paper_mode, etc.)
-- signal_log      — strategy-generated signals with their outcome
-- strategy_trades — completed trades tied back to signals (for performance analysis)
-- candles         — OHLCV price history by symbol + timeframe

-- UP

-- ── TradingStore tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS positions (
	id               TEXT NOT NULL PRIMARY KEY,
	symbol           TEXT NOT NULL,
	side             TEXT NOT NULL,
	entryPrice       REAL NOT NULL,
	qty              REAL NOT NULL,
	currentPrice     REAL,
	pnl              REAL,
	status           TEXT NOT NULL DEFAULT 'open',
	openedAt         TEXT NOT NULL,
	closedAt         TEXT,
	stopLoss         REAL,
	takeProfit       REAL,
	trailingStopPct  REAL,
	trailingStopHigh REAL
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
	timestamp TEXT NOT NULL PRIMARY KEY,
	equity    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS price_alerts (
	id          TEXT    NOT NULL PRIMARY KEY,
	symbol      TEXT    NOT NULL,
	condition   TEXT    NOT NULL,
	targetPrice REAL    NOT NULL,
	triggered   INTEGER NOT NULL DEFAULT 0,
	createdAt   TEXT    NOT NULL,
	triggeredAt TEXT
);

CREATE TABLE IF NOT EXISTS trade_log (
	id        TEXT NOT NULL PRIMARY KEY,
	symbol    TEXT NOT NULL,
	side      TEXT NOT NULL,
	type      TEXT NOT NULL,
	qty       REAL NOT NULL,
	price     REAL NOT NULL,
	total     REAL NOT NULL,
	orderId   TEXT,
	createdAt TEXT NOT NULL
);

-- Key/value settings (max_trade_usd, daily_limit_usd, paper_mode)
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT NOT NULL PRIMARY KEY,
	value TEXT NOT NULL
);

-- ── TradeJournal tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_log (
	id               TEXT NOT NULL PRIMARY KEY,
	strategyName     TEXT NOT NULL,
	symbol           TEXT NOT NULL,
	direction        TEXT NOT NULL,
	confidence       REAL NOT NULL,
	reason           TEXT NOT NULL,
	entryPrice       REAL NOT NULL,
	qty              REAL NOT NULL,
	stopLoss         REAL NOT NULL,
	takeProfit       REAL NOT NULL,
	status           TEXT NOT NULL DEFAULT 'generated',
	rejectionReasons TEXT,
	createdAt        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_log_strategy
	ON signal_log (strategyName, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_signal_log_status
	ON signal_log (status, createdAt DESC);

CREATE TABLE IF NOT EXISTS strategy_trades (
	id           TEXT NOT NULL PRIMARY KEY,
	signalId     TEXT NOT NULL,
	strategyName TEXT NOT NULL,
	symbol       TEXT NOT NULL,
	direction    TEXT NOT NULL,
	entryPrice   REAL NOT NULL,
	exitPrice    REAL,
	qty          REAL NOT NULL,
	pnl          REAL,
	rMultiple    REAL,
	exitReason   TEXT,
	enteredAt    TEXT NOT NULL,
	exitedAt     TEXT,
	FOREIGN KEY (signalId) REFERENCES signal_log(id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_trades_name
	ON strategy_trades (strategyName, enteredAt DESC);

-- ── CandleStore table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candles (
	symbol    TEXT    NOT NULL,
	timeframe TEXT    NOT NULL,
	openTime  INTEGER NOT NULL,
	open      REAL    NOT NULL,
	high      REAL    NOT NULL,
	low       REAL    NOT NULL,
	close     REAL    NOT NULL,
	volume    REAL    NOT NULL,
	PRIMARY KEY (symbol, timeframe, openTime)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup
	ON candles (symbol, timeframe, openTime DESC);

-- ── Default safety settings ──────────────────────────────────────────────────
-- These are conservative defaults. Real-money values must be set in config.
-- INSERT OR IGNORE means this only runs on a fresh database —
-- existing settings are never overwritten by a migration.

INSERT OR IGNORE INTO settings (key, value) VALUES ('max_trade_usd',   '25');
INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_limit_usd', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('paper_mode',      'true');

-- DOWN

DROP INDEX IF EXISTS idx_candles_lookup;
DROP TABLE IF EXISTS candles;
DROP INDEX IF EXISTS idx_strategy_trades_name;
DROP TABLE IF EXISTS strategy_trades;
DROP INDEX IF EXISTS idx_signal_log_status;
DROP INDEX IF EXISTS idx_signal_log_strategy;
DROP TABLE IF EXISTS signal_log;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS trade_log;
DROP TABLE IF EXISTS price_alerts;
DROP TABLE IF EXISTS equity_snapshots;
DROP TABLE IF EXISTS positions;
