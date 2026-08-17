#!/usr/bin/env node

// bin/zaraa.ts
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var CONFIG_DIR = join(homedir(), ".zaraa");
var CONFIG_FILE = join(CONFIG_DIR, "zaraa.config.json");
async function detectOllama() {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2e3)
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => a !== "--skip-setup" && !a.startsWith("-"));
  const hasSubcommand = positional.length > 0;
  const hasInformationalFlag = args.some(
    (arg) => ["--help", "-h", "--version", "-v"].includes(arg)
  );
  if (hasSubcommand || hasInformationalFlag || args.includes("--skip-setup")) {
    await import("./src-RLYBBZLU.js");
    return;
  }
  const { lstatSync: lstatForFirstRun } = await import("fs");
  let isFirstRun = true;
  try {
    const cfgStats = lstatForFirstRun(CONFIG_FILE);
    isFirstRun = false;
    if (!hasSubcommand && (cfgStats.isSymbolicLink() || !cfgStats.isFile())) {
      throw new Error(
        cfgStats.isSymbolicLink() ? `Refusing to use config path that is a symlink: ${CONFIG_FILE}. Replace the symlink with a regular file under the intended home config path.` : `Refusing to use config path that is not a regular file: ${CONFIG_FILE}.`
      );
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      isFirstRun = true;
    } else {
      throw error;
    }
  }
  if (isFirstRun) {
    const {
      mkdirSync,
      chmodSync,
      lstatSync,
      renameSync,
      unlinkSync,
      openSync,
      writeFileSync,
      closeSync,
      constants: fsConstants
    } = await import("fs");
    const { randomBytes } = await import("crypto");
    const { buildFirstRunConfig } = await import("./first-run-config-3U4XNZEH.js");
    if (existsSync(CONFIG_DIR)) {
      let dirStats;
      try {
        dirStats = lstatSync(CONFIG_DIR);
      } catch {
        throw new Error(`Cannot lstat config dir ${CONFIG_DIR}`);
      }
      if (dirStats.isSymbolicLink()) {
        throw new Error(
          `Refusing first-run scaffold under symlink config dir: ${CONFIG_DIR}. Replace the symlink with a real directory under the intended home path.`
        );
      }
      if (!dirStats.isDirectory()) {
        throw new Error(`Config path parent is not a directory: ${CONFIG_DIR}`);
      }
    } else {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
    }
    try {
      chmodSync(CONFIG_DIR, 448);
    } catch {
    }
    const ollamaDetected = await detectOllama();
    const home = homedir();
    const config = buildFirstRunConfig({ home, ollama: ollamaDetected });
    const body = `${JSON.stringify(config, null, 2)}
`;
    const tmp = join(
      CONFIG_DIR,
      `.zaraa.config.json.first-run-tmp.${process.pid}.${randomBytes(4).toString("hex")}`
    );
    try {
      const fd = openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        384
      );
      try {
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(tmp, 384);
      } catch {
      }
      renameSync(tmp, CONFIG_FILE);
      try {
        chmodSync(CONFIG_FILE, 384);
      } catch {
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
      }
      throw error;
    }
    if (ollamaDetected) {
      console.log("Found Ollama at localhost:11434 -- wrote a paper-only first-run config.\n");
      console.log("From the installed folder: run `pnpm doctor` then `pnpm start`.\n");
      return;
    }
    console.log("\n\u{1F31F} Welcome to Zaraa!\n");
    console.log("This looks like your first time running Zaraa.");
    console.log(`\u2705 Paper-only config scaffold created at ${CONFIG_FILE}`);
    console.log("\u{1F4DD} Complete setup from the installed folder:\n");
    console.log("  pnpm setup     # interactive provider + trust wizard");
    console.log("  pnpm doctor    # verify rails + provider readiness");
    console.log("  pnpm start     # start the local gateway\n");
    return;
  }
  await import("./src-RLYBBZLU.js");
}
main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exit(1);
});
