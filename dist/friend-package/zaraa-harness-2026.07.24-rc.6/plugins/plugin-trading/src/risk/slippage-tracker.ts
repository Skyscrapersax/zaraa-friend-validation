import { z } from "zod";

const ConfigSchema = z.object({
  alertThresholdPct: z.number().min(0).max(100).default(0.5),
  maxHistory: z.number().int().positive().default(10_000),
});

export type SlippageConfig = z.infer<typeof ConfigSchema>;

export interface SlippageRecord {
  symbol: string;
  exchange: string;
  expectedPrice: number;
  actualPrice: number;
  slippagePct: number;
  slippageAbs: number;
  side: "BUY" | "SELL";
  timestampMs: number;
  qty: number;
}

export interface SlippageStats {
  totalTrades: number;
  meanSlippagePct: number;
  maxSlippagePct: number;  minSlippagePct: number;
  medianSlippagePct: number;
  alertCount: number;
  byExchange: Record<string, { count: number; meanPct: number; maxPct: number }>;
  bySymbol: Record<string, { count: number; meanPct: number; maxPct: number }>;
}

export class SlippageTracker {
  private records: SlippageRecord[] = [];
  private config: SlippageConfig;
  private onAlert?: (record: SlippageRecord) => void;

  constructor(config?: Partial<SlippageConfig>, onAlert?: (record: SlippageRecord) => void) {
    this.config = ConfigSchema.parse(config ?? {});
    this.onAlert = onAlert;
  }

  recordTrade(input: {
    symbol: string;
    exchange: string;
    expectedPrice: number;
    actualPrice: number;
    side: "BUY" | "SELL";
    qty: number;
    timestampMs?: number;
  }): SlippageRecord {    const { symbol, exchange, expectedPrice, actualPrice, side, qty } = input;
    const slippageAbs = Math.abs(actualPrice - expectedPrice);
    // For buys, positive slippage = paid more; for sells, positive slippage = received less
    const slippagePct = expectedPrice > 0
      ? (side === "BUY"
        ? ((actualPrice - expectedPrice) / expectedPrice) * 100
        : ((expectedPrice - actualPrice) / expectedPrice) * 100)
      : 0;

    const record: SlippageRecord = {
      symbol,
      exchange,
      expectedPrice,
      actualPrice,
      slippagePct,
      slippageAbs,
      side,
      timestampMs: input.timestampMs ?? Date.now(),
      qty,
    };

    this.records.push(record);
    if (this.records.length > this.config.maxHistory) {
      this.records.splice(0, this.records.length - this.config.maxHistory);
    }
    if (Math.abs(slippagePct) >= this.config.alertThresholdPct) {
      console.warn(`[SlippageTracker] HIGH SLIPPAGE: ${symbol} on ${exchange} — ${slippagePct.toFixed(3)}% (threshold: ${this.config.alertThresholdPct}%)`);
      this.onAlert?.(record);
    }

    return record;
  }

  getStats(filter?: { symbol?: string; exchange?: string; sinceMs?: number }): SlippageStats {
    let filtered = this.records;
    if (filter?.symbol) filtered = filtered.filter(r => r.symbol === filter.symbol);
    if (filter?.exchange) filtered = filtered.filter(r => r.exchange === filter.exchange);
    if (filter?.sinceMs) filtered = filtered.filter(r => r.timestampMs >= filter.sinceMs!);

    if (filtered.length === 0) {
      return {
        totalTrades: 0, meanSlippagePct: 0, maxSlippagePct: 0, minSlippagePct: 0,
        medianSlippagePct: 0, alertCount: 0, byExchange: {}, bySymbol: {},
      };
    }

    const pcts = filtered.map(r => r.slippagePct);
    const sorted = [...pcts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const byExchange: Record<string, { count: number; meanPct: number; maxPct: number }> = {};
    const bySymbol: Record<string, { count: number; meanPct: number; maxPct: number }> = {};

    for (const r of filtered) {
      // By exchange
      if (!byExchange[r.exchange]) byExchange[r.exchange] = { count: 0, meanPct: 0, maxPct: 0 };
      byExchange[r.exchange].count++;
      byExchange[r.exchange].maxPct = Math.max(byExchange[r.exchange].maxPct, Math.abs(r.slippagePct));
      
      // By symbol
      if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { count: 0, meanPct: 0, maxPct: 0 };
      bySymbol[r.symbol].count++;
      bySymbol[r.symbol].maxPct = Math.max(bySymbol[r.symbol].maxPct, Math.abs(r.slippagePct));
    }

    // Calculate means
    for (const [ex, data] of Object.entries(byExchange)) {
      const exRecords = filtered.filter(r => r.exchange === ex);
      data.meanPct = exRecords.reduce((s, r) => s + r.slippagePct, 0) / exRecords.length;
    }
    for (const [sym, data] of Object.entries(bySymbol)) {
      const symRecords = filtered.filter(r => r.symbol === sym);
      data.meanPct = symRecords.reduce((s, r) => s + r.slippagePct, 0) / symRecords.length;
    }
    return {
      totalTrades: filtered.length,
      meanSlippagePct: pcts.reduce((s, p) => s + p, 0) / pcts.length,
      maxSlippagePct: Math.max(...pcts.map(Math.abs)),
      minSlippagePct: Math.min(...pcts.map(Math.abs)),
      medianSlippagePct: median,
      alertCount: filtered.filter(r => Math.abs(r.slippagePct) >= this.config.alertThresholdPct).length,
      byExchange,
      bySymbol,
    };
  }

  /** Get slippage score for a strategy (lower is better, 0-100 scale) */
  getStrategySlippageScore(filter?: { symbol?: string; exchange?: string }): number {
    const stats = this.getStats(filter);
    if (stats.totalTrades === 0) return 50; // neutral if no data
    // Score: 100 = no slippage, 0 = terrible slippage (>2%)
    const avgAbsSlippage = Math.abs(stats.meanSlippagePct);
    return Math.max(0, Math.min(100, 100 - (avgAbsSlippage * 50)));
  }

  getRecordCount(): number {
    return this.records.length;
  }
}