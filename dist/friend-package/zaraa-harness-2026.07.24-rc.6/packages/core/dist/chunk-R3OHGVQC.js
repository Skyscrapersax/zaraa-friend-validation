import {
  readGrokCliToken
} from "./chunk-UXKN3EGC.js";

// src/voice/xai-voice-auth.ts
function isXaiVoiceProvider(provider) {
  const type = (provider.type ?? "").toLowerCase();
  const base = (provider.baseUrl ?? "").toLowerCase();
  const name = (provider.name ?? "").toLowerCase();
  if (type === "openrouter" || base.includes("openrouter.ai")) return false;
  if (base && !base.includes("api.x.ai") && type !== "xai") {
    if (name !== "xai-direct" && name !== "grok" && name !== "xai") return false;
  }
  if (type === "xai") return true;
  if (base.includes("api.x.ai")) return true;
  if (name === "xai-direct" || name === "grok") return true;
  return false;
}
function pickXaiVoiceProvider(providers = []) {
  const eligible = providers.filter(isXaiVoiceProvider);
  return eligible.find((p) => (p.baseUrl ?? "").toLowerCase().includes("api.x.ai")) || eligible.find((p) => (p.type ?? "").toLowerCase() === "xai") || eligible[0];
}
function normalizeXaiApiOrigin(baseUrl) {
  const trimmed = (baseUrl || "https://api.x.ai").replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}
function resolveGrokCliToken(input) {
  if (typeof input.grokCliToken === "function") {
    return input.grokCliToken()?.trim() || "";
  }
  if (typeof input.grokCliToken === "string") {
    return input.grokCliToken.trim();
  }
  if (input.grokCliToken === null) {
    return "";
  }
  try {
    return readGrokCliToken(input.grokAuthPath)?.trim() || "";
  } catch {
    return "";
  }
}
function resolveXaiVoiceAuth(input = {}) {
  const env = input.env ?? process.env;
  const providers = input.providers ?? [];
  const xai = pickXaiVoiceProvider(providers);
  const envVar = xai?.envVar || "XAI_API_KEY";
  const staticKey = input.apiKey?.trim() || "";
  const providerOrEnvKey = xai?.apiKey?.trim() || env[envVar]?.trim() || env.XAI_API_KEY?.trim() || "";
  const grokCliKey = staticKey || providerOrEnvKey ? "" : resolveGrokCliToken(input);
  const apiKey = staticKey || providerOrEnvKey || grokCliKey;
  if (!apiKey) {
    return null;
  }
  const baseUrl = normalizeXaiApiOrigin(
    xai?.baseUrl?.toLowerCase().includes("api.x.ai") ? xai.baseUrl : "https://api.x.ai"
  );
  if (staticKey) {
    return { apiKey, baseUrl };
  }
  return {
    apiKey,
    baseUrl,
    // Re-runs the resolution chain so token rotation doesn't strand a stale key.
    apiKeyProvider: () => resolveXaiVoiceAuth(input)?.apiKey ?? null
  };
}

export {
  isXaiVoiceProvider,
  pickXaiVoiceProvider,
  normalizeXaiApiOrigin,
  resolveXaiVoiceAuth
};
