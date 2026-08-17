import { z } from "zod";

const WeightsSchema = z.object({
  health: z.number().min(0).max(1).default(0.4),
  slippage: z.number().min(0).max(1).default(0.3),
  fundingRate: z.number().min(0).max(1).default(0.2),
  fees: z.number().min(0).max(1).default(0.1),
});

const ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  exchanges: z.array(z.string()).default([]),
  weights: WeightsSchema.default({}),
});

export type ExecutionRouterConfig = z.infer<typeof ConfigSchema>;

export interface ExchangeScores {
  exchange: string;
  healthScore: number;
  slippageScore: number;
  fundingScore: number;
  feeScore: number;
  totalScore: number;
}
export interface RouteDecision {
  exchange: string;
  score: number;
  reasons: string[];
  alternatives: { exchange: string; score: number }[];
}

export interface ExecutionRouterDeps {
  getHealthScore?: (exchange: string) => number; // 0-100
  getSlippageScore?: (exchange: string, symbol?: string) => number; // 0-100
  getFundingScore?: (exchange: string, symbol?: string) => number; // 0-100
  getFeeScore?: (exchange: string) => number; // 0-100
}

export class ExecutionRouter {
  private config: ExecutionRouterConfig;
  private deps: ExecutionRouterDeps;

  constructor(config?: Partial<ExecutionRouterConfig>, deps?: ExecutionRouterDeps) {
    this.config = ConfigSchema.parse(config ?? {});
    this.deps = deps ?? {};
  }
  route(symbol: string, side: "BUY" | "SELL", _sizeUsd: number): RouteDecision {
    if (this.config.exchanges.length === 0) {
      return { exchange: "default", score: 100, reasons: ["No exchanges configured"], alternatives: [] };
    }
    if (this.config.exchanges.length === 1) {
      return { exchange: this.config.exchanges[0], score: 100, reasons: ["Single exchange configured"], alternatives: [] };
    }

    const scores = this.getScores(symbol);
    const sorted = [...scores].sort((a, b) => b.totalScore - a.totalScore);
    const best = sorted[0];

    const reasons: string[] = [];
    if (best.healthScore >= 80) reasons.push("healthy exchange");
    if (best.slippageScore >= 70) reasons.push("low slippage");
    if (best.fundingScore >= 70) reasons.push("favorable funding");
    if (best.feeScore >= 70) reasons.push("competitive fees");

    return {
      exchange: best.exchange,
      score: Math.round(best.totalScore * 10) / 10,
      reasons: reasons.length > 0 ? reasons : ["best overall score"],
      alternatives: sorted.slice(1).map(s => ({ exchange: s.exchange, score: Math.round(s.totalScore * 10) / 10 })),
    };
  }
  getScores(symbol: string): ExchangeScores[] {
    const w = this.config.weights;
    return this.config.exchanges.map(exchange => {
      const healthScore = this.deps.getHealthScore?.(exchange) ?? 50;
      const slippageScore = this.deps.getSlippageScore?.(exchange, symbol) ?? 50;
      const fundingScore = this.deps.getFundingScore?.(exchange, symbol) ?? 50;
      const feeScore = this.deps.getFeeScore?.(exchange) ?? 50;

      const totalScore = healthScore * w.health + slippageScore * w.slippage + fundingScore * w.fundingRate + feeScore * w.fees;

      return { exchange, healthScore, slippageScore, fundingScore, feeScore, totalScore };
    });
  }
}