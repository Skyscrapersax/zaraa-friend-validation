// src/storage/document-store.ts
import Database from "better-sqlite3";
import crypto from "crypto";
var DocumentStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.initTables();
  }
  initTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS documents (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				content TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'note',
				tags TEXT NOT NULL DEFAULT '[]',
				source TEXT NOT NULL DEFAULT 'system',
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
			CREATE INDEX IF NOT EXISTS idx_documents_createdAt ON documents(createdAt DESC);
			CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
		`);
  }
  create(input) {
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const doc = {
      id,
      title: input.title,
      content: input.content,
      type: input.type || "note",
      tags: input.tags || [],
      source: input.source || "system",
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(
      `INSERT INTO documents (id, title, content, type, tags, source, createdAt, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(doc.id, doc.title, doc.content, doc.type, JSON.stringify(doc.tags), doc.source, doc.createdAt, doc.updatedAt);
    return doc;
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    return row ? this.rowToDocument(row) : null;
  }
  list(options) {
    const conditions = [];
    const params = [];
    if (options?.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options?.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }
    if (options?.search) {
      conditions.push("(title LIKE ? OR content LIKE ?)");
      const q = `%${options.search}%`;
      params.push(q, q);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(options?.limit ?? 50, 500);
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(
      `SELECT * FROM documents ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    return rows.map(this.rowToDocument);
  }
  update(id, input) {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...input,
      tags: input.tags ?? existing.tags,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.db.prepare(
      `UPDATE documents SET title = ?, content = ?, type = ?, tags = ?, source = ?, updatedAt = ? WHERE id = ?`
    ).run(updated.title, updated.content, updated.type, JSON.stringify(updated.tags), updated.source, updated.updatedAt, id);
    return updated;
  }
  delete(id) {
    const result = this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    return result.changes > 0;
  }
  count(options) {
    const conditions = [];
    const params = [];
    if (options?.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options?.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM documents ${where}`).get(...params);
    return row?.count ?? 0;
  }
  rowToDocument(row) {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      type: row.type,
      tags: JSON.parse(row.tags || "[]"),
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
};

export {
  DocumentStore
};
