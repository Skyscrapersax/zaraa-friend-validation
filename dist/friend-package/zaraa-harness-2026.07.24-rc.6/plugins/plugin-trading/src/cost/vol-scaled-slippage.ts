/**
 * Volatility / ATR-scaled slippage for backtester per-bar exit cost.
 *
 * The backtester currently applies flat slippage to every fill. Real fills slip
 * substantially more on high-ATR / gap bars — precisely when stop-loss and
 * end-of-data exits trigger. Charging only flat slippage on those bars flatters
 * tail behavior and drawdown.
 *
 * This module provides a pure, additive hook:
 *   slippageForBar({ baseBps, regime, atr?, price?, gapThrough? })
 *
 * CONTRACT (safety invariant):
 *   slippageForBar() NEVER returns below baseBps.
 *   It only TIGHTENS (raises) the cost — never loosens it.
 *   The result is also capped to prevent runaway values on extreme inputs.
 *
 * Usage in the backtester (opt-in injection):
 *   import { slippageForBar } from "../cost/vol-scaled-slippage.js";
 *   const effectiveSlippage = slippageForBar({
 *     baseBps: slippageBps,
 *     regime: classifyVolRegime(realizedVolEwma(closes)),
 *     atr: currentAtr,
 *     price: current.close,
 *     gapThrough: isGapBar,
 *   });
 *
 * The Backtester's default behavior (no injection) is UNCHANGED — the flat slippage
 * path still works exactly as before. This hook is opt-in per call-site.
 */

import type { VolRegime } from "../risk/volatility-estimator.js";

export interface VolScaledSlippageInput {
  /** Base slippage in bps (the current flat assumption). Floor for the result. */
  baseBps: number;
  /** Volatility regime, typically from classifyVolRegime(). */
  regime: VolRegime;
  /**
   * Bar ATR (Average True Range), same units as price.
   * When provided, adds an ATR-proportional cost term in high/normal regimes.
   */
  atr?: number;
  /**
   * Current bar price (close / reference price) — used to convert ATR to bps.
   * Required for ATR-proportional scaling; ignored if atr is absent.
   */
  price?: number;
  /**
   * True when the exit gapped through the stop level (e.g. the bar opened past
   * the stop-loss price). Adds a fixed extra bps to model the fill-at-open cost.
   */
  gapThrough?: boolean;
}

/**
 * Gap-through premium in bps — added when the bar opens past the stop level.
 * Represents the market-order fill-at-open cost when price jumps over the stop.
 */
const GAP_THROUGH_PREMIUM_BPS = 10;

/**
 * Maximum result cap in bps to avoid runaway values (100% slippage).
 * Chosen conservatively at 500bps (5%) — sufficient for extreme crypto volatility.
 */
const MAX_SLIPPAGE_BPS = 500;

/**
 * Regime multipliers applied to the ATR-proportional add-on component.
 * These only affect the EXTRA cost over baseBps, not the base itself.
 *
 * high:   2.0× the ATR% term  — fills slip significantly in violent bars
 * normal: 0.0× — no ATR add-on for normal; the regime fixed add-on covers it
 * low:    0.0× — no ATR add-on (quiet markets → flat slippage suffices)
 *
 * The regime multipliers on the ATR term are intentionally asymmetric: the spec
 * asks that high-vol tightens costs and low-vol never loosens them (monotone floor).
 * Normal regime uses flat baseBps to remain backward-compatible with flat assumption.
 */
const REGIME_ATR_MULTIPLIER: Record<VolRegime, number> = {
  high: 2.0,
  normal: 0.0,
  low: 0.0,
};

/**
 * Fixed regime add-on in bps (on top of baseBps), applied regardless of ATR.
 * Captures the bid-ask widening effect that correlates with volatility regime
 * even when no ATR data is supplied.
 *
 * high:   +5bps minimum regime premium
 * normal: +0bps (no add-on for normal; base covers it)
 * low:    +0bps (floor = baseBps; we don't reward low-vol with a discount)
 */
const REGIME_FIXED_ADDON_BPS: Record<VolRegime, number> = {
  high: 5,
  normal: 0,
  low: 0,
};

/**
 * Returns the effective slippage in bps for a single bar exit.
 * Always >= baseBps (safety invariant), always <= MAX_SLIPPAGE_BPS.
 *
 * Formula:
 *   effective = baseBps
 *             + regimeFixedAddon                   (regime premium)
 *             + atrPctBps * regimeAtrMultiplier     (ATR-proportional widening)
 *             + (gapThrough ? GAP_THROUGH_PREMIUM : 0)
 *   clamped to [baseBps, MAX_SLIPPAGE_BPS]
 */
export function slippageForBar(input: VolScaledSlippageInput): number {
  const { baseBps, regime, gapThrough = false } = input;

  // Clamp baseBps to be non-negative (guard against bad callers)
  const base = Math.max(0, baseBps);

  // ATR-proportional add-on
  let atrAddonBps = 0;
  const atrMultiplier = REGIME_ATR_MULTIPLIER[regime];
  if (
    atrMultiplier > 0 &&
    input.atr !== undefined &&
    input.price !== undefined &&
    Number.isFinite(input.atr) &&
    Number.isFinite(input.price) &&
    input.price > 0 &&
    input.atr >= 0
  ) {
    // ATR as a fraction of price, in bps
    const atrPctBps = (input.atr / input.price) * 10_000;
    atrAddonBps = atrPctBps * atrMultiplier;
  }

  // Fixed regime premium
  const regimeFixedAddon = REGIME_FIXED_ADDON_BPS[regime];

  // Gap-through premium
  const gapAddon = gapThrough ? GAP_THROUGH_PREMIUM_BPS : 0;

  const effective = base + regimeFixedAddon + atrAddonBps + gapAddon;

  // Clamp: hard floor at baseBps (invariant), hard ceiling at MAX
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(base, effective));
}
