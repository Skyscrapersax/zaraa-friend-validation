// src/messaging/discord-tools.ts
var manifest = {
  name: "discord",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["messaging.discord"],
  trust: "core",
  tools: [
    {
      name: "discord_read_recent",
      description: "Read recent Discord messages",
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
      name: "discord_search",
      description: "Search Discord messages by text",
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
      name: "discord_read_channel",
      description: "Read messages from a specific Discord channel",
      parameters: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "Discord channel ID" },
          limit: { type: "number", description: "Maximum messages to return (default: 100)" }
        },
        required: ["channelId"]
      },
      requiresApproval: false
    },
    {
      name: "discord_send",
      description: "Send a Discord message",
      parameters: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "Discord channel ID to send to" },
          message: { type: "string", description: "The text message to send" }
        },
        required: ["channelId", "message"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(store, client) {
  return {
    discord_read_recent: async (args) => {
      const limit = args.limit;
      return JSON.stringify(store.readRecent(limit));
    },
    discord_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit;
      return JSON.stringify(store.search(query, limit));
    },
    discord_read_channel: async (args) => {
      const channelId = args.channelId;
      if (!channelId) throw new Error("channelId is required");
      const limit = args.limit;
      return JSON.stringify(store.readChannel(channelId, limit));
    },
    discord_send: async (args) => {
      const channelId = args.channelId;
      const message = args.message;
      if (!channelId || !message) throw new Error("channelId and message are required");
      const result = await client.send(channelId, message);
      return `Discord message sent (ID: ${result.messageId})`;
    }
  };
}

export {
  manifest,
  createHandlers
};
