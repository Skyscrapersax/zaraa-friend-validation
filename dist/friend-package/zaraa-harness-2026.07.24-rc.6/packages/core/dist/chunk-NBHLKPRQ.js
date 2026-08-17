// src/messaging/discord-store.ts
import Database from "better-sqlite3";
var DiscordStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
  }
  createTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				message_id TEXT PRIMARY KEY,
				channel_id TEXT NOT NULL,
				guild_id TEXT NOT NULL,
				text TEXT NOT NULL,
				author_id TEXT NOT NULL,
				author_name TEXT NOT NULL,
				date TEXT NOT NULL,
				is_bot INTEGER NOT NULL,
				fetched_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_discord_channel_id ON messages(channel_id);
			CREATE INDEX IF NOT EXISTS idx_discord_date ON messages(date);
		`);
  }
  upsert(messages) {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO messages (message_id, channel_id, guild_id, text, author_id, author_name, date, is_bot, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        stmt.run(m.messageId, m.channelId, m.guildId, m.text, m.authorId, m.authorName, m.date, m.isBot ? 1 : 0, now);
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
  readChannel(channelId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY date ASC LIMIT ?").all(channelId, limit);
    return rows.map(this.rowToMessage);
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  rowToMessage(row) {
    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      text: row.text,
      authorId: row.author_id,
      authorName: row.author_name,
      date: row.date,
      isBot: row.is_bot === 1
    };
  }
};

export {
  DiscordStore
};
