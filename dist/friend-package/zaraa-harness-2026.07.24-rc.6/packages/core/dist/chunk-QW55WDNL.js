import {
  formatForIMessage
} from "./chunk-KE2G7CEW.js";

// src/notifications/channels/imessage-channel.ts
var IMessageChannel = class {
  name = "imessage";
  defaultEnabled = false;
  sender;
  contact;
  constructor(sender, contact) {
    this.sender = sender;
    this.contact = contact;
  }
  async send(payload) {
    const prefix = payload.priority === "urgent" ? "[URGENT] " : payload.priority === "high" ? "[!] " : "";
    const title = payload.title ? `${payload.title}: ` : "";
    const raw = `${prefix}${title}${payload.message}`;
    const skipSessionRecord = payload.metadata?.skipSessionRecord === true;
    const shouldRecordInSession = !skipSessionRecord && typeof payload.metadata?.sessionId === "string" && payload.metadata.sessionId.startsWith("imessage-");
    await this.sender.send(this.contact, formatForIMessage(raw), {
      skipSessionRecord: !shouldRecordInSession
    });
  }
};

export {
  IMessageChannel
};
