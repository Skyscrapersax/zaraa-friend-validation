-- UP
CREATE TABLE IF NOT EXISTS strategy_regime_weights (
  strategy_name TEXT NOT NULL,
  regime TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  avg_pnl REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (strategy_name, regime)
);

-- DOWN
DROP TABLE IF EXISTS strategy_regime_weights;
