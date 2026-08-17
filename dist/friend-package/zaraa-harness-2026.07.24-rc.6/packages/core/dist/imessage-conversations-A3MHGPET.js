import "./chunk-R5U7XKVJ.js";

// src/messaging/imessage-conversations.ts
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var DEFAULT_PATH = join(homedir(), ".zaraa", "data", "imessage-conversations.db");
var DEFAULT_HISTORY_LIMIT = 10;
var MAX_HISTORY_LIMIT = 50;
var SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS imessage_conversations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		sender TEXT NOT NULL,
		ts INTEGER NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
		content TEXT NOT NULL
	)`,
  `CREATE INDEX IF NOT EXISTS idx_imessage_conversations_sender_ts
		ON imessage_conversations(sender, ts)`
];
var SQLiteIMessageConversationStore = class {
  db;
  constructor(config) {
    const path = config?.path ?? DEFAULT_PATH;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.prepare(stmt).run();
    }
  }
  appendTurn(sender, role, content) {
    if (!sender || !content) return;
    this.db.prepare(
      `INSERT INTO imessage_conversations (sender, ts, role, content)
				 VALUES (?, ?, ?, ?)`
    ).run(normalizeSender(sender), Date.now(), role, content);
  }
  loadHistory(sender, limit = DEFAULT_HISTORY_LIMIT) {
    const clamped = Math.min(Math.max(1, limit), MAX_HISTORY_LIMIT);
    const rows = this.db.prepare(
      `SELECT sender, ts, role, content
				 FROM imessage_conversations
				 WHERE sender = ?
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`
    ).all(normalizeSender(sender), clamped);
    return rows.reverse();
  }
  clearHistory(sender) {
    const result = this.db.prepare(`DELETE FROM imessage_conversations WHERE sender = ?`).run(normalizeSender(sender));
    return result.changes;
  }
  pruneOlderThan(cutoffMs) {
    const result = this.db.prepare(`DELETE FROM imessage_conversations WHERE ts < ?`).run(cutoffMs);
    return result.changes;
  }
  close() {
    this.db.close();
  }
};
function normalizeSender(sender) {
  return sender.trim().toLowerCase();
}
export {
  SQLiteIMessageConversationStore
};
