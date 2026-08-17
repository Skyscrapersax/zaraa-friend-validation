-- Migration 009: Persist scale-out milestone hits
-- Tracks which profit milestones have fired for each open position so that
-- milestone state survives process restarts without double-scaling.

-- UP

CREATE TABLE IF NOT EXISTS position_milestones (
	positionId TEXT NOT NULL,
	profitPct  REAL NOT NULL,
	firedAt    TEXT NOT NULL,
	PRIMARY KEY (positionId, profitPct)
);

-- DOWN

DROP TABLE IF EXISTS position_milestones;
