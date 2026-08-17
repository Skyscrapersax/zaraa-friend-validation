import { z } from "zod";

const FngResponseSchema = z.object({
  data: z.array(z.object({
    value: z.string(),
    value_classification: z.string(),
    timestamp: z.string(),
  })).min(1),
});

const ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cacheTtlMs: z.number().int().positive().default(4 * 60 * 60 * 1000), // 4 hours
  extremeFearThreshold: z.number().int().default(25),
  fearThreshold: z.number().int().default(45),
  greedThreshold: z.number().int().default(55),
  extremeGreedThreshold: z.number().int().default(75),
  blockLongsAbove: z.number().int().default(75), // block new longs in Extreme Greed
});

export type SentimentConfig = z.infer<typeof ConfigSchema>;

export type SentimentZone = "EXTREME_FEAR" | "FEAR" | "NEUTRAL" | "GREED" | "EXTREME_GREED";

export interface SentimentReading {
  value: number;
  zone: SentimentZone;  classification: string;
  timestamp: string;
  fetchedAt: string;
}

export interface SentimentSignalResult {
  allowed: boolean;
  reason: string;
  sentiment: SentimentReading | null;
}

export class SentimentSignal {
  private config: SentimentConfig;
  private cached: SentimentReading | null = null;
  private lastFetchMs = 0;
  private fetchFn: () => Promise<Response>;

  constructor(config?: Partial<SentimentConfig>, fetchFn?: () => Promise<Response>) {
    this.config = ConfigSchema.parse(config ?? {});
    this.fetchFn = fetchFn ?? (() => fetch("https://api.alternative.me/fng/?limit=1"));
  }

  /** Get current sentiment, using cache if fresh enough */
  async getSentiment(): Promise<SentimentReading | null> {
    if (this.cached && Date.now() - this.lastFetchMs < this.config.cacheTtlMs) {
      return this.cached;
    }

    try {
      const response = await this.fetchFn();
      const json = await response.json();
      const parsed = FngResponseSchema.parse(json);
      const entry = parsed.data[0];
      const value = parseInt(entry.value, 10);

      this.cached = {
        value,
        zone: this.classifyZone(value),
        classification: entry.value_classification,
        timestamp: entry.timestamp,
        fetchedAt: new Date().toISOString(),
      };
      this.lastFetchMs = Date.now();
      return this.cached;
    } catch (err) {
      console.warn("[SentimentSignal] Failed to fetch Fear & Greed index:", err instanceof Error ? err.message : err);
      return this.cached; // Return stale data if available
    }
  }

  /** Check if a long entry is allowed based on sentiment */
  async checkLongEntry(): Promise<SentimentSignalResult> {    if (!this.config.enabled) {
      return { allowed: true, reason: "Sentiment check disabled", sentiment: null };
    }

    const sentiment = await this.getSentiment();
    if (!sentiment) {
      return { allowed: true, reason: "No sentiment data available", sentiment: null };
    }

    if (sentiment.value >= this.config.blockLongsAbove) {
      return {
        allowed: false,
        reason: `Long entry blocked: ${sentiment.zone} (${sentiment.value}) exceeds threshold ${this.config.blockLongsAbove}`,
        sentiment,
      };
    }

    return { allowed: true, reason: `Sentiment OK: ${sentiment.zone} (${sentiment.value})`, sentiment };
  }

  /** Check if conditions favor buying (contrarian: Extreme Fear = opportunity) */
  async isBuyOpportunity(): Promise<{ opportunity: boolean; sentiment: SentimentReading | null }> {
    const sentiment = await this.getSentiment();
    if (!sentiment) return { opportunity: false, sentiment: null };
    return {      opportunity: sentiment.value <= this.config.extremeFearThreshold,
      sentiment,
    };
  }

  private classifyZone(value: number): SentimentZone {
    if (value <= this.config.extremeFearThreshold) return "EXTREME_FEAR";
    if (value <= this.config.fearThreshold) return "FEAR";
    if (value <= this.config.greedThreshold) return "NEUTRAL";
    if (value <= this.config.extremeGreedThreshold) return "GREED";
    return "EXTREME_GREED";
  }

  /** Inject a reading for testing */
  setCachedReading(reading: SentimentReading): void {
    this.cached = reading;
    this.lastFetchMs = Date.now();
  }

  getConfig(): SentimentConfig {
    return { ...this.config };
  }
}