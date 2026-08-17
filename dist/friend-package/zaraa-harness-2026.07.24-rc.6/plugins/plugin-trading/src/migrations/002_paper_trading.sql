-- Migration 002: Paper trading support
-- Adds isPaper flag to positions and trade_log, plus a virtual portfolio table.

-- UP

-- Add isPaper column to positions (default true = paper mode is the safe default)
ALTER TABLE positions ADD COLUMN isPaper INTEGER NOT NULL DEFAULT 1;

-- Add isPaper column to trade_log
ALTER TABLE trade_log ADD COLUMN isPaper INTEGER NOT NULL DEFAULT 1;

-- Virtual portfolio for paper trading — each row is a currency balance (USDT, BTC, ETH, etc.)
CREATE TABLE IF NOT EXISTS paper_balances (
	currency TEXT NOT NULL PRIMARY KEY,
	balance  REAL NOT NULL DEFAULT 0
);

-- Seed default paper balance ($1000 USDT)
INSERT OR IGNORE INTO paper_balances (currency, balance) VALUES ('USDT', 1000);

-- Add virtual_balance_usd setting
INSERT OR IGNORE INTO settings (key, value) VALUES ('virtual_balance_usd', '1000');

-- DOWN

DROP TABLE IF EXISTS paper_balances;
