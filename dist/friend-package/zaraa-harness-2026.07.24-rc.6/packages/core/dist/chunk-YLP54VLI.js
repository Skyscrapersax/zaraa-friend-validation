// src/storage/designer-project-store.ts
import { randomUUID } from "crypto";
import {
  extractDesignerArtifacts,
  lintDesignerHtmlArtifact
} from "@zaraa/shared";
import Database from "better-sqlite3";
var DesignerProjectStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }
  createProject(input) {
    const id = randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const project = {
      id,
      title: input.title,
      brief: input.brief,
      status: "draft",
      skillId: input.skillId,
      systemId: input.systemId,
      directionId: input.directionId,
      testProjectId: input.testProjectId ?? null,
      linkedSessionId: input.linkedSessionId ?? null,
      filesystemPath: input.filesystemPath ?? null,
      currentCaptureId: null,
      currentManifestId: null,
      lastWarning: null,
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(`
			INSERT INTO designer_projects (
				id, title, brief, status, skillId, systemId, directionId, testProjectId,
				linkedSessionId, filesystemPath, currentCaptureId, currentManifestId, lastWarning, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      project.id,
      project.title,
      project.brief,
      project.status,
      project.skillId,
      project.systemId,
      project.directionId,
      project.testProjectId,
      project.linkedSessionId,
      project.filesystemPath,
      project.currentCaptureId,
      project.currentManifestId,
      project.lastWarning,
      project.createdAt,
      project.updatedAt
    );
    return project;
  }
  getProject(id) {
    const row = this.db.prepare("SELECT * FROM designer_projects WHERE id = ?").get(id);
    return row ? this.rowToProject(row) : null;
  }
  listProjects(options) {
    const params = [];
    const where = options?.search?.trim() ? "WHERE title LIKE ? OR brief LIKE ?" : "";
    if (where) {
      const search = `%${options?.search?.trim()}%`;
      params.push(search, search);
    }
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM designer_projects ${where}`).get(...params);
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const rows = this.db.prepare(`
			SELECT * FROM designer_projects ${where}
			ORDER BY updatedAt DESC, createdAt DESC
			LIMIT ? OFFSET ?
		`).all(...params, limit, offset);
    return {
      projects: rows.map((row) => this.rowToProject(row)),
      total: totalRow.count
    };
  }
  updateProject(id, input) {
    const existing = this.getProject(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...input,
      systemId: input.systemId ?? existing.systemId,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const tx = this.db.transaction(() => {
      this.validateProjectSelection(id, updated.currentCaptureId, updated.currentManifestId);
      this.db.prepare(`
				UPDATE designer_projects
				SET title = ?, brief = ?, status = ?, skillId = ?, systemId = ?, directionId = ?,
					testProjectId = ?, linkedSessionId = ?, filesystemPath = ?, currentCaptureId = ?, currentManifestId = ?,
					lastWarning = ?, updatedAt = ?
				WHERE id = ?
			`).run(
        updated.title,
        updated.brief,
        updated.status,
        updated.skillId,
        updated.systemId,
        updated.directionId,
        updated.testProjectId,
        updated.linkedSessionId,
        updated.filesystemPath,
        updated.currentCaptureId,
        updated.currentManifestId,
        updated.lastWarning,
        updated.updatedAt,
        id
      );
    });
    tx();
    return updated;
  }
  deleteProject(id) {
    const result = this.db.prepare("DELETE FROM designer_projects WHERE id = ?").run(id);
    return result.changes > 0;
  }
  captureArtifacts(projectId, input) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error("Designer project not found");
    }
    const artifacts = extractDesignerArtifacts(input.source);
    if (artifacts.length === 0) {
      const warning = "No artifact blocks found.";
      const now2 = (/* @__PURE__ */ new Date()).toISOString();
      const capture = {
        id: randomUUID(),
        projectId,
        manifestId: null,
        versionId: null,
        captureMode: input.captureMode,
        sessionId: input.sessionId,
        messageId: input.messageId,
        runId: input.runId,
        autoCaptured: input.autoCaptured,
        rawSource: input.source,
        artifactIndex: -1,
        artifactIdentifier: null,
        parsedTitle: null,
        parsedMimeType: null,
        parsedKind: null,
        parserWarnings: [warning],
        createdFrom: input.createdFrom ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        createdAt: now2
      };
      const tx2 = this.db.transaction(() => {
        this.insertCapture(capture);
        this.db.prepare(`
					UPDATE designer_projects
					SET status = 'warning', lastWarning = ?, updatedAt = ?
					WHERE id = ?
				`).run(warning, now2, projectId);
      });
      tx2();
      const updatedProject2 = this.getProject(projectId);
      if (!updatedProject2) {
        throw new Error("Designer project not found");
      }
      return {
        captures: [capture],
        selectedManifest: null,
        selectedVersion: null,
        project: updatedProject2,
        warnings: [warning]
      };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const captures = [];
    const warnings = [];
    let selectedManifest = null;
    let selectedCapture = null;
    let currentCapture = null;
    let currentManifest = null;
    const tx = this.db.transaction(() => {
      for (const [artifactIndex, artifact] of artifacts.entries()) {
        const captureId = randomUUID();
        const manifestId = randomUUID();
        const lintSummary = artifact.kind === "html" ? lintDesignerHtmlArtifact(artifact.content) : null;
        const manifestStatus = artifact.warnings.length > 0 || lintSummary && lintSummary.status !== "pass" ? "warning" : "captured";
        const manifest = {
          id: manifestId,
          projectId,
          captureId,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          renderer: artifact.kind === "html" ? "html-iframe" : "source-only",
          title: artifact.title,
          status: manifestStatus,
          sourceSkillId: project.skillId,
          designSystemId: project.systemId,
          directionId: project.directionId,
          exports: artifact.kind === "html" ? ["html"] : [],
          lintSummary,
          createdFrom: input.createdFrom ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          content: artifact.content,
          createdAt: now,
          updatedAt: now
        };
        const capture = {
          id: captureId,
          projectId,
          manifestId,
          versionId: null,
          captureMode: input.captureMode,
          sessionId: input.sessionId,
          messageId: input.messageId,
          runId: input.runId,
          autoCaptured: input.autoCaptured,
          rawSource: artifact.rawSource,
          artifactIndex,
          artifactIdentifier: artifact.identifier,
          parsedTitle: artifact.title,
          parsedMimeType: artifact.mimeType,
          parsedKind: artifact.kind,
          parserWarnings: artifact.warnings,
          createdFrom: input.createdFrom ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          createdAt: now
        };
        this.insertManifest(manifest);
        this.insertCapture(capture);
        captures.push(capture);
        currentCapture ??= capture;
        currentManifest ??= manifest;
        warnings.push(...capture.parserWarnings);
        if (lintSummary) {
          warnings.push(...lintSummary.issues.map((issue) => issue.message));
        }
        if (!selectedManifest && artifact.kind === "html") {
          selectedManifest = manifest;
          selectedCapture = capture;
        }
      }
      const projectCapture = selectedCapture ?? currentCapture;
      const projectManifest = selectedManifest ?? currentManifest;
      if (projectCapture && projectManifest) {
        const lastWarning = warnings.length > 0 ? summarizeWarnings(warnings) : null;
        this.db.prepare(`
					UPDATE designer_projects
					SET status = ?, currentCaptureId = ?, currentManifestId = ?, lastWarning = ?, updatedAt = ?
					WHERE id = ?
				`).run(
          lastWarning ? "warning" : "captured",
          projectCapture.id,
          projectManifest.id,
          lastWarning,
          now,
          projectId
        );
      }
    });
    tx();
    const updatedProject = this.getProject(projectId);
    if (!updatedProject) {
      throw new Error("Designer project not found");
    }
    return {
      captures,
      selectedManifest,
      selectedVersion: null,
      project: updatedProject,
      warnings
    };
  }
  listCaptures(projectId) {
    const rows = this.db.prepare(`
			SELECT * FROM designer_captures
			WHERE projectId = ?
			ORDER BY createdAt DESC
		`).all(projectId);
    return rows.map((row) => this.rowToCapture(row));
  }
  getManifest(id) {
    const row = this.db.prepare("SELECT * FROM designer_manifests WHERE id = ?").get(id);
    return row ? this.rowToManifest(row) : null;
  }
  promoteVersion(projectId, input) {
    const capture = this.db.prepare(`
			SELECT * FROM designer_captures
			WHERE id = ? AND projectId = ?
		`).get(input.captureId, projectId);
    if (!capture?.manifestId) {
      throw new Error("Designer capture not found");
    }
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error("Designer project not found");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const manifestId = capture.manifestId;
    let version = null;
    const tx = this.db.transaction(() => {
      const maxRow = this.db.prepare(`
				SELECT COALESCE(MAX(versionNumber), 0) AS versionNumber
				FROM designer_versions
				WHERE projectId = ?
			`).get(projectId);
      const next = {
        id: randomUUID(),
        projectId,
        captureId: capture.id,
        manifestId,
        name: input.name,
        description: input.description ?? null,
        versionNumber: maxRow.versionNumber + 1,
        promotedAt: now
      };
      this.db.prepare(`
				INSERT INTO designer_versions (
					id, projectId, captureId, manifestId, name, description, versionNumber, promotedAt
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
        next.id,
        next.projectId,
        next.captureId,
        next.manifestId,
        next.name,
        next.description,
        next.versionNumber,
        next.promotedAt
      );
      this.db.prepare(`
				UPDATE designer_projects
				SET status = 'saved', currentCaptureId = ?, currentManifestId = ?, updatedAt = ?
				WHERE id = ?
			`).run(next.captureId, next.manifestId, now, projectId);
      version = next;
    });
    tx();
    if (!version) {
      throw new Error("Designer version not created");
    }
    return version;
  }
  listVersions(projectId) {
    const rows = this.db.prepare(`
			SELECT * FROM designer_versions
			WHERE projectId = ?
			ORDER BY versionNumber ASC
		`).all(projectId);
    return rows.map((row) => this.rowToVersion(row));
  }
  restoreVersion(projectId, versionId) {
    const version = this.db.prepare(`
			SELECT * FROM designer_versions
			WHERE id = ? AND projectId = ?
		`).get(versionId, projectId);
    if (!version) {
      throw new Error("Designer version not found");
    }
    const updated = this.updateProject(projectId, {
      status: "saved",
      currentCaptureId: version.captureId,
      currentManifestId: version.manifestId
    });
    if (!updated) {
      throw new Error("Designer project not found");
    }
    return updated;
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
  initTables() {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS designer_projects (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				brief TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'draft',
				skillId TEXT NOT NULL,
				systemId TEXT NOT NULL,
				directionId TEXT NOT NULL,
				testProjectId TEXT,
				linkedSessionId TEXT,
				filesystemPath TEXT,
				currentCaptureId TEXT,
				currentManifestId TEXT,
				lastWarning TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS designer_manifests (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL,
				captureId TEXT NOT NULL,
				kind TEXT NOT NULL,
				mimeType TEXT NOT NULL,
				renderer TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				sourceSkillId TEXT NOT NULL,
				designSystemId TEXT NOT NULL,
				directionId TEXT NOT NULL,
				exports TEXT NOT NULL,
				lintSummary TEXT,
				createdFrom TEXT,
				sourceDocumentId TEXT,
				content TEXT NOT NULL,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL,
				FOREIGN KEY(projectId) REFERENCES designer_projects(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS designer_captures (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL,
				manifestId TEXT,
				versionId TEXT,
				captureMode TEXT NOT NULL,
				sessionId TEXT,
				messageId TEXT,
				runId TEXT,
				autoCaptured INTEGER NOT NULL,
				rawSource TEXT NOT NULL,
				artifactIndex INTEGER NOT NULL,
				artifactIdentifier TEXT,
				parsedTitle TEXT,
				parsedMimeType TEXT,
				parsedKind TEXT,
				parserWarnings TEXT NOT NULL,
				createdFrom TEXT,
				sourceDocumentId TEXT,
				createdAt TEXT NOT NULL,
				FOREIGN KEY(projectId) REFERENCES designer_projects(id) ON DELETE CASCADE,
				FOREIGN KEY(manifestId) REFERENCES designer_manifests(id) ON DELETE CASCADE,
				FOREIGN KEY(versionId) REFERENCES designer_versions(id) ON DELETE SET NULL
			);

			CREATE TABLE IF NOT EXISTS designer_versions (
				id TEXT PRIMARY KEY,
				projectId TEXT NOT NULL,
				captureId TEXT NOT NULL,
				manifestId TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				versionNumber INTEGER NOT NULL,
				promotedAt TEXT NOT NULL,
				FOREIGN KEY(projectId) REFERENCES designer_projects(id) ON DELETE CASCADE,
				FOREIGN KEY(captureId) REFERENCES designer_captures(id) ON DELETE CASCADE,
				FOREIGN KEY(manifestId) REFERENCES designer_manifests(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_designer_projects_updatedAt ON designer_projects(updatedAt DESC);
			CREATE INDEX IF NOT EXISTS idx_designer_captures_projectId ON designer_captures(projectId);
			CREATE INDEX IF NOT EXISTS idx_designer_manifests_projectId ON designer_manifests(projectId);
			CREATE INDEX IF NOT EXISTS idx_designer_versions_projectId ON designer_versions(projectId, versionNumber);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_designer_versions_project_versionNumber
				ON designer_versions(projectId, versionNumber);
		`);
  }
  insertManifest(manifest) {
    this.db.prepare(`
			INSERT INTO designer_manifests (
				id, projectId, captureId, kind, mimeType, renderer, title, status,
				sourceSkillId, designSystemId, directionId, exports, lintSummary,
				createdFrom, sourceDocumentId, content, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      manifest.id,
      manifest.projectId,
      manifest.captureId,
      manifest.kind,
      manifest.mimeType,
      manifest.renderer,
      manifest.title,
      manifest.status,
      manifest.sourceSkillId,
      manifest.designSystemId,
      manifest.directionId,
      JSON.stringify(manifest.exports),
      manifest.lintSummary ? JSON.stringify(manifest.lintSummary) : null,
      manifest.createdFrom,
      manifest.sourceDocumentId,
      manifest.content,
      manifest.createdAt,
      manifest.updatedAt
    );
  }
  insertCapture(capture) {
    this.db.prepare(`
			INSERT INTO designer_captures (
				id, projectId, manifestId, versionId, captureMode, sessionId, messageId, runId,
				autoCaptured, rawSource, artifactIndex, artifactIdentifier, parsedTitle, parsedMimeType, parsedKind,
				parserWarnings, createdFrom, sourceDocumentId, createdAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      capture.id,
      capture.projectId,
      capture.manifestId,
      capture.versionId,
      capture.captureMode,
      capture.sessionId,
      capture.messageId,
      capture.runId,
      capture.autoCaptured ? 1 : 0,
      capture.rawSource,
      capture.artifactIndex,
      capture.artifactIdentifier,
      capture.parsedTitle,
      capture.parsedMimeType,
      capture.parsedKind,
      JSON.stringify(capture.parserWarnings),
      capture.createdFrom,
      capture.sourceDocumentId,
      capture.createdAt
    );
  }
  rowToProject(row) {
    return { ...row };
  }
  rowToManifest(row) {
    return {
      ...row,
      exports: parseJson(row.exports, []),
      lintSummary: row.lintSummary ? parseJson(row.lintSummary, null) : null
    };
  }
  rowToCapture(row) {
    return {
      ...row,
      autoCaptured: row.autoCaptured === 1,
      parserWarnings: parseJson(row.parserWarnings, [])
    };
  }
  rowToVersion(row) {
    return { ...row };
  }
  validateProjectSelection(projectId, captureId, manifestId) {
    let capture;
    let manifest;
    if (captureId) {
      capture = this.db.prepare(`
				SELECT * FROM designer_captures
				WHERE id = ? AND projectId = ?
			`).get(captureId, projectId);
      if (!capture) {
        throw new Error("Designer artifact selection not found");
      }
    }
    if (manifestId) {
      manifest = this.db.prepare(`
				SELECT * FROM designer_manifests
				WHERE id = ? AND projectId = ?
			`).get(manifestId, projectId);
      if (!manifest) {
        throw new Error("Designer artifact selection not found");
      }
    }
    if (capture && manifest && (capture.manifestId !== manifest.id || manifest.captureId !== capture.id)) {
      throw new Error("Designer artifact selection not found");
    }
  }
};
function parseJson(source, fallback) {
  try {
    return JSON.parse(source);
  } catch {
    return fallback;
  }
}
function summarizeWarnings(warnings) {
  return Array.from(new Set(warnings)).join(" ");
}
function clampLimit(limit) {
  return Math.min(Math.max(limit ?? 50, 0), 500);
}
function clampOffset(offset) {
  return Math.max(offset ?? 0, 0);
}

export {
  DesignerProjectStore
};
