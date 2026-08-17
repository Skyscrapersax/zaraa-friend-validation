#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperDir = join(__dirname, "..", "tools", "native-helper");
const installDir = join(homedir(), ".zaraa", "bin");
const installPath = join(installDir, "zaraa-gui-helper");

if (process.platform !== "darwin") {
  console.error(`zaraa-gui-helper is macOS-only (got ${process.platform}). Skipping build.`);
  process.exit(0);
}

console.log(`[build:native] swift build -c release in ${helperDir}`);
const r = spawnSync("swift", ["build", "-c", "release"], { cwd: helperDir, stdio: "inherit" });
if (r.status !== 0) {
  console.error(`[build:native] swift build failed (exit ${r.status})`);
  process.exit(r.status ?? 1);
}

const builtBin = join(helperDir, ".build", "release", "ZaraaGuiHelper");
if (!existsSync(builtBin)) {
  console.error(`[build:native] expected binary at ${builtBin} but it's missing`);
  process.exit(1);
}

mkdirSync(installDir, { recursive: true });
copyFileSync(builtBin, installPath);
chmodSync(installPath, 0o755);
console.log(`[build:native] installed -> ${installPath}`);
