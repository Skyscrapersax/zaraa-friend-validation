// src/integrations/gmail-tools.ts
var manifest = {
  name: "gmail",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.gmail"],
  trust: "core",
  tools: [
    {
      name: "gmail_inbox",
      description: "Read inbox messages",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum messages to return (default: 20)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "gmail_search",
      description: "Search emails by query",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Gmail search query (same syntax as Gmail search bar)"
          },
          limit: {
            type: "number",
            description: "Maximum messages to return (default: 10)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "gmail_read",
      description: "Read a specific email by message ID",
      parameters: {
        type: "object",
        properties: {
          messageId: {
            type: "string",
            description: "The Gmail message ID to read"
          }
        },
        required: ["messageId"]
      },
      requiresApproval: false
    },
    {
      name: "gmail_send",
      description: "Send an email",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address"
          },
          subject: {
            type: "string",
            description: "Email subject line"
          },
          body: {
            type: "string",
            description: "Email body text"
          }
        },
        required: ["to", "subject", "body"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(client) {
  return {
    gmail_inbox: async (args) => {
      const limit = args.limit ?? 20;
      const messages = await client.listMessages("", limit);
      const summaries = messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        date: m.date,
        snippet: m.snippet
      }));
      return JSON.stringify(summaries);
    },
    gmail_search: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const limit = args.limit ?? 10;
      const messages = await client.searchMessages(query, limit);
      const summaries = messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        date: m.date,
        snippet: m.snippet
      }));
      return JSON.stringify(summaries);
    },
    gmail_read: async (args) => {
      const messageId = args.messageId;
      if (!messageId) throw new Error("messageId is required");
      const message = await client.getMessage(messageId);
      return JSON.stringify(message);
    },
    gmail_send: async (args) => {
      const to = args.to;
      const subject = args.subject;
      const body = args.body;
      if (!to || !subject || !body) {
        throw new Error("to, subject, and body are required");
      }
      const result = await client.sendMessage(to, subject, body);
      return `Email sent successfully (id: ${result.id})`;
    }
  };
}

export {
  manifest,
  createHandlers
};
