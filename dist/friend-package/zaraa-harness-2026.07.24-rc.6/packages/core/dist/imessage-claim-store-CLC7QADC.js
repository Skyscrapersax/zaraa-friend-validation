import "./chunk-R5U7XKVJ.js";

// src/messaging/imessage-claim-store.ts
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var DEFAULT_CLAIM_STORE_PATH = join(homedir(), ".zaraa", "data", "imessage-poller.db");
var RETRY_CLAIM_BUFFER_MS = 1e4;
var SQLiteIMessageClaimStore = class {
  db;
  constructor(config) {
    const path = config?.path ?? DEFAULT_CLAIM_STORE_PATH;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS imessage_message_claims (
				message_id INTEGER PRIMARY KEY,
				owner_id TEXT NOT NULL,
				status TEXT NOT NULL,
				lease_expires_at INTEGER,
				updated_at INTEGER NOT NULL,
				last_error TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_imessage_message_claims_status_lease
				ON imessage_message_claims(status, lease_expires_at);
		`);
  }
  tryClaim(messageId, ownerId, leaseMs) {
    const now = Date.now();
    const leaseExpiresAt = now + Math.max(1e3, leaseMs);
    const claim = this.db.transaction((id, owner, expiresAt, ts) => {
      const existing = this.db.prepare(
        `SELECT message_id, owner_id, status, lease_expires_at
					 FROM imessage_message_claims
					 WHERE message_id = ?`
      ).get(id);
      if (!existing) {
        this.db.prepare(
          `INSERT INTO imessage_message_claims (
							message_id, owner_id, status, lease_expires_at, updated_at, last_error
						) VALUES (?, ?, 'processing', ?, ?, NULL)`
        ).run(id, owner, expiresAt, ts);
        return true;
      }
      if (existing.status === "handled" || existing.status === "failed") {
        return false;
      }
      const leaseExpired = typeof existing.lease_expires_at !== "number" || existing.lease_expires_at <= ts;
      if (!leaseExpired && existing.owner_id !== owner) {
        return false;
      }
      this.db.prepare(
        `UPDATE imessage_message_claims
					 SET owner_id = ?, status = 'processing', lease_expires_at = ?, updated_at = ?, last_error = NULL
					 WHERE message_id = ?`
      ).run(owner, expiresAt, ts, id);
      return true;
    });
    return claim(messageId, ownerId, leaseExpiresAt, now);
  }
  markHandled(messageId, ownerId) {
    this.db.prepare(
      `UPDATE imessage_message_claims
				 SET status = 'handled', lease_expires_at = NULL, updated_at = ?, last_error = NULL
				 WHERE message_id = ? AND owner_id = ? AND status = 'processing'`
    ).run(Date.now(), messageId, ownerId);
  }
  markRetryScheduled(messageId, ownerId, nextRetryAt, lastError) {
    const leaseExpiresAt = Math.max(Date.now(), nextRetryAt) + RETRY_CLAIM_BUFFER_MS;
    this.db.prepare(
      `UPDATE imessage_message_claims
				 SET lease_expires_at = ?, updated_at = ?, last_error = ?
				 WHERE message_id = ? AND owner_id = ? AND status = 'processing'`
    ).run(leaseExpiresAt, Date.now(), lastError.slice(0, 500), messageId, ownerId);
  }
  markFailed(messageId, ownerId, lastError) {
    this.db.prepare(
      `UPDATE imessage_message_claims
				 SET status = 'failed', lease_expires_at = NULL, updated_at = ?, last_error = ?
				 WHERE message_id = ? AND owner_id = ? AND status = 'processing'`
    ).run(Date.now(), lastError.slice(0, 500), messageId, ownerId);
  }
  close() {
    this.db.close();
  }
};
export {
  SQLiteIMessageClaimStore
};
