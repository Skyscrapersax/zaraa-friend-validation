import "./chunk-R5U7XKVJ.js";

// src/messaging/telegram-gateway.ts
var DEFAULT_MAX_LENGTH = 4e3;
var TelegramGateway = class {
  config;
  maxLen;
  /** Maps approval IDs → chat IDs so we can send approval results back */
  approvalChatMap = /* @__PURE__ */ new Map();
  processing = /* @__PURE__ */ new Set();
  // chatIds currently being processed
  constructor(config) {
    this.config = config;
    this.maxLen = config.maxMessageLength ?? DEFAULT_MAX_LENGTH;
  }
  /**
   * Start listening for inbound messages and approval events.
   */
  start() {
    this.config.client.onMessage((msg) => this.handleInbound(msg));
    if (this.config.eventBus) {
      this.config.eventBus.on("approval.created", (event) => {
        this.handleApprovalCreated(event.data);
      });
      this.config.eventBus.on("approval.resolved", (event) => {
        this.handleApprovalResolved(event.data);
      });
    }
    this.config.client.onCallbackQuery((chatId, data) => {
      this.handleCallbackQuery(chatId, data);
    });
    console.log("[TelegramGateway] Started \u2014 two-way chat enabled");
  }
  async handleInbound(msg) {
    const { chatId, text, fromUser } = msg;
    if (this.config.allowedChatIds?.length && !this.config.allowedChatIds.includes(chatId)) {
      return;
    }
    this.config.store.upsert([msg]);
    if (msg.isBot || !text?.trim()) return;
    if (this.processing.has(chatId)) {
      await this.config.client.send(chatId, "_Processing previous message... please wait._");
      return;
    }
    this.processing.add(chatId);
    const sessionId = `telegram-${chatId}`;
    try {
      let response = "";
      for await (const event of this.config.chat(text, sessionId)) {
        if (event.type === "text-delta" && event.content) {
          response += event.content;
        } else if (event.type === "response" && event.content) {
          response = event.content;
        } else if (event.type === "error") {
          response = `Error: ${event.error}`;
        } else if (event.type === "approval-needed") {
          this.approvalChatMap.set(event.approvalId, chatId);
        }
      }
      if (response.trim()) {
        await this.sendLong(chatId, response);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramGateway] Error processing message from ${fromUser}:`, errMsg);
      await this.config.client.send(chatId, `_Error: ${errMsg.slice(0, 200)}_`);
    } finally {
      this.processing.delete(chatId);
    }
  }
  /**
   * Send an approval request as an inline keyboard message to all allowed chats.
   */
  async handleApprovalCreated(data) {
    const approvalId = data.approvalId;
    const description = data.description;
    const confidence = data.confidence;
    const text = [
      "*Approval Required*",
      "",
      description,
      confidence !== void 0 ? `Confidence: ${confidence}%` : ""
    ].filter(Boolean).join("\n");
    const targetChat = this.approvalChatMap.get(approvalId);
    const chatIds = targetChat ? [targetChat] : this.config.allowedChatIds ?? [];
    for (const chatId of chatIds) {
      try {
        await this.config.client.sendWithButtons(chatId, text, [
          [
            { text: "Approve", callback_data: `approve:${approvalId}` },
            { text: "Deny", callback_data: `deny:${approvalId}` }
          ]
        ]);
      } catch (err) {
        console.error("[TelegramGateway] Failed to send approval to chat", chatId, err);
      }
    }
  }
  async handleApprovalResolved(data) {
    const approvalId = data.approvalId;
    const result = data.result;
    const description = data.description;
    const chatId = this.approvalChatMap.get(approvalId);
    this.approvalChatMap.delete(approvalId);
    if (!chatId) return;
    const emoji = result === "approved" ? "+" : "x";
    await this.config.client.send(chatId, `[${emoji}] ${result.toUpperCase()}: ${description}`);
  }
  async handleCallbackQuery(chatId, data) {
    const [action, approvalId] = data.split(":");
    if (!approvalId || !this.config.approvalQueue) return;
    if (action === "approve") {
      const result = this.config.approvalQueue.approve(approvalId);
      if (typeof result === "object" && !result.ok) {
        await this.config.client.send(chatId, `Could not approve: ${result.error}`);
        return;
      }
    } else if (action === "deny") {
      this.config.approvalQueue.deny(approvalId);
    }
  }
  /**
   * Split long messages to stay within Telegram's 4096 char limit.
   */
  async sendLong(chatId, text) {
    if (text.length <= this.maxLen) {
      await this.config.client.send(chatId, text);
      return;
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= this.maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf("\n\n", this.maxLen);
      if (splitIdx < this.maxLen * 0.3) {
        splitIdx = remaining.lastIndexOf("\n", this.maxLen);
      }
      if (splitIdx < this.maxLen * 0.3) {
        splitIdx = this.maxLen;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    for (const chunk of chunks) {
      await this.config.client.send(chatId, chunk);
    }
  }
};
export {
  TelegramGateway
};
