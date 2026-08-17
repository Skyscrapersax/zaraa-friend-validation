import { z } from "zod";

const ConfigSchema = z.object({
  correlationThreshold: z.number().min(0).max(1).default(0.7),
  maxCorrelatedExposureMultiplier: z.number().min(1).max(10).default(2),
  minDataPoints: z.number().int().min(5).default(10),
  /**
   * Threshold above which a pair is treated as "correlated" for the
   * sizing-scale path (independent of the harder block threshold above).
   * 0.5 admits XRP↔XLM (0.6) and the BTC/ETH/SOL cluster while excluding
   * uncorrelated pairs that fall back to the 0.3 default.
   */
  correlationScaleThreshold: z.number().min(0).max(1).default(0.5),
});

/**
 * Static correlation table used as a fallback when live price history is
 * unavailable or below `minDataPoints`. Symbol identifiers are normalized to
 * the base asset (BTC_USDT → BTC, ETH/USD → ETH).
 */
const STATIC_CORRELATIONS: ReadonlyArray<readonly [string, string, number]> = [
  ["BTC", "ETH", 0.85],
  ["BTC", "SOL", 0.7],
  ["ETH", "SOL", 0.75],
  ["XRP", "XLM", 0.6],
];

const STATIC_DEFAULT_CORRELATION = 0.3;

function normalizeBaseAsset(symbol: string): string {
  return symbol.split(/[\/_\-:]/)[0].toUpperCase();
}

function lookupStaticCorrelation(a: string, b: string): number {
  const A = normalizeBaseAsset(a);
  const B = normalizeBaseAsset(b);
  if (A === B) return 1.0;
  for (const [x, y, c] of STATIC_CORRELATIONS) {
    if ((x === A && y === B) || (x === B && y === A)) return c;
  }
  return STATIC_DEFAULT_CORRELATION;
}

export type CorrelationGuardConfig = z.infer<typeof ConfigSchema>;

export interface PriceHistory {
  symbol: string;
  prices: number[]; // chronologically ordered
}

export interface CorrelationResult {
  symbol: string;
  correlation: number;
}

export interface CorrelationCheck {
  allowed: boolean;
  reason: string;
  correlations: CorrelationResult[];
  totalCorrelatedExposureUsd: number;
}
/**
 * Pearson correlation coefficient between two arrays of equal length.
 *
 * Returns NaN when correlation is undefined (length mismatch, n < 2,
 * non-finite inputs, or zero variance in either series). Callers must
 * detect NaN with Number.isFinite and fall back to a static correlation
 * — propagating NaN through sizing/exposure math would silently disable
 * the guard.
 */
function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n !== b.length || n < 2) return Number.NaN;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return Number.NaN;
  }

  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }

  if (denA === 0 || denB === 0) return Number.NaN;
  return num / Math.sqrt(denA * denB);
}
export class CorrelationGuard {
  private priceHistories: Map<string, number[]> = new Map();
  private config: CorrelationGuardConfig;

  constructor(config?: Partial<CorrelationGuardConfig>) {
    this.config = ConfigSchema.parse(config ?? {});
  }

  /** Update price history for a symbol */
  updatePrices(symbol: string, prices: number[]): void {
    this.priceHistories.set(symbol, prices);
  }

  /** Add a single price point to a symbol's history (rolling window) */
  addPrice(symbol: string, price: number, maxPoints = 30): void {
    const existing = this.priceHistories.get(symbol) ?? [];
    existing.push(price);
    if (existing.length > maxPoints) existing.splice(0, existing.length - maxPoints);
    this.priceHistories.set(symbol, existing);
  }
  /**
   * Check if a new trade would create excessive correlated exposure.
   */
  checkCorrelation(
    symbol: string,
    existingPositions: { symbol: string; sizeUsd: number }[],
    newPositionSizeUsd: number,
    maxSinglePositionUsd: number,
  ): CorrelationCheck {
    const newPrices = this.priceHistories.get(symbol);
    const correlations: CorrelationResult[] = [];

    if (!newPrices || newPrices.length < this.config.minDataPoints) {
      return { allowed: true, reason: "Insufficient price data for correlation check", correlations, totalCorrelatedExposureUsd: 0 };
    }

    let correlatedExposure = newPositionSizeUsd;

    for (const pos of existingPositions) {
      if (pos.symbol === symbol) {
        correlatedExposure += Math.abs(pos.sizeUsd);
        correlations.push({ symbol: pos.symbol, correlation: 1.0 });
        continue;
      }
      const posPrices = this.priceHistories.get(pos.symbol);
      if (!posPrices || posPrices.length < this.config.minDataPoints) continue;

      // Align lengths
      const minLen = Math.min(newPrices.length, posPrices.length);
      const a = newPrices.slice(-minLen);
      const b = posPrices.slice(-minLen);

      const rawCorr = pearsonCorrelation(a, b);
      // Live Pearson is undefined on zero-variance / NaN inputs (e.g.
      // a flat-priced sentinel series). Fall back to the static table
      // so a degenerate price feed can't silently disable the guard.
      const corr = Number.isFinite(rawCorr) ? rawCorr : lookupStaticCorrelation(symbol, pos.symbol);
      correlations.push({ symbol: pos.symbol, correlation: Math.round(corr * 1000) / 1000 });

      if (Math.abs(corr) >= this.config.correlationThreshold) {
        correlatedExposure += Math.abs(pos.sizeUsd) * Math.abs(corr);
      }
    }

    const maxAllowed = maxSinglePositionUsd * this.config.maxCorrelatedExposureMultiplier;
    if (correlatedExposure > maxAllowed) {
      const highCorr = correlations.filter(c => Math.abs(c.correlation) >= this.config.correlationThreshold);
      const names = highCorr.map(c => `${c.symbol}(${c.correlation})`).join(", ");
      return {
        allowed: false,
        reason: `Correlated exposure $${correlatedExposure.toFixed(0)} exceeds limit $${maxAllowed.toFixed(0)}. High correlations: ${names}`,
        correlations,
        totalCorrelatedExposureUsd: correlatedExposure,
      };
    }

    return { allowed: true, reason: "ok", correlations, totalCorrelatedExposureUsd: correlatedExposure };
  }
  /**
   * Compute a position-size scale factor (0.0–1.0) based on correlated open
   * exposure. Falls back to a static correlation table when live price history
   * is unavailable.
   *
   *   No correlated same-direction positions       → 1.0
   *   1 correlated same-direction position         → 0.5
   *   2+ correlated same-direction positions       → 0.25
   *   Correlated opposite-direction (natural hedge)→ does not reduce scale
   */
  getCorrelationScale(
    newSymbol: string,
    newDirection: "long" | "short",
    existingPositions: { symbol: string; direction: "long" | "short" }[],
  ): number {
    const threshold = this.config.correlationScaleThreshold;
    let stackedCount = 0;

    for (const pos of existingPositions) {
      const corr = this.correlationFor(newSymbol, pos.symbol);
      if (Math.abs(corr) < threshold) continue;

      // For positive correlation: same direction stacks exposure.
      // For negative correlation: opposite direction stacks exposure.
      const isStackingExposure =
        corr >= 0 ? pos.direction === newDirection : pos.direction !== newDirection;
      if (isStackingExposure) stackedCount++;
    }

    if (stackedCount === 0) return 1.0;
    if (stackedCount === 1) return 0.5;
    return 0.25;
  }

  /** Best-effort correlation: live Pearson if both series have enough data, else static table. */
  private correlationFor(a: string, b: string): number {
    if (normalizeBaseAsset(a) === normalizeBaseAsset(b)) return 1.0;
    const pa = this.priceHistories.get(a);
    const pb = this.priceHistories.get(b);
    if (pa && pb && pa.length >= this.config.minDataPoints && pb.length >= this.config.minDataPoints) {
      const minLen = Math.min(pa.length, pb.length);
      const corr = pearsonCorrelation(pa.slice(-minLen), pb.slice(-minLen));
      if (Number.isFinite(corr)) return corr;
    }
    return lookupStaticCorrelation(a, b);
  }

  /** Get correlation matrix for all tracked symbols */
  getCorrelationMatrix(): { symbols: string[]; matrix: number[][] } {
    const symbols = [...this.priceHistories.keys()];
    const n = symbols.length;

    // Pearson, minLen, the minDataPoints->0 guard, and the static fallback are
    // all symmetric in (a,b), so the matrix is symmetric. Compute only the
    // upper triangle (one slice-pair + one Pearson pass per unordered pair) and
    // mirror into both cells — halves the constant factor on this O(S^2) path
    // while keeping the output byte-identical to the prior all-ordered-pairs loop.
    const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n));

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      const a = symbols[i];
      const pa = this.priceHistories.get(a)!;
      for (let j = i + 1; j < n; j++) {
        const b = symbols[j];
        const pb = this.priceHistories.get(b)!;
        const minLen = Math.min(pa.length, pb.length);
        let value: number;
        if (minLen < this.config.minDataPoints) {
          value = 0;
        } else {
          const rawCorr = pearsonCorrelation(pa.slice(-minLen), pb.slice(-minLen));
          const corr = Number.isFinite(rawCorr) ? rawCorr : lookupStaticCorrelation(a, b);
          value = Math.round(corr * 1000) / 1000;
        }
        matrix[i][j] = value;
        matrix[j][i] = value;
      }
    }

    return { symbols, matrix };
  }
}