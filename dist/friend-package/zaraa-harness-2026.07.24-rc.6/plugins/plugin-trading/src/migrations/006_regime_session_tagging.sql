-- Migration 006: Add regime and session tagging to signal_log and strategy_trades.
--
-- Enables post-hoc analysis of which market regimes and trading sessions
-- produce the best (and worst) trades. This data powers:
--   1. Journal regime breakdowns (which regimes are we profitable in?)
--   2. Session quality analysis (are we trading in good windows?)
--   3. Regime-segmented backtesting (how does a strategy perform per regime?)

-- UP

-- Add regime/session columns to signal_log (where signals are born)
ALTER TABLE signal_log ADD COLUMN regime TEXT;
ALTER TABLE signal_log ADD COLUMN regimeConfidence REAL;
ALTER TABLE signal_log ADD COLUMN session TEXT;
ALTER TABLE signal_log ADD COLUMN sessionFitness REAL;

-- Add regime/session to strategy_trades (carried from signal at entry time)
ALTER TABLE strategy_trades ADD COLUMN regime TEXT;
ALTER TABLE strategy_trades ADD COLUMN session TEXT;

-- Index for regime-based queries (journal breakdowns, performance analysis)
CREATE INDEX IF NOT EXISTS idx_signal_log_regime
	ON signal_log (regime, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_trades_regime
	ON strategy_trades (regime, enteredAt DESC);

-- DOWN

DROP INDEX IF EXISTS idx_strategy_trades_regime;
DROP INDEX IF EXISTS idx_signal_log_regime;
-- SQLite does not support DROP COLUMN prior to 3.35.0.
-- These columns are nullable so they're safe to leave if rollback isn't possible.
-- On SQLite >= 3.35.0:
-- ALTER TABLE signal_log DROP COLUMN regime;
-- ALTER TABLE signal_log DROP COLUMN regimeConfidence;
-- ALTER TABLE signal_log DROP COLUMN session;
-- ALTER TABLE signal_log DROP COLUMN sessionFitness;
-- ALTER TABLE strategy_trades DROP COLUMN regime;
-- ALTER TABLE strategy_trades DROP COLUMN session;
