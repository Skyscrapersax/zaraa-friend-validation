// src/runtime-home.ts
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
function resolveRuntimeHomeDir(env = process.env) {
  const raw = env.ZARAA_HOME_DIR;
  if (raw === void 0) return homedir();
  const value = raw.trim();
  if (!value) throw new Error("ZARAA_HOME_DIR must be a non-empty absolute path");
  if (!isAbsolute(value)) throw new Error("ZARAA_HOME_DIR must be a non-empty absolute path");
  const resolved = resolve(value);
  if (dirname(resolved) === resolved) throw new Error("ZARAA_HOME_DIR cannot be a filesystem root");
  return resolved;
}
function resolveCliConfigDir(env = process.env) {
  return env.ZARA_CONFIG_PATH?.trim() || join(resolveRuntimeHomeDir(env), ".zaraa");
}

export {
  resolveRuntimeHomeDir,
  resolveCliConfigDir
};
