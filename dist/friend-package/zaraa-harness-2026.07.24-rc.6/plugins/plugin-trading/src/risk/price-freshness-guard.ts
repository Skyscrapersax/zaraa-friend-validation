/**
 * PriceFreshnessGuard — prevents stop-monitor decisions based on stale prices.
 *
 * Wraps a price-lookup function and enforces a configurable max-age.
 * In conservative mode (default) stale prices block the stop check.
 * In permissive mode the stale price is returned but flagged.
 */

export interface PriceResult {
  price: number;
  timestamp: number;
}

export interface FreshnessCheckResult {
  price: number;
  timestamp: number;
  stale: boolean;
  ageMs: number;
}

export type FreshnessMode = "conservative" | "permissive";

export interface StalenessStats {
  totalChecks: number;
  staleChecks: number;
  lastStaleAt: number | null;
}

export interface PriceFreshnessGuardOpts {
  /** Maximum acceptable age in milliseconds (default: 60_000) */
  maxAgeMs?: number;
  /** conservative = block stale prices, permissive = allow with flag */
  mode?: FreshnessMode;
  /** Optional logger — receives warnings on stale prices */
  onStale?: (symbol: string, ageMs: number, mode: FreshnessMode) => void;
}

export class StalePriceError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly ageMs: number,
    public readonly maxAgeMs: number,
  ) {
    super(
      `Price for ${symbol} is stale (age: ${ageMs}ms, max: ${maxAgeMs}ms)`,
    );
    this.name = "StalePriceError";
  }
}

export class PriceFreshnessGuard {
  private maxAgeMs: number;
  private mode: FreshnessMode;
  private onStale?: (symbol: string, ageMs: number, mode: FreshnessMode) => void;
  private stats = new Map<string, StalenessStats>();

  constructor(opts: PriceFreshnessGuardOpts = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 60_000;
    this.mode = opts.mode ?? "conservative";
    this.onStale = opts.onStale;
  }

  /**
   * Check a price result for freshness.
   *
   * @param symbol  Trading pair, e.g. "BTC_USDT"
   * @param result  Price data with timestamp
   * @param now     Current time (injectable for tests)
   * @returns       FreshnessCheckResult in permissive mode
   * @throws        StalePriceError in conservative mode when stale
   */
  check(
    symbol: string,
    result: PriceResult,
    now: number = Date.now(),
  ): FreshnessCheckResult {
    const ageMs = now - result.timestamp;
    const stale = ageMs > this.maxAgeMs;

    // Update per-symbol stats
    const s = this.stats.get(symbol) ?? {
      totalChecks: 0,
      staleChecks: 0,
      lastStaleAt: null,
    };
    s.totalChecks++;
    if (stale) {
      s.staleChecks++;
      s.lastStaleAt = now;
      this.onStale?.(symbol, ageMs, this.mode);
    }
    this.stats.set(symbol, s);

    if (stale && this.mode === "conservative") {
      throw new StalePriceError(symbol, ageMs, this.maxAgeMs);
    }

    return {
      price: result.price,
      timestamp: result.timestamp,
      stale,
      ageMs,
    };
  }

  /** Get staleness statistics for a specific symbol */
  getStats(symbol: string): StalenessStats | undefined {
    return this.stats.get(symbol);
  }

  /** Get staleness statistics for all tracked symbols */
  getAllStats(): Map<string, StalenessStats> {
    return new Map(this.stats);
  }
}
