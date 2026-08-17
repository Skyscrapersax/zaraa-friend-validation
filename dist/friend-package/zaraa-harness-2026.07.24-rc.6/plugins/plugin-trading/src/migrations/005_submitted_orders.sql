-- Migration 005: Submitted orders table for idempotency
-- Prevents duplicate order submission when a signal is received more than once
-- or when a timeout causes uncertainty about whether an order was placed.
--
-- key       — SHA-256 hash of (symbol + side + qty + type + time-window)
-- orderId   — exchange order ID, set once the order is confirmed on exchange
-- status    — pending (submitted, awaiting confirmation) | confirmed | failed
-- symbol    — instrument name (e.g. BTC_USDT)
-- createdAt — ISO timestamp for 24-hour TTL cleanup

-- UP

CREATE TABLE IF NOT EXISTS submitted_orders (
	key       TEXT NOT NULL PRIMARY KEY,
	orderId   TEXT,
	status    TEXT NOT NULL DEFAULT 'pending',
	symbol    TEXT NOT NULL,
	createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submitted_orders_created
	ON submitted_orders (createdAt);

-- DOWN

DROP INDEX IF EXISTS idx_submitted_orders_created;
DROP TABLE IF EXISTS submitted_orders;
