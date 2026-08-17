import { z } from "zod";

export const FlashCrashConfigSchema = z.object({
  /** Price drop threshold in percent to trigger flash crash detection (default: 10%) */
  dropThresholdPct: z.number().positive().default(10),
  /** Rolling window in milliseconds (default: 300000 = 5 minutes) */
  windowMs: z.number().positive().default(300_000),
  /** Minimum data points required before detection is active (default: 5) */
  minDataPoints: z.number().int().positive().default(5),
});

export type FlashCrashConfig = z.infer<typeof FlashCrashConfigSchema>;

export interface FlashCrashResult {
  detected: boolean;
  dropPct: number;
  windowMs: number;
  recommendation: "flatten" | "widen_stops" | "none";
}

export interface FlashCrashEvent {
  symbol: string;
  dropPct: number;
  windowMs: number;
  recommendation: "flatten" | "widen_stops";
  highPrice: number;
  lowPrice: number;
  timestamp: number;
}

interface PricePoint {
  price: number;
  timestamp: number;
}

export class FlashCrashDetector {
  private config: FlashCrashConfig;
  private priceWindows = new Map<string, PricePoint[]>();
  private listeners: Array<(event: FlashCrashEvent) => void> = [];

  constructor(config?: Partial<FlashCrashConfig>) {
    this.config = FlashCrashConfigSchema.parse(config ?? {});
  }

  /** Register a listener for flash crash events. */
  on(listener: (event: FlashCrashEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Remove a previously registered listener. */
  off(listener: (event: FlashCrashEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Record a price observation for a symbol.
   * Prices outside the rolling window are pruned automatically.
   */
  recordPrice(symbol: string, price: number, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    if (!Number.isFinite(price) || price <= 0) return;

    let window = this.priceWindows.get(symbol);
    if (!window) {
      window = [];
      this.priceWindows.set(symbol, window);
    }

    window.push({ price, timestamp: ts });

    // Prune entries outside the rolling window
    const cutoff = ts - this.config.windowMs;
    while (window.length > 0 && window[0].timestamp < cutoff) {
      window.shift();
    }
  }

  /**
   * Check whether a flash crash is occurring for the given symbol.
   *
   * Compares the highest price in the rolling window to the most recent price.
   * - If drop > dropThresholdPct   -> detected=true, recommendation='flatten'
   * - If drop > dropThresholdPct/2 -> detected=false, recommendation='widen_stops'
   * - Otherwise                    -> detected=false, recommendation='none'
   *
   * Emits a FlashCrashEvent when a crash is detected.
   */
  checkFlashCrash(symbol: string): FlashCrashResult {
    const window = this.priceWindows.get(symbol);

    if (!window || window.length < this.config.minDataPoints) {
      return { detected: false, dropPct: 0, windowMs: this.config.windowMs, recommendation: "none" };
    }

    let highPrice = -Infinity;
    for (const point of window) {
      if (point.price > highPrice) highPrice = point.price;
    }

    const latestPrice = window[window.length - 1].price;
    const dropPct = ((highPrice - latestPrice) / highPrice) * 100;

    if (dropPct >= this.config.dropThresholdPct) {
      const event: FlashCrashEvent = {
        symbol,
        dropPct,
        windowMs: this.config.windowMs,
        recommendation: "flatten",
        highPrice,
        lowPrice: latestPrice,
        timestamp: window[window.length - 1].timestamp,
      };
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* swallow listener errors */ }
      }
      return { detected: true, dropPct, windowMs: this.config.windowMs, recommendation: "flatten" };
    }

    if (dropPct >= this.config.dropThresholdPct / 2) {
      return { detected: false, dropPct, windowMs: this.config.windowMs, recommendation: "widen_stops" };
    }

    return { detected: false, dropPct, windowMs: this.config.windowMs, recommendation: "none" };
  }

  /** Clear all recorded prices for a symbol (or all symbols if none specified). */
  reset(symbol?: string): void {
    if (symbol) {
      this.priceWindows.delete(symbol);
    } else {
      this.priceWindows.clear();
    }
  }

  /** Get current config (read-only copy). */
  getConfig(): FlashCrashConfig {
    return { ...this.config };
  }
}
