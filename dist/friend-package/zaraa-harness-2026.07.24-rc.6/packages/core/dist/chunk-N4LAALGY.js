// src/messaging/slack-tools.ts
var manifest = {
  name: "slack",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["messaging.slack"],
  trust: "core",
  tools: [
    {
      name: "slack_read_recent",
      description: "Read recent Slack messages",
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
      name: "slack_search",
      description: "Search Slack messages by text",
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
      name: "slack_read_channel",
      description: "Read messages from a Slack channel",
      parameters: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "Slack channel ID (e.g., C01ABCDEF)" },
          limit: { type: "number", description: "Maximum messages to return (default: 100)" }
        },
        required: ["channelId"]
      },
      requiresApproval: false
    },
    {
      name: "slack_send",
      description: "Send a Slack message",
      parameters: {
        type: "object",
        properties: {
          channelId: { type: "string", description: "Slack channel ID to send to" },
          message: { type: "string", description: "The text message to send" },
          threadTs: { type: "string", description: "Thread timestamp to reply in a thread" }
        },
        required: ["channelId", "message"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(store, client) {
  return {
    slack_read_recent: async (args) => {
      const limit = args.limit;
      return JSON.stringify(store.readRecent(limit));
    },
    slack_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit;
      return JSON.stringify(store.search(query, limit));
    },
    slack_read_channel: async (args) => {
      const channelId = args.channelId;
      if (!channelId) throw new Error("channelId is required");
      const limit = args.limit;
      return JSON.stringify(store.readChannel(channelId, limit));
    },
    slack_send: async (args) => {
      const channelId = args.channelId;
      const message = args.message;
      if (!channelId || !message) throw new Error("channelId and message are required");
      const threadTs = args.threadTs;
      const result = await client.send(channelId, message, threadTs);
      return `Slack message sent (ts: ${result.ts})`;
    }
  };
}

export {
  manifest,
  createHandlers
};
