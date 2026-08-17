// src/integrations/gmail-client.ts
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
var GmailClient = class {
  gmail;
  auth;
  constructor(credentialsPath, tokenPath) {
    const content = readFileSync(credentialsPath, "utf-8");
    const { installed } = JSON.parse(content);
    this.auth = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );
    if (existsSync(tokenPath)) {
      const tokenContent = readFileSync(tokenPath, "utf-8");
      const tokens = JSON.parse(tokenContent);
      this.auth.setCredentials(tokens);
      this.auth.on("tokens", (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        writeFileSync(tokenPath, JSON.stringify(merged));
      });
    }
    this.gmail = google.gmail({ version: "v1", auth: this.auth });
  }
  dispose() {
    this.auth.removeAllListeners("tokens");
  }
  async listMessages(query = "", maxResults = 20) {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults
    });
    const messageIds = res.data.messages ?? [];
    const messages = [];
    for (const msg of messageIds) {
      if (msg.id) {
        const full = await this.getMessage(msg.id);
        messages.push(full);
      }
    }
    return messages;
  }
  async getMessage(messageId) {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    });
    const headers = res.data.payload?.headers ?? [];
    const getHeader = (name) => {
      const header = headers.find(
        (h) => h.name?.toLowerCase() === name.toLowerCase()
      );
      return header?.value ?? "";
    };
    const subject = getHeader("Subject");
    const from = getHeader("From");
    const to = getHeader("To");
    const date = getHeader("Date");
    const snippet = res.data.snippet ?? "";
    const labelIds = res.data.labelIds ?? [];
    let body = "";
    const payload = res.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, "base64").toString("utf-8");
    } else if (payload?.parts) {
      const textPart = payload.parts.find(
        (p) => p.mimeType === "text/plain"
      );
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
      }
    }
    return {
      id: res.data.id ?? messageId,
      threadId: res.data.threadId ?? "",
      subject,
      from,
      to,
      date,
      snippet,
      body,
      labelIds
    };
  }
  async sendMessage(to, subject, body) {
    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body
    ];
    const rawMessage = messageParts.join("\r\n");
    const raw = Buffer.from(rawMessage).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });
    return { id: res.data.id ?? "" };
  }
  async searchMessages(query, limit = 10) {
    return this.listMessages(query, limit);
  }
};

export {
  GmailClient
};
