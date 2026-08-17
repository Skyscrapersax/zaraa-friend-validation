-- 008_fee_columns.sql

-- UP

ALTER TABLE positions ADD COLUMN entryFee REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN exitFee REAL NOT NULL DEFAULT 0;

-- DOWN

-- SQLite does not support DROP COLUMN in older versions;
-- these columns are harmless if left in place.
