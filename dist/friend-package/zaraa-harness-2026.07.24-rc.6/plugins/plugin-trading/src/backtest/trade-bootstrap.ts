/**
 * Bootstrap resampling for strategy robustness assessment.
 *
 * Replaces the near-no-op monteCarloShuffle approach (which only permutes the
 * fixed PnL multiset and therefore produces a tightly-clustered Sharpe
 * distribution that passes the isRobust check for almost any net-positive
 * strategy).
 *
 * This module samples trades WITH REPLACEMENT N times, rebuilds the equity
 * curve for each resample, recomputes Sharpe, and reports:
 *   - positiveSharpeRate: fraction of resamples with Sharpe > 0
 *   - sharpeCI95Lower / sharpeCI95Upper: 95% percentile CI on resampled Sharpe
 *   - isRobust: CI lower bound > 0  (strict; the shuffle test required only
 *     percentile >= 60, which is much weaker)
 *
 * Per the 0/1134 survival prior: this module intentionally reports WIDE error
 * bands. It does NOT overstate confidence. A marginal strategy that the
 * permutation test would pass will often fail here — that is correct behavior.
 *
 * Block bootstrap (blockSize > 1) is available to preserve autocorrelation
 * structure in the trade sequence (e.g. winning streaks), at the cost of
 * slightly less variance in the resample distribution.
 */

import { calculatePerformance, type BacktestTrade } from "./performance.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface BootstrapOptions {
  /** Number of bootstrap resamples. Default: 1000. */
  iterations?: number;
  /**
   * Block size for block bootstrap. When > 1, consecutive blocks of this
   * length are sampled with replacement to preserve autocorrelation.
   * Default: 1 (standard i.i.d. bootstrap).
   */
  blockSize?: number;
  /**
   * Optional integer seed for the PRNG. When provided, the result is fully
   * deterministic (same seed + same trades → identical output). When omitted,
   * Math.random() is used and results vary between calls.
   */
  seed?: number;
}

export interface BootstrapResult {
  /** Sharpe of the actual trade sequence (not resampled). */
  actualSharpe: number;
  /** Total PnL of the actual trade sequence. */
  actualPnl: number;
  /** Sharpe values from each bootstrap resample (sorted ascending). */
  resampleSharpes: number[];
  /** 2.5th percentile of resampled Sharpes (95% CI lower bound). */
  sharpeCI95Lower: number;
  /** 97.5th percentile of resampled Sharpes (95% CI upper bound). */
  sharpeCI95Upper: number;
  /**
   * Fraction of resamples with Sharpe > 0. Ranges [0, 1].
   * Near 1.0 = strong positive edge across resamples.
   * Near 0.5 = noise.
   */
  positiveSharpeRate: number;
  /**
   * True only when the 95% CI lower bound on resampled Sharpe is strictly
   * positive (i.e. even the pessimistic tail of the bootstrap distribution
   * shows positive risk-adjusted returns). This is a strict criterion — the
   * legacy shuffle test's percentile >= 60 is much weaker.
   */
  isRobust: boolean;
  /** Actual number of iterations run. */
  iterations: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Bootstrap edge robustness test.
 *
 * @param trades         Trade list from a backtest run.
 * @param startingEquity Starting equity used in the backtest (for Sharpe calc).
 * @param options        Bootstrap configuration (see {@link BootstrapOptions}).
 */
export function bootstrapEdge(
  trades: BacktestTrade[],
  startingEquity: number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const {
    iterations = 1000,
    blockSize = 1,
    seed,
  } = options;

  // Minimum trade count guard — too few trades produce meaningless statistics.
  if (trades.length < 5) {
    return {
      actualSharpe: 0,
      actualPnl: 0,
      resampleSharpes: [],
      sharpeCI95Lower: 0,
      sharpeCI95Upper: 0,
      positiveSharpeRate: 0,
      isRobust: false,
      iterations,
    };
  }

  // Compute actual performance on the original sequence.
  const actualCurve = buildEquityCurve(trades, startingEquity);
  const actualMetrics = calculatePerformance(trades, actualCurve);
  const actualSharpe = actualMetrics.sharpeRatio;
  const actualPnl = actualMetrics.totalPnl;

  // Initialize PRNG (seeded if requested, otherwise use Math.random).
  const rng = seed !== undefined ? seededRng(seed) : Math.random;

  // Run bootstrap resamples.
  //
  // Hot-loop optimization: the previous implementation allocated a fresh
  // BacktestTrade[] per iteration (resampleTrades), an N+1 equity-curve array
  // (buildEquityCurve), and ran the full calculatePerformance (winners/losers
  // filters, ~5 reduces, drawdown loop, sortino, Math.max/min spreads) — then
  // discarded everything except metrics.sharpeRatio. Here we draw pnls into a
  // single reused number[] buffer (preserving the exact RNG draw order) and
  // compute the Sharpe inline.
  //
  // INVARIANT: resampleSharpe() below MUST stay byte-for-byte in lockstep with
  // performance.ts (tradePnlReturns + computeSharpe + r2 rounding). The pushed
  // value is the r2-rounded Sharpe, exactly as metrics.sharpeRatio was. Any
  // divergence silently corrupts the robustness gate (CI bounds,
  // positiveSharpeRate boundary, isRobust) and breaks determinism.
  const resampleSharpes: number[] = [];
  const n = trades.length;
  const pnlBuffer = new Array<number>(n);

  for (let i = 0; i < iterations; i++) {
    drawResampledPnls(trades, rng, blockSize, pnlBuffer);
    resampleSharpes.push(resampleSharpe(pnlBuffer, startingEquity));
  }

  // Sort for percentile extraction.
  resampleSharpes.sort((a, b) => a - b);

  // 95% CI: 2.5th and 97.5th percentiles (percentile interpolation).
  const ci95Lower = percentile(resampleSharpes, 0.025);
  const ci95Upper = percentile(resampleSharpes, 0.975);

  // Fraction of resamples with Sharpe > 0.
  const positiveSharpeRate =
    resampleSharpes.filter((s) => s > 0).length / resampleSharpes.length;

  return {
    actualSharpe: round(actualSharpe, 4),
    actualPnl: round(actualPnl, 2),
    resampleSharpes,
    sharpeCI95Lower: round(ci95Lower, 4),
    sharpeCI95Upper: round(ci95Upper, 4),
    positiveSharpeRate: round(positiveSharpeRate, 4),
    isRobust: ci95Lower > 0,
    iterations,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Resample `trades` with replacement.
 *
 * Standard bootstrap (blockSize === 1): each position in the output is drawn
 * independently and uniformly from the input trade list.
 *
 * Block bootstrap (blockSize > 1): the output is assembled by drawing blocks
 * of consecutive trades (wrapping around) with replacement. This preserves
 * short-range autocorrelation (e.g. winning streaks, regime persistence).
 * The output length equals `trades.length` — the last block may be truncated.
 */
function resampleTrades(
  trades: BacktestTrade[],
  rng: () => number,
  blockSize: number,
): BacktestTrade[] {
  const n = trades.length;

  if (blockSize <= 1) {
    // Standard i.i.d. bootstrap: sample n trades with replacement.
    return Array.from({ length: n }, () => trades[Math.floor(rng() * n)]);
  }

  // Block bootstrap.
  const result: BacktestTrade[] = [];
  while (result.length < n) {
    // Pick a random start index (wraps around).
    const start = Math.floor(rng() * n);
    const blockEnd = Math.min(start + blockSize, n);
    result.push(...trades.slice(start, blockEnd));
  }
  return result.slice(0, n);
}

/**
 * Draw a resampled set of trade PnLs into the reused `out` buffer (length n),
 * preserving the EXACT RNG draw order of {@link resampleTrades} so the
 * resampled Sharpe distribution is value-identical to the previous
 * full-object resampling path.
 *
 *   - i.i.d. mode (blockSize <= 1): n calls to rng(), filling positions 0..n-1.
 *   - block mode (blockSize > 1): one rng() per block start, then consecutive
 *     pnls copied index-by-index (no slice/spread), output truncated to n.
 */
function drawResampledPnls(
  trades: BacktestTrade[],
  rng: () => number,
  blockSize: number,
  out: number[],
): void {
  const n = trades.length;

  if (blockSize <= 1) {
    // Standard i.i.d. bootstrap: one rng() draw per output position (same
    // sequence as Array.from({ length: n }, () => trades[floor(rng()*n)])).
    for (let i = 0; i < n; i++) {
      out[i] = trades[Math.floor(rng() * n)].pnl;
    }
    return;
  }

  // Block bootstrap: mirror resampleTrades' draw order (one rng() per block
  // start), copying pnls into the buffer until n positions are filled.
  let filled = 0;
  while (filled < n) {
    const start = Math.floor(rng() * n);
    const blockEnd = Math.min(start + blockSize, n);
    for (let j = start; j < blockEnd && filled < n; j++) {
      out[filled++] = trades[j].pnl;
    }
  }
}

/**
 * Compute the resampled Sharpe from a pnl buffer, replicating EXACTLY the value
 * that calculatePerformance(...).sharpeRatio produces for the equivalent trade
 * list.
 *
 * INVARIANT: this MUST stay in lockstep with performance.ts —
 * tradePnlReturns (per-trade ret = equity>0 ? pnl/equity : 0, then equity+=pnl),
 * computeSharpe (length<2 -> 0; mean; variance with (n-1) denom; stdDev;
 * stdDev===0 -> 0; (mean/stdDev)*sqrt(365)), and r2 (Math.round(n*100)/100).
 * A divergence silently corrupts the robustness gate (CI bounds,
 * positiveSharpeRate boundary, isRobust) and breaks determinism.
 */
function resampleSharpe(pnls: number[], startingEquity: number): number {
  const n = pnls.length;
  if (n < 2) return 0;

  // tradePnlReturns + computeSharpe, fused into a single O(N) pass for the mean.
  let equity = startingEquity;
  let mean = 0;
  // Reuse the returns to avoid recomputing equity progression for the variance.
  const returns = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const ret = equity > 0 ? pnls[i] / equity : 0;
    returns[i] = ret;
    mean += ret;
    equity += pnls[i];
  }
  mean /= n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = returns[i] - mean;
    variance += d * d;
  }
  variance /= n - 1;

  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;

  // Annualize assuming ~365 trades/year, then r2-round to match metrics.sharpeRatio.
  return Math.round((mean / stdDev) * Math.sqrt(365) * 100) / 100;
}

/** Build equity curve from a trade list. */
function buildEquityCurve(trades: BacktestTrade[], startingEquity: number): number[] {
  const curve = [startingEquity];
  let equity = startingEquity;
  for (const t of trades) {
    equity += t.pnl;
    curve.push(equity);
  }
  return curve;
}

/**
 * Extract a percentile value from a SORTED array using linear interpolation.
 * p = 0.025 → 2.5th percentile; p = 0.975 → 97.5th percentile.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Simple seeded PRNG (mulberry32). Deterministic for the given 32-bit seed.
 * Produces values in [0, 1).
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
