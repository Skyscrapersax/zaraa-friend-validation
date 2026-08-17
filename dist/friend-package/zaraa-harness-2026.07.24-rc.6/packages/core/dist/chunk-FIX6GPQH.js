// src/messaging/telegram-client.ts
import { Telegraf } from "telegraf";
var TelegramClient = class {
  bot;
  textHandlerRegistered = false;
  messageHandlerRegistered = false;
  callbackHandlerRegistered = false;
  constructor(botToken) {
    this.bot = new Telegraf(botToken);
  }
  /** Legacy handler — stores messages only (no agent routing). */
  onText(handler) {
    if (this.textHandlerRegistered) return;
    this.textHandlerRegistered = true;
    this.bot.on("text", (ctx) => {
      const msg = ctx.message;
      handler({
        messageId: msg.message_id,
        chatId: msg.chat.id,
        text: msg.text,
        fromUser: msg.from?.first_name ?? "Unknown",
        fromId: msg.from?.id ?? 0,
        date: new Date(msg.date * 1e3).toISOString(),
        isBot: msg.from?.is_bot ?? false
      });
    });
  }
  /** Gateway handler — routes inbound messages to the agent loop. */
  onMessage(handler) {
    if (this.messageHandlerRegistered) return;
    this.messageHandlerRegistered = true;
    this.bot.on("text", (ctx) => {
      const msg = ctx.message;
      handler({
        messageId: msg.message_id,
        chatId: msg.chat.id,
        text: msg.text,
        fromUser: msg.from?.first_name ?? "Unknown",
        fromId: msg.from?.id ?? 0,
        date: new Date(msg.date * 1e3).toISOString(),
        isBot: msg.from?.is_bot ?? false
      });
    });
  }
  /** Handle inline keyboard button presses. */
  onCallbackQuery(handler) {
    if (this.callbackHandlerRegistered) return;
    this.callbackHandlerRegistered = true;
    this.bot.on("callback_query", (ctx) => {
      const cb = ctx.callbackQuery;
      const chatId = cb.message?.chat?.id;
      const data = "data" in cb ? cb.data : void 0;
      if (chatId && data) {
        handler(chatId, data);
        ctx.answerCbQuery().catch((err) => {
          console.debug(
            `[telegram-client] answerCbQuery ack failed (will retry on next button press): ${err instanceof Error ? err.message : err}`
          );
        });
      }
    });
  }
  async send(chatId, text) {
    const result = await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown"
    });
    return { messageId: result.message_id };
  }
  /** Send a message with an inline keyboard (e.g. approve/deny buttons). */
  async sendWithButtons(chatId, text, buttons) {
    const result = await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons }
    });
    return { messageId: result.message_id };
  }
  async startPolling() {
    await this.bot.launch({ dropPendingUpdates: true });
  }
  stop() {
    this.bot.stop("SIGTERM");
  }
};

export {
  TelegramClient
};
