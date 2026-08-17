import { z } from "zod";

const ConfigSchema = z.object({
  defaultLimitPerMinute: z.number().int().positive().default(60),
  defaultLimitPer10s: z.number().int().positive().default(20),
  burstLimit: z.number().int().positive().default(5),
});

export type RateLimiterConfig = z.infer<typeof ConfigSchema>;

export interface RateLimitStatus {
  exchange: string;
  callsLastMinute: number;
  callsLast10s: number;
  callsLastSecond: number;
  limitPerMinute: number;
  limitPer10s: number;
  burstLimit: number;
  isThrottled: boolean;
  retryAfterMs: number;
}

interface ExchangeLimits {
  perMinute: number;
  per10s: number;
  burst: number;
}
export class ApiRateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private config: RateLimiterConfig;
  private customLimits: Map<string, ExchangeLimits> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = ConfigSchema.parse(config ?? {});
  }

  checkAndConsume(exchange: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    this.pruneOld(exchange, now);
    const ts = this.timestamps.get(exchange) ?? [];
    const limits = this.getLimits(exchange);

    const last1s = ts.filter(t => t >= now - 1000).length;
    if (last1s >= limits.burst) {
      return { allowed: false, retryAfterMs: 1000 - (now - ts[ts.length - limits.burst]) };
    }

    const last10s = ts.filter(t => t >= now - 10_000).length;
    if (last10s >= limits.per10s) {
      return { allowed: false, retryAfterMs: 10_000 - (now - ts[ts.length - limits.per10s]) };
    }

    const last60s = ts.filter(t => t >= now - 60_000).length;
    if (last60s >= limits.perMinute) {
      return { allowed: false, retryAfterMs: 60_000 - (now - ts[ts.length - limits.perMinute]) };
    }
    ts.push(now);
    this.timestamps.set(exchange, ts);
    return { allowed: true, retryAfterMs: 0 };
  }

  getStatus(exchange: string): RateLimitStatus {
    const now = Date.now();
    this.pruneOld(exchange, now);
    const ts = this.timestamps.get(exchange) ?? [];
    const limits = this.getLimits(exchange);

    const last1s = ts.filter(t => t >= now - 1000).length;
    const last10s = ts.filter(t => t >= now - 10_000).length;
    const last60s = ts.filter(t => t >= now - 60_000).length;

    const isThrottled = last1s >= limits.burst || last10s >= limits.per10s || last60s >= limits.perMinute;
    let retryAfterMs = 0;
    if (last1s >= limits.burst) retryAfterMs = Math.max(retryAfterMs, 1000);
    if (last10s >= limits.per10s) retryAfterMs = Math.max(retryAfterMs, 10_000);
    if (last60s >= limits.perMinute) retryAfterMs = Math.max(retryAfterMs, 60_000);

    return {
      exchange,
      callsLastMinute: last60s,
      callsLast10s: last10s,
      callsLastSecond: last1s,
      limitPerMinute: limits.perMinute,
      limitPer10s: limits.per10s,
      burstLimit: limits.burst,      isThrottled,
      retryAfterMs,
    };
  }

  setLimits(exchange: string, limits: { perMinute?: number; per10s?: number; burst?: number }): void {
    const current = this.getLimits(exchange);
    this.customLimits.set(exchange, {
      perMinute: limits.perMinute ?? current.perMinute,
      per10s: limits.per10s ?? current.per10s,
      burst: limits.burst ?? current.burst,
    });
  }

  private getLimits(exchange: string): ExchangeLimits {
    return this.customLimits.get(exchange) ?? {
      perMinute: this.config.defaultLimitPerMinute,
      per10s: this.config.defaultLimitPer10s,
      burst: this.config.burstLimit,
    };
  }

  private pruneOld(exchange: string, now: number): void {
    const ts = this.timestamps.get(exchange);
    if (!ts) return;
    const cutoff = now - 60_000;
    const pruned = ts.filter(t => t >= cutoff);
    this.timestamps.set(exchange, pruned);
  }
}