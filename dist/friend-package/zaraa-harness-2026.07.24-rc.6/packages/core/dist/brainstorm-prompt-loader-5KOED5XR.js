import "./chunk-R5U7XKVJ.js";

// src/messaging/brainstorm-prompt-loader.ts
import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var DEFAULT_ARTIFACT_DIR = join(
  process.env.ZARAA_HOME_DIR?.trim() || homedir(),
  ".zaraa",
  "growth-cycle",
  "artifacts",
  "imessage_brainstorm"
);
var CACHE_TTL_MS = 5e3;
var VERSION_FILENAME_RE = /^v(\d+)\.xml$/;
var FALLBACK_V0 = `<imessage_brainstorm version="0-fallback">
  <self>Zaraa \u2014 Sky's autonomous AI agent. Free-form iMessage thinking partner.</self>
  <prime_directive>
    Help Sky think. First word is content, not pleasantry. State a take, name the strongest objection, end with one next move he could make in the next 60 minutes.
  </prime_directive>
  <length_rules>Default \u22644 short paragraphs (\u2264500 chars total). "deep" \u2192 up to 8 paragraphs. One-line answers when one line answers it.</length_rules>
  <forbidden>"great question", "as an AI", hedging without naming the uncertainty, restating Sky's question before answering, numbered lists for non-list content.</forbidden>
</imessage_brainstorm>`;
var BrainstormPromptLoader = class {
  artifactDir;
  cacheTtlMs;
  now;
  cache = null;
  lastCheckedMs = 0;
  constructor(config) {
    this.artifactDir = config?.artifactDir ?? DEFAULT_ARTIFACT_DIR;
    this.cacheTtlMs = config?.cacheTtlMs ?? CACHE_TTL_MS;
    this.now = config?.now ?? (() => Date.now());
  }
  load() {
    const now = this.now();
    if (this.cache && now - this.lastCheckedMs < this.cacheTtlMs) {
      return this.cache;
    }
    this.lastCheckedMs = now;
    this.cache = this.readFromDisk(now);
    return this.cache;
  }
  readFromDisk(now) {
    try {
      const entries = readdirSync(this.artifactDir);
      const versions = entries.map((name) => {
        const match = name.match(VERSION_FILENAME_RE);
        return match ? { name: match[0], version: Number(match[1]) } : null;
      }).filter((v) => v !== null).sort((a, b) => b.version - a.version);
      if (versions.length === 0) {
        return this.fallback(now);
      }
      const top = versions[0];
      const xml = readFileSync(join(this.artifactDir, top.name), "utf8");
      if (!xml || !xml.includes("<imessage_brainstorm")) {
        return this.fallback(now);
      }
      return {
        xml,
        version: top.version,
        source: "artifact",
        loadedAt: now
      };
    } catch {
      return this.fallback(now);
    }
  }
  fallback(now) {
    return {
      xml: FALLBACK_V0,
      version: 0,
      source: "fallback",
      loadedAt: now
    };
  }
};
var sharedLoader = null;
function getBrainstormPrompt() {
  if (!sharedLoader) sharedLoader = new BrainstormPromptLoader();
  return sharedLoader.load();
}
var __testing = {
  FALLBACK_V0,
  resetSharedLoader: () => {
    sharedLoader = null;
  }
};
export {
  BrainstormPromptLoader,
  __testing,
  getBrainstormPrompt
};
