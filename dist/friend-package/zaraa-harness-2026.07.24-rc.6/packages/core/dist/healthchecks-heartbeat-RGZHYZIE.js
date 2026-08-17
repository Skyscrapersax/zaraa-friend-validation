import {
  createLogger
} from "./chunk-RSXICYJP.js";
import "./chunk-R5U7XKVJ.js";

// src/notifications/healthchecks-heartbeat.ts
var HealthchecksHeartbeat = class {
  url;
  intervalMs;
  fetchImpl;
  onError;
  timer = null;
  log = createLogger({ module: "healthchecks-heartbeat" });
  inflight = false;
  lastPingAt = null;
  lastPingOk = null;
  lastError = null;
  consecutiveFailures = 0;
  constructor(config) {
    this.url = config.url;
    this.intervalMs = config.intervalMs ?? 6e4;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.onError = config.onError ?? ((err) => this.log.warn(
      { err: err instanceof Error ? err.message : err },
      "heartbeat ping failed"
    ));
  }
  /** Current status for /api/health/extended and the iMessage status command. */
  getStatus() {
    return {
      configured: true,
      url: this.url,
      intervalMs: this.intervalMs,
      lastPingAt: this.lastPingAt,
      lastPingOk: this.lastPingOk,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures
    };
  }
  /**
   * Fire a single ping with one retry-after-3s on transient failure.
   * Never throws — reports the final error via `onError`. A transient
   * network blip or cold DNS shouldn't page the operator — the retry
   * has to also fail for onError to fire.
   */
  async ping() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const firstError = await this.attemptPing();
      if (firstError === null) return;
      await new Promise((resolve) => setTimeout(resolve, 3e3));
      if (!this.timer) return;
      const retryError = await this.attemptPing();
      if (retryError !== null) this.onError(retryError);
    } finally {
      this.inflight = false;
    }
  }
  /**
   * Single network attempt. Returns null on success, or an Error on
   * failure (timeout, non-ok status, network error). Never throws.
   * Updates the status fields so /api/health/extended can report them.
   */
  async attemptPing() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        signal: controller.signal
      });
      this.lastPingAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!res.ok) {
        const err = new Error(`heartbeat ${this.url} returned ${res.status}`);
        this.lastPingOk = false;
        this.lastError = err.message;
        this.consecutiveFailures++;
        return err;
      }
      this.lastPingOk = true;
      this.lastError = null;
      this.consecutiveFailures = 0;
      return null;
    } catch (err) {
      this.lastPingAt = (/* @__PURE__ */ new Date()).toISOString();
      this.lastPingOk = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures++;
      return err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }
  /** Start periodic pings. Fires one immediately so the first uptime datum lands quickly. */
  start() {
    if (this.timer) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
};
export {
  HealthchecksHeartbeat
};
