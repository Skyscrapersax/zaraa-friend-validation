import { z } from "zod";

const GraduationStepSchema = z.object({
  minTradesCompleted: z.number().int().min(0),
  minWinRate: z.number().min(0).max(1),
  maxUsd: z.number().positive(),
});

const PositionGraduationConfigSchema = z.object({
  initialMaxUsd: z.number().positive().default(10),
  graduationSteps: z
    .array(GraduationStepSchema)
    .min(1)
    .default([
      { minTradesCompleted: 0, minWinRate: 0, maxUsd: 10 },
      { minTradesCompleted: 10, minWinRate: 0.4, maxUsd: 25 },
      { minTradesCompleted: 25, minWinRate: 0.45, maxUsd: 50 },
      { minTradesCompleted: 50, minWinRate: 0.5, maxUsd: 100 },
      { minTradesCompleted: 100, minWinRate: 0.5, maxUsd: 200 },
    ]),
});

export type GraduationStep = z.infer<typeof GraduationStepSchema>;
export type PositionGraduationConfig = z.infer<typeof PositionGraduationConfigSchema>;

export interface TradeStats {
  totalTrades: number;
  winRate: number;
}

export interface GraduationStatus {
  currentLevel: number;
  maxLevels: number;
  currentMaxUsd: number;
  nextLevel: {
    tradesNeeded: number;
    winRateNeeded: number;
    maxUsd: number;
  } | null;
}

export class PositionGraduation {
  private readonly config: PositionGraduationConfig;
  private lastLevel: number = -1;

  constructor(config?: Partial<z.input<typeof PositionGraduationConfigSchema>>) {
    this.config = PositionGraduationConfigSchema.parse(config ?? {});
  }

  /**
   * Returns the maximum allowed position size in USD based on the trader's
   * track record. Levels cannot be skipped — each step must be satisfied
   * in order.
   */
  getCurrentMaxUsd(stats: TradeStats): number {
    let level = 0;
    const steps = this.config.graduationSteps;

    for (let i = 1; i < steps.length; i++) {
      const step = steps[i];
      if (
        stats.totalTrades >= step.minTradesCompleted &&
        stats.winRate >= step.minWinRate
      ) {
        level = i;
      } else {
        break; // cannot skip levels
      }
    }

    if (level !== this.lastLevel && this.lastLevel !== -1) {
      console.log(
        `[PositionGraduation] Level transition ${this.lastLevel} → ${level} ` +
          `(maxUsd: ${steps[level].maxUsd}, trades: ${stats.totalTrades}, winRate: ${(stats.winRate * 100).toFixed(1)}%)`,
      );
    }
    this.lastLevel = level;
    return steps[level].maxUsd;
  }

  /**
   * Returns detailed graduation status including the current level,
   * current max USD, and what is needed for the next level.
   */
  getGraduationStatus(stats: TradeStats): GraduationStatus {
    const maxUsd = this.getCurrentMaxUsd(stats);
    const steps = this.config.graduationSteps;
    const currentLevel = steps.findIndex((s) => s.maxUsd === maxUsd);

    let nextLevel: GraduationStatus["nextLevel"] = null;
    if (currentLevel < steps.length - 1) {
      const next = steps[currentLevel + 1];
      nextLevel = {
        tradesNeeded: Math.max(0, next.minTradesCompleted - stats.totalTrades),
        winRateNeeded: next.minWinRate,
        maxUsd: next.maxUsd,
      };
    }

    return {
      currentLevel,
      maxLevels: steps.length,
      currentMaxUsd: maxUsd,
      nextLevel,
    };
  }
}
