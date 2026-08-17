/**
 * TradeNotifier — formats trade alerts and determines escalation.
 *
 * Produces human-readable messages for trade lifecycle events and
 * identifies critical situations that warrant iMessage escalation.
 */

export interface TradeEvent {
  type: "open" | "close" | "stop_triggered" | "flash_crash" | "circuit_break";
  symbol: string;
  details: Record<string, unknown>;
}

export class TradeNotifier {
  /**
   * Format a trade event into a human-readable alert message.
   */
  formatTradeAlert(event: TradeEvent): string {
    const { type, symbol, details } = event;

    switch (type) {
      case "open":
        return (
          `Opened ${details.side ?? "long"} position on ${symbol}` +
          ` — qty: ${details.qty ?? "?"}` +
          ` @ $${this.fmtNum(details.price)}` +
          (details.paperMode ? " [PAPER]" : "")
        );

      case "close": {
        const pnl = typeof details.pnl === "number" ? details.pnl : undefined;
        const pnlStr = pnl !== undefined ? ` P&L: ${pnl >= 0 ? "+$" : "-$"}${Math.abs(pnl).toFixed(2)}` : "";
        return `Closed position on ${symbol} — qty: ${details.qty ?? "?"}${pnlStr}`;
      }

      case "stop_triggered":
        return (
          `Stop triggered on ${symbol}` +
          ` — type: ${details.stopType ?? "unknown"}` +
          ` @ $${this.fmtNum(details.triggerPrice)}` +
          (typeof details.pnl === "number" ? ` P&L: ${(details.pnl as number) >= 0 ? "+$" : "-$"}${Math.abs(details.pnl as number).toFixed(2)}` : "")
        );

      case "flash_crash":
        return (
          `FLASH CRASH detected on ${symbol}` +
          ` — drop: ${this.fmtNum(details.dropPct)}%` +
          ` in ${this.fmtNum(details.windowMs)}ms` +
          `. Recommendation: ${details.recommendation ?? "flatten"}`
        );

      case "circuit_break":
        return (
          `CIRCUIT BREAKER tripped` +
          (details.reasons ? ` — ${(details.reasons as string[]).join("; ")}` : "") +
          `. All trading halted.`
        );

      default:
        return `Trade event [${type}] on ${symbol}: ${JSON.stringify(details)}`;
    }
  }

  /**
   * Determine whether a trade event should be escalated (iMessage, etc.).
   * Critical events: flash crash, circuit break, or large losses > $50.
   */
  shouldEscalate(event: TradeEvent): boolean {
    if (event.type === "flash_crash" || event.type === "circuit_break") {
      return true;
    }

    const pnl = typeof event.details.pnl === "number" ? event.details.pnl : 0;
    if (pnl < -50) {
      return true;
    }

    return false;
  }

  /**
   * Format an urgent escalation message suitable for iMessage delivery.
   */
  getEscalationMessage(event: TradeEvent): string {
    const alert = this.formatTradeAlert(event);
    const urgency =
      event.type === "flash_crash"
        ? "FLASH CRASH"
        : event.type === "circuit_break"
          ? "CIRCUIT BREAKER"
          : "LARGE LOSS";

    return `[URGENT - ${urgency}] ${alert}`;
  }

  private fmtNum(val: unknown): string {
    if (typeof val === "number" && Number.isFinite(val)) {
      return val.toFixed(2);
    }
    return String(val ?? "?");
  }
}
