-- Migration 011: persistent risk monitor and automated lock-state settings.
--
-- Adds an audit trail for automated risk transitions and seeds persistent
-- runtime settings for the 2% daily-loss hard stop, 2% max drawdown lock,
-- and fractional Kelly sizing.

-- UP

CREATE TABLE IF NOT EXISTS risk_monitor (
	id TEXT NOT NULL PRIMARY KEY,
	createdAt TEXT NOT NULL,
	fromState TEXT NOT NULL,
	toState TEXT NOT NULL,
	reason TEXT NOT NULL,
	detailJson TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_monitor_created
	ON risk_monitor (createdAt DESC);

INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_loss_hardstop_pct', '0.02');
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_total_drawdown_pct', '0.02');
INSERT OR IGNORE INTO settings (key, value) VALUES ('sizing_model', 'fractional_kelly_0.25');
INSERT OR IGNORE INTO settings (key, value) VALUES ('trading_state', 'ACTIVE');
INSERT OR IGNORE INTO settings (key, value) VALUES ('trading_status', 'ACTIVE');

-- DOWN

DELETE FROM settings WHERE key IN (
	'daily_loss_hardstop_pct',
	'max_total_drawdown_pct',
	'sizing_model',
	'trading_state',
	'trading_status'
);
DROP INDEX IF EXISTS idx_risk_monitor_created;
DROP TABLE IF EXISTS risk_monitor;
