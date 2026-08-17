// src/messaging/whatsapp-tools.ts
var manifest = {
  name: "whatsapp",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["messaging.whatsapp"],
  trust: "core",
  tools: [
    {
      name: "wa_read_recent",
      description: "Read recent WhatsApp messages",
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
      name: "wa_search",
      description: "Search WhatsApp messages by text",
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
      name: "wa_read_thread",
      description: "Read a WhatsApp conversation with a contact",
      parameters: {
        type: "object",
        properties: {
          contact: { type: "string", description: "Phone number (e.g., +1234567890)" },
          limit: { type: "number", description: "Maximum messages to return (default: 100)" }
        },
        required: ["contact"]
      },
      requiresApproval: false
    },
    {
      name: "wa_send",
      description: "Send a WhatsApp message",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient phone number (e.g., +1234567890)" },
          message: { type: "string", description: "The text message to send" }
        },
        required: ["to", "message"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(store, client) {
  return {
    wa_read_recent: async (args) => {
      const limit = args.limit;
      return JSON.stringify(store.readRecent(limit));
    },
    wa_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit;
      return JSON.stringify(store.search(query, limit));
    },
    wa_read_thread: async (args) => {
      const contact = args.contact;
      if (!contact) throw new Error("contact is required");
      const limit = args.limit;
      return JSON.stringify(store.readThread(contact, limit));
    },
    wa_send: async (args) => {
      const to = args.to;
      const message = args.message;
      if (!to || !message) throw new Error("to and message are required");
      const result = await client.send(to, message);
      return `WhatsApp message sent (SID: ${result.sid})`;
    }
  };
}

export {
  manifest,
  createHandlers
};
