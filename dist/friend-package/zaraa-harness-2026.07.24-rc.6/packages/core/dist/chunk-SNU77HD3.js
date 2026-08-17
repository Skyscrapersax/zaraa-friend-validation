// src/messaging/telegram-tools.ts
var manifest = {
  name: "telegram",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["messaging.telegram"],
  trust: "core",
  tools: [
    {
      name: "tg_read_recent",
      description: "Read recent Telegram messages",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum messages to return (default: 50)" }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "tg_search",
      description: "Search Telegram messages by text",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          limit: { type: "number", description: "Maximum messages to return (default: 50)" }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "tg_read_chat",
      description: "Read messages from a specific Telegram chat",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "number", description: "Telegram chat ID" },
          limit: { type: "number", description: "Maximum messages to return (default: 100)" }
        },
        required: ["chatId"]
      },
      requiresApproval: false
    },
    {
      name: "tg_send",
      description: "Send a Telegram message",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "number", description: "Telegram chat ID" },
          message: { type: "string", description: "The text message to send" }
        },
        required: ["chatId", "message"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(store, client) {
  return {
    tg_read_recent: async (args) => {
      const limit = args.limit;
      return JSON.stringify(store.readRecent(limit));
    },
    tg_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit;
      return JSON.stringify(store.search(query, limit));
    },
    tg_read_chat: async (args) => {
      const chatId = args.chatId;
      if (chatId === void 0 || chatId === null) throw new Error("chatId is required");
      const limit = args.limit;
      return JSON.stringify(store.readChat(chatId, limit));
    },
    tg_send: async (args) => {
      const chatId = args.chatId;
      const message = args.message;
      if (!chatId || !message) throw new Error("chatId and message are required");
      const result = await client.send(chatId, message);
      return `Telegram message sent (ID: ${result.messageId})`;
    }
  };
}

export {
  manifest,
  createHandlers
};
