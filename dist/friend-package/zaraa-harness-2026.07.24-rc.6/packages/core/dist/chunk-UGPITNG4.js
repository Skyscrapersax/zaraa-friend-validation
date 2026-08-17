// src/proactive/briefing-narration.ts
function composeBriefingNarration(source, options = {}) {
  return (options.mode ?? "summary") === "voice" ? composeBriefingVoiceNarration(source) : composeBriefingSummaryNarration(source);
}
function composeBriefingSummaryNarration(source) {
  const greeting = resolveGreeting(source.generatedAt);
  const highPriority = source.sections.filter((section) => section.priority === "high");
  const parts = [greeting];
  const primaryGoal = source.topGoals[0];
  const primaryDrift = source.checkpointDrift[0];
  const primaryReview = source.checkpointReviews[0];
  if (highPriority.length > 0) {
    const titles = highPriority.map((section) => section.title.toLowerCase());
    parts.push(
      `Heads up: ${titles.join(", ")} need${highPriority.length === 1 ? "s" : ""} your attention.`
    );
  }
  if (primaryGoal) {
    const checkpoint = primaryGoal.currentCheckpoint ?? primaryGoal.endpoint ?? "No checkpoint attached";
    const nextTest = primaryGoal.nextTest ? ` Next test: ${primaryGoal.nextTest}.` : "";
    parts.push(`What matters now: ${primaryGoal.title} \u2014 ${checkpoint}.${nextTest}`);
  }
  if (primaryDrift) {
    parts.push(
      `Checkpoint drift: ${primaryDrift.title} is ${primaryDrift.severity} risk because ${truncate(primaryDrift.reason, 120)}.`
    );
  }
  if (primaryReview) {
    const reviewOutcome = formatCheckpointReviewOutcome(primaryReview);
    const reviewDetail = formatCheckpointReviewDetail(primaryReview);
    const reviewLine = reviewDetail ? `Checkpoint review: ${primaryReview.title} ${reviewOutcome} (${reviewDetail}).` : `Checkpoint review: ${primaryReview.title} ${reviewOutcome}.`;
    parts.push(reviewLine);
  }
  if (source.slippingWork.length > 0) {
    const leadSlip = truncate(source.slippingWork[0]?.prompt ?? "checkpoint-linked work", 90);
    parts.push(
      `What is slipping: ${source.slippingWork.length} item${source.slippingWork.length === 1 ? "" : "s"}, starting with ${leadSlip}.`
    );
  }
  if (source.pendingApprovals.length > 0) {
    parts.push(`Approvals waiting: ${source.pendingApprovals.length}.`);
  }
  const statBits = buildStatBits(source.sections);
  if (statBits.focusLine) {
    parts.push(statBits.focusLine);
  }
  if (statBits.bits.length > 0) {
    parts.push(`Today: ${statBits.bits.join(", ")}.`);
  }
  if (source.recommendedNextAction) {
    parts.push(`Next: ${source.recommendedNextAction}`);
  }
  return parts.join(" ");
}
function composeBriefingVoiceNarration(source, options = {}) {
  const voiceWindow = options.voiceWindow ?? resolveVoiceWindow(source.generatedAt);
  const greeting = resolveGreeting(source.generatedAt, voiceWindow);
  const parts = [greeting];
  const primaryGoal = source.topGoals[0];
  const primaryDrift = source.checkpointDrift[0];
  const primaryReview = source.checkpointReviews[0];
  const focusLead = voiceWindow === "afternoon" ? "This afternoon the focus is" : voiceWindow === "night" ? "Tonight the focus is" : "Right now the focus is";
  if (primaryGoal) {
    const checkpoint = primaryGoal.currentCheckpoint ?? primaryGoal.endpoint ?? "no checkpoint is attached yet";
    const nextTest = primaryGoal.nextTest ? ` The next test is ${primaryGoal.nextTest}.` : "";
    parts.push(`${focusLead} ${primaryGoal.title}: ${checkpoint}.${nextTest}`);
  }
  if (primaryDrift) {
    parts.push(
      `${primaryDrift.title} is showing ${primaryDrift.severity} checkpoint drift because ${truncate(primaryDrift.reason, 110)}.`
    );
  }
  if (primaryReview) {
    const reviewOutcome = formatCheckpointReviewOutcome(primaryReview);
    const reviewDetail = formatCheckpointReviewDetail(primaryReview);
    const reviewTail = reviewDetail ? `, with ${reviewDetail}` : "";
    parts.push(`The latest checkpoint review for ${primaryReview.title} ${reviewOutcome}${reviewTail}.`);
  }
  if (source.slippingWork.length > 0) {
    const leadSlip = truncate(source.slippingWork[0]?.prompt ?? "checkpoint-linked work", 80);
    const slipLead = source.slippingWork.length === 1 ? "One thing is slipping" : `${source.slippingWork.length} things are slipping`;
    parts.push(`${slipLead}, starting with ${leadSlip}.`);
  }
  if (source.pendingApprovals.length > 0) {
    parts.push(
      `${source.pendingApprovals.length} approval${source.pendingApprovals.length === 1 ? "" : "s"} ${source.pendingApprovals.length === 1 ? "is" : "are"} waiting.`
    );
  }
  if (source.recommendedNextAction) {
    parts.push(`Best next move: ${source.recommendedNextAction}`);
  }
  return parts.join(" ");
}
function buildStatBits(sections) {
  const bits = [];
  let focusLine = null;
  for (const section of sections) {
    switch (section.title) {
      case "Calendar": {
        const eventMatch = section.content.match(/(\d+) event/);
        if (eventMatch) bits.push(`${eventMatch[1]} events`);
        else if (section.content.includes("clear")) bits.push("clear schedule");
        break;
      }
      case "Availability": {
        const conflictMatch = section.content.match(/Hard conflicts:\s*(\d+)/);
        if (conflictMatch) {
          const count = Number.parseInt(conflictMatch[1], 10);
          bits.push(`${count} schedule conflict${count === 1 ? "" : "s"}`);
        } else if (section.priority === "high") {
          bits.push("schedule pressure");
        }
        break;
      }
      case "Tasks": {
        const pendingMatch = section.content.match(/Pending:\s*(\d+)/);
        if (pendingMatch && Number.parseInt(pendingMatch[1], 10) > 0) {
          bits.push(`${pendingMatch[1]} pending tasks`);
        }
        break;
      }
      case "Messages": {
        const replyCount = (section.content.match(/^ {2}- /gm) ?? []).length;
        if (replyCount > 0) bits.push(`${replyCount} message loops`);
        break;
      }
      case "Focus": {
        if (!/normal mode/i.test(section.content)) {
          focusLine = `Focus: ${section.content}`;
        }
        break;
      }
      case "Trading": {
        const posMatch = section.content.match(/Open positions:\s*(\d+)/);
        if (posMatch && Number.parseInt(posMatch[1], 10) > 0) {
          bits.push(`${posMatch[1]} open positions`);
        }
        break;
      }
    }
  }
  return { bits, focusLine };
}
function formatCheckpointReviewOutcome(review) {
  switch (review.acceptanceOutcome) {
    case "accepted":
      return "was accepted";
    case "needs-cleanup":
      return "needs cleanup";
    case "rejected":
      return "was rejected";
    case "not-applicable":
      return "is noted";
    default:
      return `finished ${review.status}`;
  }
}
function formatCheckpointReviewDetail(review) {
  const details = [];
  if (review.qaStatus && review.qaStatus !== "not-run") {
    details.push(`QA ${review.qaStatus}`);
  }
  if (review.cleanupBurden && review.cleanupBurden !== "none") {
    details.push(`${review.cleanupBurden} cleanup`);
  }
  if (review.failureClass) {
    details.push(review.failureClass);
  }
  return details.length > 0 ? details.join(", ") : null;
}
function resolveGreeting(generatedAt, voiceWindow) {
  const resolvedWindow = voiceWindow ?? resolveVoiceWindow(generatedAt);
  if (resolvedWindow === "morning") return "Good morning.";
  if (resolvedWindow === "afternoon") return "Good afternoon.";
  return "Good evening.";
}
function resolveVoiceWindow(generatedAt) {
  const reference = generatedAt ? new Date(generatedAt) : /* @__PURE__ */ new Date();
  const hour = reference.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "night";
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

// src/proactive/briefing-packet.ts
function serializeBriefingPacket(briefing, options) {
  const voiceWindow = options?.voiceWindow;
  return {
    ...briefing,
    narration: composeBriefingNarration(briefing),
    voiceScript: composeBriefingVoiceNarration(briefing, { voiceWindow }),
    voiceWindow: voiceWindow ?? null
  };
}

export {
  composeBriefingNarration,
  serializeBriefingPacket
};
