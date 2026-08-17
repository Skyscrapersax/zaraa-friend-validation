#!/usr/bin/env node
import {
  runModelsCommand
} from "./chunk-FA6ZWHA6.js";
import {
  compactHomePath
} from "./chunk-XSCLDVMG.js";
import {
  buildGatewayAccessFailureMessage,
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  fetchGatewayResponse,
  loadGatewayApiKey,
  loadLocalZaraaConfig,
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-WWFZXCWT.js";
import {
  resolveCliConfigDir,
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/index.ts
import { existsSync as existsSync5, readFileSync as readFileSync3 } from "fs";
import { join as join3 } from "path";
import { config as loadDotenv } from "dotenv";
import { parseArgs } from "util";
import { render } from "ink";
import React from "react";

// src/commands/operator-controls.ts
var VALID_ZONES = ["sandbox", "guarded", "trusted"];
var VALID_RUNTIME_MODES = ["slow", "medium", "fast", "pause"];
function isZoneName(value) {
  return typeof value === "string" && VALID_ZONES.includes(value);
}
function isRuntimeMode(value) {
  return typeof value === "string" && VALID_RUNTIME_MODES.includes(value);
}
function isStatusAlias(value) {
  return value === void 0 || ["show", "status", "current", "get"].includes(value);
}
function printUsage(kind) {
  if (kind === "zone") {
    console.log("Usage: zaraa zone [sandbox|guarded|trusted]");
    return;
  }
  console.log("Usage: zaraa runtime [slow|medium|fast|pause]");
}
async function runZoneCommand(port, target) {
  if (isStatusAlias(target)) {
    const result2 = await requestGatewayJson(port, "/api/zone");
    if (!result2.ok) {
      console.error(`Failed to read current zone: ${result2.error ?? "unknown error"}`);
      const snapshot = await collectGatewayAccessSnapshot(port);
      console.error(buildGatewayAccessFailureMessage("Zone status is unavailable.", port, snapshot, [result2]));
      return 1;
    }
    console.log(`Current zone: ${result2.data?.zone ?? "unknown"}`);
    console.log("Use `zaraa zone sandbox`, `zaraa zone guarded`, or `zaraa zone trusted` to change it.");
    return 0;
  }
  if (!isZoneName(target)) {
    printUsage("zone");
    return 1;
  }
  const result = await requestGatewayJson(port, "/api/zone", {
    method: "POST",
    body: { zone: target }
  });
  if (!result.ok) {
    console.error(`Failed to update zone: ${result.error ?? "unknown error"}`);
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(buildGatewayAccessFailureMessage("Zone update failed.", port, snapshot, [result]));
    return 1;
  }
  console.log(`Zone set to ${result.data?.zone ?? target}.`);
  return 0;
}
async function runRuntimeCommand(port, target) {
  if (isStatusAlias(target)) {
    const result2 = await requestGatewayJson(port, "/api/runtime/mode");
    if (!result2.ok) {
      console.error(`Failed to read runtime mode: ${result2.error ?? "unknown error"}`);
      const snapshot = await collectGatewayAccessSnapshot(port);
      console.error(buildGatewayAccessFailureMessage("Runtime status is unavailable.", port, snapshot, [result2]));
      return 1;
    }
    console.log(`Current runtime mode: ${result2.data?.mode ?? "unknown"}`);
    console.log(`Paused: ${result2.data?.paused ? "yes" : "no"}`);
    if (result2.data?.performance) {
      console.log(`Performance profile: ${result2.data.performance}`);
    }
    if (result2.data?.routing) {
      console.log(
        `Key routes: sandbox=${result2.data.routing.sandbox ?? "?"}, guarded=${result2.data.routing.guarded ?? "?"}, trusted=${result2.data.routing.trusted ?? "?"}`
      );
    }
    console.log("Use `zaraa runtime slow`, `zaraa runtime medium`, `zaraa runtime fast`, or `zaraa runtime pause` to change it.");
    return 0;
  }
  if (!isRuntimeMode(target)) {
    printUsage("runtime");
    return 1;
  }
  const result = await requestGatewayJson(port, "/api/runtime/mode", {
    method: "POST",
    body: { mode: target }
  });
  if (!result.ok) {
    console.error(`Failed to update runtime mode: ${result.error ?? "unknown error"}`);
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(buildGatewayAccessFailureMessage("Runtime update failed.", port, snapshot, [result]));
    return 1;
  }
  console.log(`Runtime mode set to ${result.data?.mode ?? target}.`);
  console.log(`Paused: ${result.data?.paused ? "yes" : "no"}`);
  return 0;
}

// src/commands/optimize.ts
async function runOptimize(port, strategy, period, symbol) {
  if (!strategy) {
    console.error("Error: --strategy is required");
    console.error("  Example: zaraa optimize --strategy trend-following --period 90d");
    return 1;
  }
  console.log(`
Optimizing strategy: ${strategy} | period: ${period}${symbol ? ` | symbol: ${symbol}` : ""}`);
  console.log("Running parameter grid search...\n");
  const params = { strategy, period };
  if (symbol) params.symbol = symbol;
  const res = await requestGatewayJson(port, "/tool", {
    method: "POST",
    body: { tool: "trade_optimize", params }
  });
  if (!res.ok) {
    console.error(`Error: ${res.error ?? "Request failed"}`);
    return 1;
  }
  const run = res.data;
  if (!run) {
    console.error("Error: Empty optimization response");
    return 1;
  }
  if ("error" in run) {
    console.error(`Error: ${run.error}`);
    return 1;
  }
  console.log(`Strategy: ${run.strategyName}`);
  console.log(`Candles used: ${run.candlesUsed.toLocaleString()} | Combinations tested: ${run.paramsTestedCount}`);
  console.log("");
  if (run.top3.length === 0) {
    console.log("No results \u2014 insufficient candle data to run backtest.");
    return 0;
  }
  const line = "\u2500".repeat(70);
  console.log("Top 3 Parameter Sets");
  console.log(line);
  console.log(
    `${"Rank".padEnd(5)} ${"SL ATR".padEnd(8)} ${"TP Ratio".padEnd(10)} ${"Risk%".padEnd(7)} ${"Sharpe".padEnd(8)} ${"Win%".padEnd(7)} ${"MaxDD%".padEnd(8)} ${"PnL".padEnd(10)} ${"Trades"}`
  );
  console.log(line);
  for (const r of run.top3) {
    const { stopLossAtrMultiplier: sl, takeProfitRatio: tp, riskPerTradePct: risk } = r.params;
    const pnlStr = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2);
    console.log(
      `${String(r.rank).padEnd(5)} ${sl.toFixed(1).padEnd(8)} ${tp.toFixed(1).padEnd(10)} ${`${risk}%`.padEnd(7)} ${r.sharpeRatio.toFixed(2).padEnd(8)} ${`${r.winRate}%`.padEnd(7)} ${`${r.maxDrawdownPct}%`.padEnd(8)} ${`$${pnlStr}`.padEnd(10)} ${r.tradeCount}`
    );
  }
  console.log(line);
  const best = run.top3[0];
  console.log(`
Recommended parameters (rank #1):`);
  console.log(`  stopLossAtrMultiplier: ${best.params.stopLossAtrMultiplier}`);
  console.log(`  takeProfitRatio:       ${best.params.takeProfitRatio}`);
  console.log(`  riskPerTradePct:       ${best.params.riskPerTradePct}`);
  console.log("");
  return 0;
}

// src/commands/overnight.ts
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
var SUBMITTER = "scripts/submit-overnight-operator-pack.mjs";
var HANDOFF = "scripts/print-overnight-morning-handoff.mjs";
function resolveOvernightScriptPath(kind) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = process.env.ZARAA_REPO_ROOT;
  const rel = kind === "handoff" ? HANDOFF : SUBMITTER;
  const candidates = [
    resolve(here, `../../../../${rel}`),
    resolve(here, `../../../${rel}`),
    ...repo ? [resolve(repo, rel)] : []
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}
function pushFlag(args, name, value) {
  if (value?.trim()) {
    args.push(`--${name}=${value.trim()}`);
  }
}
function buildScriptArgs(subcommand2, positionals2, options) {
  const args = [];
  if (subcommand2 === "list") {
    args.push("--list");
  } else if (subcommand2 === "preview") {
    args.push("--dry-run");
    args.push(options.full ? "--preview=full" : "--preview=brief");
  } else if (subcommand2 === "handoff") {
    if (options.full) {
      args.push("--full");
    }
  } else if (subcommand2 === "send" || !subcommand2) {
  } else {
    throw new Error(`Unknown overnight action "${subcommand2}". Use list, preview, send, or handoff.`);
  }
  const selector = positionals2[0];
  if (selector === "task" && subcommand2 !== "handoff") {
    const taskId = options.task ?? positionals2[1];
    if (!taskId) {
      throw new Error("Usage: zaraa overnight preview|send task <task-id>");
    }
    args.push(`--task=${taskId}`);
  }
  pushFlag(args, "match", options.match);
  pushFlag(args, "task", options.task);
  pushFlag(args, "voice", options.voice);
  pushFlag(args, "limit", options.limit);
  pushFlag(args, "delay-ms", options.delayMs);
  return args;
}
function runOvernight(subcommand2, positionals2, options) {
  const kind = subcommand2 === "handoff" ? "handoff" : "submit";
  const scriptPath = resolveOvernightScriptPath(kind);
  if (!scriptPath) {
    const rel = kind === "handoff" ? HANDOFF : SUBMITTER;
    console.error(
      `Overnight ${kind} script not found. From the zara monorepo: ${rel}, or export ZARAA_REPO_ROOT=/path/to/zara`
    );
    return 1;
  }
  const scriptArgs = buildScriptArgs(subcommand2, positionals2, options);
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: dirname(dirname(scriptPath)),
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

// src/commands/pulse.ts
import { execFile } from "child_process";
import { existsSync as existsSync2, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
async function collectProcessSignals(port) {
  let daemonFallbackCount = 0;
  let gatewayListenerCount = 0;
  try {
    const ownerPath = join(
      resolveRuntimeHomeDir(),
      ".zaraa",
      "locks",
      "zaraa-daemon.lock",
      "owner.json"
    );
    if (existsSync2(ownerPath)) {
      const owner = JSON.parse(readFileSync(ownerPath, "utf-8"));
      if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
        daemonFallbackCount = 1;
      }
    }
  } catch {
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    gatewayListenerCount = stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(1).length;
  } catch {
  }
  try {
    const { stdout } = await execFileAsync("ps", ["ax", "-o", "pid=,command="]);
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const daemonCount = lines.filter((line) => line.includes("scripts/zaraa-daemon.mjs")).length;
    return {
      daemonCount: Math.max(daemonCount, daemonFallbackCount),
      cloudflaredForGatewayCount: lines.filter(
        (line) => line.includes("cloudflared") && line.includes(`localhost:${port}`)
      ).length,
      gatewayListenerCount,
      ollamaCount: lines.filter((line) => line.includes("ollama serve")).length
    };
  } catch {
    return {
      daemonCount: daemonFallbackCount,
      cloudflaredForGatewayCount: 0,
      gatewayListenerCount,
      ollamaCount: 0
    };
  }
}
function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "?";
}
function formatMaybeFloat(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "?";
}
function formatTimestamp(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
function truncate(text, maxLength = 96) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}\u2026` : text;
}
function normalizeModelFailureName(name) {
  const delimiterIndex = name.indexOf(":");
  if (delimiterIndex <= 0) return name;
  const possibleProvider = name.slice(0, delimiterIndex);
  if (possibleProvider.includes("/")) return name;
  return name.slice(delimiterIndex + 1);
}
function summarizeModelFailures(models, limit = 4) {
  const grouped = /* @__PURE__ */ new Map();
  for (const model of models ?? []) {
    const rawName = model.name ?? "unknown";
    const name = normalizeModelFailureName(rawName);
    const failureCount = model.failureCount ?? 0;
    if (failureCount <= 0) continue;
    grouped.set(name, Math.max(grouped.get(name) ?? 0, failureCount));
  }
  return [...grouped.entries()].map(([name, failureCount]) => ({ name, failureCount })).sort((left, right) => right.failureCount - left.failureCount).slice(0, limit);
}
function buildPulseAlerts(snapshot) {
  const alerts = [];
  const runtime = snapshot.runtime.data;
  const zone = snapshot.zone.data?.zone;
  const scheduler = snapshot.extended.data?.scheduler;
  const tunnel = snapshot.extended.data?.tunnel;
  const heartbeat = snapshot.extended.data?.heartbeat;
  const taskStats = snapshot.extended.data?.taskStats;
  const iMessage = snapshot.extended.data?.imessage;
  const modelFailures = summarizeModelFailures(snapshot.health.data?.models, 3);
  if (!snapshot.ready.ok || snapshot.ready.data?.status !== "ready") {
    alerts.push({
      severity: "high",
      message: `Gateway readiness is ${snapshot.ready.data?.status ?? snapshot.ready.error ?? "unknown"}.`
    });
  }
  if (runtime?.paused && (scheduler?.activeCount ?? 0) > 0) {
    alerts.push({
      severity: "high",
      message: `Runtime mode is paused while ${formatNumber(scheduler?.activeCount)} scheduled tasks are registered. Use \`zaraa runtime fast\` or \`zaraa runtime medium\` when you want work to resume.`
    });
  }
  if (zone === "trusted") {
    alerts.push({
      severity: "medium",
      message: "Current zone is trusted. That is powerful, but it should usually be a deliberate session rather than the resting state. Use `zaraa zone guarded` or `zaraa zone sandbox` when you are done with elevated work."
    });
  }
  if ((snapshot.processSignals.cloudflaredForGatewayCount ?? 0) > 1 && !tunnel?.configured) {
    alerts.push({
      severity: "medium",
      message: `Found ${snapshot.processSignals.cloudflaredForGatewayCount} cloudflared processes for the gateway, but tunnel health is still unconfigured. Run \`zaraa remote\` to see whether these are temporary leftovers or part of a persistent setup.`
    });
  }
  if (modelFailures.length > 0) {
    alerts.push({
      severity: "medium",
      message: `Recent model failure counts are concentrated on ${modelFailures.map((item) => `${item.name} (${item.failureCount})`).join(", ")}.`
    });
  }
  if ((taskStats?.failureRate ?? 0) >= 2) {
    alerts.push({
      severity: "medium",
      message: `Task failure rate is ${formatMaybeFloat(taskStats?.failureRate, 2)}%.`
    });
  }
  if (heartbeat?.configured === false) {
    alerts.push({
      severity: "low",
      message: "Dead-man heartbeat is not configured, so off-machine outage visibility is limited. Run `zaraa remote` for the full remote posture."
    });
  }
  if (tunnel?.configured === false) {
    alerts.push({
      severity: "low",
      message: "Remote tunnel health is not configured through the gateway yet. Run `zaraa remote` for the full remote posture."
    });
  }
  if (iMessage && iMessage.healthy === false) {
    alerts.push({
      severity: "medium",
      message: `iMessage bridge is unhealthy: ${iMessage.lastError ?? `${iMessage.consecutiveFailures ?? 0} consecutive failures`}.`
    });
  }
  if (snapshot.processSignals.daemonCount === 0) {
    alerts.push({
      severity: "high",
      message: "No zaraa-daemon process was detected in the process table."
    });
  }
  if (snapshot.processSignals.daemonCount > 0 && snapshot.processSignals.gatewayListenerCount === 0) {
    alerts.push({
      severity: "high",
      message: "A zaraa-daemon process exists, but nothing is listening on the gateway port."
    });
  }
  return alerts.slice(0, 6);
}
function buildPulseFailureDiagnosis(snapshot, port, hasApiKey) {
  const responses = [snapshot.health, snapshot.ready, snapshot.extended, snapshot.runtime, snapshot.zone];
  if (responses.some((result) => result.status === 401)) {
    return "Pulse reached the gateway, but the API key was rejected (HTTP 401). Check gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.";
  }
  if (!hasApiKey) {
    return "Pulse could not reach the protected operator endpoints because no local gateway API key was found in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.";
  }
  if (snapshot.processSignals.daemonCount === 0) {
    return "Pulse could not reach the protected operator endpoints, and no zaraa-daemon process was detected. Start or restart the daemon first.";
  }
  if (snapshot.processSignals.gatewayListenerCount === 0) {
    return `Pulse could not reach the protected operator endpoints. A zaraa-daemon process exists, but nothing is listening on port ${port}.`;
  }
  return `Pulse could not reach the protected operator endpoints even though a local listener exists on port ${port} and a gateway API key is present. That usually points to a local networking or sandbox boundary rather than a missing daemon.`;
}
function printSection(title) {
  console.log(`
${title}`);
}
function printBullet(line) {
  console.log(`- ${line}`);
}
async function runPulse(port, taskLimit = 5) {
  const processSignals = await collectProcessSignals(port);
  const hasApiKey = Boolean(loadGatewayApiKey());
  const health = await requestGatewayJson(port, "/api/health");
  const ready = await requestGatewayJson(port, "/ready");
  const runtime = await requestGatewayJson(port, "/api/runtime/mode");
  const zone = await requestGatewayJson(port, "/api/zone");
  const extended = await requestGatewayJson(port, "/api/health/extended");
  const recentTasks = await requestGatewayJson(port, `/api/tasks?limit=${taskLimit}`);
  const failedTasks = await requestGatewayJson(port, `/api/tasks?status=failed&limit=${taskLimit}`);
  const snapshot = {
    health,
    ready,
    extended,
    runtime,
    zone,
    recentTasks,
    failedTasks,
    processSignals
  };
  console.log("Zaraa Pulse");
  printBullet(`Gateway health: ${health.data?.status ?? health.error ?? "unknown"}`);
  printBullet(`Gateway ready: ${ready.data?.status ?? ready.error ?? "unknown"}`);
  printBullet(`Runtime mode: ${runtime.data?.mode ?? runtime.error ?? "unknown"}`);
  printBullet(`Zone: ${zone.data?.zone ?? zone.error ?? "unknown"}`);
  printBullet(`Snapshot time: ${formatTimestamp(extended.data?.timestamp ?? health.data?.lastTraceAt)}`);
  printSection("System");
  printBullet(`Uptime: ${extended.data?.uptime?.human ?? `${formatNumber(health.data?.uptime)}s`}`);
  printBullet(`Task queue: ${formatNumber(health.data?.taskQueue?.pending)} pending / ${formatNumber(health.data?.taskQueue?.running)} running`);
  printBullet(`Scheduler: ${formatNumber(extended.data?.scheduler?.activeCount)} active, next run ${formatTimestamp(extended.data?.scheduler?.nextRunAt ?? null)}`);
  printBullet(`Memory: RSS ${formatMaybeFloat(extended.data?.memory?.rss?.mb)} MB, heap ${formatMaybeFloat(extended.data?.memory?.heapUsed?.mb)} / ${formatMaybeFloat(extended.data?.memory?.heapTotal?.mb)} MB`);
  printBullet(`Database: ${extended.data?.database?.connected ? "connected" : "disconnected"}, ${formatMaybeFloat(extended.data?.database?.sizeMB, 2)} MB`);
  printBullet(`Processes: daemon ${processSignals.daemonCount}, ollama ${processSignals.ollamaCount}, cloudflared ${processSignals.cloudflaredForGatewayCount}`);
  printBullet(`Gateway listener: ${processSignals.gatewayListenerCount > 0 ? `listening (${processSignals.gatewayListenerCount})` : "not detected"}`);
  printSection("Workflow");
  printBullet(`Task outcomes: ${formatNumber(extended.data?.taskStats?.success)} success / ${formatNumber(extended.data?.taskStats?.failure)} failure (${formatMaybeFloat(extended.data?.taskStats?.failureRate, 2)}% failure rate)`);
  printBullet(`Budget: ${formatNumber(health.data?.budget?.tokensUsedToday)} tokens today, $${formatMaybeFloat(health.data?.budget?.costToday, 2)} spend`);
  printBullet(`Ollama: ${health.data?.ollama ?? "unknown"}`);
  printBullet(`iMessage: ${extended.data?.imessage ? extended.data.imessage.healthy ? "healthy" : "degraded" : "not configured"}`);
  printBullet(`Tunnel: ${extended.data?.tunnel?.configured ? extended.data.tunnel.reachable === false ? "configured but unreachable" : "configured" : "not configured"}`);
  printBullet(`Heartbeat: ${extended.data?.heartbeat?.configured ? "configured" : "not configured"}`);
  const modelFailures = summarizeModelFailures(health.data?.models, 5);
  if (modelFailures.length > 0) {
    printSection("Model Pressure");
    for (const model of modelFailures) {
      printBullet(`${model.name}: ${model.failureCount} recent failures`);
    }
  }
  const alerts = buildPulseAlerts(snapshot);
  if (alerts.length > 0) {
    printSection("Operator Alerts");
    for (const alert of alerts) {
      printBullet(`[${alert.severity}] ${alert.message}`);
    }
  }
  const failed = failedTasks.data?.tasks ?? [];
  if (failed.length > 0) {
    printSection("Recent Failed Tasks");
    for (const task of failed.slice(0, taskLimit)) {
      printBullet(`${truncate(task.prompt)} | ${task.source ?? "unknown"} | ${formatTimestamp(task.createdAt)}`);
    }
  }
  const recent = recentTasks.data?.tasks ?? [];
  if (recent.length > 0) {
    printSection("Recent Activity");
    for (const task of recent.slice(0, taskLimit)) {
      const when = task.completedAt ?? task.createdAt;
      printBullet(`${task.status ?? "unknown"} | ${truncate(task.prompt)} | ${task.source ?? "unknown"} | ${formatTimestamp(when)}`);
    }
  }
  if (!health.ok && !extended.ok && !runtime.ok && !zone.ok) {
    console.error(`
${buildPulseFailureDiagnosis(snapshot, port, hasApiKey)}`);
    return 1;
  }
  return 0;
}

// src/commands/remote.ts
import { execFile as execFile2 } from "child_process";
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";
import { promisify as promisify2 } from "util";
var execFileAsync2 = promisify2(execFile2);
function describeTwilioVoiceStatus(snapshot) {
  if (!snapshot.twilioVoice?.enabled) {
    return "not configured";
  }
  if (snapshot.twilioVoice.hasConfiguredPublicUrl) {
    return "enabled (stable public URL configured)";
  }
  if (snapshot.twilioVoice.autoTunnelLikely) {
    return snapshot.cloudflaredProcesses.temporary > 0 ? "enabled (temporary public URL fallback active)" : "enabled (on-demand temporary public URL fallback)";
  }
  return "enabled";
}
function formatTimestamp2(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
function printSection2(title) {
  console.log(`
${title}`);
}
function printBullet2(line) {
  console.log(`- ${line}`);
}
function formatRemoteConfigFileLine(configPath, home = homedir()) {
  return `Config file: ${configPath ? compactHomePath(configPath, home) : "not found"}`;
}
function compactCommandLine(command, home = homedir()) {
  return command.split(/(\s+)/).map((part) => /\s/.test(part) ? part : compactHomePath(part, home)).join("");
}
function formatRemoteCleanupCommandLine(command, home = homedir()) {
  return `Command: ${compactCommandLine(command, home)}`;
}
function normalizeDnsName(value) {
  if (!value) return null;
  return value.endsWith(".") ? value.slice(0, -1) : value;
}
function extractIpv4(values2) {
  return (values2 ?? []).filter((item) => /^[0-9.]+$/.test(item));
}
function summarizeTwilioVoice(configData, configuredGatewayPublicUrl) {
  const twilio = configData?.voice?.twilio;
  const enabled = Boolean(twilio?.accountSid && twilio?.authToken);
  const hasConfiguredPublicUrl = Boolean(twilio?.publicUrl || configuredGatewayPublicUrl);
  return {
    enabled,
    hasPhoneNumber: Boolean(twilio?.fromNumber),
    hasConfiguredPublicUrl,
    autoTunnelLikely: enabled && !hasConfiguredPublicUrl
  };
}
function parseCloudflaredConfig(path) {
  if (!existsSync3(path)) {
    return { exists: false, tunnelId: null, hostnames: [] };
  }
  const raw = readFileSync2(path, "utf-8");
  const tunnelId = raw.match(/^\s*tunnel:\s*(.+)\s*$/m)?.[1]?.trim() ?? null;
  const hostnames = [...raw.matchAll(/^\s*-\s*hostname:\s*(.+)\s*$/gm)].map((match) => match[1].trim());
  return {
    exists: true,
    tunnelId,
    hostnames
  };
}
function readDaemonOwnerPid() {
  try {
    const ownerPath = join2(
      resolveRuntimeHomeDir(),
      ".zaraa",
      "locks",
      "zaraa-daemon.lock",
      "owner.json"
    );
    if (!existsSync3(ownerPath)) return null;
    const owner = JSON.parse(readFileSync2(ownerPath, "utf-8"));
    return Number.isInteger(owner.pid) && Number(owner.pid) > 0 ? Number(owner.pid) : null;
  } catch {
    return null;
  }
}
async function getGatewayListenerCount(port) {
  try {
    const { stdout } = await execFileAsync2("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(1).length;
  } catch {
    return 0;
  }
}
async function getLaunchdJobStatus(label) {
  try {
    const { stdout } = await execFileAsync2("launchctl", ["list"]);
    const line = stdout.split("\n").map((item) => item.trim()).find((item) => item.endsWith(label));
    if (!line) {
      return { label, loaded: false, pid: null, lastExitStatus: null };
    }
    const parts = line.split(/\s+/);
    const pid = parts[0] === "-" ? null : Number(parts[0]);
    const lastExitStatus = parts.length >= 2 ? Number(parts[1]) : null;
    return {
      label,
      loaded: true,
      pid: Number.isFinite(pid ?? NaN) ? pid : null,
      lastExitStatus: Number.isFinite(lastExitStatus ?? NaN) ? lastExitStatus : null,
      inferred: false
    };
  } catch {
    return { label, loaded: false, pid: null, lastExitStatus: null, inferred: false };
  }
}
function parseProcessTable(stdout) {
  return stdout.split("\n").map((line) => line.trim()).flatMap((row) => {
    const match = row.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      }
    ];
  });
}
async function getCloudflaredProcessSummary() {
  try {
    const { stdout } = await execFileAsync2("ps", ["ax", "-o", "pid=,ppid=,command="]);
    const items = parseProcessTable(stdout).filter((item) => item.command.startsWith("cloudflared "));
    const commands = items.map((item) => item.command);
    return {
      total: commands.length,
      temporary: commands.filter((line) => line.includes(" tunnel --url ")).length,
      named: commands.filter((line) => line.includes(" tunnel run ")).length,
      commands,
      items
    };
  } catch {
    return {
      total: 0,
      temporary: 0,
      named: 0,
      commands: [],
      items: []
    };
  }
}
async function getDaemonProcessSummary() {
  try {
    const { stdout } = await execFileAsync2("ps", ["ax", "-o", "pid=,ppid=,command="]);
    const items = parseProcessTable(stdout).filter((item) => item.command.includes("scripts/zaraa-daemon.mjs"));
    let launchdManaged = 0;
    let manual = 0;
    for (const item of items) {
      if (item.ppid === 1) launchdManaged++;
      else manual++;
    }
    return {
      total: items.length,
      launchdManaged,
      manual,
      commands: items.map((item) => item.command),
      items
    };
  } catch {
    return {
      total: 0,
      launchdManaged: 0,
      manual: 0,
      commands: [],
      items: []
    };
  }
}
function normalizeDaemonProcessSummary(summary, launchdPid) {
  const launchdManaged = launchdPid === null ? 0 : summary.items.filter((item) => item.pid === launchdPid).length;
  return {
    ...summary,
    launchdManaged,
    manual: Math.max(0, summary.items.length - launchdManaged)
  };
}
function summarizeTailscaleStatus(raw) {
  const parsed = JSON.parse(raw);
  const peers = Object.values(parsed.Peer ?? {}).map((peer) => ({
    hostName: peer.HostName ?? "unknown",
    dnsName: normalizeDnsName(peer.DNSName),
    os: peer.OS ?? null,
    online: Boolean(peer.Online),
    active: Boolean(peer.Active),
    ipv4: extractIpv4(peer.TailscaleIPs)
  }));
  const ipv4 = extractIpv4(parsed.Self?.TailscaleIPs ?? parsed.TailscaleIPs);
  return {
    installed: true,
    connected: parsed.BackendState === "Running" && ipv4.length > 0,
    backendState: parsed.BackendState ?? null,
    hostName: parsed.Self?.HostName ?? null,
    dnsName: normalizeDnsName(parsed.Self?.DNSName),
    ipv4,
    magicDnsSuffix: parsed.MagicDNSSuffix ?? null,
    onlinePeerCount: peers.filter((peer) => peer.online).length,
    activePeerCount: peers.filter((peer) => peer.active).length,
    iphonePeerOnline: peers.some((peer) => peer.online && peer.os === "iOS"),
    peers,
    error: null
  };
}
function formatCommandErrorDetail(raw) {
  const normalized = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return "unavailable";
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
async function getTailscaleStatusSummary() {
  try {
    const { stdout, stderr } = await execFileAsync2("tailscale", ["status", "--json"]);
    try {
      return summarizeTailscaleStatus(stdout);
    } catch (error) {
      return {
        installed: true,
        connected: false,
        backendState: null,
        hostName: null,
        dnsName: null,
        ipv4: [],
        magicDnsSuffix: null,
        onlinePeerCount: 0,
        activePeerCount: 0,
        iphonePeerOnline: false,
        peers: [],
        error: formatCommandErrorDetail(stdout || stderr || (error instanceof Error ? error.message : String(error)))
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return {
        installed: false,
        connected: false,
        backendState: null,
        hostName: null,
        dnsName: null,
        ipv4: [],
        magicDnsSuffix: null,
        onlinePeerCount: 0,
        activePeerCount: 0,
        iphonePeerOnline: false,
        peers: [],
        error: null
      };
    }
    return {
      installed: true,
      connected: false,
      backendState: null,
      hostName: null,
      dnsName: null,
      ipv4: [],
      magicDnsSuffix: null,
      onlinePeerCount: 0,
      activePeerCount: 0,
      iphonePeerOnline: false,
      peers: [],
      error: formatCommandErrorDetail(
        (typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : void 0) || (typeof error === "object" && error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : void 0) || message
      )
    };
  }
}
function applyDaemonOwnerFallback(launchdDaemon, daemonProcesses, ownerPid) {
  if (ownerPid === null) {
    return {
      launchdDaemon,
      daemonProcesses: normalizeDaemonProcessSummary(daemonProcesses, launchdDaemon.pid)
    };
  }
  const normalizedLaunchd = launchdDaemon.loaded ? launchdDaemon : {
    ...launchdDaemon,
    loaded: true,
    pid: ownerPid,
    inferred: true
  };
  const normalizedProcesses = normalizeDaemonProcessSummary(daemonProcesses, normalizedLaunchd.pid);
  if (normalizedProcesses.total > 0) {
    return {
      launchdDaemon: normalizedLaunchd,
      daemonProcesses: {
        ...normalizedProcesses,
        inferred: normalizedProcesses.items.length === 0
      }
    };
  }
  return {
    launchdDaemon: normalizedLaunchd,
    daemonProcesses: {
      ...normalizedProcesses,
      total: 1,
      launchdManaged: 1,
      manual: 0,
      inferred: true
    }
  };
}
function buildRemoteFailureDiagnosis(snapshot, port, hasApiKey, healthResult) {
  if (healthResult.status === 401) {
    return "Remote status reached the gateway, but the API key was rejected (HTTP 401). Check gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.";
  }
  if (!hasApiKey) {
    return "Remote status could not read /api/health/extended because no local gateway API key was found in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.";
  }
  if (snapshot.daemonProcesses.total === 0) {
    return "Remote status could not read /api/health/extended, and no zaraa-daemon process was detected. Start or restart the daemon first.";
  }
  if (snapshot.gatewayListenerCount === 0) {
    return `Remote status could not read /api/health/extended. A zaraa-daemon process exists, but nothing is listening on port ${port}.`;
  }
  return `Remote status could not read /api/health/extended even though a local listener exists on port ${port} and a gateway API key is present. That usually points to a local networking or sandbox boundary rather than a missing daemon.`;
}
async function collectRemoteStatusSnapshot(port) {
  const config = loadLocalZaraaConfig();
  const configuredPublicUrl = config.data?.gateway?.publicUrl ?? null;
  const configuredHeartbeatUrl = config.data?.notifications?.healthchecksUrl ?? null;
  const cloudflaredConfigPath = join2(homedir(), ".cloudflared", "config.yml");
  const cloudflaredPlistPath = join2(homedir(), "Library", "LaunchAgents", "com.zaraa.cloudflared.plist");
  const twilioVoice = summarizeTwilioVoice(config.data, configuredPublicUrl);
  const daemonOwnerPid = readDaemonOwnerPid();
  const [healthResult, gatewayListenerCount, launchdDaemon, launchdCloudflared, cloudflaredProcesses, rawDaemonProcesses, tailscale] = await Promise.all([
    requestGatewayJson(port, "/api/health/extended"),
    getGatewayListenerCount(port),
    getLaunchdJobStatus("com.zaraa.daemon"),
    getLaunchdJobStatus("com.zaraa.cloudflared"),
    getCloudflaredProcessSummary(),
    getDaemonProcessSummary(),
    getTailscaleStatusSummary()
  ]);
  const daemonState = applyDaemonOwnerFallback(launchdDaemon, rawDaemonProcesses, daemonOwnerPid);
  const cloudflaredConfig = parseCloudflaredConfig(cloudflaredConfigPath);
  return {
    healthResult,
    snapshot: {
      configPath: config.path,
      configuredPublicUrl,
      configuredHeartbeatUrl,
      health: healthResult.data,
      gatewayListenerCount,
      launchdDaemon: daemonState.launchdDaemon,
      launchdCloudflared,
      cloudflaredConfig,
      cloudflaredPlistInstalled: existsSync3(cloudflaredPlistPath),
      cloudflaredProcesses,
      daemonProcesses: daemonState.daemonProcesses,
      tailscale,
      twilioVoice
    }
  };
}
function buildRemoteRecommendations(snapshot) {
  const recommendations = [];
  const tunnel = snapshot.health?.tunnel;
  const heartbeat = snapshot.health?.heartbeat;
  const tailscale = snapshot.tailscale;
  const twilioVoice = snapshot.twilioVoice;
  const singleTemporaryTunnelLikelyForTwilio = Boolean(twilioVoice?.autoTunnelLikely) && snapshot.cloudflaredProcesses.total === 1 && snapshot.cloudflaredProcesses.temporary === 1 && !snapshot.cloudflaredConfig.exists && !snapshot.cloudflaredPlistInstalled && !snapshot.configuredPublicUrl;
  if (snapshot.daemonProcesses.total > 1) {
    recommendations.push({
      severity: "high",
      message: `There are ${snapshot.daemonProcesses.total} Zaraa daemon processes running (${snapshot.daemonProcesses.launchdManaged} launchd-managed, ${snapshot.daemonProcesses.manual} manual). Keep one authority, or runtime state can drift between instances. Run \`zaraa remote cleanup\` for a safe preview.`
    });
  }
  if (snapshot.cloudflaredProcesses.total > 1) {
    recommendations.push({
      severity: "medium",
      message: `There are ${snapshot.cloudflaredProcesses.total} cloudflared processes running. Keep one tunnel path, or stop the extras so remote behavior stays predictable. Run \`zaraa remote cleanup\` to preview which extras can be retired.`
    });
  }
  if (snapshot.cloudflaredProcesses.temporary > 0 && !snapshot.cloudflaredConfig.exists && !snapshot.cloudflaredPlistInstalled && !snapshot.configuredPublicUrl && !singleTemporaryTunnelLikelyForTwilio) {
    recommendations.push({
      severity: "high",
      message: "Temporary Cloudflare tunnels are running, but there is no persistent tunnel config, launchd service, or gateway publicUrl. Run `zaraa remote cleanup` to preview stopping the temporary extras, or `scripts/setup-remote-access.sh` and choose option 3 when you want a stable remote URL."
    });
  }
  if (singleTemporaryTunnelLikelyForTwilio) {
    recommendations.push({
      severity: "medium",
      message: "Twilio voice is configured without a persistent public URL, so Zaraa is keeping one temporary Cloudflare tunnel alive for call webhooks. That works, but the URL rotates on restart. Add `gateway.publicUrl` or `voice.twilio.publicUrl` when you want stable phone-call reachability."
    });
  }
  if (twilioVoice?.autoTunnelLikely && snapshot.cloudflaredProcesses.temporary === 0) {
    recommendations.push({
      severity: "medium",
      message: "Twilio voice is configured without a persistent public URL, and no temporary Cloudflare tunnel is currently visible. Voice callbacks will depend on Zaraa bringing up a temporary public URL at call time, which is less predictable than a pinned callback URL. Add `gateway.publicUrl` or `voice.twilio.publicUrl` when you want stable phone-call reachability."
    });
  }
  if (!snapshot.configuredPublicUrl && snapshot.cloudflaredProcesses.total === 0 && !tailscale?.connected) {
    recommendations.push({
      severity: "low",
      message: "Remote browser/iPhone access is not configured yet. Use Tailscale for private access or `scripts/setup-remote-access.sh` option 3 for a persistent Cloudflare tunnel."
    });
  }
  if (!snapshot.configuredPublicUrl && tailscale?.connected) {
    const primaryIp = tailscale.ipv4[0] ?? null;
    const dnsName = tailscale.dnsName ?? null;
    recommendations.push({
      severity: "low",
      message: `Tailscale is already connected${primaryIp ? ` (${primaryIp})` : ""}${tailscale.iphonePeerOnline ? " and your iPhone peer is online" : ""}. Use that private path now, and add a persistent Cloudflare tunnel only when you want browser access without VPN.`
    });
    if (dnsName && snapshot.cloudflaredProcesses.temporary > 0) {
      recommendations.push({
        severity: "low",
        message: `Because Tailscale is working, the temporary Cloudflare tunnels are optional. Prefer http://${dnsName}:3927 or stop the trycloudflare sessions when you no longer need public access.`
      });
    }
  }
  if (snapshot.cloudflaredConfig.exists && !snapshot.cloudflaredPlistInstalled) {
    recommendations.push({
      severity: "medium",
      message: "Cloudflare tunnel config exists, but the launchd plist is not installed. The tunnel may work only when started manually."
    });
  }
  if (snapshot.cloudflaredPlistInstalled && !snapshot.launchdCloudflared.loaded) {
    recommendations.push({
      severity: "medium",
      message: "The Cloudflare launchd plist is installed but not loaded. Reload `com.zaraa.cloudflared` if you expect the tunnel to stay up automatically."
    });
  }
  if (tunnel?.configured && tunnel.reachable === false) {
    recommendations.push({
      severity: "high",
      message: `The configured public URL is not reachable through the gateway health probe${tunnel.lastError ? ` (${tunnel.lastError})` : ""}.`
    });
  }
  if (!snapshot.configuredHeartbeatUrl && heartbeat?.configured === false) {
    recommendations.push({
      severity: "low",
      message: "External outage alerting is not configured. Add `notifications.healthchecksUrl` when you want a dead-man heartbeat off the machine."
    });
  }
  if (heartbeat?.configured && heartbeat.lastPingOk === false) {
    recommendations.push({
      severity: "medium",
      message: `Heartbeat alerts are configured but the last ping failed${heartbeat.lastError ? ` (${heartbeat.lastError})` : ""}.`
    });
  }
  if (snapshot.health?.imessage && snapshot.health.imessage.healthy === false) {
    recommendations.push({
      severity: "medium",
      message: `The iMessage bridge is degraded${snapshot.health.imessage.lastError ? ` (${snapshot.health.imessage.lastError})` : ""}.`
    });
  }
  return recommendations.slice(0, 6);
}
function buildRemoteCleanupPlan(snapshot) {
  const actions = [];
  const warnings = [];
  const retainedDaemonPids = new Set(
    snapshot.launchdDaemon.pid !== null ? [snapshot.launchdDaemon.pid] : []
  );
  const manualDaemons = snapshot.daemonProcesses.items.filter((item) => !retainedDaemonPids.has(item.pid));
  const manualDaemonPids = new Set(manualDaemons.map((item) => item.pid));
  const temporaryCloudflared = snapshot.cloudflaredProcesses.items.filter((item) => item.command.includes(" tunnel --url "));
  for (const daemon of manualDaemons) {
    actions.push({
      pid: daemon.pid,
      signal: "SIGTERM",
      label: "manual daemon",
      reason: "duplicate daemon outside launchd supervision",
      command: daemon.command
    });
  }
  for (const tunnel of temporaryCloudflared) {
    const tiedToManualDaemon = manualDaemonPids.has(tunnel.ppid);
    const orphanedTemporaryTunnel = tunnel.ppid === 1 || !manualDaemonPids.has(tunnel.ppid) && !retainedDaemonPids.has(tunnel.ppid);
    const safeToCullExtras = !snapshot.configuredPublicUrl && !snapshot.cloudflaredConfig.exists && Boolean(snapshot.tailscale?.connected);
    if (!tiedToManualDaemon && !orphanedTemporaryTunnel) continue;
    if (!tiedToManualDaemon && !safeToCullExtras) continue;
    if (actions.some((action) => action.pid === tunnel.pid)) continue;
    actions.push({
      pid: tunnel.pid,
      signal: "SIGTERM",
      label: "temporary cloudflared",
      reason: tiedToManualDaemon ? "spawned by a manual daemon that is scheduled for cleanup" : "extra temporary tunnel while Tailscale is already available",
      command: tunnel.command
    });
  }
  if (snapshot.daemonProcesses.launchdManaged > 1) {
    warnings.push("Multiple launchd-managed daemons are running. The cleanup helper leaves them alone so you can inspect launchd state separately.");
  }
  if (snapshot.cloudflaredProcesses.named > 0) {
    warnings.push("Named Cloudflare tunnels are present. Cleanup targets only temporary tunnels and leaves named tunnels running.");
  }
  if (actions.length === 0 && (snapshot.daemonProcesses.total > 1 || snapshot.cloudflaredProcesses.total > 1)) {
    warnings.push("Duplicate processes were detected, but none matched the conservative cleanup rules. Inspect `zaraa remote` output before stopping anything manually.");
  }
  return { actions, warnings };
}
function buildRemoteAccessPaths(snapshot, port) {
  const publicUrl = snapshot.configuredPublicUrl ?? snapshot.health?.tunnel?.publicUrl ?? null;
  const paths = [];
  const singleTemporaryTunnelLikelyForTwilio = Boolean(snapshot.twilioVoice?.autoTunnelLikely) && snapshot.cloudflaredProcesses.total === 1 && snapshot.cloudflaredProcesses.temporary === 1 && !snapshot.cloudflaredConfig.exists && !snapshot.cloudflaredPlistInstalled && !publicUrl;
  if (snapshot.tailscale?.installed) {
    const primaryIp = snapshot.tailscale.ipv4[0] ?? null;
    const dnsName = snapshot.tailscale.dnsName ? `http://${snapshot.tailscale.dnsName}:${port}` : null;
    paths.push({
      name: "Tailscale",
      readiness: snapshot.tailscale.connected && primaryIp ? "ready" : "partial",
      primary: primaryIp ? `http://${primaryIp}:${port}` : null,
      secondary: dnsName,
      note: snapshot.tailscale.connected ? `${snapshot.tailscale.iphonePeerOnline ? "iPhone peer online" : "Private mesh available"}${snapshot.tailscale.activePeerCount > 0 ? `, ${snapshot.tailscale.activePeerCount} active peer${snapshot.tailscale.activePeerCount === 1 ? "" : "s"}` : ""}` : `Installed${snapshot.tailscale.backendState ? `, backend state ${snapshot.tailscale.backendState}` : ""}${snapshot.tailscale.error ? ` (${snapshot.tailscale.error})` : ""}`
    });
  } else {
    paths.push({
      name: "Tailscale",
      readiness: "missing",
      primary: null,
      secondary: null,
      note: "Not installed"
    });
  }
  let cloudflareReadiness = "missing";
  if (publicUrl && snapshot.health?.tunnel?.reachable === false) cloudflareReadiness = "partial";
  else if (publicUrl) cloudflareReadiness = "ready";
  else if (snapshot.cloudflaredProcesses.total > 0 || snapshot.cloudflaredConfig.exists) cloudflareReadiness = "partial";
  paths.push({
    name: "Cloudflare",
    readiness: cloudflareReadiness,
    primary: publicUrl,
    secondary: snapshot.cloudflaredConfig.hostnames.length > 0 ? snapshot.cloudflaredConfig.hostnames.map((host) => `https://${host}`).join(", ") : null,
    note: publicUrl && snapshot.health?.tunnel?.reachable === false ? `Configured but unreachable${snapshot.health.tunnel.lastError ? ` (${snapshot.health.tunnel.lastError})` : ""}` : singleTemporaryTunnelLikelyForTwilio ? "One temporary trycloudflare tunnel is likely serving Twilio voice callbacks" : snapshot.twilioVoice?.autoTunnelLikely && snapshot.cloudflaredProcesses.temporary === 0 ? "No public tunnel is currently visible; Twilio voice will rely on an on-demand temporary callback URL" : snapshot.cloudflaredProcesses.temporary > 0 && !snapshot.cloudflaredConfig.exists ? `${snapshot.cloudflaredProcesses.temporary} temporary trycloudflare tunnel${snapshot.cloudflaredProcesses.temporary === 1 ? "" : "s"} running` : snapshot.cloudflaredConfig.exists ? "Persistent tunnel config present" : "No public tunnel configured"
  });
  paths.push({
    name: "Heartbeat Alerts",
    readiness: snapshot.configuredHeartbeatUrl && snapshot.health?.heartbeat?.lastPingOk === false ? "partial" : snapshot.configuredHeartbeatUrl ? "ready" : "missing",
    primary: snapshot.configuredHeartbeatUrl,
    secondary: null,
    note: snapshot.configuredHeartbeatUrl ? snapshot.health?.heartbeat?.lastPingOk === false ? `Configured but failing${snapshot.health.heartbeat.lastError ? ` (${snapshot.health.heartbeat.lastError})` : ""}` : "Configured" : "No external dead-man heartbeat configured"
  });
  return paths;
}
async function runRemoteCleanup(port, options = {}) {
  const { snapshot } = await collectRemoteStatusSnapshot(port);
  const plan = buildRemoteCleanupPlan(snapshot);
  const apply = options.apply === true && options.dryRun !== true;
  console.log("Zaraa Remote Cleanup");
  printBullet2(`Mode: ${apply ? "apply" : "dry run"}`);
  printBullet2(`Daemon processes observed: ${snapshot.daemonProcesses.total}`);
  printBullet2(`Temporary cloudflared observed: ${snapshot.cloudflaredProcesses.temporary}`);
  if (plan.actions.length === 0) {
    printBullet2("No cleanup actions are recommended right now.");
    if (plan.warnings.length > 0) {
      printSection2("Warnings");
      for (const warning of plan.warnings) {
        printBullet2(warning);
      }
    }
    return 0;
  }
  printSection2("Planned Actions");
  for (const action of plan.actions) {
    printBullet2(`pid ${action.pid} (${action.label}) \u2014 ${action.reason}`);
    printBullet2(formatRemoteCleanupCommandLine(action.command));
  }
  if (plan.warnings.length > 0) {
    printSection2("Warnings");
    for (const warning of plan.warnings) {
      printBullet2(warning);
    }
  }
  if (!apply) {
    console.log("\nDry run only \u2014 no processes were signaled. Re-run with `zaraa remote cleanup --apply` when you want to execute this plan.");
    return 0;
  }
  let failures = 0;
  for (const action of plan.actions) {
    try {
      process.kill(action.pid, action.signal);
      printBullet2(`Sent ${action.signal} to pid ${action.pid} (${action.label}).`);
    } catch (error) {
      failures++;
      console.error(
        `Failed to signal pid ${action.pid}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failures > 0) return 1;
  console.log("\nCleanup signals sent. Re-run `zaraa remote` in a few seconds to confirm the remaining posture.");
  return 0;
}
async function runRemoteStatus(port, action) {
  if (action !== void 0 && !["show", "status"].includes(action)) {
    console.log("Usage: zaraa remote [status] | zaraa remote cleanup [--dry-run|--apply]");
    return 1;
  }
  const { snapshot, healthResult } = await collectRemoteStatusSnapshot(port);
  const hasApiKey = Boolean(loadGatewayApiKey());
  const configuredPublicUrl = snapshot.configuredPublicUrl;
  const configuredHeartbeatUrl = snapshot.configuredHeartbeatUrl;
  console.log("Zaraa Remote");
  printBullet2(formatRemoteConfigFileLine(snapshot.configPath));
  printBullet2(`Gateway public URL: ${configuredPublicUrl ?? "not configured"}`);
  printBullet2(`Heartbeat URL: ${configuredHeartbeatUrl ?? "not configured"}`);
  printBullet2(`Snapshot time: ${formatTimestamp2(snapshot.health?.timestamp ?? null)}`);
  printSection2("Gateway View");
  printBullet2(`Tunnel health: ${snapshot.health?.tunnel?.configured ? snapshot.health.tunnel.reachable === true ? "reachable" : snapshot.health.tunnel.reachable === false ? "configured but unreachable" : "configured" : "not configured"}`);
  printBullet2(`Tunnel last check: ${formatTimestamp2(snapshot.health?.tunnel?.lastCheckedAt ?? null)}`);
  if (snapshot.health?.tunnel?.lastError) {
    printBullet2(`Tunnel error: ${snapshot.health.tunnel.lastError}`);
  }
  printBullet2(`iMessage bridge: ${snapshot.health?.imessage ? snapshot.health.imessage.healthy ? "healthy" : "degraded" : "not configured"}`);
  if (snapshot.health?.imessage) {
    printBullet2(`iMessage processed: ${snapshot.health.imessage.messagesProcessed ?? 0}`);
  }
  printBullet2(`Heartbeat alerts: ${snapshot.health?.heartbeat?.configured ? snapshot.health.heartbeat.lastPingOk === false ? "configured but failing" : "configured" : "not configured"}`);
  if (snapshot.health?.heartbeat?.configured) {
    printBullet2(`Heartbeat last ping: ${formatTimestamp2(snapshot.health.heartbeat.lastPingAt ?? null)}`);
  }
  printSection2("Access Paths");
  for (const path of buildRemoteAccessPaths(snapshot, port)) {
    const summary = `${path.name}: ${path.readiness}`;
    if (path.primary) {
      printBullet2(`${summary} \u2014 ${path.primary}`);
    } else {
      printBullet2(summary);
    }
    if (path.secondary) {
      printBullet2(`${path.name} alternate: ${path.secondary}`);
    }
    printBullet2(`${path.name} note: ${path.note}`);
  }
  printSection2("Local Setup");
  printBullet2(
    `Daemon launchd job: ${snapshot.launchdDaemon.loaded ? snapshot.launchdDaemon.inferred ? `inferred from owner lock${snapshot.launchdDaemon.pid ? ` (pid ${snapshot.launchdDaemon.pid})` : ""}` : `loaded${snapshot.launchdDaemon.pid ? ` (pid ${snapshot.launchdDaemon.pid})` : ""}` : "not loaded"}`
  );
  printBullet2(
    `Daemon processes: ${snapshot.daemonProcesses.total} total (${snapshot.daemonProcesses.launchdManaged} launchd-managed, ${snapshot.daemonProcesses.manual} manual)${snapshot.daemonProcesses.inferred ? " [owner lock fallback]" : ""}`
  );
  printBullet2(`Gateway listener: ${snapshot.gatewayListenerCount > 0 ? `listening (${snapshot.gatewayListenerCount})` : "not detected"}`);
  printBullet2(
    `Twilio voice: ${describeTwilioVoiceStatus(snapshot)}`
  );
  printBullet2(`Tailscale: ${snapshot.tailscale?.installed ? snapshot.tailscale.connected ? "connected" : "installed but not connected" : "not installed"}`);
  if (snapshot.tailscale?.installed) {
    printBullet2(`Tailscale host: ${snapshot.tailscale.hostName ?? "unknown"}`);
    printBullet2(`Tailscale DNS: ${snapshot.tailscale.dnsName ?? "unknown"}`);
    printBullet2(`Tailscale IPv4: ${snapshot.tailscale.ipv4.length > 0 ? snapshot.tailscale.ipv4.join(", ") : "none"}`);
    printBullet2(`Tailscale peers: ${snapshot.tailscale.onlinePeerCount} online, ${snapshot.tailscale.activePeerCount} active`);
    if (snapshot.tailscale.error) {
      printBullet2(`Tailscale error: ${snapshot.tailscale.error}`);
    }
  }
  printBullet2(`Cloudflare launchd job: ${snapshot.launchdCloudflared.loaded ? `loaded${snapshot.launchdCloudflared.pid ? ` (pid ${snapshot.launchdCloudflared.pid})` : ""}` : "not loaded"}`);
  printBullet2(`Cloudflare plist: ${snapshot.cloudflaredPlistInstalled ? "installed" : "missing"}`);
  printBullet2(`Cloudflare config: ${snapshot.cloudflaredConfig.exists ? "present" : "missing"}`);
  if (snapshot.cloudflaredConfig.exists) {
    printBullet2(`Cloudflare tunnel id: ${snapshot.cloudflaredConfig.tunnelId ?? "unknown"}`);
    printBullet2(`Cloudflare hostnames: ${snapshot.cloudflaredConfig.hostnames.length > 0 ? snapshot.cloudflaredConfig.hostnames.join(", ") : "none found"}`);
  }
  printBullet2(`Cloudflared processes: ${snapshot.cloudflaredProcesses.total} total (${snapshot.cloudflaredProcesses.temporary} temporary, ${snapshot.cloudflaredProcesses.named} named)`);
  if (snapshot.cloudflaredProcesses.commands.length > 0) {
    printSection2("Cloudflared Commands");
    for (const command of snapshot.cloudflaredProcesses.commands.slice(0, 5)) {
      printBullet2(compactCommandLine(command));
    }
  }
  if (snapshot.daemonProcesses.commands.length > 1) {
    printSection2("Daemon Commands");
    for (const command of snapshot.daemonProcesses.commands.slice(0, 5)) {
      printBullet2(compactCommandLine(command));
    }
  }
  const recommendations = buildRemoteRecommendations(snapshot);
  if (recommendations.length > 0) {
    printSection2("Recommendations");
    for (const item of recommendations) {
      printBullet2(`[${item.severity}] ${item.message}`);
    }
  }
  if (!healthResult.ok) {
    console.error(`
${buildRemoteFailureDiagnosis(snapshot, port, hasApiKey, healthResult)}`);
    return 1;
  }
  return 0;
}

// src/commands/self-improve.ts
import { existsSync as existsSync4 } from "fs";
import { spawnSync as spawnSync2 } from "child_process";
import { dirname as dirname2, resolve as resolve2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var SUBMITTER2 = "scripts/submit-self-improvement-patches.mjs";
function resolveSelfImproveSubmitterPath() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  const repo = process.env.ZARAA_REPO_ROOT;
  const candidates = [
    resolve2(here, `../../../../${SUBMITTER2}`),
    resolve2(here, `../../../${SUBMITTER2}`),
    ...repo ? [resolve2(repo, SUBMITTER2)] : []
  ];
  return candidates.find((file) => existsSync4(file)) ?? null;
}
function pushFlag2(args, name, value) {
  if (value?.trim()) {
    args.push(`--${name}=${value.trim()}`);
  }
}
function buildScriptArgs2(subcommand2, positionals2, options) {
  const args = [];
  if (subcommand2 === "disciplines" || subcommand2 === "list") {
    args.push("--list-disciplines");
  } else if (subcommand2 === "preview") {
    args.push("--dry-run");
    args.push(options.full ? "--preview=full" : "--preview=brief");
  } else if (subcommand2 === "send" || !subcommand2) {
  } else {
    throw new Error(
      `Unknown self-improve action "${subcommand2}". Use disciplines, preview, or send.`
    );
  }
  const selector = positionals2[0];
  if (!selector || selector === "starter") {
    args.push("--starter");
  } else if (selector === "wave") {
    const wave = positionals2[1];
    if (!wave) {
      throw new Error("Usage: zaraa self-improve preview|send wave <number>");
    }
    args.push(`--wave=${wave}`);
  } else if (selector === "task") {
    const taskId = options.task ?? positionals2[1];
    if (!taskId) {
      throw new Error("Usage: zaraa self-improve preview|send task <task-id>");
    }
    args.push(`--task=${taskId}`);
  } else if (selector === "all") {
    args.push("--all");
  } else {
    args.push("--starter");
  }
  pushFlag2(args, "discipline", options.discipline);
  pushFlag2(args, "match", options.match);
  pushFlag2(args, "task", options.task);
  pushFlag2(args, "voice", options.voice);
  pushFlag2(args, "limit", options.limit);
  pushFlag2(args, "delay-ms", options.delayMs);
  return args;
}
function runSelfImprove(subcommand2, positionals2, options) {
  const scriptPath = resolveSelfImproveSubmitterPath();
  if (!scriptPath) {
    console.error(
      "Self-improve submitter not found. From the zara monorepo: scripts/submit-self-improvement-patches.mjs, or export ZARAA_REPO_ROOT=/path/to/zara"
    );
    return 1;
  }
  const scriptArgs = buildScriptArgs2(subcommand2, positionals2, options);
  const result = spawnSync2(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: dirname2(dirname2(scriptPath)),
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

// src/commands/workflow-controls.ts
function isZoneName2(value) {
  return typeof value === "string" && VALID_ZONES.includes(value);
}
function isRuntimeMode2(value) {
  return typeof value === "string" && VALID_RUNTIME_MODES.includes(value);
}
function printBullet3(line) {
  console.log(`- ${line}`);
}
function printPlan(title, current, desired) {
  console.log(title);
  printBullet3(`Current zone: ${current.zone}`);
  printBullet3(`Current runtime mode: ${current.runtimeMode}${current.runtimePaused ? " (paused)" : ""}`);
  printBullet3(`Current task generation: ${current.taskGenerationPaused ? "paused" : "active"}`);
  printBullet3(`Target zone: ${desired.zone}`);
  printBullet3(`Target runtime mode: ${desired.runtimeMode}${desired.runtimePaused ? " (paused)" : ""}`);
  printBullet3(`Target task generation: ${desired.taskGenerationPaused ? "paused" : "active"}`);
}
async function getWorkflowState(port) {
  const [zoneResult, runtimeResult, taskGenerationResult] = await Promise.all([
    requestGatewayJson(port, "/api/zone"),
    requestGatewayJson(port, "/api/runtime/mode"),
    requestGatewayJson(port, "/api/tasks/generation")
  ]);
  if (!zoneResult.ok || !runtimeResult.ok || !taskGenerationResult.ok) {
    console.error(
      `Failed to read workflow state: zone=${zoneResult.error ?? zoneResult.status}, runtime=${runtimeResult.error ?? runtimeResult.status}, task-generation=${taskGenerationResult.error ?? taskGenerationResult.status}`
    );
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(
      buildGatewayAccessFailureMessage(
        "Workflow state is unavailable.",
        port,
        snapshot,
        [zoneResult, runtimeResult, taskGenerationResult]
      )
    );
    return null;
  }
  return {
    zone: zoneResult.data?.zone ?? "unknown",
    runtimeMode: runtimeResult.data?.mode ?? "unknown",
    runtimePaused: Boolean(runtimeResult.data?.paused),
    taskGenerationPaused: Boolean(taskGenerationResult.data?.paused)
  };
}
async function setZone(port, zone) {
  const result = await requestGatewayJson(port, "/api/zone", {
    method: "POST",
    body: { zone }
  });
  if (!result.ok) {
    console.error(`Failed to update zone: ${result.error ?? "unknown error"}`);
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(buildGatewayAccessFailureMessage("Zone update failed.", port, snapshot, [result]));
    return false;
  }
  console.log(`Zone set to ${result.data?.zone ?? zone}.`);
  return true;
}
async function setRuntimeMode(port, mode) {
  const result = await requestGatewayJson(port, "/api/runtime/mode", {
    method: "POST",
    body: { mode }
  });
  if (!result.ok) {
    console.error(`Failed to update runtime mode: ${result.error ?? "unknown error"}`);
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(buildGatewayAccessFailureMessage("Runtime update failed.", port, snapshot, [result]));
    return false;
  }
  console.log(`Runtime mode set to ${result.data?.mode ?? mode}.`);
  return true;
}
async function setTaskGenerationPaused(port, paused) {
  const result = await requestGatewayJson(port, "/api/tasks/generation", {
    method: "POST",
    body: paused ? { paused } : {
      paused,
      reason: "cli resume command: operator requested task generation resume"
    }
  });
  if (!result.ok) {
    console.error(`Failed to update task generation state: ${result.error ?? "unknown error"}`);
    const snapshot = await collectGatewayAccessSnapshot(port);
    console.error(buildGatewayAccessFailureMessage("Task-generation update failed.", port, snapshot, [result]));
    return false;
  }
  console.log(`Task generation ${result.data?.paused ? "paused" : "resumed"}.`);
  return true;
}
async function runPauseCommand(port, options = {}) {
  const targetZone = options.zoneOverride;
  if (targetZone && !isZoneName2(targetZone)) {
    console.log("Usage: zaraa pause [--zone sandbox|guarded|trusted] [--dry-run]");
    return 1;
  }
  const current = await getWorkflowState(port);
  if (!current) return 1;
  const desired = {
    zone: targetZone ?? "sandbox",
    runtimeMode: "pause",
    runtimePaused: true,
    taskGenerationPaused: true
  };
  printPlan("Zaraa Pause Plan", current, desired);
  const needsTaskGenerationChange = current.taskGenerationPaused !== desired.taskGenerationPaused;
  const needsRuntimeChange = current.runtimeMode !== desired.runtimeMode || current.runtimePaused !== desired.runtimePaused;
  const needsZoneChange = current.zone !== desired.zone;
  if (!needsTaskGenerationChange && !needsRuntimeChange && !needsZoneChange) {
    console.log("No changes needed.");
    return 0;
  }
  if (options.dryRun) {
    console.log("Dry run only \u2014 no changes applied.");
    return 0;
  }
  if (needsTaskGenerationChange && !await setTaskGenerationPaused(port, true)) return 1;
  if (needsRuntimeChange && !await setRuntimeMode(port, "pause")) return 1;
  if (needsZoneChange && !await setZone(port, desired.zone)) return 1;
  return 0;
}
async function runResumeCommand(port, modeOverride, options = {}) {
  if (modeOverride && !isRuntimeMode2(modeOverride)) {
    console.log("Usage: zaraa resume [slow|medium|fast] [--zone sandbox|guarded|trusted] [--dry-run]");
    return 1;
  }
  if (modeOverride === "pause") {
    console.log("Usage: zaraa resume [slow|medium|fast] [--zone sandbox|guarded|trusted] [--dry-run]");
    return 1;
  }
  const targetZone = options.zoneOverride;
  if (targetZone && !isZoneName2(targetZone)) {
    console.log("Usage: zaraa resume [slow|medium|fast] [--zone sandbox|guarded|trusted] [--dry-run]");
    return 1;
  }
  const current = await getWorkflowState(port);
  if (!current) return 1;
  const desiredMode = modeOverride ?? "medium";
  const desired = {
    zone: targetZone ?? "guarded",
    runtimeMode: desiredMode,
    runtimePaused: false,
    taskGenerationPaused: false
  };
  printPlan("Zaraa Resume Plan", current, desired);
  const needsZoneChange = current.zone !== desired.zone;
  const needsTaskGenerationChange = current.taskGenerationPaused !== desired.taskGenerationPaused;
  const needsRuntimeChange = current.runtimeMode !== desired.runtimeMode || current.runtimePaused !== desired.runtimePaused;
  if (!needsZoneChange && !needsTaskGenerationChange && !needsRuntimeChange) {
    console.log("No changes needed.");
    return 0;
  }
  if (options.dryRun) {
    console.log("Dry run only \u2014 no changes applied.");
    return 0;
  }
  if (needsZoneChange && !await setZone(port, desired.zone)) return 1;
  if (needsTaskGenerationChange && !await setTaskGenerationPaused(port, false)) return 1;
  if (needsRuntimeChange && !await setRuntimeMode(port, desiredMode)) return 1;
  return 0;
}

// src/components/ChatView.tsx
import { randomUUID as randomUUID2 } from "crypto";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// src/components/chat-request.ts
import { randomUUID } from "crypto";
function buildCliChatRequestBody(message, options = {}) {
  const createRequestId = options.createRequestId ?? randomUUID;
  return {
    requestId: createRequestId(),
    message,
    ...options.sessionId ? { sessionId: options.sessionId } : {},
    ...options.surface ? { surface: options.surface } : {},
    ...options.interactionMode ? { interactionMode: options.interactionMode } : {},
    ...options.zone ? { zone: options.zone } : {},
    ...options.cwd ? { cwd: options.cwd } : {}
  };
}

// src/components/chat-stream.ts
function reconcileAssistantMessage(messages, assistant, mode) {
  const index = messages.findIndex((message) => message.id === assistant.id);
  if (index < 0) return [...messages, assistant];
  return messages.map(
    (message, currentIndex) => currentIndex === index ? {
      ...message,
      content: mode === "append" ? message.content + assistant.content : assistant.content
    } : message
  );
}
async function* readChatEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const event2 = parseEvent(buffer.slice(0, newline));
        if (event2) yield event2;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    const event = parseEvent(buffer + decoder.decode());
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}
function parseEvent(line) {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// src/components/ChatView.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var messageSequence = 0;
function createMessage(role, content) {
  messageSequence += 1;
  return { id: `message-${messageSequence}`, role, content };
}
function ChatView({
  initialMessage,
  zoneOverride,
  port = 3927,
  conduitMode = false,
  sessionId,
  cwd
}) {
  const { exit } = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [zone] = useState(zoneOverride || "sandbox");
  const [error, setError] = useState(null);
  const stableSessionId = useMemo(
    () => sessionId ?? `cli-shell-${randomUUID2().slice(0, 8)}`,
    [sessionId]
  );
  const workDir = cwd ?? process.cwd();
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });
  const handleSubmit = useCallback(
    async (value) => {
      if (!value.trim()) return;
      const trimmed = value.trim();
      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === ":q") {
        exit();
        return;
      }
      if (trimmed === "/help") {
        setMessages((prev) => [
          ...prev,
          createMessage("user", trimmed),
          createMessage(
            "system",
            [
              "Zaraa shell \u2014 Claude-Code-style terminal through Zaraa.",
              "Everything routes her auths, models, tools, memory, and policy.",
              "",
              "  plain text     talk / ask her to code or plan",
              "  /help          this help",
              "  /quit          exit",
              "",
              'Coding jobs with worktrees: zaraacoder "task" (separate).',
              "Truth packet: zaraacoder northstar"
            ].join("\n")
          )
        ]);
        setInput("");
        return;
      }
      setMessages((prev) => [...prev, createMessage("user", trimmed)]);
      setInput("");
      setIsProcessing(true);
      setError(null);
      const assistantMessage = createMessage("assistant", "");
      try {
        const response = await fetchGatewayResponse(port, "/api/chat", {
          method: "POST",
          body: buildCliChatRequestBody(trimmed, {
            sessionId: stableSessionId,
            surface: conduitMode ? "cli-shell" : "cli",
            interactionMode: "text",
            zone,
            cwd: workDir
          }),
          timeoutMs: 0
        });
        if (!response.ok) {
          const snapshot = await collectGatewayAccessSnapshot(port);
          setError(
            buildGatewayEndpointFailureMessage(
              "Chat is unavailable.",
              "/api/chat",
              port,
              snapshot,
              [{ ok: false, status: response.status, data: null, error: `HTTP ${response.status}` }]
            )
          );
          return;
        }
        if (!response.body) throw new Error("Chat stream response body is unavailable");
        for await (const event of readChatEvents(response.body)) {
          if (event.type === "response" && typeof event.content === "string") {
            const content = event.content;
            setMessages(
              (prev) => reconcileAssistantMessage(prev, { ...assistantMessage, content }, "replace")
            );
          } else if (event.type === "error") {
            setError(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
          } else if (event.type === "plan" && typeof event.content === "string") {
            setMessages((prev) => [
              ...prev,
              createMessage("system", `Plan: ${event.content}`)
            ]);
          } else if (event.type === "tool-call") {
            const toolCall = event.toolCall;
            const name = toolCall?.name ?? "tool";
            setMessages((prev) => [
              ...prev,
              createMessage("system", `Using: ${name}`)
            ]);
          } else if (event.type === "text-delta" && typeof event.content === "string") {
            const delta = event.content;
            setMessages(
              (prev) => reconcileAssistantMessage(prev, { ...assistantMessage, content: delta }, "append")
            );
          }
        }
      } catch (err) {
        const snapshot = await collectGatewayAccessSnapshot(port);
        setError(
          buildGatewayEndpointFailureMessage(
            "Chat is unavailable.",
            "/api/chat",
            port,
            snapshot,
            [{ ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) }]
          )
        );
      } finally {
        setIsProcessing(false);
      }
    },
    [port, stableSessionId, conduitMode, zone, workDir, exit]
  );
  useEffect(() => {
    if (initialMessage) {
      void handleSubmit(initialMessage);
    }
  }, [initialMessage, handleSubmit]);
  const welcomed = useRef(false);
  useEffect(() => {
    if (!conduitMode || initialMessage || welcomed.current) return;
    welcomed.current = true;
    setMessages([
      createMessage(
        "system",
        [
          "Northstar conduit \u2014 you talk to Zaraa; she holds auths, models, tools, and judgment.",
          `cwd ${workDir}`,
          `session ${stableSessionId}`,
          "Type freely. /help \xB7 /quit"
        ].join("\n")
      )
    ]);
  }, [conduitMode, initialMessage, workDir, stableSessionId]);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsx(
      StatusBar,
      {
        zone,
        isProcessing,
        conduitMode,
        cwd: workDir
      }
    ),
    /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginY: 1, children: messages.map((msg) => /* @__PURE__ */ jsx(MessageRow, { message: msg }, msg.id)) }),
    error && /* @__PURE__ */ jsx(Box, { marginBottom: 1, children: /* @__PURE__ */ jsxs(Text, { color: "red", children: [
      "Error: ",
      error
    ] }) }),
    !initialMessage && /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsxs(Text, { color: "cyan", bold: true, children: [
        ">",
        " "
      ] }),
      /* @__PURE__ */ jsx(
        TextInput,
        {
          value: input,
          onChange: setInput,
          onSubmit: handleSubmit,
          placeholder: "Talk to Zaraa\u2026 (/help \xB7 Ctrl+C quit)"
        }
      )
    ] })
  ] });
}
function MessageRow({ message }) {
  const colorMap = {
    user: "cyan",
    assistant: "green",
    system: "yellow"
  };
  const labelMap = {
    user: "You",
    assistant: "Zaraa",
    system: "\xB7"
  };
  return /* @__PURE__ */ jsxs(Box, { marginBottom: 1, flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Text, { color: colorMap[message.role], bold: true, children: labelMap[message.role] }),
    /* @__PURE__ */ jsxs(Text, { children: [
      " ",
      message.content
    ] })
  ] });
}
function StatusBar({
  zone,
  isProcessing,
  conduitMode,
  cwd
}) {
  const zoneColors = {
    sandbox: "yellow",
    guarded: "blue",
    trusted: "green"
  };
  const shortCwd = cwd.replace(process.env.HOME ?? "", "~");
  return /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, flexDirection: "column", children: [
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsx(Text, { bold: true, color: "magenta", children: conduitMode ? "Zaraa shell" : "Zaraa" }),
      /* @__PURE__ */ jsx(Text, { children: " \xB7 " }),
      /* @__PURE__ */ jsx(Text, { dimColor: true, children: conduitMode ? "northstar conduit" : "interactive" }),
      /* @__PURE__ */ jsx(Text, { children: " \xB7 " }),
      /* @__PURE__ */ jsx(Text, { color: zoneColors[zone] || "white", children: zone }),
      /* @__PURE__ */ jsx(Text, { children: " \xB7 " }),
      /* @__PURE__ */ jsx(Text, { children: isProcessing ? "thinking\u2026" : "ready" })
    ] }),
    conduitMode ? /* @__PURE__ */ jsxs(Text, { dimColor: true, children: [
      shortCwd,
      " \xB7 auths/models/tools via daemon \xB7 not Zero/Claude side-app"
    ] }) : null
  ] });
}

// src/index.ts
loadDotenv({ quiet: true });
loadDotenv({ path: join3(resolveRuntimeHomeDir(), ".zaraa", ".env"), quiet: true });
var rawArgs = process.argv.slice(2);
var { values, positionals } = parseArgs({
  args: rawArgs,
  options: {
    zone: { type: "string", short: "z" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    port: { type: "string", short: "p" },
    "data-dir": { type: "string" },
    // backtest flags
    strategy: { type: "string" },
    pair: { type: "string" },
    period: { type: "string" },
    // for backtest and leaderboard subcommands
    equity: { type: "string" },
    list: { type: "boolean" },
    limit: { type: "string" },
    discipline: { type: "string" },
    match: { type: "string" },
    task: { type: "string" },
    voice: { type: "string" },
    full: { type: "boolean" },
    "delay-ms": { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    // goal drops: repeatable "<description> :: <check command>"
    check: { type: "string", multiple: true }
  },
  allowPositionals: true,
  strict: false
});
function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return parsed > 0 ? parsed : 3927;
}
function readReleaseVersion() {
  for (const relativePath of ["../../../package.json", "../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync3(new URL(relativePath, import.meta.url), "utf8"));
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version;
      }
    } catch {
    }
  }
  return "unknown";
}
if (values.help) {
  console.log(`
Zaraa - Personal AI Assistant

Usage:
  zaraa                      Interactive mode (prefers live daemon)
  zaraa shell                Claude-Code-style terminal through Zaraa (daemon conduit)
  zaraa tui                  Alias for shell
  zaraa ide                  Open Zaraa IDE in the browser (#ide)
  zaraa "message"            One-shot message
  node packages/cli/dist/zaraa.js setup   Setup wizard
  node packages/cli/dist/zaraa.js doctor  System diagnostics
  zaraa reminders-tcc        Calendar/Reminders Automation TCC probe + Human grant card
  zaraa computer [status|frontmost|capture]
                             Read-only computer observe (not click/type)
  zaraa health               Liveness + breaker snapshot (status/uptime/memory/breakers)
  zaraa shadow-status        Paper-trading P&L, win rate, open positions
  zaraa pulse                Operator health + workflow snapshot
  zaraa pet [watch|desktop|hatch|show]
                             Baby Bleepy Bot companion (ASCII / desktop / hatch)
  zaraa remote [status]      Remote access + heartbeat diagnostics
  zaraa remote cleanup       Preview duplicate-process cleanup
  zaraa pause                Pause runtime + task generation for focus time
  zaraa resume [mode]        Resume workflow in slow, medium, or fast mode
  zaraa zone [zone]          Show or set the active trust zone
  zaraa runtime [mode]       Show or set the runtime mode
  zaraa models list [--scope global|zaraacoder]
  zaraa models provider enable|disable <name> [--scope global|zaraacoder]
  zaraa models enable|disable <modelKey> [--scope global|zaraacoder]
  zaraa audit                View audit trail
  zaraa trust                Trust ledger tier map (autonomy kernel)
  zaraa goal "<intent>" --check "<proof> :: <command>"
                             Drop a goal into the compiler inbox (--check repeatable)
  zaraa leaderboard          Strategy performance leaderboard
  zaraa perf                 Performance profiling report
  zaraa coder                Open Zaraacoder terminal cockpit
  zaraa coder <task>         Run task in current repo
  zaraa coder run --repo <path> [--mode plan|build] [--plan-only] <task>
  zaraa coder attach [session-id|latest]
  zaraa coder models status|pin <modelKey>|auto
  zaraa coder list|status|trace|diff|handoff [session-id|latest]
                             Inspect Zaraacoder repo context for a task
  zaraa coder gc [--dry-run|--apply]
                             Preview or remove eligible stale worktrees
  zaraa coder bench [--json] [--root <path>]
                             Run the deterministic ZaraBench seed suite
  zaraa coder bench compare [--json] <baseline-result.json> <candidate-result.json>
                             Compare saved ZaraBench result artifacts
  zaraa coder bench baseline promote [--json] [--baseline <path>] <result.json>
                             Save a known-good ZaraBench baseline artifact
  zaraa coder bench baseline compare [--json] [--baseline <path>] <candidate-result.json>
                             Compare a result artifact against the saved baseline
  zaraa coder bench check [--json] [--root <path>] [--baseline <path>]
                             Run ZaraBench and compare it against the saved baseline
  zaraa config file          Print active config file path
  zaraa memory search <q>    Search memories
  zaraa memory forget <q>    Forget memories
  zaraa memory mcp           Run stdio MCP bridge for memory search/store
  zaraa self-improve disciplines
                             List self-improvement discipline slugs
  zaraa self-improve preview starter
                             Preview starter patches in operator voice
  zaraa self-improve send starter
                             Dispatch starter patches
  zaraa overnight list       List tonight's overnight operator tasks
  zaraa overnight preview    Preview the overnight operator pack
  zaraa overnight send       Dispatch the overnight operator pack
  zaraa overnight handoff    Print the morning operator handoff
  zaraa db status            Show migration status for all databases
  zaraa db new <name>        Print a new migration file template
  zaraa backtest             Run a strategy backtest
    --strategy <name>          Strategy: trend-following, mean-reversion, breakout
    --pair <BTC/USDT>          Trading pair (default: BTC)
    --period <30d>             Lookback period: 7d, 30d, 90d, 1y (default: all data)
    --equity <10000>           Starting equity in USD (default: 10000)
    --list                     Show saved backtest results instead of running
  zaraa optimize             Optimize strategy parameters via grid search
    --strategy <name>          Strategy to optimize (required)
    --period <90d>             Historical period for optimization (default: 90d)
    --pair <BTC/USDT>          Trading pair (default: BTC)

Options:
  -z, --zone <zone>          Override zone (sandbox/guarded/trusted)
  -p, --port <port>          Gateway port (default: 3927)
      --data-dir <path>      Data directory (default: ~/.zaraa/data)
      --period <period>      Leaderboard period: 7d|30d|90d|all (default: 30d)
      --discipline <slug>    Filter self-improvement tasks by discipline
      --match <text>         Filter self-improvement tasks by text
      --task <id>            Select one self-improvement task by id
      --limit <n>            Limit self-improvement task count after filtering
      --voice <name>         Self-improvement prompt voice: operator|structured
      --full                 Full preview for self-improvement tasks
      --delay-ms <ms>        Delay between dispatched self-improvement tasks
      --dry-run              Preview changes without applying them
      --apply                Apply cleanup or workflow actions immediately
      --repo <path>          Zaraacoder repository path
      --plan-only            Inspect Zaraacoder context without editing
      --root <path>          ZaraBench artifact root
  -h, --help                 Show help
  -v, --version              Show version
`);
  process.exit(0);
}
if (values.version) {
  console.log(`zaraa v${readReleaseVersion()}`);
  process.exit(0);
}
var subcommand = positionals[0];
if (subcommand === "setup") {
  const { SetupWizard } = await import("./setup-wizard-CNNTBAES.js");
  render(React.createElement(SetupWizard));
} else if (subcommand === "doctor") {
  const { Doctor } = await import("./doctor-BGJ3J4LD.js");
  render(
    React.createElement(Doctor, {
      port: parsePort(values.port)
    })
  );
} else if (subcommand === "reminders-tcc") {
  const { runRemindersTcc } = await import("./reminders-tcc-L3QYV5QK.js");
  process.exit(runRemindersTcc(process.argv.slice(3)));
} else if (subcommand === "computer") {
  const { runComputer } = await import("./computer-5OAS5RR3.js");
  process.exit(runComputer(process.argv.slice(3)));
} else if (subcommand === "trust") {
  const { runTrust } = await import("./trust-53TD7V6A.js");
  await runTrust(process.argv.slice(3));
} else if (subcommand === "goal") {
  const { runGoalCommand } = await import("./goal-P37P3KO3.js");
  process.exit(
    runGoalCommand(positionals.slice(1), {
      dataDir: values["data-dir"],
      checks: values.check
    })
  );
} else if (subcommand === "health") {
  const { Health } = await import("./health-GWO7BZOB.js");
  const { waitUntilExit } = render(
    React.createElement(Health, {
      port: parsePort(values.port)
    })
  );
  await waitUntilExit();
  process.exit(0);
} else if (subcommand === "shadow-status") {
  const { ShadowStatusView } = await import("./shadow-status-RGA4LGT3.js");
  const { waitUntilExit } = render(
    React.createElement(ShadowStatusView, {
      port: parsePort(values.port)
    })
  );
  await waitUntilExit();
  process.exit(0);
} else if (subcommand === "pulse") {
  const port = parsePort(values.port);
  const limit = Math.max(1, Math.min(parseInt(values.limit || "5", 10) || 5, 20));
  const exitCode = await runPulse(port, limit);
  process.exit(exitCode);
} else if (subcommand === "pet") {
  const port = parsePort(values.port);
  const { runPetCommand } = await import("./pet-FTIRQBWH.js");
  const exitCode = await runPetCommand(port, positionals.slice(1));
  process.exit(exitCode);
} else if (subcommand === "remote") {
  const port = parsePort(values.port);
  if (positionals[1] === "cleanup") {
    if (positionals[2]) {
      console.log("Usage: zaraa remote cleanup [--dry-run|--apply]");
      process.exit(1);
    }
    const exitCode2 = await runRemoteCleanup(port, {
      apply: values.apply,
      dryRun: values["dry-run"]
    });
    process.exit(exitCode2);
  }
  const exitCode = await runRemoteStatus(port, positionals[1]);
  process.exit(exitCode);
} else if (subcommand === "pause") {
  if (positionals[1]) {
    console.log("Usage: zaraa pause [--zone sandbox|guarded|trusted] [--dry-run]");
    process.exit(1);
  }
  const port = parsePort(values.port);
  const exitCode = await runPauseCommand(port, {
    zoneOverride: values.zone,
    dryRun: values["dry-run"]
  });
  process.exit(exitCode);
} else if (subcommand === "resume") {
  if (positionals[2]) {
    console.log(
      "Usage: zaraa resume [slow|medium|fast] [--zone sandbox|guarded|trusted] [--dry-run]"
    );
    process.exit(1);
  }
  const port = parsePort(values.port);
  const exitCode = await runResumeCommand(port, positionals[1], {
    zoneOverride: values.zone,
    dryRun: values["dry-run"]
  });
  process.exit(exitCode);
} else if (subcommand === "zone") {
  const port = parsePort(values.port);
  const exitCode = await runZoneCommand(port, positionals[1]);
  process.exit(exitCode);
} else if (subcommand === "runtime") {
  const port = parsePort(values.port);
  const exitCode = await runRuntimeCommand(port, positionals[1]);
  process.exit(exitCode);
} else if (subcommand === "models") {
  const port = parsePort(values.port);
  const exitCode = await runModelsCommand(port, positionals.slice(1));
  process.exit(exitCode);
} else if (subcommand === "audit") {
  const { Audit } = await import("./audit-4OLSG5JF.js");
  render(
    React.createElement(Audit, {
      port: parsePort(values.port)
    })
  );
} else if (subcommand === "config") {
  const configAction = positionals[1];
  if (configAction === "file") {
    const configDir = resolveCliConfigDir();
    const candidates = [join3(configDir, "zaraa.config.json"), join3(configDir, "config.json")];
    const found = candidates.find((p) => existsSync5(p));
    console.log(found ?? candidates[0]);
    process.exit(0);
  } else {
    console.log("Usage: zaraa config file");
    process.exit(1);
  }
} else if (subcommand === "leaderboard") {
  const { Leaderboard } = await import("./leaderboard-IACZWPCU.js");
  const port = parsePort(values.port);
  const period = values.period || "30d";
  const { waitUntilExit } = render(React.createElement(Leaderboard, { period, port }));
  await waitUntilExit();
  process.exit(0);
} else if (subcommand === "perf") {
  const { Perf } = await import("./perf-BBBNNODA.js");
  render(
    React.createElement(Perf, {
      port: parsePort(values.port)
    })
  );
} else if (subcommand === "memory") {
  const memoryAction = positionals[1];
  if (memoryAction === "mcp") {
    const { runMemoryMcpServer } = await import("./memory-mcp-7HILS5HQ.js");
    await runMemoryMcpServer();
    process.exit(0);
  }
  const memoryQuery = positionals.slice(2).join(" ");
  const { Memory } = await import("./memory-VOOT2ZH6.js");
  render(
    React.createElement(Memory, {
      action: memoryAction,
      query: memoryQuery,
      port: parsePort(values.port)
    })
  );
} else if (subcommand === "self-improve") {
  const action = positionals[1];
  const commandPositionals = positionals.slice(2);
  const exitCode = runSelfImprove(action, commandPositionals, {
    discipline: values.discipline,
    match: values.match,
    task: values.task,
    voice: values.voice,
    full: values.full,
    delayMs: values["delay-ms"],
    limit: values.limit
  });
  process.exit(exitCode);
} else if (subcommand === "overnight") {
  const action = positionals[1];
  const commandPositionals = positionals.slice(2);
  const exitCode = runOvernight(action, commandPositionals, {
    match: values.match,
    task: values.task,
    voice: values.voice,
    full: values.full,
    delayMs: values["delay-ms"],
    limit: values.limit
  });
  process.exit(exitCode);
} else if (subcommand === "db") {
  const dbAction = positionals[1];
  const { dbStatus, dbNew } = await import("./db-LVQ75KQC.js");
  if (dbAction === "status") {
    const dataDir = values["data-dir"];
    await dbStatus(dataDir);
  } else if (dbAction === "new") {
    const migrationName = positionals.slice(2).join("_");
    dbNew(migrationName);
  } else {
    console.log(`Usage:
  zaraa db status             Show migration status for all databases
  zaraa db new <name>         Print a new migration file template`);
    process.exit(1);
  }
} else if (subcommand === "backtest") {
  if (values.port) process.env.ZARAA_PORT = values.port;
  const { Backtest } = await import("./backtest-7PAKEAQL.js");
  const { waitUntilExit } = render(
    React.createElement(Backtest, {
      strategy: values.strategy,
      pair: values.pair,
      period: values.period,
      equity: values.equity ? parseFloat(values.equity) : void 0,
      list: values.list,
      // When --list is set, --strategy filters the list instead of naming a strategy to run
      listStrategy: values.list ? values.strategy : void 0
    })
  );
  await waitUntilExit();
} else if (subcommand === "optimize") {
  const port = parsePort(values.port);
  const exitCode = await runOptimize(
    port,
    values.strategy,
    values.period || "90d",
    values.pair || void 0
  );
  process.exit(exitCode);
} else if (subcommand === "coder" || subcommand === "zaraacoder") {
  const { runZaraacoderCommand } = await import("./zaraacoder-KDPKDKTS.js");
  const subcommandIndex = rawArgs.indexOf(subcommand);
  const commandArgs = subcommandIndex === -1 ? positionals.slice(1) : rawArgs.slice(subcommandIndex + 1);
  const exitCode = await runZaraacoderCommand(commandArgs);
  process.exit(exitCode);
} else if (subcommand === "ide") {
  const port = parsePort(values.port);
  const url = `http://127.0.0.1:${port}/#ide`;
  const { loadGatewayApiKey: loadGatewayApiKey2, requestGatewayJson: requestGatewayJson2 } = await import("./gateway-client-XTJHNZIL.js");
  if (!loadGatewayApiKey2()) {
    console.error(
      "No gateway API key. Set gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY."
    );
    process.exit(1);
  }
  const health = await requestGatewayJson2(port, "/api/health", {
    timeoutMs: 5e3
  });
  if (!health.ok) {
    console.error(`Zaraa daemon not reachable on port ${port}. Start it, then retry zaraa ide.`);
    process.exit(1);
  }
  console.log("Zaraa IDE (Phase 0)");
  console.log(`  ${url}`);
  console.log("  Conduit chat + Zaraacode bridge. Terminal twin: zaraa shell");
  try {
    const { execFile: execFile3 } = await import("child_process");
    const { promisify: promisify3 } = await import("util");
    await promisify3(execFile3)("open", [url]);
    console.log("  Opened in default browser.");
  } catch {
    console.log("  Open that URL in your browser (could not auto-open).");
  }
  process.exit(0);
} else if (subcommand === "shell" || subcommand === "tui" || subcommand === "repl") {
  const port = parsePort(values.port);
  const { loadGatewayApiKey: loadGatewayApiKey2, requestGatewayJson: requestGatewayJson2 } = await import("./gateway-client-XTJHNZIL.js");
  if (!loadGatewayApiKey2()) {
    console.error(
      "No gateway API key. Set gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY."
    );
    process.exit(1);
  }
  const health = await requestGatewayJson2(port, "/api/health", {
    timeoutMs: 5e3
  });
  if (!health.ok) {
    console.error(
      `Zaraa daemon not reachable on port ${port}. Start it first:
  node scripts/zaraa-daemon.mjs
or launchctl kickstart gui/$(id -u)/com.zaraa.daemon`
    );
    process.exit(1);
  }
  const zone = values.zone && ["sandbox", "guarded", "trusted"].includes(values.zone) ? values.zone : "guarded";
  const { waitUntilExit } = render(
    React.createElement(ChatView, {
      port,
      conduitMode: true,
      zoneOverride: zone,
      cwd: process.cwd()
    })
  );
  await waitUntilExit();
  process.exit(0);
} else {
  const configDir = resolveCliConfigDir();
  const hasConfig = existsSync5(join3(configDir, "zaraa.config.json")) || existsSync5(join3(configDir, "config.json"));
  if (!hasConfig) {
    console.log("No configuration found. Starting setup wizard...");
    const { SetupWizard } = await import("./setup-wizard-CNNTBAES.js");
    const { waitUntilExit } = render(React.createElement(SetupWizard));
    await waitUntilExit();
  }
  const port = parsePort(values.port);
  const message = subcommand || void 0;
  const { requestGatewayJson: requestGatewayJson2 } = await import("./gateway-client-XTJHNZIL.js");
  const health = await requestGatewayJson2(port, "/api/health", {
    timeoutMs: 3e3
  });
  if (health.ok) {
    const zone = values.zone && ["sandbox", "guarded", "trusted"].includes(values.zone) ? values.zone : "guarded";
    const { waitUntilExit } = render(
      React.createElement(ChatView, {
        initialMessage: message,
        zoneOverride: zone,
        port,
        conduitMode: true,
        cwd: process.cwd()
      })
    );
    await waitUntilExit();
    process.exit(0);
  }
  const { launch } = await import("@zaraa/core");
  console.log("No live daemon on this port \u2014 starting Zaraa in-process...");
  let result = null;
  try {
    result = await launch({ port });
    console.log(`Gateway running on http://localhost:${port}`);
    if (values.zone && ["sandbox", "guarded", "trusted"].includes(values.zone)) {
      result.zara.setZone(values.zone, { source: "cli" });
    }
    const { waitUntilExit } = render(
      React.createElement(ChatView, {
        initialMessage: message,
        zoneOverride: values.zone,
        port,
        conduitMode: true,
        cwd: process.cwd()
      })
    );
    await waitUntilExit();
    await result.stop();
  } catch (err) {
    if (result) {
      try {
        await result.stop();
      } catch {
      }
    }
    console.error("Failed to start Zaraa:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
