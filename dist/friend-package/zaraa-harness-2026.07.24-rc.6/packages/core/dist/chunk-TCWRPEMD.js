// src/messaging/message-triage.ts
var URGENT_RE = /\b(urgent|asap|immediately|right away|today|tonight|now\b|emergency|where are you|eta)\b/i;
var SCHEDULING_RE = /\b(schedule|reschedule|time|timing|meeting|availability|free at|tomorrow|today|tonight|confirm)\b/i;
var FOLLOWUP_RE = /\b(follow[- ]?up|checking in|circling back|circle back|reminder|bump|nudge)\b/i;
var DECISION_RE = /\b(approve|approval|decide|decision|choose|sign off|yes or no|greenlight)\b/i;
var OUTBOUND_OPEN_LOOP_RE = /\?|let me know|can you|could you|would you|does that work|are you free|confirm|reply|respond|send over|share|checking in|follow[- ]?up|circle back/i;
function analyzeRecentMessages(messages, now = /* @__PURE__ */ new Date()) {
  const threads = /* @__PURE__ */ new Map();
  for (const message of messages) {
    const key = message.chatId || message.handleId || `message-${message.id}`;
    const existing = threads.get(key) ?? [];
    existing.push(message);
    threads.set(key, existing);
  }
  const needsReply = [];
  const waitingOnOthers = [];
  for (const [threadKey, threadMessages] of threads) {
    const sorted = [...threadMessages].sort(
      (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime()
    );
    const latest = sorted[0];
    if (!latest) continue;
    const ageMinutes = Math.max(
      0,
      Math.round((now.getTime() - new Date(latest.date).getTime()) / 6e4)
    );
    const preview = buildPreview(latest);
    const reasons = classifyReasons(preview);
    const score = scoreThread(reasons, ageMinutes);
    const triaged = {
      contact: latest.handleId || threadKey,
      chatId: latest.chatId || threadKey,
      latestAt: latest.date,
      preview,
      waitingFor: latest.isFromMe ? "response" : "reply",
      reasons,
      score,
      priority: classifyPriority(score, reasons),
      ageMinutes
    };
    if (!latest.isFromMe) {
      needsReply.push(triaged);
      continue;
    }
    if (OUTBOUND_OPEN_LOOP_RE.test(preview)) {
      waitingOnOthers.push(triaged);
    }
  }
  const stale = [
    ...needsReply.filter((thread) => thread.ageMinutes >= 12 * 60),
    ...waitingOnOthers.filter((thread) => thread.ageMinutes >= 24 * 60)
  ].sort((left, right) => right.ageMinutes - left.ageMinutes);
  return {
    needsReply: sortThreads(needsReply),
    waitingOnOthers: sortThreads(waitingOnOthers),
    stale,
    totalRecentMessages: messages.length,
    totalThreads: threads.size
  };
}
function buildMessageJudgmentQueue(triage, options = {}) {
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const staleChatIds = new Set(triage.stale.map((thread) => thread.chatId));
  const selected = /* @__PURE__ */ new Map();
  for (const thread of [...triage.needsReply, ...triage.stale]) {
    const isStale = staleChatIds.has(thread.chatId);
    if (!selected.has(thread.chatId) && shouldSurfaceForJudgment(thread, isStale)) {
      selected.set(thread.chatId, toJudgmentItem(thread, isStale));
    }
  }
  if (selected.size < limit) {
    for (const thread of triage.needsReply) {
      if (selected.has(thread.chatId)) continue;
      selected.set(thread.chatId, toJudgmentItem(thread, staleChatIds.has(thread.chatId)));
      if (selected.size >= limit) break;
    }
  }
  const items = [...selected.values()].sort((left, right) => {
    const rankDelta = rankJudgmentItem(right) - rankJudgmentItem(left);
    if (rankDelta !== 0) return rankDelta;
    if (left.ageMinutes !== right.ageMinutes) return right.ageMinutes - left.ageMinutes;
    return new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime();
  }).slice(0, limit);
  return {
    items,
    totalCandidates: selected.size,
    totalNeedsReply: triage.needsReply.length,
    totalStale: triage.stale.length
  };
}
function buildMessageFollowupQueue(triage, options = {}) {
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const items = triage.waitingOnOthers.map((thread) => toFollowupItem(thread)).filter((thread) => thread.due).sort((left, right) => {
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    if (left.priority !== right.priority) {
      return rankPriority(right.priority) - rankPriority(left.priority);
    }
    if (left.ageMinutes !== right.ageMinutes) return right.ageMinutes - left.ageMinutes;
    return new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime();
  }).slice(0, limit);
  return {
    items,
    totalCandidates: triage.waitingOnOthers.length,
    totalDue: triage.waitingOnOthers.map((thread) => toFollowupItem(thread)).filter((thread) => thread.due).length,
    totalOverdue: triage.waitingOnOthers.map((thread) => toFollowupItem(thread)).filter((thread) => thread.overdue).length
  };
}
function buildPreview(message) {
  const text = message.text.trim();
  if (text) return truncate(text, 120);
  if (message.attachments && message.attachments.length > 0) {
    const first = message.attachments[0];
    return `[Attachment] ${first.filename}`;
  }
  return "(no text)";
}
function rankPriority(priority) {
  switch (priority) {
    case "high":
      return 2;
    case "normal":
      return 1;
    default:
      return 0;
  }
}
function classifyReasons(text) {
  const reasons = [];
  if (URGENT_RE.test(text)) reasons.push("urgent");
  if (SCHEDULING_RE.test(text)) reasons.push("scheduling");
  if (FOLLOWUP_RE.test(text)) reasons.push("follow-up");
  if (DECISION_RE.test(text)) reasons.push("decision");
  if (text.includes("?")) reasons.push("question");
  if (reasons.length === 0) reasons.push("new inbound");
  return reasons;
}
function scoreThread(reasons, ageMinutes) {
  let score = 1;
  if (reasons.includes("urgent")) score += 4;
  if (reasons.includes("scheduling")) score += 2;
  if (reasons.includes("follow-up")) score += 2;
  if (reasons.includes("decision")) score += 2;
  if (reasons.includes("question")) score += 1;
  if (ageMinutes < 60) score += 2;
  else if (ageMinutes < 6 * 60) score += 1;
  return score;
}
function classifyPriority(score, reasons) {
  if (reasons.includes("urgent") || score >= 7) return "high";
  if (score >= 4) return "normal";
  return "low";
}
function sortThreads(threads) {
  return [...threads].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime();
  });
}
function shouldSurfaceForJudgment(thread, stale) {
  if (stale) return true;
  if (thread.priority === "high") return true;
  if (thread.reasons.includes("decision") || thread.reasons.includes("scheduling") || thread.reasons.includes("urgent")) {
    return true;
  }
  if (thread.waitingFor === "reply" && thread.ageMinutes >= 180) return true;
  if (thread.waitingFor === "response" && thread.ageMinutes >= 24 * 60) return true;
  return false;
}
function toJudgmentItem(thread, stale) {
  return {
    ...thread,
    stale,
    whyNow: buildWhyNow(thread, stale),
    recommendedAction: buildRecommendedAction(thread, stale),
    suggestedGoal: buildSuggestedGoal(thread, stale)
  };
}
function toFollowupItem(thread) {
  const followupAfterMinutes = getFollowupAfterMinutes(thread);
  const due = thread.ageMinutes >= followupAfterMinutes;
  const overdue = thread.ageMinutes >= Math.max(24 * 60, followupAfterMinutes + 12 * 60);
  return {
    ...thread,
    followupAfterMinutes,
    due,
    overdue,
    recommendedAction: buildFollowupAction(thread, overdue),
    suggestedGoal: buildFollowupGoal(thread, overdue)
  };
}
function rankJudgmentItem(item) {
  let rank = item.score;
  if (item.priority === "high") rank += 5;
  else if (item.priority === "normal") rank += 2;
  if (item.stale) rank += 3;
  if (item.reasons.includes("decision")) rank += 3;
  if (item.reasons.includes("scheduling")) rank += 2;
  if (item.reasons.includes("urgent")) rank += 2;
  if (item.waitingFor === "reply") rank += 1;
  return rank;
}
function buildWhyNow(thread, stale) {
  if (stale && thread.waitingFor === "response") {
    return "Open loop has gone stale and may need a nudge or a close.";
  }
  if (stale) {
    return "Inbound thread has waited too long for a reply.";
  }
  if (thread.reasons.includes("decision")) {
    return "The other party is asking for a decision or sign-off.";
  }
  if (thread.reasons.includes("scheduling")) {
    return "Timing needs a concrete response.";
  }
  if (thread.reasons.includes("urgent")) {
    return "Urgent language suggests a quick reply matters.";
  }
  if (thread.waitingFor === "response") {
    return "You asked for something and may want to follow up.";
  }
  return "Recent inbound likely needs operator judgment.";
}
function buildRecommendedAction(thread, stale) {
  if (thread.reasons.includes("decision")) {
    return "Make the decision clearly and reply in one pass.";
  }
  if (thread.reasons.includes("scheduling")) {
    return "Confirm the time or propose the best alternative.";
  }
  if (stale && thread.waitingFor === "response") {
    return "Decide whether to send a short follow-up or close the loop.";
  }
  if (stale) {
    return "Reply now or explicitly defer so the thread stops drifting.";
  }
  if (thread.reasons.includes("urgent")) {
    return "Reply quickly with a concrete next step.";
  }
  return thread.waitingFor === "response" ? "Send a brief follow-up if this still matters." : "Draft a concise reply and keep momentum.";
}
function buildSuggestedGoal(thread, stale) {
  if (thread.reasons.includes("decision")) return "answer the decision request clearly";
  if (thread.reasons.includes("scheduling")) return "confirm timing or propose an alternative";
  if (stale && thread.waitingFor === "response") return "send a polite follow-up or close the loop";
  if (stale) return "reply clearly and stop the thread from drifting";
  if (thread.reasons.includes("urgent")) return "reply quickly with the next step";
  return thread.waitingFor === "response" ? "send a brief follow-up" : "reply clearly and keep momentum";
}
function getFollowupAfterMinutes(thread) {
  if (thread.priority === "high") return 4 * 60;
  if (thread.reasons.includes("decision") || thread.reasons.includes("scheduling")) return 6 * 60;
  if (thread.reasons.includes("follow-up") || thread.reasons.includes("question")) return 12 * 60;
  return 24 * 60;
}
function buildFollowupAction(thread, overdue) {
  if (thread.reasons.includes("decision")) {
    return overdue ? "Send a direct follow-up asking for a decision or close the loop." : "Send a direct follow-up asking for a clear decision.";
  }
  if (thread.reasons.includes("scheduling")) {
    return overdue ? "Send a follow-up with a concrete time option or close the scheduling loop." : "Send a follow-up with a concrete time option.";
  }
  return overdue ? "Send a short nudge or explicitly close the open loop." : "Send a short follow-up to keep the thread moving.";
}
function buildFollowupGoal(thread, overdue) {
  if (thread.reasons.includes("decision")) {
    return overdue ? "ask for a decision or close the loop" : "ask for a clear decision";
  }
  if (thread.reasons.includes("scheduling")) {
    return overdue ? "propose a concrete time or close the scheduling loop" : "propose a concrete time";
  }
  return overdue ? "send a polite nudge or close the loop" : "send a brief follow-up";
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export {
  analyzeRecentMessages,
  buildMessageJudgmentQueue,
  buildMessageFollowupQueue
};
