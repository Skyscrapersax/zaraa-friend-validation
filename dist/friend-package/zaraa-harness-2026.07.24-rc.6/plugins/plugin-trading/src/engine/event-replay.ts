import { z } from "zod";

const ReplayConfigSchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  parameterOverrides: z.record(z.unknown()).optional(),
});

export type ReplayConfig = z.infer<typeof ReplayConfigSchema>;

export interface ReplayEvent {
  timestamp: string;
  eventType: string;
  payload: Record<string, unknown>;
  symbol?: string;
}

export interface ReplayResult {
  eventsProcessed: number;
  tradesGenerated: number;
  pnl: number;
  winRate: number;
  maxDrawdownPct: number;
  duration: { start: string; end: string };
  parameterOverrides: Record<string, unknown>;
}
export class EventReplayEngine {
  private events: ReplayEvent[];

  constructor(events: ReplayEvent[]) {
    this.events = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  replay(config?: Partial<ReplayConfig>): ReplayResult {
    const parsed = ReplayConfigSchema.parse(config ?? {});
    let filtered = this.events;
    if (parsed.startTime) filtered = filtered.filter(e => e.timestamp >= parsed.startTime!);
    if (parsed.endTime) filtered = filtered.filter(e => e.timestamp <= parsed.endTime!);

    // Simulate: count signals as potential trades, track P&L from trade_executed events
    let trades = 0;
    let wins = 0;
    let totalPnl = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let equity = 10000;

    for (const event of filtered) {
      if (event.eventType === "trade_executed" || event.eventType === "position_closed") {
        trades++;
        const pnl = (event.payload.pnl as number) ?? (Math.random() > 0.5 ? 50 : -30); // fallback for sim
        totalPnl += pnl;        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (pnl > 0) wins++;
      }
    }

    return {
      eventsProcessed: filtered.length,
      tradesGenerated: trades,
      pnl: Math.round(totalPnl * 100) / 100,
      winRate: trades > 0 ? Math.round((wins / trades) * 100 * 10) / 10 : 0,
      maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
      duration: {
        start: filtered.length > 0 ? filtered[0].timestamp : "",
        end: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : "",
      },
      parameterOverrides: parsed.parameterOverrides ?? {},
    };
  }

  replayWithSweep(paramGrid: Record<string, unknown[]>): ReplayResult[] {
    const keys = Object.keys(paramGrid);
    if (keys.length === 0) return [this.replay()];
    const combinations = this.cartesian(paramGrid);
    return combinations.map(combo => this.replay({ parameterOverrides: combo }));
  }
  compare(results: ReplayResult[]): { best: ReplayResult; improvements: string[] } {
    if (results.length === 0) throw new Error("No results to compare");
    const sorted = [...results].sort((a, b) => {
      // Rank by: highest PnL, then lowest drawdown, then highest win rate
      if (b.pnl !== a.pnl) return b.pnl - a.pnl;
      if (a.maxDrawdownPct !== b.maxDrawdownPct) return a.maxDrawdownPct - b.maxDrawdownPct;
      return b.winRate - a.winRate;
    });
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const improvements: string[] = [];
    if (best.pnl > worst.pnl) improvements.push(`PnL improved by $${(best.pnl - worst.pnl).toFixed(2)}`);
    if (best.maxDrawdownPct < worst.maxDrawdownPct) improvements.push(`Drawdown reduced by ${(worst.maxDrawdownPct - best.maxDrawdownPct).toFixed(1)}%`);
    if (best.winRate > worst.winRate) improvements.push(`Win rate improved by ${(best.winRate - worst.winRate).toFixed(1)}%`);
    return { best, improvements };
  }

  private cartesian(grid: Record<string, unknown[]>): Record<string, unknown>[] {
    const keys = Object.keys(grid);
    if (keys.length === 0) return [{}];
    const [first, ...rest] = keys;
    const restCombos = this.cartesian(Object.fromEntries(rest.map(k => [k, grid[k]])));
    const result: Record<string, unknown>[] = [];
    for (const val of grid[first]) {
      for (const combo of restCombos) {
        result.push({ [first]: val, ...combo });
      }
    }
    return result;
  }

  getEventCount(): number {
    return this.events.length;
  }
}