// src/storage/creative-project-store.ts
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
var CreativeReleaseReadinessError = class extends Error {
  constructor(gaps) {
    super(`Creative project cannot be released: ${gaps.join("; ")}`);
    this.gaps = gaps;
    this.name = "CreativeReleaseReadinessError";
  }
  gaps;
};
function clampLimit(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(500, Math.trunc(value ?? 50)));
}
function clampOffset(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}
var CreativeProjectStore = class {
  db;
  outputDir;
  constructor(config) {
    this.db = new Database(config.path);
    this.outputDir = config.outputDir ?? join(homedir(), ".zaraa", "creative-outputs");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }
  createProject(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const project = {
      id: randomUUID(),
      title: input.title,
      medium: input.medium,
      status: "source-gated",
      humanSource: input.humanSource,
      audience: input.audience,
      form: input.form,
      qualityGate: input.qualityGate,
      provenanceNotes: input.provenanceNotes,
      linkedSessionId: input.linkedSessionId ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(`
			INSERT INTO creative_projects (
				id, title, medium, status, humanSource, audience, form, qualityGate,
				provenanceNotes, linkedSessionId, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      project.id,
      project.title,
      project.medium,
      project.status,
      project.humanSource,
      project.audience,
      project.form,
      project.qualityGate,
      project.provenanceNotes,
      project.linkedSessionId,
      project.createdAt,
      project.updatedAt
    );
    return project;
  }
  getProject(id) {
    const project = this.getProjectRow(id);
    if (!project) return null;
    return {
      project: this.rowToProject(project),
      references: this.listReferences(id),
      generations: this.listGenerations(id),
      critiques: this.listCritiques(id)
    };
  }
  listProjects(options) {
    const params = [];
    const search = options?.search?.trim();
    const where = search ? "WHERE title LIKE ? OR humanSource LIKE ? OR audience LIKE ? OR form LIKE ? OR provenanceNotes LIKE ?" : "";
    if (search) {
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM creative_projects ${where}`).get(...params);
    const rows = this.db.prepare(`
			SELECT * FROM creative_projects ${where}
			ORDER BY updatedAt DESC, createdAt DESC
			LIMIT ? OFFSET ?
		`).all(
      ...params,
      clampLimit(options?.limit),
      clampOffset(options?.offset)
    );
    return { projects: rows.map((row) => this.rowToProject(row)), total: total.count };
  }
  updateProject(id, input) {
    const existing = this.getProjectRow(id);
    if (!existing) return null;
    const updated = {
      ...this.rowToProject(existing),
      ...input,
      linkedSessionId: input.linkedSessionId ?? existing.linkedSessionId,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (updated.status === "generated") {
      this.assertGeneratedReady({
        project: updated,
        critiques: this.listCritiques(id)
      });
    }
    if (updated.status === "released") {
      this.assertReleaseReady({
        project: updated,
        references: this.listReferences(id),
        generations: this.listGenerations(id),
        critiques: this.listCritiques(id)
      });
    }
    this.db.prepare(`
			UPDATE creative_projects
			SET title = ?, medium = ?, status = ?, humanSource = ?, audience = ?, form = ?,
				qualityGate = ?, provenanceNotes = ?, linkedSessionId = ?, updatedAt = ?
			WHERE id = ?
		`).run(
      updated.title,
      updated.medium,
      updated.status,
      updated.humanSource,
      updated.audience,
      updated.form,
      updated.qualityGate,
      updated.provenanceNotes,
      updated.linkedSessionId,
      updated.updatedAt,
      id
    );
    return this.getProject(id);
  }
  addReference(projectId, input) {
    this.assertProject(projectId);
    const reference = {
      id: randomUUID(),
      projectId,
      title: input.title,
      url: input.url ?? null,
      transferablePattern: input.transferablePattern,
      nonTransferableElements: input.nonTransferableElements,
      provenanceNotes: input.provenanceNotes,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.db.prepare(`
			INSERT INTO creative_references (
				id, projectId, title, url, transferablePattern, nonTransferableElements,
				provenanceNotes, createdAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      reference.id,
      reference.projectId,
      reference.title,
      reference.url,
      reference.transferablePattern,
      reference.nonTransferableElements,
      reference.provenanceNotes,
      reference.createdAt
    );
    this.touchProject(projectId);
    return reference;
  }
  logGeneration(projectId, input) {
    this.assertProject(projectId);
    const id = randomUUID();
    const generation = {
      id,
      projectId,
      tool: input.tool,
      taskId: input.taskId ?? null,
      prompt: input.prompt,
      outputUrl: this.resolveGenerationOutputUrl(projectId, id, input),
      humanSelection: input.humanSelection ?? null,
      notes: input.notes ?? null,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.db.prepare(`
			INSERT INTO creative_generations (
				id, projectId, tool, taskId, prompt, outputUrl, humanSelection, notes, createdAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      generation.id,
      generation.projectId,
      generation.tool,
      generation.taskId,
      generation.prompt,
      generation.outputUrl,
      generation.humanSelection,
      generation.notes,
      generation.createdAt
    );
    this.touchProject(projectId, this.hasCurrentGateCritique(projectId) ? "generated" : "draft");
    return generation;
  }
  logCritique(projectId, input) {
    const project = this.assertProject(projectId);
    const critique = {
      id: randomUUID(),
      projectId,
      verdict: input.verdict,
      qualityGate: project.qualityGate,
      scores: input.scores,
      highestLeverageRevision: input.highestLeverageRevision,
      provenanceGaps: input.provenanceGaps,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.db.prepare(`
			INSERT INTO creative_critiques (
				id, projectId, verdict, qualityGate, scores, highestLeverageRevision, provenanceGaps, createdAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      critique.id,
      critique.projectId,
      critique.verdict,
      critique.qualityGate,
      JSON.stringify(critique.scores),
      critique.highestLeverageRevision,
      critique.provenanceGaps,
      critique.createdAt
    );
    this.touchProject(projectId, "reviewed");
    return critique;
  }
  close() {
    this.db.close();
  }
  initTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS creative_projects (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				medium TEXT NOT NULL,
				status TEXT NOT NULL,
				humanSource TEXT NOT NULL,
				audience TEXT NOT NULL,
				form TEXT NOT NULL,
				qualityGate TEXT NOT NULL,
				provenanceNotes TEXT NOT NULL,
				linkedSessionId TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_creative_projects_updated ON creative_projects(updatedAt DESC);
			CREATE TABLE IF NOT EXISTS creative_references (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				url TEXT,
				transferablePattern TEXT NOT NULL,
				nonTransferableElements TEXT NOT NULL,
				provenanceNotes TEXT NOT NULL,
				createdAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_creative_references_project ON creative_references(projectId);
			CREATE TABLE IF NOT EXISTS creative_generations (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
				tool TEXT NOT NULL,
				taskId TEXT,
				prompt TEXT NOT NULL,
				outputUrl TEXT,
				humanSelection TEXT,
				notes TEXT,
				createdAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_creative_generations_project ON creative_generations(projectId);
			CREATE TABLE IF NOT EXISTS creative_critiques (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
				verdict TEXT NOT NULL,
				qualityGate TEXT NOT NULL DEFAULT '',
				scores TEXT NOT NULL,
				highestLeverageRevision TEXT NOT NULL,
				provenanceGaps TEXT NOT NULL,
				createdAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_creative_critiques_project ON creative_critiques(projectId);
		`);
    this.ensureColumn("creative_critiques", "qualityGate", "TEXT NOT NULL DEFAULT ''");
  }
  getProjectRow(id) {
    const row = this.db.prepare("SELECT * FROM creative_projects WHERE id = ?").get(id);
    return row ?? null;
  }
  ensureColumn(table, column, definition) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  assertProject(projectId) {
    const project = this.getProjectRow(projectId);
    if (!project) throw new Error("Creative project not found.");
    return this.rowToProject(project);
  }
  touchProject(projectId, status) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (status) {
      this.db.prepare("UPDATE creative_projects SET status = ?, updatedAt = ? WHERE id = ?").run(status, now, projectId);
      return;
    }
    this.db.prepare("UPDATE creative_projects SET updatedAt = ? WHERE id = ?").run(now, projectId);
  }
  listReferences(projectId) {
    const rows = this.db.prepare(`
			SELECT * FROM creative_references WHERE projectId = ? ORDER BY createdAt ASC
		`).all(projectId);
    return rows.map((row) => this.rowToReference(row));
  }
  listGenerations(projectId) {
    const rows = this.db.prepare(`
			SELECT * FROM creative_generations WHERE projectId = ? ORDER BY createdAt ASC
		`).all(projectId);
    return rows.map((row) => this.rowToGeneration(row));
  }
  listCritiques(projectId) {
    const rows = this.db.prepare(`
			SELECT * FROM creative_critiques WHERE projectId = ? ORDER BY createdAt ASC
		`).all(projectId);
    return rows.map((row) => this.rowToCritique(row));
  }
  rowToProject(row) {
    return { ...row };
  }
  rowToReference(row) {
    return { ...row };
  }
  rowToGeneration(row) {
    return { ...row };
  }
  rowToCritique(row) {
    return {
      ...row,
      qualityGate: row.qualityGate ?? "",
      scores: JSON.parse(row.scores)
    };
  }
  resolveGenerationOutputUrl(projectId, generationId, input) {
    const outputUrl = typeof input.outputUrl === "string" ? input.outputUrl.trim() : "";
    if (outputUrl.toLowerCase().startsWith("chat://")) {
      throw new Error("Ephemeral chat:// outputUrl refused; persist the creative output first.");
    }
    const outputContent = typeof input.outputContent === "string" ? input.outputContent : "";
    if (outputContent.length > 0) {
      const projectDir = join(this.outputDir, projectId);
      mkdirSync(projectDir, { recursive: true });
      const outputPath = join(projectDir, `${generationId}.md`);
      writeFileSync(outputPath, outputContent, "utf-8");
      return outputPath;
    }
    return outputUrl || null;
  }
  hasCurrentGateCritique(projectId) {
    const project = this.getProjectRow(projectId);
    if (!project) return false;
    return this.listCritiques(projectId).some(
      (critique) => critique.qualityGate.trim() === project.qualityGate.trim()
    );
  }
  assertGeneratedReady(snapshot) {
    if (!snapshot.critiques.some(
      (critique) => critique.qualityGate.trim() === snapshot.project.qualityGate.trim()
    )) {
      throw new Error(
        "Creative project cannot be marked generated before a critique against the current quality gate is logged."
      );
    }
  }
  assertReleaseReady(snapshot) {
    const gaps = [];
    if (!snapshot.project.humanSource.trim()) gaps.push("human source missing");
    if (isVagueQualityGate(snapshot.project.qualityGate))
      gaps.push("quality gate missing or vague");
    if (!snapshot.project.provenanceNotes.trim()) gaps.push("project provenance missing");
    if (snapshot.references.length === 0) gaps.push("no references mapped");
    if (!snapshot.generations.some((generation) => generation.humanSelection?.trim())) {
      gaps.push("no human generation selection logged");
    }
    const latestCritique = snapshot.critiques.at(-1);
    if (!latestCritique) {
      gaps.push("no anti-slop critique logged");
    } else {
      if (latestCritique.verdict !== "ship") gaps.push("latest critique verdict is not ship");
      const lowestScore = Math.min(...Object.values(latestCritique.scores));
      if (lowestScore < 4) gaps.push(`latest critique score below 4 (${lowestScore})`);
      if (hasOpenProvenanceGap(latestCritique.provenanceGaps)) {
        gaps.push("latest critique has provenance gaps");
      }
    }
    if (gaps.length > 0) throw new CreativeReleaseReadinessError(gaps);
  }
};
function isVagueQualityGate(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase();
  return trimmed.length < 24 || /\b(high quality|beautiful|premium|viral|cinematic|stunning|make it pop|looks good)\b/.test(
    normalized
  );
}
function hasOpenProvenanceGap(value) {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return !["no gaps", "no known gaps", "none", "n/a"].includes(normalized);
}

export {
  CreativeReleaseReadinessError,
  CreativeProjectStore
};
