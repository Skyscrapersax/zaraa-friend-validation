import { z } from "zod";

const ConfigSchema = z.object({
  latencyDegradedMs: z.number().positive().default(2000),
  latencyUnhealthyMs: z.number().positive().default(5000),
  errorRateDegradedPct: z.number().min(0).max(100).default(10),
  errorRateUnhealthyPct: z.number().min(0).max(100).default(25),
  windowMs: z.number().int().positive().default(5 * 60 * 1000),
  positionSizeReductionPct: z.number().min(0).max(100).default(50),
  stopWidenMultiplier: z.number().min(1).max(3).default(1.5),
});

export type ExchangeHealthConfig = z.infer<typeof ConfigSchema>;

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

export interface ExchangeHealth {
  exchange: string;
  status: HealthStatus;
  avgLatencyMs: number;
  errorRatePct: number;
  rateLimitRemaining: number | null;
  callCount: number;
  lastChecked: string;
  adjustments: {    positionSizeMultiplier: number;
    stopLossMultiplier: number;
    tradingPaused: boolean;
  };
}

interface CallRecord {
  timestampMs: number;
  latencyMs: number;
  success: boolean;
  rateLimitRemaining?: number;
}

export class ExchangeHealthMonitor {
  private calls: Map<string, CallRecord[]> = new Map();
  private config: ExchangeHealthConfig;
  private onStatusChange?: (exchange: string, health: ExchangeHealth) => void;

  constructor(config?: Partial<ExchangeHealthConfig>, onStatusChange?: (exchange: string, health: ExchangeHealth) => void) {
    this.config = ConfigSchema.parse(config ?? {});
    this.onStatusChange = onStatusChange;
  }
  recordCall(exchange: string, latencyMs: number, success: boolean, rateLimitRemaining?: number): void {
    if (!this.calls.has(exchange)) this.calls.set(exchange, []);
    const records = this.calls.get(exchange)!;
    records.push({ timestampMs: Date.now(), latencyMs, success, rateLimitRemaining });
    // Prune old records
    const cutoff = Date.now() - this.config.windowMs;
    const pruned = records.filter(r => r.timestampMs >= cutoff);
    this.calls.set(exchange, pruned);
  }

  getHealth(exchange: string): ExchangeHealth {
    const records = this.getRecentRecords(exchange);
    const status = this.computeStatus(records);
    const avgLatency = records.length > 0
      ? records.reduce((s, r) => s + r.latencyMs, 0) / records.length
      : 0;
    const errorRate = records.length > 0
      ? (records.filter(r => !r.success).length / records.length) * 100
      : 0;
    const lastRateLimit = records.length > 0
      ? records[records.length - 1].rateLimitRemaining ?? null
      : null;
    const adjustments = this.getAdjustments(status);

    return {
      exchange,
      status,
      avgLatencyMs: Math.round(avgLatency),
      errorRatePct: Math.round(errorRate * 10) / 10,
      rateLimitRemaining: lastRateLimit,
      callCount: records.length,
      lastChecked: new Date().toISOString(),
      adjustments,
    };
  }

  getAllHealth(): ExchangeHealth[] {
    return [...this.calls.keys()].map(ex => this.getHealth(ex));
  }

  private getRecentRecords(exchange: string): CallRecord[] {
    const records = this.calls.get(exchange) ?? [];
    const cutoff = Date.now() - this.config.windowMs;
    return records.filter(r => r.timestampMs >= cutoff);
  }
  private computeStatus(records: CallRecord[]): HealthStatus {
    if (records.length === 0) return "HEALTHY";

    const avgLatency = records.reduce((s, r) => s + r.latencyMs, 0) / records.length;
    const errorRate = (records.filter(r => !r.success).length / records.length) * 100;

    if (avgLatency >= this.config.latencyUnhealthyMs || errorRate >= this.config.errorRateUnhealthyPct) {
      return "UNHEALTHY";
    }
    if (avgLatency >= this.config.latencyDegradedMs || errorRate >= this.config.errorRateDegradedPct) {
      return "DEGRADED";
    }
    return "HEALTHY";
  }

  private getAdjustments(status: HealthStatus): ExchangeHealth["adjustments"] {
    switch (status) {
      case "HEALTHY":
        return { positionSizeMultiplier: 1, stopLossMultiplier: 1, tradingPaused: false };
      case "DEGRADED":
        return {
          positionSizeMultiplier: 1 - (this.config.positionSizeReductionPct / 100),
          stopLossMultiplier: this.config.stopWidenMultiplier,
          tradingPaused: false,        };
      case "UNHEALTHY":
        return { positionSizeMultiplier: 0, stopLossMultiplier: 1, tradingPaused: true };
    }
  }
}