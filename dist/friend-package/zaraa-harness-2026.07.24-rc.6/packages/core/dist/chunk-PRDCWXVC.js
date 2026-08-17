import {
  buildReplyDraftPrompt,
  parseReplyDraftResponse,
  resolveRecipient,
  summarizeContactContext
} from "./chunk-ORI6SRSL.js";
import {
  analyzeRecentMessages,
  buildMessageFollowupQueue,
  buildMessageJudgmentQueue
} from "./chunk-TCWRPEMD.js";

// src/messaging/imessage-tools.ts
var manifest = {
  name: "imessage",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["messaging.imessage"],
  trust: "core",
  tools: [
    {
      name: "imsg_read_recent",
      description: "Read recent iMessages",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Phone number or email to filter by (optional)"
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 50)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "imsg_search",
      description: "Search iMessages by text",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for"
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 50)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "imsg_read_thread",
      description: "Read a conversation thread",
      parameters: {
        type: "object",
        properties: {
          chatId: {
            type: "string",
            description: 'Chat identifier (e.g., "iMessage;-;+1234567890")'
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 100)"
          }
        },
        required: ["chatId"]
      },
      requiresApproval: false
    },
    {
      name: "imsg_triage",
      description: "Summarize recent iMessages into reply-needed, waiting-on-others, and stale threads.",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Optional phone number or email to scope triage to one contact"
          },
          limit: {
            type: "number",
            description: "Maximum number of recent messages to analyze (default: 100)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "imsg_judgment_queue",
      description: "Surface the highest-leverage message threads that likely need operator judgment or a drafted reply next.",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Optional phone number or email to scope the queue to one contact"
          },
          limit: {
            type: "number",
            description: "Maximum number of recent messages to analyze (default: 150)"
          },
          queueLimit: {
            type: "number",
            description: "Maximum judgment items to return (default: 5)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "imsg_followup_queue",
      description: "Surface outbound iMessage threads that are due for a follow-up because the other party has not responded yet.",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Optional phone number or email to scope the queue to one contact"
          },
          limit: {
            type: "number",
            description: "Maximum number of recent messages to analyze (default: 150)"
          },
          queueLimit: {
            type: "number",
            description: "Maximum follow-up items to return (default: 5)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "imsg_send",
      description: "Send an iMessage",
      parameters: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Phone number or email address of the recipient"
          },
          message: {
            type: "string",
            description: "The text message to send"
          },
          service: {
            type: "string",
            enum: ["iMessage", "SMS"],
            description: 'Message service to use (default: "iMessage")'
          }
        },
        required: ["recipient", "message"]
      },
      requiresApproval: true
    },
    {
      name: "imsg_send_file",
      description: "Send a local file (image, audio, PDF, etc.) as an iMessage attachment. Stages the file to a Messages-friendly path first so attachments from ~/.zaraa actually arrive.",
      parameters: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Phone number or email address of the recipient"
          },
          filePath: {
            type: "string",
            description: "Absolute local path to the file to attach (or ~/\u2026)"
          },
          caption: {
            type: "string",
            description: "Optional plain-text message sent with or just before the file"
          },
          service: {
            type: "string",
            enum: ["iMessage", "SMS"],
            description: 'Message service to use (default: "iMessage")'
          }
        },
        required: ["recipient", "filePath"]
      },
      requiresApproval: true
    },
    {
      name: "imsg_draft_reply",
      description: "Read an iMessage thread and draft a suggested reply without sending it.",
      parameters: {
        type: "object",
        properties: {
          chatId: {
            type: "string",
            description: "Chat identifier to draft from (preferred when known)"
          },
          contact: {
            type: "string",
            description: "Phone number or email to scope the draft to one contact"
          },
          limit: {
            type: "number",
            description: "Maximum thread messages to use (default: 12)"
          },
          tone: {
            type: "string",
            description: "Optional tone guidance like warm, concise, upbeat, or firm"
          },
          goal: {
            type: "string",
            description: "Optional purpose for the reply, like confirm timing or nudge for feedback"
          },
          draftLength: {
            type: "string",
            enum: ["short", "medium", "long"],
            description: "How long the draft should be (default: short)"
          }
        },
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(reader, sender, deps = {}) {
  return {
    imsg_read_recent: async (args) => {
      const contact = args.contact;
      const limit = args.limit;
      const messages = reader.readRecent({ contact, limit });
      return JSON.stringify(messages);
    },
    imsg_search: async (args) => {
      const query = args.query;
      if (!query) {
        throw new Error("query is required");
      }
      const limit = args.limit;
      return JSON.stringify(reader.search(query, limit));
    },
    imsg_read_thread: async (args) => {
      const chatId = args.chatId;
      if (!chatId) {
        throw new Error("chatId is required");
      }
      const limit = args.limit;
      return JSON.stringify(reader.readThread(chatId, limit));
    },
    imsg_triage: async (args) => {
      const contact = args.contact;
      const limit = args.limit ?? 100;
      const messages = reader.readRecent({ contact, limit });
      return JSON.stringify(analyzeRecentMessages(messages));
    },
    imsg_judgment_queue: async (args) => {
      const contact = args.contact;
      const limit = args.limit ?? 150;
      const queueLimit = args.queueLimit ?? 5;
      const messages = reader.readRecent({ contact, limit });
      const triage = analyzeRecentMessages(messages);
      return JSON.stringify(buildMessageJudgmentQueue(triage, { limit: queueLimit }));
    },
    imsg_followup_queue: async (args) => {
      const contact = args.contact;
      const limit = args.limit ?? 150;
      const queueLimit = args.queueLimit ?? 5;
      const messages = reader.readRecent({ contact, limit });
      const triage = analyzeRecentMessages(messages);
      return JSON.stringify(buildMessageFollowupQueue(triage, { limit: queueLimit }));
    },
    imsg_send: async (args) => {
      const recipient = args.recipient;
      const message = args.message;
      if (!recipient || !message) {
        throw new Error("recipient and message are required");
      }
      const service = args.service;
      await sender.send(recipient, message, service);
      return "Message sent";
    },
    imsg_send_file: async (args) => {
      const recipient = typeof args.recipient === "string" ? args.recipient.trim() : "";
      const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
      if (!recipient || !filePath) {
        throw new Error("recipient and filePath are required");
      }
      const service = args.service;
      const caption = typeof args.caption === "string" ? args.caption.trim() : "";
      if (caption) {
        await sender.send(recipient, caption, service);
      }
      await sender.sendFile(recipient, filePath, service ?? "iMessage");
      return caption ? "Caption + file sent" : "File sent";
    },
    imsg_draft_reply: async (args, context) => {
      const chatId = typeof args.chatId === "string" ? args.chatId : void 0;
      const contact = typeof args.contact === "string" ? args.contact : void 0;
      if (!chatId && !contact) {
        throw new Error("chatId or contact is required");
      }
      const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 12)));
      const tone = typeof args.tone === "string" ? args.tone : void 0;
      const goal = typeof args.goal === "string" ? args.goal : void 0;
      const draftLength = normalizeDraftLength(args.draftLength);
      const messages = chatId ? reader.readThread(chatId, limit) : reader.readRecent({ contact, limit });
      if (messages.length === 0) {
        throw new Error("No messages found for that thread");
      }
      const recipient = resolveRecipient(messages, contact);
      const triage = analyzeRecentMessages(messages);
      const threadSignal = triage.needsReply[0] ?? triage.waitingOnOthers[0] ?? triage.stale[0];
      const contactContext = deps.resolveContactContext?.({
        messages,
        contact,
        chatId
      }) ?? null;
      const contactContextSummary = summarizeContactContext(contactContext, recipient);
      const latestAt = messages.map((message) => message.date).sort().at(-1) ?? null;
      const latestMessage = [...messages].sort(
        (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime()
      )[0];
      const fallbackReplyNeeded = threadSignal?.waitingFor === "reply" || !!goal && goal.trim().length > 0 || !latestMessage?.isFromMe;
      if (!deps.draftReply) {
        return JSON.stringify({
          recipient,
          chatId,
          replyNeeded: fallbackReplyNeeded,
          priority: threadSignal?.priority ?? "normal",
          reasons: threadSignal?.reasons ?? [],
          summary: "Drafting provider unavailable.",
          draft: "",
          confidence: "low",
          latestAt,
          messageCount: messages.length,
          contactContextSummary,
          nextAction: "Configure a drafting provider or ask Zaraa directly in chat to draft the reply.",
          prompt: buildReplyDraftPrompt({
            messages,
            contact,
            chatId,
            tone,
            goal,
            draftLength,
            contactContext
          })
        });
      }
      const packet = await deps.draftReply(
        {
          messages,
          contact,
          chatId,
          tone,
          goal,
          draftLength,
          contactContext
        },
        context
      );
      if (packet && typeof packet === "object" && "draft" in packet && "summary" in packet) {
        return JSON.stringify(packet);
      }
      return JSON.stringify(
        parseReplyDraftResponse(String(packet ?? ""), {
          recipient,
          chatId,
          priority: threadSignal?.priority ?? "normal",
          reasons: threadSignal?.reasons ?? [],
          latestAt,
          messageCount: messages.length,
          replyNeeded: fallbackReplyNeeded,
          contactContextSummary
        })
      );
    }
  };
}
function normalizeDraftLength(value) {
  return value === "medium" || value === "long" ? value : "short";
}

export {
  manifest,
  createHandlers
};
