import { homedir } from "node:os";
import { join } from "node:path";
import {
  HelperClient,
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GuiAllowlist,
  RateLimiter,
  SensitiveAppGuard,
  KillSwitch,
  type VlmProvider,
} from "@zaraa/gui";
import { GUI_MANIFEST } from "./manifest.js";
import { createGuiHandlers } from "./handlers.js";
import { makePolicyGuard } from "./policy-guard.js";
import type { GuiActionEvent, GuiKillSwitchEvent } from "./policy-guard.js";
import { createRecentActionsBuffer } from "./recent-actions.js";

export const PLUGIN_NAME = "gui";

export type GuiPluginSafetyConfig = {
  actionsPerMinute?: number;
  screenshotsPerMinute?: number;
  sensitiveApps?: string[];
  remoteProvidersAllowedInZone?: ("trusted" | "guarded" | "sandbox")[];
};

export type GuiPluginConfig = {
  enabled?: boolean;
  helperBinPath?: string;
  vlm?: {
    provider?: "ollama" | "anthropic" | "openai";
    model?: string;
    host?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  safety?: GuiPluginSafetyConfig;
};

/**
 * Runtime callbacks. These can't live on `GuiPluginConfig` because that
 * type is the serialized shape persisted in `~/.zaraa/zaraa.config.json`.
 */
export type GuiPluginRuntime = {
  /**
   * Called once per guarded gui_* call (allow OR block). Forwarded to the
   * plugin's policy guard. Implementations MUST NOT throw — the guard
   * wraps invocations to swallow errors.
   */
  onActionEvent?: (event: GuiActionEvent) => void;

  /**
   * Called once per kill-switch state change (trip OR reset). Errors are
   * caught locally — subscriber bugs cannot break the policy guard.
   */
  onKillSwitchEvent?: (event: GuiKillSwitchEvent) => void;
};

export class RemoteProviderNotPermittedError extends Error {
  constructor(provider: string) {
    super(
      `Remote VLM provider "${provider}" requires safety.remoteProvidersAllowedInZone to be set ` +
        `to a non-empty list (e.g. ["trusted"]). Refusing to load plugin-gui to prevent ` +
        `screenshots from leaving the host.`,
    );
    this.name = "RemoteProviderNotPermittedError";
  }
}

function buildVlm(cfg: GuiPluginConfig): VlmProvider {
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
        baseUrl: cfg.vlm?.baseUrl,
      });
    case "openai":
      return new OpenAIProvider({
        model: cfg.vlm?.model ?? "gpt-4o",
        apiKey: cfg.vlm?.apiKey,
        baseUrl: cfg.vlm?.baseUrl,
      });
    case "ollama":
    default:
      return new OllamaProvider({
        model: cfg.vlm?.model ?? "qwen2.5vl:7b",
        host: cfg.vlm?.host ?? "http://127.0.0.1:11434",
      });
  }
}

export type GuiKillSwitchSnapshot = {
  tripped: boolean;
  /** Reason from the most recent state change; null if never tripped. */
  reason: string | null;
  /** ISO ts of the most recent state change; null if never tripped. */
  changedAt: string | null;
};

export type GuiPluginInstance = {
  manifest: typeof GUI_MANIFEST;
  handlers: ReturnType<typeof createGuiHandlers>;
  /**
   * Snapshot of the last 10 GuiActionEvents, oldest first.
   * Used by the core gateway to populate /api/gui/status.recentActions.
   */
  getRecentActions: () => GuiActionEvent[];
  /** Current snapshot of the kill-switch state. */
  getKillSwitchSnapshot: () => GuiKillSwitchSnapshot;
  /**
   * Reset the kill-switch. Returns `{ ok: false, reason: "not_tripped" }`
   * if the switch was already armed. Emits a `GuiKillSwitchEvent` via
   * `runtime.onKillSwitchEvent` on success.
   */
  resetKillSwitch: (reason: string) => { ok: true } | { ok: false; reason: "not_tripped" };
  /** Test-only handle to the internal KillSwitch. NOT for production use. */
  __testHooks: { killSwitch: import("@zaraa/gui").KillSwitch };
};

export function createGuiPlugin(
  config: GuiPluginConfig | undefined,
  runtime?: GuiPluginRuntime,
): GuiPluginInstance | null {
  if (!config?.enabled) return null;

  const binPath = config.helperBinPath ?? join(homedir(), ".zaraa", "bin", "zaraa-gui-helper");
  const helper = new HelperClient(binPath);

  const vlm: VlmProvider = buildVlm(config);

  const allowlist = new GuiAllowlist();
  const inputRateLimit = new RateLimiter({
    windowMs: 60_000,
    maxEvents: config.safety?.actionsPerMinute ?? 60,
    name: "input",
  });
  const screenshotRateLimit = new RateLimiter({
    windowMs: 60_000,
    maxEvents: config.safety?.screenshotsPerMinute ?? 10,
    name: "screenshot",
  });
  const sensitiveApps = new SensitiveAppGuard({ extra: config.safety?.sensitiveApps });
  const killSwitch = new KillSwitch();
  killSwitch.attachHelper(helper);

  // Bridge KillSwitch state changes to the runtime callback and snapshot
  // fields. lastReason/lastChangedAt are captured on every transition so
  // HTTP callers can read state without holding a KillSwitch reference.
  let lastReason: string | null = null;
  let lastChangedAt: string | null = null;

  const safeEmitKs = (event: GuiKillSwitchEvent) => {
    if (!runtime?.onKillSwitchEvent) return;
    try { runtime.onKillSwitchEvent(event); } catch { /* sink subscriber errors */ }
  };

  killSwitch.onTrip((reason) => {
    lastReason = reason;
    lastChangedAt = new Date().toISOString();
    safeEmitKs({ ts: lastChangedAt, state: "tripped", reason });
  });

  killSwitch.onReset((reason) => {
    lastReason = reason;
    lastChangedAt = new Date().toISOString();
    safeEmitKs({ ts: lastChangedAt, state: "reset", reason });
  });

  // NEW: in-memory ring of last 10 events. Wrap the user's onActionEvent
  // so the buffer also captures every event before forwarding.
  const recentActions = createRecentActionsBuffer(10);
  const userOnAction = runtime?.onActionEvent;
  const onActionEvent = (event: GuiActionEvent) => {
    recentActions.push(event);
    if (userOnAction) {
      try { userOnAction(event); } catch { /* sink errors from external bus */ }
    }
  };

  const policyGuard = makePolicyGuard(
    { allowlist, inputRateLimit, screenshotRateLimit, sensitiveApps, killSwitch, onActionEvent },
    () => helper.frontmostApp(),
  );

  return {
    manifest: GUI_MANIFEST,
    handlers: createGuiHandlers({ helper, vlm, policyGuard }),
    getRecentActions: () => recentActions.snapshot(),
    getKillSwitchSnapshot: () => ({
      tripped: killSwitch.aborted,
      reason: lastReason,
      changedAt: lastChangedAt,
    }),
    resetKillSwitch: (reason: string) => {
      if (!killSwitch.aborted) return { ok: false, reason: "not_tripped" as const };
      killSwitch.reset(reason);
      return { ok: true as const };
    },
    __testHooks: { killSwitch },
  };
}

export { GUI_MANIFEST } from "./manifest.js";
export { createGuiHandlers, type GuiHandlerDeps } from "./handlers.js";
export {
  makePolicyGuard,
  GuiPolicyError,
  type GuardSpec,
  type PolicyDeps,
  type PolicyGuard,
  type GuiActionEvent,
  type GuiActionDecision,
  type GuiKillSwitchEvent,
  type GuiKillSwitchState,
} from "./policy-guard.js";
export type { RecentActionsBuffer } from "./recent-actions.js";
export { createRecentActionsBuffer } from "./recent-actions.js";
