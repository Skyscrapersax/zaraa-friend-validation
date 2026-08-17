// src/providers/model-availability.ts
function lookupToggle(map, key) {
  if (!map || !(key in map)) return void 0;
  return map[key] ?? false;
}
function buildProviderModelIndex(providers) {
  const duplicateCounts = /* @__PURE__ */ new Map();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      duplicateCounts.set(model, (duplicateCounts.get(model) ?? 0) + 1);
    }
  }
  const entries = [];
  for (const provider of providers) {
    for (const modelName of provider.models ?? []) {
      const shouldNamespace = (duplicateCounts.get(modelName) ?? 0) > 1;
      const modelKey = shouldNamespace ? `${provider.name}:${modelName}` : modelName;
      entries.push({
        providerName: provider.name,
        providerType: provider.type,
        modelKey,
        modelName
      });
    }
  }
  return entries;
}
function resolveProviderConfigEnabled(provider) {
  return provider.enabled !== false;
}
function resolveGlobalProviderEnabled(source, providerName) {
  const provider = source.providers.find((entry) => entry.name === providerName);
  if (!provider) return false;
  const toggle = lookupToggle(source.modelControls?.providers, providerName);
  return toggle ?? resolveProviderConfigEnabled(provider);
}
function resolveGlobalModelEnabled(source, modelKey, providerName) {
  if (providerName && !resolveGlobalProviderEnabled(source, providerName)) {
    return false;
  }
  const toggle = lookupToggle(source.modelControls?.models, modelKey);
  return toggle ?? true;
}
function resolveZaraacoderPool(source) {
  return source.zaraacoder?.modelPool ?? {};
}
function resolveZaraacoderProviderEnabled(source, providerName) {
  const pool = resolveZaraacoderPool(source);
  const inheritGlobal = pool.inheritGlobal !== false;
  const base = inheritGlobal ? resolveGlobalProviderEnabled(source, providerName) : (() => {
    const provider = source.providers.find((entry) => entry.name === providerName);
    return provider ? resolveProviderConfigEnabled(provider) : false;
  })();
  const override = lookupToggle(pool.providers, providerName);
  return override ?? base;
}
function resolveZaraacoderModelEnabled(source, modelKey, providerName) {
  const pool = resolveZaraacoderPool(source);
  const inheritGlobal = pool.inheritGlobal !== false;
  const base = inheritGlobal ? resolveGlobalModelEnabled(source, modelKey, providerName) : (() => {
    if (providerName && !resolveProviderConfigEnabled(
      source.providers.find((entry) => entry.name === providerName) ?? { name: providerName, type: "custom", models: [] }
    )) {
      return false;
    }
    return true;
  })();
  const override = lookupToggle(pool.models, modelKey);
  return override ?? base;
}
function isProviderEnabled(source, providerName, scope = "global") {
  return scope === "zaraacoder" ? resolveZaraacoderProviderEnabled(source, providerName) : resolveGlobalProviderEnabled(source, providerName);
}
function isModelEnabled(source, modelKey, providerName, scope = "global") {
  if (providerName && !isProviderEnabled(source, providerName, scope)) {
    return false;
  }
  return scope === "zaraacoder" ? resolveZaraacoderModelEnabled(source, modelKey, providerName) : resolveGlobalModelEnabled(source, modelKey, providerName);
}
function findProviderForModelKey(source, modelKey) {
  for (const entry of buildProviderModelIndex(source.providers)) {
    if (entry.modelKey === modelKey || entry.modelName === modelKey) {
      return entry.providerName;
    }
  }
  return void 0;
}
function buildAvailabilityDashboard(source) {
  const pool = resolveZaraacoderPool(source);
  const duplicateCounts = /* @__PURE__ */ new Map();
  for (const provider of source.providers) {
    for (const model of provider.models ?? []) {
      duplicateCounts.set(model, (duplicateCounts.get(model) ?? 0) + 1);
    }
  }
  const providers = source.providers.map((provider) => {
    const globalEnabled = resolveGlobalProviderEnabled(source, provider.name);
    const zaraacoderEnabled = resolveZaraacoderProviderEnabled(source, provider.name);
    const models = (provider.models ?? []).map((modelName) => {
      const shouldNamespace = (duplicateCounts.get(modelName) ?? 0) > 1;
      const key = shouldNamespace ? `${provider.name}:${modelName}` : modelName;
      const label = shouldNamespace ? `${modelName} (${provider.name})` : modelName;
      return {
        key,
        label,
        enabled: isModelEnabled(source, key, provider.name, "global"),
        globalEnabled: resolveGlobalModelEnabled(source, key, provider.name),
        zaraacoderEnabled: resolveZaraacoderModelEnabled(source, key, provider.name)
      };
    });
    return {
      name: provider.name,
      type: provider.type,
      enabled: globalEnabled,
      globalEnabled,
      zaraacoderEnabled,
      models
    };
  });
  return {
    inheritGlobal: pool.inheritGlobal !== false,
    primaryModel: pool.primaryModel?.trim() || null,
    providers
  };
}
function applyProviderToggle(source, providerName, enabled, scope) {
  if (scope === "global") {
    const modelControls = { ...source.modelControls ?? {} };
    modelControls.providers = { ...modelControls.providers ?? {}, [providerName]: enabled };
    return { ...source, modelControls };
  }
  const zaraacoder = { ...source.zaraacoder ?? {} };
  const modelPool = { ...zaraacoder.modelPool ?? {} };
  modelPool.providers = { ...modelPool.providers ?? {}, [providerName]: enabled };
  zaraacoder.modelPool = modelPool;
  return { ...source, zaraacoder };
}
function applyModelToggle(source, modelKey, enabled, scope) {
  if (scope === "global") {
    const modelControls = { ...source.modelControls ?? {} };
    modelControls.models = { ...modelControls.models ?? {}, [modelKey]: enabled };
    return { ...source, modelControls };
  }
  const zaraacoder = { ...source.zaraacoder ?? {} };
  const modelPool = { ...zaraacoder.modelPool ?? {} };
  modelPool.models = { ...modelPool.models ?? {}, [modelKey]: enabled };
  zaraacoder.modelPool = modelPool;
  return { ...source, zaraacoder };
}
function applyPrimaryModel(source, model) {
  const zaraacoder = { ...source.zaraacoder ?? {} };
  const modelPool = { ...zaraacoder.modelPool ?? {} };
  if (model && model.trim()) {
    modelPool.primaryModel = model.trim();
  } else {
    delete modelPool.primaryModel;
  }
  zaraacoder.modelPool = modelPool;
  return { ...source, zaraacoder };
}
function applyInheritGlobal(source, inheritGlobal) {
  const zaraacoder = { ...source.zaraacoder ?? {} };
  const modelPool = { ...zaraacoder.modelPool ?? {} };
  modelPool.inheritGlobal = inheritGlobal;
  zaraacoder.modelPool = modelPool;
  return { ...source, zaraacoder };
}

// src/secrets/credential-resolver.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

// src/providers/routing-defaults.ts
var DEFAULT_CURSOR_SDK_ENV_VAR = "CURSOR_API_KEY";
var CODING_PROVIDER_PRIORITY = [
  "cursor-sdk",
  "cursor-agent",
  "claude-cli",
  "codex",
  "openai",
  "anthropic"
];
var TOOL_CALLER_PROVIDER_PRIORITY = [
  "codex",
  "openai",
  "anthropic",
  "openrouter",
  "openai-compatible"
];
var LOCAL_PROVIDER_PRIORITY = ["ollama"];
var LOCAL_ONLY_ROUTE_SLOTS = [
  "sandbox",
  "guarded",
  "trusted",
  "default",
  "chat",
  "background",
  "coding",
  "deep",
  "deeper",
  "opus",
  "agent",
  "superdebug",
  "fast",
  "toolcaller",
  "codereview",
  "introspection"
];
var CODING_MODEL_HINTS = [
  /^composer-2\.5$/i,
  /^composer-2\.5-fast$/i,
  /^composer-2-fast$/i,
  /^composer-2$/i,
  /^gpt-5\.[0-9]+-codex-spark$/i,
  /^gpt-5\.[0-9]+-codex/i,
  /^qwen2\.5-coder/i
];
var TOOL_CALLER_MODEL_HINTS = [
  /^gpt-5\.[0-9]+-codex-spark$/i,
  /^gpt-5\.[0-9]+-codex/i,
  /^gpt-5\.5/i,
  /^claude-sonnet/i
];
var LOCAL_MODEL_HINTS = [
  /^qwen3\.5-zaraa$/i,
  /^phi4-mini-zaraa$/i,
  /^gemma4-e4b-zaraa$/i,
  /^gemma4-e4b-qat-zaraa$/i,
  /^gemma4-e2b-zaraa$/i,
  /^gemma3-zaraa$/i,
  /^hf\.co\/deepreinforce-ai\/ornith/i,
  /^hf\.co\/deepreinforce-ai\/orinth/i,
  /^(?:.*)ornith/i,
  /^(?:.*)orinth/i
];
var FAST_LOCAL_MODEL_HINTS = [
  /^local_fast$/i,
  /^gemma4-e4b-qat-zaraa$/i,
  /^gemma4-e4b-zaraa$/i,
  /^gemma4[-:].*e4b.*zaraa$/i,
  /^qwen3\.5-zaraa$/i,
  /^phi4-mini-zaraa$/i,
  /^hf\.co\/deepreinforce-ai\/ornith/i,
  /^hf\.co\/deepreinforce-ai\/orinth/i,
  /^(?:.*)ornith/i,
  /^(?:.*)orinth/i
];
var FAST_CLOUD_MODEL_HINTS = [/^gpt-5\.5-low$/i, /^gpt-5\.4-mini$/i];
var NON_TOOL_PROVIDER_TYPES = /* @__PURE__ */ new Set([
  "cursor-sdk",
  "cursor-agent",
  "cursor"
]);
var CANONICAL_ROUTING_KEY_PROVIDER_TYPES = /* @__PURE__ */ new Set([
  "cursor-sdk",
  "cursor-agent"
]);
function modelMatchesAnyHint(modelName, hints) {
  return hints.some((hint) => hint.test(modelName));
}
function isLoopbackProviderUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
function isLocalOnlyProviderConfig(provider) {
  if (provider.enabled === false) return false;
  if (provider.type === "ollama") return true;
  if (!["openai", "openai-compatible", "custom"].includes(provider.type)) return false;
  return isLoopbackProviderUrl(provider.baseUrl);
}
function isFreeRouteModel(modelName) {
  return /:free$/i.test(modelName.trim());
}
function canonicalFreeRouteKey(modelName) {
  let k = modelName.trim().toLowerCase();
  const prefixes = [
    "openrouter:",
    "openrouter/",
    "xai-direct:",
    "xai-api:",
    "xai:",
    "grok:"
  ];
  for (const p of prefixes) {
    if (k.startsWith(p)) {
      k = k.slice(p.length);
      break;
    }
  }
  return k;
}
var DISABLED_PROVIDER_ROUTE_MODELS = /* @__PURE__ */ new Set([
  "nvidia/nemotron-3-ultra-550b-a55b:free"
]);
function isDisabledProviderRouteModel(modelName) {
  const normalized = modelName.trim().toLowerCase();
  const openRouterModel = normalized.startsWith("openrouter:") ? normalized.slice("openrouter:".length) : normalized;
  return DISABLED_PROVIDER_ROUTE_MODELS.has(normalized) || DISABLED_PROVIDER_ROUTE_MODELS.has(openRouterModel);
}
function isRoutableEntry(entry) {
  return !isDisabledProviderRouteModel(entry.modelKey) && !isDisabledProviderRouteModel(entry.modelName);
}
function listRoutableEntries(providers) {
  return buildProviderModelIndex(providers.filter((provider) => provider.enabled !== false)).filter(
    isRoutableEntry
  );
}
function isCursorSdkEnvAvailable(provider, env = process.env) {
  const envVar = provider.envVar ?? DEFAULT_CURSOR_SDK_ENV_VAR;
  return Boolean(env[envVar]?.trim());
}
function isCursorSdkProviderEligible(provider, env = process.env) {
  if (provider.type !== "cursor-sdk" || provider.enabled === false) return false;
  if (provider.apiKey?.trim()) return false;
  if (provider.auth === "none") return false;
  if (provider.auth === "keychain") return true;
  if (provider.auth === "env" || provider.auth === void 0) {
    return isCursorSdkEnvAvailable(provider, env);
  }
  return false;
}
function hasEligibleCursorSdkLane(providers, env = process.env) {
  return providers.some((provider) => isCursorSdkProviderEligible(provider, env));
}
function findProviderConfig(providers, providerName) {
  return providers.find((provider) => provider.name === providerName);
}
function providerOrderIndex(providers, providerName) {
  const index = providers.findIndex((provider) => provider.name === providerName);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
function resolveRoutingModelKey(entry) {
  if (CANONICAL_ROUTING_KEY_PROVIDER_TYPES.has(entry.providerType)) {
    return `${entry.providerName}:${entry.modelName}`;
  }
  return entry.modelKey;
}
function isCursorSdkEntryEligible(entry, providers, env) {
  if (entry.providerType !== "cursor-sdk") return true;
  const provider = findProviderConfig(providers, entry.providerName);
  return provider ? isCursorSdkProviderEligible(provider, env) : false;
}
function pickEntryByProviderPriority(entries, providers, priority, options) {
  const env = options?.env ?? process.env;
  const hints = options?.modelHints ?? [];
  for (const providerType of priority) {
    if (options?.excludeProviderTypes?.has(providerType)) continue;
    const typeEntries = entries.filter((entry) => entry.providerType === providerType).sort(
      (left, right) => providerOrderIndex(providers, left.providerName) - providerOrderIndex(providers, right.providerName)
    );
    for (const hint of hints) {
      const match = typeEntries.find(
        (entry) => modelMatchesAnyHint(entry.modelName, [hint]) && isCursorSdkEntryEligible(entry, providers, env)
      );
      if (match) return resolveRoutingModelKey(match);
    }
    const fallback = typeEntries.find((entry) => isCursorSdkEntryEligible(entry, providers, env));
    if (fallback) return resolveRoutingModelKey(fallback);
  }
  return void 0;
}
function buildRoutingDefaults(providers, options = {}) {
  const env = options.env ?? process.env;
  const entries = listRoutableEntries(providers);
  const modelKeys = entries.map((entry) => entry.modelKey);
  if (modelKeys.length === 0) return {};
  const defaults = {};
  const local = pickEntryByProviderPriority(entries, providers, LOCAL_PROVIDER_PRIORITY, {
    modelHints: LOCAL_MODEL_HINTS,
    env
  });
  const fastLocal = pickEntryByProviderPriority(entries, providers, LOCAL_PROVIDER_PRIORITY, {
    modelHints: FAST_LOCAL_MODEL_HINTS,
    env
  });
  const fastCloud = pickEntryByProviderPriority(entries, providers, TOOL_CALLER_PROVIDER_PRIORITY, {
    modelHints: FAST_CLOUD_MODEL_HINTS,
    excludeProviderTypes: NON_TOOL_PROVIDER_TYPES,
    env
  });
  if (options.localOnly && local) {
    return Object.fromEntries(
      LOCAL_ONLY_ROUTE_SLOTS.map((slot) => [slot, local])
    );
  }
  const codingPriority = hasEligibleCursorSdkLane(providers, env) ? CODING_PROVIDER_PRIORITY : CODING_PROVIDER_PRIORITY.filter((type) => type !== "cursor-sdk");
  const coding = pickEntryByProviderPriority(entries, providers, codingPriority, {
    modelHints: CODING_MODEL_HINTS,
    env
  });
  const toolcaller = pickEntryByProviderPriority(
    entries,
    providers,
    TOOL_CALLER_PROVIDER_PRIORITY,
    {
      modelHints: TOOL_CALLER_MODEL_HINTS,
      excludeProviderTypes: NON_TOOL_PROVIDER_TYPES,
      env
    }
  );
  if (coding) {
    defaults.coding = coding;
    defaults.fast = fastCloud ?? coding ?? fastLocal;
  }
  if (toolcaller) {
    defaults.toolcaller = toolcaller;
    defaults.guarded = toolcaller;
  }
  if (local) {
    defaults.sandbox = local;
    defaults.chat = local;
    defaults.background = local;
    defaults.fast = defaults.fast ?? fastLocal;
  }
  const onlyLocalProviders = providers.filter((provider) => provider.enabled !== false).every((provider) => provider.type === "ollama");
  if (onlyLocalProviders && local) {
    defaults.default = local;
    defaults.trusted = local;
    return defaults;
  }
  if (coding) {
    defaults.trusted = coding;
    if (!defaults.default) defaults.default = coding;
  } else if (toolcaller) {
    defaults.trusted = toolcaller;
    if (!defaults.default) defaults.default = toolcaller;
  } else if (local) {
    if (!defaults.default) defaults.default = local;
  }
  return defaults;
}
var ROUTING_FILL_SLOTS = [...LOCAL_ONLY_ROUTE_SLOTS];
function isUnsetRoutingValue(value) {
  return value === void 0 || value.trim() === "";
}
function mergeRoutingDefaults(routing, providers, options = {}) {
  const suggested = buildRoutingDefaults(providers, options);
  const merged = { ...routing, aliases: { ...routing.aliases } };
  if (options.localOnly) {
    for (const slot of LOCAL_ONLY_ROUTE_SLOTS) {
      const value = suggested[slot];
      if (typeof value === "string" && value.length > 0) merged[slot] = value;
    }
    merged.fallbackChain = merged.default ? [merged.default] : [];
    merged.opusEscalationChain = merged.default ? [merged.default] : [];
    merged.aliases = Object.fromEntries(
      Object.entries(merged.aliases ?? {}).filter(([, target]) => target === merged.default)
    );
    return merged;
  }
  for (const slot of ROUTING_FILL_SLOTS) {
    const value = suggested[slot];
    if (typeof value !== "string" || value.length === 0) continue;
    if (isUnsetRoutingValue(merged[slot])) {
      merged[slot] = value;
    }
  }
  return merged;
}
var CLOUD_WORKER_ARM_WEIGHTS = [
  { model: "gpt-5.5", weight: 7 },
  { model: "claude-sonnet-5", weight: 2 },
  { model: "claude-fable-5", weight: 1 }
];
function hashSeedString(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = hash * 31 + seed.charCodeAt(i) | 0;
  }
  return Math.abs(hash);
}
function pickWeightedCloudWorkerArm(seed) {
  const numericSeed = typeof seed === "string" ? hashSeedString(seed) : Math.abs(Math.trunc(seed));
  const totalWeight = CLOUD_WORKER_ARM_WEIGHTS.reduce((sum, arm) => sum + arm.weight, 0);
  let slot = numericSeed % totalWeight;
  for (const arm of CLOUD_WORKER_ARM_WEIGHTS) {
    if (slot < arm.weight) return arm.model;
    slot -= arm.weight;
  }
  return CLOUD_WORKER_ARM_WEIGHTS[0].model;
}

// src/providers/cursor-credential-guard.ts
function cursorSdkInlineApiKeyForbidden(provider) {
  return provider.type === "cursor-sdk" && Boolean(provider.apiKey?.trim());
}

// src/providers/grok-cli-token-manager.ts
import { execFile } from "child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var EXPIRY_BUFFER_MS = 6e4;
var DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
var DEFAULT_EXPIRES_IN_SEC = 21600;
async function runGrokCli(binary, args) {
  try {
    await execFileAsync(binary, args, { timeout: 3e4 });
  } catch {
    throw new Error("Grok CLI token refresh failed");
  }
}
async function defaultTokenFetcher(input) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId
  });
  const res = await fetch(input.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OIDC refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const accessToken = data.access_token?.trim() ?? "";
  if (!accessToken) throw new Error("OIDC refresh returned no access_token");
  return {
    accessToken,
    refreshToken: data.refresh_token?.trim() || void 0,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : void 0
  };
}
function readJwtExpiryMs(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1e3;
  } catch {
    return null;
  }
}
function parseEntryExpiryMs(entry, key) {
  if (typeof entry.expires_at === "string") {
    const parsed = Date.parse(entry.expires_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at)) {
    return entry.expires_at < 1e12 ? entry.expires_at * 1e3 : entry.expires_at;
  }
  return readJwtExpiryMs(key) ?? Number.NaN;
}
function clientIdFromEntryKey(entryKey) {
  const parts = entryKey.split("::");
  return parts.length >= 2 ? parts[parts.length - 1] : void 0;
}
function tokenEndpointForIssuer(issuer) {
  if (!issuer) return DEFAULT_TOKEN_ENDPOINT;
  const base = issuer.replace(/\/$/, "");
  if (base.includes("auth.x.ai")) return `${base}/oauth2/token`;
  return `${base}/oauth2/token`;
}
function readAuthFile(authPath) {
  if (!existsSync(authPath)) return null;
  try {
    return JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}
function listEntries(auth) {
  const out = [];
  for (const [entryKey, value] of Object.entries(auth)) {
    if (!value || typeof value !== "object") continue;
    const raw = value;
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key || key.length < 20) continue;
    const expiresAt = parseEntryExpiryMs(raw, key);
    const refreshToken = typeof raw.refresh_token === "string" ? raw.refresh_token.trim() : void 0;
    const clientId = (typeof raw.oidc_client_id === "string" ? raw.oidc_client_id.trim() : void 0) || clientIdFromEntryKey(entryKey);
    const issuer = typeof raw.oidc_issuer === "string" ? raw.oidc_issuer.trim() : void 0;
    out.push({
      key,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      refreshToken,
      clientId,
      issuer,
      entryKey,
      raw
    });
  }
  return out;
}
function readFreshToken(authPath, now) {
  const auth = readAuthFile(authPath);
  if (!auth) return null;
  let freshest = null;
  for (const entry of listEntries(auth)) {
    if (entry.expiresAt <= now + EXPIRY_BUFFER_MS) continue;
    if (!freshest || entry.expiresAt > freshest.expiresAt) freshest = entry;
  }
  return freshest?.key ?? null;
}
function pickRefreshableEntry(authPath, now) {
  const auth = readAuthFile(authPath);
  if (!auth) return null;
  let best = null;
  for (const entry of listEntries(auth)) {
    if (!entry.refreshToken || !entry.clientId) continue;
    if (!best || entry.expiresAt > best.expiresAt) best = entry;
  }
  if (best) return best;
  const all = listEntries(auth);
  if (all.length === 0) return null;
  return all.sort((a, b) => b.expiresAt - a.expiresAt)[0] ?? null;
}
function writeAuthEntry(authPath, entryKey, patch) {
  const auth = readAuthFile(authPath) ?? {};
  const existing = auth[entryKey] && typeof auth[entryKey] === "object" ? { ...auth[entryKey] } : {};
  existing.key = patch.key;
  existing.expires_at = new Date(patch.expiresAtMs).toISOString();
  if (patch.refreshToken) existing.refresh_token = patch.refreshToken;
  auth[entryKey] = existing;
  const tmp = `${authPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}
`, { mode: 384 });
  renameSync(tmp, authPath);
}
var GrokCliTokenManager = class {
  authPath;
  grokBin;
  runner;
  tokenFetcher;
  now;
  refreshPromise = null;
  constructor(options = {}) {
    this.authPath = options.authPath ?? join(homedir(), ".grok", "auth.json");
    this.grokBin = options.grokBin ?? join(homedir(), ".grok", "bin", "grok");
    this.runner = options.runner ?? runGrokCli;
    this.tokenFetcher = options.tokenFetcher ?? defaultTokenFetcher;
    this.now = options.now ?? Date.now;
  }
  async getAccessToken() {
    const token = readFreshToken(this.authPath, this.now());
    if (token) return token;
    this.refreshPromise ??= this.refresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  async refresh() {
    const entry = pickRefreshableEntry(this.authPath, this.now());
    if (entry?.refreshToken && entry.clientId) {
      try {
        const result = await this.tokenFetcher({
          tokenEndpoint: tokenEndpointForIssuer(entry.issuer),
          clientId: entry.clientId,
          refreshToken: entry.refreshToken
        });
        const expiresAtMs = this.now() + (result.expiresIn ?? DEFAULT_EXPIRES_IN_SEC) * 1e3;
        writeAuthEntry(this.authPath, entry.entryKey, {
          key: result.accessToken,
          refreshToken: result.refreshToken ?? entry.refreshToken,
          expiresAtMs
        });
        return result.accessToken;
      } catch (err) {
        console.warn(
          `[grok-cli-token-manager] OIDC token refresh failed; falling back to Grok CLI nudge: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    await this.runner(this.grokBin, ["models"]);
    const token = readFreshToken(this.authPath, this.now());
    if (!token) throw new Error("Grok CLI auth unavailable or expired");
    return token;
  }
};

// src/secrets/credential-resolver.ts
var DEFAULT_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  "cursor-sdk": "CURSOR_API_KEY",
  "cursor-agent": "CURSOR_API_KEY",
  "openai-compatible": "OPENROUTER_API_KEY"
};
function normalizeAuthType(auth) {
  switch (auth) {
    case "api-key":
    case "api_key":
    case "apiKey":
      return "config";
    case "env-var":
    case "envVar":
      return "env";
    case "keychain":
    case "env":
    case "config":
    case "none":
    case "oauth":
      return auth;
    default:
      return void 0;
  }
}
function readGrokCliToken(authPath = join2(homedir2(), ".grok", "auth.json")) {
  if (!existsSync2(authPath)) return null;
  try {
    const raw = JSON.parse(readFileSync2(authPath, "utf-8"));
    const now = Date.now();
    const bufferMs = 6e4;
    let bestFresh = null;
    let bestAny = null;
    for (const value of Object.values(raw)) {
      if (!value || typeof value !== "object") continue;
      const entry = value;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (key.length < 20) continue;
      let exp = Number.NaN;
      if (typeof entry.expires_at === "string") exp = Date.parse(entry.expires_at);
      if (!Number.isFinite(exp)) exp = readJwtExpiryMs(key) ?? Number.NaN;
      const score = Number.isFinite(exp) ? exp : 0;
      if (!bestAny || score > bestAny.exp) bestAny = { key, exp: score };
      if (Number.isFinite(exp) && exp > now + bufferMs) {
        if (!bestFresh || exp > bestFresh.exp) bestFresh = { key, exp };
      } else if (!Number.isFinite(exp) && !bestFresh) {
        bestFresh = { key, exp: Number.POSITIVE_INFINITY };
      }
    }
    return bestFresh?.key ?? bestAny?.key ?? null;
  } catch {
    return null;
  }
}
var grokCliTokenManager = new GrokCliTokenManager();
var CredentialResolver = class {
  keychain;
  grokAuthPath;
  constructor(config = {}) {
    this.keychain = config.keychain ?? null;
    this.grokAuthPath = config.grokAuthPath;
  }
  /**
   * Resolve the API key for a provider.
   * Returns null if the provider doesn't need credentials (auth: "none")
   * or if no credential could be found.
   */
  async resolve(provider) {
    const auth = normalizeAuthType(provider.auth);
    if (auth === "none") {
      return null;
    }
    if (provider.type === "ollama" && !provider.auth && !provider.apiKey && !provider.envVar) {
      return null;
    }
    if (auth) {
      const specific = await this.resolveSpecific(provider, auth);
      if (!specific && isXaiProvider(provider)) {
        return this.tryGrokCliAuth();
      }
      return specific;
    }
    return await this.tryKeychain(provider) ?? this.tryEnvVar(provider) ?? this.tryConfig(provider) ?? (isXaiProvider(provider) ? this.tryGrokCliAuth() : null);
  }
  /**
   * Store a credential in the keychain for a provider.
   */
  async store(providerName, apiKey) {
    if (!this.keychain) {
      throw new Error("Cannot store credential: keychain not initialized");
    }
    await this.keychain.set(`providers/${providerName}`, apiKey);
  }
  /**
   * Check if a credential exists in the keychain for a provider.
   */
  async hasKeychainCredential(providerName) {
    if (!this.keychain) return false;
    return this.keychain.has(`providers/${providerName}`);
  }
  /**
   * Delete a credential from the keychain.
   */
  async deleteKeychainCredential(providerName) {
    if (!this.keychain) return false;
    return this.keychain.delete(`providers/${providerName}`);
  }
  async resolveSpecific(provider, auth) {
    switch (auth) {
      case "keychain":
        return this.tryKeychain(provider);
      case "env":
        return this.tryEnvVar(provider);
      case "config":
        return this.tryConfig(provider);
      case "none":
      case "oauth":
        return null;
      default:
        return null;
    }
  }
  async tryKeychain(provider) {
    if (!this.keychain) return null;
    const key = await this.keychain.get(`providers/${provider.name}`);
    if (key) {
      return { apiKey: key, source: "keychain" };
    }
    return null;
  }
  tryEnvVar(provider) {
    const envVarName = provider.envVar ?? DEFAULT_ENV_VARS[provider.type];
    if (!envVarName) return null;
    const value = process.env[envVarName];
    if (value) {
      return { apiKey: value, source: "env" };
    }
    return null;
  }
  tryConfig(provider) {
    if (cursorSdkInlineApiKeyForbidden(provider)) {
      console.warn(
        `[credential-resolver] Ignoring inline apiKey for cursor-sdk provider "${provider.name}" \u2014 use ${provider.envVar ?? "CURSOR_API_KEY"} env or keychain`
      );
      return null;
    }
    if (provider.apiKey) {
      return { apiKey: provider.apiKey, source: "config" };
    }
    return null;
  }
  /**
   * Read access token from Grok CLI auth store (~/.grok/auth.json).
   * Mark it as OAuth so providers can re-read the rotating token per request.
   */
  tryGrokCliAuth() {
    const apiKey = readGrokCliToken(this.grokAuthPath);
    return apiKey ? { apiKey, source: "oauth" } : null;
  }
};
function isXaiProvider(provider) {
  if (provider.type === "xai") return true;
  const name = (provider.name ?? "").toLowerCase();
  if (name === "xai" || name === "xai-direct" || name === "grok") return true;
  const base = (provider.baseUrl ?? "").toLowerCase();
  return base.includes("api.x.ai");
}

export {
  buildProviderModelIndex,
  isModelEnabled,
  findProviderForModelKey,
  buildAvailabilityDashboard,
  applyProviderToggle,
  applyModelToggle,
  applyPrimaryModel,
  applyInheritGlobal,
  isLocalOnlyProviderConfig,
  isFreeRouteModel,
  canonicalFreeRouteKey,
  mergeRoutingDefaults,
  pickWeightedCloudWorkerArm,
  cursorSdkInlineApiKeyForbidden,
  GrokCliTokenManager,
  readGrokCliToken,
  CredentialResolver
};
