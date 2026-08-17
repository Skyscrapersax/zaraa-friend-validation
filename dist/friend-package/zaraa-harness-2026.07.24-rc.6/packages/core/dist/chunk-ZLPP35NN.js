// src/osa/osa-bridge.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
function escapeAppleScript(str) {
  return str.replace(/\0/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
var AppNotRunningError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AppNotRunningError";
  }
};
function condenseOsaError(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const diag = [...lines].reverse().find((l) => /execution error/i.test(l));
  return diag ?? lines[0] ?? raw;
}
function describeKilledExec(error, timeoutMs) {
  const execErr = error;
  if (!execErr || !execErr.killed && !execErr.signal) return null;
  if (execErr.killed) {
    return `osascript timed out after ${timeoutMs}ms (killed${execErr.signal ? ` by ${execErr.signal}` : ""})`;
  }
  return `osascript killed by ${execErr.signal} (external)`;
}
var OsaBridge = class {
  timeout;
  constructor(config = {}) {
    this.timeout = config.timeout ?? 1e4;
  }
  /** Execute an AppleScript expression via osascript -e */
  async run(script) {
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        timeout: this.timeout
      });
      return stdout.trim();
    } catch (error) {
      const killed = describeKilledExec(error, this.timeout);
      if (killed) {
        throw new Error(`AppleScript execution failed: ${killed}`);
      }
      const raw = error instanceof Error ? error.message : String(error);
      const msg = condenseOsaError(raw);
      if (/Application isn.?t running|\(-600\)/.test(msg)) {
        throw new AppNotRunningError(msg);
      }
      throw new Error(`AppleScript execution failed: ${msg}`);
    }
  }
  /** Execute an AppleScript file */
  async runFile(path) {
    try {
      const { stdout } = await execFileAsync("osascript", [path], {
        timeout: this.timeout
      });
      return stdout.trim();
    } catch (error) {
      const killed = describeKilledExec(error, this.timeout);
      const raw = error instanceof Error ? error.message : String(error);
      const msg = killed ?? condenseOsaError(raw);
      throw new Error(`AppleScript file execution failed: ${msg}`);
    }
  }
  /** Check if an application is running */
  async isAppRunning(appName) {
    try {
      const result = await this.run(
        `tell application "System Events" to (name of processes) contains "${escapeAppleScript(appName)}"`
      );
      return result === "true";
    } catch (err) {
      console.debug("[osa-bridge] isAppRunning check failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }
  /**
   * Ensure an application is running before scripting it. `tell application
   * "Messages"` (and similar) times out with osascript error -1712 when the
   * target app is not already running; launching it first via `open -ga`
   * (background — no focus steal, no window reopen) avoids that. Best-effort:
   * never throws, so a launch failure still lets the caller attempt the send.
   * `settleMs` gives the app a moment to register before the next AppleScript.
   */
  async ensureAppRunning(appName, settleMs = 1200) {
    try {
      if (await this.isAppRunning(appName)) return;
      await execFileAsync("open", ["-ga", appName], { timeout: this.timeout });
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
    } catch (err) {
      console.debug(
        "[osa-bridge] ensureAppRunning launch failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
  /** Activate (bring to front) an application */
  async activateApp(appName) {
    await this.run(`tell application "${escapeAppleScript(appName)}" to activate`);
  }
  /** Get a property from an application via AppleScript */
  async getAppProperty(appName, property) {
    if (!/^[a-zA-Z][a-zA-Z0-9 _.]*$/.test(property) || property.length > 128) {
      throw new Error(`Invalid AppleScript property name: "${property.slice(0, 50)}"`);
    }
    return this.run(`tell application "${escapeAppleScript(appName)}" to get ${property}`);
  }
  /** Execute a shell command directly (not via AppleScript). Uses execFile for safety (no shell). */
  async runCommand(binary, args) {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        timeout: this.timeout
      });
      return stdout.trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Command execution failed (${binary}): ${msg}`);
    }
  }
  /** Execute a JXA (JavaScript for Automation) script via osascript */
  async runJxa(script) {
    try {
      const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
        timeout: this.timeout
      });
      return stdout.trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`JXA execution failed: ${msg}`);
    }
  }
};

export {
  escapeAppleScript,
  AppNotRunningError,
  OsaBridge
};
