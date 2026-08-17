import "./chunk-R5U7XKVJ.js";

// src/osa/safari-tab.ts
import { execFile } from "child_process";
import { accessSync, constants as fsConstants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var DEFAULT_SAFARI_TAB_HELPER = process.env.ZARAA_SAFARI_TAB_HELPER?.trim() || join(homedir(), "Projects", "zara-safari-tab", "open-safari-tab.sh");
var safariTabManifest = {
  name: "safari-tab",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["os.automation"],
  trust: "core",
  tools: [
    {
      name: "safari_open_tab",
      description: "Open a new tab in the user's Safari (macOS). Default URL is about:blank. https only unless allowHttp is true. Does NOT enable full computer control; uses a confirm-gated Safari-only helper (no System Events). User can close the tab with Cmd+W. Prefer this over gui_* or app_* for Safari tabs.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open (default about:blank). https:// preferred."
          },
          activate: {
            type: "boolean",
            description: "Bring Safari to front (default true)."
          },
          allowHttp: {
            type: "boolean",
            description: "Allow http:// URLs (default false; https-only)."
          }
        }
      },
      // Side-effect tool; policy/hands-off may still auto-approve for non-hard-stop.
      requiresApproval: true
    }
  ]
};
function resolveHelper(path) {
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Safari tab helper missing or not executable: ${path}. Install/fix: chmod +x ~/Projects/zara-safari-tab/open-safari-tab.sh`
    );
  }
}
function buildSafariHelperEnv(base = process.env) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"];
  const env = {};
  for (const key of keep) {
    const v = base[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }
  env.CONFIRM_SAFARI_TAB = "1";
  return env;
}
var SAFARI_OPEN_TAB_TIMEOUT_MS_MAX = 3e4;
var SAFARI_OPEN_TAB_TIMEOUT_MS_DEFAULT = 2e4;
function clampSafariOpenTabTimeoutMs(timeoutMs) {
  const raw = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : SAFARI_OPEN_TAB_TIMEOUT_MS_DEFAULT;
  return Math.min(SAFARI_OPEN_TAB_TIMEOUT_MS_MAX, Math.max(5e3, Math.floor(raw)));
}
async function defaultRunHelper(helperPath, argv, timeoutMs) {
  const capped = clampSafariOpenTabTimeoutMs(timeoutMs);
  try {
    const { stdout, stderr } = await execFileAsync(helperPath, argv, {
      timeout: capped,
      maxBuffer: 2 * 1024 * 1024,
      env: buildSafariHelperEnv()
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && "killed" in error && error.killed) {
      throw new Error(`safari_open_tab timed out after ${capped}ms`);
    }
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      const e = error;
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: e.code
      };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
function createSafariTabHandlers(deps = {}) {
  const helperPath = deps.helperPath ?? DEFAULT_SAFARI_TAB_HELPER;
  const timeoutMs = clampSafariOpenTabTimeoutMs(deps.timeoutMs);
  const run = deps.runHelper ?? ((argv) => defaultRunHelper(helperPath, argv, timeoutMs));
  return {
    async safari_open_tab(args) {
      if (process.platform !== "darwin" && !deps.runHelper) {
        return JSON.stringify({
          ok: false,
          error: "safari_open_tab is macOS-only"
        });
      }
      if (!deps.runHelper) {
        resolveHelper(helperPath);
      }
      const url = (args.url ?? "about:blank").trim() || "about:blank";
      const argv = ["--confirm", "--json", "--url", url];
      if (args.activate === false) argv.push("--no-activate");
      if (args.allowHttp === true) argv.push("--allow-http");
      const result = await run(argv);
      const combined = `${result.stdout}
${result.stderr}`.trim();
      const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
      let jsonLine = lines.reverse().find((l) => l.startsWith("{") && l.includes("status"));
      if (jsonLine) {
        try {
          const parsed = JSON.parse(jsonLine);
          if (parsed.status === "ok") {
            return JSON.stringify({
              ok: true,
              url,
              detail: parsed.detail ?? "safari tab opened",
              emergency: "Cmd+W closes the tab; revoke Automation TCC to block future opens."
            });
          }
          return JSON.stringify({
            ok: false,
            url,
            status: parsed.status,
            detail: parsed.detail,
            exit: parsed.exit ?? result.exitCode,
            hint: "If Automation denied: System Settings \u2192 Privacy & Security \u2192 Automation \u2192 (daemon/terminal) \u2192 Safari."
          });
        } catch {
        }
      }
      if (result.exitCode === 0) {
        return JSON.stringify({
          ok: true,
          url,
          detail: combined || "ok",
          emergency: "Cmd+W closes the tab."
        });
      }
      return JSON.stringify({
        ok: false,
        url,
        exit: result.exitCode,
        detail: combined || "helper failed",
        hint: "Check helper audit log and Automation TCC for the Zaraa daemon process."
      });
    }
  };
}
export {
  DEFAULT_SAFARI_TAB_HELPER,
  SAFARI_OPEN_TAB_TIMEOUT_MS_DEFAULT,
  SAFARI_OPEN_TAB_TIMEOUT_MS_MAX,
  buildSafariHelperEnv,
  clampSafariOpenTabTimeoutMs,
  createSafariTabHandlers,
  safariTabManifest
};
