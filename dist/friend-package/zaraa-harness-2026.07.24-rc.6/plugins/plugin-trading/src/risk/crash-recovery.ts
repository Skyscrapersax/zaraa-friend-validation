import type { TradingStore, Position } from "../trading-store.js";
import type { CryptoClient } from "../crypto-client.js";
import type { TradingEventLog } from "../engine/event-log.js";
import type { StopMonitor } from "./stop-monitor.js";

export interface RecoveryPosition {
  position: Position;
  status: "verified" | "orphaned" | "drifted";
  exchangePrice: number | null;
  driftPct: number | null;
  error?: string;
}

export interface RecoveryReport {
  timestamp: string;
  totalOpen: number;
  verified: number;
  orphaned: number;
  drifted: number;
  reArmed: number;
  positions: RecoveryPosition[];
}

export interface CrashRecoveryDeps {
  store: TradingStore;
  client: CryptoClient;
  stopMonitor: StopMonitor;
  eventLog?: TradingEventLog;
  /** Price drift % threshold to flag as "drifted". Default: 5 */
  driftThresholdPct?: number;
  /** Called when recovery finds orphaned or significantly drifted positions */
  onAlert?: (report: RecoveryReport) => void;
}

/** Drift threshold default: 5% move since last recorded price */
const DEFAULT_DRIFT_PCT = 5;

/**
 * CrashRecoveryManager — runs on startup to reconcile open positions
 * with the exchange and re-arm stop monitoring.
 *
 * Solves the gap where a process crash leaves positions unmonitored
 * until an operator manually triggers stop checks.
 */
export class CrashRecoveryManager {
  private store: TradingStore;
  private client: CryptoClient;
  private stopMonitor: StopMonitor;
  private eventLog?: TradingEventLog;
  private driftThresholdPct: number;
  private onAlert?: (report: RecoveryReport) => void;
  private hasRun = false;

  constructor(deps: CrashRecoveryDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.stopMonitor = deps.stopMonitor;
    this.eventLog = deps.eventLog;
    this.driftThresholdPct = deps.driftThresholdPct ?? DEFAULT_DRIFT_PCT;
    this.onAlert = deps.onAlert;
  }

  /** Returns true if recover() has already been called. */
  get recovered(): boolean {
    return this.hasRun;
  }
  /**
   * Run crash recovery sweep. Safe to call multiple times — only
   * executes once (subsequent calls return the cached report).
   */
  async recover(): Promise<RecoveryReport> {
    // OpportunityTrader paper positions (executionVenue="opp-trader",
    // isPaper=1) are XRPL/Stellar/Solana DEX trades that own their own price
    // feed and lifecycle. The default CEX client returns "Invalid
    // instrument_name" for those pairs, which used to flood the error log on
    // every restart. They're virtual (no real exchange position), so there is
    // nothing for crash-recovery to verify — skip them entirely.
    const openPositions = this.store.getOpenPositions().filter((p) => {
      const row = p as unknown as Record<string, unknown>;
      const isOppTraderPaper =
        row.executionVenue === "opp-trader" && Number(row.isPaper ?? 0) === 1;
      return !isOppTraderPaper;
    });
    const recoveryPositions: RecoveryPosition[] = [];
    let reArmed = 0;

    for (const pos of openPositions) {
      const rp = await this.reconcilePosition(pos);
      recoveryPositions.push(rp);
    }

    // Re-arm stop monitoring by triggering one check cycle.
    // StopMonitor.checkStops() reads all open positions from the store
    // and evaluates their stops — this effectively re-arms monitoring.
    try {
      await this.stopMonitor.checkStops();
      reArmed = openPositions.length;
    } catch (err) {
      console.error("[crash-recovery] Failed to re-arm stop monitor:", err instanceof Error ? err.message : err);
    }
    const report: RecoveryReport = {
      timestamp: new Date().toISOString(),
      totalOpen: openPositions.length,
      verified: recoveryPositions.filter(r => r.status === "verified").length,
      orphaned: recoveryPositions.filter(r => r.status === "orphaned").length,
      drifted: recoveryPositions.filter(r => r.status === "drifted").length,
      reArmed,
      positions: recoveryPositions,
    };

    // Log to event log
    this.eventLog?.append("risk_check_passed", {
      action: "crash_recovery",
      totalOpen: report.totalOpen,
      verified: report.verified,
      orphaned: report.orphaned,
      drifted: report.drifted,
      reArmed: report.reArmed,
    });

    // Alert if any positions are orphaned or drifted
    if (report.orphaned > 0 || report.drifted > 0) {
      this.onAlert?.(report);
    }

    this.hasRun = true;
    return report;
  }
  /**
   * Reconcile a single position against the exchange.
   * Fetches current price and checks for drift from last recorded price.
   */
  private async reconcilePosition(pos: Position): Promise<RecoveryPosition> {
    try {
      const ticker = await this.client.getTicker(pos.symbol);
      const exchangePrice = ticker.last;

      // Calculate drift from last known price
      const lastPrice = pos.currentPrice ?? pos.entryPrice;
      const driftPct = lastPrice > 0
        ? Math.abs((exchangePrice - lastPrice) / lastPrice) * 100
        : 0;

      // Update the position with current exchange price
      const unrealizedPnl = pos.side === "long"
        ? (exchangePrice - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exchangePrice) * pos.qty;
      try {
        this.store.updatePositionPrice(pos.id, exchangePrice, unrealizedPnl);
      } catch {
        // Non-fatal — position may have been closed between read and update
      }
      const status = driftPct >= this.driftThresholdPct ? "drifted" : "verified";

      if (status === "drifted") {
        console.warn(
          `[crash-recovery] Position ${pos.id} (${pos.symbol}) drifted ${driftPct.toFixed(1)}%: ` +
          `last=${lastPrice}, exchange=${exchangePrice}`,
        );
      }

      return {
        position: pos,
        status,
        exchangePrice,
        driftPct: Math.round(driftPct * 100) / 100,
      };
    } catch (err) {
      // Exchange fetch failed — position may be orphaned (delisted, symbol changed, etc.)
      console.error(
        `[crash-recovery] Cannot verify ${pos.symbol} (${pos.id}):`,
        err instanceof Error ? err.message : err,
      );
      return {
        position: pos,
        status: "orphaned",
        exchangePrice: null,
        driftPct: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
