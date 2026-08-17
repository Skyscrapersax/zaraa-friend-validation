// src/index.ts
import { homedir } from "os";
import { join } from "path";
import {
  HelperClient,
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GuiAllowlist,
  RateLimiter,
  SensitiveAppGuard,
  KillSwitch
} from "@zaraa/gui";

// src/manifest.ts
var tools = [
  {
    name: "gui_screenshot",
    description: "Capture a PNG of the current desktop (or a region). Returns base64 + dimensions.",
    parameters: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            w: { type: "integer", minimum: 1 },
            h: { type: "integer", minimum: 1 }
          }
        }
      }
    },
    minZone: "sandbox",
    requiresApproval: false
  },
  {
    name: "gui_describe",
    description: "Capture the screen and ask the local VLM to describe what is visible. Returns text.",
    parameters: {
      type: "object",
      properties: {
        focusHint: { type: "string", description: "Optional steering hint for the VLM" }
      }
    },
    minZone: "sandbox",
    requiresApproval: false
  },
  {
    name: "gui_plan",
    description: "Capture the screen and ask the VLM to propose 1-3 next actions toward `goal`. Returns PlannedAction[]; does NOT execute.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", minLength: 1 }
      },
      required: ["goal"]
    },
    minZone: "sandbox",
    requiresApproval: false
  },
  {
    name: "gui_wait",
    description: "Sleep for a given number of milliseconds. Useful for letting the UI settle between actions.",
    parameters: {
      type: "object",
      properties: { ms: { type: "integer", minimum: 0, maximum: 6e4 } },
      required: ["ms"]
    },
    minZone: "sandbox",
    requiresApproval: false
  },
  {
    name: "gui_scroll",
    description: "Scroll at a screen position by a delta. (Phase 4 will implement; Phase 3 returns 'not implemented'.)",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        dx: { type: "integer" },
        dy: { type: "integer" }
      },
      required: ["x", "y", "dx", "dy"]
    },
    minZone: "sandbox",
    requiresApproval: false
  },
  {
    name: "gui_click",
    description: "Click at a screen position. Irreversible.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        clicks: { type: "integer", enum: [1, 2], default: 1 }
      },
      required: ["x", "y"]
    },
    minZone: "guarded",
    requiresApproval: true
  },
  {
    name: "gui_key",
    description: "Send a keyboard chord, e.g. ['cmd','c']. Irreversible.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
      },
      required: ["keys"]
    },
    minZone: "guarded",
    requiresApproval: true
  },
  {
    name: "gui_type",
    description: "Type a text string. (Phase 4 will implement; Phase 3 returns 'not implemented'.) Irreversible.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        redact: { type: "boolean", default: false }
      },
      required: ["text"]
    },
    minZone: "guarded",
    requiresApproval: true
  },
  {
    name: "gui_drag",
    description: "Drag from one screen position to another. (Phase 4 will implement; Phase 3 returns 'not implemented'.) Irreversible.",
    parameters: {
      type: "object",
      properties: {
        fromX: { type: "integer", minimum: 0 },
        fromY: { type: "integer", minimum: 0 },
        toX: { type: "integer", minimum: 0 },
        toY: { type: "integer", minimum: 0 },
        button: { type: "string", enum: ["left", "right"], default: "left" }
      },
      required: ["fromX", "fromY", "toX", "toY"]
    },
    minZone: "guarded",
    requiresApproval: true
  }
];
var GUI_MANIFEST = {
  name: "gui",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["ui.dom"],
  trust: "verified",
  tools
};

// src/handlers.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var SPECS = {
  gui_screenshot: { toolName: "gui_screenshot", bucket: "screenshot", requiresFrontmostCheck: false },
  gui_describe: { toolName: "gui_describe", bucket: "screenshot", requiresFrontmostCheck: false },
  gui_plan: { toolName: "gui_plan", bucket: "screenshot", requiresFrontmostCheck: false },
  gui_wait: { toolName: "gui_wait", bucket: "none", requiresFrontmostCheck: false },
  gui_scroll: { toolName: "gui_scroll", bucket: "input", requiresFrontmostCheck: true },
  gui_click: { toolName: "gui_click", bucket: "input", requiresFrontmostCheck: true },
  gui_key: { toolName: "gui_key", bucket: "input", requiresFrontmostCheck: true },
  gui_type: { toolName: "gui_type", bucket: "input", requiresFrontmostCheck: true },
  gui_drag: { toolName: "gui_drag", bucket: "input", requiresFrontmostCheck: true }
};
function createGuiHandlers(deps) {
  const { helper, vlm, policyGuard } = deps;
  return {
    gui_screenshot: async (args) => policyGuard(SPECS.gui_screenshot, async () => {
      await helper.start();
      const region = args.region;
      return helper.capture(region);
    }),
    gui_describe: async (args) => policyGuard(SPECS.gui_describe, async () => {
      await helper.start();
      const ss = await helper.capture();
      const focusHint = args.focusHint;
      const goal = focusHint ? `describe what is on the screen, with attention to: ${focusHint}` : "describe what is on the screen";
      const plans = await vlm.plan(
        {
          screenshotBase64: ss.pngBase64,
          width: ss.width,
          height: ss.height,
          goal
        },
        []
      );
      const description = plans.find((p) => p.thought)?.thought ?? "";
      return { description, plans };
    }),
    gui_plan: async (args) => policyGuard(SPECS.gui_plan, async () => {
      const goal = args.goal;
      await helper.start();
      const ss = await helper.capture();
      return vlm.plan(
        {
          screenshotBase64: ss.pngBase64,
          width: ss.width,
          height: ss.height,
          goal
        },
        []
      );
    }),
    gui_wait: async (args) => policyGuard(SPECS.gui_wait, async () => {
      const ms = Math.max(0, Math.min(6e4, Number(args.ms) || 0));
      await sleep(ms);
      return { ok: true, ms };
    }),
    gui_scroll: async (args) => {
      const a = args;
      return policyGuard(SPECS.gui_scroll, async () => {
        await helper.start();
        await helper.scroll(a);
        return { ok: true };
      });
    },
    gui_click: async (args) => {
      const a = args;
      return policyGuard(SPECS.gui_click, async () => {
        await helper.start();
        await helper.click({
          x: a.x,
          y: a.y,
          button: a.button ?? "left",
          clicks: a.clicks ?? 1
        });
        return { ok: true };
      });
    },
    gui_key: async (args) => {
      const keys = args.keys;
      return policyGuard(SPECS.gui_key, async () => {
        await helper.start();
        await helper.key(keys);
        return { ok: true };
      });
    },
    gui_type: async (args) => {
      const text = args.text;
      return policyGuard(SPECS.gui_type, async () => {
        await helper.start();
        await helper.type(text);
        return { ok: true };
      });
    },
    gui_drag: async (args) => {
      const a = args;
      return policyGuard(SPECS.gui_drag, async () => {
        await helper.start();
        await helper.drag({ ...a, button: a.button ?? "left" });
        return { ok: true };
      });
    }
  };
}

// src/policy-guard.ts
var GuiPolicyError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "GuiPolicyError";
  }
  code;
};
function safeEmit(sink, event) {
  if (!sink) return;
  try {
    sink(event);
  } catch {
  }
}
function makePolicyGuard(deps, frontmost) {
  return async function guard(spec, run) {
    if (deps.killSwitch.aborted) {
      safeEmit(deps.onActionEvent, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        tool: spec.toolName,
        decision: "block",
        reasonCode: "kill_switch",
        reason: "kill-switch tripped \u2014 GUI actions refused",
        durationMs: 0
      });
      throw new GuiPolicyError("kill_switch", "kill-switch tripped \u2014 GUI actions refused");
    }
    if (!deps.allowlist.allows(spec.toolName)) {
      safeEmit(deps.onActionEvent, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        tool: spec.toolName,
        decision: "block",
        reasonCode: "allowlist",
        reason: `tool ${spec.toolName} is not in the allowlist`,
        durationMs: 0
      });
      throw new GuiPolicyError("allowlist", `tool ${spec.toolName} is not in the allowlist`);
    }
    if (spec.bucket === "input") {
      try {
        deps.inputRateLimit.consume();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        safeEmit(deps.onActionEvent, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "rate_limit",
          reason,
          durationMs: 0
        });
        throw new GuiPolicyError("rate_limit", reason);
      }
    } else if (spec.bucket === "screenshot") {
      try {
        deps.screenshotRateLimit.consume();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        safeEmit(deps.onActionEvent, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "rate_limit",
          reason,
          durationMs: 0
        });
        throw new GuiPolicyError("rate_limit", reason);
      }
    }
    let frontmostBundleId;
    if (spec.requiresFrontmostCheck) {
      frontmostBundleId = await frontmost();
      if (deps.sensitiveApps.isBlocked(frontmostBundleId)) {
        const reason = deps.sensitiveApps.reasonFor(frontmostBundleId) ?? `frontmost app ${frontmostBundleId} is blocked`;
        safeEmit(deps.onActionEvent, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "sensitive_app",
          reason,
          durationMs: 0,
          frontmostBundleId
        });
        throw new GuiPolicyError("sensitive_app", reason);
      }
    }
    const start = Date.now();
    const result = await run();
    safeEmit(deps.onActionEvent, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      tool: spec.toolName,
      decision: "allow",
      durationMs: Date.now() - start,
      frontmostBundleId
    });
    return result;
  };
}

// src/recent-actions.ts
function createRecentActionsBuffer(capacity) {
  if (capacity < 1) {
    throw new Error(`recent-actions buffer capacity must be >= 1 (got ${capacity})`);
  }
  const items = [];
  return {
    push(event) {
      items.push(event);
      if (items.length > capacity) items.shift();
    },
    snapshot() {
      return items.slice();
    },
    clear() {
      items.length = 0;
    }
  };
}

// src/index.ts
var PLUGIN_NAME = "gui";
var RemoteProviderNotPermittedError = class extends Error {
  constructor(provider) {
    super(
      `Remote VLM provider "${provider}" requires safety.remoteProvidersAllowedInZone to be set to a non-empty list (e.g. ["trusted"]). Refusing to load plugin-gui to prevent screenshots from leaving the host.`
    );
    this.name = "RemoteProviderNotPermittedError";
  }
};
function buildVlm(cfg) {
  const providerName = cfg.vlm?.provider ?? "ollama";
  const allowedZones = cfg.safety?.remoteProvidersAllowedInZone ?? [];
  if (providerName !== "ollama" && allowedZones.length === 0) {
    throw new RemoteProviderNotPermittedError(providerName);
  }
  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider({
        model: cfg.vlm?.model ?? "claude-opus-4-7",
        apiKey: cfg.vlm?.apiKey,
        baseUrl: cfg.vlm?.baseUrl
      });
    case "openai":
      return new OpenAIProvider({
        model: cfg.vlm?.model ?? "gpt-4o",
        apiKey: cfg.vlm?.apiKey,
        baseUrl: cfg.vlm?.baseUrl
      });
    case "ollama":
    default:
      return new OllamaProvider({
        model: cfg.vlm?.model ?? "qwen2.5vl:7b",
        host: cfg.vlm?.host ?? "http://127.0.0.1:11434"
      });
  }
}
function createGuiPlugin(config, runtime) {
  if (!config?.enabled) return null;
  const binPath = config.helperBinPath ?? join(homedir(), ".zaraa", "bin", "zaraa-gui-helper");
  const helper = new HelperClient(binPath);
  const vlm = buildVlm(config);
  const allowlist = new GuiAllowlist();
  const inputRateLimit = new RateLimiter({
    windowMs: 6e4,
    maxEvents: config.safety?.actionsPerMinute ?? 60,
    name: "input"
  });
  const screenshotRateLimit = new RateLimiter({
    windowMs: 6e4,
    maxEvents: config.safety?.screenshotsPerMinute ?? 10,
    name: "screenshot"
  });
  const sensitiveApps = new SensitiveAppGuard({ extra: config.safety?.sensitiveApps });
  const killSwitch = new KillSwitch();
  killSwitch.attachHelper(helper);
  let lastReason = null;
  let lastChangedAt = null;
  const safeEmitKs = (event) => {
    if (!runtime?.onKillSwitchEvent) return;
    try {
      runtime.onKillSwitchEvent(event);
    } catch {
    }
  };
  killSwitch.onTrip((reason) => {
    lastReason = reason;
    lastChangedAt = (/* @__PURE__ */ new Date()).toISOString();
    safeEmitKs({ ts: lastChangedAt, state: "tripped", reason });
  });
  killSwitch.onReset((reason) => {
    lastReason = reason;
    lastChangedAt = (/* @__PURE__ */ new Date()).toISOString();
    safeEmitKs({ ts: lastChangedAt, state: "reset", reason });
  });
  const recentActions = createRecentActionsBuffer(10);
  const userOnAction = runtime?.onActionEvent;
  const onActionEvent = (event) => {
    recentActions.push(event);
    if (userOnAction) {
      try {
        userOnAction(event);
      } catch {
      }
    }
  };
  const policyGuard = makePolicyGuard(
    { allowlist, inputRateLimit, screenshotRateLimit, sensitiveApps, killSwitch, onActionEvent },
    () => helper.frontmostApp()
  );
  return {
    manifest: GUI_MANIFEST,
    handlers: createGuiHandlers({ helper, vlm, policyGuard }),
    getRecentActions: () => recentActions.snapshot(),
    getKillSwitchSnapshot: () => ({
      tripped: killSwitch.aborted,
      reason: lastReason,
      changedAt: lastChangedAt
    }),
    resetKillSwitch: (reason) => {
      if (!killSwitch.aborted) return { ok: false, reason: "not_tripped" };
      killSwitch.reset(reason);
      return { ok: true };
    },
    __testHooks: { killSwitch }
  };
}
export {
  GUI_MANIFEST,
  GuiPolicyError,
  PLUGIN_NAME,
  RemoteProviderNotPermittedError,
  createGuiHandlers,
  createGuiPlugin,
  createRecentActionsBuffer,
  makePolicyGuard
};
