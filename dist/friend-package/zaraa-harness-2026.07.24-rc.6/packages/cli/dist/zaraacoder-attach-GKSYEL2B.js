import {
  acceptBlockedReason,
  buildReadyFilePreviewRows,
  canAcceptSession,
  formatHandoffLines,
  formatProgressRail,
  isActionableSession,
  previewBlockedReason,
  prioritizeActionableSessions
} from "./chunk-HKJMS7DX.js";
import {
  loadModelsDashboard,
  pinZaraacoderModel
} from "./chunk-FA6ZWHA6.js";
import {
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  fetchGatewayResponse,
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/zaraacoder-attach.tsx
import { Buffer } from "buffer";
import { execFile, spawn } from "child_process";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// src/commands/zaraacoder-stream.ts
function parseSseFrame(frameText) {
  const frame = {};
  const dataLines = [];
  for (const line of frameText.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) frame.data = dataLines.join("\n");
  return frame;
}
async function readSseStream(body, onFrame) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frameText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frameText.trim().length > 0) onFrame(parseSseFrame(frameText));
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
  }
}
function subscribeZaraacoderTerminalStream(port, sessionId, handlers, options = {}) {
  const fetchStream = options.fetchImpl ?? fetchGatewayResponse;
  const backoffBaseMs = options.backoffBaseMs ?? 1e3;
  const backoffMaxMs = options.backoffMaxMs ?? 15e3;
  let stopped = false;
  let attempt = 0;
  let lastEventId;
  let controller = null;
  let retryTimer = null;
  const scheduleReconnect = () => {
    if (stopped) return;
    handlers.onStatus?.("reconnecting");
    attempt += 1;
    const delay = Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs);
    retryTimer = setTimeout(() => {
      void connect();
    }, delay);
  };
  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    if (attempt === 0) handlers.onStatus?.("connecting");
    try {
      const query = lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : "";
      const path = `/api/zaraacoder/sessions/${encodeURIComponent(sessionId)}/stream${query}`;
      const response = await fetchStream(port, path, { timeoutMs: null, signal: controller.signal });
      if (!response.ok || !response.body) {
        handlers.onError?.(`Stream unavailable (HTTP ${response.status})`);
        if (response.status === 404) {
          handlers.onStatus?.("closed");
          return;
        }
        scheduleReconnect();
        return;
      }
      attempt = 0;
      handlers.onStatus?.("live");
      await readSseStream(response.body, (frame) => {
        if (frame.id) lastEventId = frame.id;
        if (!frame.data) return;
        try {
          handlers.onEvent(JSON.parse(frame.data));
        } catch {
        }
      });
    } catch (error) {
      if (stopped) return;
      handlers.onError?.(error instanceof Error ? error.message : String(error));
    }
    scheduleReconnect();
  };
  void connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    controller?.abort();
  };
}

// src/commands/zaraacoder-attach.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var ACTIVE_POLL_MS = 1500;
var SETTLED_POLL_MS = 15e3;
var ERROR_POLL_MS = 5e3;
var SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
function isSettledZaraacoderPhase(phase) {
  return [
    "ready",
    "complete",
    "completed",
    "blocked",
    "failed",
    "error",
    "cancelled",
    "stopped"
  ].includes(phase.toLowerCase());
}
function pruneAcceptedSessionSnapshot(session, operations) {
  const appliedFiles = new Set(
    operations.flatMap((operation) => [operation.relativePath, operation.sourcePath])
  );
  return {
    ...session,
    changedFiles: (session.changedFiles ?? []).filter((file) => !appliedFiles.has(file)),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function persistAttachSessionSnapshot(session) {
  const repoPath = session.repoPath?.trim();
  const tracePath = session.tracePath?.trim();
  const createdAt = session.createdAt?.trim();
  const updatedAt = session.updatedAt?.trim() || (/* @__PURE__ */ new Date()).toISOString();
  if (!repoPath || !tracePath || !createdAt) {
    throw new Error("Session snapshot missing repoPath, tracePath, or createdAt");
  }
  const { ZaraacoderSessionStore } = await import("@zaraa/core");
  const store = new ZaraacoderSessionStore({
    rootDir: join(resolveRuntimeHomeDir(), ".zaraa", "zaraacoder")
  });
  const phase = session.phase;
  const reviewStatus = phase === "ready" || phase === "blocked" || phase === "failed" ? phase : null;
  await store.append({
    sessionId: session.sessionId,
    task: session.task,
    repoPath,
    phase,
    ...session.goal ? { goal: session.goal } : {},
    ...session.agentLane ? { agentLane: session.agentLane } : {},
    ...session.executorRoute ? { executorRoute: session.executorRoute } : {},
    branchName: session.branchName ?? null,
    worktreePath: session.worktreePath ?? null,
    tracePath,
    reviewStatus,
    changedFiles: session.changedFiles ?? [],
    ...session.handoffSummary ? { handoffSummary: session.handoffSummary } : {},
    ...session.handoffRisks ? { handoffRisks: session.handoffRisks } : {},
    createdAt,
    updatedAt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attach SessionSnapshot is a subset of store snapshot
  });
}
function zaraacoderAttachPollMs(loaded) {
  if (!loaded.ok) return ERROR_POLL_MS;
  return !loaded.session || isSettledZaraacoderPhase(loaded.session.phase) ? SETTLED_POLL_MS : ACTIVE_POLL_MS;
}
async function fetchSession(port, sessionId) {
  return requestGatewayJson(
    port,
    `/api/zaraacoder/sessions/${encodeURIComponent(sessionId)}`
  );
}
async function fetchSessions(port) {
  return requestGatewayJson(port, "/api/zaraacoder/sessions");
}
async function fetchTrace(port, sessionId) {
  return requestGatewayJson(
    port,
    `/api/zaraacoder/sessions/${encodeURIComponent(sessionId)}/trace`
  );
}
async function startSession(port, body) {
  return requestGatewayJson(port, "/api/zaraacoder/sessions", {
    method: "POST",
    body
  });
}
var SLASH_COMMANDS = [
  "/new <task>",
  "/agent <auto|codex|claude|grok|local|zero>",
  "/models",
  "/model <key|auto>",
  "/status",
  "/diff",
  "/preview [file|number]",
  "/verify",
  "/accept <number>",
  "/undo",
  "/sessions",
  "/attach <session-id|number>",
  "/latest",
  "/brief",
  "/feed",
  "/handoff",
  "/changes",
  "/promote [number]",
  "/copy brief|handoff|diff|promote [number]",
  "/artifact",
  "/open [artifact|worktree|repo|trace]",
  "/doctor",
  "/refresh",
  "/where",
  "/goal <goal>",
  "/continue [note]",
  "/stop",
  "/run <command>",
  "/test <command>",
  "/actions",
  "/trace",
  "/help",
  "/quit"
];
var COMMAND_DESCRIPTIONS = {
  "/new": "start fresh work",
  "/agent": "choose agent lane for new work",
  "/models": "show available LLM sources",
  "/model": "pin model for auto routing",
  "/status": "show current state",
  "/diff": "inspect the patch",
  "/preview": "diff (or file) for one changed path",
  "/verify": "check repo diff",
  "/accept": "apply one reviewed file",
  "/undo": "restore last accepted edit",
  "/sessions": "choose recent work",
  "/attach": "switch session",
  "/latest": "attach latest work",
  "/brief": "show next action",
  "/feed": "show live events",
  "/handoff": "show continuation context",
  "/changes": "show repo status",
  "/promote": "print manual copy command",
  "/copy": "copy output",
  "/artifact": "show artifact URL",
  "/open": "open artifact or path",
  "/doctor": "check terminal health",
  "/refresh": "reload session",
  "/where": "show repo and worktree paths",
  "/goal": "update goal",
  "/continue": "resume settled work",
  "/stop": "stop active work or dismiss review",
  "/run": "run allowlisted command",
  "/test": "run allowlisted check",
  "/actions": "show phase-aware actions",
  "/trace": "reload trace",
  "/help": "show command guide",
  "/quit": "detach terminal"
};
function formatHelpLines() {
  return [
    "Start    plain text after a finished run \xB7 /new <task>",
    "Route    /agent <lane> \xB7 /models \xB7 /model <key|auto>",
    "Watch    /status \xB7 /feed \xB7 /handoff",
    "Review   /diff \xB7 /preview [file|number] \xB7 /verify",
    "Apply    /accept <number> \xB7 /undo \xB7 /promote [number]",
    "Sessions /sessions \xB7 /attach <id|number> \xB7 /latest",
    "Share    /brief \xB7 /handoff \xB7 /copy <target> \xB7 /open <target>",
    "System   /doctor \xB7 /where \xB7 /changes \xB7 /refresh \xB7 /quit",
    "Input    / commands \xB7 ! allowlisted shell \xB7 \u2191\u2193 history \xB7 Tab complete"
  ];
}
var COMMAND_ALIASES = {
  "?": "help",
  a: "actions",
  b: "brief",
  c: "changes",
  d: "diff",
  f: "feed",
  h: "handoff",
  m: "promote",
  n: "brief",
  next: "brief",
  o: "artifact",
  p: "show",
  q: "quit",
  r: "verify",
  s: "status",
  t: "trace",
  u: "undo",
  w: "where"
};
var nextNoticeId = 0;
var NOTICE_LINE_LIMIT = 30;
var execFileAsync = promisify(execFile);
function trimNoticeRows(current, next, limit = NOTICE_LINE_LIMIT) {
  return [...current, ...next].slice(-limit);
}
function shouldCondenseCockpit(noticeCount) {
  return noticeCount > 4;
}
async function copyTextToClipboard(text) {
  await new Promise((resolve2, reject) => {
    const child = spawn("pbcopy", { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve2() : reject(new Error(stderr.trim() || `pbcopy exited ${code}`));
    });
    child.stdin.end(text);
  });
}
function normalizeTerminalEvent(event) {
  return {
    id: event.id ?? `${event.kind ?? event.type ?? "event"}:${event.timestamp ?? Date.now()}`,
    kind: event.kind ?? event.type ?? "event",
    timestamp: event.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
    message: event.message ?? "",
    ...event.data ? { data: event.data } : {}
  };
}
function latestExecutorRoute(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "executor.selected") continue;
    const route = typeof event.data?.route === "string" ? event.data.route : event.message;
    if (route.trim()) return route.trim();
  }
  return null;
}
function flattenTerminalStreamEvent(event) {
  if (event.kind === "trace") {
    const trace = event.data?.trace;
    if (trace) {
      return {
        id: trace.id ?? event.id,
        kind: trace.type ?? "event",
        timestamp: trace.timestamp ?? event.timestamp,
        message: trace.message ?? event.message,
        ...trace.data ? { data: trace.data } : {}
      };
    }
  }
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    message: event.message,
    ...event.data ? { data: event.data } : {}
  };
}
function formatControlResultRows(event) {
  if (!event) return ["\u2713 Sent"];
  const normalized = normalizeTerminalEvent(event);
  const kind = normalized.kind.toLowerCase();
  const message = normalized.message.trim().replace(/\s+/g, " ");
  const icon = kind.includes("error") || kind.includes("fail") ? "\xD7" : kind.includes("stop") || kind.includes("cancel") ? "\u25A0" : kind.includes("continue") || kind.includes("message") || kind.includes("steer") ? "\u203A" : kind.includes("ready") || kind.includes("complete") ? "\u25C6" : "\u2713";
  const label = message ? `${normalized.kind} \xB7 ${message}` : normalized.kind;
  return [`${icon} ${label}`];
}
function phaseColor(phase) {
  const normalized = phase.toLowerCase();
  if (normalized === "ready" || normalized === "complete" || normalized === "completed")
    return "green";
  if (normalized === "failed" || normalized === "error") return "red";
  if (normalized === "blocked" || normalized === "review") return "yellow";
  return "cyan";
}
function formatRelativeAge(timestamp, nowMs) {
  if (!timestamp) return null;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1e3));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
function formatLiveActivity(session, frame = 0, nowMs = Date.now()) {
  if (!session) return { active: false, color: "cyan", icon: "\u25C7", label: "Waiting for a task" };
  const phase = session.phase.toLowerCase();
  const age = formatRelativeAge(session.updatedAt, nowMs);
  if (phase === "ready" || phase === "complete" || phase === "completed") {
    return {
      active: false,
      color: "green",
      icon: "\u25C6",
      label: `Ready for review${age ? ` \xB7 ${age} ago` : ""}`
    };
  }
  if (phase === "blocked")
    return { active: false, color: "yellow", icon: "\u25B2", label: "Needs your input" };
  if (phase === "failed" || phase === "error")
    return { active: false, color: "red", icon: "\xD7", label: "Run failed" };
  if (phase === "cancelled" || phase === "stopped")
    return { active: false, color: "gray", icon: "\u25A0", label: "Run stopped" };
  const label = {
    queued: "Bleepy is queued",
    preparing: "Bleepy is preparing a clean worktree",
    planning: "Bleepy is thinking + coding",
    editing: "Bleepy is capturing edits",
    verifying: "Bleepy is running checks",
    reviewing: "Bleepy is reviewing the diff"
  }[phase] ?? "Bleepy is working";
  return {
    active: true,
    color: "cyan",
    icon: SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0] ?? "\xB7",
    label: `${label}${age ? ` \xB7 ${age}` : ""}`
  };
}
function formatLiveEventRow(event) {
  const kind = event.kind.toLowerCase();
  let style;
  switch (kind) {
    case "session.created":
      style = ["\u25C7", "Session started", "cyan"];
      break;
    case "worktree.created":
      style = ["\u2713", "Worktree ready", "green"];
      break;
    case "worktree.source-dirty":
    case "worktree.source-status-unavailable":
      style = ["!", "Source isolated", "yellow"];
      break;
    case "context.loaded":
      style = ["\u2713", "Context loaded", "green"];
      break;
    case "executor.selected":
      style = ["\u25C6", "LLM route", "magenta"];
      break;
    case "planner.fallback":
      style = ["\u21B3", "Fallback selected", "yellow"];
      break;
    case "plan.written":
      style = ["\u2713", "Coding complete", "green"];
      break;
    case "edit.recorded":
      style = ["+", "Edit captured", "magenta"];
      break;
    case "check.started":
      style = ["\u25C6", "Checking", "cyan"];
      break;
    case "check.completed": {
      const passed = event.message.includes("exited 0");
      style = [passed ? "\u2713" : "\xD7", "Check complete", passed ? "green" : "red"];
      break;
    }
    case "check.skipped":
      style = ["\u2013", "Check skipped", "yellow"];
      break;
    case "review.completed":
      style = ["\u2713", "Review complete", "green"];
      break;
    case "session.completed":
      style = ["\u25C6", "Ready for you", "green"];
      break;
    default:
      style = kind.includes("blocked") ? ["!", "Blocked", "yellow"] : kind.includes("failed") || kind === "error" ? ["\xD7", "Failed", "red"] : ["\xB7", event.kind.replaceAll(".", " "), "gray"];
  }
  const [icon, label, color] = style;
  const time = event.timestamp.includes("T") ? event.timestamp.slice(11, 16) : event.timestamp.slice(0, 5);
  const message = event.message.trim().replace(/\s+/g, " ");
  const clipped = message.length > 64 ? `${message.slice(0, 61)}...` : message;
  return { color, text: `${icon} ${time} ${label}${clipped ? ` \xB7 ${clipped}` : ""}` };
}
function formatOutputEventRow(event) {
  const stream = typeof event.data?.stream === "string" ? event.data.stream : "stdout";
  const text = event.message.trim();
  if (stream === "thinking") {
    const clipped2 = text.length > 90 ? `${text.slice(0, 87)}...` : text;
    return { dim: true, text: `\u{1F4AD} ${clipped2.replace(/\s+/g, " ")}` };
  }
  if (stream === "tool") {
    const clipped2 = text.length > 64 ? `${text.slice(0, 61)}...` : text;
    return { color: "magenta", dim: false, text: `\u2699 ${clipped2.replace(/\s+/g, " ")}` };
  }
  if (stream === "stderr") {
    if (/DeprecationWarning|ExperimentalWarning|npm warn|^\s*$/i.test(text)) {
      return { dim: true, text: "" };
    }
    const clipped2 = text.length > 90 ? `${text.slice(0, 87)}...` : text;
    return { color: "red", dim: false, text: `\u26A0 ${clipped2.replace(/\s+/g, " ")}` };
  }
  const clipped = text.length > 90 ? `${text.slice(0, 87)}...` : text;
  return { dim: false, color: "cyan", text: `\u203A ${clipped.replace(/\s+/g, " ")}` };
}
function formatCockpitEventRow(event) {
  const row = event.kind === "output" ? formatOutputEventRow(event) : formatLiveEventRow(event);
  const text = row.text.replace(/\s+/g, " ").trim();
  return { ...row, text: text.length > 180 ? `${text.slice(0, 177)}...` : text };
}
function hasReviewableFiles(session) {
  return (session?.changedFiles?.length ?? 0) > 0;
}
function nextActionForSession(session, surface = "attach", sessionRef) {
  if (!session)
    return surface === "standalone" ? "zaraacoder <task>" : "Type a task, or use /new <task>.";
  const phase = session.phase.toLowerCase();
  const reviewable = hasReviewableFiles(session);
  if (surface === "standalone") {
    if ((phase === "ready" || phase === "complete" || phase === "completed") && reviewable) {
      return sessionRef ? `zaraacoder preview ${sessionRef} 1` : "zaraacoder preview 1";
    }
    if (phase === "blocked" || phase === "failed") {
      return "zaraacoder handoff";
    }
    if (phase === "planning") return "zaraacoder feed";
    if (phase === "ready" && !reviewable) return 'zaraacoder "<task>"';
    return "zaraacoder status";
  }
  if ((phase === "ready" || phase === "complete" || phase === "completed") && reviewable) {
    return "Preview one file, run /verify, then /accept 1 when ready.";
  }
  if (phase === "blocked" || phase === "failed") {
    return "Read /handoff, then start a corrected run with /new <task>.";
  }
  if (phase === "planning") {
    return "Watch live work; use /status or /feed for detail.";
  }
  if (phase === "ready" && !reviewable) {
    return "History only \u2014 start a new task when you want a fresh review.";
  }
  return "Watch feed, then use /status or /handoff when state changes.";
}
function formatActionDeck(session, surface = "attach", sessionRef) {
  if (surface === "standalone") {
    if (!session) return ["zaraacoder <task>", "zaraacoder sessions"];
    const phase2 = session.phase.toLowerCase();
    if ((phase2 === "ready" || phase2 === "complete" || phase2 === "completed") && hasReviewableFiles(session)) {
      return sessionRef ? [`zaraacoder preview ${sessionRef} 1`, `zaraacoder accept ${sessionRef} 1`] : ["zaraacoder preview 1", "zaraacoder accept 1"];
    }
    if (phase2 === "blocked" || phase2 === "failed" || phase2 === "error") {
      return ["zaraacoder handoff", "zaraacoder stop"];
    }
    if (phase2 === "ready") return ['zaraacoder "<task>"', "zaraacoder sessions"];
    return ["zaraacoder status", "zaraacoder feed"];
  }
  if (!session) return ["/new <task>", "/sessions"];
  const phase = session.phase.toLowerCase();
  if ((phase === "ready" || phase === "complete" || phase === "completed") && hasReviewableFiles(session)) {
    return ["/preview 1", "/accept 1"];
  }
  if (phase === "blocked" || phase === "failed" || phase === "error") {
    return ["/handoff", "/continue <note>"];
  }
  if (phase === "ready") return ["/new <task>", "/sessions"];
  return ["/status", "/stop"];
}
function formatEventPulse(events) {
  if (!events.length) return "Pulse \xB7 quiet";
  const latest = events[events.length - 1];
  const stamped = formatEventRow({
    id: latest.id ?? "pulse",
    kind: latest.kind,
    timestamp: latest.timestamp ?? "2026-01-01T00:00:00.000Z",
    message: latest.message,
    ...latest.data ? { data: latest.data } : {}
  });
  const withoutTime = stamped.replace(/\s\d{2}:\d{2}\s+/, " ").replace(/^[·]\s+/, "").trim();
  const label = withoutTime || latest.kind;
  return `Pulse \xB7 ${events.length} \xB7 ${label}`;
}
function formatEventRow(event) {
  const time = event.timestamp.includes("T") ? event.timestamp.slice(11, 16) : event.timestamp.slice(0, 5);
  const kind = event.kind.toLowerCase();
  if (kind === "output" || kind === "executor.output") {
    const row = formatOutputEventRow({
      message: event.message,
      data: event.data ?? (kind === "executor.output" ? { stream: "stdout" } : void 0)
    });
    if (!row.text) return "";
    return `${time} ${row.text}`.trim();
  }
  return formatLiveEventRow({
    kind: event.kind,
    message: event.message,
    timestamp: event.timestamp
  }).text;
}
function formatFeedRows(events, limit = 12) {
  const rows = events.slice(-limit).map(formatEventRow).filter((row) => row.length > 0);
  return rows.length ? rows : ["Feed empty \xB7 run a task or open attach"];
}
function briefPathHint(session) {
  const files = session.changedFiles ?? [];
  if (!files.length) return "";
  const first = displaySessionPath(session, files[0]);
  return files.length === 1 ? ` \xB7 ${first}` : ` \xB7 ${files.length} files \xB7 ${first}`;
}
function formatOperatorBrief(session, events, context) {
  const surface = context.surface ?? "attach";
  const nextLabel = surface === "standalone" ? "Next:" : "Next";
  if (!session) {
    return [
      "Brief \xB7 no session",
      `${nextLabel} ${nextActionForSession(null, surface)}`,
      `Actions ${formatActionDeck(null, surface).join(" | ")}`,
      formatEventPulse(events)
    ];
  }
  const sessionId = session.sessionId || context.sessionId;
  const phaseLabel = session.phase === "ready" && (session.changedFiles?.length ?? 0) === 0 ? "stored" : session.phase;
  return [
    `Brief \xB7 ${phaseLabel}${briefPathHint(session)}`,
    `  task \xB7 ${session.task}`,
    `  id \xB7 ${sessionId}`,
    `${nextLabel} ${nextActionForSession(session, surface, context.sessionRef)}`,
    `Actions ${formatActionDeck(session, surface, context.sessionRef).join(" | ")}`,
    `Artifact http://localhost:${context.port}/api/zaraacoder/sessions/${encodeURIComponent(sessionId)}/artifact`,
    formatEventPulse(events),
    ...events.length ? ["Recent:", ...formatFeedRows(events, 3)] : []
  ];
}
function formatMissionStatus(session) {
  if (!session) return ["No session loaded."];
  const phase = session.phase === "ready" && (session.changedFiles?.length ?? 0) === 0 ? "stored" : session.phase;
  return [
    `Mission \xB7 ${phase}${briefPathHint(session)}${session.agentLane ? ` \xB7 ${session.agentLane}` : ""}`,
    `  id \xB7 ${session.sessionId.slice(0, 8)}`,
    session.goal ? `  goal \xB7 ${session.goal}` : null,
    session.branchName ? `  branch \xB7 ${session.branchName}` : null,
    session.changedFiles?.length ? `  files \xB7 ${session.changedFiles.slice(0, 4).map((file, index) => `${index + 1}. ${displaySessionPath(session, file)}`).join(" | ")}${session.changedFiles.length > 4 ? ` +${session.changedFiles.length - 4}` : ""}` : null
  ].filter((line) => Boolean(line));
}
function formatWhereRows(session, cwd) {
  if (!session) {
    return [`Where \xB7 no session`, `  cwd \xB7 ${cwd}`, 'Next: zaraacoder "<task>"'];
  }
  const phase = session.phase === "ready" && (session.changedFiles?.length ?? 0) === 0 ? "stored" : session.phase;
  return [
    `Where \xB7 ${phase}${briefPathHint(session)}`,
    `  cwd \xB7 ${cwd}`,
    session.repoPath ? `  repo \xB7 ${session.repoPath}` : null,
    session.worktreePath ? `  worktree \xB7 ${session.worktreePath}` : null,
    session.tracePath ? `  trace \xB7 ${session.tracePath}` : null,
    `  id \xB7 ${session.sessionId}`
  ].filter((line) => Boolean(line));
}
function formatDoctorRows(input) {
  const standalone = input.standaloneMode === true;
  const stackHealthy = input.snapshot.hasApiKey && input.snapshot.daemonDetected && input.snapshot.gatewayListenerCount > 0;
  const healthy = standalone ? Boolean(input.standaloneCommandPath) : stackHealthy;
  const sessionPhase = input.session?.phase?.toLowerCase() ?? "";
  const reviewableReady = sessionPhase === "ready" && (input.session?.changedFiles?.length ?? 0) > 0;
  const codingReady = standalone ? Boolean(input.standaloneCommandPath) : input.snapshot.daemonDetected && input.snapshot.gatewayListenerCount > 0;
  const sessionFiles = input.session?.changedFiles ?? [];
  const nextRows = codingReady ? reviewableReady ? [
    sessionFiles.length === 1 ? `Pending review \xB7 1 file \xB7 ${displaySessionPath(input.session, sessionFiles[0])}` : `Pending review \xB7 ${sessionFiles.length} files \xB7 ${displaySessionPath(input.session, sessionFiles[0])}`,
    'Next: zaraacoder "<task>"',
    input.sessionRef ? `Also: zaraacoder preview ${input.sessionRef} 1` : "Also: zaraacoder preview 1"
  ] : sessionPhase === "blocked" ? ["Next: zaraacoder handoff"] : input.session ? ["Next: zaraacoder list"] : ['Next: zaraacoder "your task"'] : [];
  const sessionFileHint = sessionFiles.length === 0 ? "" : sessionFiles.length === 1 ? ` \xB7 ${displaySessionPath(input.session, sessionFiles[0])}` : ` \xB7 ${sessionFiles.length} files \xB7 ${displaySessionPath(input.session, sessionFiles[0])}`;
  return [
    healthy ? "Doctor \xB7 all good" : "Doctor \xB7 needs attention",
    ...standalone ? ["  mode \xB7 standalone \xB7 CLI lanes only (daemon optional)"] : [],
    `  api key \xB7 ${input.snapshot.hasApiKey ? "ok" : standalone ? "n/a (standalone)" : "missing"}`,
    `  daemon \xB7 ${input.snapshot.daemonDetected ? "ok" : standalone ? "down (optional)" : "down"}`,
    `  port ${input.port} \xB7 ${input.snapshot.gatewayListenerCount > 0 ? "listening" : standalone ? "closed (optional)" : "closed"}`,
    ...input.standaloneCommandPath === void 0 ? [] : [`  command \xB7 ${input.standaloneCommandPath ? "linked" : "not linked"}`],
    ...(input.executorTimeoutRows ?? []).map(
      (row) => row.startsWith("Warning") ? `  ${row}` : `  ${row.replace(/^Executor timeout /, "timeout \xB7 ")}`
    ),
    input.session ? `  session \xB7 ${input.session.phase}${sessionFileHint}` : "  session \xB7 none",
    ...input.execLine ? [input.execLine] : [],
    ...input.standaloneCommandPath === null ? [
      `Link: cd ${shellQuote(input.cwd)} && rtk pnpm zaraacoder link`
    ] : [],
    ...nextRows.length ? nextRows : [
      "Next: launchctl kickstart -k gui/$(id -u)/com.zaraa.daemon",
      `Or: cd ${shellQuote(input.cwd)} && rtk pnpm dev:gateway`
    ]
  ];
}
function formatAttachGatewayUnavailable(port, error, cwd = process.cwd()) {
  return [
    `Zaraa gateway unavailable on port ${port}.`,
    "Start/restart daemon:",
    "launchctl kickstart -k gui/$(id -u)/com.zaraa.daemon",
    "Dev fallback:",
    `cd ${shellQuote(cwd)} && rtk pnpm dev:gateway`,
    "Then reopen:",
    `cd ${shellQuote(cwd)} && rtk pnpm --filter @zaraa/cli exec zaraa coder`,
    `Raw error: ${error}`
  ];
}
function resolveOpenTarget(session, input) {
  if (!input.sessionId) return { ok: false, error: "No active session." };
  const target = input.target?.trim().toLowerCase() || "artifact";
  if (target === "artifact") {
    return {
      ok: true,
      label: "artifact",
      target: `http://localhost:${input.port}/api/zaraacoder/sessions/${encodeURIComponent(input.sessionId)}/artifact`
    };
  }
  if (!session) return { ok: false, error: "No active session." };
  if (target === "worktree" && session.worktreePath) {
    return { ok: true, label: "worktree", target: session.worktreePath };
  }
  if (target === "repo" && session.repoPath) {
    return { ok: true, label: "repo", target: session.repoPath };
  }
  if (target === "trace" && session.tracePath) {
    return { ok: true, label: "trace", target: session.tracePath };
  }
  if (target === "worktree" || target === "repo" || target === "trace") {
    return { ok: false, error: `No ${target} target for this session.` };
  }
  return { ok: false, error: "Usage: /open [artifact|worktree|repo|trace]" };
}
function formatOpenResultLines(label, target, options = {}) {
  const surface = options.surface ?? "attach";
  const cli = surface === "standalone";
  const files = options.session?.changedFiles?.length ?? 0;
  const readyWithFiles = options.session?.phase === "ready" && files > 0;
  let next;
  if (label === "worktree" && readyWithFiles) {
    next = cli ? "Next: zaraacoder preview 1" : "Next: /preview 1";
  } else if (label === "repo") {
    next = cli ? "Next: zaraacoder changes" : "Next: /changes";
  } else if (label === "trace") {
    next = cli ? "Next: zaraacoder feed" : "Next: /feed";
  } else if (label === "artifact") {
    next = cli ? "Next: zaraacoder status" : "Next: /status";
  } else {
    next = cli ? "Next: zaraacoder status" : "Next: /status";
  }
  return [`Open \xB7 ${label}`, `  path \xB7 ${target}`, next];
}
async function openExternalTarget(target) {
  await execFileAsync("open", [target]);
}
function formatHotkeyHelp(session) {
  const files = session?.changedFiles?.length ?? 0;
  const phase = session?.phase?.toLowerCase() ?? "";
  if ((phase === "ready" || phase === "complete" || phase === "completed") && files > 0) {
    return "/p preview \xB7 /a accept \xB7 /u undo \xB7 / commands \xB7 /q quit";
  }
  if (phase === "blocked" || phase === "failed" || phase === "error") {
    return "/handoff \xB7 /continue \xB7 / commands \xB7 /q quit";
  }
  if (phase && phase !== "ready" && phase !== "cancelled" && phase !== "stopped") {
    return "/status \xB7 /feed \xB7 /stop \xB7 / commands \xB7 /q quit";
  }
  return "/new \xB7 / commands \xB7 /p preview \xB7 /r verify \xB7 /q quit";
}
var AGENT_LANES = ["auto", "codex", "claude", "grok", "local", "zero"];
function resolveAgentLane(value) {
  const lane = value.trim().toLowerCase();
  return AGENT_LANES.find((candidate) => candidate === lane) ?? null;
}
function formatModelSummary(dashboard, nextAgentLane, activeAgentLane, activeRoute) {
  const runRoute = activeRoute?.trim();
  const restart = dashboard && dashboard.executorRefresh !== "per-run" ? " \xB7 restart" : "";
  if (runRoute) {
    const next = nextAgentLane === "auto" ? dashboard?.primaryModel ? `auto ${dashboard.primaryModel}` : "auto" : `${nextAgentLane} strict`;
    return `\u2726 Run ${runRoute} \xB7 next ${next}${restart}`;
  }
  const runAgent = activeAgentLane?.trim().toLowerCase();
  if (runAgent && runAgent !== "auto") {
    const next = runAgent !== nextAgentLane ? ` \xB7 next ${nextAgentLane}` : "";
    return `\u2726 Run ${runAgent} \xB7 strict lane${next}`;
  }
  if (nextAgentLane !== "auto") return `\u2726 Next ${nextAgentLane} \xB7 strict lane`;
  if (!dashboard) return "\u2726 Next auto \xB7 routing loading";
  const sourceCount = (dashboard.providers ?? []).filter(
    (provider) => provider.zaraacoderEnabled
  ).length;
  const model = dashboard.primaryModel ? `pinned ${dashboard.primaryModel}` : `auto fallback ${dashboard.activeExecutorModel ?? "unknown"}`;
  return `\u2726 Next auto \xB7 ${model} \xB7 ${sourceCount} source${sourceCount === 1 ? "" : "s"}${restart}`;
}
function formatModelDashboardRows(dashboard) {
  const providers = dashboard.providers ?? [];
  const enabled = providers.filter((provider) => provider.zaraacoderEnabled);
  const pinLine = dashboard.primaryModel ? `  pin \xB7 ${dashboard.primaryModel}` : `  auto \xB7 fallback ${dashboard.activeExecutorModel ?? "unknown"}`;
  const refreshNote = dashboard.executorRefresh === "per-run" ? null : "  tip \xB7 restart daemon after route changes";
  return [
    "Models \xB7 routing",
    pinLine,
    `  sources \xB7 ${enabled.length} on \xB7 ${providers.length - enabled.length} off`,
    ...enabled.length ? enabled.map((provider) => {
      const models = provider.models.filter((model) => model.zaraacoderEnabled).map((model) => model.key);
      return `  \u2713 ${provider.name}${models.length ? ` \xB7 ${models.join(", ")}` : " \xB7 on"}`;
    }) : ["  \xD7 no enabled LLM sources"],
    ...refreshNote ? [refreshNote] : [],
    "  route \xB7 /agent <auto|codex|claude|grok|local|zero>",
    "  pin \xB7 /model <key|auto>",
    "Next: /agent auto   # or pin a lane"
  ];
}
function matchingSlashCommands(value) {
  const input = value.trimStart();
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const prefix = input.toLowerCase();
  const alias = COMMAND_ALIASES[prefix.slice(1)];
  if (alias) {
    const command = alias === "show" ? "/preview" : `/${alias}`;
    return SLASH_COMMANDS.filter((usage) => usage.split(" ", 1)[0] === command);
  }
  return SLASH_COMMANDS.filter((usage) => usage.split(" ", 1)[0]?.startsWith(prefix));
}
function formatSlashCommandMenu(value, limit = 5) {
  return matchingSlashCommands(value).slice(0, limit).map((usage) => {
    const command = usage.split(" ", 1)[0] ?? usage;
    return `${usage} \u2014 ${COMMAND_DESCRIPTIONS[command] ?? "command"}`;
  });
}
function completeSlashCommand(value) {
  const matches = matchingSlashCommands(value);
  if (matches.length !== 1) return value;
  const usage = matches[0] ?? value;
  const command = usage.split(" ", 1)[0] ?? usage;
  return usage.includes(" ") ? `${command} ` : command;
}
function formatInputHint(value, session) {
  const input = value.trim();
  if (!input) {
    const files = session?.changedFiles?.length ?? 0;
    const phase = session?.phase?.toLowerCase() ?? "";
    if ((phase === "ready" || phase === "complete" || phase === "completed") && files > 0) {
      return "Ready \xB7 /preview 1 \xB7 /accept 1 \xB7 /undo";
    }
    if (phase === "blocked" || phase === "failed" || phase === "error") {
      return "Blocked \xB7 /handoff \xB7 /continue <note>";
    }
    if (phase && phase !== "ready" && phase !== "cancelled" && phase !== "stopped") {
      return "Running \xB7 watch feed \xB7 /status \xB7 /stop";
    }
    return "Type a task \xB7 / commands \xB7 ! allowlisted shell";
  }
  if (input.startsWith("!")) return "Enter runs through Zaraacoder's command allowlist";
  if (!input.startsWith("/")) return "Enter starts the next task when this run is done";
  const matches = formatSlashCommandMenu(input, 3);
  return matches.length ? "Tab completes \xB7 Enter runs" : "Unknown command \xB7 /help";
}
function recallInputHistory(history, index, direction) {
  if (history.length === 0) return { index: null, value: "" };
  if (direction === "previous") {
    const nextIndex2 = index === null ? history.length - 1 : Math.max(0, index - 1);
    return { index: nextIndex2, value: history[nextIndex2] ?? "" };
  }
  if (index === null) return { index: null, value: "" };
  const nextIndex = index + 1;
  return nextIndex >= history.length ? { index: null, value: "" } : { index: nextIndex, value: history[nextIndex] ?? "" };
}
function parseZaraacoderAttachInput(value) {
  const input = value.trim();
  if (!input) return { kind: "noop" };
  if (!input.startsWith("/")) {
    if (input.startsWith("!")) {
      const command2 = input.slice(1).trim();
      return command2 ? { kind: "control", body: { action: "run_command", command: command2 } } : { kind: "error", message: "Usage: !<allowlisted command>" };
    }
    return { kind: "control", body: { action: "user_message", message: input } };
  }
  const body = input.slice(1).trim();
  const firstSpace = body.search(/\s/);
  const rawCommand = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const command = rawCommand === "accept" ? "apply" : rawCommand === "preview" ? "show" : COMMAND_ALIASES[rawCommand] ?? rawCommand;
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace).trim();
  switch (command) {
    case "actions":
    case "artifact":
    case "brief":
    case "changes":
    case "diff":
    case "doctor":
    case "feed":
    case "handoff":
    case "help":
    case "latest":
    case "models":
    case "quit":
    case "refresh":
    case "sessions":
    case "status":
    case "trace":
    case "undo":
    case "verify":
    case "where":
      return { kind: "local", command };
    case "agent":
    case "model":
      return rest ? { kind: "local", command, filePath: rest } : { kind: "local", command };
    case "apply":
      return rest ? { kind: "local", command: "apply", filePath: rest } : { kind: "local", command };
    case "promote":
      return rest ? { kind: "local", command: "promote", filePath: rest } : { kind: "local", command };
    case "copy":
      return rest ? { kind: "local", command: "copy", filePath: rest } : { kind: "error", message: "Usage: /copy brief|handoff|diff|promote [number]" };
    case "attach":
      return rest ? { kind: "local", command: "attach", sessionId: rest } : { kind: "error", message: "Usage: /attach <session-id|number>" };
    case "new":
      return rest ? { kind: "local", command: "new", task: rest } : { kind: "error", message: "Usage: /new <task>" };
    case "open":
      return rest ? { kind: "local", command: "open", filePath: rest } : { kind: "local", command };
    case "show":
      return rest || rawCommand === "p" || rawCommand === "preview" ? { kind: "local", command: "show", filePath: rest || "1" } : {
        kind: "error",
        message: `Usage: /${rawCommand === "preview" ? "preview <file|number>" : "show <file>"}`
      };
    case "continue":
      return { kind: "control", body: { action: "continue", ...rest ? { message: rest } : {} } };
    case "stop":
      return rest ? { kind: "error", message: "Usage: /stop" } : { kind: "control", body: { action: "stop" } };
    case "goal":
      return rest ? { kind: "control", body: { action: "set_goal", goal: rest } } : { kind: "error", message: "Usage: /goal <goal>" };
    case "run":
      return rest ? { kind: "control", body: { action: "run_command", command: rest } } : { kind: "error", message: "Usage: /run <command>" };
    case "test":
      return rest ? { kind: "control", body: { action: "run_command", command: rest } } : { kind: "error", message: "Usage: /test <command>" };
    default:
      return { kind: "error", message: `Unknown command "/${rawCommand}". Type /help.` };
  }
}
async function sendControl(port, sessionId, body) {
  return requestGatewayJson(
    port,
    `/api/zaraacoder/sessions/${encodeURIComponent(sessionId)}/control`,
    { method: "POST", body }
  );
}
async function loadSessionState(port, sessionId) {
  if (!sessionId) {
    return {
      ok: true,
      session: null,
      events: []
    };
  }
  const sessionResult = await fetchSession(port, sessionId);
  if (!sessionResult.ok) {
    return {
      ok: false,
      missing: sessionResult.status === 404,
      error: sessionResult.error ?? "Failed to load session"
    };
  }
  const traceResult = await fetchTrace(port, sessionId);
  return {
    ok: true,
    session: sessionResult.data?.session ?? null,
    events: traceResult.ok && traceResult.data?.events ? traceResult.data.events.map(normalizeTerminalEvent).slice(-40) : null
  };
}
function formatSessionStatus(session) {
  if (!session) return ["No session loaded."];
  const files = session.changedFiles ?? [];
  const phase = session.phase === "ready" && files.length === 0 ? "stored" : session.phase;
  const pathHint = files.length === 0 ? "" : files.length === 1 ? ` \xB7 ${displaySessionPath(session, files[0])}` : ` \xB7 ${files.length} files \xB7 ${displaySessionPath(session, files[0])}`;
  return [
    `Status \xB7 ${phase}${pathHint}`,
    `  task \xB7 ${session.task}`,
    session.goal ? `  goal \xB7 ${session.goal}` : null,
    session.branchName ? `  branch \xB7 ${session.branchName}` : null,
    session.worktreePath ? `  worktree \xB7 ${session.worktreePath}` : null,
    `  id \xB7 ${session.sessionId}`,
    session.tracePath ? `  trace \xB7 ${session.tracePath}` : null
  ].filter((line) => Boolean(line));
}
function formatHandoff(session, events) {
  if (!session) return ["No session loaded."];
  const reviewStatus = session.phase === "ready" || session.phase === "blocked" || session.phase === "failed" ? session.phase : null;
  const lines = formatHandoffLines(
    {
      sessionId: session.sessionId,
      task: session.task,
      repoPath: session.repoPath ?? ".",
      goal: session.goal,
      phase: session.phase,
      branchName: session.branchName ?? null,
      worktreePath: session.worktreePath ?? null,
      tracePath: session.tracePath ?? "",
      reviewStatus,
      changedFiles: session.changedFiles ?? [],
      handoffSummary: session.handoffSummary,
      handoffRisks: session.handoffRisks,
      createdAt: "",
      updatedAt: ""
    },
    session.sessionId
  );
  const recent = events.slice(-3).map((event) => formatEventRow(event)).filter(Boolean);
  if (recent.length) {
    lines.push("Recent:");
    lines.push(...recent);
  }
  return lines;
}
function formatSessionRows(sessions) {
  if (!sessions.length) return ["List \xB7 empty", "Next: /new <task>"];
  const visibleSessions = sessions.slice(0, 5);
  return [
    ...visibleSessions.map((session, index) => {
      const files = session.changedFiles ?? [];
      const changed = files.length === 0 ? "" : files.length === 1 ? ` \xB7 ${displaySessionPath(session, files[0])}` : ` \xB7 ${files.length} files \xB7 ${displaySessionPath(session, files[0])}`;
      return `${index + 1}. ${session.phase} ${session.task}${changed} -> /attach ${index + 1}`;
    }),
    ...sessions.length > visibleSessions.length ? [`More: zaraacoder sessions --limit ${sessions.length}`] : []
  ];
}
function formatDiffRows(session) {
  if (!session) return ["No session loaded."];
  const changedFiles = session.changedFiles ?? [];
  return changedFiles.length ? [
    "Changed files:",
    ...changedFiles.map(
      (file, index) => `${index + 1}. ${displaySessionPath(session, file)}`
    )
  ] : ["No recorded edits."];
}
function formatAttachPreviewNext(session, fileArg) {
  if (!session) return "Next: /sessions";
  if (!canAcceptSession(session)) {
    return session.phase === "cancelled" ? "Next: /new <task>  # dismissed" : "Next: /status";
  }
  const files = session.changedFiles ?? [];
  if (!files.length) return "Next: /new <task>";
  let selectedIndex = -1;
  if (/^[1-9]\d*$/.test(fileArg)) {
    selectedIndex = Number.parseInt(fileArg, 10) - 1;
  } else {
    selectedIndex = files.findIndex((changedFile) => {
      const rel = displaySessionPath(session, changedFile);
      return rel === fileArg || changedFile === fileArg || changedFile.endsWith(`/${fileArg}`) || rel.endsWith(`/${fileArg}`);
    });
  }
  if (selectedIndex < 0 || selectedIndex >= files.length) {
    return "Next: /accept 1";
  }
  const acceptCmd = `/accept ${selectedIndex + 1}`;
  const remainingAfter = files.length - selectedIndex - 1;
  if (remainingAfter <= 0) return `Next: ${acceptCmd}`;
  const nextPath = displaySessionPath(session, files[selectedIndex + 1]);
  const previewCmd = `/preview ${selectedIndex + 2}`;
  const more = remainingAfter === 1 ? `or: ${previewCmd} \xB7 ${nextPath}` : `or: ${previewCmd} \xB7 ${nextPath} (${remainingAfter} more)`;
  return `Next: ${acceptCmd}   # ${more}`;
}
async function formatDiffPatchRows(session, readPatch = readSessionDiffPatch) {
  if (!session) return ["No session loaded."];
  const changedFiles = session.changedFiles ?? [];
  if (!changedFiles.length) return ["No recorded edits."];
  const patch = await readPatch(session);
  if (!patch?.trim()) return formatDiffRows(session);
  const first = displaySessionPath(session, changedFiles[0]);
  const multi = changedFiles.length > 1 ? ` \xB7 ${changedFiles.length} files \xB7 ${first}` : ` \xB7 ${first}`;
  return [
    "Patch:",
    ...clippedPatchLines(patch.trimEnd()),
    `Next: /preview 1${multi}  \xB7  /accept 1  \xB7  /undo`
  ];
}
async function readSessionDiffPatch(session) {
  if (!session.repoPath || !session.worktreePath || !session.changedFiles?.length) return null;
  const chunks = [];
  for (const file of session.changedFiles) {
    const relativePath = displaySessionPath(session, file);
    const repoFile = join(session.repoPath, relativePath);
    const worktreeFile = join(session.worktreePath, relativePath);
    const repoExists = await pathExists(repoFile);
    const worktreeExists = await pathExists(worktreeFile);
    if (!repoExists && !worktreeExists) continue;
    try {
      const { stdout } = await execFileAsync("git", [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        repoExists ? repoFile : "/dev/null",
        worktreeExists ? worktreeFile : "/dev/null"
      ]);
      if (stdout.trim())
        chunks.push(cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile).trimEnd());
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      if (stdout.trim())
        chunks.push(cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile).trimEnd());
    }
  }
  return chunks.join("\n") || null;
}
function displaySessionPath(session, filePath) {
  if (!session.worktreePath) return filePath;
  const sourcePath = isAbsolute(filePath) ? filePath : join(session.worktreePath, filePath);
  return relative(session.worktreePath, sourcePath) || filePath;
}
function cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile) {
  return stdout.split(`a${repoFile}`).join(`a/${relativePath}`).split(`b${repoFile}`).join(`a/${relativePath}`).split(`a${worktreeFile}`).join(`a/${relativePath}`).split(`b${worktreeFile}`).join(`b/${relativePath}`).split(repoFile).join(`a/${relativePath}`).split(worktreeFile).join(`b/${relativePath}`);
}
function clippedPatchLines(patch, limit = 220) {
  const lines = patch.split(/\r?\n/);
  return lines.length > limit ? [...lines.slice(0, limit), `... truncated ${lines.length - limit} line(s)`] : lines;
}
function formatGitStatusLine(line) {
  const raw = line.replace(/\t/g, " ");
  const match = /^(.)(.)\s+(.*)$/.exec(raw);
  if (!match) return `  \xB7 ${raw.trim()}`;
  const x = match[1] ?? " ";
  const y = match[2] ?? " ";
  const path = match[3] ?? "";
  const untracked = x === "?" || y === "?";
  const deleted = x === "D" || y === "D";
  const added = x === "A" || y === "A";
  const glyph = untracked ? "+" : deleted ? "\u2212" : added ? "+" : "~";
  const code = `${x}${y}`.replace(/ /g, "").trim();
  return code ? `  ${glyph} ${path}  (${code})` : `  ${glyph} ${path}`;
}
function formatGitStatusRows(repoPath, lines, limit = 20) {
  const visible = lines.slice(0, limit);
  const n = lines.length;
  const header = n === 0 ? "Changes \xB7 clean" : n === 1 ? "Changes \xB7 1 path" : `Changes \xB7 ${n} paths`;
  return [
    header,
    ...visible.length ? visible.map(formatGitStatusLine) : ["  (no tracked edits)"],
    ...lines.length > visible.length ? [`  \u2026 +${lines.length - visible.length} more`] : [],
    `  repo \xB7 ${repoPath}`
  ];
}
function formatVerifyRows(input) {
  return [
    input.ok ? "Verify \xB7 clean" : "Verify \xB7 failed",
    `  repo \xB7 ${input.repoPath}`,
    input.ok ? "  git diff --check passed" : "  git diff --check failed",
    ...!input.ok && input.error.trim() ? [`  ${input.error.trim()}`] : []
  ];
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function commandErrorMessage(error) {
  if (typeof error === "object" && error !== null) {
    const maybe = error;
    if (typeof maybe.stderr === "string" && maybe.stderr.trim()) return maybe.stderr.trim();
    if (typeof maybe.stdout === "string" && maybe.stdout.trim()) return maybe.stdout.trim();
    if (typeof maybe.message === "string" && maybe.message.trim()) return maybe.message.trim();
  }
  return String(error);
}
function isInside(basePath, path) {
  const rel = relative(basePath, path);
  return rel === "" || !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
function formatPromoteRows(session, filePath) {
  if (!session) return ["No session loaded."];
  if (!session.repoPath || !session.worktreePath)
    return ["Promote unavailable: missing repo or worktree path."];
  let changedFiles = session.changedFiles ?? [];
  if (!changedFiles.length) return ["No recorded edits."];
  if (filePath && /^[1-9]\d*$/.test(filePath)) {
    const index = Number.parseInt(filePath, 10) - 1;
    const selected = changedFiles[index];
    if (!selected) return [`No changed file at index ${filePath}.`];
    changedFiles = [selected];
  }
  const n = changedFiles.length;
  const rows = [
    n === 1 ? "Promote \xB7 1 file (manual)" : `Promote \xB7 ${n} files (manual)`,
    "  prefer \xB7 zaraacoder accept when review is ready",
    `cd ${shellQuote(session.repoPath)}`
  ];
  for (const file of changedFiles) {
    const sourcePath = isAbsolute(file) ? file : join(session.worktreePath, file);
    if (!isInside(session.worktreePath, sourcePath)) {
      rows.push(`Skip outside worktree: ${file}`);
      continue;
    }
    const relativePath = relative(session.worktreePath, sourcePath);
    const targetPath = join(session.repoPath, relativePath);
    rows.push(
      `mkdir -p ${shellQuote(dirname(targetPath))} && cp ${shellQuote(sourcePath)} ${shellQuote(targetPath)}`
    );
  }
  rows.push("Then: git diff --check");
  rows.push("Next: zaraacoder accept 1   # preferred over promote when safe");
  return rows;
}
function formatCopyRows(session, target, context = {}) {
  const [command, filePath] = target.trim().split(/\s+/, 2);
  if (!command || !["brief", "handoff", "diff", "promote"].includes(command)) {
    return { ok: false, error: "Usage: /copy brief|handoff|diff|promote [number]" };
  }
  const rows = command === "promote" ? formatPromoteRows(session, filePath) : command === "brief" ? formatOperatorBrief(session, context.events ?? [], {
    port: context.port ?? 0,
    sessionId: context.sessionId ?? session?.sessionId ?? ""
  }) : command === "handoff" ? formatHandoff(session, context.events ?? []) : formatDiffRows(session);
  if (command === "promote" && (rows.length === 0 || !String(rows[0] ?? "").startsWith("Promote \xB7"))) {
    return { ok: false, error: rows[0] ?? "Nothing to copy." };
  }
  return {
    ok: true,
    label: command,
    text: (command === "promote" ? rows.slice(1) : rows).map(
      (row) => row === "Then: git diff --check" || row === "Then run: git diff --check" ? "git diff --check" : row
    ).join("\n")
  };
}
function formatAcceptPlanFailRows(kind, detail) {
  switch (kind) {
    case "no-session":
      return ["Accept \xB7 no session", 'Next: zaraacoder list | zaraacoder "<task>"'];
    case "no-worktree":
      return ["Accept \xB7 no worktree", "Next: zaraacoder status | zaraacoder doctor"];
    case "no-edits":
      return ["Accept \xB7 no edits", 'Next: zaraacoder status | zaraacoder "<task>"'];
    case "usage":
      return ["Accept \xB7 usage \xB7 number or all", "Next: zaraacoder accept 1 | zaraacoder accept all"];
    case "bad-index":
      return [
        `Accept \xB7 no file at index ${detail?.index ?? "?"}`,
        "Next: zaraacoder status | zaraacoder list"
      ];
    case "no-files":
      return [
        "Accept \xB7 no files",
        ...detail?.skipped ?? [],
        "Next: zaraacoder status | zaraacoder promote 1"
      ];
    case "outside":
      return [
        "Accept \xB7 outside worktree",
        ...detail?.skipped ?? [],
        "Next: zaraacoder status | zaraacoder promote 1"
      ];
    case "dirty": {
      const paths = detail?.paths ?? [];
      return [
        "Accept \xB7 blocked \xB7 dirty",
        ...paths.map((relativePath, index) => `  ${index + 1}. ${relativePath}`),
        "  tip \xB7 promote copies manually when main has local edits",
        "Next: zaraacoder promote 1 | zaraacoder changes"
      ];
    }
    default:
      return ["Accept \xB7 blocked", "Next: zaraacoder status"];
  }
}
function resolveApplyOperations(session, filePath, dirtyPaths = /* @__PURE__ */ new Set()) {
  if (!session) return { ok: false, rows: formatAcceptPlanFailRows("no-session") };
  if (!session.repoPath || !session.worktreePath) {
    return { ok: false, rows: formatAcceptPlanFailRows("no-worktree") };
  }
  let changedFiles = session.changedFiles ?? [];
  if (!changedFiles.length) return { ok: false, rows: formatAcceptPlanFailRows("no-edits") };
  if (filePath) {
    if (!/^[1-9]\d*$/.test(filePath)) return { ok: false, rows: formatAcceptPlanFailRows("usage") };
    const index = Number.parseInt(filePath, 10) - 1;
    const selected = changedFiles[index];
    if (!selected) {
      return { ok: false, rows: formatAcceptPlanFailRows("bad-index", { index: filePath }) };
    }
    changedFiles = [selected];
  }
  const operations = [];
  const skipped = [];
  for (const file of changedFiles) {
    const sourcePath = isAbsolute(file) ? file : join(session.worktreePath, file);
    if (!isInside(session.worktreePath, sourcePath)) {
      skipped.push(`Skip outside worktree: ${file}`);
      continue;
    }
    const relativePath = relative(session.worktreePath, sourcePath);
    operations.push({
      relativePath,
      sourcePath,
      targetPath: join(session.repoPath, relativePath)
    });
  }
  if (!operations.length) {
    return {
      ok: false,
      rows: formatAcceptPlanFailRows(skipped.length ? "outside" : "no-files", {
        skipped
      })
    };
  }
  const dirtyTargets = operations.map((operation) => operation.relativePath).filter((relativePath) => dirtyPaths.has(relativePath));
  if (dirtyTargets.length) {
    return {
      ok: false,
      rows: formatAcceptPlanFailRows("dirty", { paths: dirtyTargets })
    };
  }
  return { ok: true, operations, skipped };
}
function formatApplyResultRows(input) {
  return [
    ...input.skipped,
    `Applied ${input.appliedCount} file(s).`,
    ...(input.appliedFiles ?? []).map((file, index) => `${index + 1}. ${file}`),
    input.verify.ok ? "Verified repo: git diff --check passed." : `Verify failed: ${input.verify.error}`
  ];
}
function formatAttachApplyFollowUp(input) {
  const files = input.appliedCount === 1 ? "1 file" : `${input.appliedCount} files`;
  const remaining = input.remainingFiles ?? [];
  const next = remaining.length > 0 ? remaining.length === 1 ? `Next: /accept 1   # 1 file still pending \xB7 ${remaining[0]} (or: /accept all)` : `Next: /accept 1   # ${remaining.length} files still pending \xB7 ${remaining[0]} (or: /accept all)` : "Next: /verify   (undo if needed: /undo)";
  return [`\u2726 Landed ${files} \xB7 undo anytime: /undo`, next];
}
function attachUndoRoot(repoPath) {
  return join(
    resolveRuntimeHomeDir(),
    ".zaraa",
    "zaraacoder",
    "undo",
    Buffer.from(resolve(repoPath)).toString("base64url")
  );
}
function attachUndoRecordPath(repoPath) {
  return join(attachUndoRoot(repoPath), "last.json");
}
async function writeAttachUndoRecord(input) {
  const repoPath = resolve(input.repoPath);
  const backupRoot = join(attachUndoRoot(repoPath), input.sessionId ?? "latest");
  await input.makeDirectory(backupRoot);
  const files = [];
  for (const [index, operation] of input.operations.entries()) {
    const existed = await input.pathExists(operation.targetPath);
    const file = {
      relativePath: operation.relativePath,
      targetPath: operation.targetPath,
      existed
    };
    if (existed) {
      file.backupPath = join(backupRoot, `${index + 1}.bak`);
      await input.copyFile(operation.targetPath, file.backupPath);
    }
    files.push(file);
  }
  await input.writeTextFile(
    attachUndoRecordPath(repoPath),
    `${JSON.stringify({ repoPath, sessionId: input.sessionId, files }, null, 2)}
`
  );
}
async function restoreAttachUndoRecord(input) {
  const repoPath = resolve(input.repoPath);
  const recordPath = attachUndoRecordPath(repoPath);
  const record = parseAttachUndoRecord(await input.readTextFile(recordPath));
  if (!record || resolve(record.repoPath) !== repoPath || record.files.length === 0) {
    return ["Undo unavailable: no accepted patch recorded."];
  }
  for (const file of record.files) {
    if (file.existed) {
      if (!file.backupPath) return [`Undo unavailable: missing backup for ${file.relativePath}.`];
      await input.makeDirectory(dirname(file.targetPath));
      await input.copyFile(file.backupPath, file.targetPath);
    } else {
      await input.removePath(file.targetPath);
    }
  }
  await input.verifyRepoDiff(repoPath);
  await input.removePath(recordPath);
  return [
    `Undid ${record.files.length} file(s).`,
    ...record.files.map((file, index) => `${index + 1}. ${file.relativePath}`),
    "Verified repo: git diff --check passed.",
    "\u21BA Restored \xB7 review with /preview 1 (or /changes)",
    "Next: /changes | /verify"
  ];
}
function parseAttachUndoRecord(raw) {
  try {
    const data = JSON.parse(raw);
    if (typeof data.repoPath !== "string" || !Array.isArray(data.files)) return null;
    const files = [];
    for (const file of data.files) {
      if (!file || typeof file.relativePath !== "string" || typeof file.targetPath !== "string" || typeof file.existed !== "boolean")
        return null;
      files.push({
        relativePath: file.relativePath,
        targetPath: file.targetPath,
        existed: file.existed,
        ...typeof file.backupPath === "string" ? { backupPath: file.backupPath } : {}
      });
    }
    return {
      repoPath: data.repoPath,
      ...typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {},
      files
    };
  } catch {
    return null;
  }
}
async function dirtyApplyTargets(repoPath, operations) {
  const dirty = /* @__PURE__ */ new Set();
  for (const operation of operations) {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "status",
      "--porcelain",
      "--",
      operation.relativePath
    ]);
    if (stdout.trim()) dirty.add(operation.relativePath);
  }
  return dirty;
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function resolveShowFilePath(session, filePath) {
  if (!session?.worktreePath) return null;
  const index = /^[1-9]\d*$/.test(filePath) ? Number.parseInt(filePath, 10) - 1 : null;
  const selectedPath = index === null ? filePath : session.changedFiles?.[index];
  if (!selectedPath) return null;
  const sourcePath = isAbsolute(selectedPath) ? selectedPath : join(session.worktreePath, selectedPath);
  return isInside(session.worktreePath, sourcePath) ? sourcePath : null;
}
function resolveAttachPreview(session, filePath) {
  if (session && !isActionableSession(session)) {
    return {
      ok: false,
      notice: (previewBlockedReason(session) ?? "Preview blocked.").replace(
        /; start a new task\.?$/i,
        "."
      )
    };
  }
  const resolvedPath = resolveShowFilePath(session, filePath);
  if (!resolvedPath) {
    return { ok: false, notice: "Show unavailable: file must be inside session worktree." };
  }
  return { ok: true, resolvedPath };
}
function formatShowFilePreview(filePath, content, maxChars = 4e3) {
  const clipped = content.length > maxChars;
  const preview = clipped ? content.slice(0, maxChars) : content;
  const lines = preview ? preview.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  return [
    `Preview ${filePath}:`,
    ...lines,
    ...clipped ? [`... clipped ${content.length - maxChars} chars`] : []
  ];
}
function buildStartSessionBody(input) {
  return {
    task: input.task,
    repoPath: input.session?.repoPath ?? input.fallbackRepoPath,
    ...input.session?.goal ? { goal: input.session.goal } : {},
    ...input.agentLane ? { agent: input.agentLane } : {}
  };
}
function buildNoSessionStartBody(input, fallbackRepoPath) {
  return buildPromptStartBody(input, null, "", fallbackRepoPath);
}
function buildPromptStartBody(input, session, activeSessionId, fallbackRepoPath, agentLane) {
  if (input.kind !== "control" || input.body.action !== "user_message") return null;
  if (activeSessionId && (!session || !isSettledZaraacoderPhase(session.phase))) return null;
  return buildStartSessionBody({ session, task: input.body.message, fallbackRepoPath, agentLane });
}
function queuedSteeringMessage(input, session) {
  return input.kind === "control" && input.body.action === "user_message" && session && !isSettledZaraacoderPhase(session.phase) ? input.body.message : null;
}
function hasPendingSteering(message, sending) {
  return Boolean(message) || sending;
}
function resolveInitialAttachSessionId(sessionId, sessions, repoPath = process.cwd()) {
  if (sessionId !== "latest") return sessionId;
  const matchingRepo = sessions.filter((session) => session.repoPath === repoPath);
  const prioritized = prioritizeActionableSessions(matchingRepo.length ? matchingRepo : sessions);
  return prioritized[0]?.sessionId ?? null;
}
function resolveAttachSessionId(sessionId, sessions) {
  if (!/^[1-9]\d*$/.test(sessionId)) return sessionId;
  return sessions[Number.parseInt(sessionId, 10) - 1]?.sessionId ?? null;
}
function AttachView({ port, sessionId }) {
  const { exit } = useApp();
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [input, setInput] = useState("");
  const [inputHistory, setInputHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [notices, setNotices] = useState([]);
  const [animationFrame, setAnimationFrame] = useState(0);
  const [modelDashboard, setModelDashboard] = useState(null);
  const [nextAgentLane, setNextAgentLane] = useState("auto");
  const [showThinking, setShowThinking] = useState(true);
  const [streamStatus, setStreamStatus] = useState("connecting");
  const [queuedMessage, setQueuedMessage] = useState(null);
  const sendingQueuedMessage = useRef(false);
  const seenStreamEventIds = useRef(/* @__PURE__ */ new Set());
  useInput((typed, key) => {
    if (key.ctrl && typed === "c") {
      if (input) {
        setInput("");
        setHistoryIndex(null);
        return;
      }
      exit();
      return;
    }
    if (key.ctrl && typed === "t") {
      setShowThinking((current) => !current);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const recalled = recallInputHistory(
        inputHistory,
        historyIndex,
        key.upArrow ? "previous" : "next"
      );
      setHistoryIndex(recalled.index);
      setInput(recalled.value);
      return;
    }
    if (key.tab) {
      setInput(completeSlashCommand(input));
    }
  });
  const working = Boolean(session && !isSettledZaraacoderPhase(session.phase));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setAnimationFrame((frame) => frame + 1), 120);
    return () => clearInterval(timer);
  }, [working]);
  const pushNotice = useCallback((...lines) => {
    const nextLines = lines.map((line) => ({
      id: `${Date.now()}-${nextNoticeId++}`,
      line
    }));
    setNotices((current) => trimNoticeRows(current, nextLines));
  }, []);
  const refreshModelDashboard = useCallback(async () => {
    const result = await loadModelsDashboard(port, "zaraacoder");
    if (result.ok && result.data) setModelDashboard(result.data);
    return result;
  }, [port]);
  useEffect(() => {
    void refreshModelDashboard();
  }, [refreshModelDashboard]);
  const applyLoadedState = useCallback((loaded) => {
    if (!loaded.ok) {
      setError(loaded.error);
      if (loaded.missing) {
        setActiveSessionId("");
        setSession(null);
        setEvents([]);
      }
      return false;
    }
    setSession(loaded.session);
    setError(null);
    return true;
  }, []);
  const refreshSession = useCallback(
    async (nextSessionId = activeSessionId) => {
      const loaded = await loadSessionState(port, nextSessionId);
      applyLoadedState(loaded);
      return loaded;
    },
    [activeSessionId, applyLoadedState, port]
  );
  useEffect(() => {
    if (!queuedMessage || !activeSessionId || !session || !isSettledZaraacoderPhase(session.phase) || sendingQueuedMessage.current) return;
    sendingQueuedMessage.current = true;
    void (async () => {
      try {
        const result = await sendControl(port, activeSessionId, {
          action: "user_message",
          message: queuedMessage
        });
        if (!result.ok) {
          pushNotice(
            "Steer \xB7 failed",
            result.error ?? "could not send queued message",
            "Next: /status \xB7 /continue"
          );
        } else {
          pushNotice("Steer \xB7 sent", ...formatControlResultRows(result.data?.event));
        }
        await refreshSession();
      } finally {
        sendingQueuedMessage.current = false;
        setQueuedMessage((current) => current === queuedMessage ? null : current);
      }
    })();
  }, [activeSessionId, port, pushNotice, queuedMessage, refreshSession, session]);
  useEffect(() => {
    seenStreamEventIds.current = /* @__PURE__ */ new Set();
    if (!activeSessionId) {
      setStreamStatus("closed");
      return;
    }
    const unsubscribe = subscribeZaraacoderTerminalStream(port, activeSessionId, {
      onEvent: (streamEvent) => {
        const flattened = flattenTerminalStreamEvent(streamEvent);
        if (seenStreamEventIds.current.has(flattened.id)) return;
        seenStreamEventIds.current.add(flattened.id);
        if ((streamEvent.kind === "session" || streamEvent.kind === "done") && streamEvent.data?.session) {
          setSession(streamEvent.data.session);
        }
        setEvents((current) => [...current, flattened]);
      },
      onStatus: (status) => setStreamStatus(status),
      onError: (message) => setError(message)
    });
    return unsubscribe;
  }, [port, activeSessionId]);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const loaded = await loadSessionState(port, activeSessionId);
      if (cancelled) return;
      applyLoadedState(loaded);
      timer = setTimeout(() => {
        void poll();
      }, zaraacoderAttachPollMs(loaded));
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [port, activeSessionId, applyLoadedState]);
  const header = useMemo(() => {
    if (!session) {
      return activeSessionId ? "Attach \xB7 connecting\u2026" : "Attach \xB7 idle \xB7 type a task";
    }
    return session.task;
  }, [session, activeSessionId]);
  const runLocalCommand = async (parsed) => {
    const { command } = parsed;
    if (command === "help") {
      pushNotice("Help \xB7 commands", ...formatHelpLines());
      return;
    }
    if (command === "agent") {
      if (!parsed.filePath) {
        pushNotice(
          `Agent \xB7 next ${nextAgentLane}`,
          "  choices \xB7 auto \xB7 codex \xB7 claude \xB7 grok \xB7 local \xB7 zero"
        );
        return;
      }
      const lane = resolveAgentLane(parsed.filePath);
      if (!lane) {
        pushNotice("Usage: /agent <auto|codex|claude|grok|local|zero>");
        return;
      }
      setNextAgentLane(lane);
      pushNotice(
        `Agent \xB7 set \xB7 ${lane}`,
        lane === "auto" ? "  auto \xB7 Zaraa picks the best route" : `  strict \xB7 ${lane} (failures stay visible)`
      );
      return;
    }
    if (command === "models") {
      const result = await refreshModelDashboard();
      if (!result.ok || !result.data) {
        pushNotice(
          "Models \xB7 unavailable",
          result.error ?? "unknown error",
          "Next: /doctor"
        );
        return;
      }
      pushNotice(...formatModelDashboardRows(result.data));
      return;
    }
    if (command === "model") {
      const key = parsed.filePath?.trim();
      if (!key) {
        pushNotice("Usage: /model <key|auto>", "Use /models to see enabled model keys.");
        return;
      }
      const model = key.toLowerCase() === "auto" ? null : key;
      const result = await pinZaraacoderModel(port, model);
      if (!result.ok) {
        pushNotice(
          "Model \xB7 pin failed",
          result.data?.error ?? result.error ?? "unknown error",
          "Next: /models"
        );
        return;
      }
      const refreshed = await refreshModelDashboard();
      pushNotice(
        `Model \xB7 ${result.data?.primaryModel ?? "auto"}`,
        refreshed.data?.executorRefresh === "per-run" ? "  applies to new auto-agent runs" : "  restart daemon before the next auto-agent run"
      );
      return;
    }
    if (command === "actions") {
      pushNotice("Actions \xB7 deck", ...formatActionDeck(session));
      return;
    }
    if (command === "brief") {
      const loaded = await refreshSession();
      const briefSession = loaded.ok ? loaded.session : session;
      const briefEvents = loaded.ok && loaded.events ? loaded.events : events;
      pushNotice(
        ...formatOperatorBrief(briefSession, briefEvents, { port, sessionId: activeSessionId })
      );
      return;
    }
    if (command === "attach") {
      let nextSessionId = parsed.sessionId;
      if (!nextSessionId) {
        pushNotice("Usage: /attach <session-id>");
        return;
      }
      if (/^[1-9]\d*$/.test(nextSessionId)) {
        const list2 = await fetchSessions(port);
        if (!list2.ok || !list2.data?.sessions) {
          pushNotice(list2.error ?? "Failed to load sessions.");
          return;
        }
        const resolvedSessionId = resolveAttachSessionId(nextSessionId, list2.data.sessions);
        if (!resolvedSessionId) {
          pushNotice(`Attach \xB7 no session at index ${nextSessionId}`, "Next: /sessions");
          return;
        }
        nextSessionId = resolvedSessionId;
      }
      setActiveSessionId(nextSessionId);
      setSession(null);
      setEvents([]);
      pushNotice(`Attach \xB7 ${nextSessionId.slice(0, 8)}`);
      await refreshSession(nextSessionId);
      return;
    }
    if (command === "new") {
      const task = parsed.task;
      if (!task) {
        pushNotice("Usage: /new <task>");
        return;
      }
      const result = await startSession(
        port,
        buildStartSessionBody({
          session: null,
          task,
          fallbackRepoPath: session?.repoPath ?? process.cwd(),
          agentLane: nextAgentLane
        })
      );
      const nextSession = result.data?.session;
      if (!result.ok || !nextSession) {
        pushNotice(
          "Start \xB7 failed",
          result.error ?? "could not create session",
          "Next: /doctor \xB7 /sessions"
        );
        return;
      }
      setActiveSessionId(nextSession.sessionId);
      setSession(nextSession);
      setEvents([]);
      pushNotice(
        `Start \xB7 ${nextSession.sessionId.slice(0, 8)}`,
        `  task \xB7 ${task.slice(0, 56)}`,
        "Next: watch feed \xB7 /status"
      );
      await refreshSession(nextSession.sessionId);
      return;
    }
    if (command === "quit") {
      exit();
      return;
    }
    if (command === "feed") {
      const loaded = await refreshSession();
      const feedSession = loaded.ok ? loaded.session : session;
      const phase = feedSession?.phase === "ready" && (feedSession.changedFiles?.length ?? 0) === 0 ? "stored" : feedSession?.phase ?? "none";
      const pathHint = feedSession && (feedSession.changedFiles?.length ?? 0) > 0 ? briefPathHint(feedSession) : "";
      pushNotice(
        `Feed \xB7 ${phase}${pathHint}`,
        ...formatFeedRows(loaded.ok && loaded.events ? loaded.events : events)
      );
      return;
    }
    if (command === "refresh" || command === "trace") {
      const loaded = await refreshSession();
      pushNotice(
        loaded.ok ? command === "trace" ? "Trace \xB7 refreshed" : "Session \xB7 refreshed" : loaded.error
      );
      return;
    }
    if (command === "status") {
      const loaded = await refreshSession();
      pushNotice(...formatSessionStatus(loaded.ok ? loaded.session : session));
      return;
    }
    if (command === "where") {
      const loaded = await refreshSession();
      pushNotice(...formatWhereRows(loaded.ok ? loaded.session : session, process.cwd()));
      return;
    }
    if (command === "verify") {
      const loaded = await refreshSession();
      const verifySession = loaded.ok ? loaded.session : session;
      const repoPath = verifySession?.repoPath ?? process.cwd();
      try {
        await execFileAsync("git", ["-C", repoPath, "diff", "--check"]);
        pushNotice(...formatVerifyRows({ repoPath, ok: true }));
      } catch (error2) {
        pushNotice(
          ...formatVerifyRows({
            repoPath,
            ok: false,
            error: commandErrorMessage(error2)
          })
        );
      }
      return;
    }
    if (command === "doctor") {
      const [loaded, snapshot] = await Promise.all([
        refreshSession(),
        collectGatewayAccessSnapshot(port)
      ]);
      pushNotice(
        ...formatDoctorRows({
          session: loaded.ok ? loaded.session : session,
          port,
          cwd: process.cwd(),
          snapshot
        })
      );
      return;
    }
    if (command === "handoff") {
      const loaded = await refreshSession();
      pushNotice(
        ...formatHandoff(
          loaded.ok ? loaded.session : session,
          loaded.ok && loaded.events ? loaded.events : events
        )
      );
      return;
    }
    if (command === "artifact") {
      pushNotice(
        `Artifact: http://localhost:${port}/api/zaraacoder/sessions/${encodeURIComponent(activeSessionId)}/artifact`
      );
      return;
    }
    if (command === "open") {
      const loaded = await refreshSession();
      const resolved = resolveOpenTarget(loaded.ok ? loaded.session : session, {
        port,
        sessionId: activeSessionId,
        target: parsed.filePath
      });
      if (!resolved.ok) {
        pushNotice(resolved.error);
        return;
      }
      try {
        await openExternalTarget(resolved.target);
        pushNotice(
          ...formatOpenResultLines(resolved.label, resolved.target, {
            session: loaded.ok ? loaded.session : session,
            surface: "attach"
          })
        );
      } catch (error2) {
        pushNotice(`Open failed: ${error2 instanceof Error ? error2.message : String(error2)}`);
      }
      return;
    }
    if (command === "diff") {
      const loaded = await refreshSession();
      pushNotice(...await formatDiffPatchRows(loaded.ok ? loaded.session : session));
      return;
    }
    if (command === "changes") {
      const loaded = await refreshSession();
      const changesSession = loaded.ok ? loaded.session : session;
      const repoPath = changesSession?.repoPath ?? process.cwd();
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", repoPath, "status", "--short", "--untracked-files=no"],
          { timeout: 4e3, maxBuffer: 2 * 1024 * 1024 }
        );
        pushNotice(...formatGitStatusRows(repoPath, stdout.split(/\r?\n/).filter(Boolean)));
      } catch (error2) {
        pushNotice(`Changes failed: ${commandErrorMessage(error2)}`);
      }
      return;
    }
    if (command === "copy") {
      const loaded = await refreshSession();
      const copyRows = formatCopyRows(loaded.ok ? loaded.session : session, parsed.filePath ?? "", {
        events: loaded.ok && loaded.events ? loaded.events : events,
        port,
        sessionId: activeSessionId
      });
      if (!copyRows.ok) {
        pushNotice(copyRows.error);
        return;
      }
      try {
        await copyTextToClipboard(copyRows.text);
        pushNotice(
          `Copy \xB7 ${copyRows.label}${copyRows.label === "promote" ? " commands" : ""}`
        );
      } catch (error2) {
        pushNotice(
          "Copy \xB7 failed",
          error2 instanceof Error ? error2.message : String(error2)
        );
      }
      return;
    }
    if (command === "apply") {
      if (hasPendingSteering(queuedMessage, sendingQueuedMessage.current)) {
        pushNotice(
          "Accept \xB7 blocked \xB7 steering still running",
          "Next: wait for the queue, then /accept 1"
        );
        return;
      }
      const loaded = await refreshSession();
      const applySession = loaded.ok ? loaded.session : session;
      if (applySession && !canAcceptSession(applySession)) {
        const reason = acceptBlockedReason(applySession);
        pushNotice(
          reason?.replace(/; start a new task\.?$/i, ".") ?? "Accept \xB7 blocked",
          "Next: /status \xB7 /sessions"
        );
        return;
      }
      const plan = resolveApplyOperations(applySession, parsed.filePath);
      if (!plan.ok) {
        pushNotice(...plan.rows);
        return;
      }
      try {
        const dirtyPaths = await dirtyApplyTargets(applySession?.repoPath ?? "", plan.operations);
        const applyRows = resolveApplyOperations(applySession, parsed.filePath, dirtyPaths);
        if (!applyRows.ok) {
          pushNotice(...applyRows.rows);
          return;
        }
        await writeAttachUndoRecord({
          repoPath: applySession?.repoPath ?? process.cwd(),
          sessionId: applySession?.sessionId,
          operations: applyRows.operations,
          makeDirectory: async (path) => {
            await mkdir(path, { recursive: true });
          },
          copyFile,
          writeTextFile: (path, content) => writeFile(path, content, "utf-8"),
          pathExists
        });
        for (const operation of applyRows.operations) {
          await mkdir(dirname(operation.targetPath), { recursive: true });
          await copyFile(operation.sourcePath, operation.targetPath);
        }
        const pruned = applySession && applyRows.operations.length > 0 ? pruneAcceptedSessionSnapshot(applySession, applyRows.operations) : applySession;
        const remainingDisplay = (pruned?.changedFiles ?? []).map(
          (file) => displaySessionPath(pruned ?? applySession, file)
        );
        try {
          await execFileAsync("git", ["-C", applySession?.repoPath ?? "", "diff", "--check"]);
          pushNotice(
            ...formatApplyResultRows({
              appliedCount: applyRows.operations.length,
              appliedFiles: applyRows.operations.map((operation) => operation.relativePath),
              skipped: applyRows.skipped,
              verify: { ok: true }
            }),
            ...formatAttachApplyFollowUp({
              appliedCount: applyRows.operations.length,
              remainingFiles: remainingDisplay
            })
          );
        } catch (error2) {
          pushNotice(
            ...formatApplyResultRows({
              appliedCount: applyRows.operations.length,
              appliedFiles: applyRows.operations.map((operation) => operation.relativePath),
              skipped: applyRows.skipped,
              verify: { ok: false, error: error2 instanceof Error ? error2.message : String(error2) }
            })
          );
        }
        if (pruned && applySession && applyRows.operations.length > 0) {
          setSession(pruned);
          try {
            await persistAttachSessionSnapshot(pruned);
          } catch (error2) {
            pushNotice(
              `Accepted files, but session store update failed: ${error2 instanceof Error ? error2.message : String(error2)}`
            );
          }
        }
      } catch (error2) {
        pushNotice(
          "Apply \xB7 failed",
          error2 instanceof Error ? error2.message : String(error2),
          "Next: /status \xB7 /undo"
        );
      }
      return;
    }
    if (command === "undo") {
      const loaded = await refreshSession();
      const undoSession = loaded.ok ? loaded.session : session;
      try {
        pushNotice(
          ...await restoreAttachUndoRecord({
            repoPath: undoSession?.repoPath ?? process.cwd(),
            readTextFile: (path) => readFile(path, "utf-8"),
            makeDirectory: async (path) => {
              await mkdir(path, { recursive: true });
            },
            copyFile,
            removePath: (path) => rm(path, { force: true }),
            verifyRepoDiff: async (repoPath) => {
              await execFileAsync("git", ["-C", repoPath, "diff", "--check"]);
            }
          })
        );
      } catch (error2) {
        pushNotice(
          "Undo \xB7 failed",
          error2 instanceof Error ? error2.message : String(error2),
          "Next: /changes \xB7 /verify"
        );
      }
      return;
    }
    if (command === "promote") {
      const loaded = await refreshSession();
      pushNotice(...formatPromoteRows(loaded.ok ? loaded.session : session, parsed.filePath));
      return;
    }
    if (command === "show") {
      const filePath = parsed.filePath;
      if (!filePath) {
        pushNotice("Usage: /preview <file>");
        return;
      }
      const loaded = await refreshSession();
      const showSession = loaded.ok ? loaded.session : session;
      const preview = resolveAttachPreview(showSession, filePath);
      if (!preview.ok) {
        pushNotice(preview.notice);
        return;
      }
      try {
        const rows = showSession?.repoPath && showSession.worktreePath ? await buildReadyFilePreviewRows({
          displayPath: filePath,
          absolutePath: preview.resolvedPath,
          relativePath: filePath,
          repoPath: showSession.repoPath,
          worktreePath: showSession.worktreePath,
          readTextFile: (path) => readFile(path, "utf-8")
        }) : null;
        if (rows) {
          pushNotice(...rows);
        } else {
          pushNotice(
            ...formatShowFilePreview(filePath, await readFile(preview.resolvedPath, "utf-8"))
          );
        }
        if (showSession) {
          pushNotice(formatAttachPreviewNext(showSession, filePath));
        }
      } catch (error2) {
        pushNotice(
          "Preview \xB7 failed",
          error2 instanceof Error ? error2.message : String(error2),
          "Next: /status \xB7 /diff"
        );
      }
      return;
    }
    const list = await fetchSessions(port);
    if (!list.ok || !list.data?.sessions) {
      pushNotice(list.error ?? "Failed to load sessions.");
      return;
    }
    if (command === "sessions") {
      pushNotice(...formatSessionRows(list.data.sessions));
      return;
    }
    const latest = prioritizeActionableSessions(list.data.sessions)[0];
    if (!latest) {
      pushNotice(...formatSessionRows([]));
      return;
    }
    setActiveSessionId(latest.sessionId);
    setSession(null);
    setEvents([]);
    pushNotice(`Attach \xB7 latest \xB7 ${latest.sessionId.slice(0, 8)}`);
    await refreshSession(latest.sessionId);
  };
  const submitInput = async (value) => {
    const submitted = value.trim();
    if (submitted) {
      setInputHistory(
        (current) => current[current.length - 1] === submitted ? current : [...current.slice(-49), submitted]
      );
    }
    setHistoryIndex(null);
    const parsed = parseZaraacoderAttachInput(value);
    setInput("");
    if (parsed.kind === "noop") return;
    setNotices([]);
    if (parsed.kind === "error") {
      pushNotice(parsed.message);
      return;
    }
    if (parsed.kind === "local") {
      await runLocalCommand(parsed);
      return;
    }
    const queued = queuedSteeringMessage(parsed, session);
    if (queued) {
      setQueuedMessage(queued);
      pushNotice(`Steer \xB7 queued \xB7 ${queued}`, "Next: watch feed \xB7 /status");
      return;
    }
    const startBody = buildPromptStartBody(
      parsed,
      session,
      activeSessionId,
      process.cwd(),
      nextAgentLane
    );
    if (startBody) {
      const result2 = await startSession(port, startBody);
      const nextSession = result2.data?.session;
      if (!result2.ok || !nextSession) {
        pushNotice(result2.error ?? "Failed to start session.");
        return;
      }
      setActiveSessionId(nextSession.sessionId);
      setSession(nextSession);
      setEvents([]);
      pushNotice(`Started next task: ${nextSession.sessionId}`);
      await refreshSession(nextSession.sessionId);
      return;
    }
    if (!activeSessionId) {
      pushNotice("Attach \xB7 no session", "Next: type a task or /new <task>");
      return;
    }
    if (parsed.body.action === "user_message") {
      pushNotice(
        session ? "Run still working. Let it finish, or use /new <task> for parallel work." : "Session still loading. Try again in a moment."
      );
      return;
    }
    const result = await sendControl(port, activeSessionId, parsed.body);
    if (!result.ok) {
      pushNotice(result.error ?? "Failed to send command.");
      return;
    }
    pushNotice(...formatControlResultRows(result.data?.event));
    await refreshSession();
  };
  const loading = Boolean(activeSessionId && !session && !error);
  const activity = formatLiveActivity(session, animationFrame);
  const activeRoute = session?.executorRoute ?? latestExecutorRoute(events);
  const condensed = shouldCondenseCockpit(notices.length);
  const renderableEvents = events.filter(
    (event) => showThinking || !(event.kind === "output" && event.data?.stream === "thinking")
  );
  const visibleEvents = (condensed ? [] : renderableEvents.slice(-8)).map((event) => ({
    event,
    dim: false,
    ...formatCockpitEventRow(event)
  }));
  const slashMenu = formatSlashCommandMenu(input);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(
      Box,
      {
        borderStyle: "single",
        borderColor: session ? phaseColor(session.phase) : "cyan",
        paddingX: 1,
        children: /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
          /* @__PURE__ */ jsx(Text, { bold: true, color: "cyan", children: "Zaraacoder" }),
          /* @__PURE__ */ jsxs(Text, { color: activity.color, children: [
            activity.icon,
            " ",
            activity.label
          ] }),
          /* @__PURE__ */ jsx(Text, { children: header }),
          session ? /* @__PURE__ */ jsx(Text, { dimColor: true, children: formatProgressRail(session.phase) }) : null,
          /* @__PURE__ */ jsx(Text, { color: "magenta", children: formatModelSummary(
            modelDashboard,
            nextAgentLane,
            session ? session.agentLane ?? "auto" : void 0,
            activeRoute
          ) }),
          /* @__PURE__ */ jsx(Text, { dimColor: true, children: formatHotkeyHelp(session) }),
          streamStatus !== "live" ? /* @__PURE__ */ jsxs(Text, { color: streamStatus === "closed" ? "red" : "yellow", children: [
            streamStatus === "connecting" ? "\u25CC connecting\u2026" : null,
            streamStatus === "reconnecting" ? "\u25CC reconnecting\u2026" : null,
            streamStatus === "closed" ? "\u2715 stream closed" : null
          ] }) : null
        ] })
      }
    ),
    loading ? /* @__PURE__ */ jsx(Text, { color: "cyan", children: "Attach \xB7 loading\u2026" }) : /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: session ? phaseColor(session.phase) : "cyan", children: nextActionForSession(session) }),
      /* @__PURE__ */ jsxs(Text, { dimColor: true, children: [
        "Actions ",
        formatActionDeck(session).join(" | ")
      ] }),
      (condensed ? [] : formatMissionStatus(session)).map((line) => /* @__PURE__ */ jsx(Text, { dimColor: true, children: line }, line))
    ] }),
    error ? /* @__PURE__ */ jsx(Text, { color: "red", children: error }) : null,
    notices.length ? /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginTop: 1, children: notices.map((notice) => /* @__PURE__ */ jsx(Text, { dimColor: true, children: notice.line }, notice.id)) }) : null,
    visibleEvents.length ? /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, dimColor: true, children: "Live work" }),
      renderableEvents.length > visibleEvents.length ? /* @__PURE__ */ jsxs(Text, { dimColor: true, children: [
        "\xB7 ",
        renderableEvents.length - visibleEvents.length,
        " earlier \xB7 /feed for all"
      ] }) : null,
      visibleEvents.map(({ event, color, dim, text }) => /* @__PURE__ */ jsx(Text, { color, dimColor: dim, children: text }, event.id))
    ] }) : null,
    slashMenu.length ? /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2, children: slashMenu.map((line, index) => /* @__PURE__ */ jsxs(Text, { color: index === 0 ? "cyan" : void 0, dimColor: index !== 0, children: [
      index === 0 ? "\u203A" : " ",
      " ",
      line
    ] }, line)) }) : null,
    /* @__PURE__ */ jsxs(Box, { marginTop: 1, gap: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "green", children: ">" }),
      /* @__PURE__ */ jsx(
        TextInput,
        {
          value: input,
          onChange: setInput,
          onSubmit: (value) => {
            void submitInput(value);
          },
          placeholder: "message or /help"
        }
      )
    ] }),
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { dimColor: true, children: [
      "\u2191\u2193 history \xB7 Tab complete \xB7 Ctrl-T ",
      showThinking ? "hide" : "show",
      " thinking \xB7 Ctrl-C clear, again to detach"
    ] }) }),
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { dimColor: true, children: formatInputHint(input, session) }) })
  ] });
}
async function runZaraacoderAttachCommand(port, sessionId) {
  if (!sessionId || sessionId === "help" || sessionId === "--help") {
    console.log(
      ["Usage: zaraacoder attach [session-id|latest]", "Commands:", ...formatHelpLines()].join(
        "\n"
      )
    );
    return sessionId ? 0 : 1;
  }
  let resolvedSessionId = sessionId;
  if (sessionId === "latest") {
    const list = await requestGatewayJson(
      port,
      "/api/zaraacoder/sessions"
    );
    if (!list.ok) {
      for (const line of formatAttachGatewayUnavailable(
        port,
        list.error ?? "Failed to load Zaraacoder sessions."
      )) {
        console.error(line);
      }
      return 1;
    }
    resolvedSessionId = resolveInitialAttachSessionId(sessionId, list.data?.sessions ?? [], process.cwd()) ?? "";
  }
  const { render } = await import("ink");
  const React = await import("react");
  const instance = render(React.createElement(AttachView, { port, sessionId: resolvedSessionId }), {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
  return 0;
}
export {
  buildNoSessionStartBody,
  buildPromptStartBody,
  buildStartSessionBody,
  completeSlashCommand,
  flattenTerminalStreamEvent,
  formatAcceptPlanFailRows,
  formatActionDeck,
  formatApplyResultRows,
  formatAttachApplyFollowUp,
  formatAttachGatewayUnavailable,
  formatAttachPreviewNext,
  formatCockpitEventRow,
  formatControlResultRows,
  formatCopyRows,
  formatDiffPatchRows,
  formatDiffRows,
  formatDoctorRows,
  formatEventPulse,
  formatEventRow,
  formatFeedRows,
  formatGitStatusLine,
  formatGitStatusRows,
  formatHelpLines,
  formatHotkeyHelp,
  formatInputHint,
  formatLiveActivity,
  formatLiveEventRow,
  formatMissionStatus,
  formatModelDashboardRows,
  formatModelSummary,
  formatOpenResultLines,
  formatOperatorBrief,
  formatOutputEventRow,
  formatProgressRail,
  formatPromoteRows,
  formatSessionRows,
  formatShowFilePreview,
  formatSlashCommandMenu,
  formatVerifyRows,
  formatWhereRows,
  hasPendingSteering,
  isSettledZaraacoderPhase,
  latestExecutorRoute,
  loadSessionState,
  nextActionForSession,
  normalizeTerminalEvent,
  parseZaraacoderAttachInput,
  persistAttachSessionSnapshot,
  phaseColor,
  pruneAcceptedSessionSnapshot,
  queuedSteeringMessage,
  recallInputHistory,
  resolveAgentLane,
  resolveApplyOperations,
  resolveAttachPreview,
  resolveAttachSessionId,
  resolveInitialAttachSessionId,
  resolveOpenTarget,
  resolveShowFilePath,
  restoreAttachUndoRecord,
  runZaraacoderAttachCommand,
  shouldCondenseCockpit,
  trimNoticeRows,
  writeAttachUndoRecord,
  zaraacoderAttachPollMs
};
