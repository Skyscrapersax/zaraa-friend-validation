import type { StopMonitor, StopEvent } from "./stop-monitor.js";

export interface StopSchedulerDeps {
  stopMonitor: StopMonitor;
  /** Interval in ms between stop checks. Default: 10_000 (live) or 60_000 (paper) */
  intervalMs?: number;
  /** If true, use the longer paper interval (60s). Default: false (10s live interval) */
  isPaper?: boolean;
  /** Called when stops trigger during a scheduled check */
  onStopTriggered?: (events: StopEvent[]) => void;
  /** Called when a check cycle errors (log + continue) */
  onError?: (error: Error) => void;
  /**
   * Fired after every successful tick (regardless of whether stops triggered). Defense-in-depth
   * heartbeat hook: lets the in-process loop check in `trading:stop-monitor` independently of
   * the cron-driven `trade_check_stops` path, so a hung scheduler entry can't silence us.
   */
  onTick?: () => void;
}

const LIVE_INTERVAL_MS = 10_000;
const PAPER_INTERVAL_MS = 60_000;
/**
 * StopScheduler — runs StopMonitor.checkStops() on a configurable timer.
 *
 * For live trading, stops MUST be checked automatically. This scheduler
 * ensures stop-loss/take-profit/trailing-stop monitoring runs continuously
 * without requiring manual `trade_check_stops` calls.
 *
 * Error handling: log + continue. A single failed check must not crash
 * the monitoring loop — the next cycle will retry.
 */
export class StopScheduler {
  private stopMonitor: StopMonitor;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onStopTriggered?: (events: StopEvent[]) => void;
  private onError?: (error: Error) => void;
  private onTick?: () => void;
  private _isRunning = false;
  private _checkCount = 0;
  private _errorCount = 0;
  private _lastTriggeredEvents: StopEvent[] = [];

  constructor(deps: StopSchedulerDeps) {
    this.stopMonitor = deps.stopMonitor;
    this.onStopTriggered = deps.onStopTriggered;
    this.onError = deps.onError;
    this.onTick = deps.onTick;
    if (deps.intervalMs != null) {
      this.intervalMs = deps.intervalMs;
    } else {
      this.intervalMs = deps.isPaper ? PAPER_INTERVAL_MS : LIVE_INTERVAL_MS;
    }
  }

  /** Start the scheduled stop check loop. No-op if already running. */
  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /** Stop the scheduled loop. Safe to call multiple times. */
  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._isRunning = false;
  }

  /** Whether the scheduler is currently running. */
  get isRunning(): boolean {
    return this._isRunning;
  }
  /** Total number of completed check cycles. */
  get checkCount(): number {
    return this._checkCount;
  }

  /** Total number of errored check cycles. */
  get errorCount(): number {
    return this._errorCount;
  }

  /** Events from the most recent check that triggered stops. */
  get lastTriggeredEvents(): StopEvent[] {
    return this._lastTriggeredEvents;
  }

  /** The configured check interval in milliseconds. */
  get interval(): number {
    return this.intervalMs;
  }

  /**
   * Execute a single check cycle. Called by the timer, but also
   * available for manual invocation (e.g., in tests or one-off checks).
   */
  async tick(): Promise<StopEvent[]> {
    try {
      const events = await this.stopMonitor.checkStops();
      this._checkCount++;
      if (events.length > 0) {
        this._lastTriggeredEvents = events;
        this.onStopTriggered?.(events);
      }
      // Fire tick hook AFTER a successful check so the heartbeat reflects real
      // monitoring activity, not just timer firing. Wrap in try/catch so a buggy
      // hook can't break the monitor loop.
      try {
        this.onTick?.();
      } catch (hookErr) {
        const hookError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
        console.error("[stop-scheduler] onTick hook failed:", hookError.message);
      }
      return events;
    } catch (err) {
      this._errorCount++;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[stop-scheduler] Check cycle failed:", error.message);
      this.onError?.(error);
      return [];
    }
  }
}
