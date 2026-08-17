import * as _zaraa_gui from '@zaraa/gui';
import { GuiAllowlist, RateLimiter, SensitiveAppGuard, KillSwitch, HelperClient, VlmProvider } from '@zaraa/gui';
import { PluginManifest } from '@zaraa/shared';

declare const GUI_MANIFEST: PluginManifest;

/**
 * Reasons a GUI handler can be refused before its body runs.
 */
type GuiPolicyErrorCode = "kill_switch" | "allowlist" | "rate_limit" | "sensitive_app";
declare class GuiPolicyError extends Error {
    readonly code: GuiPolicyErrorCode;
    constructor(code: GuiPolicyErrorCode, message: string);
}
/**
 * Live-action telemetry emitted once per guarded call (allow OR block).
 * Consumed by the dashboard via the gui.action SSE channel and by the
 * plugin's in-memory recent-actions ring buffer.
 */
type GuiActionDecision = "allow" | "block";
type GuiActionEvent = {
    /** ISO 8601 timestamp captured at completion (allow) or at refusal (block). */
    ts: string;
    /** Tool name, e.g. "gui_screenshot", "gui_click". */
    tool: string;
    /** Whether the policy guard let the call through. */
    decision: GuiActionDecision;
    /** Reason code when blocked. Mirrors GuiPolicyErrorCode. Undefined when decision === "allow". */
    reasonCode?: GuiPolicyErrorCode;
    /** Human-readable reason. Undefined when decision === "allow". */
    reason?: string;
    /** Wall-clock duration of the guarded call in ms. 0 if blocked before invocation. */
    durationMs: number;
    /** Frontmost app bundle id, when sensitive-app check ran. Undefined otherwise. */
    frontmostBundleId?: string;
};
/**
 * Discrete state transitions of the GUI kill-switch. Emitted exactly once
 * per state change — trip and reset both fire one event.
 */
type GuiKillSwitchState = "tripped" | "reset";
type GuiKillSwitchEvent = {
    /** ISO 8601 wall-clock of the state change. */
    ts: string;
    /** New state after the change. */
    state: GuiKillSwitchState;
    /** Free-form reason: "hotkey:kill", "policy_abuse", "operator_reset", etc. */
    reason: string;
};
type PolicyDeps = {
    allowlist: Pick<GuiAllowlist, "allows">;
    inputRateLimit: Pick<RateLimiter, "consume">;
    screenshotRateLimit: Pick<RateLimiter, "consume">;
    sensitiveApps: Pick<SensitiveAppGuard, "isBlocked" | "reasonFor">;
    killSwitch: Pick<KillSwitch, "aborted">;
    /**
     * Optional sink for live action telemetry. Called once per guarded call,
     * for both allow and block paths. Implementations MUST NOT throw — the
     * guard wraps invocations to swallow errors so emission cannot break the
     * call path.
     */
    onActionEvent?: (event: GuiActionEvent) => void;
};
type GuardSpec = {
    toolName: string;
    bucket: "input" | "screenshot" | "none";
    requiresFrontmostCheck: boolean;
};
type FrontmostFn = () => Promise<string | undefined>;
type PolicyGuard = <T>(spec: GuardSpec, run: () => Promise<T>) => Promise<T>;
/**
 * Build a guard composer that every plugin-gui handler runs through. Each
 * call applies the four checks in order: kill-switch latch, allowlist,
 * rate-limit (when bucket != "none"), and sensitive-app deny list.
 */
declare function makePolicyGuard(deps: PolicyDeps, frontmost: FrontmostFn): PolicyGuard;

type GuiHandlerDeps = {
    helper: Pick<HelperClient, "start" | "stop" | "capture" | "click" | "key" | "type" | "drag" | "scroll" | "frontmostApp" | "onHotkey">;
    vlm: Pick<VlmProvider, "name" | "isLocal" | "plan">;
    policyGuard: PolicyGuard;
};
type Handler = (args: Record<string, unknown>, context?: unknown) => Promise<unknown>;
declare function createGuiHandlers(deps: GuiHandlerDeps): Record<string, Handler>;

interface RecentActionsBuffer {
    push(event: GuiActionEvent): void;
    snapshot(): GuiActionEvent[];
    clear(): void;
}
/**
 * Bounded FIFO of the most recent N GUI action events. Oldest events are
 * dropped when capacity is exceeded. `snapshot()` returns a defensive copy
 * — callers are free to mutate it.
 */
declare function createRecentActionsBuffer(capacity: number): RecentActionsBuffer;

declare const PLUGIN_NAME = "gui";
type GuiPluginSafetyConfig = {
    actionsPerMinute?: number;
    screenshotsPerMinute?: number;
    sensitiveApps?: string[];
    remoteProvidersAllowedInZone?: ("trusted" | "guarded" | "sandbox")[];
};
type GuiPluginConfig = {
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
type GuiPluginRuntime = {
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
declare class RemoteProviderNotPermittedError extends Error {
    constructor(provider: string);
}
type GuiKillSwitchSnapshot = {
    tripped: boolean;
    /** Reason from the most recent state change; null if never tripped. */
    reason: string | null;
    /** ISO ts of the most recent state change; null if never tripped. */
    changedAt: string | null;
};
type GuiPluginInstance = {
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
    resetKillSwitch: (reason: string) => {
        ok: true;
    } | {
        ok: false;
        reason: "not_tripped";
    };
    /** Test-only handle to the internal KillSwitch. NOT for production use. */
    __testHooks: {
        killSwitch: _zaraa_gui.KillSwitch;
    };
};
declare function createGuiPlugin(config: GuiPluginConfig | undefined, runtime?: GuiPluginRuntime): GuiPluginInstance | null;

export { GUI_MANIFEST, type GuardSpec, type GuiActionDecision, type GuiActionEvent, type GuiHandlerDeps, type GuiKillSwitchEvent, type GuiKillSwitchSnapshot, type GuiKillSwitchState, type GuiPluginConfig, type GuiPluginInstance, type GuiPluginRuntime, type GuiPluginSafetyConfig, GuiPolicyError, PLUGIN_NAME, type PolicyDeps, type PolicyGuard, type RecentActionsBuffer, RemoteProviderNotPermittedError, createGuiHandlers, createGuiPlugin, createRecentActionsBuffer, makePolicyGuard };
