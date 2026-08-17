// src/messaging/whatsapp-client.ts
import twilio from "twilio";
function stripWhatsAppPrefix(phone) {
  return phone.replace(/^whatsapp:/, "");
}
function ensureWhatsAppPrefix(phone) {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}
var WhatsAppClient = class {
  client;
  fromNumber;
  constructor(accountSid, authToken, fromNumber) {
    this.client = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
  }
  async send(to, body) {
    try {
      const message = await this.client.messages.create({
        from: ensureWhatsAppPrefix(this.fromNumber),
        to: ensureWhatsAppPrefix(to),
        body
      });
      return { sid: message.sid };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp message to "${to}": ${msg}`);
    }
  }
  async fetchMessages(options) {
    const params = {
      limit: options?.limit ?? 100
    };
    if (options?.since) {
      params.dateSentAfter = options.since;
    }
    const messages = await this.client.messages.list(params);
    return messages.map((m) => ({
      sid: m.sid,
      body: m.body ?? "",
      fromNumber: stripWhatsAppPrefix(m.from),
      toNumber: stripWhatsAppPrefix(m.to),
      direction: m.direction,
      status: m.status,
      dateSent: m.dateSent instanceof Date ? m.dateSent.toISOString() : String(m.dateSent)
    }));
  }
};

export {
  WhatsAppClient
};
