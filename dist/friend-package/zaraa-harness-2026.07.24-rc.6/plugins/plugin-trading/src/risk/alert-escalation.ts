/**
 * AlertEscalation — tracks raised alerts and identifies unacknowledged
 * critical alerts that need escalation.
 */

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  id: string;
  message: string;
  severity: AlertSeverity;
  raisedAt: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

export interface AlertEscalationConfig {
  /** Timeout in ms before an unacknowledged critical alert needs escalation (default: 300000 / 5 min). */
  acknowledgementTimeoutMs: number;
  /** Maximum number of escalation attempts per alert (default: 3). */
  maxEscalations: number;
}

const DEFAULT_CONFIG: AlertEscalationConfig = {
  acknowledgementTimeoutMs: 300_000,
  maxEscalations: 3,
};

export class AlertEscalation {
  private readonly config: AlertEscalationConfig;
  private alerts = new Map<string, Alert>();
  private escalationCounts = new Map<string, number>();

  constructor(config?: Partial<AlertEscalationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Raise a new alert. If an alert with the same id already exists
   * and is not acknowledged, it is updated in place.
   */
  raiseAlert(id: string, message: string, severity: AlertSeverity): void {
    const existing = this.alerts.get(id);
    if (existing && !existing.acknowledged) {
      existing.message = message;
      existing.severity = severity;
      return;
    }
    this.alerts.set(id, {
      id,
      message,
      severity,
      raisedAt: Date.now(),
      acknowledged: false,
    });
    this.escalationCounts.set(id, 0);
  }

  /** Acknowledge an alert by id. */
  acknowledge(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = Date.now();
    }
  }

  /** Return all pending (unacknowledged) alerts. */
  getPendingAlerts(): Alert[] {
    return [...this.alerts.values()].filter((a) => !a.acknowledged);
  }

  /**
   * Return critical alerts that are older than the acknowledgement timeout
   * and have not been escalated more than maxEscalations times.
   * Each call increments the escalation counter for returned alerts.
   */
  getUnacknowledgedCritical(): Alert[] {
    const now = Date.now();
    const results: Alert[] = [];

    for (const alert of this.alerts.values()) {
      if (
        alert.severity === "critical" &&
        !alert.acknowledged &&
        now - alert.raisedAt >= this.config.acknowledgementTimeoutMs
      ) {
        const count = this.escalationCounts.get(alert.id) ?? 0;
        if (count < this.config.maxEscalations) {
          this.escalationCounts.set(alert.id, count + 1);
          results.push(alert);
        }
      }
    }

    return results;
  }
}
