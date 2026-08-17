// src/notifications/channels/webhook-channel.ts
import { createHmac } from "crypto";
var WebhookChannel = class {
  name = "webhook";
  url;
  customHeaders;
  secret;
  maxRetries;
  constructor(config) {
    this.url = config.url;
    this.customHeaders = config.headers ?? {};
    this.secret = config.secret ?? null;
    this.maxRetries = config.maxRetries ?? 2;
  }
  async send(payload) {
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      ...this.customHeaders
    };
    if (this.secret) {
      const signature = createHmac("sha256", this.secret).update(body).digest("hex");
      headers["X-Signature-256"] = `sha256=${signature}`;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(1e4)
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`Webhook failed with ${res.status}: ${await res.text()}`);
        }
        lastError = new Error(`Webhook failed with ${res.status}: ${await res.text()}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) continue;
      }
    }
    throw lastError;
  }
};

export {
  WebhookChannel
};
