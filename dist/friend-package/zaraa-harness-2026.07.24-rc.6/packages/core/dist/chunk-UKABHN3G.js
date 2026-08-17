// src/cli-anything/cli-anything-bridge.ts
import { execFile } from "child_process";
var CLI_ANYTHING_PREFIX = "cli-anything-";
var MAX_OUTPUT_CHARS = 64e3;
var DISCOVERY_CACHE_TTL = 5 * 60 * 1e3;
function validateArg(arg) {
  const dangerous = /[;&|`${}[\]<>!\\]/;
  if (dangerous.test(arg)) return false;
  if (arg.includes("\0")) return false;
  if (arg.length > 4096) return false;
  return true;
}
function isValidSoftwareName(name) {
  return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(name) && name.length <= 64;
}
function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `

[truncated \u2014 output was ${text.length} chars, showing first ${MAX_OUTPUT_CHARS}]`;
}
var CliAnythingBridge = class {
  options;
  discovered = /* @__PURE__ */ new Map();
  activeCommands = 0;
  lastDiscoveryTime = 0;
  constructor(options = {}) {
    this.options = {
      allowlist: options.allowlist ?? [],
      blocklist: options.blocklist ?? [],
      timeoutMs: options.timeoutMs ?? 12e4,
      maxConcurrent: options.maxConcurrent ?? 3
    };
  }
  /**
   * Discover installed CLI-Anything harnesses by scanning PATH
   * for binaries matching the "cli-anything-*" pattern.
   * Results are cached for 5 minutes; pass force=true to bypass.
   */
  async discover(force = false) {
    if (!force && this.discovered.size > 0 && Date.now() - this.lastDiscoveryTime < DISCOVERY_CACHE_TTL) {
      return Array.from(this.discovered.values());
    }
    this.discovered.clear();
    const binaries = await this.findBinaries();
    for (const { binary, path } of binaries) {
      const software = binary.replace(CLI_ANYTHING_PREFIX, "");
      if (!isValidSoftwareName(software)) continue;
      if (!this.isSoftwareAllowed(software)) continue;
      const harness = { binary, software, path };
      try {
        const result = await this.execRaw(path, ["--version"], 5e3);
        if (result.exitCode === 0 && result.stdout.trim()) {
          harness.version = result.stdout.trim().split("\n")[0];
        }
      } catch (err) {
        console.debug(`[cli-anything] version detection failed for ${software}:`, err instanceof Error ? err.message : err);
      }
      this.discovered.set(software, harness);
    }
    this.lastDiscoveryTime = Date.now();
    return Array.from(this.discovered.values());
  }
  /** Get previously discovered harnesses */
  getDiscovered() {
    return Array.from(this.discovered.values());
  }
  /** Check if a specific software harness is available */
  has(software) {
    return this.discovered.has(software);
  }
  /**
   * Execute a CLI-Anything command.
   *
   * @param software  The software name (e.g. "gimp")
   * @param args      Command arguments (e.g. ["project", "new", "-w", "1920", "--json"])
   * @param json      Whether to append --json flag (default: true)
   */
  async run(software, args, json = true) {
    const harness = this.discovered.get(software);
    if (!harness) {
      return {
        ok: false,
        stdout: "",
        stderr: `Software "${software}" is not available. Run cli_discover first.`,
        exitCode: -1,
        durationMs: 0
      };
    }
    if (!this.isSoftwareAllowed(software)) {
      return {
        ok: false,
        stdout: "",
        stderr: `Software "${software}" is not in the allowlist.`,
        exitCode: -1,
        durationMs: 0
      };
    }
    for (const arg of args) {
      if (!validateArg(arg)) {
        return {
          ok: false,
          stdout: "",
          stderr: `Argument rejected by safety check: "${arg.slice(0, 100)}"`,
          exitCode: -1,
          durationMs: 0
        };
      }
    }
    if (this.activeCommands >= this.options.maxConcurrent) {
      return {
        ok: false,
        stdout: "",
        stderr: `Concurrency limit reached (${this.options.maxConcurrent}). Wait for a running command to finish.`,
        exitCode: -1,
        durationMs: 0
      };
    }
    const finalArgs = json && !args.includes("--json") ? [...args, "--json"] : [...args];
    this.activeCommands++;
    try {
      const result = await this.execRaw(
        harness.path,
        finalArgs,
        this.options.timeoutMs
      );
      result.stdout = truncateOutput(result.stdout);
      result.stderr = truncateOutput(result.stderr);
      if (json && result.exitCode === 0) {
        try {
          result.data = JSON.parse(result.stdout);
        } catch (err) {
          console.debug("[cli-anything] JSON parse of output failed:", err instanceof Error ? err.message : err);
        }
      }
      return result;
    } finally {
      this.activeCommands--;
    }
  }
  /**
   * Get help text for a software harness or a specific command group.
   */
  async help(software, command) {
    const harness = this.discovered.get(software);
    if (!harness) {
      return `Software "${software}" is not available.`;
    }
    const args = command ? [command, "--help"] : ["--help"];
    const result = await this.execRaw(harness.path, args, 1e4);
    return result.stdout || result.stderr;
  }
  /* ---------------------------------------------------------------- */
  /*  Internal helpers                                                */
  /* ---------------------------------------------------------------- */
  isSoftwareAllowed(software) {
    if (this.options.blocklist.length > 0 && this.options.blocklist.includes(software)) {
      return false;
    }
    if (this.options.allowlist.length > 0) {
      return this.options.allowlist.includes(software);
    }
    return true;
  }
  /** Find cli-anything-* binaries on PATH */
  async findBinaries() {
    return new Promise((resolve) => {
      const findCmd = process.platform === "win32" ? "where" : "bash";
      const findArgs = process.platform === "win32" ? ["cli-anything-*"] : ["-c", 'compgen -c | grep "^cli-anything-" | sort -u'];
      execFile(findCmd, findArgs, { timeout: 1e4 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        const names = stdout.trim().split("\n").filter(Boolean);
        const results = [];
        let pending = names.length;
        if (pending === 0) {
          resolve([]);
          return;
        }
        for (const name of names) {
          const whichCmd = process.platform === "win32" ? "where" : "which";
          execFile(whichCmd, [name], { timeout: 5e3 }, (e, out) => {
            if (!e && out.trim()) {
              results.push({ binary: name, path: out.trim().split("\n")[0] });
            }
            pending--;
            if (pending === 0) resolve(results);
          });
        }
      });
    });
  }
  /** Low-level subprocess execution — always uses execFile (no shell) */
  execRaw(binaryPath, args, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      execFile(
        binaryPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          // 10 MB
          env: { ...process.env, NO_COLOR: "1" }
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const exitCode = err && "code" in err ? err.code ?? 1 : err ? 1 : 0;
          resolve({
            ok: exitCode === 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode,
            durationMs
          });
        }
      );
    });
  }
};

export {
  CliAnythingBridge
};
