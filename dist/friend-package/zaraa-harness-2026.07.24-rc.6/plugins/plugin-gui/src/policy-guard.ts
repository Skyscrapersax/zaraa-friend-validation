import type {
  GuiAllowlist,
  KillSwitch,
  RateLimiter,
  SensitiveAppGuard,
} from "@zaraa/gui";

/**
 * Reasons a GUI handler can be refused before its body runs.
 */
export type GuiPolicyErrorCode =
  | "kill_switch"
  | "allowlist"
  | "rate_limit"
  | "sensitive_app";

export class GuiPolicyError extends Error {
  constructor(public readonly code: GuiPolicyErrorCode, message: string) {
    super(message);
    this.name = "GuiPolicyError";
  }
}

/**
 * Live-action telemetry emitted once per guarded call (allow OR block).
 * Consumed by the dashboard via the gui.action SSE channel and by the
 * plugin's in-memory recent-actions ring buffer.
 */
export type GuiActionDecision = "allow" | "block";

export type GuiActionEvent = {
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
export type GuiKillSwitchState = "tripped" | "reset";

export type GuiKillSwitchEvent = {
  /** ISO 8601 wall-clock of the state change. */
  ts: string;
  /** New state after the change. */
  state: GuiKillSwitchState;
  /** Free-form reason: "hotkey:kill", "policy_abuse", "operator_reset", etc. */
  reason: string;
};

export type PolicyDeps = {
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

export type GuardSpec = {
  toolName: string;
  bucket: "input" | "screenshot" | "none";
  requiresFrontmostCheck: boolean;
};

export type FrontmostFn = () => Promise<string | undefined>;

export type PolicyGuard = <T>(spec: GuardSpec, run: () => Promise<T>) => Promise<T>;

function safeEmit(
  sink: ((event: GuiActionEvent) => void) | undefined,
  event: GuiActionEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // emission is observability-only; never let it break the guard
  }
}

/**
 * Build a guard composer that every plugin-gui handler runs through. Each
 * call applies the four checks in order: kill-switch latch, allowlist,
 * rate-limit (when bucket != "none"), and sensitive-app deny list.
 */
export function makePolicyGuard(deps: PolicyDeps, frontmost: FrontmostFn): PolicyGuard {
  return async function guard<T>(spec: GuardSpec, run: () => Promise<T>): Promise<T> {
    if (deps.killSwitch.aborted) {
      safeEmit(deps.onActionEvent, {
        ts: new Date().toISOString(),
        tool: spec.toolName,
        decision: "block",
        reasonCode: "kill_switch",
        reason: "kill-switch tripped — GUI actions refused",
        durationMs: 0,
      });
      throw new GuiPolicyError("kill_switch", "kill-switch tripped — GUI actions refused");
    }

    if (!deps.allowlist.allows(spec.toolName)) {
      safeEmit(deps.onActionEvent, {
        ts: new Date().toISOString(),
        tool: spec.toolName,
        decision: "block",
        reasonCode: "allowlist",
        reason: `tool ${spec.toolName} is not in the allowlist`,
        durationMs: 0,
      });
      throw new GuiPolicyError("allowlist", `tool ${spec.toolName} is not in the allowlist`);
    }

    if (spec.bucket === "input") {
      try {
        deps.inputRateLimit.consume();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        safeEmit(deps.onActionEvent, {
          ts: new Date().toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "rate_limit",
          reason,
          durationMs: 0,
        });
        throw new GuiPolicyError("rate_limit", reason);
      }
    } else if (spec.bucket === "screenshot") {
      try {
        deps.screenshotRateLimit.consume();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        safeEmit(deps.onActionEvent, {
          ts: new Date().toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "rate_limit",
          reason,
          durationMs: 0,
        });
        throw new GuiPolicyError("rate_limit", reason);
      }
    }

    let frontmostBundleId: string | undefined;
    if (spec.requiresFrontmostCheck) {
      frontmostBundleId = await frontmost();
      if (deps.sensitiveApps.isBlocked(frontmostBundleId)) {
        const reason = deps.sensitiveApps.reasonFor(frontmostBundleId)
          ?? `frontmost app ${frontmostBundleId} is blocked`;
        safeEmit(deps.onActionEvent, {
          ts: new Date().toISOString(),
          tool: spec.toolName,
          decision: "block",
          reasonCode: "sensitive_app",
          reason,
          durationMs: 0,
          frontmostBundleId,
        });
        throw new GuiPolicyError("sensitive_app", reason);
      }
    }

    const start = Date.now();
    const result = await run();
    safeEmit(deps.onActionEvent, {
      ts: new Date().toISOString(),
      tool: spec.toolName,
      decision: "allow",
      durationMs: Date.now() - start,
      frontmostBundleId,
    });
    return result;
  };
}
