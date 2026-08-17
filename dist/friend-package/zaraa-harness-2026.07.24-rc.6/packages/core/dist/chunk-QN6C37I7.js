// src/messaging/slack-store.ts
import Database from "better-sqlite3";
var SlackStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
  }
  createTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				ts TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				text TEXT NOT NULL,
				user_id TEXT NOT NULL,
				user_name TEXT NOT NULL,
				thread_ts TEXT,
				fetched_at TEXT NOT NULL,
				PRIMARY KEY (channel_id, ts)
			);
			CREATE INDEX IF NOT EXISTS idx_slack_channel_id ON messages(channel_id);
		`);
  }
  upsert(messages) {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO messages (ts, channel_id, text, user_id, user_name, thread_ts, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        stmt.run(m.ts, m.channelId, m.text, m.userId, m.userName, m.threadTs ?? null, now);
      }
    });
    tx();
  }
  readRecent(limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit);
    return rows.map(this.rowToMessage);
  }
  search(query, limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE text LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY ts DESC LIMIT ?").all(query, limit);
    return rows.map(this.rowToMessage);
  }
  readChannel(channelId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY ts ASC LIMIT ?").all(channelId, limit);
    return rows.map(this.rowToMessage);
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  rowToMessage(row) {
    const msg = {
      ts: row.ts,
      channelId: row.channel_id,
      text: row.text,
      userId: row.user_id,
      userName: row.user_name
    };
    if (row.thread_ts != null) {
      msg.threadTs = row.thread_ts;
    }
    return msg;
  }
};

export {
  SlackStore
};
