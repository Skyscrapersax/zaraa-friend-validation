// src/messaging/slack-client.ts
import { App } from "@slack/bolt";
var SlackClient = class {
  app;
  textHandlerRegistered = false;
  constructor(botToken, appToken, signingSecret) {
    this.app = new App({
      token: botToken,
      appToken,
      signingSecret,
      socketMode: true
    });
  }
  onText(handler) {
    if (this.textHandlerRegistered) return;
    this.textHandlerRegistered = true;
    this.app.message(async ({ message }) => {
      if (message.subtype) return;
      const m = message;
      handler({
        ts: m.ts,
        channelId: m.channel,
        text: m.text ?? "",
        userId: m.user ?? "",
        userName: m.user ?? "",
        threadTs: m.thread_ts
      });
    });
  }
  async send(channelId, text, threadTs) {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadTs
    });
    return { ts: result.ts ?? "" };
  }
  async start() {
    await this.app.start();
  }
  async stop() {
    await this.app.stop();
  }
};

export {
  SlackClient
};
