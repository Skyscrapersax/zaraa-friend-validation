-- Migration 016: Mark shadow trades in strategy_trades.
--
-- Before this migration, shadow / paper / live trades all landed in the same
-- strategy_trades rows with no way to distinguish them. Shadow positions
-- closing through StopMonitor never updated their exit fields either, so the
-- learning-loop consumers (leaderboard, grader, return attribution, dynamic
-- risk) silently mixed shadow signals with real outcomes — or excluded them
-- entirely because exitedAt was always NULL.
--
-- isShadow = 1 marks rows produced by the shadow execution path. Default 0 so
-- all existing rows continue to be treated as paper/live. Consumer queries
-- filter on isShadow = 0 by default; shadow-only views opt in explicitly.

-- UP

ALTER TABLE strategy_trades ADD COLUMN isShadow INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_strategy_trades_shadow
	ON strategy_trades (isShadow, exitedAt DESC);

-- DOWN

DROP INDEX IF EXISTS idx_strategy_trades_shadow;

-- SQLite cannot DROP COLUMN before 3.35; the column is harmless at default 0
-- so leaving it in place on rollback is acceptable.
