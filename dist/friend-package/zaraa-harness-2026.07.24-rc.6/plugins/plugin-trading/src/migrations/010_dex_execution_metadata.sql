-- 010: Optional metadata for on-chain (DEX) execution alongside CEX trades.

-- UP

ALTER TABLE trade_log ADD COLUMN executionVenue TEXT;
ALTER TABLE trade_log ADD COLUMN chain TEXT;
ALTER TABLE trade_log ADD COLUMN txSignature TEXT;
ALTER TABLE trade_log ADD COLUMN slippageBps INTEGER;
ALTER TABLE trade_log ADD COLUMN routeJson TEXT;

ALTER TABLE positions ADD COLUMN executionVenue TEXT;
ALTER TABLE positions ADD COLUMN chain TEXT;
ALTER TABLE positions ADD COLUMN txSignature TEXT;
ALTER TABLE positions ADD COLUMN slippageBps INTEGER;
ALTER TABLE positions ADD COLUMN routeJson TEXT;

-- DOWN

-- SQLite: columns left in place on rollback (harmless).
