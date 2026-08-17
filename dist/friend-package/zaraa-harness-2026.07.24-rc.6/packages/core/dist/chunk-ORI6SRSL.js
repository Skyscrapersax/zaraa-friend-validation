import {
  formatForIMessage
} from "./chunk-KE2G7CEW.js";

// src/messaging/reply-drafter.ts
function buildReplyDraftPrompt(input) {
  const ordered = [...input.messages].sort(
    (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()
  );
  const latest = ordered.at(-1) ?? null;
  const latestSpeaker = latest ? latest.isFromMe ? "me" : "them" : "them";
  const recipient = resolveRecipient(ordered, input.contact);
  const lengthGuide = describeDraftLength(input.draftLength);
  const tone = input.tone?.trim() || "warm, concise, natural";
  const goal = input.goal?.trim() ? `Explicit goal: ${input.goal.trim()}` : "No extra goal supplied. Infer the most useful next reply from the thread.";
  const contactSummary = summarizeContactContext(input.contactContext, recipient);
  const transcript = ordered.slice(-12).map((message) => {
    const who = message.isFromMe ? "Me" : "Them";
    const text = summarizeMessage(message);
    return `[${message.date}] ${who}: ${text}`;
  }).join("\n");
  return [
    "You draft iMessage replies for Zaraa.",
    "Return JSON only with keys: summary, draft, replyNeeded, confidence.",
    "Do not include markdown fences. Do not mention being an AI.",
    "Keep the draft grounded in the thread only. If facts are missing, stay tactfully vague.",
    "If the latest message is from me and there is no explicit goal to follow up, set replyNeeded to false and leave draft empty.",
    `Tone: ${tone}.`,
    `Length: ${lengthGuide}.`,
    goal,
    `Recipient/context: ${recipient || input.chatId || "unknown recipient"}.`,
    contactSummary ? `Known recipient context: ${contactSummary}.` : null,
    `Latest speaker: ${latestSpeaker}.`,
    "",
    "Recent thread:",
    transcript || "(no messages available)"
  ].join("\n");
}
function parseReplyDraftResponse(raw, fallback) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    const draft = cleanText(parsed.draft);
    const summary = cleanText(parsed.summary);
    const replyNeeded = typeof parsed.replyNeeded === "boolean" ? parsed.replyNeeded : fallback.replyNeeded ?? draft.length > 0;
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : "medium";
    return {
      recipient: fallback.recipient,
      chatId: fallback.chatId,
      replyNeeded,
      priority: fallback.priority ?? "normal",
      reasons: fallback.reasons ?? [],
      summary: summary || "Draft reply prepared from the recent thread.",
      draft: replyNeeded ? draft : "",
      confidence,
      latestAt: fallback.latestAt ?? null,
      messageCount: fallback.messageCount,
      contactContextSummary: fallback.contactContextSummary ?? null
    };
  } catch {
    const draft = cleanText(cleaned);
    return {
      recipient: fallback.recipient,
      chatId: fallback.chatId,
      replyNeeded: fallback.replyNeeded ?? draft.length > 0,
      priority: fallback.priority ?? "normal",
      reasons: fallback.reasons ?? [],
      summary: "Draft reply prepared from the recent thread.",
      draft,
      confidence: "low",
      latestAt: fallback.latestAt ?? null,
      messageCount: fallback.messageCount,
      contactContextSummary: fallback.contactContextSummary ?? null
    };
  }
}
function resolveRecipient(messages, contact) {
  if (contact?.trim()) return contact.trim();
  const latestOtherParty = [...messages].reverse().find((message) => !message.isFromMe && message.handleId.trim().length > 0);
  return latestOtherParty?.handleId?.trim() || messages.at(-1)?.handleId?.trim() || "";
}
function summarizeMessage(message) {
  const text = message.text.trim();
  if (text) return truncate(text.replace(/\s+/g, " "), 240);
  if (message.attachments && message.attachments.length > 0) {
    return `[Attachment] ${message.attachments[0].filename}`;
  }
  return "(no text)";
}
function cleanText(value) {
  return typeof value === "string" ? formatForIMessage(value).trim() : "";
}
function describeDraftLength(length) {
  switch (length) {
    case "long":
      return "3-6 sentences, still concise";
    case "medium":
      return "2-4 sentences";
    default:
      return "1-3 short sentences";
  }
}
function summarizeContactContext(context, recipient) {
  if (!context) return null;
  const parts = [];
  const label = context.displayName.trim();
  if (label && label !== recipient) parts.push(label);
  if (context.relationship?.trim()) parts.push(`relationship: ${context.relationship.trim()}`);
  const topics = context.topics?.slice(0, 4) ?? [];
  if (topics.length > 0) parts.push(`recent topics: ${topics.join(", ")}`);
  const prefSummary = summarizeCommPrefs(context.commPrefs);
  if (prefSummary) parts.push(`communication prefs: ${prefSummary}`);
  if (context.notes?.trim()) parts.push(`notes: ${truncate(context.notes.trim(), 120)}`);
  return parts.length > 0 ? parts.join("; ") : null;
}
function summarizeCommPrefs(commPrefs) {
  if (!commPrefs) return null;
  const entries = Object.entries(commPrefs).filter(([, value]) => value !== null && value !== void 0 && String(value).trim().length > 0).slice(0, 4).map(([key, value]) => `${key}=${String(value).trim()}`);
  return entries.length > 0 ? entries.join(", ") : null;
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export {
  buildReplyDraftPrompt,
  parseReplyDraftResponse,
  resolveRecipient,
  summarizeMessage,
  summarizeContactContext
};
