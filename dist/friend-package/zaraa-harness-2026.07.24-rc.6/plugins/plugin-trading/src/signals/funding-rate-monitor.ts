import { z } from "zod";

const ConfigSchema = z.object({
  alertThresholdPctPer8h: z.number().min(0).default(0.1),
  arbitrageMinDiffPct: z.number().min(0).default(0.05),
  maxHistory: z.number().int().positive().default(1000),
});

export type FundingRateConfig = z.infer<typeof ConfigSchema>;

export interface FundingRateEntry {
  symbol: string;
  exchange: string;
  rate: number; // as percentage per 8h period
  timestampMs: number;
  annualizedPct: number;
}

export interface FundingRateStats {
  symbol: string;
  exchange: string;
  currentRate: number;
  avg8h: number;
  avg24h: number;
  annualizedPct: number;  entryCount: number;
  isHighFunding: boolean;
}

export interface FundingArbitrage {
  symbol: string;
  longExchange: string; // exchange with lower funding (you'd go long here)
  shortExchange: string; // exchange with higher funding (you'd go short here)
  diffPct: number;
  annualizedDiffPct: number;
}

export class FundingRateMonitor {
  private entries: FundingRateEntry[] = [];
  private config: FundingRateConfig;
  private onAlert?: (stats: FundingRateStats) => void;

  constructor(config?: Partial<FundingRateConfig>, onAlert?: (stats: FundingRateStats) => void) {
    this.config = ConfigSchema.parse(config ?? {});
    this.onAlert = onAlert;
  }

  /** Record a funding rate observation */
  analyzeFundingRate(symbol: string, exchange: string, rate: number, timestampMs?: number): FundingRateEntry {
    const ts = timestampMs ?? Date.now();    const annualizedPct = rate * 3 * 365; // 3 periods per day * 365 days

    const entry: FundingRateEntry = { symbol, exchange, rate, timestampMs: ts, annualizedPct };
    this.entries.push(entry);

    // Enforce max history
    if (this.entries.length > this.config.maxHistory) {
      this.entries.splice(0, this.entries.length - this.config.maxHistory);
    }

    // Check alert threshold
    if (Math.abs(rate) >= this.config.alertThresholdPctPer8h) {
      const stats = this.getStats(symbol, exchange);
      if (stats) {
        console.warn(`[FundingRateMonitor] HIGH FUNDING: ${symbol} on ${exchange} — ${rate.toFixed(4)}% per 8h (annualized: ${annualizedPct.toFixed(1)}%)`);
        this.onAlert?.(stats);
      }
    }

    return entry;
  }

  /** Get stats for a specific symbol/exchange pair */
  getStats(symbol: string, exchange: string): FundingRateStats | null {
    const relevant = this.entries.filter(e => e.symbol === symbol && e.exchange === exchange);    if (relevant.length === 0) return null;

    const latest = relevant[relevant.length - 1];
    const now = latest.timestampMs;

    const last8h = relevant.filter(e => e.timestampMs >= now - 8 * 60 * 60 * 1000);
    const last24h = relevant.filter(e => e.timestampMs >= now - 24 * 60 * 60 * 1000);

    const avg8h = last8h.length > 0 ? last8h.reduce((s, e) => s + e.rate, 0) / last8h.length : latest.rate;
    const avg24h = last24h.length > 0 ? last24h.reduce((s, e) => s + e.rate, 0) / last24h.length : latest.rate;

    return {
      symbol,
      exchange,
      currentRate: latest.rate,
      avg8h: Math.round(avg8h * 10000) / 10000,
      avg24h: Math.round(avg24h * 10000) / 10000,
      annualizedPct: Math.round(latest.annualizedPct * 10) / 10,
      entryCount: relevant.length,
      isHighFunding: Math.abs(latest.rate) >= this.config.alertThresholdPctPer8h,
    };
  }

  /** Find arbitrage opportunities across exchanges */
  getArbitrageOpportunities(): FundingArbitrage[] {    // Get latest rate per symbol per exchange
    const latestRates: Map<string, Map<string, number>> = new Map();

    for (const entry of this.entries) {
      if (!latestRates.has(entry.symbol)) latestRates.set(entry.symbol, new Map());
      latestRates.get(entry.symbol)!.set(entry.exchange, entry.rate);
    }

    const opportunities: FundingArbitrage[] = [];

    for (const [symbol, exchanges] of latestRates) {
      const exchangeList = [...exchanges.entries()];
      for (let i = 0; i < exchangeList.length; i++) {
        for (let j = i + 1; j < exchangeList.length; j++) {
          const [exA, rateA] = exchangeList[i];
          const [exB, rateB] = exchangeList[j];
          const diff = Math.abs(rateA - rateB);

          if (diff >= this.config.arbitrageMinDiffPct) {
            const longExchange = rateA < rateB ? exA : exB;
            const shortExchange = rateA < rateB ? exB : exA;
            opportunities.push({
              symbol,
              longExchange,
              shortExchange,              diffPct: Math.round(diff * 10000) / 10000,
              annualizedDiffPct: Math.round(diff * 3 * 365 * 10) / 10,
            });
          }
        }
      }
    }

    return opportunities.sort((a, b) => b.diffPct - a.diffPct);
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}