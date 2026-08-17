export interface WebhookAlertPayload {
  eventType: string;
  message: string;
  severity: "info" | "warning" | "critical";
  timestamp: string;
}

export class WebhookAlerter {
  constructor(private readonly webhookUrl: string) {}

  async send(payload: WebhookAlertPayload): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(
          `[WebhookAlerter] ${this.webhookUrl} responded ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      console.warn(
        "[WebhookAlerter] delivery failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
