// src/messaging/telegram-store.ts
import Database from "better-sqlite3";
var TelegramStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
  }
  createTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				chat_id INTEGER NOT NULL,
				message_id INTEGER NOT NULL,
				text TEXT NOT NULL,
				from_user TEXT NOT NULL,
				from_id INTEGER NOT NULL,
				date TEXT NOT NULL,
				is_bot INTEGER NOT NULL,
				fetched_at TEXT NOT NULL,
				PRIMARY KEY (chat_id, message_id)
			);
			CREATE INDEX IF NOT EXISTS idx_tg_date ON messages(date);
			CREATE INDEX IF NOT EXISTS idx_tg_chat_id ON messages(chat_id);
		`);
  }
  upsert(messages) {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO messages (chat_id, message_id, text, from_user, from_id, date, is_bot, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        stmt.run(m.chatId, m.messageId, m.text, m.fromUser, m.fromId, m.date, m.isBot ? 1 : 0, now);
      }
    });
    tx();
  }
  readRecent(limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages ORDER BY date DESC LIMIT ?").all(limit);
    return rows.map(this.rowToMessage);
  }
  search(query, limit = 50) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE text LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY date DESC LIMIT ?").all(query, limit);
    return rows.map(this.rowToMessage);
  }
  readChat(chatId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY date ASC LIMIT ?").all(chatId, limit);
    return rows.map(this.rowToMessage);
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  rowToMessage(row) {
    return {
      messageId: row.message_id,
      chatId: row.chat_id,
      text: row.text,
      fromUser: row.from_user,
      fromId: row.from_id,
      date: row.date,
      isBot: row.is_bot === 1
    };
  }
};

export {
  TelegramStore
};
