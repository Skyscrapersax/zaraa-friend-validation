// src/integrations/obsidian-client.ts
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync
} from "fs";
import { execFileSync } from "child_process";
import { join, relative, extname, basename, resolve, dirname } from "path";
function isDatalessFileListing(listing) {
  return /\bdataless\b/.test(listing);
}
var ObsidianClient = class {
  vaultPath;
  constructor(vaultPath) {
    if (!existsSync(vaultPath)) {
      throw new Error(`Vault path does not exist: ${vaultPath}`);
    }
    this.vaultPath = resolve(vaultPath);
  }
  listNotes(subdir = "", limit = 50) {
    const targetDir = join(this.vaultPath, subdir);
    this.validatePath(targetDir);
    if (!existsSync(targetDir)) {
      return [];
    }
    const notes = [];
    this.walkDirectory(targetDir, notes);
    notes.sort(
      (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
    );
    return notes.slice(0, limit);
  }
  readNote(notePath) {
    if (extname(notePath) !== ".md") {
      throw new Error("Only .md files are supported");
    }
    const fullPath = join(this.vaultPath, notePath);
    this.validatePath(fullPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Note does not exist: ${notePath}`);
    }
    this.assertLocalNote(fullPath, notePath);
    return readFileSync(fullPath, "utf-8");
  }
  writeNote(notePath, content) {
    if (extname(notePath) !== ".md") {
      throw new Error("Only .md files are supported");
    }
    const fullPath = join(this.vaultPath, notePath);
    this.validatePath(fullPath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }
  searchNotes(query, limit = 20) {
    const lowerQuery = query.toLowerCase();
    const matches = [];
    this.walkDirectoryStreaming(this.vaultPath, lowerQuery, matches, limit);
    return matches;
  }
  appendToNote(notePath, content) {
    if (extname(notePath) !== ".md") {
      throw new Error("Only .md files are supported");
    }
    const fullPath = join(this.vaultPath, notePath);
    this.validatePath(fullPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Note does not exist: ${notePath}`);
    }
    this.assertLocalNote(fullPath, notePath);
    const existing = readFileSync(fullPath, "utf-8");
    writeFileSync(fullPath, existing + content, "utf-8");
  }
  validatePath(fullPath) {
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(this.vaultPath)) {
      throw new Error("Path escapes vault directory");
    }
  }
  walkDirectory(dir, results) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = readdirSync(current);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(current, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          stack.push(fullPath);
        } else if (stat.isFile() && extname(entry) === ".md" && !this.isDatalessFile(fullPath)) {
          const relPath = relative(this.vaultPath, fullPath);
          results.push({
            path: relPath,
            name: basename(entry, ".md"),
            content: readFileSync(fullPath, "utf-8"),
            lastModified: stat.mtime.toISOString()
          });
        }
      }
    }
  }
  walkDirectoryStreaming(dir, lowerQuery, matches, limit) {
    const stack = [dir];
    while (stack.length > 0 && matches.length < limit) {
      const current = stack.pop();
      const entries = readdirSync(current);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const fullPath = join(current, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          stack.push(fullPath);
        } else if (stat.isFile() && extname(entry) === ".md" && !this.isDatalessFile(fullPath)) {
          const name = basename(entry, ".md");
          if (name.toLowerCase().includes(lowerQuery)) {
            const content2 = readFileSync(fullPath, "utf-8");
            matches.push({
              path: relative(this.vaultPath, fullPath),
              name,
              content: content2.length > 200 ? content2.slice(0, 200) + "..." : content2,
              lastModified: stat.mtime.toISOString()
            });
            if (matches.length >= limit) return;
            continue;
          }
          const content = readFileSync(fullPath, "utf-8");
          if (content.toLowerCase().includes(lowerQuery)) {
            matches.push({
              path: relative(this.vaultPath, fullPath),
              name,
              content: content.length > 200 ? content.slice(0, 200) + "..." : content,
              lastModified: stat.mtime.toISOString()
            });
            if (matches.length >= limit) return;
          }
        }
      }
    }
  }
  assertLocalNote(fullPath, notePath) {
    if (this.isDatalessFile(fullPath)) {
      throw new Error(`Note is not downloaded locally: ${notePath}`);
    }
  }
  isDatalessFile(fullPath) {
    if (process.platform !== "darwin") return false;
    try {
      const listing = execFileSync("/bin/ls", ["-lO", fullPath], {
        encoding: "utf-8",
        timeout: 250,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return isDatalessFileListing(listing);
    } catch {
      return true;
    }
  }
};

export {
  isDatalessFileListing,
  ObsidianClient
};
