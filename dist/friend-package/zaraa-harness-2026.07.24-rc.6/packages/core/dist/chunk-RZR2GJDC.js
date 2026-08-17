// src/messaging/whatsapp-store.ts
import Database from "better-sqlite3";
var WhatsAppStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
  }
  createTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				sid TEXT PRIMARY KEY,
				body TEXT NOT NULL,
				from_number TEXT NOT NULL,
				to_number TEXT NOT NULL,
				direction TEXT NOT NULL,
				status TEXT NOT NULL,
				date_sent TEXT NOT NULL,
				fetched_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_wa_date_sent ON messages(date_sent);
			CREATE INDEX IF NOT EXISTS idx_wa_from_number ON messages(from_number);
			CREATE INDEX IF NOT EXISTS idx_wa_to_number ON messages(to_number);
		`);
  }
  upsert(messages) {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO messages (sid, body, from_number, to_number, direction, status, date_sent, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        stmt.run(m.sid, m.body, m.fromNumber, m.toNumber, m.direction, m.status, m.dateSent, now);
      }
    });
    tx();
  }
  readRecent(limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY date_sent DESC LIMIT ?").all(limit);
    return rows.map(this.rowToMessage);
  }
  search(query, limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE body LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY date_sent DESC LIMIT ?").all(query, limit);
    return rows.map(this.rowToMessage);
  }
  readThread(contact, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE from_number = ? OR to_number = ? ORDER BY date_sent ASC LIMIT ?").all(contact, contact, limit);
    return rows.map(this.rowToMessage);
  }
  getLastMessageDate() {
    const row = this.db.prepare("SELECT MAX(date_sent) as max_date FROM messages").get();
    return row?.max_date ?? null;
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  rowToMessage(row) {
    return {
      sid: row.sid,
      body: row.body,
      fromNumber: row.from_number,
      toNumber: row.to_number,
      direction: row.direction,
      status: row.status,
      dateSent: row.date_sent
    };
  }
};

export {
  WhatsAppStore
};
