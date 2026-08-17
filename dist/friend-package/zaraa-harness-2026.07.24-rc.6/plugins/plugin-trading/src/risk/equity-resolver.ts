/**
 * EquityResolver — centralized equity calculation for position sizing.
 *
 * Before this module, handlers.ts used `daily_limit_usd || "200"` (effective
 * fallback: $400) while execution-manager.ts used `daily_limit_usd || "100"`
 * (effective fallback: $200). This inconsistency meant the same position could
 * be sized differently depending on the code path.
 *
 * EquityResolver provides a single source of truth:
 *   1. Use latest equity from store if available
 *   2. Fall back to peak equity if latest is missing
 *   3. Fall back to (daily_limit * configurable multiplier) as last resort
 *
 * The default multiplier is 3x — a compromise between the old 5x (too
 * aggressive) and 2x (too conservative) values.
 */

export interface EquityResolverDeps {
  /** Get the most recent equity snapshot value */
  getLatestEquity: () => number;
  /** Get the peak (high-water mark) equity value */
  getPeakEquity: () => number;
  /** Get a stored setting by key */
  getSetting: (key: string) => string | null;
}

export interface EquityResolverConfig {
  /**
   * Multiplier applied to daily_limit_usd when no equity snapshots exist.
   * Default: 3 (compromise between old 5x and 2x values).
   */
  fallbackMultiplier: number;
  /**
   * Default daily limit USD when the setting is not configured.
   * Default: 150 (midpoint of old 100 and 200 defaults).
   */
  defaultDailyLimitUsd: number;
  /**
   * Minimum equity floor to prevent dangerously small sizing.
   * Default: 100.
   */
  minEquityFloor: number;
}

export interface EquityResult {
  /** The resolved account equity for position sizing */
  accountEquity: number;
  /** The resolved peak equity for drawdown checks */
  peakEquity: number;
  /** Whether the fallback multiplier was used (indicates missing equity data) */
  usedFallback: boolean;
  /** Which source provided accountEquity */
  source: "latest" | "peak" | "fallback";
}

const DEFAULT_CONFIG: EquityResolverConfig = {
  fallbackMultiplier: 3,
  defaultDailyLimitUsd: 150,
  minEquityFloor: 100,
};

export class EquityResolver {
  private readonly deps: EquityResolverDeps;
  private readonly config: EquityResolverConfig;
  /** Track whether the last resolve() used fallback — sticky until a real equity arrives */
  private lastUsedFallback = false;

  constructor(deps: EquityResolverDeps, config?: Partial<EquityResolverConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Resolve account equity and peak equity using a consistent fallback chain.
   *
   * Priority:
   *   1. Latest equity snapshot (current capital)
   *   2. Peak equity (if latest is zero/missing)
   *   3. Fallback: max(minEquityFloor, dailyLimit * multiplier)
   *
   * Logs a warning when fallback is used since it indicates the exchange
   * API or equity snapshot pipeline has an issue.
   */
  resolve(): EquityResult {
    const latestEquity = this.deps.getLatestEquity();
    const storedPeakEquity = this.deps.getPeakEquity();

    let accountEquity: number;
    let source: EquityResult["source"];
    let usedFallback = false;

    if (latestEquity > 0) {
      accountEquity = latestEquity;
      source = "latest";
    } else if (storedPeakEquity > 0) {
      accountEquity = storedPeakEquity;
      source = "peak";
    } else {
      const dailyLimit = Number(
        this.deps.getSetting("daily_limit_usd") || String(this.config.defaultDailyLimitUsd),
      );
      accountEquity = Math.max(
        this.config.minEquityFloor,
        dailyLimit * this.config.fallbackMultiplier,
      );
      source = "fallback";
      usedFallback = true;
      console.warn(
        `[equity-resolver] No equity snapshots available. Using fallback: ` +
        `$${accountEquity} (daily_limit $${dailyLimit} * ${this.config.fallbackMultiplier}x). ` +
        `This may indicate an exchange API issue.`,
      );
    }

    this.lastUsedFallback = usedFallback;

    const peakEquity = storedPeakEquity > 0 ? storedPeakEquity : accountEquity;

    return { accountEquity, peakEquity, usedFallback, source };
  }

  /**
   * Report whether the resolver is currently operating in fallback mode.
   * True means no real equity data is available — exchange API may be down.
   */
  isInFallbackMode(): boolean {
    return this.lastUsedFallback;
  }

  /** Expose config for debugging / tests */
  getConfig(): Readonly<EquityResolverConfig> {
    return { ...this.config };
  }
}
