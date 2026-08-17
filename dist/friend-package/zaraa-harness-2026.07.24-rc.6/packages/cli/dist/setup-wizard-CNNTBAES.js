import {
  FRIEND_POLYMARKET_SECRET_KEYS,
  FRIEND_TRADING_SECRET_KEYS,
  applyFriendMoneySafety,
  mergeSetupConfig
} from "./chunk-ZXGRN7XQ.js";
import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/setup-wizard/index.tsx
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState } from "react";

// src/setup-wizard/config-persist.mjs
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { randomBytes } from "crypto";
var SETUP_CONFIG_PRE_WRITE_BACKUP_KEEP = 1;
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stripUtf8Bom(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  return raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
}
function listPresentSecretFields(config) {
  const paths = [];
  if (!isPlainObject(config)) return paths;
  const trading = isPlainObject(config.trading) ? config.trading : null;
  if (trading) {
    for (const key of FRIEND_TRADING_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(trading, key) && trading[key] != null) {
        paths.push(`trading.${key}`);
      }
    }
  }
  const predictions = isPlainObject(config.predictions) ? config.predictions : null;
  const polymarket = predictions && isPlainObject(predictions.polymarket) ? predictions.polymarket : null;
  if (polymarket) {
    for (const key of FRIEND_POLYMARKET_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(polymarket, key) && polymarket[key] != null) {
        paths.push(`predictions.polymarket.${key}`);
      }
    }
  }
  return paths;
}
function setupConfigPreWriteBackupPath(absConfigPath, now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${absConfigPath}.pre-setup-wizard.${stamp}.json`;
}
function setupConfigRestoreCommand(backupPath, configPath) {
  const q = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
  return `cp ${q(backupPath)} ${q(configPath)}`;
}
function formatSetupRestoreDisplay(backupPath, configPath, home = homedir()) {
  const compact = (p) => {
    const value = String(p);
    if (value === home) return "~";
    return value.startsWith(`${home}${sep}`) ? `~${value.slice(home.length)}` : value;
  };
  return `cp ${compact(backupPath)} ${compact(configPath)}`;
}
function assertSetupConfigPathNotSymlink(abs) {
  const parent = dirname(abs);
  if (existsSync(parent)) {
    let parentStats;
    try {
      parentStats = lstatSync(parent);
    } catch {
      parentStats = null;
    }
    if (parentStats?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write setup config under symlink parent directory: ${parent}. Replace the parent symlink with a real directory under the intended home path.`
      );
    }
    if (parentStats && !parentStats.isDirectory()) {
      throw new Error(
        `Refusing to write setup config: parent path is not a directory: ${parent}.`
      );
    }
  }
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to write setup config through symlink: ${abs}. Replace the symlink with a regular file under the intended home config path.`
    );
  }
  if (!stats.isFile()) {
    throw new Error(
      `Refusing to write setup config: path is not a regular file: ${abs}. Expected a plain JSON config file (not a directory or special file).`
    );
  }
  if (typeof stats.nlink === "number" && stats.nlink > 1) {
    throw new Error(
      `Refusing to write setup config with hardlink count ${stats.nlink}: ${abs}. Copy to a unique regular file (nlink=1) under the intended home config path, then re-run setup.`
    );
  }
}
function writeSetupConfigBackupExclusive(sourceAbs, backupAbs) {
  const absSource = resolve(sourceAbs);
  const absBackup = resolve(backupAbs);
  if (absSource === absBackup) {
    throw new Error("Refusing to write setup backup over the live config path.");
  }
  if (existsSync(absBackup)) {
    let st = null;
    try {
      st = lstatSync(absBackup);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write pre-setup backup through existing symlink: ${absBackup}.`
      );
    }
    throw new Error(
      `Pre-setup backup path already exists: ${absBackup}. Retry after removing the collision.`
    );
  }
  let sourceStats;
  try {
    sourceStats = lstatSync(absSource);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot lstat config for setup backup ${absSource}: ${detail}`);
  }
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(`Refusing to backup non-regular or symlink config: ${absSource}.`);
  }
  const body = readFileSync(absSource);
  const fd = openSync(
    absBackup,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    384
  );
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(absBackup, 384);
  } catch {
  }
  return absBackup;
}
function writeSetupFileExclusive0600(absPath, body) {
  const abs = resolve(absPath);
  const fd = openSync(
    abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    384
  );
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(abs, 384);
  } catch {
  }
  return abs;
}
function writeSetupConfigAtomically(abs, body, options = {}) {
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    chmodSync(dir, 448);
  } catch {
  }
  const suffix = typeof options.tmpSuffix === "string" && options.tmpSuffix.length > 0 ? options.tmpSuffix : `${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmp = join(dir, `.${basename(abs)}.setup-wizard-tmp.${suffix}`);
  try {
    writeSetupFileExclusive0600(tmp, body);
    renameSync(tmp, abs);
    try {
      chmodSync(abs, 384);
    } catch {
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw error;
  }
}
function pruneSetupConfigPreWriteBackups(absConfigPath, keep = SETUP_CONFIG_PRE_WRITE_BACKUP_KEEP) {
  const abs = resolve(absConfigPath);
  const dir = dirname(abs);
  const base = basename(abs);
  const prefix = `${base}.pre-setup-wizard.`;
  if (!existsSync(dir)) return [];
  const backups = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      backups.push({ path: full, mtimeMs: statSync(full).mtimeMs });
    } catch {
    }
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pruned = [];
  for (const extra of backups.slice(Math.max(0, keep))) {
    try {
      unlinkSync(extra.path);
      pruned.push(extra.path);
    } catch {
    }
  }
  return pruned;
}
function persistSetupConfigFile(configPath, config, options = {}) {
  const abs = resolve(configPath);
  assertSetupConfigPathNotSymlink(abs);
  const existed = existsSync(abs);
  let existing = {};
  let rawExisting = null;
  if (existed) {
    try {
      rawExisting = readFileSync(abs, "utf8");
      existing = JSON.parse(stripUtf8Bom(rawExisting));
    } catch (error) {
      throw new Error(
        `Cannot parse existing config at ${abs}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const beforeSecrets = listPresentSecretFields(existing);
  const afterSecrets = new Set(listPresentSecretFields(config));
  const strippedSecretFields = beforeSecrets.filter((p) => !afterSecrets.has(p));
  const body = `${JSON.stringify(config, null, 2)}
`;
  const writeConfig2 = options.writeConfig ?? writeSetupConfigAtomically;
  let backupPath = null;
  if (strippedSecretFields.length > 0 && existed && rawExisting != null) {
    backupPath = setupConfigPreWriteBackupPath(abs, options.now ?? /* @__PURE__ */ new Date());
    writeSetupConfigBackupExclusive(abs, backupPath);
  }
  try {
    writeConfig2(abs, body);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Setup config write failed for ${abs}: ${msg}` + (backupPath ? ` Pre-setup backup kept at ${backupPath}` : "")
    );
  }
  const prunedBackupPaths = pruneSetupConfigPreWriteBackups(abs);
  return {
    path: abs,
    backupPath,
    restoreCommand: backupPath ? setupConfigRestoreCommand(backupPath, abs) : null,
    strippedSecretFields,
    prunedBackupPaths
  };
}

// src/setup-wizard/index.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function applyFriendMoneySafety2(config) {
  return applyFriendMoneySafety(config);
}
function mergeSetupConfig2(existing, generated) {
  return mergeSetupConfig(existing, generated);
}
function SelectionStep({
  options,
  onSelect
}) {
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow) {
      setSelected((s) => Math.min(options.length - 1, s + 1));
    } else if (key.return) {
      onSelect(selected);
    } else {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        onSelect(num - 1);
      }
    }
  });
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    options.map((opt, i) => /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsxs(Text, { color: i === selected ? "cyan" : void 0, bold: i === selected, children: [
        i === selected ? "> " : "  ",
        i + 1,
        ". ",
        opt.label
      ] }),
      opt.description && /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        " -- ",
        opt.description
      ] })
    ] }, opt.label)),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "Use arrow keys + Enter, or press a number" }) })
  ] });
}
function TextInputStep({
  label,
  mask,
  defaultValue,
  onSubmit
}) {
  const [value, setValue] = useState(defaultValue || "");
  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });
  const display = mask ? "*".repeat(value.length) : value;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsxs(Text, { children: [
        label,
        ": "
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: display }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "|" })
    ] }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "Type your value, then press Enter to continue" }) })
  ] });
}
function writeConfig(state) {
  const home = resolveRuntimeHomeDir();
  const CONFIG_DIR = join2(home, ".zaraa");
  const CONFIG_FILE = join2(CONFIG_DIR, "zaraa.config.json");
  if (!existsSync2(CONFIG_DIR)) {
    mkdirSync2(CONFIG_DIR, { recursive: true });
  }
  const providers = [];
  if (state.providerChoice === "anthropic" && state.apiKey) {
    providers.push({
      name: "anthropic",
      type: "anthropic",
      apiKey: state.apiKey,
      models: ["claude-sonnet-5"]
    });
  } else if (state.providerChoice === "ollama") {
    providers.push({
      name: "ollama",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      models: [state.ollamaModel || "llama3.2:3b"]
    });
  } else if (state.providerChoice === "openrouter" && state.apiKey) {
    providers.push({
      name: "openrouter",
      type: "openrouter",
      apiKey: state.apiKey,
      baseUrl: "https://openrouter.ai/api/v1",
      models: ["anthropic/claude-sonnet-5"]
    });
  }
  let defaultModel = "claude-sonnet-5";
  if (state.providerChoice === "ollama") {
    defaultModel = state.ollamaModel || "llama3.2:3b";
  } else if (state.providerChoice === "openrouter") {
    defaultModel = "anthropic/claude-sonnet-5";
  }
  const privacyMap = {
    strict: {
      confidential: [
        `${home}/.ssh/**`,
        `${home}/.aws/**`,
        `${home}/.env*`,
        `**/.env`,
        `**/*secret*`,
        `**/*credential*`
      ],
      neverSendPatterns: [
        "sk-",
        "ghp_",
        "AKIA",
        "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b"
      ],
      onConfidentialAccess: "block",
      promptInspection: "log",
      networkMode: "selective"
    },
    balanced: {
      confidential: [`${home}/.ssh/**`, `${home}/.aws/**`, `**/.env`, `**/*secret*`],
      neverSendPatterns: ["sk-", "ghp_", "AKIA"],
      onConfidentialAccess: "ask",
      promptInspection: "off",
      networkMode: "selective"
    },
    minimal: {
      confidential: [`${home}/.ssh/**`],
      neverSendPatterns: [],
      onConfidentialAccess: "ask",
      promptInspection: "off",
      networkMode: "open"
    }
  };
  const guardedCapabilities = {
    files: {
      allow: [`${home}/Documents/**`, `${home}/Projects/**`, `${home}/Desktop/**`],
      deny: []
    },
    network: {
      allow: ["api.anthropic.com", "api.openai.com", "openrouter.ai", "localhost:11434"],
      deny: []
    },
    shell: {
      allow: ["ls", "ls *", "git *", "echo *", "pwd", "which *"],
      approve: ["rm *", "mv *", "cp *", "mkdir *"],
      deny: ["sudo *", "chmod *", "chown *"]
    }
  };
  const generatedConfig = {
    defaultZone: state.zone,
    zones: {
      guarded: guardedCapabilities,
      trusted: {
        enabled: state.zone === "trusted",
        requireAuth: true,
        autoDowngrade: {
          afterMinutes: 60,
          onAnomaly: true
        }
      }
    },
    providers,
    models: {
      default: defaultModel
    },
    privacy: privacyMap[state.privacy],
    scheduler: {
      tasks: [
        {
          id: "daily-crypto-discipline",
          enabled: false,
          schedule: "daily 09:00 UTC",
          zone: "guarded",
          prompt: "Daily trading discipline snapshot.",
          notify: "none",
          silent: true
        }
      ],
      watchdogs: [],
      overnight: { enabled: false },
      limits: {
        maxTokensPerDay: 1e6,
        maxTasksPerHour: 60,
        maxCostPerDay: "$10",
        pauseOnBudgetExhaust: true
      }
    },
    performance: providers.length > 0 ? "auto" : "minimal"
  };
  let existingConfig = {};
  if (existsSync2(CONFIG_FILE)) {
    try {
      const raw = readFileSync2(CONFIG_FILE, "utf8");
      const text = raw.length > 0 && raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
      existingConfig = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Cannot update invalid config at ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const config = mergeSetupConfig2(existingConfig, generatedConfig);
  const persist = persistSetupConfigFile(CONFIG_FILE, config);
  return {
    path: CONFIG_FILE,
    backupPath: persist.backupPath ?? null,
    restoreCommand: persist.restoreCommand ?? null,
    strippedSecretFields: persist.strippedSecretFields ?? []
  };
}
var PROVIDER_LABELS = {
  anthropic: "Anthropic (Claude)",
  ollama: "Ollama (Local)",
  openrouter: "OpenRouter",
  skip: "Skipped"
};
var ZONE_LABELS = {
  sandbox: "Sandbox (Safe)",
  guarded: "Guarded (Balanced)",
  trusted: "Trusted (Full)"
};
var PRIVACY_LABELS = {
  strict: "Strict",
  balanced: "Balanced",
  minimal: "Minimal"
};
function SetupWizard() {
  const { exit } = useApp();
  const [step, setStep] = useState("welcome");
  const [configPath, setConfigPath] = useState("");
  const [configBackupPath, setConfigBackupPath] = useState(null);
  const [configRestoreCommand, setConfigRestoreCommand] = useState(null);
  const [strippedSecretFields, setStrippedSecretFields] = useState([]);
  const [state, setState] = useState({
    providerChoice: null,
    apiKey: "",
    ollamaModel: "llama3.2:3b",
    zone: "sandbox",
    privacy: "balanced"
  });
  const stepOrder = ["welcome", "provider", "zone", "privacy", "done"];
  const stepMap = {
    welcome: 0,
    provider: 1,
    "provider-api-key": 1,
    "provider-model": 1,
    zone: 2,
    privacy: 3,
    done: 4
  };
  const currentStepNum = stepMap[step] + 1;
  const handleProviderSelect = useCallback((index) => {
    const choices = ["anthropic", "ollama", "openrouter", "skip"];
    const choice = choices[index];
    setState((s) => ({ ...s, providerChoice: choice }));
    if (choice === "anthropic" || choice === "openrouter") {
      setStep("provider-api-key");
    } else if (choice === "ollama") {
      setStep("provider-model");
    } else {
      setStep("zone");
    }
  }, []);
  const handleApiKey = useCallback((key) => {
    setState((s) => ({ ...s, apiKey: key }));
    setStep("zone");
  }, []);
  const handleOllamaModel = useCallback((model) => {
    setState((s) => ({ ...s, ollamaModel: model || "llama3.2:3b" }));
    setStep("zone");
  }, []);
  const handleZoneSelect = useCallback((index) => {
    const zones = ["sandbox", "guarded", "trusted"];
    setState((s) => ({ ...s, zone: zones[index] }));
    setStep("privacy");
  }, []);
  const handlePrivacySelect = useCallback((index) => {
    const modes = ["strict", "balanced", "minimal"];
    setState((s) => {
      const updated = { ...s, privacy: modes[index] };
      const written = writeConfig(updated);
      setConfigPath(written.path);
      setConfigBackupPath(written.backupPath);
      setConfigRestoreCommand(written.restoreCommand);
      setStrippedSecretFields(written.strippedSecretFields);
      return updated;
    });
    setStep("done");
  }, []);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "double", paddingX: 2, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, color: "cyan", children: "Zaraa Setup Wizard" }),
      /* @__PURE__ */ jsxs(Text, { children: [
        " ",
        "| Step ",
        currentStepNum,
        "/",
        stepOrder.length
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      step === "welcome" && /* @__PURE__ */ jsx(WelcomeStep, { onNext: () => setStep("provider") }),
      step === "provider" && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
        /* @__PURE__ */ jsx(Text, { bold: true, children: "Which LLM provider would you like to use?" }),
        /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(
          SelectionStep,
          {
            options: [
              {
                label: "Anthropic (Claude)",
                description: "Recommended for best tool use"
              },
              {
                label: "Ollama (Local)",
                description: "Free, private, runs on your machine"
              },
              {
                label: "OpenRouter",
                description: "Access many models via one API"
              },
              {
                label: "Skip for now"
              }
            ],
            onSelect: handleProviderSelect
          }
        ) })
      ] }),
      step === "provider-api-key" && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
        /* @__PURE__ */ jsxs(Text, { bold: true, children: [
          "Enter your ",
          state.providerChoice === "anthropic" ? "Anthropic" : "OpenRouter",
          " API key:"
        ] }),
        /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(TextInputStep, { label: "API Key", mask: true, onSubmit: handleApiKey }) })
      ] }),
      step === "provider-model" && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
        /* @__PURE__ */ jsx(Text, { bold: true, children: "Enter the Ollama model name:" }),
        /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(
          TextInputStep,
          {
            label: "Model",
            defaultValue: "llama3.2:3b",
            onSubmit: handleOllamaModel
          }
        ) })
      ] }),
      step === "zone" && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
        /* @__PURE__ */ jsx(Text, { bold: true, children: "What trust level should Zaraa start with?" }),
        /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(
          SelectionStep,
          {
            options: [
              {
                label: "Sandbox (Safe)",
                description: "Safest start; no shell writes"
              },
              {
                label: "Guarded (Balanced)",
                description: "Allowed files; shell asks first"
              },
              {
                label: "Trusted (Full)",
                description: "Full access; experienced users"
              }
            ],
            onSelect: handleZoneSelect
          }
        ) })
      ] }),
      step === "privacy" && /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
        /* @__PURE__ */ jsx(Text, { bold: true, children: "Privacy mode?" }),
        /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(
          SelectionStep,
          {
            options: [
              {
                label: "Strict",
                description: "Block all confidential paths, log all prompts"
              },
              {
                label: "Balanced",
                description: "Ask before accessing confidential data"
              },
              {
                label: "Minimal",
                description: "Trust all paths, minimal logging"
              }
            ],
            onSelect: handlePrivacySelect
          }
        ) })
      ] }),
      step === "done" && /* @__PURE__ */ jsx(
        DoneStep,
        {
          state,
          configPath,
          backupPath: configBackupPath,
          restoreCommand: configRestoreCommand,
          strippedSecretFields,
          onExit: exit
        }
      )
    ] })
  ] });
}
function WelcomeStep({ onNext }) {
  useInput((_input, key) => {
    if (key.return) {
      onNext();
    }
  });
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: "cyan", children: "Welcome to Zaraa!" }),
    /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { children: "Zaraa is your personal AI assistant that runs locally on your machine." }),
      /* @__PURE__ */ jsx(Text, { children: "She can help with file management, shell commands, web browsing," }),
      /* @__PURE__ */ jsx(Text, { children: "and more -- all while respecting your privacy and security preferences." })
    ] }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "This wizard will help you configure Zaraa in just a few steps." }) }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "green", children: "Press Enter to get started..." }) })
  ] });
}
function DoneStep({
  state,
  configPath,
  backupPath,
  restoreCommand,
  strippedSecretFields,
  onExit
}) {
  const home = resolveRuntimeHomeDir();
  const displayConfigPath = configPath.startsWith(home) ? `~${configPath.slice(home.length)}` : configPath;
  const displayBackupPath = backupPath && backupPath.startsWith(home) ? `~${backupPath.slice(home.length)}` : backupPath;
  useInput((_input, key) => {
    if (key.return) {
      onExit();
    }
  });
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: "green", children: "Setup complete!" }),
    /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { bold: true, children: "Your configuration:" }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Provider: ",
        state.providerChoice ? PROVIDER_LABELS[state.providerChoice] : "None"
      ] }),
      state.providerChoice === "ollama" && /* @__PURE__ */ jsxs(Text, { children: [
        " Model: ",
        state.ollamaModel
      ] }),
      state.providerChoice === "anthropic" && /* @__PURE__ */ jsx(Text, { children: " Model: claude-sonnet-5" }),
      /* @__PURE__ */ jsxs(Text, { children: [
        " Trust level: ",
        ZONE_LABELS[state.zone]
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        " Privacy: ",
        PRIVACY_LABELS[state.privacy]
      ] })
    ] }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, flexDirection: "column", children: /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
      "Config written to: ",
      displayConfigPath
    ] }) }),
    backupPath && restoreCommand ? /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsxs(Text, { color: "yellow", children: [
        "Removed live trading credentials (field names only):",
        " ",
        strippedSecretFields.join(", ") || "(secrets stripped)"
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "Pre-setup backup (mode 0600): ",
        displayBackupPath
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "Restore previous config: ",
        formatSetupRestoreDisplay(backupPath, configPath, home)
      ] })
    ] }) : null,
    /* @__PURE__ */ jsxs(Box, { marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { bold: true, children: "Next steps (from the installed folder):" }),
      state.providerChoice === "skip" && /* @__PURE__ */ jsx(Text, { color: "yellow", children: "Add an LLM provider: edit ~/.zaraa/zaraa.config.json" }),
      /* @__PURE__ */ jsx(Text, { children: " Verify: pnpm doctor" }),
      /* @__PURE__ */ jsx(Text, { children: " Start: pnpm start" }),
      /* @__PURE__ */ jsx(Text, { children: " Open: http://localhost:3927/" })
    ] }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "Press Enter to exit..." }) })
  ] });
}
export {
  SetupWizard,
  applyFriendMoneySafety2 as applyFriendMoneySafety,
  mergeSetupConfig2 as mergeSetupConfig
};
