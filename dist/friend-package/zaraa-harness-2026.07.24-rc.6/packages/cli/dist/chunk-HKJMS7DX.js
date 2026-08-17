import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import {
  resolveCliConfigDir,
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/zaraacoder.ts
import { Buffer } from "buffer";
import { execFile } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import {
  acceptBlockedReason,
  canAcceptSession,
  IN_FLIGHT_SESSION_PHASES,
  isActionableSession,
  previewBlockedReason
} from "@zaraa/core";
function polishLearnedDisplayLine(line) {
  const raw = typeof line === "string" ? line.trim() : "";
  if (!raw) return "";
  if (raw.endsWith("\u2026") || /[.!?]$/.test(raw)) return raw;
  let text = raw.replace(/[,;:]\s*$/, "").trimEnd();
  const ok = /* @__PURE__ */ new Set([
    "tool",
    "tools",
    "call",
    "calls",
    "task",
    "list",
    "done",
    "first",
    "once",
    "only",
    "also",
    "just",
    "next",
    "here",
    "with",
    "from",
    "into",
    "over",
    "use",
    "fix",
    "out",
    "off",
    "all",
    "any",
    "now"
  ]);
  const parts = text.split(/\s+/);
  const last = parts[parts.length - 1] ?? "";
  if (parts.length >= 4 && /^[A-Za-z']+$/.test(last) && last.length <= 5 && !ok.has(last.toLowerCase())) {
    text = parts.slice(0, -1).join(" ").trimEnd();
  }
  if (text.length >= 40 && !/[.!?…]$/.test(text)) return `${text}\u2026`;
  if (text !== raw && !text.endsWith("\u2026")) return `${text}\u2026`;
  return text;
}
var USAGE = "Usage: zaraacoder [attach [session-id|latest]] | zaraacoder <task> | zaraacoder run --repo <path> [--lane auto|codex|claude|grok|local|zero] [--goal <text>] [--mode plan|build] [--plan-only] [--auto-accept] [--no-auto-accept] [--standalone] [--cc-compat] [--json] [--store <path>] <task> | zaraacoder learn <when> <do> | zaraacoder gc [--dry-run|--apply] | zaraacoder list|sessions [--json] [--verbose] [--all] [--store <path>] [--repo <path>] [--limit <n>] | zaraacoder goal <session-id|latest> <goal> [--json] [--store <path>] | zaraacoder now | zaraacoder ready | zaraacoder burnin | zaraacoder doctor | zaraacoder verify | zaraacoder changes | zaraacoder brief | zaraacoder where | zaraacoder feed | zaraacoder say <message> | zaraacoder continue [note] | zaraacoder stop [session] | zaraacoder preview [session] [file|number] | zaraacoder accept [number|all] or accept <session> <number|all> | zaraacoder undo | zaraacoder promote [number] | zaraacoder link | zaraacoder open [artifact|worktree|repo|trace] | zaraacoder bench [--json] [--root <path>] | zaraacoder bench compare <baseline-result.json> <candidate-result.json> | zaraacoder bench baseline promote|compare [--json] [--baseline <path>] <result.json> | zaraacoder bench check [--json] [--root <path>] [--baseline <path>] | zaraacoder status|trace|diff|handoff [number|session-id|latest] [--json] [--store <path>]";
var HELP_TEXT = [
  "Zaraacoder \u2014 worktree edits you preview before they touch your repo.",
  "",
  "Daily loop (safer than Claude Code: nothing lands until you accept):",
  '  zaraacoder --lane claude "fix the bug"   # live spinner + feed + Diff',
  "  zaraacoder accept 1                      # or answer Y/a at the TTY prompt",
  "  zaraacoder undo                          # change your mind",
  "",
  "Claude Code muscle memory (opt-in profile):",
  "  export ZARAACODER_CC_COMPAT=1            # standalone + hermetic lane + auto-accept",
  '  zaraacoder "fix the bug"               # lands when ready+checks pass (undo still works)',
  "  # monorepo-safe default remains manual accept without CC-compat",
  "",
  "When you need it:",
  "  doctor          health + council lanes",
  "  list            actionable sessions (shows first changed path)",
  '  learn "when" "do"  make one correction stick',
  "  p 1 / u         preview / undo shortcuts",
  "  zaraacoder      interactive attach (streaming REPL)",
  "",
  "More: zaraacoder help more"
].join("\n");
var HELP_MORE_TEXT = [
  "All commands:",
  "  zaraacoder | zaraacoder <task>",
  "  run --repo <path> [--lane auto|codex|claude|grok|local|zero] [--goal <text>] [--mode plan|build] [--plan-only] [--auto-accept] [--no-auto-accept] [--cc-compat] <task>",
  "  list|sessions [--all] [--limit n] [--repo path]",
  "  status|trace|diff|handoff [number|session-id|latest]",
  "  preview [session] [file|number]",
  "  accept [number|all]  |  accept <session> <number|all>",
  "  undo | promote [number] | verify | changes",
  "  doctor | ready | now | brief | where | feed | open \u2026",
  "  attach | northstar (go) | wire-zero | tonight | burnin",
  "  say <msg> | continue [note] | stop [session] | goal <session> <goal> | learn <when> <do>",
  "  models status|pin <key>|auto | link | gc | bench \u2026",
  "",
  "Short aliases: p preview \xB7 a attach \xB7 n now \xB7 l list \xB7 u undo \xB7 s status \xB7 d diff \xB7 r verify",
  "Tips: one Next line per screen; list/doctor show paths; undo prints \u21BA Restored; never accept a ghost.",
  "Opt-in auto-accept: --auto-accept or ZARAACODER_AUTO_ACCEPT=1 (ready + checks pass \u2192 accept all; undo still works).",
  "Standalone (daemon optional): --standalone or ZARAACODER_STANDALONE=1 \u2014 doctor/ready pass with linked CLI only; use CLI lanes (claude/codex/local).",
  "CC-compat (Claude Code muscle memory): --cc-compat or ZARAACODER_CC_COMPAT=1 \u2014 standalone stack + hermetic default lane + auto-accept when checks pass; monorepo default stays manual accept without this profile. Disable accept with --no-auto-accept or ZARAACODER_AUTO_ACCEPT=0."
].join("\n");
var CORE_PACKAGE = "@zaraa/core";
var SHARED_PACKAGE = "@zaraa/shared";
var ZARAACODER_VERSION = "0.0.1";
var DEFAULT_EXECUTOR_TIMEOUT_MS = 5 * 60 * 1e3;
var DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1e3;
var DEFAULT_SESSION_LIST_LIMIT = 5;
var DEFAULT_LANE_MODELS = {
  codex: "gpt-5.6-sol",
  claude: "claude-sonnet-5",
  grok: "grok-4.5",
  local: "gemma4-e4b-qat-zaraa"
};
var execFileAsync = promisify(execFile);
var INSPECT_ACTIONS = /* @__PURE__ */ new Set(["status", "trace", "diff", "handoff"]);
var TOP_LEVEL_ACTION_ALIASES = {
  "?": "help",
  a: "attach",
  b: "brief",
  c: "changes",
  d: "diff",
  f: "feed",
  go: "northstar",
  h: "handoff",
  l: "list",
  ls: "list",
  m: "promote",
  n: "now",
  next: "northstar",
  ns: "northstar",
  o: "open",
  p: "preview",
  q: "help",
  r: "verify",
  s: "status",
  start: "northstar",
  t: "trace",
  truth: "northstar",
  u: "undo",
  w: "where",
  wire: "wire-zero"
};
async function defaultReadAcceptPrompt(prompt) {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return await new Promise((resolve2) => {
      rl.question(prompt, (answer) => {
        resolve2(answer);
      });
    });
  } finally {
    rl.close();
  }
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
async function verifyRepoDiff(repoPath) {
  await execFileAsync("git", ["-C", repoPath, "diff", "--check"], { timeout: 15e3 });
}
var GIT_STATUS_TIMEOUT_SENTINEL = "__zaraacoder_git_status_timeout__";
async function listRepoChanges(repoPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4e3;
  const untracked = options.includeUntracked ? "normal" : "no";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "status", "--short", `--untracked-files=${untracked}`],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    const err = error;
    const msg = err.message ?? String(error);
    if (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT" || /ETIMEDOUT|timed out|TIMEOUT/i.test(msg)) {
      return [GIT_STATUS_TIMEOUT_SENTINEL];
    }
    throw error;
  }
}
function nextOperatorStep(input) {
  const files = input.changedFiles ?? [];
  if (input.phase === "cancelled") {
    return 'Next: zaraacoder "<task>"  # dismissed; start a new run';
  }
  if (input.phase === "ready" && files.length === 0) {
    return 'Next: zaraacoder "<task>"  # ready, but no files to accept';
  }
  const status = input.phase === "ready" ? input.reviewStatus ?? "ready" : input.phase;
  const next = nextChangedFileCommand(status, files, input.sessionRef);
  if (next) return next;
  if (input.phase && input.phase !== "ready") {
    return input.sessionRef ? `Next: zaraacoder status ${input.sessionRef}` : "Next: zaraacoder status 1";
  }
  return 'Next: zaraacoder "your task"';
}
async function openExternal(target) {
  await execFileAsync("open", [target]);
}
async function diffSessionFiles(input) {
  const { access } = await import("fs/promises");
  const exists = async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  const chunks = [];
  for (const file of input.files) {
    const relativePath = displaySessionPath({ worktreePath: input.worktreePath }, file);
    const repoFile = join(input.repoPath, relativePath);
    const worktreeFile = join(input.worktreePath, relativePath);
    const repoExists = await exists(repoFile);
    const worktreeExists = await exists(worktreeFile);
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
      if (stdout.trim()) chunks.push(cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile).trimEnd());
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      if (stdout.trim()) chunks.push(cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile).trimEnd());
    }
  }
  return chunks.join("\n");
}
function cleanNoIndexDiffPaths(stdout, relativePath, repoFile, worktreeFile) {
  return stdout.split(`a${repoFile}`).join(`a/${relativePath}`).split(`b${repoFile}`).join(`a/${relativePath}`).split(`a${worktreeFile}`).join(`a/${relativePath}`).split(`b${worktreeFile}`).join(`b/${relativePath}`).split(repoFile).join(`a/${relativePath}`).split(worktreeFile).join(`b/${relativePath}`);
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
async function resolveCommand(name) {
  try {
    const { stdout } = await execFileAsync("which", [name]);
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
function zaraacoderLinkGlobalPlan(input = {}) {
  const targetPath = resolve(input.repoRoot ?? process.cwd(), "packages/cli/dist/zaraacoder.js");
  return {
    shimPath: join(input.homeDir ?? homedir(), "bin", "zaraacoder"),
    content: `#!/usr/bin/env sh
exec node ${shellArg(targetPath)} "$@"
`
  };
}
async function linkGlobal() {
  const { chmod, mkdir, writeFile } = await import("fs/promises");
  const plan = zaraacoderLinkGlobalPlan();
  await mkdir(dirname(plan.shimPath), { recursive: true });
  await writeFile(plan.shimPath, plan.content, "utf-8");
  await chmod(plan.shimPath, 493);
}
async function runZeroBurnIn() {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", ["zaraacoder:zero-burnin"], {
      cwd: process.cwd()
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const maybe = error;
    return {
      code: typeof maybe.code === "number" ? maybe.code : 1,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string" ? maybe.stderr : errorMessage(error)
    };
  }
}
async function loadZaraacoderDeps() {
  const core = await import(CORE_PACKAGE);
  const shared = await import(SHARED_PACKAGE);
  const { access, copyFile, mkdir, readFile, rm, writeFile } = await import("fs/promises");
  return {
    defaultZaraacoderConfig: core.defaultZaraacoderConfig,
    normalizeZaraacoderConfig: core.normalizeZaraacoderConfig,
    loadZaraacoderRepoContext: core.loadZaraacoderRepoContext,
    loadZaraaConfig: shared.loadConfig,
    createConfiguredExecutor: core.createConfiguredZaraacoderExecutor,
    createSessionStore: (rootDir) => new core.ZaraacoderSessionStore({
      rootDir: rootDir ?? join(resolveRuntimeHomeDir(), ".zaraa", "zaraacoder")
    }),
    runPersistentSession: core.runPersistentZaraacoderSession,
    readTextFile: (path) => readFile(path, "utf-8"),
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeTextFile: (path, content) => writeFile(path, content, "utf-8"),
    pathExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    removePath: (path) => rm(path, { force: true }),
    runZaraBenchSeedSuite: core.runZaraBenchSeedSuite,
    verifyRepoDiff,
    listRepoChanges,
    openExternal,
    diffSessionFiles,
    copyFile,
    dirtyApplyTargets,
    resolveCommand,
    linkGlobal,
    runZeroBurnIn,
    requestGatewayJson
  };
}
function isInspectAction(action) {
  return typeof action === "string" && INSPECT_ACTIONS.has(action);
}
function readOptionValue(parts, index, option, valueName = "path") {
  const value = parts[index + 1] ?? "";
  if (!value || value.startsWith("--")) {
    throw new Error(`Zaraacoder requires ${option} <${valueName}>`);
  }
  return value;
}
function parsePositiveIntegerOption(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Zaraacoder requires ${option} <n> as a positive integer`);
  }
  return parsed;
}
function withOptionalStore(parsed, store) {
  if (store === void 0) {
    return parsed;
  }
  return { ...parsed, store };
}
function parseRunArgs(rest, trailingOptions = false) {
  let repo = "";
  let goal = "";
  let planOnly = false;
  let explicitPlanOnly = false;
  let requestedMode;
  let agentLane;
  let autoAccept;
  let json = false;
  let store;
  const taskParts = [];
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (taskParts.length > 0 && !trailingOptions) {
      taskParts.push(part);
    } else if (part === "--repo") {
      const value = rest[i + 1] ?? "";
      if (!value || value.startsWith("--")) {
        throw new Error("Zaraacoder requires --repo <path>");
      }
      repo = value;
      i += 1;
    } else if (part.startsWith("--repo=")) {
      repo = part.slice("--repo=".length);
    } else if (part === "--goal" || part === "-g") {
      goal = readOptionValue(rest, i, "--goal", "text");
      i += 1;
    } else if (part.startsWith("--goal=")) {
      goal = part.slice("--goal=".length);
      if (!goal) {
        throw new Error("Zaraacoder requires --goal <text>");
      }
    } else if (part === "--plan-only") {
      explicitPlanOnly = true;
      planOnly = true;
    } else if (part === "--auto-accept") {
      autoAccept = true;
    } else if (part === "--no-auto-accept") {
      autoAccept = false;
    } else if (part === "--cc-compat") {
      if (autoAccept !== false) autoAccept = true;
    } else if (part === "--standalone") {
    } else if (part === "--mode") {
      if (requestedMode) throw new Error("Zaraacoder --mode may only be provided once");
      const value = readOptionValue(rest, i, "--mode", "plan|build").toLowerCase();
      if (value !== "plan" && value !== "build") {
        throw new Error("Zaraacoder --mode must be one of: plan, build");
      }
      requestedMode = value;
      if (requestedMode === "plan") planOnly = true;
      i += 1;
    } else if (part.startsWith("--mode=")) {
      if (requestedMode) throw new Error("Zaraacoder --mode may only be provided once");
      const value = part.slice("--mode=".length).toLowerCase();
      if (value !== "plan" && value !== "build") {
        throw new Error("Zaraacoder --mode must be one of: plan, build");
      }
      requestedMode = value;
      if (requestedMode === "plan") planOnly = true;
    } else if (part === "--lane" || part === "--agent") {
      const value = readOptionValue(rest, i, part, "auto|codex|claude|grok|local|zero").toLowerCase();
      if (!["auto", "codex", "claude", "grok", "local", "zero"].includes(value)) {
        throw new Error(
          "Zaraacoder --lane/--agent must be one of: auto, codex, claude, grok, local, zero"
        );
      }
      agentLane = value;
      i += 1;
    } else if (part.startsWith("--lane=") || part.startsWith("--agent=")) {
      const value = part.slice(part.indexOf("=") + 1).toLowerCase();
      if (!["auto", "codex", "claude", "grok", "local", "zero"].includes(value)) {
        throw new Error(
          "Zaraacoder --lane/--agent must be one of: auto, codex, claude, grok, local, zero"
        );
      }
      agentLane = value;
    } else if (part === "--json") {
      json = true;
    } else if (part === "--store") {
      store = readOptionValue(rest, i, "--store");
      i += 1;
    } else if (part.startsWith("--store=")) {
      store = part.slice("--store=".length);
      if (!store) {
        throw new Error("Zaraacoder requires --store <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      taskParts.push(part);
    }
  }
  const task = taskParts.join(" ").trim();
  const normalizedGoal = goal.trim();
  if (!repo) repo = process.cwd();
  if (!task) throw new Error("Zaraacoder requires task text");
  if (goal && !normalizedGoal) throw new Error("Zaraacoder requires --goal <text>");
  if (requestedMode === "build" && explicitPlanOnly) {
    throw new Error("Zaraacoder --mode build cannot be combined with --plan-only");
  }
  const resolvedLane = agentLane ?? defaultAgentLaneFromEnv();
  return withOptionalStore(
    {
      action: "run",
      repo,
      task,
      ...normalizedGoal ? { goal: normalizedGoal } : {},
      planOnly,
      ...resolvedLane ? { agentLane: resolvedLane } : {},
      ...autoAccept === void 0 ? {} : { autoAccept },
      json
    },
    store
  );
}
function parseInspectArgs(action, rest) {
  const [first, ...remaining] = rest;
  const sessionId = first && !first.startsWith("--") ? first : "latest";
  const options = first && !first.startsWith("--") ? remaining : rest;
  let json = false;
  let store;
  for (let i = 0; i < options.length; i += 1) {
    const part = options[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--store") {
      store = readOptionValue(options, i, "--store");
      i += 1;
    } else if (part.startsWith("--store=")) {
      store = part.slice("--store=".length);
      if (!store) {
        throw new Error("Zaraacoder requires --store <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      throw new Error(`Unexpected Zaraacoder ${action} argument: ${part}`);
    }
  }
  return withOptionalStore(
    {
      action,
      sessionId,
      json
    },
    store
  );
}
function parseGoalArgs(rest) {
  const [sessionId, ...parts] = rest;
  if (!sessionId || sessionId.startsWith("--")) {
    throw new Error("Zaraacoder goal requires <session-id|latest>");
  }
  let json = false;
  let store;
  const goalParts = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--store") {
      store = readOptionValue(parts, i, "--store");
      i += 1;
    } else if (part.startsWith("--store=")) {
      store = part.slice("--store=".length);
      if (!store) {
        throw new Error("Zaraacoder requires --store <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      goalParts.push(part);
    }
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new Error("Zaraacoder goal requires <goal>");
  }
  return withOptionalStore({ action: "goal", sessionId, goal, json }, store);
}
function parseListArgs(rest) {
  let json = false;
  let verbose = false;
  let store;
  let limit;
  let repo = "";
  let all = false;
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--verbose") {
      verbose = true;
    } else if (part === "--all") {
      all = true;
    } else if (part === "--repo") {
      repo = readOptionValue(rest, i, "--repo");
      i += 1;
    } else if (part.startsWith("--repo=")) {
      repo = part.slice("--repo=".length);
      if (!repo) {
        throw new Error("Zaraacoder requires --repo <path>");
      }
    } else if (part === "--limit") {
      limit = parsePositiveIntegerOption(readOptionValue(rest, i, "--limit", "n"), "--limit");
      i += 1;
    } else if (part.startsWith("--limit=")) {
      limit = parsePositiveIntegerOption(part.slice("--limit=".length), "--limit");
    } else if (part === "--store") {
      store = readOptionValue(rest, i, "--store");
      i += 1;
    } else if (part.startsWith("--store=")) {
      store = part.slice("--store=".length);
      if (!store) {
        throw new Error("Zaraacoder requires --store <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      throw new Error(`Unexpected Zaraacoder list argument: ${part}`);
    }
  }
  return withOptionalStore(
    {
      action: "list",
      json,
      verbose,
      ...repo ? { repo } : {},
      ...all ? { all } : {},
      ...limit === void 0 ? {} : { limit }
    },
    store
  );
}
function parseBenchArgs(rest) {
  if (rest[0] === "compare") {
    return parseBenchCompareArgs(rest.slice(1));
  }
  if (rest[0] === "baseline") {
    return parseBenchBaselineArgs(rest.slice(1));
  }
  if (rest[0] === "check") {
    return parseBenchCheckArgs(rest.slice(1));
  }
  let json = false;
  let root;
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--root") {
      root = readOptionValue(rest, i, "--root");
      i += 1;
    } else if (part.startsWith("--root=")) {
      root = part.slice("--root=".length);
      if (!root) {
        throw new Error("Zaraacoder requires --root <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      throw new Error(`Unexpected Zaraacoder bench argument: ${part}`);
    }
  }
  return root === void 0 ? { action: "bench", json } : { action: "bench", json, root };
}
function parseBenchCompareArgs(rest) {
  let json = false;
  const paths = [];
  for (const part of rest) {
    if (part === "--json") {
      json = true;
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      paths.push(part);
    }
  }
  if (paths.length !== 2) {
    throw new Error("ZaraBench compare requires <baseline-result.json> <candidate-result.json>");
  }
  return {
    action: "bench-compare",
    json,
    baseline: paths[0],
    candidate: paths[1]
  };
}
function parseBenchBaselineArgs(rest) {
  const [baselineAction, ...options] = rest;
  if (baselineAction !== "promote" && baselineAction !== "compare") {
    throw new Error("ZaraBench baseline requires promote or compare");
  }
  let json = false;
  let baselinePath;
  const paths = [];
  for (let i = 0; i < options.length; i += 1) {
    const part = options[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--baseline") {
      baselinePath = readOptionValue(options, i, "--baseline");
      i += 1;
    } else if (part.startsWith("--baseline=")) {
      baselinePath = part.slice("--baseline=".length);
      if (!baselinePath) {
        throw new Error("ZaraBench baseline requires --baseline <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      paths.push(part);
    }
  }
  if (paths.length !== 1) {
    throw new Error(`ZaraBench baseline ${baselineAction} requires <result.json>`);
  }
  if (baselineAction === "promote") {
    return baselinePath === void 0 ? { action: "bench-baseline-promote", json, source: paths[0] } : { action: "bench-baseline-promote", json, baselinePath, source: paths[0] };
  }
  return baselinePath === void 0 ? { action: "bench-baseline-compare", json, candidate: paths[0] } : { action: "bench-baseline-compare", json, baselinePath, candidate: paths[0] };
}
function parseBenchCheckArgs(rest) {
  let json = false;
  let root;
  let baselinePath;
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (part === "--json") {
      json = true;
    } else if (part === "--root") {
      root = readOptionValue(rest, i, "--root");
      i += 1;
    } else if (part.startsWith("--root=")) {
      root = part.slice("--root=".length);
      if (!root) {
        throw new Error("Zaraacoder requires --root <path>");
      }
    } else if (part === "--baseline") {
      baselinePath = readOptionValue(rest, i, "--baseline");
      i += 1;
    } else if (part.startsWith("--baseline=")) {
      baselinePath = part.slice("--baseline=".length);
      if (!baselinePath) {
        throw new Error("ZaraBench check requires --baseline <path>");
      }
    } else if (part.startsWith("--")) {
      throw new Error(`Unknown Zaraacoder option: ${part}`);
    } else {
      throw new Error(`Unexpected ZaraBench check argument: ${part}`);
    }
  }
  return {
    action: "bench-check",
    json,
    ...root === void 0 ? {} : { root },
    ...baselinePath === void 0 ? {} : { baselinePath }
  };
}
function defaultAgentLaneFromEnv() {
  const raw = process.env.ZARAACODER_DEFAULT_LANE?.trim().toLowerCase();
  if (!raw) return void 0;
  if (["auto", "codex", "claude", "grok", "local", "zero"].includes(raw)) {
    return raw;
  }
  return void 0;
}
function parseZaraacoderArgs(args) {
  if (args[0]?.startsWith("--") && args[0] !== "--help" && args[0] !== "--version") {
    return parseRunArgs(["--repo", process.cwd(), ...args]);
  }
  const [action, ...rest] = args;
  if (!action) {
    return { action: "attach", sessionId: "latest" };
  }
  if (action === "--help" || action === "-h" || action === "help") {
    const more = rest[0] === "more" || rest[0] === "--more" || rest[0] === "all" || rest[0] === "--all";
    if (rest.length > 1 || rest.length === 1 && !more) {
      throw new Error("Usage: zaraacoder help [more]");
    }
    return more ? { action: "help", more: true } : { action: "help" };
  }
  if (action === "--version" || action === "-v" || action === "version") {
    return { action: "version" };
  }
  const alias = TOP_LEVEL_ACTION_ALIASES[action];
  if (alias) return parseZaraacoderArgs([alias, ...rest]);
  if (action === "run") {
    return parseRunArgs(rest);
  }
  if (action === "gc") {
    if (rest.length === 0 || rest.length === 1 && rest[0] === "--dry-run") {
      return { action: "gc", apply: false };
    }
    if (rest.length === 1 && rest[0] === "--apply") {
      return { action: "gc", apply: true };
    }
    throw new Error("Usage: zaraacoder gc [--dry-run|--apply]");
  }
  if (action === "list" || action === "sessions") {
    return parseListArgs(rest);
  }
  if (action === "goal") {
    return parseGoalArgs(rest);
  }
  if (action === "learn") {
    if (rest.length !== 2 || rest.some((part) => !part.trim())) {
      throw new Error('Usage: zaraacoder learn "<when>" "<do>"');
    }
    return { action: "learn", trigger: rest[0].trim(), correction: rest[1].trim() };
  }
  if (action === "bench") {
    return parseBenchArgs(rest);
  }
  if (action === "attach") {
    const sessionId = rest[0]?.trim() || "latest";
    return { action: "attach", sessionId };
  }
  if (action === "doctor") {
    const allowed = /* @__PURE__ */ new Set(["--standalone", "--cc-compat"]);
    if (rest.some((p) => !allowed.has(p))) {
      throw new Error("Usage: zaraacoder doctor [--standalone] [--cc-compat]");
    }
    const standalone = rest.includes("--standalone") || rest.includes("--cc-compat");
    return { action: "doctor", ...standalone ? { standalone: true } : {} };
  }
  if (action === "ready") {
    const allowed = /* @__PURE__ */ new Set(["--standalone", "--cc-compat"]);
    if (rest.some((p) => !allowed.has(p))) {
      throw new Error("Usage: zaraacoder ready [--standalone] [--cc-compat]");
    }
    const standalone = rest.includes("--standalone") || rest.includes("--cc-compat");
    return { action: "ready", ...standalone ? { standalone: true } : {} };
  }
  if (action === "now") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder now");
    return { action: "now" };
  }
  if (action === "northstar") {
    let json = false;
    for (const part of rest) {
      if (part === "--json") json = true;
      else throw new Error(`Unknown Zaraacoder option: ${part}`);
    }
    return { action: "northstar", json };
  }
  if (action === "wire-zero") {
    let json = false;
    for (const part of rest) {
      if (part === "--json") json = true;
      else throw new Error(`Unknown Zaraacoder option: ${part}`);
    }
    return { action: "wire-zero", json };
  }
  if (action === "tonight") {
    let json = false;
    for (const part of rest) {
      if (part === "--json") json = true;
      else throw new Error(`Unknown Zaraacoder option: ${part}`);
    }
    return { action: "tonight", json };
  }
  if (action === "burnin") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder burnin");
    return { action: "burnin" };
  }
  if (action === "verify") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder verify");
    return { action: "verify" };
  }
  if (action === "changes") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder changes");
    return { action: "changes" };
  }
  if (action === "open") {
    if (rest.length > 1) throw new Error("Usage: zaraacoder open [artifact|worktree|repo|trace]");
    return rest[0] ? { action: "open", target: rest[0] } : { action: "open" };
  }
  if (action === "brief") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder brief");
    return { action: "brief" };
  }
  if (action === "where") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder where");
    return { action: "where" };
  }
  if (action === "feed") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder feed");
    return { action: "feed" };
  }
  if (action === "say") {
    const message = rest.join(" ").trim();
    if (!message) throw new Error("Usage: zaraacoder say <message>");
    return { action: "say", message };
  }
  if (action === "continue") {
    const message = rest.join(" ").trim();
    return message ? { action: "continue", message } : { action: "continue" };
  }
  if (action === "stop") {
    if (rest.length > 1) throw new Error("Usage: zaraacoder stop [session]");
    return rest[0] ? { action: "stop", sessionId: rest[0] } : { action: "stop" };
  }
  if (action === "preview") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      return { action: "help" };
    }
    if (rest.length > 2) {
      throw new Error("Usage: zaraacoder preview [file|number] or preview <session> <file|number>");
    }
    if (rest.length === 2) return { action: "show", sessionId: rest[0], filePath: rest[1] };
    if (rest[0] === "latest") return { action: "show", sessionId: "latest", filePath: "1" };
    return { action: "show", filePath: rest[0] ?? "1" };
  }
  if (action === "show") {
    if (rest.length !== 1) throw new Error("Usage: zaraacoder show <file|number>");
    return { action: "show", filePath: rest[0] };
  }
  if (action === "promote") {
    if (rest.length > 1 || rest[0] && !/^[1-9]\d*$/.test(rest[0])) {
      throw new Error("Usage: zaraacoder promote [number]");
    }
    return rest[0] ? { action: "promote", filePath: rest[0] } : { action: "promote" };
  }
  if (action === "accept") {
    const usage = "Usage: zaraacoder accept [number|all] or accept <session> <number|all>";
    if (rest.length > 2) throw new Error(usage);
    if (rest.length === 2) {
      if (rest[1] !== "all" && !/^[1-9]\d*$/.test(rest[1])) throw new Error(usage);
      return rest[1] === "all" ? { action: "apply", sessionId: rest[0] } : { action: "apply", sessionId: rest[0], filePath: rest[1] };
    }
    if (rest[0] && rest[0] !== "all" && !/^[1-9]\d*$/.test(rest[0])) {
      throw new Error(usage);
    }
    if (rest[0] === "all") return { action: "apply" };
    return { action: "apply", filePath: rest[0] ?? "1" };
  }
  if (action === "apply") {
    if (rest.length > 1 || rest[0] && !/^[1-9]\d*$/.test(rest[0])) {
      throw new Error("Usage: zaraacoder apply [number]");
    }
    return rest[0] ? { action: "apply", filePath: rest[0] } : { action: "apply" };
  }
  if (action === "undo") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder undo");
    return { action: "undo" };
  }
  if (action === "link") {
    if (rest.length > 0) throw new Error("Usage: zaraacoder link");
    return { action: "link" };
  }
  if (action === "models") {
    return { action: "models", args: rest };
  }
  if (isInspectAction(action)) {
    return parseInspectArgs(action, rest);
  }
  if (/^[1-9]\d*$/.test(action) && rest.length === 0) {
    return { action: "status", sessionId: action, json: false };
  }
  if (!action.startsWith("-")) {
    return parseRunArgs(["--repo", process.cwd(), ...args], true);
  }
  throw new Error(USAGE);
}
function requireConfigDeps(deps) {
  if (!deps.defaultZaraacoderConfig || !deps.normalizeZaraacoderConfig) {
    throw new Error("Zaraacoder run dependencies are not configured");
  }
  return {
    defaultZaraacoderConfig: deps.defaultZaraacoderConfig,
    normalizeZaraacoderConfig: deps.normalizeZaraacoderConfig
  };
}
function requirePlanDeps(deps) {
  if (!deps.loadZaraacoderRepoContext) {
    throw new Error("Zaraacoder run dependencies are not configured");
  }
  return {
    loadZaraacoderRepoContext: deps.loadZaraacoderRepoContext
  };
}
function reportSessionLoadError(io, kind, ref) {
  if (kind === "store") {
    io.error("Session \xB7 store not configured");
    io.log("Next: zaraacoder doctor");
    return;
  }
  if (kind === "listing") {
    io.error("Session \xB7 listing not configured");
    io.log("Next: zaraacoder doctor");
    return;
  }
  if (kind === "updates") {
    io.error("Session \xB7 updates not configured");
    io.log("Next: zaraacoder doctor");
    return;
  }
  if (kind === "reader") {
    io.error("Session \xB7 file reader not configured");
    io.log("Next: zaraacoder doctor");
    return;
  }
  io.error(`Session \xB7 not found \xB7 ${ref ?? "?"}`);
  io.log("Next: zaraacoder list");
}
function createSessionStore(args, io, deps) {
  const store = deps.createSessionStore?.(args.store);
  if (!store) {
    reportSessionLoadError(io, "store");
    return null;
  }
  return store;
}
async function loadSessionSnapshot(sessionId, args, io, deps) {
  const store = createSessionStore(args, io, deps);
  if (!store) return null;
  if (sessionId === "latest") {
    if (!store.listLatest) {
      reportSessionLoadError(io, "listing");
      return null;
    }
    const [latestSession] = preferActiveCurrentRepoSessions(await store.listLatest());
    if (!latestSession) {
      reportSessionLoadError(io, "not-found", "latest");
      return null;
    }
    return latestSession;
  }
  if (/^[1-9]\d*$/.test(sessionId)) {
    if (!store.listLatest) {
      reportSessionLoadError(io, "listing");
      return null;
    }
    const session2 = preferActiveCurrentRepoSessions(await store.listLatest())[Number.parseInt(sessionId, 10) - 1];
    if (!session2) {
      reportSessionLoadError(io, "not-found", sessionId);
      return null;
    }
    return session2;
  }
  const session = await store.latest(sessionId);
  if (!session) {
    reportSessionLoadError(io, "not-found", sessionId);
    return null;
  }
  return session;
}
function preferCurrentRepoSessions(sessions) {
  const currentRepoSessions = sessions.filter((session) => sessionMatchesRepo(session, process.cwd()));
  return prioritizeActionableSessions(currentRepoSessions.length ? currentRepoSessions : sessions);
}
function preferActiveCurrentRepoSessions(sessions) {
  return preferCurrentRepoSessions(sessions).filter((session) => session.phase !== "cancelled");
}
function prioritizeActionableSessions(sessions) {
  return [...sessions].sort((a, b) => sessionPriority(a) - sessionPriority(b));
}
function sessionPriority(session) {
  if (session.worktreeMissing) return 3;
  if (IN_FLIGHT_SESSION_PHASES.has(session.phase)) return 0;
  if (isActionableSession(session)) return 1;
  if (session.phase === "blocked" && (session.changedFiles?.length ?? 0) > 0) return 1;
  return 2;
}
async function renderList(args, io, deps) {
  const store = createSessionStore(args, io, deps);
  if (!store) return 1;
  if (!store.listLatest) {
    reportSessionLoadError(io, "listing");
    return 1;
  }
  const allSessions = await store.listLatest();
  const visibleSessions = args.all ? allSessions : args.repo ? allSessions.filter((session) => sessionMatchesRepo(session, args.repo)) : preferCurrentRepoSessions(allSessions);
  const ordered = prioritizeActionableSessions(visibleSessions);
  const tidy = args.all ? ordered : ordered.filter((session) => !isNoiseSession(session));
  if (args.json) {
    const sessions2 = tidy.slice(0, args.limit);
    io.log(JSON.stringify(sessions2));
    return 0;
  }
  const listLimit = args.limit ?? DEFAULT_SESSION_LIST_LIMIT;
  const displayPool = tidy;
  const sessions = displayPool.slice(0, listLimit);
  const hidden = ordered.length - tidy.length;
  if (sessions.length === 0) {
    for (const line of formatListEmptyLines(hidden)) io.log(line);
    return 0;
  }
  for (const [index, session] of sessions.entries()) {
    const prettyList = !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
    io.log(
      formatListSession(session, args.verbose, index + 1, {
        icons: prettyList,
        color: prettyList
      })
    );
  }
  if (hidden > 0 && !args.all) {
    io.log(`  \u2026 ${hidden} quiet hidden \xB7 zaraacoder list --all`);
  }
  if (args.limit === void 0 && displayPool.length > sessions.length) {
    io.log(`More: ${moreSessionsCommand(args, displayPool.length)}`);
  }
  return 0;
}
function formatListEmptyLines(hiddenQuiet) {
  if (hiddenQuiet > 0) {
    return [
      "List \xB7 quiet",
      `  ${hiddenQuiet} stored/cancelled session(s) hidden`,
      "  show \xB7 zaraacoder list --all",
      'Next: zaraacoder "<task>"'
    ];
  }
  return ["List \xB7 empty", 'Next: zaraacoder "<task>"'];
}
function isNoiseSession(session) {
  const task = (session.task ?? "").trim();
  const files = session.changedFiles?.length ?? 0;
  const phase = session.phase.toLowerCase();
  if (isQuietHistorySession(session)) return true;
  if (files > 0) return false;
  if (task.length <= 2) return true;
  return phase === "failed" || phase === "blocked" || phase === "error";
}
function isQuietHistorySession(session) {
  const phase = session.phase.toLowerCase();
  if (phase === "cancelled") return true;
  return phase === "ready" && (session.changedFiles?.length ?? 0) === 0;
}
function moreSessionsCommand(args, total) {
  return zaraacoderCommand([
    "sessions",
    ...args.all ? ["--all"] : [],
    ...args.repo ? ["--repo", args.repo] : [],
    "--limit",
    String(total)
  ]);
}
function formatSessionListIcon(session) {
  const label = displaySessionPhase(session);
  if (label === "ready") return "\u25C6";
  if (label === "stored") return "\xB7";
  if (session.phase === "blocked") return "\u25B2";
  if (session.phase === "failed" || session.phase === "error") return "\xD7";
  if (session.phase && IN_FLIGHT_SESSION_PHASES.has(session.phase)) return "\u25C9";
  return "\xB7";
}
function formatListChangedHint(session) {
  const files = session.changedFiles ?? [];
  if (!files.length) return "";
  const first = clipText(displaySessionPath(session, files[0]), 32);
  if (files.length === 1) return ` \xB7 ${first}`;
  return ` \xB7 ${files.length} files \xB7 ${first}`;
}
function formatListSession(session, verbose, index, options = {}) {
  const goal = session.goal ? ` \xB7 ${clipText(session.goal, 40)}` : "";
  const changed = formatListChangedHint(session);
  const sessionRef = nextCommandSessionRef(String(index));
  const previewCommand = sessionRef ? zaraacoderCommand(["preview", sessionRef, "1"]) : zaraacoderCommand(["preview", "1"]);
  const phaseLabel = displaySessionPhase(session);
  const icon = options.icons ? `${formatSessionListIcon(session)} ` : "";
  const c = options.color === true;
  const phasePainted = phaseLabel === "ready" ? ansiPaint("green", phaseLabel, c) : phaseLabel === "stored" ? ansiPaint("dim", phaseLabel, c) : session.phase === "blocked" ? ansiPaint("yellow", phaseLabel, c) : session.phase === "failed" ? ansiPaint("red", phaseLabel, c) : IN_FLIGHT_SESSION_PHASES.has(session.phase) ? ansiPaint("cyan", phaseLabel, c) : phaseLabel;
  const next = session.phase === "ready" && session.changedFiles?.length ? ` \xB7 ${previewCommand}` : session.phase === "blocked" && session.changedFiles?.length ? ` \xB7 zaraacoder handoff ${index}` : IN_FLIGHT_SESSION_PHASES.has(session.phase) ? ` \xB7 zaraacoder status ${index}` : "";
  const task = clipText(session.task, 64);
  if (!verbose) {
    return `${index}. ${icon}${phasePainted}  ${task}${goal}${changed}${next}`;
  }
  const branch = session.branchName ? ` \xB7 ${session.branchName}` : "";
  return `${index}. ${icon}${phasePainted}  ${session.sessionId}  ${task}${goal}${changed}${branch}${next}`;
}
function clipText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
function sessionMatchesRepo(session, repo) {
  if (!repo) return true;
  const resolvedRepo = resolve(repo);
  return resolve(session.repoPath) === resolvedRepo;
}
function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function effectiveExecutorTimeoutMs(deps) {
  const raw = Number.parseInt(process.env.ZARAACODER_EXECUTOR_TIMEOUT_MS ?? "", 10);
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  const baseConfig = deps.defaultZaraacoderConfig?.();
  const config = baseConfig ? deps.normalizeZaraacoderConfig?.(baseConfig) ?? baseConfig : void 0;
  return Math.min(
    positiveNumber(config?.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS),
    positiveNumber(config?.executorTimeoutMs, DEFAULT_EXECUTOR_TIMEOUT_MS)
  );
}
function formatExecutorTimeoutRows(timeoutMs) {
  const seconds = timeoutMs / 1e3;
  return [
    `Executor timeout ${Number.isInteger(seconds) ? seconds.toFixed(0) : String(seconds)}s`,
    ...timeoutMs < 1e4 ? [
      "Warning executor timeout below 10s; unset ZARAACODER_EXECUTOR_TIMEOUT_MS for normal coding."
    ] : []
  ];
}
async function loadCurrentRepoSession(deps) {
  return (await loadCurrentRepoSessionSelection(deps))?.session ?? null;
}
async function loadCurrentRepoSessionSelection(deps) {
  const store = deps.createSessionStore?.();
  if (!store?.listLatest) return null;
  const sessions = await store.listLatest();
  const currentRepoSessions = preferActiveCurrentRepoSessions(
    sessions.filter((session2) => sessionMatchesRepo(session2, process.cwd()))
  );
  const session = currentRepoSessions[0];
  if (!session) return null;
  const sessionRef = nextCommandSessionRef(String(currentRepoSessions.indexOf(session) + 1));
  return { session, sessionRef };
}
async function renderDoctor(io, deps, opts = {}) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const [{ formatDoctorRows }, gatewayDiagnostics] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    deps.collectGatewayAccessSnapshot ? Promise.resolve({ collectGatewayAccessSnapshot: deps.collectGatewayAccessSnapshot }) : import("./gateway-diagnostics-CWMKN65K.js")
  ]);
  const [selection, snapshot, standaloneCommandPath, config, execution] = await Promise.all([
    loadCurrentRepoSessionSelection(deps),
    gatewayDiagnostics.collectGatewayAccessSnapshot(port),
    (deps.resolveCommand ?? resolveCommand)("zaraacoder"),
    deps.loadZaraaConfig?.(resolveCliConfigDir()),
    // Partner capacity signal: task-runner concurrency (same path as web/m controls).
    (deps.requestGatewayJson ?? requestGatewayJson)(port, "/api/tasks/execution")
  ]);
  const session = selection && !isNoiseSession(selection.session) ? selection.session : null;
  const execLine = execution.ok && execution.data ? `  exec \xB7 ${execution.data.paused ? "paused" : "open"} \xB7 cap ${execution.data.effectiveMaxConcurrency ?? execution.data.maxConcurrency ?? "?"} \xB7 active ${execution.data.activeCount ?? 0}` : null;
  for (const row of formatDoctorRows({
    session,
    sessionRef: selection?.sessionRef,
    port,
    cwd: process.cwd(),
    snapshot,
    standaloneCommandPath,
    standaloneMode: isDaemonOptionalMode(void 0, { standalone: opts.standalone }),
    executorTimeoutRows: formatExecutorTimeoutRows(effectiveExecutorTimeoutMs(deps)),
    ...execLine ? { execLine } : {}
  })) {
    io.log(row);
  }
  const laneModels = config?.zaraacoder?.executor?.laneModels;
  const resolveCmd = deps.resolveCommand ?? resolveCommand;
  const cliProbe = await probeCoderCliLanes(resolveCmd);
  io.log(formatCoderCliLaneProbeLine(cliProbe));
  const hermetic = suggestHermeticDefaultLane(cliProbe);
  if (hermetic) {
    io.log(
      `  hermetic \xB7 prefer --lane ${hermetic} (or ZARAACODER_DEFAULT_LANE=${hermetic}) for daemon-optional runs`
    );
  } else {
    io.log(
      "  hermetic \xB7 no claude/codex/zero on PATH \u2014 install a CLI lane or use daemon model providers"
    );
  }
  io.log("Council \xB7 codex \xB7 claude \xB7 grok \xB7 local");
  for (const lane of ["codex", "claude", "grok", "local"]) {
    io.log(`  ${lane} \xB7 ${laneModels?.[lane]?.trim() || DEFAULT_LANE_MODELS[lane]}`);
  }
  try {
    const store = deps.createSessionStore?.();
    const listed = store?.listLatest ? await store.listLatest() : [];
    if (listed.length >= 20) {
      io.log(`  history \xB7 ${listed.length} sessions \xB7 quiet hidden in list (use --all)`);
    }
  } catch {
  }
  return 0;
}
async function renderReady(io, deps, opts = {}) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const gatewayDiagnostics = deps.collectGatewayAccessSnapshot ? { collectGatewayAccessSnapshot: deps.collectGatewayAccessSnapshot } : await import("./gateway-diagnostics-CWMKN65K.js");
  const [selection, snapshot, standaloneCommandPath, verifyResult, changeLines] = await Promise.all([
    loadCurrentRepoSessionSelection(deps),
    gatewayDiagnostics.collectGatewayAccessSnapshot(port),
    (deps.resolveCommand ?? resolveCommand)("zaraacoder"),
    (deps.verifyRepoDiff ?? verifyRepoDiff)(process.cwd()).then(() => ({ ok: true })).catch((error) => ({ ok: false, error: errorMessage(error) })),
    // Fast dirtiness (untracked skipped) — same source as `now` so labels match.
    (deps.listRepoChanges ?? listRepoChanges)(process.cwd()).catch(() => [])
  ]);
  const session = selection && !isQuietHistorySession(selection.session) ? selection.session : null;
  const standaloneMode = isDaemonOptionalMode(void 0, { standalone: opts.standalone });
  const stackOk = isCoderStackReady({
    standaloneCommandPath,
    snapshot,
    standalone: standaloneMode
  });
  const sessionOk = !session || session.phase === "ready";
  const ready = stackOk && sessionOk;
  const trackedDirty = changeLines[0] === GIT_STATUS_TIMEOUT_SENTINEL ? -1 : changeLines.filter((line) => line !== GIT_STATUS_TIMEOUT_SENTINEL).length;
  const headline = !stackOk ? "Ready \xB7 needs attention" : !sessionOk ? "Ready \xB7 session blocked" : "Ready \xB7 all good";
  io.log(headline);
  io.log(`  command \xB7 ${standaloneCommandPath ? "linked" : "not linked"}`);
  io.log(`  api key \xB7 ${snapshot.hasApiKey ? "ok" : "missing"}`);
  io.log(`  daemon \xB7 ${snapshot.daemonDetected ? "ok" : "down"}${standaloneMode ? " (optional \xB7 standalone)" : ""}`);
  io.log(`  port ${port} \xB7 ${snapshot.gatewayListenerCount > 0 ? "listening" : "closed"}`);
  if (standaloneMode) io.log("  mode \xB7 standalone \xB7 CLI lanes only (no daemon required)");
  for (const row of formatExecutorTimeoutRows(effectiveExecutorTimeoutMs(deps))) {
    io.log(row.startsWith("Warning") ? `  ${row}` : `  ${row.replace(/^Executor timeout /, "timeout \xB7 ")}`);
  }
  const dirtyLabel = trackedDirty < 0 ? "status timed out" : trackedDirty === 0 ? "no tracked edits" : `${trackedDirty} uncommitted`;
  io.log(
    `  repo \xB7 ${dirtyLabel} \xB7 diff-check ${verifyResult.ok ? "ok" : "fail"}`
  );
  if (session) {
    io.log(`  session \xB7 ${displaySessionPhase(session)}${formatListChangedHint(session)}`);
    for (const row of formatRunChangedFilesRows(session.worktreePath, session.changedFiles ?? [])) io.log(row);
  } else {
    io.log("  session \xB7 none");
  }
  if (!stackOk) {
    io.log("Next: zaraacoder doctor");
  } else {
    io.log(
      nextOperatorStep({
        phase: session?.phase,
        reviewStatus: session?.reviewStatus,
        changedFiles: session?.changedFiles,
        sessionRef: selection?.sessionRef
      })
    );
  }
  return ready ? 0 : 1;
}
async function callZaraaMcpTool(port, toolName, args = {}, deps) {
  const request = deps.requestGatewayJson ?? requestGatewayJson;
  const response = await request(port, "/mcp", {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    },
    timeoutMs: 2e4
  });
  if (!response.ok || !response.data) {
    return {
      ok: false,
      text: response.error ?? `MCP call failed (HTTP ${response.status})`,
      status: response.status
    };
  }
  if (response.data.error?.message) {
    return { ok: false, text: response.data.error.message, status: response.status };
  }
  const blocks = response.data.result?.content ?? [];
  const text = blocks.map((b) => b.text ?? "").filter(Boolean).join("\n");
  return {
    ok: !response.data.result?.isError,
    text: text || JSON.stringify(response.data.result ?? response.data),
    status: response.status
  };
}
async function renderNorthstar(io, deps, json) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const result = await callZaraaMcpTool(port, "truth", {}, deps);
  if (!result.ok && result.status === 0) {
    io.error("Zaraa MCP unreachable. Start the daemon, then retry from the installed folder.");
    io.error(result.text);
    io.log("Next: pnpm truth");
    return 1;
  }
  if (!result.ok && result.status === 404) {
    io.error(
      "Zaraa MCP endpoint missing (404). Rebuild/restart the daemon so /mcp is live."
    );
    return 1;
  }
  if (!result.ok) {
    io.error(result.text);
    return 1;
  }
  if (json) {
    io.log(result.text);
    return 0;
  }
  let packet;
  try {
    packet = JSON.parse(result.text);
  } catch {
    io.log(result.text);
    return 0;
  }
  const partner = packet.partner;
  if (partner?.next || partner?.health) {
    const health = partner.health ?? "?";
    io.log(`Northstar \xB7 partner \xB7 ${health}`);
    io.log(`  mode \xB7 ${partner.tradingMode ?? "?"}`);
    io.log(`  load \xB7 ${partner.load ?? "?"}`);
    if (typeof partner.restarts10m === "number" && (partner.restarts10m > 0 || partner.crashLoop)) {
      io.log(
        `  restarts \xB7 ${partner.restarts10m}/10m${partner.crashLoop ? " \xB7 crash storm" : ""}`
      );
    }
    const risks = Array.isArray(partner.risks) ? partner.risks : [];
    if (risks.length === 0) {
      io.log("  risks \xB7 none");
    } else {
      io.log("  risks \xB7");
      for (const risk of risks.slice(0, 3)) io.log(`    - ${risk}`);
    }
    const learned = Array.isArray(partner.corrections) ? partner.corrections : [];
    if (learned.length) {
      io.log("  learned \xB7");
      for (const line of learned.slice(0, 3)) {
        io.log(`    - ${polishLearnedDisplayLine(line)}`);
      }
    }
    if (typeof partner.soulLine === "string" && partner.soulLine.trim()) {
      io.log(`  soul \xB7 ${partner.soulLine.trim()}`);
    }
    io.log(`Next: ${partner.next ?? packet.nextAction ?? "zaraacoder brief"}`);
    io.log("");
  }
  io.log("Northstar \xB7 detail");
  io.log(`  generated \xB7 ${packet.generatedAt ?? "?"}`);
  io.log(
    `  health \xB7 ${packet.health?.status ?? "?"}${packet.health?.version ? ` \xB7 v${packet.health.version}` : ""}`
  );
  io.log(
    `  sessions \xB7 ${packet.zaraacoder?.activeSessions ?? 0} \xB7 backend ${packet.zaraacoder?.executorBackend ?? "codex"}`
  );
  if (packet.zaraacoder?.latest?.sessionId) {
    const latestPhase = displaySessionPhase(packet.zaraacoder.latest);
    const files = packet.zaraacoder.latest.changedFiles ?? [];
    const pathHint = files.length === 0 ? "" : files.length === 1 ? ` \xB7 ${clipText(String(files[0]).split("/").pop() ?? files[0], 32)}` : ` \xB7 ${files.length} files`;
    io.log(
      `  latest \xB7 ${latestPhase}${pathHint} \xB7 ${clipText(packet.zaraacoder.latest.task ?? "", 40)}`
    );
    io.log(`  id \xB7 ${packet.zaraacoder.latest.sessionId}`);
  }
  io.log(
    `  zero \xB7 installed=${packet.zero?.installed ? "yes" : "no"} \xB7 auth=${packet.zero?.authLogins ?? 0} \xB7 mcp=${packet.zero?.mcpRegistered ? "yes" : "no"}`
  );
  if (packet.zero?.note) io.log(`  zero-note \xB7 ${packet.zero.note}`);
  io.log(
    `  tasks \xB7 generation ${packet.tasks?.generationPaused === true ? "paused" : packet.tasks?.generationPaused === false ? "open" : "unknown"}`
  );
  if (packet.tasks?.reason) io.log(`  tasks-reason \xB7 ${packet.tasks.reason}`);
  io.log(
    `  trading \xB7 paperMode=${packet.trading?.paperMode === true ? "true" : packet.trading?.paperMode === false ? "false" : "unknown"}`
  );
  for (const note of packet.notes ?? []) io.log(`  note \xB7 ${note}`);
  if (!partner?.next) {
    io.log(`Next: ${packet.nextAction ?? "zaraacoder brief"}`);
  }
  return 0;
}
function displaySessionPhase(session) {
  return session.phase === "ready" && session.changedFiles?.length === 0 ? "stored" : session.phase ?? "?";
}
function formatWorkingPhaseLabel(phase) {
  const labels = {
    queued: "queued",
    preparing: "preparing worktree",
    planning: "thinking + coding",
    editing: "capturing edits",
    verifying: "running checks",
    reviewing: "reviewing diff"
  };
  const key = phase.trim().toLowerCase();
  return labels[key] ?? phase;
}
function formatProgressRail(phase) {
  const normalized = phase.toLowerCase();
  if (["blocked", "failed", "error", "cancelled", "stopped"].includes(normalized)) {
    return normalized === "blocked" ? "! needs input" : `\xD7 ${normalized}`;
  }
  const current = normalized === "queued" || normalized === "preparing" ? 0 : normalized === "planning" || normalized === "editing" ? 1 : normalized === "verifying" ? 2 : normalized === "reviewing" ? 3 : 4;
  return ["setup", "code", "verify", "review"].map((label, index) => `${index < current ? "\u2713" : index === current ? "\u25C6" : "\u25CB"} ${label}`).join("  ");
}
function formatElapsedShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1e3) return `${Math.max(0, Math.floor(ms))}ms`;
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, "0")}s`;
}
var ANSI = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  cyan: "\x1B[36m",
  green: "\x1B[32m",
  magenta: "\x1B[35m",
  yellow: "\x1B[33m",
  red: "\x1B[31m",
  blue: "\x1B[34m",
  gray: "\x1B[90m"
};
function ansiPaint(style, text, enabled = false) {
  if (!enabled) return text;
  return `${ANSI[style]}${text}${ANSI.reset}`;
}
function formatLivePhaseLines(input) {
  const c = input.color === true;
  const head = `${ansiPaint("cyan", "Working", c)} \xB7 ${ansiPaint("bold", formatWorkingPhaseLabel(input.phase), c)} \xB7 ${ansiPaint("dim", formatElapsedShort(input.elapsedMs), c)}`;
  const lines = [head, `  ${ansiPaint("dim", formatProgressRail(input.phase), c)}`];
  const routeBits = [input.agentLane, input.executorRoute].map((part) => typeof part === "string" ? part.trim() : "").filter(Boolean);
  if (routeBits.length) {
    lines.push(`  ${ansiPaint("magenta", "\u25C6", c)} ${ansiPaint("magenta", routeBits.join(" \xB7 "), c)}`);
  }
  return lines;
}
function formatLiveRunStartLine(input) {
  const c = input.color === true;
  const task = clipText(input.task.replace(/\s+/g, " ").trim(), 72);
  const lane = input.lane?.trim() ? ` \xB7 ${ansiPaint("yellow", `lane ${input.lane.trim()}`, c)}` : "";
  return `${ansiPaint("green", "\u25B6", c)} ${ansiPaint("bold", "Zaraacoder", c)}${lane} \xB7 ${task}`;
}
function pickInterestingStdoutLine(lines) {
  const cleaned = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length >= 4 && line.length < 240).filter((line) => !/^\s*[{}[\],]\s*$/.test(line)).filter((line) => !/^(npm |pnpm |yarn |node:|Debugger|ExperimentalWarning)/i.test(line)).filter((line) => !/^(\[info\]|\[debug\]|DEBUG:)/i.test(line));
  if (!cleaned.length) return null;
  const scored = cleaned.map((line) => {
    let score = 0;
    if (/\b(read|reading|write|wrote|edit|edited|creat|updat|fix|run|ran|tool|inspect|diff|check|test|build)\b/i.test(line))
      score += 3;
    if (/\.(ts|tsx|js|jsx|py|rs|go|md|json|css|html)\b/i.test(line)) score += 2;
    if (/[/\\][\w.-]+/.test(line)) score += 1;
    if (/^(thinking|I'll|I will|Let me|Now )/i.test(line)) score += 1;
    if (line.length > 120) score -= 1;
    return { line, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 1) {
    return cleaned[cleaned.length - 1] ?? null;
  }
  return best.line;
}
function formatLiveOutputFeedLine(chunk, options = {}) {
  const maxLen = options.maxLen ?? 110;
  const c = options.color === true;
  const raw = chunk.text.replace(/\r/g, "").trim();
  if (!raw) return null;
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (chunk.stream === "thinking") {
    const thought = lines[lines.length - 1] ?? raw;
    if (thought.length < 4) return null;
    return `  ${ansiPaint("dim", "\u{1F4AD}", c)} ${ansiPaint("dim", clipText(thought.replace(/\s+/g, " "), maxLen), c)}`;
  }
  if (chunk.stream === "tool") {
    const tool = lines[0] ?? raw;
    return `  ${ansiPaint("magenta", "\u2699", c)} ${ansiPaint("magenta", clipText(tool.replace(/\s+/g, " "), maxLen), c)}`;
  }
  if (chunk.stream === "stderr") {
    const err = raw.replace(/\s+/g, " ");
    if (/DeprecationWarning|ExperimentalWarning|npm warn|^\s*$/i.test(err)) return null;
    return `  ${ansiPaint("red", "\u26A0", c)} ${ansiPaint("red", clipText(err, maxLen), c)}`;
  }
  const interesting = pickInterestingStdoutLine(lines.length ? lines : [raw]);
  if (!interesting) return null;
  return `  ${ansiPaint("cyan", "\u203A", c)} ${clipText(interesting, maxLen)}`;
}
function formatLiveHeartbeatLine(input) {
  const c = input.color === true;
  const label = input.phase ? formatWorkingPhaseLabel(input.phase) : "working";
  return `  ${ansiPaint("dim", `\u2026 still ${label} \xB7 ${formatElapsedShort(input.elapsedMs)}`, c)}`;
}
var LIVE_SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var LIVE_PULSE_BLOCKS = ["\u2591", "\u2592", "\u2593", "\u2588", "\u2593", "\u2592"];
function formatLiveSpinnerFrame(frame) {
  const frames = LIVE_SPINNER_FRAMES;
  return frames[(frame % frames.length + frames.length) % frames.length] ?? frames[0];
}
function formatLiveStatusBar(input) {
  const c = input.color === true;
  const spin = ansiPaint("cyan", formatLiveSpinnerFrame(input.frame), c);
  const label = ansiPaint(
    "bold",
    input.phase ? formatWorkingPhaseLabel(input.phase) : "warming up",
    c
  );
  const elapsed = ansiPaint("dim", formatElapsedShort(input.elapsedMs), c);
  const railRaw = input.phase ? formatProgressRail(input.phase) : "\u25CB setup  \u25CB code  \u25CB verify  \u25CB review";
  const rail = c ? railRaw.replaceAll("\u2713", ansiPaint("green", "\u2713", true)).replaceAll("\u25C6", ansiPaint("cyan", "\u25C6", true)).replaceAll("\u25CB", ansiPaint("dim", "\u25CB", true)) : railRaw;
  const pulseWidth = Math.max(6, Math.min(input.width ?? 10, 14));
  const pulse = Array.from({ length: pulseWidth }, (_, i) => {
    const idx = (input.frame + i) % LIVE_PULSE_BLOCKS.length;
    const block = LIVE_PULSE_BLOCKS[idx] ?? "\u2591";
    if (!c) return block;
    return idx === 3 || idx === 2 ? ansiPaint("magenta", block, true) : ansiPaint("dim", block, true);
  }).join("");
  const activity = typeof input.activityCount === "number" && input.activityCount > 0 ? ansiPaint("dim", ` \xB7 ${input.activityCount} events`, c) : "";
  return `${spin} ${label} \xB7 ${elapsed}${activity}  ${pulse}
  ${rail}`;
}
function createLiveRunAnimator(input) {
  const write = input.write ?? ((text) => {
    if (process.env.VITEST) return;
    process.stdout.write(text);
  });
  const now = input.now ?? (() => Date.now());
  const intervalMs = input.intervalMs ?? 80;
  const startedAt = now();
  let frame = 0;
  let phase = null;
  let activityCount = 0;
  let timer = null;
  let statusOpen = false;
  let stopped = false;
  const clearStatus = () => {
    if (!input.isTTY || !statusOpen) return;
    write("\x1B[1A\r\x1B[2K\x1B[1A\r\x1B[2K\r");
    statusOpen = false;
  };
  const paintStatus = () => {
    if (!input.isTTY || stopped) return;
    const bar = formatLiveStatusBar({
      frame,
      phase,
      elapsedMs: now() - startedAt,
      activityCount,
      color: true
    });
    if (statusOpen) {
      write("\x1B[1A\r\x1B[2K\x1B[1A\r\x1B[2K");
    }
    write(`${bar}
`);
    statusOpen = true;
    frame += 1;
  };
  return {
    start(taskLine) {
      input.log(taskLine);
      if (!input.isTTY) return;
      phase = "queued";
      paintStatus();
      timer = setInterval(paintStatus, intervalMs);
      timer.unref?.();
    },
    setPhase(nextPhase, meta) {
      const changed = nextPhase !== phase;
      phase = nextPhase;
      if (input.isTTY) {
        if (changed) {
          clearStatus();
          for (const line of formatLivePhaseLines({
            phase: nextPhase,
            elapsedMs: now() - startedAt,
            agentLane: meta?.agentLane,
            executorRoute: meta?.executorRoute,
            color: true
          })) {
            input.log(line);
          }
        }
        paintStatus();
        return;
      }
      if (changed) {
        for (const line of formatLivePhaseLines({
          phase: nextPhase,
          elapsedMs: now() - startedAt,
          agentLane: meta?.agentLane,
          executorRoute: meta?.executorRoute
        })) {
          input.log(line);
        }
      }
    },
    logFeed(line) {
      activityCount += 1;
      if (input.isTTY) {
        clearStatus();
        input.log(line);
        paintStatus();
        return;
      }
      input.log(line);
    },
    noteActivity() {
      activityCount += 1;
    },
    stop(doneLine) {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearStatus();
      if (doneLine) {
        input.log(
          input.isTTY && !doneLine.includes("\x1B[") ? ansiPaint("green", doneLine, true) : doneLine
        );
      }
    }
  };
}
function summarizeUnifiedDiff(patch) {
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
function isAutoAcceptEnvEnabled(env) {
  const flag = (env ?? process.env).ZARAACODER_AUTO_ACCEPT?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}
function isAutoAcceptEnvDisabled(env) {
  const flag = (env ?? process.env).ZARAACODER_AUTO_ACCEPT?.trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off" || flag === "no";
}
function isStandaloneModeEnabled(env) {
  const flag = (env ?? process.env).ZARAACODER_STANDALONE?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}
function isCcCompatEnabled(env) {
  const flag = (env ?? process.env).ZARAACODER_CC_COMPAT?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}
function isDaemonOptionalMode(env, opts = {}) {
  return opts.standalone === true || isStandaloneModeEnabled(env) || isCcCompatEnabled(env);
}
function isCoderStackReady(input) {
  const standalone = isDaemonOptionalMode(input.env, { standalone: input.standalone });
  if (!input.standaloneCommandPath) return false;
  if (standalone) return true;
  return input.snapshot.hasApiKey && input.snapshot.daemonDetected && input.snapshot.gatewayListenerCount > 0;
}
function suggestHermeticDefaultLane(probe) {
  if (probe.claude) return "claude";
  if (probe.codex) return "codex";
  if (probe.zero) return "zero";
  return void 0;
}
function formatCoderCliLaneProbeLine(probe) {
  const bit = (name, path) => `${name}\xB7${path ? "found" : "missing"}`;
  return `  clis \xB7 ${bit("claude", probe.claude)} \xB7 ${bit("codex", probe.codex)} \xB7 ${bit("zero", probe.zero)}`;
}
async function probeCoderCliLanes(resolve2) {
  const [claude, codex, zero] = await Promise.all([
    resolve2("claude"),
    resolve2("codex"),
    resolve2("zero")
  ]);
  return { claude, codex, zero };
}
function checksPassForAutoAccept(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return true;
  return checks.every((check) => {
    if (!check || typeof check !== "object") return false;
    const exitCode = check.exitCode;
    return typeof exitCode === "number" && exitCode === 0;
  });
}
function shouldAutoAcceptAfterRun(input) {
  if (input.autoAccept === false || isAutoAcceptEnvDisabled(input.env)) return false;
  const enabled = input.autoAccept === true || isAutoAcceptEnvEnabled(input.env) || isCcCompatEnabled(input.env);
  if (!enabled) return false;
  if (input.status !== "ready") return false;
  if ((input.fileCount ?? 0) <= 0) return false;
  return checksPassForAutoAccept(input.checks);
}
function formatAutoAcceptLine(fileCount, options = {}) {
  const c = options.color === true;
  const n = fileCount === 1 ? "1 file" : `${fileCount} files`;
  return `${ansiPaint("green", "Auto-accept", c)} \xB7 ${n} \xB7 checks ok \xB7 undo: zaraacoder undo`;
}
function shouldPromptAcceptAfterRun(input) {
  if (input.json) return false;
  const flag = (input.env ?? process.env).ZARAACODER_ACCEPT_PROMPT?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  return input.isTTY === true;
}
function formatAcceptPromptLine(fileCount, options = {}) {
  const c = options.color === true;
  const fileHint = options.firstFile?.trim() ? ` ${ansiPaint("cyan", clipText(options.firstFile.trim(), 36), c)}` : "";
  if (fileCount <= 1) {
    return `${ansiPaint("green", "Accept", c)} this change${fileHint}? ${ansiPaint("bold", "[Y/n]", c)} `;
  }
  return `${ansiPaint("green", "Accept", c)}? ${ansiPaint("bold", "[Y", c)}=file 1${fileHint} \xB7 ${ansiPaint("bold", "a", c)}=all ${fileCount} \xB7 ${ansiPaint("bold", "n", c)}=skip] `;
}
function parseAcceptPromptAnswer(raw, _fileCount = 1) {
  const t = raw.trim().toLowerCase();
  if (!t || t === "y" || t === "yes" || t === "1") return "accept-first";
  if (t === "a" || t === "all" || t === "*") return "accept-all";
  return "skip";
}
function formatRunAlsoFilesLine(files, options = {}) {
  if (files.length <= 1) return null;
  const rest = files.slice(1).map(
    (file) => clipText(displaySessionPath({ worktreePath: options.worktreePath ?? null }, file), 28)
  );
  const shown = rest.slice(0, 3);
  const extra = rest.length > 3 ? ` +${rest.length - 3} more` : "";
  const body = `also ${shown.join(" \xB7 ")}${extra}  \xB7  preview 2\u2026 or accept all`;
  return `  ${ansiPaint("dim", body, options.color === true)}`;
}
function nextAfterRunSummary(input) {
  const files = input.changedFiles;
  if (input.showedInlinePreview && input.status === "ready" && files.length > 0) {
    if (files.length === 1) {
      return "Next: zaraacoder accept 1";
    }
    const pathHint = input.firstFile?.trim() ? ` \xB7 ${clipText(input.firstFile.trim(), 36)}` : "";
    return `Next: zaraacoder accept 1   # or: accept all (${files.length} files${pathHint})`;
  }
  return nextChangedFileCommand(input.status, files, input.sessionId);
}
function colorizeDiffLine(line, color = false) {
  if (!color) return line;
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return ansiPaint("dim", line, true);
  }
  if (line.startsWith("+")) return ansiPaint("green", line, true);
  if (line.startsWith("-")) return ansiPaint("red", line, true);
  return line;
}
function formatDiffPreviewRows(displayPath, patch, maxLines = 60, options = {}) {
  const color = options.color === true;
  const lines = patch.replace(/\r?\n$/, "").split(/\r?\n/);
  const clipped = lines.slice(0, maxLines);
  const { added, removed } = summarizeUnifiedDiff(patch);
  const stats = added > 0 || removed > 0 ? ` \xB7 ${ansiPaint("green", `+${added}`, color)} ${ansiPaint("red", `\u2212${removed}`, color)}` : "";
  const header = `${ansiPaint("bold", "Diff", color)} ${ansiPaint("cyan", displayPath, color)}${stats}:`;
  return [
    header,
    ...clipped.map((line) => colorizeDiffLine(line, color)),
    ...lines.length > maxLines ? [ansiPaint("dim", `\u2026 (${lines.length - maxLines} more lines)`, color)] : []
  ];
}
function formatDoneCelebrationLines(input) {
  const c = input.color === true;
  const elapsed = formatElapsedShort(input.elapsedMs);
  const files = input.fileCount <= 0 ? "no files" : input.fileCount === 1 ? "1 file ready" : `${input.fileCount} files ready`;
  return [
    ansiPaint("green", `\u2726 \u2606 \u2726  Done \xB7 ${elapsed}  \xB7  ${files}  \u2726 \u2606 \u2726`, c),
    ansiPaint("dim", "  worktree isolated \u2014 nothing lands until you accept", c)
  ];
}
function formatRunInterruptedLine(options = {}) {
  const c = options.color === true;
  return ansiPaint(
    "yellow",
    "\u25A0 Interrupted \xB7 nothing applied to your repo (worktree still isolated)",
    c
  );
}
function formatApplyLandedLine(options = {}) {
  const c = options.color === true;
  const n = options.fileCount ?? 0;
  const files = n <= 0 ? "change" : n === 1 ? "1 file" : `${n} files`;
  return ansiPaint("green", `\u2726 Landed ${files} \xB7 undo anytime: zaraacoder undo`, c);
}
function formatApplyNextLine(remainingCount, options = {}) {
  const c = options.color === true;
  if (remainingCount > 0) {
    const pathHint = options.firstFile?.trim() ? ` \xB7 ${clipText(options.firstFile.trim(), 40)}` : "";
    const label = remainingCount === 1 ? `1 file still pending${pathHint}` : `${remainingCount} files still pending${pathHint}`;
    return `${ansiPaint("cyan", "Next:", c)} zaraacoder accept 1   # ${label} (or: accept all)`;
  }
  return `${ansiPaint("cyan", "Next:", c)} zaraacoder verify   (undo if needed: zaraacoder undo)`;
}
function formatRunOutcomeLines(input) {
  const c = input.color === true;
  const elapsed = formatElapsedShort(input.elapsedMs);
  const status = input.status.toLowerCase();
  if (status === "ready") {
    return formatDoneCelebrationLines({
      elapsedMs: input.elapsedMs,
      fileCount: input.fileCount,
      color: c
    });
  }
  if (status === "blocked") {
    const detail = input.blockedMessage?.trim() ? clipText(input.blockedMessage.replace(/\s+/g, " ").trim(), 90) : "needs your input";
    return [
      ansiPaint("yellow", `\u25B2 Blocked \xB7 ${elapsed}  \xB7  ${detail}`, c),
      ansiPaint("dim", "  read the Blocked/Next lines below \u2014 nothing was applied", c)
    ];
  }
  if (status === "failed" || status === "error") {
    const detail = input.blockedMessage?.trim() ? clipText(input.blockedMessage.replace(/\s+/g, " ").trim(), 90) : "run failed";
    return [
      ansiPaint("red", `\xD7 Failed \xB7 ${elapsed}  \xB7  ${detail}`, c),
      ansiPaint("dim", "  try a smaller task or zaraacoder doctor", c)
    ];
  }
  return [
    ansiPaint("dim", `\xB7 Finished \xB7 ${elapsed}  \xB7  status ${input.status}`, c)
  ];
}
function formatFileContentPreviewRows(displayPath, content, maxLines = 40) {
  const lines = content ? content.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const clipped = lines.slice(0, maxLines);
  return [
    `Preview ${displayPath}:`,
    ...clipped,
    ...lines.length > maxLines ? [`\u2026 (${lines.length - maxLines} more lines)`] : []
  ];
}
async function buildReadyFilePreviewRows(input) {
  if (input.repoPath?.trim()) {
    try {
      const diffFn = input.diffSessionFiles ?? diffSessionFiles;
      const patch = await diffFn({
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        files: [input.relativePath]
      });
      if (patch.trim()) {
        return formatDiffPreviewRows(input.displayPath, patch, 60, {
          color: input.color === true
        });
      }
    } catch {
    }
  }
  if (!input.readTextFile) return null;
  try {
    const text = await input.readTextFile(input.absolutePath);
    return formatFileContentPreviewRows(input.displayPath, text);
  } catch {
    return null;
  }
}
async function renderWireZero(io, deps, json) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const { loadGatewayApiKey } = await import("./gateway-client-XTJHNZIL.js");
  const apiKey = loadGatewayApiKey();
  if (!apiKey) {
    io.error(
      "No gateway API key. Set gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY."
    );
    return 1;
  }
  const zeroPath = join(homedir(), ".local", "bin", "zero");
  let resolvedZero = await (deps.resolveCommand ?? resolveCommand)("zero");
  if (!resolvedZero) {
    try {
      const { access } = await import("fs/promises");
      await access(zeroPath);
      resolvedZero = zeroPath;
    } catch {
      io.error("Zero CLI not found. Install to ~/.local/bin/zero first.");
      return 1;
    }
  }
  const url = `http://127.0.0.1:${port}/mcp`;
  const report = {
    zero: resolvedZero,
    url,
    steps: []
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      resolvedZero,
      [
        "mcp",
        "add",
        "zaraa",
        "--type",
        "http",
        "--url",
        url,
        "--header",
        `X-Api-Key=${apiKey}`
      ],
      { timeout: 3e4 }
    );
    report.steps.push("mcp-add-ok");
    if (stdout.trim()) report.addStdout = stdout.trim();
    if (stderr.trim()) report.addStderr = stderr.trim();
  } catch (error) {
    const msg = errorMessage(error);
    report.steps.push("mcp-add-failed");
    report.error = msg;
    if (json) {
      io.log(JSON.stringify(report));
    } else {
      io.error(`zero mcp add zaraa failed: ${msg}`);
    }
    return 1;
  }
  try {
    const { stdout } = await execFileAsync(
      resolvedZero,
      ["mcp", "check", "zaraa", "--json"],
      { timeout: 3e4 }
    );
    report.steps.push("mcp-check-ok");
    report.check = JSON.parse(stdout);
  } catch (error) {
    report.steps.push("mcp-check-failed");
    report.checkError = errorMessage(error);
  }
  try {
    const { loadLocalZaraaConfig } = await import("./gateway-client-XTJHNZIL.js");
    const cfg = loadLocalZaraaConfig().data;
    const gbrain = cfg?.mcp?.servers?.find((s) => s.name === "gbrain" && s.enabled !== false);
    if (gbrain?.url) {
      report.steps.push("gbrain-url-found");
      report.gbrainHint = `Optional: zero mcp add gbrain --type http --url ${gbrain.url} --header "Authorization=Bearer <gbrain-token>"`;
    }
  } catch {
  }
  if (json) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatWireZeroSuccessLines({
      zeroPath: String(resolvedZero),
      url,
      checkOk: Boolean(report.check),
      checkError: typeof report.checkError === "string" ? report.checkError : void 0,
      gbrainHint: typeof report.gbrainHint === "string" ? report.gbrainHint : void 0
    })) {
      io.log(line);
    }
  }
  return report.check ? 0 : 0;
}
function formatWireZeroSuccessLines(input) {
  const lines = [
    input.checkOk ? "Wire \xB7 ok" : "Wire \xB7 partial",
    `  zero \xB7 ${input.zeroPath}`,
    `  mcp \xB7 ${input.url}`,
    "  auth \xB7 X-Api-Key (local config)"
  ];
  if (input.checkOk) {
    lines.push("  check \xB7 ok \u2014 tools available from Zero TUI");
  } else if (input.checkError) {
    lines.push(`  check \xB7 failed \xB7 ${clipText(input.checkError, 60)}`);
    lines.push("  tip \xB7 start daemon, then: zero mcp check zaraa --json");
  }
  if (input.gbrainHint) lines.push(`  gbrain \xB7 ${clipText(input.gbrainHint, 72)}`);
  lines.push("Next: zero auth   # OAuth for Claude/Codex if needed");
  lines.push("Then: zaraacoder northstar   # truth packet");
  return lines;
}
async function renderTonight(io, deps, json) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const zeroPath = await (deps.resolveCommand ?? resolveCommand)("zero") ?? join(homedir(), ".local", "bin", "zero");
  const report = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ready: false,
    provider: null,
    steps: [],
    commands: [],
    notes: []
  };
  const truth = await callZaraaMcpTool(port, "truth", {}, deps);
  report.truthOk = truth.ok;
  if (truth.ok) {
    try {
      report.truth = JSON.parse(truth.text);
    } catch {
      report.truthText = truth.text;
    }
  } else {
    report.notes.push(`Zaraa MCP truth failed: ${truth.text}`);
  }
  let logins = [];
  try {
    const { stdout } = await execFileAsync(zeroPath, ["auth", "status", "--json"], {
      timeout: 15e3
    });
    const parsed = JSON.parse(stdout);
    logins = Array.isArray(parsed.logins) ? parsed.logins : [];
    report.logins = logins.map((l) => ({
      key: l.key,
      expired: l.expired,
      expiresAt: l.expiresAt
    }));
  } catch (error) {
    report.notes.push(`zero auth status failed: ${errorMessage(error)}`);
  }
  const hasChatgpt = logins.some((l) => l.key === "provider:chatgpt" && !l.expired);
  const hasXai = logins.some((l) => l.key === "provider:xai" && !l.expired);
  const candidates = [];
  if (hasXai) {
    candidates.push({
      id: "xai",
      setup: ["setup", "xai", "--model", "grok-4", "--json"],
      smoke: "TONIGHT_XAI_OK"
    });
  }
  if (hasChatgpt) {
    candidates.push({
      id: "chatgpt",
      setup: ["setup", "chatgpt", "--model", "gpt-5.5", "--json"],
      smoke: "TONIGHT_CHATGPT_OK"
    });
  }
  candidates.push({
    id: "ollama-local",
    setup: [
      "setup",
      "ollama",
      "--name",
      "Ollama Local",
      "--model",
      "gemma4-e4b-qat-zaraa:latest",
      "--base-url",
      "http://localhost:11434/v1",
      "--json"
    ],
    smoke: "TONIGHT_LOCAL_OK"
  });
  let chosen = null;
  for (const candidate of candidates) {
    try {
      await execFileAsync(zeroPath, candidate.setup, { timeout: 3e4 });
      const { stdout, stderr } = await execFileAsync(
        zeroPath,
        [
          "exec",
          "--cwd",
          "/tmp",
          "--auto",
          "low",
          "--max-turns",
          "2",
          "--output-format",
          "text",
          "--prompt",
          `Reply with exactly: ${candidate.smoke}`
        ],
        { timeout: 9e4 }
      );
      const out = `${stdout}
${stderr}`;
      if (out.includes(candidate.smoke) && !/rate limit|auth error|invalid/i.test(out)) {
        chosen = candidate.id;
        report.steps.push(`provider-ok:${candidate.id}`);
        break;
      }
      report.steps.push(`provider-skip:${candidate.id}`);
      if (/rate limit/i.test(out)) {
        report.notes.push(`${candidate.id}: rate limited \u2014 trying next`);
      }
    } catch (error) {
      report.steps.push(`provider-fail:${candidate.id}`);
      const msg = errorMessage(error);
      if (/rate limit/i.test(msg)) {
        report.notes.push(`${candidate.id}: rate limited`);
      } else {
        report.notes.push(`${candidate.id}: ${msg.slice(0, 160)}`);
      }
    }
  }
  report.provider = chosen;
  try {
    const { stdout } = await execFileAsync(zeroPath, ["mcp", "list"], { timeout: 15e3 });
    if (!/\bzaraa\b/i.test(stdout)) {
      report.steps.push("mcp-missing");
      await renderWireZero(
        { log: () => {
        }, error: () => {
        } },
        deps,
        true
      );
      report.steps.push("mcp-rewired");
    } else {
      report.steps.push("mcp-ok");
    }
  } catch (error) {
    report.notes.push(`mcp list failed: ${errorMessage(error)}`);
  }
  const repo = process.cwd();
  const commands = [
    `cd ${repo}`,
    "zaraacoder northstar",
    "zero                    # TUI \u2014 MCP tool: truth",
    `zaraacoder "one small safe task"   # worktree path (Zero-first, Codex fallback)`,
    "zaraacoder preview 1 && zaraacoder accept 1"
  ];
  if (!hasXai) {
    commands.push("ZERO_OAUTH_ALLOW_PRESETS=1 zero auth login xai   # if Grok expires");
  }
  if (!hasChatgpt) {
    commands.push("zero auth chatgpt   # if you want ChatGPT again");
  }
  report.commands = commands;
  report.ready = Boolean(chosen && truth.ok);
  report.zaraacoderBackend = "zero (codex fallback)";
  report.claudeNote = "Claude Max stays on `claude` CLI / Zaraa claude-cli \u2014 Zero 0.1.0 cannot use Claude Code OAuth";
  if (json) {
    io.log(JSON.stringify(report, null, 2));
    return report.ready ? 0 : 1;
  }
  for (const line of formatTonightCardLines({
    ready: Boolean(report.ready),
    codingProvider: chosen ?? "none",
    mcpOk: truth.ok,
    hasChatgpt,
    hasXai,
    commands,
    notes: report.notes,
    claudeNote: String(report.claudeNote ?? "")
  })) {
    io.log(line);
  }
  return report.ready ? 0 : 1;
}
function formatTonightCardLines(input) {
  const lines = [
    input.ready ? "Tonight \xB7 ready" : "Tonight \xB7 blocked",
    `  coding \xB7 ${input.codingProvider}`,
    `  mcp \xB7 ${input.mcpOk ? "ok" : "down"}`,
    `  logins \xB7 chatgpt=${input.hasChatgpt ? "yes" : "no"} \xB7 xai=${input.hasXai ? "yes" : "no"}`,
    "  executor \xB7 Zero-first (Codex fallback)",
    "How:",
    "  1 \xB7 Zaraa northstar (truth when unsure)",
    "  2 \xB7 Zero TUI or zaraacoder run \u2192 preview \u2192 accept",
    "Run:",
    ...input.commands.map((cmd) => `  ${cmd}`)
  ];
  if (input.notes?.length) {
    lines.push("Notes:");
    for (const n of input.notes.slice(0, 5)) lines.push(`  \xB7 ${n}`);
  }
  if (input.claudeNote?.trim()) {
    lines.push(`  claude \xB7 ${clipText(input.claudeNote.trim(), 90)}`);
  }
  lines.push(
    input.ready ? 'Next: zaraacoder --lane claude "one small safe task"' : "Next: zaraacoder doctor | zaraacoder wire-zero"
  );
  return lines;
}
async function renderNow(io, deps) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const [{ formatEventRow, normalizeTerminalEvent }, gatewayDiagnostics] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    deps.collectGatewayAccessSnapshot ? Promise.resolve({ collectGatewayAccessSnapshot: deps.collectGatewayAccessSnapshot }) : import("./gateway-diagnostics-CWMKN65K.js")
  ]);
  const [selection, snapshot, standaloneCommandPath, changes, execution, generation] = await Promise.all([
    loadCurrentRepoSessionSelection(deps),
    gatewayDiagnostics.collectGatewayAccessSnapshot(port),
    (deps.resolveCommand ?? resolveCommand)("zaraacoder"),
    (deps.listRepoChanges ?? listRepoChanges)(process.cwd()),
    (deps.requestGatewayJson ?? requestGatewayJson)(port, "/api/tasks/execution"),
    (deps.requestGatewayJson ?? requestGatewayJson)(
      port,
      "/api/tasks/generation"
    )
  ]);
  const session = selection?.session ?? null;
  let latest = "none";
  if (session) {
    const lines = await readTraceLines(session, io, deps);
    if (!lines) return 1;
    const latestEvent = lines.map(
      (line) => normalizeTerminalEvent(parseTraceLine(line))
    ).at(-1);
    if (latestEvent) latest = formatEventRow(latestEvent);
  }
  if (session) {
    io.log(`Now \xB7 ${displaySessionPhase(session)}${formatListChangedHint(session)}`);
  } else {
    io.log("Now \xB7 idle");
  }
  io.log(`  stack \xB7 ${standaloneCommandPath && snapshot.daemonDetected ? "ok" : "check doctor"}`);
  if (generation.ok && generation.data) {
    io.log(`  generation \xB7 ${generation.data.paused ? "paused" : "open"}`);
  }
  if (execution.ok && execution.data) {
    const cap = execution.data.effectiveMaxConcurrency ?? execution.data.maxConcurrency ?? "?";
    io.log(
      `  exec \xB7 ${execution.data.paused ? "paused" : "open"} \xB7 cap ${cap} \xB7 active ${execution.data.activeCount ?? 0}`
    );
  }
  const changeCount = changes.length === 1 && changes[0] === GIT_STATUS_TIMEOUT_SENTINEL ? -1 : changes.filter((line) => line !== GIT_STATUS_TIMEOUT_SENTINEL).length;
  io.log(
    changeCount < 0 ? "  repo \xB7 status timed out" : changeCount === 0 ? "  repo \xB7 clean" : `  repo \xB7 ${changeCount} uncommitted`
  );
  if (session) {
    io.log(`  task \xB7 ${clipText(session.task, 72)}`);
    if ((session.changedFiles?.length ?? 0) > 1) {
      for (const row of formatRunChangedFilesRows(
        session.worktreePath,
        session.changedFiles ?? []
      )) {
        io.log(row);
      }
    }
    if (latest !== "none") {
      const latestClean = latest.replace(/^[·◆✓×!◇■›⚙💭⚠]\s+/u, "");
      io.log(`  latest \xB7 ${latestClean}`);
    }
  } else {
    io.log("  session \xB7 none");
  }
  io.log(
    nextOperatorStep({
      phase: session?.phase,
      reviewStatus: session?.reviewStatus,
      changedFiles: session?.changedFiles,
      sessionRef: selection?.sessionRef
    })
  );
  return 0;
}
function formatBurnInResultLines(input) {
  const detail = input.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failed = input.code !== 0;
  const lines = [
    failed ? "Burnin \xB7 failed" : "Burnin \xB7 ok",
    ...detail.map((line) => `  \xB7 ${line}`)
  ];
  if (input.stderr?.trim()) {
    for (const line of input.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      lines.push(`  \u26A0 ${line}`);
    }
  }
  lines.push(
    failed ? "Next: zaraacoder wire-zero | zaraacoder doctor" : 'Next: zaraacoder doctor   # then: zaraacoder --lane claude "\u2026"'
  );
  return lines;
}
async function renderBurnIn(io, deps) {
  const result = await (deps.runZeroBurnIn ?? runZeroBurnIn)();
  for (const line of formatBurnInResultLines({
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  })) {
    if (line.startsWith("  \u26A0 ")) io.error(line.slice(4));
    else io.log(line);
  }
  return result.code;
}
async function renderOpen(args, io, deps) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const [{ resolveOpenTarget }, session] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    loadCurrentRepoSession(deps)
  ]);
  const resolved = resolveOpenTarget(session, {
    port,
    sessionId: session?.sessionId ?? "",
    target: args.target
  });
  if (!resolved.ok) {
    io.error(resolved.error.replace("/open", "zaraacoder open"));
    return 1;
  }
  await (deps.openExternal ?? openExternal)(resolved.target);
  const { formatOpenResultLines } = await import("./zaraacoder-attach-GKSYEL2B.js");
  for (const row of formatOpenResultLines(resolved.label, resolved.target, {
    session,
    surface: "standalone"
  })) {
    io.log(row);
  }
  return 0;
}
async function renderBrief(io, deps) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const [{ formatOperatorBrief, normalizeTerminalEvent }, selection] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    loadCurrentRepoSessionSelection(deps)
  ]);
  const session = selection?.session ?? null;
  const lines = session && deps.readTextFile ? await readTraceLines(session, io, deps) : [];
  if (!lines) return 1;
  const events = lines.map(
    (line) => normalizeTerminalEvent(parseTraceLine(line))
  );
  for (const row of formatOperatorBrief(session, events, {
    port,
    sessionId: session?.sessionId ?? "latest",
    surface: "standalone",
    sessionRef: selection?.sessionRef
  })) {
    io.log(row);
  }
  return 0;
}
async function renderWhere(io, deps) {
  const { formatWhereRows } = await import("./zaraacoder-attach-GKSYEL2B.js");
  const selection = await loadCurrentRepoSessionSelection(deps);
  const session = selection?.session ?? null;
  for (const row of formatWhereRows(session, process.cwd())) io.log(row);
  io.log(
    nextChangedFileCommand(sessionNextStatus(session), session?.changedFiles ?? [], selection?.sessionRef) ?? "Next: zaraacoder status | zaraacoder handoff"
  );
  return 0;
}
async function renderFeed(io, deps) {
  const [{ formatFeedRows, normalizeTerminalEvent }, selection] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    loadCurrentRepoSessionSelection(deps)
  ]);
  const session = selection?.session ?? null;
  if (!session) {
    io.log("Feed \xB7 no session");
    for (const row of formatFeedRows([])) io.log(row);
    io.log('Next: zaraacoder "<task>"');
    return 0;
  }
  const lines = await readTraceLines(session, io, deps);
  if (!lines) return 1;
  const events = lines.map(
    (line) => normalizeTerminalEvent(parseTraceLine(line))
  );
  io.log(
    `Feed \xB7 ${displaySessionPhase(session)}${formatListChangedHint(session)}`
  );
  for (const row of formatFeedRows(events)) io.log(row);
  io.log(
    nextChangedFileCommand(sessionNextStatus(session), session.changedFiles ?? [], selection?.sessionRef) ?? "Next: zaraacoder status | zaraacoder handoff"
  );
  return 0;
}
async function renderPromote(args, io, deps) {
  const [{ formatPromoteRows }, session] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    loadCurrentRepoSession(deps)
  ]);
  for (const row of formatPromoteRows(session, args.filePath)) io.log(row);
  return 0;
}
async function renderShow(args, io, deps) {
  if (!deps.readTextFile) {
    reportSessionLoadError(io, "reader");
    return 1;
  }
  const [{ formatShowFilePreview, resolveShowFilePath }, session] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    args.sessionId ? loadSessionSnapshot(args.sessionId, {}, io, deps) : loadCurrentRepoSession(deps)
  ]);
  if (args.sessionId && !session) return 1;
  if (session && args.sessionId && !isActionableSession(session)) {
    io.error(previewBlockedReason(session) ?? "Preview blocked.");
    io.log(
      nextOperatorStep({
        phase: session.phase,
        reviewStatus: session.reviewStatus,
        changedFiles: session.changedFiles
      })
    );
    return 1;
  }
  let selectedSession = session;
  let selectedSessionId = args.sessionId;
  let filePath = resolveShowFilePath(session, args.filePath);
  if (!filePath && !args.sessionId && /^[1-9]\d*$/.test(args.filePath)) {
    const fallbackSession = await loadSessionSnapshot(
      args.filePath,
      {},
      { log: () => void 0, error: () => void 0 },
      deps
    );
    if (fallbackSession && !isActionableSession(fallbackSession)) {
      io.error(previewBlockedReason(fallbackSession) ?? "Preview blocked.");
      io.log(
        nextOperatorStep({
          phase: fallbackSession.phase,
          reviewStatus: fallbackSession.reviewStatus,
          changedFiles: fallbackSession.changedFiles
        })
      );
      return 1;
    }
    const fallbackFilePath = resolveShowFilePath(fallbackSession, "1");
    if (fallbackFilePath) {
      selectedSession = fallbackSession;
      selectedSessionId = nextCommandSessionRef(args.filePath);
      filePath = fallbackFilePath;
    }
  }
  if (selectedSession && !isActionableSession(selectedSession)) {
    io.error(previewBlockedReason(selectedSession) ?? "Preview blocked.");
    io.log(
      nextOperatorStep({
        phase: selectedSession.phase,
        reviewStatus: selectedSession.reviewStatus,
        changedFiles: selectedSession.changedFiles
      })
    );
    return 1;
  }
  if (!filePath) {
    if (/^[1-9]\d*$/.test(args.filePath) && !session?.changedFiles?.length) {
      io.error("Preview \xB7 no recorded edits");
      io.log('Next: zaraacoder status | zaraacoder "<task>"');
      return 1;
    }
    io.error("Preview \xB7 file not in worktree");
    io.log("Next: zaraacoder status | zaraacoder diff");
    return 1;
  }
  const displayPath = selectedSession ? displaySessionPath(selectedSession, filePath) : filePath;
  const colorDiff = deps.isTTY === true || deps.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
  const previewRows = selectedSession?.repoPath && selectedSession.worktreePath ? await buildReadyFilePreviewRows({
    displayPath,
    absolutePath: filePath,
    relativePath: displayPath,
    repoPath: selectedSession.repoPath,
    worktreePath: selectedSession.worktreePath,
    readTextFile: deps.readTextFile,
    diffSessionFiles: deps.diffSessionFiles,
    color: colorDiff
  }) : formatShowFilePreview(displayPath, await deps.readTextFile(filePath));
  if (previewRows) {
    for (const row of previewRows) io.log(row);
  } else {
    for (const row of formatShowFilePreview(displayPath, await deps.readTextFile(filePath))) {
      io.log(row);
    }
  }
  io.log(formatShowNextCommand(selectedSession, displayPath, selectedSessionId));
  return 0;
}
function formatShowNextCommand(session, displayPath, sessionId) {
  if (session && !canAcceptSession(session)) {
    return session.phase === "cancelled" ? 'Next: zaraacoder "<task>"  # dismissed; start a new run' : `Next: zaraacoder status${sessionId ? ` ${sessionId}` : ""}`;
  }
  const files = session?.changedFiles ?? [];
  const selectedIndex = files.findIndex((changedFile) => {
    const sourcePath = isAbsolute(changedFile) ? changedFile : join(session?.worktreePath ?? "", changedFile);
    return (session?.worktreePath ? relative(session.worktreePath, sourcePath) : changedFile) === displayPath;
  });
  if (selectedIndex < 0) {
    return `Next: zaraacoder diff${sessionId ? ` ${sessionId}` : ""}`;
  }
  const acceptCmd = sessionId ? `zaraacoder accept ${sessionId} ${selectedIndex + 1}` : `zaraacoder accept ${selectedIndex + 1}`;
  const remainingAfter = files.length - selectedIndex - 1;
  if (remainingAfter <= 0) {
    return `Next: ${acceptCmd}`;
  }
  const nextFile = files[selectedIndex + 1];
  const nextPath = clipText(
    displaySessionPath(
      { worktreePath: session?.worktreePath ?? void 0 },
      nextFile
    ),
    36
  );
  const previewCmd = sessionId ? `preview ${sessionId} ${selectedIndex + 2}` : `preview ${selectedIndex + 2}`;
  const more = remainingAfter === 1 ? `or: ${previewCmd} \xB7 ${nextPath}` : `or: ${previewCmd} \xB7 ${nextPath} (${remainingAfter} more)`;
  return `Next: ${acceptCmd}   # ${more}`;
}
async function renderApply(args, io, deps) {
  const [{ formatApplyResultRows, resolveApplyOperations }, loadedSession] = await Promise.all([
    import("./zaraacoder-attach-GKSYEL2B.js"),
    args.sessionId ? loadSessionSnapshot(args.sessionId, {}, io, deps) : loadCurrentRepoSession(deps)
  ]);
  if (args.sessionId && !loadedSession) return 1;
  let session = loadedSession;
  if (session && !canAcceptSession(session)) {
    io.error(acceptBlockedReason(session) ?? "Accept blocked.");
    io.log(
      nextOperatorStep({
        phase: session.phase,
        reviewStatus: session.reviewStatus,
        changedFiles: session.changedFiles
      })
    );
    return 1;
  }
  let filePath = args.filePath;
  let plan = resolveApplyOperations(session, filePath);
  if (!args.sessionId && filePath && /^[1-9]\d*$/.test(filePath) && !plan.ok && // Accept · no file at index N → try rebinding number as session id
  plan.rows.some((row) => row.startsWith(`Accept \xB7 no file at index ${filePath}`))) {
    const fallbackSession = await loadSessionSnapshot(
      filePath,
      {},
      { log: () => void 0, error: () => void 0 },
      deps
    );
    if (fallbackSession && !canAcceptSession(fallbackSession)) {
      io.error(acceptBlockedReason(fallbackSession) ?? "Accept blocked.");
      io.log(
        nextOperatorStep({
          phase: fallbackSession.phase,
          reviewStatus: fallbackSession.reviewStatus,
          changedFiles: fallbackSession.changedFiles
        })
      );
      return 1;
    }
    const fallbackPlan = resolveApplyOperations(fallbackSession, "1");
    if (fallbackPlan.ok) {
      session = fallbackSession;
      filePath = "1";
      plan = fallbackPlan;
    }
  }
  if (session && !canAcceptSession(session)) {
    io.error(acceptBlockedReason(session) ?? "Accept blocked.");
    io.log(
      nextOperatorStep({
        phase: session.phase,
        reviewStatus: session.reviewStatus,
        changedFiles: session.changedFiles
      })
    );
    return 1;
  }
  if (!plan.ok) {
    for (const row of plan.rows) io.log(row);
    return 1;
  }
  const dirtyPaths = await (deps.dirtyApplyTargets ?? dirtyApplyTargets)(session?.repoPath ?? "", plan.operations);
  const applyRows = resolveApplyOperations(session, filePath, dirtyPaths);
  if (!applyRows.ok) {
    for (const row of applyRows.rows) io.log(row);
    return 1;
  }
  const fs = await import("fs/promises");
  const makeDirectory = deps.makeDirectory ?? (async (path) => {
    await fs.mkdir(path, { recursive: true });
  });
  const copyPath = deps.copyFile ?? fs.copyFile;
  const writeTextFile = deps.writeTextFile ?? ((path, content) => fs.writeFile(path, content, "utf-8"));
  const pathExists = deps.pathExists ?? (async (path) => {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  });
  await writeUndoRecord({
    repoPath: session?.repoPath ?? process.cwd(),
    sessionId: session?.sessionId,
    operations: applyRows.operations,
    makeDirectory,
    copyFile: copyPath,
    writeTextFile,
    pathExists
  });
  for (const operation of applyRows.operations) {
    await makeDirectory(dirname(operation.targetPath));
    await copyPath(operation.sourcePath, operation.targetPath);
  }
  try {
    await (deps.verifyRepoDiff ?? verifyRepoDiff)(session?.repoPath ?? process.cwd());
    const appliedFiles = new Set(
      applyRows.operations.flatMap((operation) => [operation.relativePath, operation.sourcePath])
    );
    const remainingFiles = session.changedFiles.filter((file) => !appliedFiles.has(file));
    await createSessionStore({}, io, deps)?.append?.({
      ...session,
      changedFiles: remainingFiles,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    for (const row of formatApplyResultRows({
      appliedCount: applyRows.operations.length,
      appliedFiles: applyRows.operations.map((operation) => operation.relativePath),
      skipped: applyRows.skipped,
      verify: { ok: true }
    })) io.log(row);
    const applyColor = deps.isTTY === true || deps.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
    io.log(
      formatApplyLandedLine({
        color: applyColor,
        fileCount: applyRows.operations.length
      })
    );
    const nextPending = remainingFiles.length > 0 ? displaySessionPath(session, remainingFiles[0]) : void 0;
    io.log(
      formatApplyNextLine(remainingFiles.length, {
        color: applyColor,
        firstFile: nextPending
      })
    );
    return 0;
  } catch (error) {
    for (const row of formatApplyResultRows({
      appliedCount: applyRows.operations.length,
      appliedFiles: applyRows.operations.map((operation) => operation.relativePath),
      skipped: applyRows.skipped,
      verify: { ok: false, error: errorMessage(error) }
    })) io.log(row);
    io.log("Next: zaraacoder undo");
    return 1;
  }
}
function undoRoot(repoPath) {
  return join(
    resolveRuntimeHomeDir(),
    ".zaraa",
    "zaraacoder",
    "undo",
    Buffer.from(resolve(repoPath)).toString("base64url")
  );
}
function undoRecordPath(repoPath) {
  return join(undoRoot(repoPath), "last.json");
}
async function hasUndoRecord(repoPath, deps) {
  const fs = await import("fs/promises");
  const pathExists = deps.pathExists ?? (async (path) => {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  });
  return pathExists(undoRecordPath(repoPath));
}
async function writeUndoRecord(input) {
  const repoPath = resolve(input.repoPath);
  const backupRoot = join(undoRoot(repoPath), input.sessionId ?? "latest");
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
    undoRecordPath(repoPath),
    `${JSON.stringify({ repoPath, sessionId: input.sessionId, files }, null, 2)}
`
  );
}
async function renderUndo(io, deps) {
  const repoPath = resolve(process.cwd());
  const recordPath = undoRecordPath(repoPath);
  const fs = await import("fs/promises");
  const readTextFile = deps.readTextFile ?? ((path) => fs.readFile(path, "utf-8"));
  const makeDirectory = deps.makeDirectory ?? ((path) => fs.mkdir(path, { recursive: true }));
  const copyPath = deps.copyFile ?? fs.copyFile;
  const removePath = deps.removePath ?? ((path) => fs.rm(path, { force: true }));
  let record = null;
  try {
    record = parseUndoRecord(await readTextFile(recordPath));
  } catch {
  }
  if (!record || resolve(record.repoPath) !== repoPath || record.files.length === 0) {
    io.error("Undo \xB7 none recorded");
    io.log("Next: zaraacoder accept 1   # accept something first");
    return 1;
  }
  for (const file of record.files) {
    if (file.existed) {
      if (!file.backupPath) {
        io.error(`Undo \xB7 missing backup \xB7 ${file.relativePath}`);
        io.log("Next: zaraacoder changes | zaraacoder verify");
        return 1;
      }
      await makeDirectory(dirname(file.targetPath));
      await copyPath(file.backupPath, file.targetPath);
    } else {
      await removePath(file.targetPath);
    }
  }
  try {
    await (deps.verifyRepoDiff ?? verifyRepoDiff)(repoPath);
    if (record.sessionId) {
      const store = deps.createSessionStore?.();
      const session = await store?.latest(record.sessionId);
      if (session && store?.append) {
        const restoredFiles = record.files.map(
          (file) => session.worktreePath ? join(session.worktreePath, file.relativePath) : file.relativePath
        );
        await store.append({
          ...session,
          phase: "ready",
          reviewStatus: "ready",
          changedFiles: [.../* @__PURE__ */ new Set([...session.changedFiles, ...restoredFiles])],
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
    await removePath(recordPath);
    io.log(`Undid ${record.files.length} file(s).`);
    for (const [index, file] of record.files.entries()) io.log(`${index + 1}. ${file.relativePath}`);
    io.log("Verified repo: git diff --check passed.");
    const undoColor = deps.isTTY === true || deps.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
    io.log(
      ansiPaint(
        "yellow",
        "\u21BA Restored \xB7 review with zaraacoder preview 1 (or changes)",
        undoColor
      )
    );
    io.log(record.sessionId ? "Next: zaraacoder preview 1" : "Next: zaraacoder changes | zaraacoder verify");
    return 0;
  } catch (error) {
    io.log(`Undo verify failed: ${errorMessage(error)}`);
    io.log("Next: zaraacoder changes | zaraacoder verify");
    return 1;
  }
}
function parseUndoRecord(raw) {
  try {
    const data = JSON.parse(raw);
    if (typeof data.repoPath !== "string" || !Array.isArray(data.files)) return null;
    const files = [];
    for (const file of data.files) {
      if (!file || typeof file.relativePath !== "string" || typeof file.targetPath !== "string" || typeof file.existed !== "boolean") return null;
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
function formatLinkSuccessLines() {
  return [
    "Link \xB7 ok",
    "  command \xB7 zaraacoder is on your PATH",
    "Next: zaraacoder doctor"
  ];
}
async function renderLink(io, deps) {
  await (deps.linkGlobal ?? linkGlobal)();
  for (const line of formatLinkSuccessLines()) io.log(line);
  return 0;
}
async function renderSessionControl(args, io, deps) {
  const session = args.action === "stop" && args.sessionId ? await loadSessionSnapshot(args.sessionId, {}, io, deps) : await loadCurrentRepoSession(deps);
  if (!session) {
    io.error("Control \xB7 no session");
    io.log('Next: zaraacoder list | zaraacoder "<task>"');
    return 1;
  }
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const body = args.action === "say" ? { action: "user_message", message: args.message } : args.action === "continue" ? { action: "continue", ...args.message ? { message: args.message } : {} } : { action: "stop" };
  const response = await (deps.requestGatewayJson ?? requestGatewayJson)(
    port,
    `/api/zaraacoder/sessions/${encodeURIComponent(session.sessionId)}/control`,
    { method: "POST", body }
  );
  if (!response.ok) {
    io.error(`Control \xB7 failed \xB7 ${response.error ?? `HTTP ${response.status}`}`);
    io.log("Next: zaraacoder doctor | zaraacoder status");
    return 1;
  }
  const { formatControlResultRows } = await import("./zaraacoder-attach-GKSYEL2B.js");
  for (const row of formatControlResultRows(response.data?.event)) io.log(row);
  if (response.data?.event?.kind === "error") return 1;
  if (args.action === "stop") {
    io.log('Next: zaraacoder list   # or: zaraacoder "<task>"');
  } else {
    io.log("Next: zaraacoder feed");
  }
  return 0;
}
async function renderVerify(io, deps) {
  const repoPath = process.cwd();
  const { formatVerifyRows } = await import("./zaraacoder-attach-GKSYEL2B.js");
  const color = deps.isTTY === true || deps.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
  try {
    await (deps.verifyRepoDiff ?? verifyRepoDiff)(repoPath);
    for (const row of formatVerifyRows({ repoPath, ok: true })) io.log(row);
    io.log(ansiPaint("green", "\u2726 Clean \u2014 safe to commit when you're ready", color));
    return 0;
  } catch (error) {
    for (const row of formatVerifyRows({ repoPath, ok: false, error: errorMessage(error) })) {
      io.log(row);
    }
    io.log(
      ansiPaint(
        "red",
        "\xD7 Diff check failed \u2014 fix trailing whitespace / conflict markers",
        color
      )
    );
    return 1;
  }
}
async function renderChanges(io, deps) {
  const repoPath = process.cwd();
  const { formatGitStatusRows } = await import("./zaraacoder-attach-GKSYEL2B.js");
  const lines = await (deps.listRepoChanges ?? listRepoChanges)(repoPath);
  if (lines.length === 1 && lines[0] === GIT_STATUS_TIMEOUT_SENTINEL) {
    io.log("Changes \xB7 timed out");
    io.log(`  repo \xB7 ${repoPath}`);
    io.log("  git status too slow (huge dirty/untracked tree)");
    io.log("  tip \xB7 git status --short --untracked-files=no");
    io.log("Next: zaraacoder status");
    return 1;
  }
  for (const row of formatGitStatusRows(repoPath, lines)) io.log(row);
  const undoAvailable = await hasUndoRecord(repoPath, deps);
  if (undoAvailable) io.log("  undo \xB7 zaraacoder undo");
  io.log(
    lines.length === 0 ? "Next: zaraacoder status" : undoAvailable ? "Next: zaraacoder verify   (or: undo)" : "Next: zaraacoder verify"
  );
  return 0;
}
async function renderGoal(args, io, deps) {
  const store = createSessionStore(args, io, deps);
  if (!store) return 1;
  if (!store.append) {
    reportSessionLoadError(io, "updates");
    return 1;
  }
  const session = args.sessionId === "latest" ? await loadLatestSessionSnapshot(store, io) : await loadStoreSessionSnapshot(store, args.sessionId, io);
  if (!session) return 1;
  const updatedSession = {
    ...session,
    goal: args.goal,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await store.append(updatedSession);
  if (args.json) {
    io.log(JSON.stringify(updatedSession));
    return 0;
  }
  for (const line of formatGoalSetLines(updatedSession)) io.log(line);
  return 0;
}
function formatGoalSetLines(session) {
  const goal = clipText(session.goal ?? "", 72);
  return [
    `Goal \xB7 set${formatListChangedHint(session)}`,
    `  goal \xB7 ${goal}`,
    `  task \xB7 ${clipText(session.task, 56)}`,
    `  id \xB7 ${session.sessionId}`,
    `Next: zaraacoder status ${session.sessionId === "latest" ? "latest" : session.sessionId}`
  ];
}
function formatLearnSuccessLines(trigger, correction) {
  return [
    "Learn \xB7 recorded",
    `  when \xB7 ${clipText(trigger, 56)}`,
    `  do \xB7 ${clipText(correction, 72)}`,
    "Next: zaraacoder doctor   # or keep coding"
  ];
}
async function renderLearn(args, io, deps) {
  const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
  const response = await (deps.requestGatewayJson ?? requestGatewayJson)(
    port,
    "/api/learning/correction",
    { method: "POST", body: { trigger: args.trigger, mistake: args.trigger, suggestion: args.correction } }
  );
  if (!response.ok || response.data?.recorded !== true) {
    io.error(response.error ?? "Correction was not recorded");
    return 1;
  }
  for (const line of formatLearnSuccessLines(args.trigger, args.correction)) io.log(line);
  return 0;
}
async function loadLatestSessionSnapshot(store, io) {
  if (!store.listLatest) {
    reportSessionLoadError(io, "listing");
    return null;
  }
  const [latestSession] = await store.listLatest();
  if (!latestSession) {
    reportSessionLoadError(io, "not-found", "latest");
    return null;
  }
  return latestSession;
}
async function loadStoreSessionSnapshot(store, sessionId, io) {
  const session = await store.latest(sessionId);
  if (!session) {
    reportSessionLoadError(io, "not-found", sessionId);
    return null;
  }
  return session;
}
function formatStatusCardLines(session, options = {}) {
  const phase = displaySessionPhase(session);
  const c = options.color === true;
  const icon = options.icons === true ? `${formatSessionListIcon(session)} ` : "";
  const phasePainted = phase === "ready" ? ansiPaint("green", phase, c) : phase === "stored" ? ansiPaint("dim", phase, c) : session.phase === "blocked" ? ansiPaint("yellow", phase, c) : session.phase === "failed" ? ansiPaint("red", phase, c) : phase;
  const lines = [
    `Status \xB7 ${icon}${phasePainted}${formatListChangedHint(session)}`,
    `  task \xB7 ${clipText(session.task, 72)}`
  ];
  if (session.goal) lines.push(`  goal \xB7 ${clipText(session.goal, 72)}`);
  if (session.reviewStatus && session.reviewStatus !== phase) {
    lines.push(`  review \xB7 ${session.reviewStatus}`);
  }
  if (session.branchName) lines.push(`  branch \xB7 ${clipText(session.branchName, 56)}`);
  if (session.worktreePath) lines.push(`  worktree \xB7 ${session.worktreePath}`);
  lines.push(`  id \xB7 ${session.sessionId}`);
  if (session.tracePath) lines.push(`  trace \xB7 ${session.tracePath}`);
  return lines;
}
async function renderStatus(sessionId, args, io, deps) {
  const session = await loadSessionSnapshot(sessionId, args, io, deps);
  if (!session) return 1;
  if (args.json) {
    io.log(JSON.stringify(session));
    return 0;
  }
  const pretty = deps.isTTY === true || deps.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
  for (const line of formatStatusCardLines(session, { color: pretty, icons: pretty })) {
    io.log(line);
  }
  for (const row of formatRunChangedFilesRows(session.worktreePath, session.changedFiles)) {
    io.log(row);
  }
  io.log(
    nextOperatorStep({
      phase: session.phase,
      reviewStatus: session.reviewStatus,
      changedFiles: session.changedFiles,
      sessionRef: nextCommandSessionRef(sessionId)
    })
  );
  printBlockedReason(io, session.blockedReason);
  return 0;
}
function nonEmptyTraceLines(raw) {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}
function parseTraceLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { line };
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function changedFilesFromTraceEvent(event) {
  if (!isRecord(event) || event.type !== "edit.recorded" || !isRecord(event.data)) {
    return [];
  }
  const paths = event.data.changedFiles;
  if (Array.isArray(paths)) {
    return paths.filter((path2) => typeof path2 === "string");
  }
  const path = event.data.path;
  return typeof path === "string" ? [path] : [];
}
function printBlockedReason(io, blockedReason) {
  if (!blockedReason) return;
  io.log(`Blocked: ${blockedReason.code} - ${blockedReason.message}`);
  io.log(`Next: ${blockedReason.safestNextAction}`);
}
async function readTraceLines(session, io, deps) {
  if (!deps.readTextFile) {
    reportSessionLoadError(io, "reader");
    return null;
  }
  return nonEmptyTraceLines(await deps.readTextFile(session.tracePath));
}
async function renderTrace(sessionId, args, io, deps) {
  const session = await loadSessionSnapshot(sessionId, args, io, deps);
  if (!session) return 1;
  const lines = await readTraceLines(session, io, deps);
  if (!lines) return 1;
  if (args.json) {
    io.log(JSON.stringify(lines.map(parseTraceLine)));
    return 0;
  }
  const { formatFeedRows, normalizeTerminalEvent } = await import("./zaraacoder-attach-GKSYEL2B.js");
  for (const row of formatFeedRows(lines.map(
    (line) => normalizeTerminalEvent(parseTraceLine(line))
  ))) {
    io.log(row);
  }
  io.log(nextChangedFileCommand(sessionNextStatus(session), session.changedFiles ?? [], sessionId === "latest" ? void 0 : sessionId) ?? "Next: zaraacoder status | zaraacoder handoff");
  return 0;
}
async function renderDiff(sessionId, args, io, deps) {
  const session = await loadSessionSnapshot(sessionId, args, io, deps);
  if (!session) return 1;
  const lines = await readTraceLines(session, io, deps);
  if (!lines) return 1;
  const changedFiles = Array.from(new Set(lines.flatMap((line) => changedFilesFromTraceEvent(parseTraceLine(line)))));
  if (args.json) {
    io.log(JSON.stringify(changedFiles));
    return 0;
  }
  if (!changedFiles.length) {
    io.log("No recorded edits.");
    const next2 = nextChangedFileCommand(sessionNextStatus(session), changedFiles, nextCommandSessionRef(sessionId));
    if (next2) io.log(next2);
    return 0;
  }
  const next = nextChangedFileCommand("ready", changedFiles, nextCommandSessionRef(sessionId));
  const patch = await readSessionDiffPatch(session, changedFiles, deps);
  if (patch) {
    io.log("Patch:");
    for (const line of clippedPatchLines(patch)) io.log(line);
    if (next) io.log(next);
    return 0;
  }
  changedFiles.forEach((file, index) => {
    io.log(`${index + 1}. ${displaySessionPath(session, file)}`);
  });
  if (next) io.log(next);
  return 0;
}
async function readSessionDiffPatch(session, changedFiles, deps) {
  if (!session.repoPath || !session.worktreePath) return null;
  try {
    const patch = await (deps.diffSessionFiles ?? diffSessionFiles)({
      repoPath: session.repoPath,
      worktreePath: session.worktreePath,
      files: changedFiles
    });
    return patch.trim() ? patch.trimEnd() : null;
  } catch {
    return null;
  }
}
function clippedPatchLines(patch, limit = 220) {
  const lines = patch.split(/\r?\n/);
  return lines.length > limit ? [...lines.slice(0, limit), `... truncated ${lines.length - limit} line(s)`] : lines;
}
function displaySessionPath(session, filePath) {
  if (!session.worktreePath) return filePath;
  const sourcePath = isAbsolute(filePath) ? filePath : join(session.worktreePath, filePath);
  return relative(session.worktreePath, sourcePath) || filePath;
}
function formatHandoffLines(session, sessionRef) {
  const phase = displaySessionPhase(session);
  const filesLabel = formatChangedFilesLabel(session.worktreePath, session.changedFiles);
  const handoffRisks = (session.handoffRisks ?? []).filter(
    (risk) => typeof risk === "string" && risk.trim().length > 0
  );
  const lines = [
    `Handoff \xB7 ${phase}${formatListChangedHint(session)}`,
    `  task \xB7 ${clipText(session.task, 72)}`
  ];
  if (session.goal) lines.push(`  goal \xB7 ${clipText(session.goal, 72)}`);
  if (session.handoffSummary) {
    lines.push(`  summary \xB7 ${clipText(session.handoffSummary, 72)}`);
  }
  if (session.branchName) lines.push(`  branch \xB7 ${clipText(session.branchName, 56)}`);
  if (session.worktreePath) lines.push(`  worktree \xB7 ${session.worktreePath}`);
  lines.push(`  id \xB7 ${session.sessionId}`);
  lines.push(`  files \xB7 ${filesLabel}`);
  for (const risk of handoffRisks.slice(0, 3)) {
    lines.push(`  risk \xB7 ${clipText(risk, 72)}`);
  }
  if (handoffRisks.length > 3) {
    lines.push(`  risk \xB7 +${handoffRisks.length - 3} more`);
  }
  if (sessionNextStatus(session) === "ready" && (session.changedFiles?.length ?? 0) > 0) {
    const next = nextChangedFileCommand(
      sessionNextStatus(session),
      session.changedFiles,
      nextCommandSessionRef(sessionRef)
    );
    if (next) lines.push(next);
  }
  if (session.blockedReason) {
    lines.push(`Blocked: ${session.blockedReason.code} - ${session.blockedReason.message}`);
    lines.push(`Next: ${session.blockedReason.safestNextAction}`);
  }
  lines.push("Commands:");
  for (const command of handoffCommands(session, sessionRef)) {
    lines.push(command);
  }
  return lines;
}
async function renderHandoff(sessionId, args, io, deps) {
  const session = await loadSessionSnapshot(sessionId, args, io, deps);
  if (!session) return 1;
  const cmdRef = handoffCommandSessionRef(sessionId);
  if (args.json) {
    io.log(
      JSON.stringify({
        sessionId: session.sessionId,
        task: session.task,
        goal: session.goal,
        phase: session.phase,
        review: session.reviewStatus ?? "n/a",
        branch: session.branchName ?? "n/a",
        worktree: session.worktreePath ?? "n/a",
        trace: session.tracePath,
        changedFiles: session.changedFiles,
        summary: session.handoffSummary ?? null,
        risks: session.handoffRisks ?? [],
        blockedReason: session.blockedReason,
        commands: handoffCommands(session, cmdRef)
      })
    );
    return 0;
  }
  for (const line of formatHandoffLines(session, cmdRef)) io.log(line);
  return 0;
}
function handoffCommandSessionRef(sessionId) {
  return sessionId === "latest" ? "1" : sessionId;
}
function handoffCommands(session, sessionId) {
  const readyWithFiles = sessionNextStatus(session) === "ready" && (session.changedFiles?.length ?? 0) > 0;
  const commands = [];
  if (readyWithFiles) {
    commands.push(zaraacoderCommand(["preview", sessionId, "1"]));
    commands.push(zaraacoderCommand(["accept", sessionId, "1"]));
  }
  commands.push(
    zaraacoderCommand(["status", sessionId]),
    zaraacoderCommand(["diff", sessionId]),
    zaraacoderCommand(["list", "--repo", session.repoPath, "--limit", "5"])
  );
  if (readyWithFiles) commands.push(zaraacoderCommand(["undo"]));
  return commands;
}
function zaraacoderCommand(args) {
  return `zaraacoder ${args.map(shellArg).join(" ")}`;
}
function shellArg(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function formatRunSummaryMetaLines(input) {
  const phase = displaySessionPhase({
    phase: input.phase,
    changedFiles: input.changedFiles
  });
  const lines = [
    `  session \xB7 ${phase}${formatListChangedHint({
      worktreePath: input.worktreePath ?? void 0,
      changedFiles: input.changedFiles
    })}`,
    `  id \xB7 ${input.sessionId}`
  ];
  if (input.goal) lines.push(`  goal \xB7 ${clipText(input.goal, 72)}`);
  if (input.agentLane) lines.push(`  lane \xB7 ${input.agentLane}`);
  if (input.reviewStatus && input.reviewStatus !== phase && input.reviewStatus !== "n/a") {
    lines.push(`  review \xB7 ${input.reviewStatus}`);
  }
  if (input.branchName) lines.push(`  branch \xB7 ${clipText(input.branchName, 56)}`);
  if (input.worktreePath) lines.push(`  worktree \xB7 ${input.worktreePath}`);
  return lines;
}
async function printRunSummary(io, result, deps) {
  const lane = result.session.agentLane;
  for (const line of formatRunSummaryMetaLines({
    sessionId: result.session.id,
    phase: result.session.phase,
    reviewStatus: result.review.status,
    goal: result.session.goal,
    agentLane: lane,
    branchName: result.session.branchName,
    worktreePath: result.session.worktreePath,
    changedFiles: result.review.changedFiles
  })) {
    io.log(line);
  }
  let showedInlinePreview = false;
  const first = result.review.changedFiles?.[0];
  const worktree = result.session.worktreePath;
  const repoPath = result.session.repoPath;
  if (result.review.status === "ready" && first && worktree) {
    const display = displaySessionPath({ worktreePath: worktree }, first);
    const abs = isAbsolute(first) ? first : join(worktree, first);
    const colorDiff = deps?.isTTY === true || deps?.isTTY !== false && !process.env.VITEST && Boolean(typeof process.stdout !== "undefined" && process.stdout.isTTY);
    const rows = await buildReadyFilePreviewRows({
      displayPath: display,
      absolutePath: abs,
      relativePath: display,
      repoPath,
      worktreePath: worktree,
      readTextFile: deps?.readTextFile,
      diffSessionFiles: deps?.diffSessionFiles,
      color: colorDiff
    });
    if (rows) {
      for (const row of rows) io.log(row);
      showedInlinePreview = true;
      const also = formatRunAlsoFilesLine(result.review.changedFiles ?? [], {
        worktreePath: worktree,
        color: colorDiff
      });
      if (also) io.log(also);
    }
  }
  if (!showedInlinePreview) {
    for (const row of formatRunChangedFilesRows(
      result.session.worktreePath,
      result.review.changedFiles
    )) {
      io.log(row);
    }
  }
  const firstDisplay = first && worktree ? displaySessionPath({ worktreePath: worktree }, first) : first;
  const next = nextAfterRunSummary({
    status: result.review.status,
    changedFiles: result.review.changedFiles,
    showedInlinePreview,
    firstFile: typeof firstDisplay === "string" ? firstDisplay : void 0
  });
  if (next) io.log(next);
  else if (result.review.status === "ready" && result.review.changedFiles?.length) {
    io.log("Next: zaraacoder accept 1");
  } else if (result.review.status === "ready" && !result.review.changedFiles?.length) {
    io.log('Next: zaraacoder "<task>"  # ready, but no files to accept');
  }
  printBlockedReason(io, result.review.blockedReason);
  for (const evidence of result.review.evidence) io.log(`Evidence: ${evidence}`);
  for (const risk of result.review.risks) io.log(`Risk: ${risk}`);
}
function nextChangedFileCommand(status, changedFiles, sessionId) {
  if (status === "ready" && changedFiles.length) {
    return sessionId ? `Next: ${zaraacoderCommand(["preview", sessionId, "1"])}` : "Next: zaraacoder preview 1";
  }
  if (status === "blocked" && changedFiles.length) {
    return sessionId ? `Next: ${zaraacoderCommand(["preview", sessionId, "1"])}` : "Next: zaraacoder preview 1";
  }
  if (status === "cancelled") {
    return null;
  }
  return sessionId ? `Next: ${zaraacoderCommand(["status", sessionId])}` : null;
}
function sessionNextStatus(session) {
  if (!session) return null;
  return session.phase === "ready" ? session.reviewStatus ?? null : session.phase;
}
function nextCommandSessionRef(sessionId) {
  return sessionId === "latest" || sessionId === "1" ? void 0 : sessionId;
}
function formatRunChangedFilesRows(worktreePath, changedFiles) {
  if (!changedFiles.length) return ["Changed files: none"];
  return [
    "Changed files:",
    ...changedFiles.map((file, index) => `${index + 1}. ${displaySessionPath({ worktreePath }, file)}`)
  ];
}
function formatChangedFilesLabel(worktreePath, changedFiles) {
  return changedFiles.length ? changedFiles.map((file) => displaySessionPath({ worktreePath }, file)).join(", ") : "none";
}
function printRunJson(io, result) {
  io.log(
    JSON.stringify({
      session: result.session,
      review: result.review,
      changedFiles: result.review.changedFiles,
      evidence: result.review.evidence,
      risks: result.review.risks,
      blockedReason: result.review.blockedReason,
      trace: result.session.tracePath,
      worktree: result.session.worktreePath,
      branch: result.session.branchName,
      plan: result.plan,
      edits: result.edits,
      checks: result.checks,
      events: result.events
    })
  );
}
function formatPlanOnlyLines(input) {
  const allow = input.allowlist.length === 0 ? "  allow \xB7 (none)" : input.allowlist.length <= 4 ? `  allow \xB7 ${input.allowlist.join(" \xB7 ")}` : `  allow \xB7 ${input.allowlist.slice(0, 3).join(" \xB7 ")} +${input.allowlist.length - 3} more`;
  return [
    "Plan \xB7 only (no worktree edits)",
    `  task \xB7 ${clipText(input.task, 72)}`,
    ...input.goal ? [`  goal \xB7 ${clipText(input.goal, 72)}`] : [],
    `  repo \xB7 ${input.repoRoot}`,
    `  context \xB7 ${clipText(input.summary, 90)}`,
    allow,
    'Next: zaraacoder --lane claude "\u2026"   # drop --plan-only to run'
  ];
}
function printPlanOnlyJson(io, input) {
  io.log(
    JSON.stringify({
      schemaVersion: 1,
      mode: "plan-only",
      task: input.task,
      repo: input.repo,
      ...input.goal ? { goal: input.goal } : {},
      context: {
        repoRoot: input.context.repoRoot,
        summary: input.context.summary
      },
      allowedCommands: input.allowedCommands
    })
  );
}
function defaultBenchRoot() {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return join(resolveRuntimeHomeDir(), ".zaraa", "zarabench", "runs", stamp);
}
function defaultBenchBaselinePath() {
  return join(
    resolveRuntimeHomeDir(),
    ".zaraa",
    "zarabench",
    "baseline",
    "zara-bench-baseline.json"
  );
}
function printBenchSummary(io, result) {
  io.log("ZaraBench seed suite");
  io.log(`Root: ${result.rootDir}`);
  io.log(`Result: ${result.resultPath}`);
  io.log(`Total: ${result.total}`);
  io.log(`Passed: ${result.passed}`);
  io.log(`Failed: ${result.failed}`);
  for (const testCase of result.cases) {
    io.log(
      `Case ${testCase.id}: ${testCase.passed ? "pass" : "fail"} ${testCase.reviewStatus} changed=${testCase.changedFiles.length ? testCase.changedFiles.join(",") : "none"}`
    );
  }
}
function requireNumberField(record, key, artifactPath) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ZaraBench result artifact: ${artifactPath}`);
  }
  return value;
}
function requireStringField(record, key, artifactPath) {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid ZaraBench result artifact: ${artifactPath}`);
  }
  return value;
}
function requireBooleanField(record, key, artifactPath) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ZaraBench result artifact: ${artifactPath}`);
  }
  return value;
}
function asZaraBenchComparableResult(value, artifactPath) {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error(`Invalid ZaraBench result artifact: ${artifactPath}`);
  }
  return {
    total: requireNumberField(value, "total", artifactPath),
    passed: requireNumberField(value, "passed", artifactPath),
    failed: requireNumberField(value, "failed", artifactPath),
    cases: value.cases.map((testCase) => {
      if (!isRecord(testCase)) {
        throw new Error(`Invalid ZaraBench result artifact: ${artifactPath}`);
      }
      return {
        id: requireStringField(testCase, "id", artifactPath),
        passed: requireBooleanField(testCase, "passed", artifactPath),
        reviewStatus: requireStringField(testCase, "reviewStatus", artifactPath)
      };
    })
  };
}
async function readBenchResultArtifact(path, deps) {
  return (await readBenchResultArtifactData(path, deps)).result;
}
async function readBenchResultArtifactData(path, deps) {
  if (!deps.readTextFile) {
    throw new Error("ZaraBench compare reader is not configured");
  }
  try {
    const raw = JSON.parse(await deps.readTextFile(path));
    return {
      raw,
      result: asZaraBenchComparableResult(raw, path)
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ZaraBench result artifact JSON: ${path}`);
    }
    throw error;
  }
}
function casesById(result) {
  return new Map(result.cases.map((testCase) => [testCase.id, testCase]));
}
function compareZaraBenchResults(input) {
  const baselineCases = casesById(input.baseline);
  const candidateCases = casesById(input.candidate);
  const addedCases = input.candidate.cases.filter((testCase) => !baselineCases.has(testCase.id)).map((testCase) => testCase.id);
  const missingCases = input.baseline.cases.filter((testCase) => !candidateCases.has(testCase.id)).map((testCase) => testCase.id);
  const regressedCases = [];
  const improvedCases = [];
  const statusChanges = [];
  for (const baselineCase of input.baseline.cases) {
    const candidateCase = candidateCases.get(baselineCase.id);
    if (!candidateCase) continue;
    if (baselineCase.passed && !candidateCase.passed) {
      regressedCases.push(baselineCase.id);
    } else if (!baselineCase.passed && candidateCase.passed) {
      improvedCases.push(baselineCase.id);
    }
    if (baselineCase.reviewStatus !== candidateCase.reviewStatus) {
      statusChanges.push({
        id: baselineCase.id,
        baseline: baselineCase.reviewStatus,
        candidate: candidateCase.reviewStatus
      });
    }
  }
  const failedDelta = input.candidate.failed - input.baseline.failed;
  return {
    baselinePath: input.baselinePath,
    candidatePath: input.candidatePath,
    baseline: {
      total: input.baseline.total,
      passed: input.baseline.passed,
      failed: input.baseline.failed
    },
    candidate: {
      total: input.candidate.total,
      passed: input.candidate.passed,
      failed: input.candidate.failed
    },
    totalDelta: input.candidate.total - input.baseline.total,
    passedDelta: input.candidate.passed - input.baseline.passed,
    failedDelta,
    addedCases,
    missingCases,
    regressedCases,
    improvedCases,
    statusChanges,
    passed: regressedCases.length === 0 && missingCases.length === 0 && failedDelta <= 0
  };
}
function formatDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}
function formatList(values) {
  return values.length ? values.join(", ") : "none";
}
function formatStatusChanges(statusChanges) {
  if (!statusChanges.length) return "none";
  return statusChanges.map((change) => `${change.id} ${change.baseline} -> ${change.candidate}`).join(", ");
}
function printBenchComparison(io, result) {
  io.log("ZaraBench comparison");
  io.log(`Baseline: ${result.baselinePath}`);
  io.log(`Candidate: ${result.candidatePath}`);
  io.log(`Total delta: ${formatDelta(result.totalDelta)}`);
  io.log(`Passed delta: ${formatDelta(result.passedDelta)}`);
  io.log(`Failed delta: ${formatDelta(result.failedDelta)}`);
  io.log(`Regressed: ${formatList(result.regressedCases)}`);
  io.log(`Improved: ${formatList(result.improvedCases)}`);
  io.log(`Added: ${formatList(result.addedCases)}`);
  io.log(`Missing: ${formatList(result.missingCases)}`);
  io.log(`Status changes: ${formatStatusChanges(result.statusChanges)}`);
  io.log(`Result: ${result.passed ? "pass" : "fail"}`);
}
function printBenchBaselinePromotion(io, result) {
  io.log("ZaraBench baseline promoted");
  io.log(`Source: ${result.sourcePath}`);
  io.log(`Baseline: ${result.baselinePath}`);
  io.log(`Total: ${result.total}`);
  io.log(`Passed: ${result.passed}`);
  io.log(`Failed: ${result.failed}`);
  io.log(`Cases: ${formatList(result.cases)}`);
}
function printBenchCheck(io, result) {
  io.log("ZaraBench check");
  io.log(`Root: ${result.run.rootDir}`);
  io.log(`Result: ${result.run.resultPath}`);
  io.log(`Baseline: ${result.comparison.baselinePath}`);
  io.log(`Total: ${result.run.total}`);
  io.log(`Passed: ${result.run.passed}`);
  io.log(`Failed: ${result.run.failed}`);
  io.log(`Regressed: ${formatList(result.comparison.regressedCases)}`);
  io.log(`Missing: ${formatList(result.comparison.missingCases)}`);
  io.log(`Status changes: ${formatStatusChanges(result.comparison.statusChanges)}`);
  io.log(`Comparison: ${result.comparison.passed ? "pass" : "fail"}`);
}
async function renderBenchBaselinePromote(args, io, deps) {
  if (!deps.makeDirectory || !deps.writeTextFile) {
    throw new Error("ZaraBench baseline writer is not configured");
  }
  const artifact = await readBenchResultArtifactData(args.source, deps);
  const baselinePath = args.baselinePath ?? defaultBenchBaselinePath();
  const result = {
    baselinePath,
    sourcePath: args.source,
    total: artifact.result.total,
    passed: artifact.result.passed,
    failed: artifact.result.failed,
    cases: artifact.result.cases.map((testCase) => testCase.id)
  };
  await deps.makeDirectory(dirname(baselinePath));
  await deps.writeTextFile(baselinePath, `${JSON.stringify(artifact.raw, null, 2)}
`);
  if (args.json) {
    io.log(JSON.stringify(result));
  } else {
    printBenchBaselinePromotion(io, result);
  }
  return 0;
}
async function renderBenchBaselineCompare(args, io, deps) {
  const baselinePath = args.baselinePath ?? defaultBenchBaselinePath();
  const comparison = compareZaraBenchResults({
    baselinePath,
    candidatePath: args.candidate,
    baseline: await readBenchResultArtifact(baselinePath, deps),
    candidate: await readBenchResultArtifact(args.candidate, deps)
  });
  if (args.json) {
    io.log(JSON.stringify(comparison));
  } else {
    printBenchComparison(io, comparison);
  }
  return comparison.passed ? 0 : 1;
}
async function renderBenchCheck(args, io, deps) {
  if (!deps.runZaraBenchSeedSuite) {
    io.error("ZaraBench runner is not configured");
    return 1;
  }
  const run = await deps.runZaraBenchSeedSuite({
    rootDir: args.root ?? defaultBenchRoot()
  });
  const baselinePath = args.baselinePath ?? defaultBenchBaselinePath();
  let baseline;
  try {
    baseline = await readBenchResultArtifact(baselinePath, deps);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const message = `ZaraBench baseline not found: ${baselinePath}`;
    const next = `zaraacoder bench baseline promote ${run.resultPath}`;
    if (args.json) io.log(JSON.stringify({ ok: false, error: message, baselinePath, next }));
    else {
      io.error(message);
      io.log(`Next: ${next}`);
    }
    return 1;
  }
  const comparison = compareZaraBenchResults({
    baselinePath,
    candidatePath: run.resultPath,
    baseline,
    candidate: asZaraBenchComparableResult(run, run.resultPath)
  });
  const result = { run, comparison };
  if (args.json) {
    io.log(JSON.stringify(result));
  } else {
    printBenchCheck(io, result);
  }
  return comparison.passed ? 0 : 1;
}
async function renderBenchCompare(args, io, deps) {
  const comparison = compareZaraBenchResults({
    baselinePath: args.baseline,
    candidatePath: args.candidate,
    baseline: await readBenchResultArtifact(args.baseline, deps),
    candidate: await readBenchResultArtifact(args.candidate, deps)
  });
  if (args.json) {
    io.log(JSON.stringify(comparison));
  } else {
    printBenchComparison(io, comparison);
  }
  return comparison.passed ? 0 : 1;
}
async function renderBench(args, io, deps) {
  if (!deps.runZaraBenchSeedSuite) {
    io.error("ZaraBench runner is not configured");
    return 1;
  }
  const result = await deps.runZaraBenchSeedSuite({
    rootDir: args.root ?? defaultBenchRoot()
  });
  if (args.json) {
    io.log(JSON.stringify(result));
  } else {
    printBenchSummary(io, result);
  }
  return result.failed === 0 ? 0 : 1;
}
async function runZaraacoderCommand(args, io = console, deps) {
  let parsed;
  try {
    parsed = parseZaraacoderArgs(args);
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
  if (parsed.action === "help") {
    io.log(parsed.more ? HELP_MORE_TEXT : HELP_TEXT);
    return 0;
  }
  if (parsed.action === "version") {
    io.log(`zaraacoder ${ZARAACODER_VERSION}`);
    return 0;
  }
  try {
    const loadedDeps = deps ?? await loadZaraacoderDeps();
    if (parsed.action === "bench") {
      return await renderBench(parsed, io, loadedDeps);
    }
    if (parsed.action === "bench-compare") {
      return await renderBenchCompare(parsed, io, loadedDeps);
    }
    if (parsed.action === "bench-baseline-promote") {
      return await renderBenchBaselinePromote(parsed, io, loadedDeps);
    }
    if (parsed.action === "bench-baseline-compare") {
      return await renderBenchBaselineCompare(parsed, io, loadedDeps);
    }
    if (parsed.action === "bench-check") {
      return await renderBenchCheck(parsed, io, loadedDeps);
    }
    if (parsed.action === "list") {
      return await renderList(parsed, io, loadedDeps);
    }
    if (parsed.action === "doctor") {
      return await renderDoctor(io, loadedDeps, {
        standalone: "standalone" in parsed && Boolean(parsed.standalone)
      });
    }
    if (parsed.action === "ready") {
      return await renderReady(io, loadedDeps, {
        standalone: "standalone" in parsed && Boolean(parsed.standalone)
      });
    }
    if (parsed.action === "now") {
      return await renderNow(io, loadedDeps);
    }
    if (parsed.action === "northstar") {
      return await renderNorthstar(io, loadedDeps, parsed.json);
    }
    if (parsed.action === "wire-zero") {
      return await renderWireZero(io, loadedDeps, parsed.json);
    }
    if (parsed.action === "tonight") {
      return await renderTonight(io, loadedDeps, parsed.json);
    }
    if (parsed.action === "burnin") {
      return await renderBurnIn(io, loadedDeps);
    }
    if (parsed.action === "verify") {
      return await renderVerify(io, loadedDeps);
    }
    if (parsed.action === "changes") {
      return await renderChanges(io, loadedDeps);
    }
    if (parsed.action === "open") {
      return await renderOpen(parsed, io, loadedDeps);
    }
    if (parsed.action === "brief") {
      return await renderBrief(io, loadedDeps);
    }
    if (parsed.action === "where") {
      return await renderWhere(io, loadedDeps);
    }
    if (parsed.action === "feed") {
      return await renderFeed(io, loadedDeps);
    }
    if (parsed.action === "say" || parsed.action === "continue" || parsed.action === "stop") {
      return await renderSessionControl(parsed, io, loadedDeps);
    }
    if (parsed.action === "promote") {
      return await renderPromote(parsed, io, loadedDeps);
    }
    if (parsed.action === "show") {
      return await renderShow(parsed, io, loadedDeps);
    }
    if (parsed.action === "apply") {
      return await renderApply(parsed, io, loadedDeps);
    }
    if (parsed.action === "undo") {
      return await renderUndo(io, loadedDeps);
    }
    if (parsed.action === "gc") {
      const { runWorktreeGc } = await import("./zaraacoder-gc-XMACHPPQ.js");
      const store2 = createSessionStore({}, io, loadedDeps);
      if (!store2) return 1;
      if (!store2.listLatest) {
        reportSessionLoadError(io, "listing");
        return 1;
      }
      const configDeps = requireConfigDeps(loadedDeps);
      const config2 = configDeps.normalizeZaraacoderConfig(
        configDeps.defaultZaraacoderConfig()
      );
      if (!config2.worktreeRoot?.trim()) {
        io.error("GC \xB7 worktree root not configured");
        io.log("Next: zaraacoder doctor");
        return 1;
      }
      return await runWorktreeGc({
        args: {
          apply: parsed.apply,
          worktreeRoot: config2.worktreeRoot
        },
        listSessions: () => store2.listLatest(),
        io
      });
    }
    if (parsed.action === "link") {
      return await renderLink(io, loadedDeps);
    }
    if (parsed.action === "goal") {
      return await renderGoal(parsed, io, loadedDeps);
    }
    if (parsed.action === "learn") {
      return await renderLearn(parsed, io, loadedDeps);
    }
    if (parsed.action === "status") {
      return await renderStatus(parsed.sessionId, parsed, io, loadedDeps);
    }
    if (parsed.action === "trace") {
      return await renderTrace(parsed.sessionId, parsed, io, loadedDeps);
    }
    if (parsed.action === "diff") {
      return await renderDiff(parsed.sessionId, parsed, io, loadedDeps);
    }
    if (parsed.action === "handoff") {
      return await renderHandoff(parsed.sessionId, parsed, io, loadedDeps);
    }
    if (parsed.action === "attach") {
      const { runZaraacoderAttachCommand } = await import("./zaraacoder-attach-GKSYEL2B.js");
      const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
      return await runZaraacoderAttachCommand(port, parsed.sessionId);
    }
    if (parsed.action === "models") {
      const { runZaraacoderModelsCommand } = await import("./models-S4WWYB2H.js");
      const port = Number.parseInt(process.env.ZARAA_PORT ?? "3927", 10);
      return await runZaraacoderModelsCommand(port, parsed.args);
    }
    const zaraacoder = requireConfigDeps(loadedDeps);
    const config = zaraacoder.normalizeZaraacoderConfig({
      ...zaraacoder.defaultZaraacoderConfig(),
      worktreeRoot: join(resolveRuntimeHomeDir(), ".zaraa", "worktrees")
    });
    if (parsed.planOnly) {
      const planDeps = requirePlanDeps(loadedDeps);
      const context = await planDeps.loadZaraacoderRepoContext({
        repoRoot: parsed.repo
      });
      if (parsed.json) {
        printPlanOnlyJson(io, {
          task: parsed.task,
          repo: parsed.repo,
          ...parsed.goal ? { goal: parsed.goal } : {},
          context,
          allowedCommands: config.commandAllowlist
        });
        return 0;
      }
      for (const line of formatPlanOnlyLines({
        task: parsed.task,
        goal: parsed.goal,
        repoRoot: context.repoRoot,
        summary: context.summary,
        allowlist: config.commandAllowlist
      })) {
        io.log(line);
      }
      return 0;
    }
    let effectiveAgentLane = parsed.action === "run" ? parsed.agentLane : void 0;
    if (parsed.action === "run" && !effectiveAgentLane) {
      const probe = await probeCoderCliLanes(loadedDeps.resolveCommand ?? resolveCommand);
      const hermetic = suggestHermeticDefaultLane(probe);
      if (hermetic) {
        effectiveAgentLane = hermetic;
        if (!parsed.json) {
          io.log(`Lane \xB7 hermetic default \u2192 ${hermetic} (override with --lane auto|\u2026)`);
        }
      }
    }
    let executor = loadedDeps.executor;
    if (!executor && loadedDeps.loadZaraaConfig && loadedDeps.createConfiguredExecutor) {
      const dataDir = resolveCliConfigDir();
      const zaraaConfig = await loadedDeps.loadZaraaConfig(dataDir);
      const configured = await loadedDeps.createConfiguredExecutor({
        config: zaraaConfig,
        dataDir
      });
      executor = configured.executor;
    }
    if (!executor) {
      io.error("Run \xB7 blocked \xB7 executor not configured");
      io.log("  tip \xB7 use --plan-only to inspect context without coding");
      io.log("  tip \xB7 wire Zero/Codex policy, then: zaraacoder doctor");
      io.log('Next: zaraacoder run --repo . --plan-only "inspect"');
      return 1;
    }
    if (!loadedDeps.runPersistentSession) {
      io.error("Run \xB7 blocked \xB7 persistent runner not configured");
      io.log("Next: zaraacoder doctor");
      return 1;
    }
    const store = createSessionStore(parsed, io, loadedDeps);
    if (!store) return 1;
    let livePhase = null;
    let lastFeedLine = "";
    const runStartedAt = Date.now();
    const liveIsTTY = !parsed.json && (loadedDeps.isTTY ?? (process.env.VITEST ? false : Boolean(
      typeof process.stdin !== "undefined" && process.stdin.isTTY && typeof process.stdout !== "undefined" && process.stdout.isTTY
    )));
    const animator = !parsed.json ? createLiveRunAnimator({
      isTTY: liveIsTTY,
      log: (line) => io.log(line),
      write: loadedDeps.writeStdout
    }) : null;
    let lastFeedAt = runStartedAt;
    const quietHeartbeat = !parsed.json && !liveIsTTY ? setInterval(() => {
      if (Date.now() - lastFeedAt < 12e3) return;
      io.log(
        formatLiveHeartbeatLine({
          phase: livePhase,
          elapsedMs: Date.now() - runStartedAt
        })
      );
      lastFeedAt = Date.now();
    }, 4e3) : null;
    if (animator) {
      animator.start(
        formatLiveRunStartLine({
          task: parsed.task,
          lane: parsed.action === "run" ? effectiveAgentLane : void 0,
          repo: parsed.repo,
          color: liveIsTTY
        })
      );
    }
    let result;
    const abortController = loadedDeps.createAbortController?.() ?? new AbortController();
    const onInterrupt = () => {
      try {
        abortController.abort();
      } catch {
      }
      animator?.stop();
    };
    if (!parsed.json && !process.env.VITEST) {
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onInterrupt);
    }
    try {
      result = await loadedDeps.runPersistentSession({
        store,
        task: parsed.task,
        repoPath: parsed.repo,
        ...parsed.goal ? { goal: parsed.goal } : {},
        ...parsed.action === "run" && effectiveAgentLane ? { agentLane: effectiveAgentLane } : {},
        traceRoot: join(resolveRuntimeHomeDir(), ".zaraa", "zaraacoder", "traces"),
        config,
        executor,
        signal: abortController.signal,
        ...!parsed.json ? {
          onSessionUpdate: (session) => {
            if (session.phase === livePhase) return;
            livePhase = session.phase;
            if (animator) {
              animator.setPhase(session.phase, {
                agentLane: session.agentLane,
                executorRoute: session.executorRoute
              });
            } else {
              for (const line of formatLivePhaseLines({
                phase: session.phase,
                elapsedMs: Date.now() - runStartedAt,
                agentLane: session.agentLane,
                executorRoute: session.executorRoute
              })) {
                io.log(line);
              }
            }
            lastFeedAt = Date.now();
          },
          // Full stream: tool / thinking / interesting stdout / stderr.
          onOutput: (_sessionId, chunk) => {
            const line = formatLiveOutputFeedLine(chunk, { color: liveIsTTY });
            if (!line || line === lastFeedLine) return;
            lastFeedLine = line;
            if (animator) animator.logFeed(line);
            else io.log(line);
            lastFeedAt = Date.now();
          }
        } : {}
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        io.error(formatRunInterruptedLine({ color: liveIsTTY }));
        return 130;
      }
      throw error;
    } finally {
      if (!parsed.json && !process.env.VITEST) {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onInterrupt);
      }
      if (quietHeartbeat) clearInterval(quietHeartbeat);
      animator?.stop();
    }
    const fileCount = result.review.changedFiles?.length ?? 0;
    const runChecks = result.checks ?? result.review.checks;
    const wantAutoAccept = parsed.action === "run" && shouldAutoAcceptAfterRun({
      autoAccept: parsed.autoAccept,
      status: result.review.status,
      fileCount,
      checks: runChecks,
      env: process.env
    });
    if (parsed.json) {
      printRunJson(io, result);
      if (wantAutoAccept) {
        io.log(formatAutoAcceptLine(fileCount, { color: false }));
        return await renderApply({ action: "apply" }, io, loadedDeps);
      }
      return 0;
    }
    const elapsedMs = Date.now() - runStartedAt;
    for (const line of formatRunOutcomeLines({
      status: result.review.status,
      elapsedMs,
      fileCount,
      blockedMessage: result.review.blockedReason?.message,
      color: liveIsTTY
    })) {
      io.log(line);
    }
    await printRunSummary(io, result, { ...loadedDeps, isTTY: liveIsTTY });
    if (wantAutoAccept) {
      io.log(formatAutoAcceptLine(fileCount, { color: liveIsTTY }));
      return await renderApply({ action: "apply" }, io, loadedDeps);
    }
    const isTTY = liveIsTTY;
    if (result.review.status === "ready" && fileCount > 0 && shouldPromptAcceptAfterRun({ json: parsed.json, isTTY, env: process.env })) {
      const firstFile = result.review.changedFiles?.[0] ? displaySessionPath(
        { worktreePath: result.session.worktreePath },
        result.review.changedFiles[0]
      ) : void 0;
      const prompt = formatAcceptPromptLine(fileCount, {
        color: isTTY,
        firstFile
      });
      const answer = loadedDeps.readAcceptPrompt ? await loadedDeps.readAcceptPrompt(prompt) : await defaultReadAcceptPrompt(prompt);
      const choice = parseAcceptPromptAnswer(answer, fileCount);
      if (choice === "accept-first") {
        return await renderApply({ action: "apply", filePath: "1" }, io, loadedDeps);
      }
      if (choice === "accept-all") {
        return await renderApply({ action: "apply" }, io, loadedDeps);
      }
      const skipHint = firstFile ? ` \xB7 ${firstFile}` : "";
      io.log(`Skipped accept \xB7 Next: zaraacoder accept 1${skipHint}`);
    }
    return 0;
  } catch (error) {
    io.error(`Run \xB7 failed \xB7 ${errorMessage(error)}`);
    io.log("Next: zaraacoder doctor | zaraacoder status");
    return 1;
  }
}

export {
  acceptBlockedReason,
  canAcceptSession,
  IN_FLIGHT_SESSION_PHASES,
  isActionableSession,
  previewBlockedReason,
  polishLearnedDisplayLine,
  GIT_STATUS_TIMEOUT_SENTINEL,
  listRepoChanges,
  nextOperatorStep,
  zaraacoderLinkGlobalPlan,
  parseZaraacoderArgs,
  reportSessionLoadError,
  prioritizeActionableSessions,
  formatListEmptyLines,
  isNoiseSession,
  isQuietHistorySession,
  formatSessionListIcon,
  formatListChangedHint,
  displaySessionPhase,
  formatWorkingPhaseLabel,
  formatProgressRail,
  formatElapsedShort,
  ansiPaint,
  formatLivePhaseLines,
  formatLiveRunStartLine,
  pickInterestingStdoutLine,
  formatLiveOutputFeedLine,
  formatLiveHeartbeatLine,
  LIVE_SPINNER_FRAMES,
  LIVE_PULSE_BLOCKS,
  formatLiveSpinnerFrame,
  formatLiveStatusBar,
  createLiveRunAnimator,
  summarizeUnifiedDiff,
  isAutoAcceptEnvEnabled,
  isAutoAcceptEnvDisabled,
  isStandaloneModeEnabled,
  isCcCompatEnabled,
  isDaemonOptionalMode,
  isCoderStackReady,
  suggestHermeticDefaultLane,
  formatCoderCliLaneProbeLine,
  probeCoderCliLanes,
  checksPassForAutoAccept,
  shouldAutoAcceptAfterRun,
  formatAutoAcceptLine,
  shouldPromptAcceptAfterRun,
  formatAcceptPromptLine,
  parseAcceptPromptAnswer,
  formatRunAlsoFilesLine,
  nextAfterRunSummary,
  colorizeDiffLine,
  formatDiffPreviewRows,
  formatDoneCelebrationLines,
  formatRunInterruptedLine,
  formatApplyLandedLine,
  formatApplyNextLine,
  formatRunOutcomeLines,
  formatFileContentPreviewRows,
  buildReadyFilePreviewRows,
  formatWireZeroSuccessLines,
  formatTonightCardLines,
  formatBurnInResultLines,
  formatShowNextCommand,
  formatLinkSuccessLines,
  formatGoalSetLines,
  formatLearnSuccessLines,
  formatStatusCardLines,
  formatHandoffLines,
  formatRunSummaryMetaLines,
  formatPlanOnlyLines,
  runZaraacoderCommand
};
