import {
  parseReplyDraftResponse,
  resolveRecipient
} from "./chunk-ORI6SRSL.js";
import {
  formatForIMessage
} from "./chunk-KE2G7CEW.js";
import {
  analyzeRecentMessages,
  buildMessageFollowupQueue,
  buildMessageJudgmentQueue
} from "./chunk-TCWRPEMD.js";

// src/messaging/imessage-gateway.ts
import { copyFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

// src/messaging/imessage-command-triggers.ts
var isStatusTrigger = (t) => t === "status" || t === "pulse" || t === "alive" || t === "check in" || t === "checkin" || t === "how are you" || t === "how ya doing" || t === "how're you";
var isTasksTrigger = (t) => t === "tasks" || t === "activity" || t === "what are you doing" || t === "whatre you doing" || t === "what're you doing" || t === "what you doing" || t === "fill me in" || t === "what's up" || t === "whats up";
var isTradingTrigger = (t) => t === "trading" || t === "portfolio" || t === "positions" || t === "book";
var isRecentTrigger = (t) => t === "recent" || t === "catch up" || t === "catchup" || t === "history";
var isPauseTrigger = (t) => t === "pause" || t === "pause all" || t === "pause autonomy" || t === "stop" || t === "halt";
var isResumeTrigger = (t) => t === "resume" || t === "resume all" || t === "resume autonomy" || t === "go" || t === "continue";
var isHelpTrigger = (normalized) => {
  if (normalized === "?") return true;
  const stripped = normalized.replace(/[?!.]+$/, "");
  return stripped === "help" || stripped === "commands" || stripped === "what can you do" || stripped === "what can i do" || stripped === "cmds";
};

// src/messaging/auto-context-snippet.ts
var DEFAULT_MAX_CHARS = 1600;
var DEFAULT_MAX_GOALS = 3;
var DEFAULT_MAX_OPEN_TRADES = 3;
var DEFAULT_MAX_COMMITS = 3;
function buildAutoContextSnippet(inputs, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxGoals = options.maxGoals ?? DEFAULT_MAX_GOALS;
  const maxOpenTrades = options.maxOpenTrades ?? DEFAULT_MAX_OPEN_TRADES;
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const sections = [];
  const goals = (inputs.activeGoals ?? []).slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).slice(0, maxGoals);
  if (goals.length > 0) {
    sections.push(
      "ACTIVE GOALS:\n" + goals.map((g) => `  - ${g.statement}`).join("\n")
    );
  }
  const tradingLine = formatTradingState(
    inputs.paperEquityUsd,
    inputs.openTrades ?? [],
    maxOpenTrades
  );
  if (tradingLine) sections.push(tradingLine);
  if (inputs.lastReflection) {
    sections.push(
      `LAST REFLECTION (${formatRelativeAge(inputs.lastReflectionAtMs, inputs.currentTimeMs)}):
  ${inputs.lastReflection.trim().split("\n")[0]}`
    );
  }
  const commits = (inputs.recentCommits ?? []).slice(0, maxCommits);
  if (commits.length > 0) {
    sections.push(
      "RECENT COMMITS:\n" + commits.map((c) => `  - ${c}`).join("\n")
    );
  }
  if (inputs.lastSelfEdit) {
    const age = formatRelativeAge(inputs.lastSelfEdit.atMs, inputs.currentTimeMs);
    sections.push(
      `SELF-EDIT (${age}, ${inputs.lastSelfEdit.status}):
  ${inputs.lastSelfEdit.title}`
    );
  }
  if (sections.length === 0) return "";
  const header = "[zaraa state \u2014 silent, do not recite]";
  const body = sections.join("\n\n");
  const full = `${header}
${body}`;
  if (full.length <= maxChars) return full;
  return truncateToFit(header, sections, maxChars);
}
function formatTradingState(paperEquityUsd, openTrades, maxOpenTrades) {
  const hasEquity = typeof paperEquityUsd === "number" && Number.isFinite(paperEquityUsd);
  const hasTrades = openTrades.length > 0;
  if (!hasEquity && !hasTrades) return null;
  const lines = ["TRADING:"];
  if (hasEquity) {
    lines.push(`  paper equity: $${formatUsd(paperEquityUsd)}`);
  }
  if (hasTrades) {
    const shown = openTrades.slice(0, maxOpenTrades);
    const pnlSum = openTrades.reduce(
      (s, t) => s + (typeof t.unrealizedPnlUsd === "number" ? t.unrealizedPnlUsd : 0),
      0
    );
    lines.push(`  open: ${shown.length}/${openTrades.length}, total unrealized $${formatUsd(pnlSum)}`);
    for (const t of shown) {
      const pnl = formatPnlBadge(t.unrealizedPnlUsd);
      lines.push(`    ${t.side} ${t.symbol}${pnl}`);
    }
  }
  return lines.join("\n");
}
function formatPnlBadge(pnl) {
  if (typeof pnl !== "number" || !Number.isFinite(pnl)) return "";
  const sign = pnl >= 0 ? "+" : "-";
  return ` (${sign}$${formatUsd(Math.abs(pnl))})`;
}
function formatUsd(amount) {
  const abs = Math.abs(amount);
  if (abs >= 1e3) return amount.toFixed(0);
  if (abs >= 1) return amount.toFixed(2);
  return amount.toFixed(4);
}
function formatRelativeAge(thenMs, nowMs) {
  if (!thenMs) return "unknown";
  const now = nowMs ?? Date.now();
  const diffMs = Math.max(0, now - thenMs);
  const minutes = Math.floor(diffMs / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function truncateToFit(header, sections, maxChars) {
  const kept = sections.slice();
  let result = `${header}
${kept.join("\n\n")}`;
  while (result.length > maxChars && kept.length > 1) {
    kept.pop();
    result = `${header}
${kept.join("\n\n")}`;
  }
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 3) + "...";
  }
  return result;
}

// src/messaging/imessage-gateway.ts
var DEFAULT_MAX_LENGTH = 1600;
var CHUNK_DELAY_MS = 500;
var MAX_QUEUE_DEPTH = 5;
var DEFAULT_ACK_DELAY_MS = 1200;
var DEFAULT_APPROVAL_BATCH_WINDOW_MS = 1500;
var DEFAULT_APPROVAL_FALLBACK_WINDOW_MS = 10 * 60 * 1e3;
var DEFAULT_ATTACHMENT_STAGE_DIR = join(
  process.env.ZARAA_HOME_DIR?.trim() || homedir(),
  ".zaraa",
  "data",
  "imessage-attachments"
);
var MAX_ATTACHMENT_PREVIEW_BYTES = 12e3;
var MAX_ATTACHMENT_PREVIEW_LINES = 120;
var MAX_ATTACHMENT_INLINE_PREVIEWS = 3;
var SUSPICIOUS_CONTROL_CHARS_RE = new RegExp("[\\u0001-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");
var TEXT_ATTACHMENT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);
function errorToUserMessage(error) {
  const e = error.toLowerCase();
  if (e.includes("timeout") || e.includes("180s") || e.includes("timed out")) {
    return "Sorry, that took too long. Try asking something simpler or try again in a moment.";
  }
  if (e.includes("budget") || e.includes("exhausted") || /(?:session|weekly|opus|sonnet|fable ?5|fast|usage) limit/.test(e)) {
    return "I've hit my usage limit. I'll be back once it resets!";
  }
  if (e.includes("sqlite") || e.includes("database")) {
    return "I'm having a temporary storage issue. Try again in a few seconds.";
  }
  if (e.includes("not started") || e.includes("shutting down") || e.includes("not running")) {
    return "I'm currently restarting. Give me a minute.";
  }
  if (e.includes("injection") || e.includes("blocked") || e.includes("sanitiz")) {
    return "I can't process that message. Could you rephrase?";
  }
  if (e.includes("rate limit") || e.includes("429") || e.includes("too many")) {
    return "I'm getting rate limited. Give me a moment and try again.";
  }
  return "Something went wrong on my end. Try again or rephrase your question.";
}
function sanitizeAttachmentFilename(filename, fallbackIndex) {
  const cleaned = filename.trim().replace(/[/\\]+/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || `attachment-${fallbackIndex}`;
}
function looksLikeTextAttachment(filename, mimeType) {
  const lowerName = filename.toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".")) : "";
  if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) return true;
  return mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("yaml") || mimeType.includes("toml") || mimeType.includes("javascript") || mimeType.includes("typescript");
}
function buildAttachmentPreview(stagedPath, sizeBytes, mimeType, filename) {
  const previewEligible = sizeBytes <= 256e3 || looksLikeTextAttachment(filename, mimeType);
  if (!previewEligible) return null;
  let raw;
  try {
    raw = readFileSync(stagedPath);
  } catch {
    return null;
  }
  const sample = raw.subarray(0, Math.min(raw.length, MAX_ATTACHMENT_PREVIEW_BYTES));
  if (sample.includes(0)) return null;
  const decoded = sample.toString("utf8");
  const replacementChars = (decoded.match(/\uFFFD/g) ?? []).length;
  if (replacementChars > Math.max(4, Math.floor(decoded.length * 0.02))) {
    return null;
  }
  const suspiciousControlChars = (decoded.match(SUSPICIOUS_CONTROL_CHARS_RE) ?? []).length;
  if (suspiciousControlChars > Math.max(4, Math.floor(decoded.length * 0.02))) {
    return null;
  }
  const preview = decoded.split(/\r?\n/).slice(0, MAX_ATTACHMENT_PREVIEW_LINES).join("\n").trim();
  if (!preview) return null;
  return preview.length > 8e3 ? `${preview.slice(0, 8e3)}
[truncated]` : preview;
}
function buildGroundedAttachmentContext(attachments) {
  if (attachments.length === 0) return "";
  const lines = [
    "Ground-truth attachment copies for this turn:",
    "If you inspect attachments with file tools, use the staged readable copy path below, not the original Messages path."
  ];
  for (const [index, attachment] of attachments.entries()) {
    lines.push(`[Attachment ${index + 1}]`);
    lines.push(`Filename: ${attachment.filename}`);
    lines.push(`Mime type: ${attachment.mimeType}`);
    lines.push(`Original Messages path: ${attachment.sourcePath || "(missing from chat.db)"}`);
    if (attachment.stagedPath) {
      lines.push(`Staged readable copy: ${attachment.stagedPath}`);
    }
    if (typeof attachment.sizeBytes === "number") {
      lines.push(`Size: ${attachment.sizeBytes} bytes`);
    }
    if (attachment.error) {
      lines.push(`Stage error: ${attachment.error}`);
    }
    if (attachment.inlinePreview) {
      lines.push("Inline preview from the staged readable copy:");
      lines.push("--- BEGIN ATTACHMENT PREVIEW ---");
      lines.push(attachment.inlinePreview);
      lines.push("--- END ATTACHMENT PREVIEW ---");
    }
  }
  return lines.join("\n");
}
function isIMessageRichLinkPreviewAttachment(attachment) {
  const signature = `${attachment.filename ?? ""} ${attachment.path ?? ""}`.toLowerCase();
  return signature.includes(".pluginpayloadattachment");
}
function inferIMessageTaskType(message) {
  const { opusCue, operationalToolCue, deepCue, quickAssistantCue, toolIntentCue } = getIMessageRoutingHints(message);
  if (opusCue) return "opus";
  if (operationalToolCue) return "chat";
  if (deepCue) return "deep";
  if (quickAssistantCue && !toolIntentCue) return "chat";
  if (toolIntentCue) return "chat";
  return "deep";
}
function inferIMessageRequireNativeTools(message) {
  return getIMessageRoutingHints(message).operationalToolCue;
}
function getIMessageRoutingHints(message) {
  const normalized = message.toLowerCase();
  const opusCue = /\b(use opus|opus model|max effort|hardest|most capable|exhaustive|deep research|think very hard|think hardest)\b/.test(
    normalized
  );
  const explicitToolNameCue = /\b([a-z]+_[a-z_]+)\b/.test(normalized);
  const liveSystemToolCue = /\b(check|get|find|search|show|list|inspect|open|launch|quit|close|kill|restart|debug|diagnose|isolate|switch)\b/.test(
    normalized
  ) && /\b(process(?:es)?|cpu|memory|ram|daemon(?:s)?|service|pid|port(?:s)?|window|app|application|safari|finder|terminal|clipboard|battery|screenshot|screen|ocr|notification|focus|system(?:\s*health|\s*info|\s*status)?)\b/.test(
    normalized
  );
  const operationalToolCue = liveSystemToolCue || explicitToolNameCue || /\b(check|get|find|search|send|open|create|set|list|buy|sell|trade|alert|portfolio|price|balance|position|calendar|schedule|message|remind|email|health(?:\s*check)?|healthy|gateway|ollama|scheduler|heartbeat|task queue|running tasks?|failed tasks?)\b/.test(
    normalized
  );
  const deepCue = /\b(deep|deeply|analysis|analy[sz]e|compare|trade[- ]?off|tradeoff|strategy|strategic|assess|evaluate|recommend|architecture|why\b|how does|root cause|diagnose)\b/.test(
    normalized
  );
  const toolIntentCue = /\b(check|get|find|search|send|open|create|set|list|buy|sell|trade|alert|portfolio|price|balance|position|calendar|schedule|message|remind|email)\b/.test(
    normalized
  ) || explicitToolNameCue;
  const quickAssistantCue = /\b(draft|compose|rewrite|rephrase|write a message|write an email|text message|follow[- ]?up|summary|summarize|wrap[- ]?up|next step|short note)\b/.test(
    normalized
  );
  return {
    opusCue,
    deepCue,
    toolIntentCue,
    quickAssistantCue,
    operationalToolCue
  };
}
var IMessageGateway = class _IMessageGateway {
  config;
  maxLen;
  sessionId;
  ackDelayMs;
  approvalBatchWindowMs;
  approvalFallbackWindowMs;
  attachmentStageDir;
  processing = false;
  messageQueue = [];
  lastMessageJudgmentItems = [];
  lastMessageFollowupItems = [];
  lastSuggestedQueueSource = null;
  suggestedDraftCache = /* @__PURE__ */ new Map();
  pendingSuggestedSends = /* @__PURE__ */ new Map();
  pendingApprovalAnnouncements = [];
  announcedApprovalIds = /* @__PURE__ */ new Set();
  approvalBatchTimer = null;
  /** Epoch ms at which the proactive-approval snooze ends. 0 = not snoozed. */
  snoozedUntil = 0;
  constructor(config) {
    this.config = config;
    this.maxLen = config.maxMessageLength ?? DEFAULT_MAX_LENGTH;
    this.sessionId = config.sessionId ?? `imessage-${config.contact.replace(/[^a-zA-Z0-9]/g, "")}`;
    this.ackDelayMs = config.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;
    this.approvalBatchWindowMs = config.approvalBatchWindowMs ?? DEFAULT_APPROVAL_BATCH_WINDOW_MS;
    this.approvalFallbackWindowMs = config.approvalFallbackWindowMs ?? DEFAULT_APPROVAL_FALLBACK_WINDOW_MS;
    this.attachmentStageDir = config.attachmentStageDir ?? DEFAULT_ATTACHMENT_STAGE_DIR;
  }
  /**
   * Start listening for approval events via EventBus.
   */
  start() {
    if (this.config.eventBus) {
      this.config.eventBus.on("approval.created", (event) => {
        void this.handleApprovalCreated(event.data);
      });
      this.config.eventBus.on("approval.resolved", (event) => {
        void this.handleApprovalResolved(event.data);
      });
      this.config.eventBus.on("notification.reopened", (event) => {
        void this.handleNotificationReopened(event.data);
      });
    }
    console.log("[IMessageGateway] Started \u2014 two-way chat enabled");
  }
  /**
   * Handle an inbound iMessage. Called by IMessagePoller's onMessage callback.
   * Returns the response text (used by poller for retry logic).
   */
  async handleInbound(msg) {
    const helpResponse = this.checkHelpCommand(msg.text);
    if (helpResponse) {
      await this.sendLong(helpResponse);
      return "";
    }
    const autonomyResponse = await this.checkAutonomyCommand(msg.text);
    if (autonomyResponse) {
      await this.safeSend(autonomyResponse);
      return "";
    }
    const tasksResponse = await this.checkTasksCommand(msg.text);
    if (tasksResponse) {
      await this.sendLong(tasksResponse);
      return "";
    }
    const tradingResponse = await this.checkTradingCommand(msg.text);
    if (tradingResponse) {
      await this.sendLong(tradingResponse);
      return "";
    }
    const recentResponse = await this.checkRecentCommand(msg.text);
    if (recentResponse) {
      await this.sendLong(recentResponse);
      return "";
    }
    const noteResponse = await this.checkNoteCommand(msg.text);
    if (noteResponse) {
      await this.safeSend(noteResponse);
      return "";
    }
    const snoozeResponse = this.checkSnoozeCommand(msg.text);
    if (snoozeResponse) {
      await this.safeSend(snoozeResponse);
      return "";
    }
    const statusResponse = await this.checkStatusCommand(msg.text);
    if (statusResponse) {
      await this.safeSend(statusResponse);
      return "";
    }
    const approvalResponse = await this.checkApprovalCommand(msg.text);
    if (approvalResponse) return approvalResponse;
    const messageResponse = await this.checkMessageCommand(msg.text);
    if (messageResponse) return messageResponse;
    const clearResponse = await this.checkClearCommand(msg.text);
    if (clearResponse) return clearResponse;
    const stateResponse = await this.checkStateCommand(msg.text);
    if (stateResponse) return stateResponse;
    const brainstormResponse = await this.checkBrainstormCommand(msg.text);
    if (brainstormResponse !== null) return brainstormResponse;
    if (this.processing) {
      if (this.messageQueue.length >= MAX_QUEUE_DEPTH) {
        const dropped = this.messageQueue.shift();
        console.warn(`[IMessageGateway] Queue full, dropped message ${dropped?.id}`);
      }
      this.messageQueue.push(msg);
      await this.safeSend("Still working on your last message \u2014 I'll get to this next.", {
        isChatReply: true
      });
      return "";
    }
    this.processing = true;
    try {
      const response = await this.processMessage(msg);
      while (this.messageQueue.length > 0) {
        const queued = this.messageQueue.shift();
        if (!queued) break;
        try {
          await this.processMessage(queued);
        } catch (err) {
          console.error(
            `[IMessageGateway] Queued message ${queued.id} failed:`,
            err instanceof Error ? err.message : err
          );
          await this.safeSend(
            "Sorry, I hit an error processing a queued message. Moving on to the next one."
          );
        }
      }
      return response;
    } finally {
      this.processing = false;
    }
  }
  /**
   * Process a single message through the chat() agent loop.
   * The gateway handles all sending (ack, response, splitting).
   * Returns empty string so the poller does NOT re-send.
   */
  async processMessage(msg) {
    let ackTimer = null;
    if (this.config.ackMessage !== null) {
      const ackText = this.config.ackMessage ?? "Got it, thinking...";
      if (this.ackDelayMs <= 0) {
        await this.safeSend(ackText, { isChatReply: true });
      } else {
        ackTimer = setTimeout(() => {
          void this.safeSend(ackText, { isChatReply: true });
        }, this.ackDelayMs);
      }
    }
    let messageText = msg.text;
    if (msg.attachments && msg.attachments.length > 0) {
      const hasUrlInText = /https?:\/\/\S+/i.test(msg.text ?? "");
      const promptAttachments = hasUrlInText ? msg.attachments.filter((attachment) => !isIMessageRichLinkPreviewAttachment(attachment)) : msg.attachments;
      const omittedRichLinkPreviewCount = msg.attachments.length - promptAttachments.length;
      const attachDesc = promptAttachments.map((a) => `[Attached: ${a.filename} (${a.mimeType})]`).join(" ");
      if (attachDesc) {
        messageText = `${attachDesc} ${messageText || ""}`.trim();
      }
      if (attachDesc && (!messageText || messageText === attachDesc)) {
        messageText = `${attachDesc} [The user sent this without text \u2014 acknowledge what they sent]`;
      }
      if (omittedRichLinkPreviewCount > 0) {
        messageText = `${messageText}

[iMessage rich-link preview assets omitted: ${omittedRichLinkPreviewCount}. Use the URL in the message text as the source of truth.]`.trim();
      }
      const attachmentGrounding = this.stageAttachmentsForPrompt({
        ...msg,
        attachments: promptAttachments
      });
      if (attachmentGrounding) {
        messageText = `${messageText}

${attachmentGrounding}`;
      }
    }
    const taskType = this.config.taskType ?? inferIMessageTaskType(messageText);
    const requireNativeTools = inferIMessageRequireNativeTools(messageText);
    let response = "";
    try {
      for await (const event of this.config.chat(messageText, this.sessionId, {
        taskType,
        requireNativeTools,
        surface: "imessage-fallback",
        deliveryTarget: "imessage-fallback",
        interactionMode: "fallback",
        fallbackEligible: false,
        fallbackReason: "operator_imessage"
      })) {
        if (event.type === "text-delta" && event.content) {
          response += event.content;
        } else if (event.type === "response" && event.content) {
          response = event.content;
        } else if (event.type === "error") {
          response = errorToUserMessage(event.error || "Unknown error");
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[IMessageGateway] chat() error:", errMsg);
      response = errorToUserMessage(errMsg);
    }
    let cleanResponse = response.trim();
    if (cleanResponse.includes("<think>")) {
      const thinkMatch = cleanResponse.match(/<think>([\s\S]*?)<\/think>/);
      const stripped = cleanResponse.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (stripped) {
        cleanResponse = stripped;
      } else if (thinkMatch?.[1]) {
        cleanResponse = thinkMatch[1].trim();
      }
    }
    if (cleanResponse.startsWith("{") && cleanResponse.includes('"tool_calls"')) {
      cleanResponse = "I tried to use some tools but couldn't process them correctly. Let me try again with a different approach.";
    }
    if (cleanResponse.startsWith("{") && cleanResponse.includes('"parameters"')) {
      cleanResponse = "";
    }
    if (!cleanResponse || cleanResponse.length < 20) {
      if (messageText.length > 50) {
        cleanResponse = "I'm working on your request but need a moment to process it fully. Let me get back to you shortly.";
      } else {
        cleanResponse = cleanResponse || "I processed your message but had nothing to say. Try rephrasing?";
      }
    }
    if (ackTimer) {
      clearTimeout(ackTimer);
    }
    const formatted = formatForIMessage(cleanResponse);
    this.resetSessionIfCannedFallback(cleanResponse);
    await this.sendLong(formatted, { isChatReply: true });
    return "";
  }
  stageAttachmentsForPrompt(msg) {
    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) return "";
    const grounded = [];
    let inlinePreviews = 0;
    for (const [index, attachment] of attachments.entries()) {
      const sourcePath = attachment.path?.trim() || "";
      const groundedAttachment = {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sourcePath
      };
      if (!sourcePath) {
        groundedAttachment.error = "Attachment path missing in chat.db metadata.";
        grounded.push(groundedAttachment);
        continue;
      }
      try {
        const stageDir = join(this.attachmentStageDir, this.sessionId, String(msg.id));
        mkdirSync(stageDir, { recursive: true });
        const sourceBaseName = basename(sourcePath) || attachment.filename || `attachment-${index + 1}`;
        const stagedName = `${String(index + 1).padStart(2, "0")}-${sanitizeAttachmentFilename(
          attachment.filename || sourceBaseName,
          index + 1
        )}`;
        const stagedPath = join(stageDir, stagedName);
        copyFileSync(sourcePath, stagedPath);
        const sizeBytes = statSync(stagedPath).size;
        groundedAttachment.stagedPath = stagedPath;
        groundedAttachment.sizeBytes = sizeBytes;
        if (inlinePreviews < MAX_ATTACHMENT_INLINE_PREVIEWS) {
          const preview = buildAttachmentPreview(
            stagedPath,
            sizeBytes,
            attachment.mimeType,
            attachment.filename || sourceBaseName
          );
          if (preview) {
            groundedAttachment.inlinePreview = preview;
            inlinePreviews += 1;
          }
        }
      } catch (err) {
        groundedAttachment.error = err instanceof Error ? err.message : String(err);
      }
      grounded.push(groundedAttachment);
    }
    return buildGroundedAttachmentContext(grounded);
  }
  /**
   * Help listing. Matches "help", "commands", "?", "what can you do". Lists
   * the fast-path commands wired on this gateway so the operator can
   * discover the surface without memorizing it. Only lists features that
   * have a provider/controller wired, so the response reflects reality.
   */
  checkHelpCommand(text) {
    if (!text) return null;
    if (!isHelpTrigger(text.trim().toLowerCase())) return null;
    const lines = [
      "Zaraa iMessage commands:",
      "(text plain language anytime for a full conversation)",
      ""
    ];
    if (this.config.statusProvider) {
      lines.push('\u2022 "status" / "pulse" \u2014 quick pulse-check');
    }
    if (this.config.activityProvider) {
      lines.push(`\u2022 "tasks" / "what's up" \u2014 running tasks + recent activity`);
    }
    if (this.config.tradingProvider) {
      lines.push('\u2022 "trading" / "positions" \u2014 equity, positions, recent trades');
    }
    if (this.config.recentChatProvider) {
      lines.push('\u2022 "recent" / "catch up" \u2014 last few chat turns');
    }
    if (this.config.noteRecorder) {
      lines.push('\u2022 "note <text>" \u2014 save a quick operator note to memory');
    }
    if (this.config.autonomyControl) {
      lines.push('\u2022 "pause" / "stop" \u2014 halt autonomy + task queue');
      lines.push('\u2022 "resume" / "go" \u2014 re-enable both');
    }
    if (this.config.approvalQueue) {
      lines.push('\u2022 "approvals" \u2014 list pending approvals');
      lines.push('\u2022 "approve [N]" / "deny [N]" \u2014 decide on one');
    }
    if (this.config.messageReader) {
      lines.push('\u2022 "messages" / "followups" \u2014 message triage queues');
      if (this.config.draftReply) {
        lines.push('\u2022 "draft N" / "nudge N" \u2014 suggested reply for item N');
        if (this.config.approvalQueue) {
          lines.push('\u2022 "send N" \u2014 queue drafted reply N for approval');
        }
      }
    }
    lines.push("\u2022 anything else \u2014 full chat, sessions remembered");
    return lines.join("\n");
  }
  /**
   * "snooze" (optionally "snooze 2h") silences proactive approval pings for
   * a window (default 30 min). "wake" or "unsnooze" clears it. Approvals
   * still queue — they're just not texted to the operator during the
   * window, so an urgent sleep isn't interrupted. Max 6h to avoid forgetting.
   */
  checkSnoozeCommand(text) {
    if (!text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (trimmed === "wake" || trimmed === "unsnooze") {
      const wasSnoozed = this.snoozedUntil > Date.now();
      this.snoozedUntil = 0;
      if (wasSnoozed) {
        this.schedulePendingApprovalFlush();
      }
      return wasSnoozed ? "Snooze cleared. Approval pings back on." : "Not snoozed \u2014 approval pings are already on.";
    }
    const match = trimmed.match(/^snooze(?:\s+(\d+)\s*(m|min|minutes|h|hr|hour|hours))?$/);
    if (!match) return null;
    let windowMs = 30 * 60 * 1e3;
    if (match[1]) {
      const n = Math.max(1, parseInt(match[1], 10));
      const unit = match[2] ?? "m";
      windowMs = unit.startsWith("h") ? n * 60 * 60 * 1e3 : n * 60 * 1e3;
    }
    windowMs = Math.min(windowMs, 6 * 60 * 60 * 1e3);
    this.snoozedUntil = Date.now() + windowMs;
    const mins = Math.round(windowMs / 6e4);
    const label = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
    return `Snoozed approval pings for ${label}. Reply "wake" to turn them back on.`;
  }
  /** "trading" command — detailed equity + positions + recent trades. */
  async checkTradingCommand(text) {
    if (!this.config.tradingProvider || !text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!isTradingTrigger(trimmed)) return null;
    try {
      return formatOperatorTrading(await this.config.tradingProvider());
    } catch (err) {
      return `Trading snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  /** "recent" command — last few chat turns so operator can catch up. */
  async checkRecentCommand(text) {
    if (!this.config.recentChatProvider || !text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!isRecentTrigger(trimmed)) return null;
    try {
      return formatOperatorRecent(await this.config.recentChatProvider());
    } catch (err) {
      return `Recent turns failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  /** "note <text>" — append a timestamped operator note to memory. */
  async checkNoteCommand(text) {
    if (!this.config.noteRecorder || !text) return null;
    const trimmed = text.trim();
    const match = trimmed.match(/^note\b[:\s]*(.*)$/i);
    if (!match) return null;
    const body = match[1].trim();
    if (!body) {
      return 'Add the note after "note", e.g. "note band rehearsal moved to 9pm".';
    }
    try {
      await this.config.noteRecorder(body);
      return `Noted: ${truncateInline(body, 180)}`;
    } catch (err) {
      return `Couldn't save note: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  /**
   * Remote activity command. Matches "tasks", "what are you doing", "what's
   * up", "fill me in", "activity". Returns running tasks by name + recent
   * completions + recent failures. Short-circuits chat().
   */
  async checkTasksCommand(text) {
    if (!this.config.activityProvider || !text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!isTasksTrigger(trimmed)) return null;
    try {
      const snapshot = await this.config.activityProvider();
      return formatOperatorActivity(snapshot);
    } catch (err) {
      return `Activity check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  /**
   * Remote autonomy control. Matches "pause"/"stop" (halt everything) and
   * "resume"/"go"/"continue" (resume trusted autonomy; task generation may
   * remain release-gated). Idempotent: if already in the requested state,
   * reports so instead of toggling. Inert when no autonomyControl is wired,
   * so "resume" in a chat context still routes through chat() normally.
   */
  async checkAutonomyCommand(text) {
    if (!this.config.autonomyControl || !text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    const isPause = isPauseTrigger(trimmed);
    const isResume = isResumeTrigger(trimmed);
    if (!isPause && !isResume) return null;
    try {
      const before = this.config.autonomyControl.getState();
      if (isPause) {
        if (!before.trusted && before.taskGenerationPaused) {
          return 'Already paused. Autonomy off, task queue halted. Reply "resume" to continue.';
        }
        await this.config.autonomyControl.pause();
        return 'Paused. Autonomy off, task queue halted. Reply "resume" to continue.';
      }
      if (before.trusted && !before.taskGenerationPaused) {
        return "Already running. Autonomy on, task queue active.";
      }
      await this.config.autonomyControl.resume();
      const after = this.config.autonomyControl.getState();
      if (after.taskGenerationPaused) {
        return "Resumed. Autonomy on, task queue still halted pending task-generation release.";
      }
      return "Resumed. Autonomy on, task queue active.";
    } catch (err) {
      return `Autonomy command failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  /**
   * Remote pulse-check command. Matches "status", "pulse", "alive", "how are
   * you", "check in" (case-insensitive, allowing trailing punctuation). Short-
   * circuits chat() and returns a compact status snapshot pulled from
   * `statusProvider`. If no provider is wired, the command is inert so other
   * prompts ("how are you today love?") still route through chat() normally.
   */
  async checkStatusCommand(text) {
    if (!this.config.statusProvider || !text) return null;
    const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!isStatusTrigger(trimmed)) return null;
    try {
      const summary = await this.config.statusProvider();
      return formatOperatorStatus(summary);
    } catch (err) {
      return `Status check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  async checkApprovalCommand(text) {
    if (!this.config.approvalQueue || !text) return null;
    const trimmed = text.trim().toLowerCase();
    const listMatch = trimmed.match(/^approvals?$/);
    const approveMatch = trimmed.match(/^approve\s*(\d*)$/);
    const denyMatch = trimmed.match(/^deny\s*(\d*)$/);
    if (!listMatch && !approveMatch && !denyMatch) return null;
    const pending = this.config.approvalQueue.list();
    if (pending.length === 0) {
      return "No pending approvals right now.";
    }
    if (listMatch) {
      return [
        "Pending approvals:",
        "",
        ...pending.map((approval2, index) => `${index + 1}. ${approval2.description.slice(0, 180)}`),
        "",
        'Reply "approve 1" or "deny 1".'
      ].join("\n");
    }
    const isApprove = !!approveMatch;
    const indexStr = isApprove ? approveMatch?.[1] ?? "" : denyMatch?.[1] ?? "";
    const idx = indexStr ? parseInt(indexStr, 10) - 1 : pending.length - 1;
    if (idx < 0 || idx >= pending.length) {
      return `Invalid approval number. I have ${pending.length} pending \u2014 reply "approve 1" through "approve ${pending.length}".`;
    }
    const approval = pending[idx];
    try {
      if (isApprove) {
        this.config.approvalQueue.approve(approval.id);
        return `Approved: ${approval.description.slice(0, 200)}`;
      } else {
        this.config.approvalQueue.deny(approval.id);
        return `Denied: ${approval.description.slice(0, 200)}`;
      }
    } catch (err) {
      return `Failed to ${isApprove ? "approve" : "deny"}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  async checkMessageCommand(text) {
    if (!this.config.messageReader || !text) return null;
    const trimmed = text.trim().toLowerCase();
    const listMatch = trimmed.match(/^(messages|triage|judgment|judgments)$/);
    const draftMatch = trimmed.match(/^(draft|reply)\s+(\d+)$/);
    const followupListMatch = trimmed.match(/^(followups?|nudges?)$/);
    const nudgeMatch = trimmed.match(/^(nudge|followup)\s+(\d+)$/);
    const sendMatch = trimmed.match(/^send\s+(\d+)$/);
    if (!listMatch && !draftMatch && !followupListMatch && !nudgeMatch && !sendMatch) {
      return null;
    }
    if (followupListMatch || nudgeMatch) {
      this.lastSuggestedQueueSource = "followup";
      const items2 = this.lastMessageFollowupItems.length > 0 && !followupListMatch ? this.lastMessageFollowupItems : this.getMessageFollowupItems();
      if (items2.length === 0) {
        return "No message follow-ups are due right now.";
      }
      if (followupListMatch) {
        return [
          "Message follow-ups due:",
          "",
          ...items2.flatMap((item, index) => [
            `${index + 1}. [${item.priority}] ${item.contact} \u2014 ${truncateInline(item.preview, 90)} (${formatAgeMinutes(item.ageMinutes)})`,
            `   ${item.recommendedAction}`
          ]),
          "",
          this.config.approvalQueue ? 'Reply "nudge 1" for a suggested follow-up or "send 1" to queue it for approval.' : 'Reply "nudge 1" for a suggested follow-up.'
        ].join("\n");
      }
      const rawIdx2 = parseInt(nudgeMatch?.[2] ?? "", 10);
      const idx2 = Number.isNaN(rawIdx2) ? -1 : rawIdx2 - 1;
      if (idx2 < 0 || idx2 >= items2.length) {
        return `Invalid follow-up number. I have ${items2.length} queued \u2014 reply "nudge 1" through "nudge ${items2.length}".`;
      }
      const packet2 = await this.prepareSuggestedDraft(items2[idx2], "followup");
      return this.renderSuggestedDraft(packet2, idx2 + 1);
    }
    if (listMatch || draftMatch) {
      this.lastSuggestedQueueSource = "judgment";
      const items2 = this.lastMessageJudgmentItems.length > 0 && !listMatch ? this.lastMessageJudgmentItems : this.getMessageJudgmentItems();
      if (items2.length === 0) {
        return "No message threads need judgment right now.";
      }
      if (listMatch) {
        return [
          "Messages needing judgment:",
          "",
          ...items2.flatMap((item, index) => [
            `${index + 1}. [${item.priority}] ${item.contact} \u2014 ${truncateInline(item.preview, 90)} (${formatAgeMinutes(item.ageMinutes)})`,
            `   ${item.whyNow}`
          ]),
          "",
          this.config.approvalQueue ? 'Reply "draft 1" for a suggested response or "send 1" to queue it for approval.' : 'Reply "draft 1" for a suggested response.'
        ].join("\n");
      }
      const rawIdx2 = parseInt(draftMatch?.[2] ?? "", 10);
      const idx2 = Number.isNaN(rawIdx2) ? -1 : rawIdx2 - 1;
      if (idx2 < 0 || idx2 >= items2.length) {
        return `Invalid message number. I have ${items2.length} queued \u2014 reply "draft 1" through "draft ${items2.length}".`;
      }
      const packet2 = await this.prepareSuggestedDraft(items2[idx2], "judgment");
      return this.renderSuggestedDraft(packet2, idx2 + 1);
    }
    if (!sendMatch) {
      return null;
    }
    const source = this.resolveSuggestedQueueSourceForSend();
    if (!source) {
      return 'Reply "messages" or "followups" first, then "send 1".';
    }
    this.lastSuggestedQueueSource = source;
    const items = source === "followup" ? this.lastMessageFollowupItems.length > 0 ? this.lastMessageFollowupItems : this.getMessageFollowupItems() : this.lastMessageJudgmentItems.length > 0 ? this.lastMessageJudgmentItems : this.getMessageJudgmentItems();
    if (items.length === 0) {
      return source === "followup" ? "No message follow-ups are due right now." : "No message threads need judgment right now.";
    }
    const rawIdx = parseInt(sendMatch[1] ?? "", 10);
    const idx = Number.isNaN(rawIdx) ? -1 : rawIdx - 1;
    if (idx < 0 || idx >= items.length) {
      return `Invalid message number. I have ${items.length} queued \u2014 reply "send 1" through "send ${items.length}".`;
    }
    const packet = await this.prepareSuggestedDraft(items[idx], source);
    return this.queueSuggestedSend(packet);
  }
  getMessageJudgmentItems() {
    if (!this.config.messageReader) return [];
    const recent = this.config.messageReader.readRecent({ limit: 150 });
    const triage = analyzeRecentMessages(recent);
    const items = buildMessageJudgmentQueue(triage, { limit: 5 }).items;
    this.lastMessageJudgmentItems = items;
    return items;
  }
  getMessageFollowupItems() {
    if (!this.config.messageReader) return [];
    const recent = this.config.messageReader.readRecent({ limit: 150 });
    const triage = analyzeRecentMessages(recent);
    const items = buildMessageFollowupQueue(triage, { limit: 5 }).items;
    this.lastMessageFollowupItems = items;
    return items;
  }
  resolveSuggestedQueueSourceForSend() {
    if (this.lastSuggestedQueueSource) return this.lastSuggestedQueueSource;
    if (this.lastMessageJudgmentItems.length > 0 && this.lastMessageFollowupItems.length === 0) {
      return "judgment";
    }
    if (this.lastMessageFollowupItems.length > 0 && this.lastMessageJudgmentItems.length === 0) {
      return "followup";
    }
    return null;
  }
  async prepareSuggestedDraft(item, source) {
    const cacheKey = `${source}:${item.chatId}`;
    const cached = this.suggestedDraftCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!this.config.messageReader) {
      return "I can't load that thread right now.";
    }
    const messages = this.config.messageReader.readThread(item.chatId, 12);
    if (messages.length === 0) {
      return "I couldn't load that thread right now.";
    }
    if (!this.config.draftReply) {
      return [
        `Drafting isn't configured for ${item.contact} yet.`,
        "",
        `Suggested move: ${item.recommendedAction}`
      ].join("\n");
    }
    try {
      const ordered = [...messages].sort(
        (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()
      );
      const latest = ordered[ordered.length - 1] ?? null;
      const recipient = resolveRecipient(ordered, item.contact);
      const packet = await this.config.draftReply({
        messages: ordered,
        contact: item.contact,
        chatId: item.chatId,
        goal: item.suggestedGoal,
        draftLength: "short"
      });
      const normalized = packet && typeof packet === "object" && "draft" in packet && "summary" in packet ? packet : parseReplyDraftResponse(String(packet ?? ""), {
        recipient,
        chatId: item.chatId,
        latestAt: latest?.date ?? null,
        messageCount: ordered.length,
        replyNeeded: item.waitingFor === "reply"
      });
      const draftPacket = {
        source,
        contact: item.contact,
        chatId: item.chatId,
        recipient,
        suggestedGoal: item.suggestedGoal,
        recommendedAction: item.recommendedAction,
        waitingFor: item.waitingFor,
        whyNow: item.whyNow,
        draft: typeof normalized.draft === "string" ? normalized.draft.trim() : "",
        summary: typeof normalized.summary === "string" ? normalized.summary.trim() : "",
        confidence: typeof normalized.confidence === "string" ? normalized.confidence.trim() : "",
        contactContextSummary: typeof normalized.contactContextSummary === "string" ? normalized.contactContextSummary.trim() : ""
      };
      this.suggestedDraftCache.set(cacheKey, draftPacket);
      return draftPacket;
    } catch (err) {
      return `I couldn't draft that reply right now: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  renderSuggestedDraft(packet, sendIndex) {
    if (typeof packet === "string") {
      return packet;
    }
    const lines = [`Draft for ${packet.contact}:`, "", packet.draft || "(No draft generated.)"];
    if (packet.summary) lines.push("", `Context: ${packet.summary}`);
    if (packet.contactContextSummary) {
      lines.push(`Profile: ${packet.contactContextSummary}`);
    }
    if (packet.whyNow) lines.push("", `Why now: ${packet.whyNow}`);
    lines.push(`Suggested move: ${packet.recommendedAction}`);
    if (packet.confidence) lines.push(`Confidence: ${packet.confidence}`);
    if (sendIndex && this.config.approvalQueue && packet.draft) {
      lines.push("", `Reply "send ${sendIndex}" to queue this draft for approval.`);
    }
    return lines.join("\n");
  }
  queueSuggestedSend(packet) {
    if (typeof packet === "string") {
      return packet;
    }
    if (!this.config.approvalQueue) {
      return "Approval queue isn't configured, so I can't safely send that right now.";
    }
    if (!packet.draft.trim()) {
      return `I don't have a sendable draft for ${packet.contact} yet.`;
    }
    const recipient = packet.recipient.trim() || packet.contact.trim();
    const message = packet.draft.trim();
    const description = `message.send: ${recipient} \u2014 ${truncateInline(message.replace(/\s+/g, " "), 180)}`;
    const approvalId = this.config.approvalQueue.add({
      action: {
        id: `imessage-send-${Date.now()}`,
        type: "messaging.send",
        target: recipient,
        params: {
          recipient,
          message,
          service: "iMessage",
          chatId: packet.chatId,
          source: `imessage-gateway-${packet.source}`
        },
        zone: "guarded",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      },
      description,
      confidence: toApprovalConfidence(packet.confidence)
    });
    this.pendingSuggestedSends.set(approvalId, {
      recipient,
      message,
      contact: packet.contact
    });
    void this.flushSuggestedSendOnApproval(approvalId);
    const pending = this.config.approvalQueue.list();
    const approvalIndex = pending.findIndex((approval) => approval.id === approvalId);
    if (approvalIndex >= 0) {
      return `Queued send approval for ${recipient}. Reply "approve ${approvalIndex + 1}" or just "approve" to send it.`;
    }
    return `Queued send approval for ${recipient}. Reply "approve" to send it.`;
  }
  async flushSuggestedSendOnApproval(approvalId) {
    if (!this.config.approvalQueue) return;
    const pending = this.pendingSuggestedSends.get(approvalId);
    if (!pending) return;
    const result = await this.config.approvalQueue.getPromise(approvalId);
    this.pendingSuggestedSends.delete(approvalId);
    if (result !== "approved") {
      return;
    }
    try {
      await this.config.sender.send(pending.recipient, pending.message, { retryOnFailure: true });
      await this.safeSend(
        `Sent to ${pending.contact}: ${truncateInline(pending.message.replace(/\s+/g, " "), 140)}`
      );
    } catch (err) {
      await this.safeSend(
        `Approved send to ${pending.contact}, but it failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  /**
   * Send approval request to user via iMessage.
   */
  async handleApprovalCreated(data) {
    const approvalId = typeof data.approvalId === "string" && data.approvalId.trim().length > 0 ? data.approvalId.trim() : null;
    const description = data.description;
    const confidence = data.confidence;
    if (!approvalId || !description?.trim()) return;
    this.pendingApprovalAnnouncements = this.pendingApprovalAnnouncements.filter(
      (item) => item.approvalId !== approvalId
    );
    this.pendingApprovalAnnouncements.push({
      approvalId,
      description,
      confidence,
      createdAtMs: Date.now()
    });
    const lines = ["Approval needed:", "", description];
    if (confidence !== void 0) {
      lines.push(`Confidence: ${confidence}%`);
    }
    lines.push("", 'Reply "approve" or "deny"');
    if (this.snoozedUntil > Date.now()) return;
    this.schedulePendingApprovalFlush();
  }
  schedulePendingApprovalFlush() {
    if (this.approvalBatchTimer) {
      clearTimeout(this.approvalBatchTimer);
      this.approvalBatchTimer = null;
    }
    if (this.pendingApprovalAnnouncements.length === 0) {
      return;
    }
    if (this.snoozedUntil > Date.now()) {
      return;
    }
    const now = Date.now();
    const dueAt = Math.min(
      ...this.pendingApprovalAnnouncements.map(
        (item) => item.createdAtMs + Math.max(0, this.approvalFallbackWindowMs) + Math.max(0, this.approvalBatchWindowMs)
      )
    );
    this.approvalBatchTimer = setTimeout(() => {
      void this.flushPendingApprovalAnnouncements();
    }, Math.max(0, dueAt - now));
  }
  async flushPendingApprovalAnnouncements() {
    if (this.approvalBatchTimer) {
      clearTimeout(this.approvalBatchTimer);
      this.approvalBatchTimer = null;
    }
    if (this.pendingApprovalAnnouncements.length === 0) {
      return;
    }
    const now = Date.now();
    const queued = this.pendingApprovalAnnouncements.filter(
      (item) => item.createdAtMs + Math.max(0, this.approvalFallbackWindowMs) + Math.max(0, this.approvalBatchWindowMs) <= now
    );
    if (queued.length === 0) {
      this.schedulePendingApprovalFlush();
      return;
    }
    const queuedIds = new Set(queued.map((item) => item.approvalId));
    this.pendingApprovalAnnouncements = this.pendingApprovalAnnouncements.filter(
      (item) => !queuedIds.has(item.approvalId)
    );
    const pending = (this.config.approvalQueue?.list() ?? []).filter(
      (approval) => queuedIds.has(approval.id)
    );
    if (pending.length === 0) {
      this.schedulePendingApprovalFlush();
      return;
    }
    if (pending.length <= 1) {
      const single = pending[0] ?? queued[queued.length - 1];
      const lines2 = ["Approval needed:", "", single.description];
      if (single.confidence !== void 0) {
        lines2.push(`Confidence: ${single.confidence}%`);
      }
      lines2.push("", 'Reply "approve" or "deny"');
      if ("id" in single && typeof single.id === "string") {
        this.announcedApprovalIds.add(single.id);
      } else {
        this.announcedApprovalIds.add(queued[queued.length - 1].approvalId);
      }
      await this.safeSend(lines2.join("\n"));
      this.schedulePendingApprovalFlush();
      return;
    }
    for (const approval of pending) {
      this.announcedApprovalIds.add(approval.id);
    }
    const lines = [
      "Pending approvals:",
      "",
      ...pending.map((approval, index) => {
        const confidenceSuffix = approval.confidence !== void 0 ? ` (${approval.confidence}%)` : "";
        return `${index + 1}. ${approval.description.slice(0, 180)}${confidenceSuffix}`;
      }),
      "",
      'Reply "approve 1" or "deny 1".'
    ];
    await this.safeSend(lines.join("\n"));
    this.schedulePendingApprovalFlush();
  }
  /**
   * Notify user of approval resolution.
   */
  async handleApprovalResolved(data) {
    const approvalId = typeof data.approvalId === "string" && data.approvalId.trim().length > 0 ? data.approvalId.trim() : null;
    if (approvalId) {
      const before = this.pendingApprovalAnnouncements.length;
      this.pendingApprovalAnnouncements = this.pendingApprovalAnnouncements.filter(
        (item) => item.approvalId !== approvalId
      );
      if (this.pendingApprovalAnnouncements.length !== before) {
        this.schedulePendingApprovalFlush();
      }
      if (!this.announcedApprovalIds.delete(approvalId)) {
        return;
      }
    }
    const status = typeof data.result === "string" ? data.result : data.status;
    const description = data.description;
    if (status && description) {
      await this.safeSend(
        `${status === "approved" ? "Approved" : "Denied"}: ${description.slice(0, 300)}`
      );
    }
  }
  async handleNotificationReopened(data) {
    const notificationId = typeof data.notificationId === "string" && data.notificationId.trim().length > 0 ? data.notificationId.trim() : null;
    if (!notificationId) return;
    const notificationKind = typeof data.notificationKind === "string" ? data.notificationKind.trim().toLowerCase() : "";
    if (notificationKind && !notificationKind.includes("approval")) {
      return;
    }
    const before = this.pendingApprovalAnnouncements.length;
    this.pendingApprovalAnnouncements = this.pendingApprovalAnnouncements.filter(
      (item) => item.approvalId !== notificationId
    );
    if (this.pendingApprovalAnnouncements.length !== before) {
      this.schedulePendingApprovalFlush();
    }
  }
  /**
   * Split long messages and send sequentially with ordering delays.
   * Appends (1/N) indicators when splitting.
   *
   * `isChatReply: true` flows through to `safeSend` / the sender so the
   * session write for chat responses isn't duplicated (chat() already
   * records the assistant turn). Proactive sends leave it false.
   */
  async sendLong(text, opts) {
    if (text.length <= this.maxLen) {
      await this.safeSend(text, opts);
      return;
    }
    const chunks = this.splitMessage(text, this.maxLen);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const suffix = total > 1 ? ` (${i + 1}/${total})` : "";
      await this.safeSend(chunks[i] + suffix, opts);
      if (i < total - 1) {
        await this.delay(CHUNK_DELAY_MS);
      }
    }
  }
  /**
   * Split text at natural boundaries (double newline, then single newline, then hard cut).
   */
  splitMessage(text, maxLen) {
    const chunks = [];
    let remaining = text;
    const effectiveMax = maxLen - 8;
    while (remaining.length > effectiveMax) {
      let splitAt = remaining.lastIndexOf("\n\n", effectiveMax);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", effectiveMax);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", effectiveMax);
      if (splitAt <= 0) splitAt = effectiveMax;
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.trim()) {
      chunks.push(remaining.trim());
    }
    return chunks;
  }
  /**
   * Check for a `[brainstorm]` / `[bs]` / `[brain]` prefix and route the
   * stripped user message through the conversational brainstorm path:
   * loads history + auto-context, prepends the latest brainstorm system
   * prompt from the growth-cycle artifacts, and calls `config.brainstormChat`.
   *
   * Returns the reply text when handled (also sends it), "" when the
   * prefix was empty or the call errored (operator-visible message sent),
   * and null when no prefix matched OR the brainstorm path is not wired
   * (caller should fall through to the normal agent loop).
   */
  async checkBrainstormCommand(text) {
    const match = text.match(_IMessageGateway.BRAINSTORM_PREFIX_RE);
    if (!match) return null;
    const userMessage = text.slice(match[0].length).trim();
    if (!userMessage) {
      await this.safeSend(
        "Got the [brainstorm] tag but no message after it. Try `[brainstorm] what should I do tonight?`"
      );
      return "";
    }
    if (!this.config.brainstormChat) {
      return null;
    }
    let systemPrompt = "";
    let promptSource = "fallback";
    let promptVersion = 0;
    try {
      const snap = this.config.brainstormLoader?.load();
      if (snap) {
        systemPrompt = snap.xml;
        promptSource = snap.source;
        promptVersion = snap.version;
      }
    } catch (err) {
      console.warn(
        "[IMessageGateway] brainstorm prompt load failed:",
        err instanceof Error ? err.message : err
      );
    }
    let autoContext = "";
    try {
      const inputs = await this.config.autoContextProvider?.();
      if (inputs) autoContext = buildAutoContextSnippet(inputs);
    } catch (err) {
      console.warn(
        "[IMessageGateway] auto-context build failed:",
        err instanceof Error ? err.message : err
      );
    }
    let history = [];
    try {
      history = this.config.conversationStore?.loadHistory(this.config.contact, 10) ?? [];
    } catch (err) {
      console.warn(
        "[IMessageGateway] history load failed:",
        err instanceof Error ? err.message : err
      );
    }
    let response;
    try {
      response = await this.config.brainstormChat({
        systemPrompt,
        autoContext,
        history,
        userMessage,
        sessionId: this.sessionId
      });
    } catch (err) {
      console.error(
        "[IMessageGateway] brainstormChat failed:",
        err instanceof Error ? err.message : err
      );
      const hiccup = "Brain hiccup \u2014 try again, or drop the [brainstorm] tag for the slower agent path.";
      this.resetSessionIfCannedFallback(hiccup);
      await this.safeSend(hiccup);
      return "";
    }
    const trimmed = (response ?? "").trim();
    if (!trimmed) {
      await this.safeSend("(empty reply \u2014 try a slightly more specific question)");
      return "";
    }
    try {
      this.config.conversationStore?.appendTurn(this.config.contact, "user", userMessage);
      this.config.conversationStore?.appendTurn(this.config.contact, "assistant", trimmed);
    } catch (err) {
      console.warn(
        "[IMessageGateway] history persist failed:",
        err instanceof Error ? err.message : err
      );
    }
    console.log(
      `[IMessageGateway] brainstorm reply (prompt=${promptSource}/v${promptVersion}, history=${history.length}, ctx=${autoContext.length}b)`
    );
    await this.sendLong(trimmed, { isChatReply: true });
    return "";
  }
  /**
   * Reset the per-sender brainstorm conversation history. Triggered by
   * "clear" / "reset" / "/clear" / "reset thread" / "new thread".
   */
  async checkClearCommand(text) {
    const normalized = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!_IMessageGateway.CLEAR_TRIGGERS.has(normalized)) return null;
    if (!this.config.conversationStore) return null;
    let removed = 0;
    try {
      removed = this.config.conversationStore.clearHistory(this.config.contact);
    } catch (err) {
      console.warn(
        "[IMessageGateway] clearHistory failed:",
        err instanceof Error ? err.message : err
      );
    }
    const reply = removed > 0 ? `Cleared ${removed} turn${removed === 1 ? "" : "s"} from the thread.` : "Thread already empty.";
    await this.safeSend(reply);
    return reply;
  }
  /**
   * Show the operator what auto-context Zaraa would prepend on a brainstorm
   * reply right now. Triggered by "state" / "/state" / "what do you know" /
   * "show context".
   */
  async checkStateCommand(text) {
    const normalized = text.trim().toLowerCase().replace(/[?!.]+$/, "");
    if (!_IMessageGateway.STATE_TRIGGERS.has(normalized)) return null;
    let snippet = "";
    try {
      const inputs = await this.config.autoContextProvider?.();
      if (inputs) snippet = buildAutoContextSnippet(inputs, { maxChars: 4e3 });
    } catch (err) {
      console.warn(
        "[IMessageGateway] auto-context for /state failed:",
        err instanceof Error ? err.message : err
      );
    }
    const reply = snippet ? snippet : "No state context wired in (operator must configure autoContextProvider).";
    await this.sendLong(reply);
    return reply;
  }
  static BRAINSTORM_PREFIX_RE = /^\[(brainstorm|brain|bs)\]\s*/i;
  static CLEAR_TRIGGERS = /* @__PURE__ */ new Set([
    "clear",
    "reset",
    "reset thread",
    "new thread",
    "/clear"
  ]);
  static STATE_TRIGGERS = /* @__PURE__ */ new Set([
    "state",
    "what do you know",
    "show context",
    "/state"
  ]);
  /**
   * Replies that indicate the agent failed to produce a real answer due to
   * a recoverable transient condition. When we send one of these, the
   * conversation history is almost certainly poisoned (broken role
   * alternation, half-finished tool chain, etc), so we clear the contact's
   * history before the next inbound message lands.
   *
   * Deliberately excluded:
   *   - usage-limit replies (reset doesn't restore budget)
   *   - injection/sanitization-blocked replies (those are security signals
   *     — resetting would hide a probe across multiple messages)
   *   - rate-limit replies (reset doesn't unstick a rate limit)
   */
  static CANNED_FALLBACK_REPLIES = /* @__PURE__ */ new Set([
    "Sorry, that took too long. Try asking something simpler or try again in a moment.",
    "I'm having a temporary storage issue. Try again in a few seconds.",
    "I'm currently restarting. Give me a minute.",
    "Something went wrong on my end. Try again or rephrase your question.",
    "I tried to use some tools but couldn't process them correctly. Let me try again with a different approach.",
    "I'm working on your request but need a moment to process it fully. Let me get back to you shortly.",
    "I processed your message but had nothing to say. Try rephrasing?",
    "Brain hiccup \u2014 try again, or drop the [brainstorm] tag for the slower agent path."
  ]);
  /**
   * If `reply` is a known canned-fallback string, clear the contact's
   * conversation history so the next inbound starts clean. Safe to call
   * on every reply: exact-match means false positives need the reply to
   * be the literal canned string.
   */
  resetSessionIfCannedFallback(reply) {
    const trimmed = reply.trim();
    if (!_IMessageGateway.CANNED_FALLBACK_REPLIES.has(trimmed)) return;
    if (!this.config.conversationStore) return;
    try {
      const removed = this.config.conversationStore.clearHistory(this.config.contact);
      console.warn(
        `[IMessageGateway] reset session for ${this.config.contact} after canned-fallback reply (cleared ${removed} turn${removed === 1 ? "" : "s"})`
      );
    } catch (err) {
      console.warn(
        "[IMessageGateway] clearHistory after canned-fallback failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
  /**
   * Fire-and-forget send — errors are logged, not thrown.
   * `isChatReply` avoids duplicate session records: chat()'s response
   * event already appends the assistant turn in `zaraa.chat()`, so we
   * tell the sender to skip its own session record for that path only.
   * All other proactive sends (approvals, acks, confirmations) let the
   * sender record so the operator's next reply has full context.
   */
  async safeSend(text, opts) {
    try {
      await this.config.sender.send(this.config.contact, text, {
        skipSessionRecord: opts?.isChatReply === true,
        // Background-retry a failed outbound reply (no-op unless the sender's
        // retry queue is enabled). Keeps replies from being silently lost on
        // a transient AppleScript/Shortcuts hiccup.
        retryOnFailure: true
      });
    } catch (err) {
      console.error("[IMessageGateway] Send failed:", err instanceof Error ? err.message : err);
    }
  }
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
function truncateInline(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
function formatAgeMinutes(ageMinutes) {
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  if (ageMinutes < 24 * 60) return `${Math.round(ageMinutes / 60)}h ago`;
  return `${Math.round(ageMinutes / (24 * 60))}d ago`;
}
function toApprovalConfidence(confidence) {
  switch (confidence) {
    case "high":
      return 90;
    case "medium":
      return 70;
    case "low":
      return 50;
    default:
      return void 0;
  }
}
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}
function formatOperatorActivity(snapshot) {
  const lines = ["Zaraa activity:"];
  const now = Date.now();
  if (snapshot.running.length === 0) {
    lines.push("", "Now: idle (no running tasks).");
  } else {
    lines.push("", `Now (${snapshot.running.length} running):`);
    for (const t of snapshot.running.slice(0, 5)) {
      const age = formatAgeFromIso(t.startedAt, now);
      lines.push(`  \u2022 ${t.label} (${age})`);
    }
    if (snapshot.running.length > 5) {
      lines.push(`  \u2026 +${snapshot.running.length - 5} more`);
    }
  }
  if (snapshot.recentCompleted.length > 0) {
    lines.push("", "Just done:");
    for (const t of snapshot.recentCompleted.slice(0, 4)) {
      const age = formatAgeFromIso(t.completedAt, now);
      const mark = t.success ? "\u2713" : "\u2717";
      lines.push(`  ${mark} ${t.label} (${age})`);
    }
  }
  if (snapshot.recentFailed.length > 0) {
    lines.push("", "Failed (24h):");
    for (const t of snapshot.recentFailed.slice(0, 4)) {
      const reason = t.reason ? ` \u2014 ${truncateInline(t.reason, 60)}` : "";
      lines.push(`  \u2717 ${t.label}${reason}`);
    }
  }
  return lines.join("\n");
}
function formatAgeFromIso(iso, nowMs) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const ageMinutes = Math.max(0, Math.floor((nowMs - then) / 6e4));
  return formatAgeMinutes(ageMinutes);
}
function formatOperatorTrading(snapshot) {
  const mode = snapshot.paperMode ? "paper" : "LIVE";
  const halt = snapshot.halted ? " \u2014 \u26A0 HALTED" : "";
  const lines = [`Zaraa trading (${mode})${halt}:`];
  lines.push("");
  lines.push(`\u2022 Equity: $${snapshot.equity.toFixed(2)}`);
  if (snapshot.peakEquity !== void 0 && snapshot.peakEquity > 0) {
    const pct = snapshot.equity ? ((snapshot.equity - snapshot.peakEquity) / snapshot.peakEquity * 100).toFixed(1) : "0.0";
    lines.push(`\u2022 Peak: $${snapshot.peakEquity.toFixed(2)} (${pct}% from peak)`);
  }
  if (snapshot.dayStartEquity !== void 0 && snapshot.dayStartEquity > 0) {
    const dayPnl = snapshot.equity - snapshot.dayStartEquity;
    const sign = dayPnl >= 0 ? "+" : "";
    lines.push(`\u2022 Today: ${sign}$${dayPnl.toFixed(2)}`);
  }
  if (snapshot.halted && snapshot.haltReason) {
    lines.push(`\u2022 Halt reason: ${snapshot.haltReason}`);
  }
  if (snapshot.openPositions.length === 0) {
    lines.push("", "Positions: none");
  } else {
    lines.push("", `Positions (${snapshot.openPositions.length}):`);
    for (const pos of snapshot.openPositions.slice(0, 6)) {
      const pnl = pos.unrealizedPnl !== void 0 ? ` (${pos.unrealizedPnl >= 0 ? "+" : ""}$${pos.unrealizedPnl.toFixed(2)})` : "";
      lines.push(`  ${pos.side === "long" ? "\u25B2" : "\u25BC"} ${pos.symbol} ${pos.size}@$${pos.entry.toFixed(2)}${pnl}`);
    }
    if (snapshot.openPositions.length > 6) {
      lines.push(`  \u2026 +${snapshot.openPositions.length - 6} more`);
    }
  }
  if (snapshot.recentTrades && snapshot.recentTrades.length > 0) {
    const now = Date.now();
    lines.push("", "Recent trades:");
    for (const trade of snapshot.recentTrades.slice(0, 4)) {
      const age = formatAgeFromIso(trade.closedAt, now);
      const pnl = trade.pnl !== void 0 ? ` ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}` : "";
      lines.push(
        `  ${trade.side.toUpperCase()} ${trade.symbol} ${trade.size}@$${trade.price.toFixed(2)}${pnl} (${age})`
      );
    }
  }
  return lines.join("\n");
}
function formatOperatorRecent(snapshot) {
  if (snapshot.turns.length === 0) {
    return "No recent chat turns.";
  }
  const lines = ["Recent chat:"];
  for (const turn of snapshot.turns) {
    const label = turn.role === "user" ? "you" : "Zaraa";
    const content = turn.content.replace(/\s+/g, " ").trim();
    const preview = truncateInline(content, 180);
    lines.push(`\u2022 ${label}: ${preview}`);
  }
  return lines.join("\n");
}
function formatOperatorStatus(summary) {
  const degraded = summary.degraded.length > 0;
  const header = degraded ? "Zaraa status (\u26A0 degraded):" : "Zaraa status:";
  const lines = [header];
  lines.push(`\u2022 Uptime: ${formatUptime(summary.uptimeSeconds)}`);
  if (summary.lastChatMinutesAgo !== null) {
    const chatAge = summary.lastChatMinutesAgo < 1 ? "just now" : summary.lastChatMinutesAgo < 60 ? `${Math.round(summary.lastChatMinutesAgo)}m ago` : summary.lastChatMinutesAgo < 24 * 60 ? `${Math.round(summary.lastChatMinutesAgo / 60)}h ago` : `${Math.round(summary.lastChatMinutesAgo / (24 * 60))}d ago`;
    lines.push(`\u2022 Last chat: ${chatAge}`);
  }
  if (summary.tasks) {
    const parts = [];
    if (summary.tasks.running > 0) parts.push(`${summary.tasks.running} running`);
    if (summary.tasks.pending > 0) parts.push(`${summary.tasks.pending} pending`);
    if (summary.tasks.failed > 0) parts.push(`${summary.tasks.failed} failed`);
    if (parts.length > 0) lines.push(`\u2022 Tasks: ${parts.join(", ")}`);
    else lines.push("\u2022 Tasks: idle");
  }
  if (summary.pendingApprovals > 0) {
    lines.push(
      `\u2022 Approvals: ${summary.pendingApprovals} pending (reply "approvals")`
    );
  }
  if (summary.trading) {
    const mode = summary.trading.paperMode ? "paper" : "LIVE";
    const equity = summary.trading.equity.toFixed(2);
    const haltSuffix = summary.trading.halted ? ` \u2014 \u26A0 HALTED${summary.trading.haltReason ? ` (${summary.trading.haltReason})` : ""}` : "";
    lines.push(
      `\u2022 Trading: ${mode}, ${summary.trading.openPositions} pos, $${equity}${haltSuffix}`
    );
  }
  if (summary.remoteAccess) {
    const parts = [];
    if (summary.remoteAccess.tunnelConfigured) {
      parts.push(
        summary.remoteAccess.tunnelReachable === true ? "tunnel ok" : summary.remoteAccess.tunnelReachable === false ? "tunnel unreachable" : "tunnel unknown"
      );
    }
    if (summary.remoteAccess.heartbeatConfigured) {
      parts.push(
        summary.remoteAccess.heartbeatHealthy === true ? "heartbeat ok" : summary.remoteAccess.heartbeatHealthy === false ? "heartbeat failing" : "heartbeat unknown"
      );
    }
    if (parts.length > 0) lines.push(`\u2022 Remote: ${parts.join(", ")}`);
  }
  if (degraded) {
    lines.push(`\u2022 Degraded: ${summary.degraded.join(", ")}`);
  } else {
    lines.push("\u2022 All systems OK");
  }
  if (summary.notes && summary.notes.length > 0) {
    lines.push(...summary.notes.map((n) => `\u2022 ${n}`));
  }
  return lines.join("\n");
}

export {
  IMessageGateway,
  formatOperatorActivity,
  formatOperatorTrading,
  formatOperatorRecent,
  formatOperatorStatus
};
