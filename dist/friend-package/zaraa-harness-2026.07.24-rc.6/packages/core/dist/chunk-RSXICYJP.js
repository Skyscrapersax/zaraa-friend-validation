// src/logger.ts
import pino from "pino";
var LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
var VALID_LOG_LEVELS = new Set(LOG_LEVELS);
function resolveLogLevel(envValue) {
  if (envValue !== void 0 && envValue !== "") {
    if (VALID_LOG_LEVELS.has(envValue)) {
      return envValue;
    }
    process.stderr.write(
      `[zaraa/logger] Unknown LOG_LEVEL "${envValue}". Valid levels: ${[...VALID_LOG_LEVELS].join(", ")}. Falling back to default.
`
    );
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}
var level = resolveLogLevel(process.env.LOG_LEVEL);
var SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "password",
  "passwd",
  "secret",
  "mnemonic",
  "seedPhrase",
  "seed_phrase",
  "privateKey",
  "private_key",
  "seed",
  "passphrase",
  "solanaDexSecretKey",
  "solana_dex_secret_key",
  "authorization",
  "x-api-key",
  "x_api_key",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "walletSeed",
  "wallet_seed",
  "privateKeyHex",
  "private_key_hex"
]);
var SENSITIVE_VALUE_PATTERNS = [
  /^sk_[0-9a-f]{32,}$/i,
  // Zaraa gateway API keys (sk_ prefix)
  /^sk-[0-9a-zA-Z]{20,}$/,
  // OpenAI-style API keys
  /^sk-ant-[0-9a-zA-Z-]{20,}$/,
  // Anthropic API keys
  /^[0-9a-f]{64}$/,
  // raw 256-bit hex (private keys, secrets)
  /^[0-9a-f]{128}$/,
  // raw 512-bit hex
  // Base58 strings 87-88 chars long: Solana private keys / wallet seeds
  /^[1-9A-HJ-NP-Za-km-z]{87,88}$/,
  // BIP-39 mnemonic: 12, 15, 18, 21, or 24 space-separated lowercase words
  /^(?:[a-z]+ ){11,23}[a-z]+$/
];
function isRedactableValue(v) {
  if (typeof v !== "string" || v.length < 16) return false;
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(v.trim()));
}
function redactSensitive(obj, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== "object") {
    if (typeof obj === "string" && isRedactableValue(obj)) return "[REDACTED]";
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => redactSensitive(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k) || SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "string" && isRedactableValue(v)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
}
var logger = pino({
  level,
  transport: process.env.NODE_ENV !== "production" ? {
    target: "pino/file",
    options: { destination: 1 }
    // stdout
  } : void 0,
  formatters: {
    level: (label) => ({ level: label }),
    log: (obj) => redactSensitive(obj)
  },
  base: { service: "zaraa" }
});
function createLogger(context) {
  return logger.child(context);
}

export {
  redactSensitive,
  logger,
  createLogger
};
