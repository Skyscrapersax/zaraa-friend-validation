// src/messaging/whatsapp-poller.ts
var WhatsAppPoller = class {
  client;
  store;
  baseIntervalMs;
  timer = null;
  consecutiveFailures = 0;
  lastError = null;
  constructor(client, store, options) {
    this.client = client;
    this.store = store;
    this.baseIntervalMs = options?.intervalMs ?? 15e3;
  }
  async poll() {
    try {
      const lastDate = this.store.getLastMessageDate();
      const options = { limit: 100 };
      if (lastDate) {
        options.since = new Date(lastDate);
      }
      const messages = await this.client.fetchMessages(options);
      if (messages.length > 0) {
        this.store.upsert(messages);
      }
      this.consecutiveFailures = 0;
      this.lastError = null;
      return messages.length;
    } catch (err) {
      this.consecutiveFailures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[whatsapp-poller] poll failed (attempt ${this.consecutiveFailures}): ${this.lastError}`
      );
      return 0;
    }
  }
  getStatus() {
    return {
      healthy: this.consecutiveFailures === 0,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError
    };
  }
  getBackoffInterval() {
    if (this.consecutiveFailures === 0) return this.baseIntervalMs;
    const multiplier = Math.pow(2, Math.min(this.consecutiveFailures, 5));
    return this.baseIntervalMs * multiplier;
  }
  start() {
    if (this.timer) return;
    const tick = async () => {
      await this.poll();
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(tick, this.getBackoffInterval());
    };
    this.timer = setTimeout(tick, this.baseIntervalMs);
  }
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
};

export {
  WhatsAppPoller
};
