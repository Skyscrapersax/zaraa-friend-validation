-- Migration 014: raise max_total_drawdown_pct from 0.02 to 0.07.
--
-- The 2% threshold seeded by migration 011 fired the automated risk lock
-- at normal paper-trading drawdown, blocking all entries across multiple
-- sessions despite a 10% RiskManager.maxDrawdownPct elsewhere in the system.
-- 0.07 matches the code default in automated-risk-lock.ts and aligns the two
-- subsystems so the lock only triggers on genuinely large drawdowns.
--
-- daily_loss_hardstop_pct stays at 0.02 — a 2% daily realized loss limit is
-- intentional and unrelated to the drawdown lock that was over-firing.

-- UP

UPDATE settings SET value = '0.07'
	WHERE key = 'max_total_drawdown_pct' AND value = '0.02';

-- DOWN

UPDATE settings SET value = '0.02'
	WHERE key = 'max_total_drawdown_pct' AND value = '0.07';
