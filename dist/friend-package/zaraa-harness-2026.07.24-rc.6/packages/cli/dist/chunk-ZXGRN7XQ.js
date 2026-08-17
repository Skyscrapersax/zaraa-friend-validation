// ../../scripts/friend-release-constants.mjs
import { spawnSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
var FRIEND_PACKAGE_ROOT_REL = "dist/friend-package";
var FRIEND_PACKAGE_LATEST_REL = `${FRIEND_PACKAGE_ROOT_REL}/latest.json`;
var FRIEND_TRADING_SECRET_KEYS = [
  "apiKey",
  "apiSecret",
  "solanaDexSecretKey",
  "liveModeLock"
];
var FRIEND_POLYMARKET_SECRET_KEYS = ["apiKey", "apiSecret", "apiPassphrase", "privateKey"];
var FRIEND_PACKAGE_STAGING_SKIP_BASENAMES = /* @__PURE__ */ new Set([
  ".DS_Store",
  ".git",
  ".npmrc",
  ".turbo",
  ".vite",
  ".zaraa",
  ":memory:",
  "__fixtures__",
  "coverage",
  "fixtures",
  "install-output.log",
  "node_modules",
  "target"
]);
var FRIEND_BUNDLE_FORBIDDEN_BASENAMES = /* @__PURE__ */ new Set([
  ...FRIEND_PACKAGE_STAGING_SKIP_BASENAMES,
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "npm-cache",
  "pnpm-store",
  "zaraa.config.json"
]);

// src/setup-wizard/config-merge.mjs
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var TRADING_SECRET_KEYS = FRIEND_TRADING_SECRET_KEYS;
var POLYMARKET_SECRET_KEYS = FRIEND_POLYMARKET_SECRET_KEYS;
function applyFriendMoneySafety(config) {
  const trading = isPlainObject(config.trading) ? { ...config.trading } : {};
  const predictions = isPlainObject(config.predictions) ? { ...config.predictions } : {};
  const polymarket = isPlainObject(predictions.polymarket) ? { ...predictions.polymarket } : null;
  const scheduler = isPlainObject(config.scheduler) ? { ...config.scheduler } : {};
  const overnight = isPlainObject(scheduler.overnight) ? { ...scheduler.overnight } : {};
  trading.paperMode = true;
  trading.autoExecuteLive = false;
  trading.backgroundAutomation = false;
  for (const key of TRADING_SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(trading, key) && trading[key] != null) {
      delete trading[key];
    }
  }
  predictions.paperMode = true;
  predictions.autoExecuteLive = false;
  if (polymarket) {
    for (const key of POLYMARKET_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(polymarket, key) && polymarket[key] != null) {
        delete polymarket[key];
      }
    }
    predictions.polymarket = polymarket;
  }
  if (overnight.enabled !== false) {
    overnight.enabled = false;
  }
  scheduler.overnight = overnight;
  return {
    ...config,
    trading,
    predictions,
    scheduler
  };
}
function mergeSetupConfig(existing, generated) {
  const {
    trading: _generatedTrading,
    predictions: _generatedPredictions,
    ...safeGenerated
  } = generated;
  if (!isPlainObject(existing)) {
    return applyFriendMoneySafety({ ...safeGenerated });
  }
  const base = existing;
  const merged = { ...base, ...safeGenerated };
  if (isPlainObject(base.trading)) {
    merged.trading = { ...base.trading };
  }
  if (isPlainObject(base.predictions)) {
    merged.predictions = { ...base.predictions };
  }
  return applyFriendMoneySafety(merged);
}

export {
  FRIEND_TRADING_SECRET_KEYS,
  FRIEND_POLYMARKET_SECRET_KEYS,
  applyFriendMoneySafety,
  mergeSetupConfig
};
