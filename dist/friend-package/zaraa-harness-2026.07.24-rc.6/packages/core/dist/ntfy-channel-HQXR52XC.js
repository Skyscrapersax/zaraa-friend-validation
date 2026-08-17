import {
  createLogger
} from "./chunk-RSXICYJP.js";
import "./chunk-R5U7XKVJ.js";

// src/notifications/channels/ntfy-channel.ts
var PRIORITY_TO_NTFY = {
  urgent: "5",
  high: "4",
  normal: "3",
  low: "2"
};
var NtfyChannel = class {
  name = "ntfy";
  topicUrl;
  accessToken;
  fetchImpl;
  log = createLogger({ module: "notifications.ntfy" });
  constructor(config) {
    this.topicUrl = config.topicUrl;
    if (config.accessToken !== void 0) this.accessToken = config.accessToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }
  async send(payload) {
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Priority": PRIORITY_TO_NTFY[payload.priority ?? "normal"] ?? "3"
    };
    if (payload.title) headers["X-Title"] = payload.title;
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    try {
      const res = await this.fetchImpl(this.topicUrl, {
        method: "POST",
        headers,
        body: payload.message,
        signal: controller.signal
      });
      if (!res.ok) {
        this.log.warn(
          { status: res.status, url: this.topicUrl },
          "ntfy push returned non-ok status"
        );
      }
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : err },
        "ntfy push failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
};
export {
  NtfyChannel
};
