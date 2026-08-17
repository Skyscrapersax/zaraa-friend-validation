/**
 * ShadowModeExecutor — bridge between paper and live trading.
 *
 * Runs live signals through the full pre-trade validation pipeline but
 * intercepts before actual exchange calls. Logs what WOULD have happened,
 * tracks shadow P&L over time, and validates that all pre-trade checks
 * pass exactly as they would in live mode.
 *
 * Use case: prove the system works with real market data before risking
 * real money. Compare shadow P&L against paper results to measure
 * readiness for live deployment.
 */

/**
 * Per-strategy closed-trade stats embedded in a P&L snapshot, keyed by strategy
 * name. Structurally compatible with TradeJournal.PerStrategyStat — kept defined
 * here so this engine stays dependency-free of the journal/DB layer.
 */
/**
 * Canonical cap for the rolling P&L snapshot window — 48 entries ≈ 24h at the
 * 30-min snapshot cadence. Single source of truth shared by the in-memory ring
 * (recordPnlSnapshot) and the trading.db `shadow_pnl_snapshots` settings blob
 * persisted in core (zaraa.ts onPnlSnapshot), so the two never drift.
 */
export const SHADOW_PNL_SNAPSHOT_CAP = 48;

export interface ShadowStrategyStat {
  trades: number;
  pnl: number;
  winRate: number;
  /** Chronic loser flagged for potential disable (>=20 trades, winRate<0.35, pnl<-$1). */
  flagged: boolean;
}

export interface ShadowPnlSnapshot {
  ts: number;
  trades: number;
  openPositions: number;
  totalPnl: number;
  unrealizedPnl: number;
  totalEquity: number;
  winRate: number;
  /**
   * Per-strategy breakdown of closed trades, keyed by strategy name. Lets us
   * see which strategies win/lose without querying the journal. Optional —
   * absent when no strategyStatsProvider is wired (and on snapshots recorded
   * before this field existed).
   */
  strategies?: Record<string, ShadowStrategyStat>;
}

export interface ShadowTradeParams {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  strategy: string;
  /**
   * Signal confidence in [0,1] — used to scale position size via
   * confidence tiers (see ShadowModeExecutorOpts.confidenceTiers) and logged
   * in the ENTRY line for diagnostics.
   */
  confidence?: number;
  /**
   * Per-trade trailing-stop distance in percent (e.g. 1.5 = 1.5%).
   * Overrides the executor's defaultTrailingStopPercent for this position.
   * Omit (or set 0) to disable trailing for this trade.
   */
  trailingStopPercent?: number;
}

/**
 * Confidence-based position-sizing tier. Each tier specifies a minimum
 * confidence (inclusive) and the fraction of the requested position size to
 * use when the signal's confidence falls into that tier.
 *
 * Tiers are evaluated highest minConfidence first; the first match wins.
 */
export interface ConfidenceSizingTier {
  /** Inclusive lower bound for the tier (0..1) */
  minConfidence: number;
  /** Multiplier applied to position size — clamped to [0,1] */
  sizePct: number;
}

/**
 * Default confidence tiers per the sizing spec:
 *   < 0.5             → skipped upstream by the confidence threshold filter
 *   0.5 <= c < 0.6   → 50% of max position size
 *   0.6 <= c < 0.7   → 75% of max position size
 *   0.7 <= c          → 100% of max position size
 */
export const DEFAULT_CONFIDENCE_TIERS: ConfidenceSizingTier[] = [
  { minConfidence: 0.7, sizePct: 1.0 },
  { minConfidence: 0.6, sizePct: 0.75 },
  { minConfidence: 0.5, sizePct: 0.5 },
];

export interface ShadowTradeResult {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  strategy: string;
  estimatedFees: number;
  timestamp: number;
  preTradeChecksPassed: boolean;
  preTradeRejection?: string;
}

export interface ShadowPerformance {
  trades: number;
  winRate: number;
  totalPnl: number;
  unrealizedPnl: number;
  totalEquity: number;
  openPositionCount: number;
  avgSlippage: number;
}

/** Aggregated closed-trade stats for one attribution key (strategy or symbol). */
export interface ShadowAttributionStat {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
}

/**
 * P&L attribution across closed shadow positions — answers "which
 * strategies/symbols make or lose money" without the journal/DB layer.
 */
export interface ShadowAttribution {
  byStrategy: Record<string, ShadowAttributionStat>;
  bySymbol: Record<string, ShadowAttributionStat>;
}

/** Reason a shadow position closed — lines up with strategy_trades.exitReason. */
export type ShadowExitReason = "stop_loss" | "take_profit" | "manual" | "time_expiry";

export interface ShadowPosition {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  strategy: string;
  enteredAt: number;
  exitPrice?: number;
  exitedAt?: number;
  pnl?: number;
  exitReason?: ShadowExitReason;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Trailing-stop distance in percent (e.g. 1.5 = 1.5%). When set and the price
   * moves favorably, `updatePrice` ratchets `stopLoss` tighter — never backward.
   * Undefined or 0 keeps the legacy fixed SL/TP behavior.
   */
  trailingStopPercent?: number;
  /** Signal confidence at entry (0..1) — persisted for later analysis */
  confidence?: number;
  /** Multiplier applied from the confidence tier (0..1) */
  sizingMultiplier?: number;
  /** USD notional after confidence scaling and maxTradeUsd cap */
  notionalUsd?: number;
}

/** Pre-trade check function — mirrors real validation pipeline */
export type PreTradeCheckFn = (params: ShadowTradeParams) => {
  passed: boolean;
  reason?: string;
};

/** Default fee rate in basis points (10 bps = 0.1%) */
const DEFAULT_FEE_BPS = 10;

export interface ShadowModeExecutorOpts {
  /** Fee rate in basis points for cost estimation. Default: 10 */
  feeBps?: number;
  /**
   * Confidence-based sizing tiers. Higher-confidence signals get a larger
   * fraction of the requested position size. Order does not matter — tiers
   * are sorted by minConfidence descending internally and the first match
   * wins. Defaults to DEFAULT_CONFIDENCE_TIERS.
   */
  confidenceTiers?: ConfidenceSizingTier[];
  /**
   * Hard cap on USD notional per shadow trade. The scaled (qty * price)
   * notional is clamped via Math.min so it can NEVER exceed this regardless
   * of confidence. When omitted, no notional cap is enforced (raw qty used).
   */
  maxTradeUsd?: number;
  /** Pre-trade validation function (mirrors live checks) */
  preTradeCheck?: PreTradeCheckFn;
  /** Optional logger for shadow executions */
  onShadowTrade?: (result: ShadowTradeResult) => void;
  /** Called each time a P&L snapshot is recorded (every 30 min) — use to persist to DB */
  onPnlSnapshot?: (snapshot: ShadowPnlSnapshot) => void;
  /**
   * Supplies the per-strategy closed-trade breakdown embedded into each P&L
   * snapshot. Called once per `recordPnlSnapshot()`. Wire to
   * `TradeJournal.getPerStrategyStats()`. Omit to leave snapshots without a
   * per-strategy breakdown. Throwing here is non-fatal — the snapshot is still
   * recorded, just without the `strategies` field.
   */
  strategyStatsProvider?: () => Record<string, ShadowStrategyStat>;
  /**
   * Predicate returning true when `strategy` has been disabled by the operator
   * via config (`trading.disabledStrategies`). When wired, executeShadow
   * REJECTS any entry for a disabled strategy before opening a position. Wire to
   * `StrategyRegistry.isDisabled`. This closes the gap where the shadow entry
   * paths (handler + execution-manager) call executeShadow directly and bypass
   * the SignalEngine's `getActive()` filter — the cause of mean-reversion
   * accumulating 93 shadow trades while listed in `disabledStrategies`. Omit to
   * leave shadow entries unfiltered (backward-compatible). Throwing here is
   * non-fatal — the entry is allowed (FAIL-OPEN), mirroring strategyStatsProvider.
   */
  disabledStrategyProvider?: (strategy: string) => boolean;
  /**
   * Called whenever the open-positions list mutates: open, SL/TP set, close.
   * Use to persist `getOpenPositions()` to durable storage so the list survives
   * daemon restarts and closed positions don't resurrect.
   */
  onOpenPositionsChange?: (openPositions: ShadowPosition[]) => void;
  /**
   * Called once per closed shadow position, with the fully populated
   * ShadowPosition (exitPrice, exitedAt, pnl, exitReason set). Use this to
   * persist exits into strategy_trades so the row's exitedAt + pnl + exitReason
   * fields get filled in — without this hook, shadow exits live only in the
   * in-memory closedPositions array.
   */
  onPositionClose?: (closed: ShadowPosition) => void;
  /** Restore open positions from a previous session (loaded from persistent storage on restart) */
  initialPositions?: ShadowPosition[];
  /**
   * Cumulative baseline (closed trades + realized P&L) from `strategy_trades`
   * captured at construction. Folded into `getShadowPerformance()` so the
   * lifetime totals survive daemon restarts instead of resetting to whatever
   * closes happened since boot. Source: `TradeJournal.getCumulativeStats()`.
   */
  initialCumulative?: { trades: number; wins?: number; totalPnl: number };
  /**
   * Default trailing-stop distance (percent) applied to new shadow positions
   * when `ShadowTradeParams.trailingStopPercent` is not provided. Omit to keep
   * legacy fixed SL/TP behavior. Recommended: 1.5 (tighter than the 2% fixed SL).
   */
  defaultTrailingStopPercent?: number;
  /**
   * Hard cap on concurrent open shadow positions per symbol. When the cap is
   * reached, `executeShadow` rejects the trade with a `perSymbolCap` reason
   * instead of opening another position. Default: 2.
   *
   * Defense-in-depth: the SignalEngine already enforces the per-asset cap
   * upstream, but this executor-level guard prevents the lower-level path
   * (e.g. tests, future callers, missed code paths) from stacking unlimited
   * positions on a single symbol — which is what produced the 97-position
   * pile-up that caused the 48h shadow soak failure.
   */
  maxPositionsPerSymbol?: number;
}

/**
 * Names to check against the operator's disable list for a given entry.
 * The SignalEngine wraps multi-strategy agreement as `ensemble(a+b)`
 * (signal-engine.ts) while `trading.disabledStrategies` holds bare names, so
 * an ensemble entry must be checked under the full name AND each member.
 * Non-ensemble names pass through unchanged.
 */
function expandStrategyNames(strategy: string): string[] {
  const match = /^ensemble\((.+)\)$/.exec(strategy);
  if (!match) return [strategy];
  const members = match[1]
    .split(/[+,]/)
    .map((name) => name.trim())
    .filter(Boolean);
  return [strategy, ...members];
}

export class ShadowModeExecutor {
  private positions: ShadowPosition[] = [];
  private closedPositions: ShadowPosition[] = [];
  /** FIFO cap on retained closed positions. Shadow mode runs for months; without
   *  a bound this array grows unbounded (memory leak). Reports cover the most recent N. */
  private static readonly MAX_CLOSED_POSITIONS = 10_000;
  private feeBps: number;
  private confidenceTiers: ConfidenceSizingTier[];
  private maxTradeUsd?: number;
  private preTradeCheck?: PreTradeCheckFn;
  private onShadowTrade?: (result: ShadowTradeResult) => void;
  private onPnlSnapshot?: (snapshot: ShadowPnlSnapshot) => void;
  private strategyStatsProvider?: () => Record<string, ShadowStrategyStat>;
  private disabledStrategyProvider?: (strategy: string) => boolean;
  private onOpenPositionsChange?: (openPositions: ShadowPosition[]) => void;
  private onPositionClose?: (closed: ShadowPosition) => void;
  private defaultTrailingStopPercent?: number;
  private maxPositionsPerSymbol: number;
  private nextId = 1;
  private slippageRecords: number[] = [];
  /** Rolling in-memory P&L snapshot history (last 48 entries = 24h at 30min intervals) */
  private pnlSnapshots: ShadowPnlSnapshot[] = [];
  /** Latest known price per symbol — populated by updatePrice for unrealized-P&L marking */
  private lastPrices: Map<string, number> = new Map();
  /** Cumulative baseline captured at construct time (from strategy_trades) — see ShadowModeExecutorOpts.initialCumulative */
  private cumulativeBaseline: { trades: number; wins: number; totalPnl: number } = { trades: 0, wins: 0, totalPnl: 0 };

  constructor(opts: ShadowModeExecutorOpts = {}) {
    this.feeBps = opts.feeBps ?? DEFAULT_FEE_BPS;
    this.confidenceTiers = [...(opts.confidenceTiers ?? DEFAULT_CONFIDENCE_TIERS)]
      .sort((a, b) => b.minConfidence - a.minConfidence);
    this.maxTradeUsd = opts.maxTradeUsd;
    this.preTradeCheck = opts.preTradeCheck;
    this.onShadowTrade = opts.onShadowTrade;
    this.onPnlSnapshot = opts.onPnlSnapshot;
    this.strategyStatsProvider = opts.strategyStatsProvider;
    this.disabledStrategyProvider = opts.disabledStrategyProvider;
    this.onOpenPositionsChange = opts.onOpenPositionsChange;
    this.onPositionClose = opts.onPositionClose;
    this.defaultTrailingStopPercent =
      opts.defaultTrailingStopPercent && opts.defaultTrailingStopPercent > 0
        ? opts.defaultTrailingStopPercent
        : undefined;
    this.maxPositionsPerSymbol =
      opts.maxPositionsPerSymbol && opts.maxPositionsPerSymbol > 0
        ? Math.floor(opts.maxPositionsPerSymbol)
        : 2;
    if (opts.initialCumulative) {
      const t = Number(opts.initialCumulative.trades);
      const w = Number(opts.initialCumulative.wins ?? 0);
      const p = Number(opts.initialCumulative.totalPnl);
      const trades = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
      const wins = Number.isFinite(w) && w >= 0 ? Math.min(Math.floor(w), trades) : 0;
      this.cumulativeBaseline = {
        trades,
        wins,
        totalPnl: Number.isFinite(p) ? p : 0,
      };
    }
    if (opts.initialPositions?.length) {
      // ── Defensive dedup on restore ────────────────────────────────────────
      // The persistence layer (shadow_open_positions setting) is a
      // last-writer-wins JSON blob updated by two daemons. Partial writes,
      // concurrent flushes, or a crash mid-update can leave duplicate rows
      // (same id, or same symbol stacked beyond the per-symbol cap). Without
      // pruning, those duplicates resurrect every restart and pile up — this
      // is the same class of failure as the 97-position SOL incident and the
      // XLM_USDT duplicate-position report.
      //
      // 1. Keep the first occurrence of each id (id collision = double-record).
      // 2. Within each symbol, keep at most maxPositionsPerSymbol by enteredAt
      //    ascending (oldest survives; newest duplicates are pruned).
      const seenIds = new Set<string>();
      const dedupedById: ShadowPosition[] = [];
      let duplicateIdCount = 0;
      for (const p of opts.initialPositions) {
        if (seenIds.has(p.id)) {
          duplicateIdCount++;
          continue;
        }
        seenIds.add(p.id);
        dedupedById.push({ ...p });
      }

      const bySymbol = new Map<string, ShadowPosition[]>();
      for (const p of dedupedById) {
        const list = bySymbol.get(p.symbol) ?? [];
        list.push(p);
        bySymbol.set(p.symbol, list);
      }
      const pruned: ShadowPosition[] = [];
      let overCapCount = 0;
      const overCapSymbols = new Set<string>();
      for (const [symbol, list] of bySymbol) {
        if (list.length <= this.maxPositionsPerSymbol) {
          pruned.push(...list);
          continue;
        }
        // Keep oldest N (by enteredAt asc) — they had the most time to set up
        // stops and accumulate state; drop the newer duplicates.
        const sorted = [...list].sort((a, b) => a.enteredAt - b.enteredAt);
        pruned.push(...sorted.slice(0, this.maxPositionsPerSymbol));
        overCapCount += list.length - this.maxPositionsPerSymbol;
        overCapSymbols.add(symbol);
      }
      this.positions = pruned;

      if (duplicateIdCount > 0) {
        console.warn(
          `[shadow] restore: dropped ${duplicateIdCount} duplicate-id position(s) from persisted state`,
        );
      }
      if (overCapCount > 0) {
        console.warn(
          `[shadow] restore: pruned ${overCapCount} over-cap position(s) ` +
          `(max ${this.maxPositionsPerSymbol}/symbol) on: ${[...overCapSymbols].join(", ")}`,
        );
      }

      // Seed nextId above any restored IDs to avoid collisions
      const maxId = this.positions.reduce((max, p) => {
        const n = parseInt(p.id.replace("shadow-", ""), 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);
      if (maxId > 0) this.nextId = maxId + 1;

      const missingExits = this.positions.filter(
        (p) => p.stopLoss == null || p.takeProfit == null,
      );
      if (missingExits.length > 0) {
        console.warn(
          `[shadow] WARNING: ${missingExits.length}/${this.positions.length} ` +
          `restored positions are missing stopLoss or takeProfit and will not ` +
          `auto-close. Symbols: ${missingExits.map((p) => p.symbol).join(", ")}`,
        );
      }

      // ── Seed mark prices from restored entry prices ───────────────────────
      // The persisted `shadow_open_positions` blob carries entryPrice but no
      // mark price, and `lastPrices` is otherwise empty until the live feed
      // delivers its first tick per symbol. computeUnrealizedPnl() SKIPS any
      // position whose symbol has no observed price (`if (last == null)
      // continue`), so the immediate baseline P&L snapshot taken on daemon
      // startup (zaraa.ts records one right after construction "so the first
      // datapoint after a restart isn't 30 minutes away") used to exclude EVERY
      // restored position from mark-to-market — reporting unrealizedPnl=0 /
      // totalEquity=0 even with open positions. Marking each restored position
      // at its entry/cost basis makes the restored state FULLY available before
      // that first snapshot: unrealized is honestly 0 at cost basis until a real
      // tick moves it, and the first updatePrice() overwrites the seed.
      // Existing entries (e.g. priced via a prior updatePrice in the same
      // construction) are never clobbered.
      for (const pos of this.positions) {
        if (!this.lastPrices.has(pos.symbol)) {
          this.lastPrices.set(pos.symbol, pos.entryPrice);
        }
      }
    }
  }

  private notifyOpenPositionsChanged(): void {
    this.onOpenPositionsChange?.(this.getOpenPositions());
  }

  /**
   * True when `strategy` is currently flagged as a chronic loser by the wired
   * `strategyStatsProvider` (the SAME source that feeds P&L snapshots, so the
   * block decision is always consistent with what an operator sees flagged).
   *
   * Returns false when:
   *  - no provider is wired (backward-compatible: nothing to block against), or
   *  - the strategy is absent from the stats map (no closed trades yet), or
   *  - the provider throws (FAIL-OPEN — a transient journal/stats error must
   *    not freeze all shadow entries; mirrors recordPnlSnapshot's handling).
   *
   * Purely reads the advisory `flagged` bit; never mutates flagging logic.
   */
  private isStrategyFlagged(strategy: string): boolean {
    if (!this.strategyStatsProvider) return false;
    try {
      const stats = this.strategyStatsProvider();
      return stats?.[strategy]?.flagged === true;
    } catch (err) {
      console.warn(
        "[shadow] flagged-strategy check skipped — strategyStatsProvider threw:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /**
   * True when `strategy` has been disabled by the operator via config
   * (`trading.disabledStrategies`), as reported by the wired
   * `disabledStrategyProvider` (backed by `StrategyRegistry.isDisabled`).
   *
   * Ensemble-wrapped names (`ensemble(a+b)`, produced by the SignalEngine)
   * are expanded: the entry is blocked when the full name OR any member
   * strategy is disabled — the disable list holds bare names, and a killed
   * strategy must not re-enter via an ensemble vote on the bypass paths.
   *
   * Returns false when:
   *  - no provider is wired (backward-compatible: nothing to block against), or
   *  - the provider throws (FAIL-OPEN — a transient registry error must not
   *    freeze all shadow entries; mirrors isStrategyFlagged's handling).
   *
   * Purely reads the operator's disable config; never mutates it.
   */
  private isStrategyDisabled(strategy: string): boolean {
    if (!this.disabledStrategyProvider) return false;
    try {
      for (const name of expandStrategyNames(strategy)) {
        if (this.disabledStrategyProvider(name) === true) return true;
      }
      return false;
    } catch (err) {
      console.warn(
        "[shadow] disabled-strategy check skipped — disabledStrategyProvider threw:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /**
   * Resolve the sizing multiplier for a given confidence by walking the
   * (descending-sorted) tier table. Returns 1.0 when no confidence is given,
   * 0 when confidence falls below every tier (caller should skip), and a
   * value in [0,1] otherwise.
   */
  getConfidenceSizeMultiplier(confidence: number | undefined): number {
    if (confidence === undefined || Number.isNaN(confidence)) return 1;
    for (const tier of this.confidenceTiers) {
      if (confidence >= tier.minConfidence) {
        return Math.max(0, Math.min(1, tier.sizePct));
      }
    }
    return 0;
  }

  /**
   * Record a P&L snapshot — call this every 30 minutes from an external timer.
   * Keeps the last SHADOW_PNL_SNAPSHOT_CAP (48 ≈ 24h) snapshots in memory and
   * calls onPnlSnapshot for DB persistence.
   */
  recordPnlSnapshot(): void {
    const perf = this.getShadowPerformance();
    const snapshot: ShadowPnlSnapshot = {
      ts: Date.now(),
      trades: perf.trades,
      openPositions: perf.openPositionCount,
      totalPnl: perf.totalPnl,
      unrealizedPnl: perf.unrealizedPnl,
      totalEquity: perf.totalEquity,
      winRate: perf.winRate,
    };

    // Fold in the per-strategy breakdown when a provider is wired. A throwing
    // provider (e.g. a transient DB error) must NOT drop the whole snapshot —
    // record it without the breakdown and move on.
    if (this.strategyStatsProvider) {
      try {
        const strategies = this.strategyStatsProvider();
        snapshot.strategies = strategies;
        // Auto-disable advisory: warn on each flagged chronic loser so a bad
        // strategy is visible in logs every snapshot cycle. We only log here —
        // nothing is auto-disabled yet; the `flagged` bit rides along in the
        // snapshot for an operator (or a later pass) to act on.
        for (const [id, s] of Object.entries(strategies)) {
          if (s.flagged) {
            console.warn(
              `[shadow] STRATEGY FLAGGED for potential disable: ${id} — ` +
              `${s.trades} trades, winRate=${(s.winRate * 100).toFixed(1)}%, ` +
              `P&L=$${s.pnl.toFixed(2)} (>=20 closed, winRate<35%, P&L<-$1)`,
            );
          }
        }
      } catch (err) {
        console.warn(
          "[shadow] strategyStatsProvider threw — snapshot recorded without per-strategy breakdown:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    this.pnlSnapshots.push(snapshot);
    if (this.pnlSnapshots.length > SHADOW_PNL_SNAPSHOT_CAP) this.pnlSnapshots.shift();
    this.onPnlSnapshot?.(snapshot);
  }

  /** Get all recorded P&L snapshots */
  getPnlSnapshots(): ShadowPnlSnapshot[] {
    return [...this.pnlSnapshots];
  }

  /**
   * Execute a shadow trade — runs full validation but never calls the exchange.
   *
   * Returns what WOULD have happened: entry price, position size, estimated fees.
   */
  executeShadow(params: ShadowTradeParams): ShadowTradeResult {
    const now = Date.now();
    const id = `shadow-${this.nextId++}`;

    // Run pre-trade checks exactly as live would
    let preTradeChecksPassed = true;
    let preTradeRejection: string | undefined;

    if (this.preTradeCheck) {
      const check = this.preTradeCheck(params);
      preTradeChecksPassed = check.passed;
      preTradeRejection = check.reason;
    }

    // ── Flagged-strategy gate ───────────────────────────────────────────────
    // A strategy flagged as a chronic loser (TradeJournal STRATEGY_FLAG_
    // THRESHOLDS: >=20 closed trades, winRate<35%, cumulative P&L<-$1) must
    // STOP opening new shadow positions. Before this, the flag was advisory
    // only — it rode along in P&L snapshots and was logged each cycle, but a
    // 24%-win strategy like rsi-divergence kept opening trades regardless.
    // We consult the already-wired strategyStatsProvider so the block is the
    // single choke point both shadow entry paths (handler + execution-manager)
    // funnel through. Flagging logic itself is untouched — this only reads it.
    if (preTradeChecksPassed && this.isStrategyFlagged(params.strategy)) {
      preTradeChecksPassed = false;
      preTradeRejection =
        `strategy "${params.strategy}" is flagged as a chronic loser ` +
        `(>=20 closed, winRate<35%, P&L<-$1) — new shadow entries blocked`;
    }

    // ── Disabled-strategy gate ──────────────────────────────────────────────
    // A strategy the operator disabled via config (`trading.disabledStrategies`)
    // must STOP opening new shadow positions. The SignalEngine already filters
    // these via `strategyRegistry.getActive()`, but the shadow entry paths
    // (handlers.ts + execution-manager.ts) can call executeShadow directly and
    // bypass that filter — which let mean-reversion accumulate 93 shadow trades
    // while listed in `disabledStrategies`. We consult the wired
    // disabledStrategyProvider (StrategyRegistry.isDisabled) so this executor is
    // the single choke point both bypass paths funnel through. Fail-open: a
    // throwing provider allows the entry (see isStrategyDisabled).
    if (preTradeChecksPassed && this.isStrategyDisabled(params.strategy)) {
      preTradeChecksPassed = false;
      preTradeRejection =
        `strategy "${params.strategy}" is disabled via config ` +
        `(trading.disabledStrategies) — new shadow entries blocked`;
    }

    // ── Symbol+strategy duplicate gate ──────────────────────────────────────
    // Refuse to open a second OPEN shadow position for the same symbol AND the
    // same strategy. The per-symbol cap below permits up to maxPositionsPerSymbol
    // positions on a symbol (intended for distinct strategies), so two entries
    // from the SAME strategy on the SAME symbol slip past it as "diversification"
    // when they're really duplicates — that's what produced the XLM_USDT and
    // ETH_USDT mean-reversion double-opens. The SignalEngine has a per-symbol
    // short-circuit upstream, but the handler and execution-manager entry paths
    // call executeShadow directly and bypass it, so the dedup must live here —
    // the single choke point all entry paths share (same rationale as the
    // flagged/disabled gates above). Counts OPEN positions only; once a position
    // closes, the symbol+strategy slot frees up for a fresh entry.
    if (preTradeChecksPassed) {
      const duplicate = this.positions.some(
        (p) => p.symbol === params.symbol && p.strategy === params.strategy,
      );
      if (duplicate) {
        preTradeChecksPassed = false;
        preTradeRejection =
          `duplicate: an open shadow position already exists for ` +
          `${params.symbol} on strategy "${params.strategy}"`;
      }
    }

    // Per-symbol cap — refuse to stack more than `maxPositionsPerSymbol` open
    // positions on the same symbol. Counted against `this.positions` only;
    // closed positions don't count.
    if (preTradeChecksPassed) {
      const sameSymbolOpen = this.positions.filter((p) => p.symbol === params.symbol).length;
      if (sameSymbolOpen >= this.maxPositionsPerSymbol) {
        preTradeChecksPassed = false;
        preTradeRejection =
          `per-symbol cap: ${sameSymbolOpen} open ${params.symbol} ` +
          `>= max ${this.maxPositionsPerSymbol}`;
      }
    }

    // ── Confidence-based position sizing ────────────────────────────────────
    // Scale the requested qty by the confidence tier, then enforce the
    // maxTradeUsd cap so the scaled notional can NEVER exceed it. The cap is
    // applied via Math.min, never as additive logic, so a misconfigured tier
    // (sizePct > 1) cannot bypass the security limit.
    const sizingMultiplier = this.getConfidenceSizeMultiplier(params.confidence);
    let scaledQty = params.qty * sizingMultiplier;
    if (this.maxTradeUsd !== undefined && this.maxTradeUsd > 0 && params.price > 0) {
      const cappedQty = this.maxTradeUsd / params.price;
      scaledQty = Math.min(scaledQty, cappedQty);
    }
    const notional = scaledQty * params.price;
    const estimatedFees = notional * (this.feeBps / 10_000);

    const result: ShadowTradeResult = {
      id,
      symbol: params.symbol,
      side: params.side,
      qty: scaledQty,
      entryPrice: params.price,
      strategy: params.strategy,
      estimatedFees,
      timestamp: now,
      preTradeChecksPassed,
      preTradeRejection,
    };

    // Only open a position if pre-trade checks passed AND the scaled qty is
    // positive — a zero or negative qty would create a no-op position.
    if (preTradeChecksPassed && scaledQty > 0) {
      // Per-trade override beats default; treat 0 / negative as "disabled"
      const explicitTrail = params.trailingStopPercent;
      const trailingStopPercent =
        explicitTrail !== undefined
          ? explicitTrail > 0 ? explicitTrail : undefined
          : this.defaultTrailingStopPercent;

      this.positions.push({
        id,
        symbol: params.symbol,
        side: params.side,
        qty: scaledQty,
        entryPrice: params.price,
        strategy: params.strategy,
        enteredAt: now,
        trailingStopPercent,
        confidence: params.confidence,
        sizingMultiplier,
        notionalUsd: notional,
      });
      this.notifyOpenPositionsChanged();

      const confStr = params.confidence !== undefined
        ? ` | confidence: ${params.confidence.toFixed(3)} (${(sizingMultiplier * 100).toFixed(0)}% size)`
        : "";
      console.log(
        `[shadow] ENTRY: ${params.symbol} ${params.side} qty=${scaledQty.toFixed(8)} ` +
        `@ $${params.price.toFixed(2)}${confStr}`,
      );
    } else if (preTradeChecksPassed && scaledQty <= 0) {
      preTradeChecksPassed = false;
      preTradeRejection = `confidence too low (multiplier=${sizingMultiplier})`;
      result.preTradeChecksPassed = false;
      result.preTradeRejection = preTradeRejection;
      console.log(
        `[shadow] REJECTED: ${params.side} ${params.symbol} — ${preTradeRejection}`,
      );
    } else {
      console.log(
        `[shadow] REJECTED: ${params.side} ${params.qty} ${params.symbol} ` +
        `@ $${params.price.toFixed(2)} — ${preTradeRejection}`,
      );
    }

    this.onShadowTrade?.(result);
    return result;
  }

  /**
   * Update shadow positions with current market price.
   * Closes positions when stop-loss or take-profit would have triggered.
   */
  updatePrice(symbol: string, currentPrice: number, slippageBps = 0): void {
    this.lastPrices.set(symbol, currentPrice);
    const toClose: ShadowPosition[] = [];

    for (const pos of this.positions) {
      if (pos.symbol !== symbol) continue;

      // Ratchet trailing SL tighter on favorable price moves before evaluating
      // the stop. Order matters: a price tick that moves the trail up may push
      // SL above the *new* mark, but the spec gates trail moves on profit
      // against entry, so the same tick can't trigger an exit it just created.
      this.maybeAdjustTrailingStop(pos, currentPrice);

      if (pos.stopLoss != null) {
        const stopHit = pos.side === "BUY"
          ? currentPrice <= pos.stopLoss
          : currentPrice >= pos.stopLoss;
        if (stopHit) {
          pos.exitPrice = pos.stopLoss;
          pos.exitedAt = Date.now();
          pos.exitReason = "stop_loss";
          toClose.push(pos);
          continue;
        }
      }

      if (pos.takeProfit != null) {
        const tpHit = pos.side === "BUY"
          ? currentPrice >= pos.takeProfit
          : currentPrice <= pos.takeProfit;
        if (tpHit) {
          pos.exitPrice = pos.takeProfit;
          pos.exitedAt = Date.now();
          pos.exitReason = "take_profit";
          toClose.push(pos);
        }
      }
    }

    for (const pos of toClose) {
      this.closePosition(pos);
    }

    // Record slippage if provided
    if (slippageBps !== 0) {
      this.slippageRecords.push(slippageBps);
    }
  }

  /**
   * Set stop-loss and take-profit for a shadow position.
   */
  setStopAndTarget(positionId: string, stopLoss: number, takeProfit: number): boolean {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return false;
    pos.stopLoss = stopLoss;
    pos.takeProfit = takeProfit;
    this.notifyOpenPositionsChanged();
    return true;
  }

  /**
   * Enable, retune, or disable the trailing stop on an open shadow position.
   * Pass 0 or a negative value to disable trailing while keeping any fixed SL/TP.
   */
  setTrailingStop(positionId: string, trailingStopPercent: number): boolean {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return false;
    pos.trailingStopPercent = trailingStopPercent > 0 ? trailingStopPercent : undefined;
    this.notifyOpenPositionsChanged();
    return true;
  }

  /**
   * Tighten `pos.stopLoss` toward the current price when the trade is in profit
   * against entry. Never moves SL backward (ratchet semantics) — drawdown ticks
   * are no-ops. Idempotent when nothing needs to move.
   */
  private maybeAdjustTrailingStop(pos: ShadowPosition, currentPrice: number): void {
    const trailPct = pos.trailingStopPercent;
    if (!trailPct || trailPct <= 0) return;

    const trailFraction = trailPct / 100;
    let candidate: number;
    let isBetter: boolean;

    if (pos.side === "BUY") {
      if (currentPrice <= pos.entryPrice) return;
      candidate = currentPrice * (1 - trailFraction);
      isBetter = pos.stopLoss == null || candidate > pos.stopLoss;
    } else {
      if (currentPrice >= pos.entryPrice) return;
      candidate = currentPrice * (1 + trailFraction);
      isBetter = pos.stopLoss == null || candidate < pos.stopLoss;
    }

    if (!isBetter) return;

    const oldSL = pos.stopLoss;
    pos.stopLoss = candidate;
    const oldStr = oldSL != null ? oldSL.toFixed(2) : "—";
    console.log(
      `[shadow] TRAIL: ${pos.symbol} SL adjusted ${oldStr} → ${candidate.toFixed(2)}`,
    );
    this.notifyOpenPositionsChanged();
  }

  /**
   * Manually close a shadow position at a given price.
   */
  closeShadowPosition(positionId: string, exitPrice: number): boolean {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return false;
    pos.exitPrice = exitPrice;
    pos.exitedAt = Date.now();
    pos.exitReason = "manual";
    this.closePosition(pos);
    return true;
  }

  /**
   * Close a shadow position because it exceeded the max-hold time. Distinct
   * from `closeShadowPosition` so the exit reason is recorded as `time_expiry`,
   * letting the strategy grader and journal distinguish stale-exit P&L from
   * stop-driven and manual closes.
   */
  closeShadowPositionByTimeExpiry(positionId: string, exitPrice: number): boolean {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return false;
    pos.exitPrice = exitPrice;
    pos.exitedAt = Date.now();
    pos.exitReason = "time_expiry";
    this.closePosition(pos);
    return true;
  }

  private closePosition(pos: ShadowPosition): void {
    const direction = pos.side === "BUY" ? 1 : -1;
    pos.pnl = direction * (pos.exitPrice! - pos.entryPrice) * pos.qty;

    // Persist the close to the trade journal BEFORE committing the in-memory +
    // settings mutation. The journal lives in a separate SQLite file from the
    // settings blob, so a true cross-DB transaction isn't possible — instead
    // we order the writes so the journal is the source of truth: only commit
    // the in-memory removal AFTER the journal accepts the close. If the
    // journal write throws, roll back the exit fields and leave the position
    // open so the next price tick retries it. Without this ordering, a thrown
    // journal write left `positions` and `shadow_open_positions` saying
    // "closed" while `strategy_trades.exitedAt` stayed NULL — the phantom-open
    // class of bug.
    if (this.onPositionClose) {
      try {
        this.onPositionClose({ ...pos });
      } catch (err) {
        console.error(
          "[shadow] closePosition aborted — journal persist threw, retaining position open:",
          err instanceof Error ? err.message : err,
        );
        pos.exitPrice = undefined;
        pos.exitedAt = undefined;
        pos.exitReason = undefined;
        pos.pnl = undefined;
        return;
      }
    }

    this.positions = this.positions.filter((p) => p.id !== pos.id);
    this.closedPositions.push(pos);
    if (this.closedPositions.length > ShadowModeExecutor.MAX_CLOSED_POSITIONS) {
      this.closedPositions.splice(
        0,
        this.closedPositions.length - ShadowModeExecutor.MAX_CLOSED_POSITIONS,
      );
    }
    this.notifyOpenPositionsChanged();
    console.log(
      `[shadow] EXIT: ${pos.symbol} P&L: $${pos.pnl.toFixed(2)} (${pos.exitReason ?? "unknown"})`,
    );
  }

  /**
   * Get shadow trading performance metrics.
   */
  getShadowPerformance(): ShadowPerformance {
    const closed = this.closedPositions;
    const unrealizedPnl = this.computeUnrealizedPnl();
    const openPositionCount = this.positions.length;
    const avgSlippage =
      this.slippageRecords.length > 0
        ? this.slippageRecords.reduce((s, v) => s + v, 0) / this.slippageRecords.length
        : 0;
    const baselineTrades = this.cumulativeBaseline.trades;
    const baselineWins = this.cumulativeBaseline.wins;
    const baselinePnl = this.cumulativeBaseline.totalPnl;

    // Lifetime winRate: combine journal baseline (survives daemon restarts)
    // with in-memory closes since boot. Without this, every pnlSnapshotTimer
    // run that fires before the first in-memory close writes winRate=0
    // alongside a non-zero lifetime trade count — producing the "bounce
    // between 0 and the actual value" pattern on alternating snapshots.
    const sessionWins = closed.filter((p) => (p.pnl ?? 0) > 0).length;
    const sessionPnl = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
    const totalTrades = baselineTrades + closed.length;
    const totalWins = baselineWins + sessionWins;
    const totalPnl = baselinePnl + sessionPnl;

    return {
      trades: totalTrades,
      winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
      totalPnl,
      unrealizedPnl,
      totalEquity: totalPnl + unrealizedPnl,
      openPositionCount,
      avgSlippage,
    };
  }

  /**
   * Mark-to-market unrealized P&L across all open positions using the most
   * recent price observed via updatePrice(). Positions for symbols that have
   * never been priced contribute 0 to unrealized P&L.
   */
  private computeUnrealizedPnl(): number {
    let unrealized = 0;
    for (const pos of this.positions) {
      const last = this.lastPrices.get(pos.symbol);
      if (last == null) continue;
      const direction = pos.side === "BUY" ? 1 : -1;
      unrealized += direction * (last - pos.entryPrice) * pos.qty;
    }
    return unrealized;
  }

  /** Get all open shadow positions */
  getOpenPositions(): ShadowPosition[] {
    return [...this.positions];
  }

  /** Get all closed shadow positions */
  getClosedPositions(): ShadowPosition[] {
    return [...this.closedPositions];
  }

  /** Most recent price observed via updatePrice for a symbol, or undefined */
  getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol);
  }

  /**
   * Per-strategy and per-symbol P&L attribution over the closed positions
   * currently retained in memory (bounded by MAX_CLOSED_POSITIONS). Unlike
   * getShadowPerformance(), this does NOT fold in the journal baseline —
   * the baseline is aggregate-only and cannot be attributed per key.
   */
  getShadowAttribution(): ShadowAttribution {
    const byStrategy: Record<string, ShadowAttributionStat> = {};
    const bySymbol: Record<string, ShadowAttributionStat> = {};
    const bump = (
      map: Record<string, ShadowAttributionStat>,
      key: string,
      pnl: number,
    ): void => {
      const stat = map[key] ?? {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        avgPnl: 0,
        winRate: 0,
      };
      map[key] = stat;
      stat.trades += 1;
      if (pnl > 0) stat.wins += 1;
      else if (pnl < 0) stat.losses += 1;
      stat.totalPnl += pnl;
    };
    for (const pos of this.closedPositions) {
      const pnl = pos.pnl ?? 0;
      bump(byStrategy, pos.strategy ?? "unknown", pnl);
      bump(bySymbol, pos.symbol, pnl);
    }
    for (const map of [byStrategy, bySymbol]) {
      for (const stat of Object.values(map)) {
        stat.avgPnl = stat.totalPnl / stat.trades;
        stat.winRate = stat.wins / stat.trades;
      }
    }
    return { byStrategy, bySymbol };
  }
}
