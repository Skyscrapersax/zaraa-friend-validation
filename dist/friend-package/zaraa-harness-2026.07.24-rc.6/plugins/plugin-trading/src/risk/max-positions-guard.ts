import { z } from "zod";

const MaxPositionsConfigSchema = z.object({
  maxOpenPositions: z.number().int().min(1).default(5),
  maxPerSymbol: z.number().int().min(1).default(1),
  maxPerExchange: z.number().int().min(1).default(3),
});

export type MaxPositionsConfig = z.infer<typeof MaxPositionsConfigSchema>;

export interface PositionInfo {
  symbol: string;
  exchange: string;
}

export interface PositionCheckResult {
  allowed: boolean;
  reason?: string;
}

export class MaxPositionsGuard {
  private readonly config: MaxPositionsConfig;

  constructor(config?: Partial<z.input<typeof MaxPositionsConfigSchema>>) {
    this.config = MaxPositionsConfigSchema.parse(config ?? {});
  }

  canOpenPosition(
    params: PositionInfo,
    currentPositions: PositionInfo[],
  ): PositionCheckResult {
    // Check total open positions
    if (currentPositions.length >= this.config.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Max open positions reached (${currentPositions.length}/${this.config.maxOpenPositions}). Close an existing position first.`,
      };
    }

    // Check per-symbol limit
    const sameSymbol = currentPositions.filter(
      (p) => p.symbol === params.symbol,
    ).length;
    if (sameSymbol >= this.config.maxPerSymbol) {
      return {
        allowed: false,
        reason: `Max positions for ${params.symbol} reached (${sameSymbol}/${this.config.maxPerSymbol}).`,
      };
    }

    // Check per-exchange limit
    const sameExchange = currentPositions.filter(
      (p) => p.exchange === params.exchange,
    ).length;
    if (sameExchange >= this.config.maxPerExchange) {
      return {
        allowed: false,
        reason: `Max positions on ${params.exchange} reached (${sameExchange}/${this.config.maxPerExchange}).`,
      };
    }

    return { allowed: true };
  }
}
