-- Migration 017: Add indexes for hot trading query paths
--
-- As trade_log, positions, and strategy_trades grow, several frequently-run
-- queries fall into full table scans. These indexes cover the dominant WHERE /
-- ORDER BY patterns identified in TradingStore, TradeJournal, LeaderboardStore,
-- StrategyGrader, and JournalReporter.
--
-- All use IF NOT EXISTS so re-running is safe on databases that already have
-- some of these (none should exist yet — just a safety net).

-- UP

-- ── trade_log ───────────────────────────────────────────────────────────────
-- getDailySpend / getDexSolanaDailySpend: WHERE isPaper = ? AND createdAt LIKE ?
-- getRecentTrades: ORDER BY createdAt DESC
CREATE INDEX IF NOT EXISTS idx_trade_log_paper_created
    ON trade_log (isPaper, createdAt DESC);

-- Per-symbol history lookups (e.g. journal reporter, future analytics)
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol_created
    ON trade_log (symbol, createdAt DESC);

-- ── positions ───────────────────────────────────────────────────────────────
-- getOpenPositions, getPositionsWithStops, getOpenPositionsMissingStopLoss:
--   WHERE status = 'open' ORDER BY openedAt DESC
CREATE INDEX IF NOT EXISTS idx_positions_status_opened
    ON positions (status, openedAt DESC);

-- getConsecutiveLosses: WHERE status = 'closed' AND isPaper = ? ORDER BY closedAt DESC
-- getDailyPnLSummary:   WHERE status = 'closed' AND closedAt LIKE ? AND isPaper = ?
-- resetPaperPortfolio:  DELETE ... WHERE isPaper = 1
CREATE INDEX IF NOT EXISTS idx_positions_status_paper_closed
    ON positions (status, isPaper, closedAt DESC);

-- ── strategy_trades ─────────────────────────────────────────────────────────
-- findOpenTrade: WHERE symbol = ? AND direction = ? AND exitedAt IS NULL AND isShadow = ?
CREATE INDEX IF NOT EXISTS idx_strategy_trades_open_lookup
    ON strategy_trades (symbol, direction, isShadow, exitedAt);

-- Grader / ranker / leaderboard aggregate queries:
--   WHERE strategyName = ? AND exitedAt IS NOT NULL AND isShadow = 0
-- Complements existing idx_strategy_trades_name (strategyName, enteredAt DESC)
-- by letting the planner skip shadow rows and unexited rows early.
CREATE INDEX IF NOT EXISTS idx_strategy_trades_perf
    ON strategy_trades (strategyName, isShadow, exitedAt);

-- DOWN

DROP INDEX IF EXISTS idx_strategy_trades_perf;
DROP INDEX IF EXISTS idx_strategy_trades_open_lookup;
DROP INDEX IF EXISTS idx_positions_status_paper_closed;
DROP INDEX IF EXISTS idx_positions_status_opened;
DROP INDEX IF EXISTS idx_trade_log_symbol_created;
DROP INDEX IF EXISTS idx_trade_log_paper_created;
