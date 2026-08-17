import { z } from "zod";

const EventTypeSchema = z.enum([
  "trade_executed", "trade_rejected", "signal_generated", "signal_confirmed",
  "signal_rejected", "risk_check_passed", "risk_check_failed",
  "kill_switch_activated", "drawdown_alert", "strategy_switch",
  "position_opened", "position_closed",
]);

export type TradingEventType = z.infer<typeof EventTypeSchema>;

const ConfigSchema = z.object({
  maxAgeDays: z.number().int().positive().default(90),
  maxEntries: z.number().int().positive().default(500_000),
});

export type EventLogConfig = z.infer<typeof ConfigSchema>;

export interface TradingEvent {
  id: string;
  timestamp: string;
  eventType: TradingEventType;
  payload: Record<string, unknown>;
  sessionId?: string;
  symbol?: string;
}

export class TradingEventLog {
  private events: TradingEvent[] = [];
  private config: EventLogConfig;
  private counter = 0;

  constructor(config?: Partial<EventLogConfig>) {
    this.config = ConfigSchema.parse(config ?? {});
  }

  append(eventType: TradingEventType, payload: Record<string, unknown>, opts?: { sessionId?: string; symbol?: string }): TradingEvent {
    const event: TradingEvent = {
      id: `evt_${Date.now()}_${++this.counter}`,
      timestamp: new Date().toISOString(),
      eventType,
      payload,
      sessionId: opts?.sessionId,
      symbol: opts?.symbol,
    };
    this.events.push(event);
    this.enforceRetention();
    return event;
  }

  query(filter: {
    eventType?: TradingEventType | TradingEventType[];
    symbol?: string;
    sessionId?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): TradingEvent[] {
    let results = this.events;

    if (filter.eventType) {
      const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
      results = results.filter(e => types.includes(e.eventType));
    }
    if (filter.symbol) results = results.filter(e => e.symbol === filter.symbol);
    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.sinceMs) {
      const since = new Date(filter.sinceMs).toISOString();
      results = results.filter(e => e.timestamp >= since);
    }
    if (filter.untilMs) {
      const until = new Date(filter.untilMs).toISOString();
      results = results.filter(e => e.timestamp <= until);
    }
    if (filter.limit) results = results.slice(-filter.limit);
    return results;
  }

  exportJson(filter?: Parameters<TradingEventLog["query"]>[0]): string {
    const events = filter ? this.query(filter) : this.events;
    return JSON.stringify(events, null, 2);
  }

  getCount(): number {
    return this.events.length;
  }

  getEventTypes(): TradingEventType[] {
    return [...new Set(this.events.map(e => e.eventType))];
  }

  private enforceRetention(): void {
    // Cap by entry count
    if (this.events.length > this.config.maxEntries) {
      this.events.splice(0, this.events.length - this.config.maxEntries);
    }
    // Cap by age
    const cutoff = new Date(Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    this.events = this.events.filter(e => e.timestamp >= cutoff);
  }
}
