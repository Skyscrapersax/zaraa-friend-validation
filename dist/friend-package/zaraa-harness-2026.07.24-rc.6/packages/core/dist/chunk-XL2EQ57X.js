// src/messaging/imessage-reader.ts
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
var APPLE_EPOCH_OFFSET = 978307200;
function convertAppleTimestamp(ts) {
  const seconds = ts / 1e9;
  const unixSeconds = seconds + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1e3).toISOString();
}
function resolveAttachmentPath(rawPath) {
  if (!rawPath) return "";
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) {
    return join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}
function rowToMessage(row, attachments) {
  return {
    id: row.ROWID,
    text: row.text ?? "",
    date: convertAppleTimestamp(row.date),
    isFromMe: row.is_from_me === 1,
    handleId: row.handle_id ?? "",
    chatId: row.chat_identifier ?? "",
    service: row.service ?? "",
    ...attachments && attachments.length > 0 ? { attachments } : {}
  };
}
var PERMISSION_ERROR_MESSAGE = "Full Disk Access required. Grant it in System Settings \u2192 Privacy & Security \u2192 Full Disk Access for your terminal app.";
var STARTUP_WARNING_HEADER = "[imessage-reader] TCC-blocked: cannot open ~/Library/Messages/chat.db";
var STARTUP_WARNING_PATH = "  Fix: System Settings \u2192 Privacy & Security \u2192 Full Disk Access \u2192 enable for the process running zaraa-daemon (Terminal.app, iTerm, or `node` if launched from launchd). Then restart the daemon.";
var IMessageReader = class {
  hasPermission;
  permissionError;
  db = null;
  constructor(config) {
    const dbPath = config?.dbPath ?? join(homedir(), "Library", "Messages", "chat.db");
    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.hasPermission = true;
    } catch (err) {
      this.db = null;
      this.hasPermission = false;
      this.permissionError = PERMISSION_ERROR_MESSAGE;
      const detail = err instanceof Error ? err.message : String(err);
      console.debug("[imessage-reader] DB open failed:", detail);
      if (!config?.silent) {
        console.warn(STARTUP_WARNING_HEADER);
        console.warn(STARTUP_WARNING_PATH);
        console.warn(`  Underlying error: ${detail}`);
      }
    }
  }
  /**
   * Fetch attachment metadata for a set of message ROWIDs.
   */
  fetchAttachments(messageIds) {
    const map = /* @__PURE__ */ new Map();
    if (!this.db || messageIds.length === 0) return map;
    try {
      const placeholders = messageIds.map(() => "?").join(",");
      const stmt = this.db.prepare(`
				SELECT maj.message_id, a.filename, a.mime_type, a.transfer_name
				FROM message_attachment_join maj
				JOIN attachment a ON a.ROWID = maj.attachment_id
				WHERE maj.message_id IN (${placeholders})
			`);
      const rows = stmt.all(...messageIds);
      for (const row of rows) {
        const att = {
          filename: row.transfer_name || row.filename?.split("/").pop() || "unknown",
          mimeType: row.mime_type || "application/octet-stream",
          path: resolveAttachmentPath(row.filename)
        };
        const existing = map.get(row.message_id) || [];
        existing.push(att);
        map.set(row.message_id, existing);
      }
    } catch (err) {
      console.debug("[imessage-reader] attachment query failed:", err instanceof Error ? err.message : err);
    }
    return map;
  }
  /**
   * Read recent messages, optionally filtered by contact handle (phone/email).
   */
  readRecent(options) {
    if (!this.db) return [];
    const limit = options?.limit ?? 50;
    const contact = options?.contact;
    let rows;
    if (contact) {
      const stmt = this.db.prepare(`
				SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id as handle_id, c.chat_identifier, m.service
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
				LEFT JOIN chat c ON c.ROWID = cmj.chat_id
				WHERE h.id = ? AND (m.text IS NOT NULL OR m.cache_has_attachments = 1)
				ORDER BY m.date DESC
				LIMIT ?
			`);
      rows = stmt.all(contact, limit);
    } else {
      const stmt = this.db.prepare(`
				SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id as handle_id, c.chat_identifier, m.service
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
				LEFT JOIN chat c ON c.ROWID = cmj.chat_id
				WHERE m.text IS NOT NULL
				ORDER BY m.date DESC
				LIMIT ?
			`);
      rows = stmt.all(limit);
    }
    const attachments = this.fetchAttachments(rows.map((r) => r.ROWID));
    return rows.map((row) => rowToMessage(row, attachments.get(row.ROWID)));
  }
  /**
   * Search messages by text content (case-insensitive LIKE match).
   */
  search(query, limit = 50) {
    if (!this.db) return [];
    const stmt = this.db.prepare(`
			SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id as handle_id, c.chat_identifier, m.service
			FROM message m
			LEFT JOIN handle h ON m.handle_id = h.ROWID
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN chat c ON c.ROWID = cmj.chat_id
			WHERE m.text IS NOT NULL AND m.text LIKE '%' || ? || '%'
			ORDER BY m.date DESC
			LIMIT ?
		`);
    const rows = stmt.all(query, limit);
    return rows.map((row) => rowToMessage(row));
  }
  /**
   * Read messages from a specific chat thread, ordered ascending (oldest first).
   */
  readThread(chatId, limit = 100) {
    if (!this.db) return [];
    const stmt = this.db.prepare(`
			SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id as handle_id, c.chat_identifier, m.service
			FROM message m
			LEFT JOIN handle h ON m.handle_id = h.ROWID
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN chat c ON c.ROWID = cmj.chat_id
			WHERE m.text IS NOT NULL AND c.chat_identifier = ?
			ORDER BY m.date ASC
			LIMIT ?
		`);
    const rows = stmt.all(chatId, limit);
    return rows.map((row) => rowToMessage(row));
  }
  /**
   * Close the underlying database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
};

export {
  convertAppleTimestamp,
  IMessageReader
};
