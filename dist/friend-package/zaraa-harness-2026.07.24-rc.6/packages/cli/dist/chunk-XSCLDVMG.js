import {
  buildGatewayAccessFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import {
  classifyRemindersTccDoctorCheck,
  remindersTccDoctorProbeArgs,
  resolveRemindersTccProbePath
} from "./chunk-WWFZXCWT.js";
import {
  resolveCliConfigDir,
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/doctor.tsx
import { execFile } from "child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import net from "net";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var execFileAsync = promisify(execFile);
var SETUP_CMD = "pnpm setup";
function buildDoctorCompletionMessage(checks) {
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const hasIsolatedOperatorViewWarning = checks.some(
    (check) => check.status === "warn" && (check.name === "Gateway API" && check.detail.includes("not trustworthy") || check.detail.includes("isolated network view"))
  );
  if (failCount > 0) {
    return `${failCount} critical check(s) failed. See above for details.`;
  }
  if (hasIsolatedOperatorViewWarning) {
    return `Core system checks passed, but local operator reachability could not be verified from this environment (${warnCount} warning(s)).`;
  }
  if (warnCount > 0) {
    return `All critical checks passed with ${warnCount} warning(s).`;
  }
  return "All checks passed! Zaraa is ready to go.";
}
function classifyDiskSpace(availableGiB, usedPct) {
  if (availableGiB < 2) return { status: "fail", critical: true };
  if (availableGiB < 10 || usedPct > 90) return { status: "warn", critical: false };
  return { status: "pass", critical: false };
}
function classifyAuthenticatedProviderStatus(status) {
  if (status >= 200 && status < 300) return { status: "pass", critical: false };
  if (status === 401 || status === 403) return { status: "fail", critical: true };
  return { status: "warn", critical: false };
}
function compactHomePath(filePath, home = os.homedir()) {
  if (filePath === home) return "~";
  return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}
function buildConfigPermissionFailureDetail(configPath, mode, home = os.homedir()) {
  const shown = compactHomePath(configPath, home);
  return `${shown} mode ${mode.toString(8)} is group/world-accessible. Run: chmod 600 ${shown}`;
}
function formatTradingDbCheckDetail(foundDb, sizeKb, home = os.homedir()) {
  const shown = compactHomePath(foundDb, home);
  return sizeKb == null ? `${shown} \u2014 cannot read (permissions?)` : `${shown} (${sizeKb} KB)`;
}
async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}
async function httpProbe(url, headers = {}) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3e3)
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function Doctor({ port = 3927 }) {
  const { exit } = useApp();
  const [checks, setChecks] = useState([]);
  const [done, setDone] = useState(false);
  const updateCheck = useCallback(
    (name, status, detail, critical = false) => {
      setChecks((prev) => {
        const existing = prev.findIndex((c) => c.name === name);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { name, status, detail, critical };
          return updated;
        }
        return [...prev, { name, status, detail, critical }];
      });
    },
    []
  );
  useEffect(() => {
    const runDiagnostics = async () => {
      const configDir = resolveCliConfigDir();
      const nodeVersion = process.version;
      const major = parseInt(nodeVersion.slice(1), 10);
      updateCheck(
        "Node.js",
        major >= 22 ? "pass" : "fail",
        `${nodeVersion} (need >= 22)`,
        true
        // critical
      );
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
      const freeGB = (freeMem / 1024 / 1024 / 1024).toFixed(1);
      updateCheck(
        "Memory",
        Number(totalGB) >= 8 && Number(freeGB) >= 1 ? "pass" : "warn",
        `${freeGB}GB free / ${totalGB}GB total`
      );
      updateCheck("Platform", "pass", `${os.platform()} ${os.arch()}`);
      try {
        const stats = statfsSync(resolveRuntimeHomeDir());
        const totalBytes = Number(stats.blocks) * Number(stats.bsize);
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        const availableGiB = availableBytes / 1024 ** 3;
        const usedPct = totalBytes > 0 ? Math.round((1 - availableBytes / totalBytes) * 100) : 0;
        const classification = classifyDiskSpace(availableGiB, usedPct);
        updateCheck(
          "Disk",
          classification.status,
          `${availableGiB.toFixed(1)} GiB available (${usedPct}% used)`,
          classification.critical
        );
      } catch {
        updateCheck("Disk", "warn", "Could not check");
      }
      let gitAvailable = false;
      try {
        const { stdout } = await execFileAsync("git", ["--version"]);
        gitAvailable = true;
        updateCheck("Git", "pass", stdout.trim());
      } catch {
        updateCheck("Git", "warn", "Not found (optional)");
      }
      if (gitAvailable) {
        let insideRepo = false;
        try {
          await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
            timeout: 5e3
          });
          insideRepo = true;
        } catch {
        }
        if (insideRepo) {
          try {
            const { stdout } = await execFileAsync(
              "git",
              ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages", "scripts"],
              { timeout: 15e3, maxBuffer: 10 * 1024 * 1024 }
            );
            const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
            const untracked = lines.filter((l) => l.startsWith("??")).length;
            const modified = lines.length - untracked;
            if (lines.length === 0) {
              updateCheck("Repo state", "pass", "clean (packages/, scripts/)");
            } else {
              const parts = [];
              if (untracked > 0) {
                parts.push(`${untracked} untracked source file(s) \u2014 clean checkout may not build`);
              }
              if (modified > 0) {
                parts.push(`${modified} uncommitted change(s)`);
              }
              updateCheck("Repo state", "warn", parts.join("; "));
            }
          } catch {
            updateCheck(
              "Repo state",
              "warn",
              "Could not verify repo state (git timed out or errored) \u2014 not assuming clean"
            );
          }
        }
      }
      const configCandidates = ["zaraa.config.json", "config.json"];
      const foundConfig = configCandidates.find((f) => {
        try {
          lstatSync(`${configDir}/${f}`);
          return true;
        } catch {
          return false;
        }
      });
      let parsedConfig = null;
      let configPath = null;
      let configPathUnsafe = false;
      if (foundConfig) {
        configPath = `${configDir}/${foundConfig}`;
        let pathUnsafe = null;
        try {
          const parent = `${configDir}`;
          const parentLst = lstatSync(parent);
          if (parentLst.isSymbolicLink()) {
            pathUnsafe = `${compactHomePath(parent)} is a symlink parent directory \u2014 replace with a real directory under the intended home path (friend pin refuses symlink parents).`;
          } else if (!parentLst.isDirectory()) {
            pathUnsafe = `${compactHomePath(parent)} is not a directory \u2014 cannot host a friend config.`;
          }
        } catch {
        }
        try {
          const lst = lstatSync(configPath);
          if (!pathUnsafe && lst.isSymbolicLink()) {
            pathUnsafe = `${compactHomePath(configPath)} is a symlink \u2014 replace with a regular file under the intended home config path (friend pin refuses symlink configs).`;
          } else if (!pathUnsafe && !lst.isFile()) {
            pathUnsafe = `${compactHomePath(configPath)} is not a regular file \u2014 expected plain JSON config (not a directory or special file).`;
          } else if (!pathUnsafe && typeof lst.nlink === "number" && lst.nlink > 1) {
            pathUnsafe = `${compactHomePath(configPath)} has hardlink count ${lst.nlink} \u2014 credential strip cannot rewrite other hardlink names; use a unique nlink=1 file.`;
          }
        } catch {
          if (!pathUnsafe) {
            pathUnsafe = `${compactHomePath(configPath)} \u2014 cannot lstat config path.`;
          }
        }
        if (pathUnsafe) {
          configPathUnsafe = true;
          updateCheck("Config", "fail", pathUnsafe, true);
          updateCheck(
            "Trading safety",
            "fail",
            "Cannot verify money rails \u2014 config path is not a regular file.",
            true
          );
        } else {
          try {
            const raw = readFileSync(configPath, "utf-8");
            const text = raw.length > 0 && raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
            parsedConfig = JSON.parse(text);
            updateCheck(
              "Config",
              "pass",
              compactHomePath(configPath),
              /* critical */
              true
            );
          } catch {
            updateCheck(
              "Config",
              "fail",
              `${compactHomePath(configPath)} \u2014 invalid JSON. Run \`${SETUP_CMD}\` to fix.`,
              true
            );
          }
        }
      } else {
        updateCheck("Config", "fail", `No config found. Run \`${SETUP_CMD}\` first.`, true);
        updateCheck(
          "Trading safety",
          "fail",
          `Cannot verify money rails \u2014 no config found. Run \`${SETUP_CMD}\`.`,
          true
        );
      }
      if (foundConfig && configPath && !parsedConfig && !configPathUnsafe) {
        updateCheck(
          "Trading safety",
          "fail",
          "Cannot verify money rails \u2014 config present but not parseable as JSON. Run `pnpm setup`.",
          true
        );
      }
      if (parsedConfig && configPath) {
        const isConfigTrue = (value) => value === true || value === "true";
        const isConfigFalse = (value) => value === false || value === "false";
        const trading = parsedConfig.trading;
        const predictions = parsedConfig.predictions;
        const scheduler = parsedConfig.scheduler;
        const paperMode = trading?.paperMode;
        const predPaper = predictions?.paperMode;
        const tradingPaperSafe = isConfigTrue(paperMode);
        const predictionsPaperUnsafe = isConfigFalse(predPaper);
        const autoLive = isConfigTrue(trading?.autoExecuteLive);
        const bgAuto = isConfigTrue(trading?.backgroundAutomation);
        const predAuto = isConfigTrue(predictions?.autoExecuteLive);
        const overnightOn = isConfigTrue(scheduler?.overnight?.enabled);
        const credentialBits = [];
        const presentSecret = (obj, key, path2) => {
          if (obj != null && Object.hasOwn(obj, key) && obj[key] != null) {
            credentialBits.push(path2);
          }
        };
        presentSecret(trading, "apiKey", "trading.apiKey");
        presentSecret(trading, "apiSecret", "trading.apiSecret");
        presentSecret(trading, "solanaDexSecretKey", "trading.solanaDexSecretKey");
        presentSecret(trading, "liveModeLock", "trading.liveModeLock");
        const polymarket = predictions?.polymarket;
        presentSecret(polymarket, "apiKey", "predictions.polymarket.apiKey");
        presentSecret(polymarket, "apiSecret", "predictions.polymarket.apiSecret");
        presentSecret(polymarket, "apiPassphrase", "predictions.polymarket.apiPassphrase");
        presentSecret(polymarket, "privateKey", "predictions.polymarket.privateKey");
        try {
          const mode = statSync(configPath).mode & 511;
          if (process.platform !== "win32" && (mode & 63) !== 0) {
            updateCheck(
              "Config permissions",
              "fail",
              buildConfigPermissionFailureDetail(configPath, mode),
              true
            );
          } else if (process.platform !== "win32") {
            updateCheck("Config permissions", "pass", "config not group/world-readable");
          }
        } catch {
        }
        if (isConfigFalse(paperMode) || predictionsPaperUnsafe || autoLive || bgAuto || predAuto || overnightOn || credentialBits.length > 0) {
          const bits = [];
          if (isConfigFalse(paperMode)) bits.push(`trading.paperMode=${String(paperMode)}`);
          if (predictionsPaperUnsafe) bits.push(`predictions.paperMode=${String(predPaper)}`);
          if (autoLive) bits.push(`trading.autoExecuteLive=${String(trading?.autoExecuteLive)}`);
          if (bgAuto)
            bits.push(`trading.backgroundAutomation=${String(trading?.backgroundAutomation)}`);
          if (predAuto) {
            bits.push(`predictions.autoExecuteLive=${String(predictions?.autoExecuteLive)}`);
          }
          if (overnightOn) {
            bits.push(`scheduler.overnight.enabled=${String(scheduler?.overnight?.enabled)}`);
          }
          if (credentialBits.length > 0) {
            bits.push(`live credentials present (${credentialBits.join(", ")})`);
          }
          updateCheck(
            "Trading safety",
            "fail",
            `Live risk flags set (${bits.join(", ")}). Friend beta expects paper-only. From the installed folder: node scripts/friend-config-safety.mjs --config ~/.zaraa/zaraa.config.json`,
            true
          );
        } else if (tradingPaperSafe && !predictionsPaperUnsafe) {
          updateCheck(
            "Trading safety",
            "pass",
            "paperMode true; predictions/autoExecute/backgroundAutomation/overnight/credentials fail-closed"
          );
        } else {
          updateCheck(
            "Trading safety",
            "warn",
            `trading.paperMode missing/unknown \u2014 treat as unsafe until paper-only is explicit. Run \`${SETUP_CMD}\` or node scripts/friend-config-safety.mjs`
          );
        }
      }
      const dataDir = path.join(configDir, "data");
      try {
        statSync(dataDir);
        const tmpFile = path.join(dataDir, `.doctor-probe-${Date.now()}`);
        try {
          writeFileSync(tmpFile, "probe");
          unlinkSync(tmpFile);
          updateCheck("Data dir", "pass", `${compactHomePath(dataDir)} (writable)`);
        } catch {
          updateCheck(
            "Data dir",
            "fail",
            `${compactHomePath(dataDir)} exists but is NOT writable \u2014 check permissions`,
            true
          );
        }
      } catch {
        updateCheck("Data dir", "pass", "Will be created on first run");
      }
      if (parsedConfig?.providers && parsedConfig.providers.length > 0) {
        const providers = parsedConfig.providers.filter((provider) => provider.enabled !== false);
        if (providers.length === 0) {
          updateCheck(
            "Providers",
            "fail",
            `All providers are disabled. Run \`${SETUP_CMD}\` or enable one provider.`,
            true
          );
        }
        await Promise.all(
          providers.map(async (p) => {
            const label = `Provider: ${p.name}`;
            const envVarMap = {
              anthropic: "ANTHROPIC_API_KEY",
              openai: "OPENAI_API_KEY",
              openrouter: "OPENROUTER_API_KEY"
            };
            const envVar = p.envVar ?? envVarMap[p.type];
            const configAuth = p.auth === "config" || p.auth === "api-key" || p.auth === "api_key" || p.auth === "apiKey";
            const credential = p.auth === "env" ? envVar ? process.env[envVar] : void 0 : configAuth ? p.apiKey : p.auth === "keychain" || p.auth === "oauth" || p.auth === "none" ? void 0 : (envVar ? process.env[envVar] : void 0) ?? p.apiKey;
            const needsApiKey = p.type === "anthropic" || p.type === "openai" || p.type === "openrouter";
            if (needsApiKey && !credential) {
              if (p.auth === "keychain" || p.auth === "oauth") {
                updateCheck(
                  label,
                  "warn",
                  `${p.auth} credentials cannot be verified by doctor; run one functional prompt after startup.`
                );
                return;
              }
              updateCheck(
                label,
                "fail",
                `${p.type} credentials are missing${envVar ? ` ($${envVar})` : ""}. Rerun \`${SETUP_CMD}\`.`,
                true
              );
              return;
            }
            switch (p.type) {
              case "anthropic": {
                const result = await httpProbe("https://api.anthropic.com/v1/models", {
                  "x-api-key": credential ?? "",
                  "anthropic-version": "2023-06-01"
                });
                const classification = classifyAuthenticatedProviderStatus(result.status);
                updateCheck(
                  label,
                  classification.status,
                  classification.status === "pass" ? "Anthropic credentials accepted" : classification.status === "fail" ? `Anthropic rejected credentials (HTTP ${result.status}). Rerun \`${SETUP_CMD}\`.` : `Anthropic check unavailable: ${result.error ?? `HTTP ${result.status}`}`,
                  classification.critical
                );
                break;
              }
              case "openai": {
                const result = await httpProbe("https://api.openai.com/v1/models", {
                  Authorization: `Bearer ${credential ?? ""}`
                });
                const classification = classifyAuthenticatedProviderStatus(result.status);
                updateCheck(
                  label,
                  classification.status,
                  classification.status === "pass" ? "OpenAI credentials accepted" : classification.status === "fail" ? `OpenAI rejected credentials (HTTP ${result.status}). Rerun \`${SETUP_CMD}\`.` : `OpenAI check unavailable: ${result.error ?? `HTTP ${result.status}`}`,
                  classification.critical
                );
                break;
              }
              case "openrouter": {
                const result = await httpProbe("https://openrouter.ai/api/v1/key", {
                  Authorization: `Bearer ${credential ?? ""}`
                });
                const classification = classifyAuthenticatedProviderStatus(result.status);
                updateCheck(
                  label,
                  classification.status,
                  classification.status === "pass" ? "OpenRouter credentials accepted" : classification.status === "fail" ? `OpenRouter rejected credentials (HTTP ${result.status}). Rerun \`${SETUP_CMD}\`.` : `OpenRouter check unavailable: ${result.error ?? `HTTP ${result.status}`}`,
                  classification.critical
                );
                break;
              }
              case "ollama": {
                const base = p.baseUrl ?? "http://localhost:11434";
                const result = await httpProbe(`${base}/api/tags`);
                if (result.ok) {
                  try {
                    const res = await fetch(`${base}/api/tags`, {
                      signal: AbortSignal.timeout(3e3)
                    });
                    const data = await res.json();
                    const models = data.models ?? [];
                    const installed = new Set(models.map((model) => model.name));
                    const missing = (p.models ?? []).filter((model) => !installed.has(model));
                    updateCheck(
                      label,
                      missing.length > 0 || models.length === 0 ? "fail" : "pass",
                      missing.length > 0 ? `Configured model not installed: ${missing.join(", ")}. Run \`ollama pull ${missing[0]}\` or rerun \`${SETUP_CMD}\`.` : models.length === 0 ? "Ollama is running but has no models. Run `ollama pull llama3.2:3b`." : `Ollama running \u2014 ${(p.models ?? []).join(", ")} ready`,
                      missing.length > 0 || models.length === 0
                    );
                  } catch {
                    updateCheck(
                      label,
                      "fail",
                      "Ollama responded, but its installed models could not be verified.",
                      true
                    );
                  }
                } else {
                  updateCheck(
                    label,
                    "fail",
                    `Ollama not reachable at ${base}: ${result.error ?? `HTTP ${result.status}`}`,
                    true
                  );
                }
                break;
              }
              default: {
                updateCheck(label, "pass", `Configured (type: ${p.type})`);
              }
            }
          })
        );
      } else if (foundConfig) {
        updateCheck(
          "Providers",
          "fail",
          `No providers configured. Run \`${SETUP_CMD}\` to add one.`,
          true
        );
      } else {
        updateCheck("Providers", "fail", `No config \u2014 run \`${SETUP_CMD}\` first.`, true);
      }
      if (!parsedConfig?.providers?.length) {
        const apiKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
        const hasAny = apiKeys.some((k) => process.env[k]);
        if (!hasAny) {
          updateCheck(
            "API keys",
            "warn",
            "No ANTHROPIC_API_KEY or OPENAI_API_KEY found \u2014 at least one LLM provider is needed"
          );
        }
      }
      const possibleDbPaths = [
        path.join(configDir, "data", "trading.db"),
        path.join(configDir, "data", "zaraa-trading.db")
      ];
      const foundDb = possibleDbPaths.find((p) => existsSync(p));
      if (foundDb) {
        try {
          const st = statSync(foundDb);
          const sizeKb = (st.size / 1024).toFixed(1);
          updateCheck("Trading DB", "pass", formatTradingDbCheckDetail(foundDb, sizeKb));
        } catch {
          updateCheck("Trading DB", "warn", formatTradingDbCheckDetail(foundDb, null));
        }
      } else {
        updateCheck("Trading DB", "pass", "Not created yet (normal on first run)");
      }
      const portFree = await checkPort(port);
      const gatewaySnapshot = await collectGatewayAccessSnapshot(port);
      const sandboxNetworkDisagrees = portFree && (gatewaySnapshot.gatewayListenerCount > 0 || gatewaySnapshot.daemonDetected);
      if (gatewaySnapshot.gatewayListenerCount > 0) {
        updateCheck(
          `Port ${port}`,
          sandboxNetworkDisagrees ? "warn" : "pass",
          sandboxNetworkDisagrees ? `Listener detected (${gatewaySnapshot.gatewayListenerCount}), but the local bind probe also reported the port as available \u2014 this sandbox has an isolated network view.` : `Listener detected (${gatewaySnapshot.gatewayListenerCount})`
        );
      } else if (gatewaySnapshot.daemonDetected) {
        updateCheck(
          `Port ${port}`,
          "warn",
          portFree ? "Daemon state was detected from the owner lock, but the local bind probe still reported the port as available \u2014 this sandbox has an isolated network view." : "Daemon state was detected from the owner lock, but no listener was visible to this doctor run."
        );
      } else {
        updateCheck(
          `Port ${port}`,
          portFree ? "pass" : "warn",
          portFree ? "Available" : "In use by another process, but no Zaraa listener was detected"
        );
      }
      const gatewayStatus = await requestGatewayJson(port, "/ready");
      if (sandboxNetworkDisagrees) {
        updateCheck(
          "Gateway API",
          "warn",
          "Listener detection and bind probing disagree in this environment, so local HTTP reachability from `doctor` is not trustworthy. Prefer `zaraa pulse` and `zaraa remote` for the operator-facing status."
        );
      } else if (gatewayStatus.ok) {
        updateCheck(
          "Gateway API",
          gatewayStatus.data?.status === "ready" ? "pass" : "warn",
          `Reachable on port ${port}${gatewayStatus.data?.status ? ` (${gatewayStatus.data.status})` : ""}`
        );
      } else {
        updateCheck(
          "Gateway API",
          "warn",
          buildGatewayAccessFailureMessage("Gateway API is not reachable.", port, gatewaySnapshot, [
            gatewayStatus
          ])
        );
      }
      if (process.platform !== "darwin") {
        const classified = classifyRemindersTccDoctorCheck({ platform: process.platform });
        updateCheck("Reminders TCC", classified.status, classified.detail, classified.critical);
      } else {
        const probePath = resolveRemindersTccProbePath();
        if (!probePath) {
          updateCheck(
            "Reminders TCC",
            "warn",
            "Probe script missing \u2014 run `pnpm -s zaraa:reminders-tcc` from the monorepo. Human grant: System Settings \u2192 Privacy & Security \u2192 Automation / Calendars / Reminders.",
            false
          );
        } else {
          try {
            const { stdout } = await execFileAsync(
              process.execPath,
              [probePath, ...remindersTccDoctorProbeArgs()],
              {
                timeout: 2e4,
                maxBuffer: 1024 * 1024
              }
            );
            const report = JSON.parse(stdout);
            const classified = classifyRemindersTccDoctorCheck(report);
            updateCheck("Reminders TCC", classified.status, classified.detail, classified.critical);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            updateCheck(
              "Reminders TCC",
              "warn",
              `Probe did not complete (${detail.slice(0, 160)}). Human: System Settings \u2192 Privacy & Security \u2192 Automation / Calendars / Reminders, then pnpm -s zaraa:reminders-tcc.`,
              false
            );
          }
        }
      }
      setDone(true);
    };
    runDiagnostics();
  }, [port, updateCheck]);
  useEffect(() => {
    if (!done) return;
    const hasCriticalFailure = checks.some((c) => c.status === "fail" && c.critical);
    const timer = setTimeout(() => {
      if (hasCriticalFailure) process.exitCode = 1;
      exit();
    }, 100);
    return () => clearTimeout(timer);
  }, [done, checks, exit]);
  const statusIcon = (s) => {
    switch (s) {
      case "pass":
        return "[OK]";
      case "warn":
        return "[WARN]";
      case "fail":
        return "[FAIL]";
      case "checking":
        return "[ .. ]";
    }
  };
  const statusColor = (s) => {
    switch (s) {
      case "pass":
        return "green";
      case "warn":
        return "yellow";
      case "fail":
        return "red";
      case "checking":
        return "gray";
    }
  };
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const labelWidth = 24;
  const completionMessage = buildDoctorCompletionMessage(checks);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsx(Box, { borderStyle: "single", paddingX: 1, children: /* @__PURE__ */ jsx(Text, { bold: true, children: "Zaraa Doctor" }) }),
    /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginTop: 1, children: checks.map((check) => /* @__PURE__ */ jsxs(Text, { children: [
      /* @__PURE__ */ jsx(Text, { color: statusColor(check.status), bold: true, children: `${statusIcon(check.status).padEnd(7)} ${check.name.padEnd(labelWidth)}` }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        " \u2014 ",
        check.detail
      ] })
    ] }, check.name)) }),
    done && /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { color: failCount > 0 ? "red" : warnCount > 0 ? "yellow" : "green", bold: true, children: completionMessage }),
      failCount > 0 && /* @__PURE__ */ jsx(Text, { color: "gray", children: "Exiting with code 1." })
    ] })
  ] });
}

export {
  buildDoctorCompletionMessage,
  classifyDiskSpace,
  classifyAuthenticatedProviderStatus,
  compactHomePath,
  buildConfigPermissionFailureDetail,
  formatTradingDbCheckDetail,
  Doctor
};
