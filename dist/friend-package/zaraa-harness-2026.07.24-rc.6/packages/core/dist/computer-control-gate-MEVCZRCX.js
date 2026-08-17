import "./chunk-R5U7XKVJ.js";

// src/security/computer-control-gate.ts
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var HARD_BLOCKED_APPS = /* @__PURE__ */ new Set([
  "system settings",
  "system preferences",
  "keychain access",
  "passwords",
  "1password",
  "1password 7",
  "bitwarden",
  "lastpass",
  "dashlane",
  "wallet"
]);
var HARD_BLOCK_PAYLOAD_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  // SSN
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  // card number
  /\bcvv2?\s*[:=]?\s*\d{3,4}\b/i,
  /\bpassword\s*[:=]/i
];
var PAYLOAD_SCANNED_TOOLS = /* @__PURE__ */ new Set([
  "app_type_text",
  "app_keystroke",
  "rc_clipboard_write"
]);
var ComputerControlGate = class {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }
  cfg;
  actionCount = 0;
  windowStartMs = 0;
  now;
  log;
  /** Master toggle — false means zero computer-control surface anywhere. */
  get masterEnabled() {
    return this.cfg?.enabled === true;
  }
  /** Desktop backend registration gate (master AND desktop toggles). */
  get desktopEnabled() {
    return this.masterEnabled && this.cfg?.backends?.desktop?.enabled === true;
  }
  get allowedApps() {
    return this.cfg?.backends?.desktop?.allowedApps ?? [];
  }
  get maxActions() {
    return this.cfg?.sessionCap?.maxActions ?? 50;
  }
  get maxWindowMs() {
    return (this.cfg?.sessionCap?.maxMinutes ?? 15) * 6e4;
  }
  auditPath() {
    const p = this.cfg?.auditLog ?? "~/.zaraa/logs/computer-control.jsonl";
    return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(2)) : p;
  }
  isHardBlockedApp(app) {
    return HARD_BLOCKED_APPS.has(app.trim().toLowerCase());
  }
  isAppAllowed(app) {
    const target = app.trim().toLowerCase();
    return this.allowedApps.some((a) => a.trim().toLowerCase() === target);
  }
  /**
   * Force spec posture onto a plugin manifest at registration time:
   * minZone at least the configured zone (default "guarded") and
   * per-action approval unless explicitly disabled in config.
   */
  wrapManifest(manifest) {
    const requiresApproval = this.cfg?.requiresApproval !== false;
    const ZONE_LEVEL = { sandbox: 0, guarded: 1, trusted: 2 };
    const floor = this.cfg?.minZone ?? "guarded";
    const minZone = (ZONE_LEVEL[manifest.minZone] ?? 0) >= (ZONE_LEVEL[floor] ?? 1) ? manifest.minZone : floor;
    return {
      ...manifest,
      minZone,
      tools: manifest.tools.map((t) => ({
        ...t,
        requiresApproval: requiresApproval ? true : t.requiresApproval
      }))
    };
  }
  /**
   * Wrap a handler map with gate enforcement. `fixedApp` pins the target app
   * for single-app plugins (e.g. logic-pro → "Logic Pro"); otherwise the
   * target is read from `args.app` when present.
   */
  wrapHandlers(plugin, handlers, opts = {}) {
    const wrapped = {};
    for (const [tool, handler] of Object.entries(handlers)) {
      wrapped[tool] = async (args, ...rest) => {
        const decision = this.evaluateCall(plugin, tool, args, opts.fixedApp);
        if (decision) {
          throw new Error(`computer-control blocked (${decision})`);
        }
        return handler(args, ...rest);
      };
    }
    return wrapped;
  }
  /**
   * Returns undefined when allowed, or a block reason string.
   * Always audits the decision.
   */
  evaluateCall(plugin, tool, args, fixedApp) {
    const app = fixedApp ?? (typeof args?.app === "string" ? args.app : void 0);
    let reason;
    if (!this.desktopEnabled) {
      reason = "computer-control desktop backend disabled";
    }
    if (!reason && app && this.isHardBlockedApp(app)) {
      reason = `hard-blocked surface: ${app}`;
    }
    if (!reason && PAYLOAD_SCANNED_TOOLS.has(tool)) {
      const payload = [args?.text, args?.content, args?.keys, args?.key].filter((v) => typeof v === "string").join(" ");
      if (payload && HARD_BLOCK_PAYLOAD_PATTERNS.some((re) => re.test(payload))) {
        reason = "credential-like payload refused";
      }
    }
    if (!reason && app && !this.isAppAllowed(app)) {
      reason = `app not in computerControl allowlist: ${app}`;
    }
    if (!reason) {
      const now = this.now();
      if (this.windowStartMs === 0 || now - this.windowStartMs > this.maxWindowMs) {
        this.windowStartMs = now;
        this.actionCount = 0;
      }
      this.actionCount += 1;
      if (this.actionCount > this.maxActions) {
        reason = `session action cap reached (${this.maxActions} per ${this.maxWindowMs / 6e4}m)`;
      }
    }
    this.audit({
      ts: new Date(this.now()).toISOString(),
      plugin,
      tool,
      app,
      decision: reason ? "block" : "allow",
      reason
    });
    return reason;
  }
  /** Append an audit entry; failures are logged and never affect the decision. */
  audit(entry) {
    try {
      const path = this.auditPath();
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}
`, "utf8");
    } catch (err) {
      this.log?.warn(
        { err: err instanceof Error ? err.message : err },
        "computer-control audit write failed"
      );
    }
  }
};
export {
  ComputerControlGate
};
