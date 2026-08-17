/**
 * StopEscalationManager — escalation ladder for persistent stop-loss failures.
 *
 * When a stop-loss sell keeps failing (exchange errors, insufficient balance,
 * network issues), the system currently just retries. If retries keep failing
 * the position sits unprotected. This manager tracks consecutive failures per
 * position and escalates through three levels:
 *
 *   Level 1 (N failures):   Emergency alert — notify operator immediately
 *   Level 2 (2N failures):  Emergency market sell at any price
 *   Level 3 (3N failures):  Full trading halt via circuit breaker callback
 *
 * Every escalation is logged to TradingEventLog and emitted via the event
 * callback so the push-notification bridge can relay to mobile.
 */

import type { TradingEventLog } from "../engine/event-log.js";

export interface StopEscalationConfig {
  /** Consecutive failures before first escalation (emergency alert). Default: 3 */
  failureThreshold: number;
}

export type EscalationLevel = "none" | "alert" | "emergency_sell" | "trading_halt";

export interface EscalationState {
  positionId: string;
  symbol: string;
  consecutiveFailures: number;
  currentLevel: EscalationLevel;
  lastFailureAt: number;
  lastError: string;
}

export interface EscalationEvent {
  positionId: string;
  symbol: string;
  level: EscalationLevel;
  consecutiveFailures: number;
  threshold: number;
  message: string;
}

export interface StopEscalationDeps {
  /** Event log for recording escalation events */
  eventLog?: TradingEventLog;
  /** Callback for push notification bridge */
  onEscalation?: (event: EscalationEvent) => void;
  /** Attempt emergency market sell — returns true if successful */
  emergencyMarketSell?: (symbol: string, qty: number, positionId: string) => Promise<boolean>;
  /** Trigger full trading halt (e.g., trip circuit breaker) */
  triggerTradingHalt?: (reason: string) => void;
  /** Configuration overrides */
  config?: Partial<StopEscalationConfig>;
}

const DEFAULT_CONFIG: StopEscalationConfig = {
  failureThreshold: 3,
};

export class StopEscalationManager {
  private readonly config: StopEscalationConfig;
  private readonly eventLog?: TradingEventLog;
  private readonly onEscalation?: (event: EscalationEvent) => void;
  private readonly emergencyMarketSell?: (symbol: string, qty: number, positionId: string) => Promise<boolean>;
  private readonly triggerTradingHalt?: (reason: string) => void;

  /** Track consecutive failures per position */
  private failures = new Map<string, EscalationState>();

  constructor(deps: StopEscalationDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.eventLog = deps.eventLog;
    this.onEscalation = deps.onEscalation;
    this.emergencyMarketSell = deps.emergencyMarketSell;
    this.triggerTradingHalt = deps.triggerTradingHalt;
  }

  /** The configured failure threshold (N). Exposed for tests. */
  get failureThreshold(): number {
    return this.config.failureThreshold;
  }

  /**
   * Record a stop-loss failure for a position. Returns the new escalation
   * level and fires side-effects (logging, alerts, emergency sell, halt)
   * when thresholds are crossed.
   */
  async recordFailure(
    positionId: string,
    symbol: string,
    qty: number,
    error: string,
  ): Promise<EscalationLevel> {
    const existing = this.failures.get(positionId);
    const count = (existing?.consecutiveFailures ?? 0) + 1;
    const N = this.config.failureThreshold;

    let level: EscalationLevel = "none";
    if (count >= 3 * N) {
      level = "trading_halt";
    } else if (count >= 2 * N) {
      level = "emergency_sell";
    } else if (count >= N) {
      level = "alert";
    }

    const state: EscalationState = {
      positionId,
      symbol,
      consecutiveFailures: count,
      currentLevel: level,
      lastFailureAt: Date.now(),
      lastError: error,
    };
    this.failures.set(positionId, state);

    // Only escalate when we first cross a threshold boundary
    const prevLevel = existing?.currentLevel ?? "none";
    if (level !== "none" && level !== prevLevel) {
      await this.escalate(level, state, qty);
    }

    return level;
  }

  /**
   * Record a successful stop-loss execution — clears escalation state
   * for the position.
   */
  recordSuccess(positionId: string): void {
    this.failures.delete(positionId);
  }

  /** Get the current escalation state for a position (or null if clean). */
  getState(positionId: string): EscalationState | null {
    return this.failures.get(positionId) ?? null;
  }

  /** Get all positions currently in an escalated state. */
  getAllEscalated(): EscalationState[] {
    return Array.from(this.failures.values()).filter(
      (s) => s.currentLevel !== "none",
    );
  }

  /** Check whether any position has reached trading_halt level. */
  isHalted(): boolean {
    for (const state of this.failures.values()) {
      if (state.currentLevel === "trading_halt") return true;
    }
    return false;
  }

  private async escalate(
    level: EscalationLevel,
    state: EscalationState,
    qty: number,
  ): Promise<void> {
    const N = this.config.failureThreshold;
    let message: string;

    switch (level) {
      case "alert":
        message =
          `EMERGENCY ALERT: Stop-loss for ${state.symbol} (${state.positionId}) ` +
          `failed ${state.consecutiveFailures} consecutive times (threshold: ${N}). ` +
          `Last error: ${state.lastError}`;
        break;
      case "emergency_sell":
        message =
          `EMERGENCY SELL: Attempting market sell for ${state.symbol} (${state.positionId}) ` +
          `after ${state.consecutiveFailures} consecutive failures (threshold: ${2 * N}). ` +
          `Position is unprotected.`;
        break;
      case "trading_halt":
        message =
          `TRADING HALT: Triggering full halt after ${state.consecutiveFailures} ` +
          `consecutive stop-loss failures for ${state.symbol} (${state.positionId}) ` +
          `(threshold: ${3 * N}). System safety compromised.`;
        break;
      default:
        return;
    }

    // Log to TradingEventLog
    this.eventLog?.append("kill_switch_activated", {
      escalationLevel: level,
      positionId: state.positionId,
      symbol: state.symbol,
      consecutiveFailures: state.consecutiveFailures,
      threshold: N,
      lastError: state.lastError,
      message,
    }, { symbol: state.symbol });

    // Emit for push notification bridge
    const event: EscalationEvent = {
      positionId: state.positionId,
      symbol: state.symbol,
      level,
      consecutiveFailures: state.consecutiveFailures,
      threshold: N,
      message,
    };
    this.onEscalation?.(event);

    // Execute level-specific actions
    if (level === "emergency_sell" && this.emergencyMarketSell) {
      try {
        const sold = await this.emergencyMarketSell(state.symbol, qty, state.positionId);
        if (sold) {
          this.recordSuccess(state.positionId);
        }
      } catch (err) {
        console.error(
          `[stop-escalation] Emergency market sell failed for ${state.symbol}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (level === "trading_halt" && this.triggerTradingHalt) {
      this.triggerTradingHalt(message);
    }
  }
}
