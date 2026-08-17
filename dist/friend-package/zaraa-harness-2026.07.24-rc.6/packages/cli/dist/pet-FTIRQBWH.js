import {
  compactHomePath
} from "./chunk-XSCLDVMG.js";
import "./chunk-F4ZXZMER.js";
import {
  loadGatewayApiKey,
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-WWFZXCWT.js";
import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/pet.ts
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var MOOD_COPY = {
  ready: { label: "Ready", bleep: "bleep?" },
  working: { label: "Working", bleep: "bleep bleep!" },
  waiting: { label: "Waiting", bleep: "need you!" },
  error: { label: "Uh-oh", bleep: "bleep\u2026" }
};
var PRESETS = [
  { bodyColor: "#53f3c7", antennaColor: "#d5ff67", species: "signal sweep hatchling" },
  { bodyColor: "#ff8f84", antennaColor: "#ffd9a3", species: "warm-error hatchling" },
  { bodyColor: "#b39cff", antennaColor: "#f0abfc", species: "night-grid hatchling" },
  { bodyColor: "#7dd3fc", antennaColor: "#fef08a", species: "open-channel hatchling" },
  { bodyColor: "#fbbf24", antennaColor: "#86efac", species: "golden-task hatchling" }
];
var NAME_A = ["Pip", "Beep", "Nori", "Zest", "Mochi", "Piko", "Luma", "Tiko", "Vee", "Sprout"];
var NAME_B = ["Bleep", "Blink", "Spark", "Chirp", "Ping", "Glow", "Byte", "Loop", "Nest", "Drift"];
var DEFAULT_HATCH = {
  name: "Baby Bleepy",
  bodyColor: "#53f3c7",
  antennaColor: "#d5ff67",
  species: "signal sweep hatchling",
  hatchedAt: "2026-07-09T00:00:00.000Z"
};
function hatchPath() {
  return join(resolveRuntimeHomeDir(), ".zaraa", "pet-hatch.json");
}
function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hatchFromSeed(seed, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  const h = hashSeed(seed.trim() || `bleep-${Date.now()}`);
  const preset = PRESETS[h % PRESETS.length];
  return {
    name: `${NAME_A[h % NAME_A.length]} ${NAME_B[(h >>> 8) % NAME_B.length]}`,
    bodyColor: preset.bodyColor,
    antennaColor: preset.antennaColor,
    species: preset.species,
    hatchedAt: nowIso
  };
}
function readHatchFile() {
  const path = hatchPath();
  if (!existsSync(path)) return { ...DEFAULT_HATCH };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 24) : DEFAULT_HATCH.name,
      bodyColor: typeof raw.bodyColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.bodyColor) ? raw.bodyColor : DEFAULT_HATCH.bodyColor,
      antennaColor: typeof raw.antennaColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.antennaColor) ? raw.antennaColor : DEFAULT_HATCH.antennaColor,
      species: typeof raw.species === "string" && raw.species.trim() ? raw.species.trim().slice(0, 48) : DEFAULT_HATCH.species,
      hatchedAt: typeof raw.hatchedAt === "string" ? raw.hatchedAt : DEFAULT_HATCH.hatchedAt
    };
  } catch {
    return { ...DEFAULT_HATCH };
  }
}
function writeHatchFile(hatch) {
  const dir = join(resolveRuntimeHomeDir(), ".zaraa");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = hatchPath();
  writeFileSync(path, `${JSON.stringify(hatch, null, 2)}
`, "utf8");
  return path;
}
function formatPetSaved(filePath, home) {
  return `  saved ${compactHomePath(filePath, home)}`;
}
function derivePetMoodFromGateway(input) {
  if (input.circuitTripped || input.status === "error" || input.status === "degraded") {
    return "error";
  }
  if ((input.approvalCount ?? 0) > 0) return "waiting";
  if ((input.runningTasks ?? 0) > 0 || (input.pendingTasks ?? 0) > 0) return "working";
  return "ready";
}
function renderAsciiPet(mood, name = "Baby Bleepy") {
  const copy = MOOD_COPY[mood];
  const face = mood === "error" ? "(x_x)" : mood === "waiting" ? "(o_o)" : mood === "working" ? "(\u2022\u0300_\u2022\u0301)" : "(\u2022\u203F\u2022)";
  const antenna = mood === "working" ? " *" : mood === "error" ? " !" : " \xB7";
  return [
    `    ${antenna}`,
    "   \u256D\u2500\u2500\u2500\u256E",
    `  ${face}  ${copy.bleep}`,
    "   \u2570\u2500\u2500\u2500\u256F",
    `  ${name} \xB7 ${copy.label}`
  ].join("\n");
}
async function fetchPetSignals(port) {
  const apiKey = loadGatewayApiKey();
  const health = await requestGatewayJson(port, "/api/health", {
    timeoutMs: 4e3,
    apiKey
  });
  if (!health.ok || !health.data) {
    return {
      mood: "error",
      detail: health.error ?? `gateway :${port} unreachable`,
      ok: false
    };
  }
  let approvalCount = 0;
  let circuitTripped = false;
  const approvals = await requestGatewayJson(port, "/api/approvals", {
    timeoutMs: 4e3,
    apiKey
  });
  if (approvals.ok && Array.isArray(approvals.data?.approvals)) {
    approvalCount = approvals.data.approvals.length;
  }
  const breaker = await requestGatewayJson(port, "/api/circuit-breaker", {
    timeoutMs: 4e3,
    apiKey
  });
  if (breaker.ok) circuitTripped = Boolean(breaker.data?.tripped);
  const running = Number(health.data.taskQueue?.running ?? 0);
  const pending = Number(health.data.taskQueue?.pending ?? 0);
  const mood = derivePetMoodFromGateway({
    status: health.data.status,
    runningTasks: running,
    pendingTasks: pending,
    approvalCount,
    circuitTripped
  });
  const detail = mood === "working" ? `${running} running \xB7 ${pending} pending` : mood === "waiting" ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}` : mood === "error" ? circuitTripped ? "circuit breaker tripped" : `status ${health.data.status ?? "error"}` : `uptime ${Math.round(Number(health.data.uptime ?? 0))}s \xB7 gateway ok`;
  return { mood, detail, ok: true };
}
function resolveDesktopUrl(dashboardPort) {
  return `http://127.0.0.1:${dashboardPort}/pet-desktop.html`;
}
async function openDesktopPet(dashboardPort = 3929) {
  const url = resolveDesktopUrl(dashboardPort);
  const platform = process.platform;
  if (platform === "darwin") {
    const chromeApps = [
      "/Applications/Google Chrome.app",
      "/Applications/Chromium.app",
      "/Applications/Microsoft Edge.app",
      "/Applications/Brave Browser.app"
    ];
    for (const app of chromeApps) {
      if (!existsSync(app)) continue;
      try {
        await execFileAsync("open", [
          "-na",
          app,
          "--args",
          `--app=${url}`,
          "--window-size=240,320",
          "--window-position=40,80"
        ]);
        return { url, method: `app-mode (${app.split("/").pop()})` };
      } catch {
      }
    }
    await execFileAsync("open", [url]);
    return { url, method: "open (default browser)" };
  }
  if (platform === "linux") {
    try {
      await execFileAsync("xdg-open", [url]);
      return { url, method: "xdg-open" };
    } catch {
    }
  }
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return { url, method: "start" };
  }
  return { url, method: "print-url" };
}
async function runPetCommand(port, args, opts = {}) {
  const sub = (args[0] ?? "once").toLowerCase();
  const hatch = readHatchFile();
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`Baby Bleepy Bot

Usage:
  zaraa pet                 One-shot ASCII status
  zaraa pet watch           Live terminal buddy (Ctrl+C to quit)
  zaraa pet desktop         Open floating desktop window
  zaraa pet hatch [seed]    Hatch a new pet into ~/.zaraa/pet-hatch.json
  zaraa pet show            Print current hatch + ASCII

Options:
  -p, --port <port>         Gateway port (default 3927)
`);
    return 0;
  }
  if (sub === "hatch") {
    const seed = args.slice(1).join(" ").trim() || `bleep-${Date.now()}`;
    const next = hatchFromSeed(seed);
    const path = writeHatchFile(next);
    console.log(`Hatched ${next.name} (${next.species})`);
    console.log(`  body ${next.bodyColor}  antenna ${next.antennaColor}`);
    console.log(formatPetSaved(path));
    console.log(`  tip: open the dashboard pet and click Hatch \u2192 Load CLI hatch, or re-hatch there.`);
    console.log("");
    console.log(renderAsciiPet("ready", next.name));
    return 0;
  }
  if (sub === "show") {
    console.log(`${hatch.name} \xB7 ${hatch.species}`);
    console.log(`body ${hatch.bodyColor}  antenna ${hatch.antennaColor}`);
    console.log(`hatched ${hatch.hatchedAt}`);
    console.log("");
    const snap2 = await fetchPetSignals(port);
    console.log(renderAsciiPet(snap2.mood, hatch.name));
    console.log(`  ${snap2.detail}`);
    return snap2.ok ? 0 : 1;
  }
  if (sub === "desktop") {
    const dashboardPort = opts.dashboardPort ?? 3929;
    const result = await openDesktopPet(dashboardPort);
    console.log(`Opening Baby Bleepy desktop pet\u2026`);
    console.log(`  ${result.url}`);
    console.log(`  via ${result.method}`);
    if (result.method === "print-url") {
      console.log("  (could not auto-open; paste the URL in a browser)");
      return 1;
    }
    return 0;
  }
  if (sub === "watch") {
    const interval = opts.watchIntervalMs ?? 2e3;
    console.log(`Watching Baby Bleepy on :${port} (Ctrl+C to quit)
`);
    const tick = async () => {
      const snap2 = await fetchPetSignals(port);
      process.stdout.write("\x1B[2J\x1B[H");
      console.log(renderAsciiPet(snap2.mood, hatch.name));
      console.log(`  ${snap2.detail}`);
      console.log(`  ${hatch.species}`);
      console.log(`  ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`);
    };
    await tick();
    const id = setInterval(() => {
      void tick();
    }, interval);
    await new Promise((resolve) => {
      const stop = () => {
        clearInterval(id);
        console.log("\nbye bleep");
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  const snap = await fetchPetSignals(port);
  console.log(renderAsciiPet(snap.mood, hatch.name));
  console.log(`  ${snap.detail}`);
  return snap.ok ? 0 : 1;
}
export {
  derivePetMoodFromGateway,
  formatPetSaved,
  hashSeed,
  hatchFromSeed,
  hatchPath,
  openDesktopPet,
  readHatchFile,
  renderAsciiPet,
  runPetCommand,
  writeHatchFile
};
