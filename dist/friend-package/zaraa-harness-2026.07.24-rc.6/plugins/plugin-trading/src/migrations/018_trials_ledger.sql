-- Migration 018: Trials ledger (D14 — honest, shared, fail-closed N)
-- trials_ledger: append-only record of every strategy variant ever backtested,
--   across abandoned runs, crash-resumes, and ALL peer agents on the branch. The
--   deflated-Sharpe hurdle (multiple-testing penalty) is only as honest as this N.
-- trials_ledger_hwm: per-strategy high-water-mark of the trial count, used to
--   fail closed if the ledger ever regresses (rows lost / tampered).

-- UP

CREATE TABLE IF NOT EXISTS trials_ledger (
	id TEXT PRIMARY KEY,
	strategyName TEXT NOT NULL,
	paramsHash TEXT NOT NULL,
	symbol TEXT NOT NULL DEFAULT '',
	windowStart INTEGER NOT NULL DEFAULT 0,
	windowEnd INTEGER NOT NULL DEFAULT 0,
	agentId TEXT NOT NULL DEFAULT 'unknown',
	backtestSharpe REAL,
	evaluatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trials_ledger_strategy
	ON trials_ledger (strategyName);

CREATE TABLE IF NOT EXISTS trials_ledger_hwm (
	strategyName TEXT PRIMARY KEY,
	maxCount INTEGER NOT NULL
);

-- DOWN

DROP TABLE IF EXISTS trials_ledger;
DROP TABLE IF EXISTS trials_ledger_hwm;
