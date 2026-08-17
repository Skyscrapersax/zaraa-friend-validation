import { z } from "zod";

const ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minTrades: z.number().int().positive().default(10),
  topN: z.number().int().positive().default(3),
  performanceMetric: z.enum(["sharpe", "winRate", "totalPnl", "profitFactor"]).default("sharpe"),
});

export type StrategyRotatorConfig = z.infer<typeof ConfigSchema>;

export interface StrategyStats {
  name: string;
  trades: number;
  pnl: number;
  winRate: number;
  sharpe: number;
  profitFactor: number;
}

export interface StrategyAllocation {
  strategyName: string;
  allocationPct: number;
  rank: number;
  score: number;
  tradeCount: number;
}
export interface RotationResult {
  timestamp: string;
  active: StrategyAllocation[];
  deactivated: string[];
  reason: string;
}

export class StrategyRotator {
  private config: StrategyRotatorConfig;
  private lastRotation: RotationResult | null = null;
  private activeStrategies: StrategyAllocation[] = [];

  constructor(config?: Partial<StrategyRotatorConfig>) {
    this.config = ConfigSchema.parse(config ?? {});
  }

  evaluate(strategies: StrategyStats[]): RotationResult {
    const eligible = strategies.filter(s => s.trades >= this.config.minTrades);
    
    if (eligible.length === 0) {
      const result: RotationResult = {
        timestamp: new Date().toISOString(),
        active: [],
        deactivated: strategies.map(s => s.name),
        reason: `No strategies meet minimum trade threshold (${this.config.minTrades})`,
      };
      this.lastRotation = result;
      this.activeStrategies = [];
      return result;
    }
    // Score and rank
    const scored = eligible
      .map(s => ({ ...s, score: this.getScore(s) }))
      .sort((a, b) => b.score - a.score);

    const topN = scored.slice(0, this.config.topN);
    const totalScore = topN.reduce((sum, s) => sum + Math.max(s.score, 0.01), 0);

    const active: StrategyAllocation[] = topN.map((s, i) => ({
      strategyName: s.name,
      allocationPct: Math.round((Math.max(s.score, 0.01) / totalScore) * 100 * 10) / 10,
      rank: i + 1,
      score: Math.round(s.score * 1000) / 1000,
      tradeCount: s.trades,
    }));

    const activeNames = new Set(active.map(a => a.strategyName));
    const deactivated = strategies.filter(s => !activeNames.has(s.name)).map(s => s.name);

    const result: RotationResult = {
      timestamp: new Date().toISOString(),
      active,
      deactivated,
      reason: `Top ${this.config.topN} by ${this.config.performanceMetric}`,
    };
    this.lastRotation = result;
    this.activeStrategies = active;
    return result;
  }

  getActiveStrategies(): StrategyAllocation[] {
    return [...this.activeStrategies];
  }

  getLastRotation(): RotationResult | null {
    return this.lastRotation;
  }

  isActive(strategyName: string): boolean {
    return this.activeStrategies.some(s => s.strategyName === strategyName);
  }

  private getScore(s: StrategyStats): number {
    switch (this.config.performanceMetric) {
      case "sharpe": return s.sharpe;
      case "winRate": return s.winRate;
      case "totalPnl": return s.pnl;
      case "profitFactor": return s.profitFactor;
    }
  }
}