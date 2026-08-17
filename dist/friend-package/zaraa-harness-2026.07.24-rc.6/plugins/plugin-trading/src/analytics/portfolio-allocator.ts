import type { Allocation } from "./allocation-optimizer.js";

export class PortfolioAllocator {
  private allocation: Allocation | null = null;
  private minScalar: number;
  private maxScalar: number;

  constructor(opts: { minScalar?: number; maxScalar?: number } = {}) {
    this.minScalar = opts.minScalar ?? 0.5;
    this.maxScalar = opts.maxScalar ?? 1.5;
  }

  setAllocation(allocation: Allocation): void {
    this.allocation = allocation;
  }

  getAllocation(): Allocation | null {
    return this.allocation;
  }

  getPositionScalar(symbol: string, currentWeights: Record<string, number>): number {
    if (!this.allocation) return 1.0;
    const targetWeight = this.allocation.weights[symbol];
    if (targetWeight === undefined) return 1.0;
    const currentWeight = currentWeights[symbol] ?? 0;
    const diff = targetWeight - currentWeight;
    const raw = 1.0 + diff * 2;
    return Math.max(this.minScalar, Math.min(this.maxScalar, Math.round(raw * 1000) / 1000));
  }
}
