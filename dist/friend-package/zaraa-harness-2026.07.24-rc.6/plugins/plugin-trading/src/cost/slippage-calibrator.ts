/**
 * Empirical slippage calibrator — maps realized per-symbol slippage stats into
 * a per-symbol slippageBps estimate for use in backtest cost models and
 * net-edge gate inputs.
 *
 * CONTRACT (safety invariant):
 *   calibrateSlippageBps() NEVER returns below minFloorBps (default 5).
 *   It can only TIGHTEN the cost assumption vs. the flat default — never loosen it.
 *
 * Usage:
 *   import { calibrateSlippageBps } from "./slippage-calibrator.js";
 *   const bps = calibrateSlippageBps(stats, { percentile: "p75" });
 *   // Pass bps as slippagePct = bps/100 to BacktestConfig, or as spreadBps
 *   // to computeNetEdgeGate, replacing the hard-coded 5bps.
 */

/** Thin realized-slippage stats shape accepted by the calibrator. */
export interface CalibratorStats {
  /** Number of fills used to compute the stats. */
  sampleCount: number;
  /**
   * Mean adverse slippage in basis points (1 bps = 0.01%).
   * Must be >= 0; negative values are treated as invalid and floored.
   * Convert from SlippageStats.meanSlippagePct via: meanSlippagePct * 100.
   */
  meanSlippageBps: number;
  /**
   * 75th-percentile adverse slippage in basis points.
   * Optional — when absent or invalid the calibrator falls back to mean.
   */
  p75SlippageBps?: number;
}

export interface CalibratorOptions {
  /**
   * Minimum sample count to trust the measured stats.
   * Below this threshold, fall back to fallbackBps.
   * Default: 10.
   */
  minSamples?: number;
  /**
   * Fallback slippage in bps when sample count is too low.
   * Default: 5 (matches the existing MIN_SLIPPAGE_BPS floor).
   */
  fallbackBps?: number;
  /**
   * Hard floor — result is always at least this many bps.
   * Default: 5 (matches the existing MIN_SLIPPAGE_BPS floor).
   */
  minFloorBps?: number;
  /**
   * Which percentile to use when stats are sufficient.
   *   "mean" (default): less sensitive to tail fills.
   *   "p75": more conservative, better for illiquid symbols.
   */
  percentile?: "mean" | "p75";
}

/**
 * Returns the calibrated slippage in bps for a symbol, derived from realized stats.
 *
 * Safety: result is always >= max(minFloorBps, fallbackBps) when sample count is
 * insufficient, and always >= minFloorBps when it is sufficient.
 * It can ONLY raise the cost hurdle vs. the flat default — never lower it.
 */
export function calibrateSlippageBps(
  stats: CalibratorStats,
  options: CalibratorOptions = {},
): number {
  const {
    minSamples = 10,
    fallbackBps = 5,
    minFloorBps = 5,
    percentile = "mean",
  } = options;

  const floor = Math.max(minFloorBps, 0);
  const safetyFloor = Math.max(floor, 0);

  // Insufficient sample count — return fallback (floored)
  if (!Number.isFinite(stats.sampleCount) || stats.sampleCount < minSamples) {
    return Math.max(safetyFloor, fallbackBps);
  }

  // Choose the raw measured value based on percentile preference
  let raw: number;

  if (percentile === "p75") {
    const p75 = stats.p75SlippageBps;
    if (Number.isFinite(p75) && (p75 as number) >= 0) {
      raw = p75 as number;
    } else {
      // p75 unavailable or invalid — fall back to mean
      raw = stats.meanSlippageBps;
    }
  } else {
    raw = stats.meanSlippageBps;
  }

  // If the raw value is invalid (NaN / negative), return the floor
  if (!Number.isFinite(raw) || raw < 0) {
    return safetyFloor;
  }

  // Apply hard floor — never be more optimistic than the minimum
  return Math.max(safetyFloor, raw);
}
