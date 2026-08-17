import "./chunk-R5U7XKVJ.js";

// src/runtime/context-pager.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

// src/runtime/conversation-summarizer.ts
function summarizeConversation(messages) {
  const userMsgs = messages.filter((m) => m.role === "user");
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  const userIntentions = userMsgs.map((m) => extractIntention(m.content)).filter(Boolean);
  const toolPattern = /\b([a-z]+_[a-z_]+)\b/g;
  const toolsUsed = /* @__PURE__ */ new Set();
  for (const msg of assistantMsgs) {
    let match = toolPattern.exec(msg.content);
    while (match !== null) {
      toolsUsed.add(match[1]);
      match = toolPattern.exec(msg.content);
    }
  }
  const topics = extractTopics(userMsgs.map((m) => m.content).join(" "));
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.content ?? "";
  const outcome = determineOutcome(lastAssistant, userMsgs);
  const firstRequest = userMsgs[0]?.content ?? "";
  const summaryParts = [];
  summaryParts.push(`User: ${truncate(firstRequest, 150)}`);
  if (userMsgs.length > 1) {
    const followUps = userMsgs.slice(1).map((m) => truncate(m.content, 60));
    summaryParts.push(`Follow-ups: ${followUps.slice(0, 3).join("; ")}`);
  }
  if (lastAssistant) {
    summaryParts.push(`Result: ${truncate(lastAssistant, 200)}`);
  }
  return {
    summary: summaryParts.join(". "),
    topics,
    toolsUsed: [...toolsUsed],
    outcome,
    messageCount: messages.length,
    userIntentions: userIntentions.slice(0, 5)
  };
}
function extractIntention(message) {
  const trimmed = message.trim();
  if (trimmed.length < 5) return null;
  const imperative = trimmed.match(
    /^(check|get|find|show|list|search|create|delete|update|send|read|write|run|set|tell|remind|schedule|buy|sell|analyze|compare)\b/i
  );
  if (imperative) {
    return truncate(trimmed, 80);
  }
  if (trimmed.endsWith("?") || trimmed.match(/^(what|how|why|when|where|who|can|do|is|are)\b/i)) {
    return truncate(trimmed, 80);
  }
  const firstSentence = trimmed.split(/[.!?]\s/)[0];
  return truncate(firstSentence, 80);
}
function extractTopics(text) {
  const stopWords = /* @__PURE__ */ new Set([
    "the",
    "and",
    "for",
    "are",
    "but",
    "not",
    "you",
    "all",
    "can",
    "had",
    "her",
    "was",
    "one",
    "our",
    "out",
    "has",
    "have",
    "this",
    "that",
    "with",
    "what",
    "from",
    "they",
    "been",
    "said",
    "will",
    "each",
    "about",
    "how",
    "when",
    "which",
    "their",
    "there",
    "would",
    "into",
    "could",
    "than",
    "just",
    "like",
    "also",
    "some",
    "more",
    "very",
    "much",
    "then",
    "them",
    "please",
    "thanks",
    "thank",
    "sure",
    "yeah",
    "okay",
    "want",
    "need",
    "know",
    "think",
    "make",
    "take",
    "give",
    "call",
    "look",
    "come",
    "keep"
  ]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, "").split(/\s+/).filter((w) => w.length >= 4 && !stopWords.has(w));
  const freq = /* @__PURE__ */ new Map();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word);
}
function determineOutcome(lastAssistant, userMsgs) {
  const lower = lastAssistant.toLowerCase();
  const lastUser = userMsgs[userMsgs.length - 1]?.content.toLowerCase() ?? "";
  if (lower.includes("done") || lower.includes("completed") || lower.includes("here you go") || lower.includes("here are the results") || lastUser.includes("thanks") || lastUser.includes("perfect") || lastUser.includes("great")) {
    return "resolved";
  }
  if (lower.includes("error") || lower.includes("unable to") || lower.includes("cannot") || lower.includes("failed")) {
    return "partial";
  }
  if (userMsgs.length <= 1) {
    return "ongoing";
  }
  return "resolved";
}
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// src/runtime/context-pager.ts
var ContextPager = class _ContextPager {
  config;
  /** In-memory index: sessionId → pages (ordered by chunkIndex) */
  index = /* @__PURE__ */ new Map();
  static SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
  constructor(config) {
    this.config = config;
    this.loadIndex();
  }
  validateSessionId(sessionId) {
    if (!_ContextPager.SAFE_SESSION_ID.test(sessionId)) {
      throw new Error(`Invalid sessionId: must be alphanumeric/hyphens/underscores, got "${sessionId}"`);
    }
  }
  /**
   * Save dropped messages to disk. Returns page metadata.
   * Never throws — returns a stub page on failure.
   */
  pageOut(sessionId, messages) {
    this.validateSessionId(sessionId);
    const pages = this.index.get(sessionId) ?? [];
    const chunkIndex = pages.length > 0 ? pages[pages.length - 1].chunkIndex + 1 : 0;
    const id = `page-${sessionId}-${chunkIndex}`;
    const { summary, topics } = summarizeConversation(
      messages.map((m) => ({ role: m.role, content: m.content }))
    );
    const page = {
      id,
      sessionId,
      chunkIndex,
      messages,
      tokenEstimate: Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4),
      summary,
      topics,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      const sessionDir = join(this.config.dataDir, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify(page));
    } catch (err) {
      console.warn("[context-pager] pageOut write failed:", err instanceof Error ? err.message : err);
    }
    pages.push(page);
    this.index.set(sessionId, pages);
    this.evictIfNeeded(sessionId);
    return page;
  }
  /**
   * Load a page's messages from disk (or memory index).
   * Returns null if page not found or corrupt.
   */
  pageIn(pageId) {
    for (const pages of this.index.values()) {
      const page = pages.find((p) => p.id === pageId);
      if (page) return page.messages;
    }
    const match = pageId.match(/^page-(.+)-(\d+)$/);
    if (!match) return null;
    const [, sessionId] = match;
    if (!_ContextPager.SAFE_SESSION_ID.test(sessionId)) return null;
    const filePath = join(this.config.dataDir, sessionId, `${pageId}.json`);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const page = JSON.parse(raw);
      return page.messages;
    } catch {
      return null;
    }
  }
  /**
   * Find pages whose topics and summaries overlap with the query.
   * Uses weighted scoring: topic matches are worth more than summary matches,
   * and rarer terms (appearing in fewer pages) score higher (TF-IDF inspired).
   */
  searchPages(sessionId, query, limit = 3) {
    this.validateSessionId(sessionId);
    const pages = this.index.get(sessionId) ?? [];
    if (pages.length === 0) return [];
    const queryWords = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
    if (queryWords.length === 0) return [];
    const docCount = pages.length;
    const termDocFreq = /* @__PURE__ */ new Map();
    for (const page of pages) {
      const pageText = (page.topics.join(" ") + " " + page.summary).toLowerCase();
      const seen = /* @__PURE__ */ new Set();
      for (const qw of queryWords) {
        if (!seen.has(qw) && pageText.includes(qw)) {
          seen.add(qw);
          termDocFreq.set(qw, (termDocFreq.get(qw) ?? 0) + 1);
        }
      }
    }
    const scored = pages.map((page) => {
      let score = 0;
      const summaryLower = page.summary.toLowerCase();
      for (const qw of queryWords) {
        const df = termDocFreq.get(qw) ?? 0;
        const idf = df > 0 ? Math.max(1, Math.log(docCount / df) + 1) : 0;
        for (const topic of page.topics) {
          if (topic.includes(qw) || qw.includes(topic)) {
            score += 3 * idf;
          }
        }
        if (summaryLower.includes(qw)) {
          score += 1 * idf;
        }
      }
      return { page, score };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.page);
  }
  /**
   * Get summaries for all pages in a session (for topic preamble).
   */
  getPageSummaries(sessionId) {
    const pages = this.index.get(sessionId) ?? [];
    return pages.map((p) => ({ id: p.id, summary: p.summary }));
  }
  /**
   * Delete pages older than the given threshold (in ms).
   * Use 0 to delete everything.
   */
  cleanup(maxAgeMs) {
    const threshold = maxAgeMs ?? this.config.cleanupAfterMs;
    const now = Date.now();
    let deleted = 0;
    let freedBytes = 0;
    for (const [sessionId, pages] of this.index.entries()) {
      const remaining = [];
      for (const page of pages) {
        const ageMs = now - new Date(page.createdAt).getTime();
        if (ageMs >= threshold) {
          try {
            const filePath = join(this.config.dataDir, sessionId, `${page.id}.json`);
            if (existsSync(filePath)) {
              const stat = statSync(filePath);
              freedBytes += stat.size;
              rmSync(filePath);
            }
          } catch {
          }
          deleted++;
        } else {
          remaining.push(page);
        }
      }
      if (remaining.length === 0) {
        this.index.delete(sessionId);
        try {
          rmSync(join(this.config.dataDir, sessionId), { recursive: true, force: true });
        } catch {
        }
      } else {
        this.index.set(sessionId, remaining);
      }
    }
    return { deleted, freedMB: Math.round(freedBytes / 1024 / 1024 * 100) / 100 };
  }
  // ── Private ──
  evictIfNeeded(sessionId) {
    const pages = this.index.get(sessionId);
    if (!pages) return;
    while (pages.length > this.config.maxPagesPerSession) {
      const evicted = pages.shift();
      try {
        const filePath = join(this.config.dataDir, sessionId, `${evicted.id}.json`);
        if (existsSync(filePath)) rmSync(filePath);
      } catch {
      }
    }
  }
  loadIndex() {
    try {
      if (!existsSync(this.config.dataDir)) return;
      const sessionDirs = readdirSync(this.config.dataDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const dir of sessionDirs) {
        const sessionId = dir.name;
        const sessionPath = join(this.config.dataDir, sessionId);
        const files = readdirSync(sessionPath).filter((f) => f.endsWith(".json")).sort();
        const pages = [];
        for (const file of files) {
          try {
            const raw = readFileSync(join(sessionPath, file), "utf-8");
            pages.push(JSON.parse(raw));
          } catch {
          }
        }
        if (pages.length > 0) {
          pages.sort((a, b) => a.chunkIndex - b.chunkIndex);
          this.index.set(sessionId, pages);
        }
      }
    } catch {
    }
  }
};
export {
  ContextPager
};
