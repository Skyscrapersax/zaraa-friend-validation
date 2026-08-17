// src/self-improvement/experiment-readout-gate.ts
var EVIDENCE_REFERENT = /`[^`]+`|\d|\bPASS\b|\bFAIL\b/;
var DISPOSITION = /\b(CLOSE|DEFER|ESCALATE)\b/;
function evaluateReadout(readout) {
  const trimmed = readout.trim();
  const missing = [];
  if (!EVIDENCE_REFERENT.test(trimmed)) missing.push("no-checkable-evidence");
  if (!DISPOSITION.test(trimmed)) missing.push("no-decision-disposition");
  return { status: missing.length === 0 ? "pass" : "fail", missing };
}

// src/tasks/task-metadata.ts
var PACKET_QA_REQUIRED_SHAPES = [
  "goal-checkpoint",
  "zodiac-specialist",
  "operator-briefing",
  "evidence-backed-brief",
  "opportunity",
  "experiment-readout"
];
var PACKET_QA_LABELS = ["Objective", "Done", "Next", "Risk"];
var FRONTIER_GAUNTLET_PROMPT_ANCHOR = /^\[Frontier gauntlet\b/;
var FRONTIER_GAUNTLET_GOAL_PREFIX = "zaraa-frontier-gauntlet:";
var FRONTIER_OUTPUT_LABELS = [
  "Evidence used",
  "Artifact",
  "Done check result",
  "Risk boundary",
  "Self-critique",
  "Next harder variation"
];
var HEX_RUN_40_PLUS = /[0-9a-fA-F]{40,}/g;
function hasGoalCheckpointAttachment(metadata) {
  return Boolean(metadata?.goalRef?.trim() && metadata?.checkpointRef?.trim());
}
function applyRoutingHintToTaskMetadata(metadata, hint) {
  const base = metadata ?? {};
  if (!hint) return base;
  return {
    ...base,
    routingModel: hint.model ?? base.routingModel,
    routingProvider: hint.provider ?? base.routingProvider,
    routingAlias: hint.alias ?? base.routingAlias
  };
}
function routingHintFromTaskMetadata(metadata) {
  if (!metadata) return void 0;
  if (!metadata.routingModel && !metadata.routingProvider && !metadata.routingAlias) {
    return void 0;
  }
  return {
    model: metadata.routingModel ?? void 0,
    provider: metadata.routingProvider ?? void 0,
    alias: metadata.routingAlias ?? void 0
  };
}
function isNonTrivialTaskPacket(prompt, source) {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  if (source === "auto-chain" || source === "autonomy") return true;
  if (trimmed.length >= 140) return true;
  if (trimmed.split("\n").length >= 4) return true;
  return /\b(objective|deliverable|checkpoint|milestone|context|why now|next test)\b/i.test(
    trimmed
  );
}
function inferTaskPacketShape(prompt, source) {
  if (source === "auto-chain" && /^\[Zodiac Dispatch:/i.test(prompt.trimStart())) {
    return "zodiac-specialist";
  }
  if (/\bexperiment readout\b/i.test(prompt) || /\bScenario:\s*Experiment readouts\b/i.test(prompt)) {
    return "experiment-readout";
  }
  if (/\bbriefing\b/i.test(prompt) && /\b(morning|afternoon|night|daily)\b/i.test(prompt)) {
    return "operator-briefing";
  }
  if (/\bopportunity\b/i.test(prompt)) {
    return "opportunity";
  }
  if (/\b(goal|checkpoint|endpoint|next test)\b/i.test(prompt)) {
    return "goal-checkpoint";
  }
  return "generic";
}
function requiresPacketQa(packetShape) {
  return PACKET_QA_REQUIRED_SHAPES.includes(packetShape);
}
var CANNED_REFUSAL_PREFIXES = [
  "status: blocked for paid release",
  "human source needed:"
];
function detectCannedRefusalResult(result, prompt = "") {
  const trimmed = result.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  const blockedTool = trimmed.match(/^blocked:\s*`?([a-z][\w.-]*)`?\s+is not available\b/i)?.[1];
  if (blockedTool && prompt.toLowerCase().includes(blockedTool.toLowerCase()) && /\bif\b[^.\n]{0,100}\bunavailable\b/i.test(prompt) && /\breport\s+blocked\b/i.test(prompt)) {
    return null;
  }
  for (const prefix of CANNED_REFUSAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return `known canned-refusal preamble "${prefix}"`;
    }
  }
  if (trimmed.length <= 320 && /^(?:status:\s*blocked\b|blocked:|cannot\s+proceed\b|unable\s+to\s+proceed\b)/i.test(trimmed) && !/```|https?:\/\/|\/[\w.-]+\/|\|/.test(trimmed)) {
    return "short non-responsive refusal with no artifact or evidence";
  }
  const helpMenu = /\bhow can i help you(?:\s+today)?\b/i.test(trimmed) || /\bwhat would you like me to (?:do|work on|help with)\b/i.test(trimmed) || /\blet me know what you'd like\b/i.test(trimmed);
  const listsOptions = /(?:^|\n)\s*(?:1[).]|[-*])\s+.+\n\s*(?:2[).]|[-*])\s+/m.test(trimmed) || /\bfor example, would you like me to\b/i.test(trimmed);
  const hasTaskContract = /\b(?:acceptance|deliverable|outcome|done definition|finish with)\b/i.test(prompt) || /\bzaraa growth task\b/i.test(prompt) || prompt.trim().length >= 80;
  const looksLikeWork = /```|https?:\/\/|\/[\w.-]+\/|\|/.test(trimmed) || /\b(?:result|model-choice lesson|reusable zaraa rule|next harder task)\b/i.test(trimmed) || /\b(?:fixed|implemented|patched|wrote|created|audited|triaged)\b/i.test(trimmed);
  if (helpMenu && listsOptions && hasTaskContract && !looksLikeWork && trimmed.length <= 1500) {
    return "help-menu idle greeting instead of executing the task";
  }
  return null;
}
var OPERATOR_GROWTH_PACK_REQUIRED_HEADINGS = [
  { label: "## Result", re: /^#{1,3}\s*result\b/im },
  { label: "## Why this is novel", re: /^#{1,3}\s*why this is novel\b/im },
  { label: "## Reusable Zaraa rule", re: /^#{1,3}\s*reusable zaraa rule\b/im },
  { label: "## Next stranger task", re: /^#{1,3}\s*next stranger task\b/im }
];
function findMissingOperatorGrowthPackHeadings(result) {
  const trimmed = result.trim();
  const missing = OPERATOR_GROWTH_PACK_REQUIRED_HEADINGS.filter(
    (item) => !item.re.test(trimmed)
  ).map((item) => item.label);
  if (/^\s*(human source needed:|status:\s*blocked\b)/i.test(trimmed)) {
    missing.push("non-refusal body");
  }
  if (trimmed.length < 120) {
    missing.push("minimum depth");
  }
  return missing;
}
function classifyFailureFromMessage(message) {
  const lower = message.toLowerCase();
  if (lower.includes("dedup") || lower.includes("duplicate") || lower.includes("already queued") || lower.includes("already exists")) {
    return "duplicate-work";
  }
  if (lower.includes("packet shape") || lower.includes("bad-packet-shape") || lower.includes("objective:") || lower.includes("done:") || lower.includes("next:") || lower.includes("risk:")) {
    return "bad-packet-shape";
  }
  if (lower.includes("policy") || lower.includes("permission") || lower.includes("approval") || lower.includes("denied") || lower.includes("blocked by safety")) {
    return "policy";
  }
  if (lower.includes("tool") || lower.includes("unknown tool") || lower.includes("tool call") || lower.includes("requires an id") || lower.includes("not configured")) {
    return "tool";
  }
  if (lower.includes("planner") || lower.includes("plan failed") || lower.includes("failed to parse plan") || lower.includes("assignment") || lower.includes("route")) {
    return "planner";
  }
  if (lower.includes("stale") || lower.includes("reaped") || lower.includes("interrupted") || lower.includes("dependency failed") || lower.includes("outdated") || lower.includes("missing input") || lower.includes("context window") || lower.includes("context length exceeded") || lower.includes("maximum context") || lower.includes("previous daemon session") || lower.includes("inherited running task") || lower.includes("stuck: running")) {
    return "stale-context";
  }
  if (lower.includes("provider") || lower.includes("model") || lower.includes("ollama") || lower.includes("timeout") || lower.includes("429") || lower.includes("503") || lower.includes("overloaded") || lower.includes("fetch failed") || lower.includes("network")) {
    return "provider";
  }
  return "provider";
}
function evaluatePacketQa(packetShape, result) {
  if (!requiresPacketQa(packetShape)) {
    return {
      qaStatus: "not-run",
      cleanupBurden: "none",
      acceptanceOutcome: "not-applicable"
    };
  }
  const trimmed = result.trim();
  if (packetShape === "experiment-readout") {
    const verdict = evaluateReadout(trimmed);
    if (verdict.status === "pass") {
      return {
        qaStatus: "pass",
        cleanupBurden: "none",
        acceptanceOutcome: "accepted"
      };
    }
    return {
      qaStatus: "fail",
      failureClass: "quality_gate_block",
      cleanupBurden: "medium",
      acceptanceOutcome: "needs-cleanup",
      lastEvidence: `experiment-readout-gate:${verdict.missing.join(",")}`
    };
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-4);
  const labels = ["Objective:", "Done:", "Next:", "Risk:"];
  const matchesTail = tail.length === 4 && tail.every((line, index) => line.startsWith(labels[index]));
  if (matchesTail) {
    return {
      qaStatus: "pass",
      cleanupBurden: "none",
      acceptanceOutcome: "accepted"
    };
  }
  const presentCount = labels.filter((label) => trimmed.includes(label)).length;
  if (presentCount >= 2) {
    return {
      qaStatus: "fail",
      failureClass: "bad-packet-shape",
      cleanupBurden: "medium",
      acceptanceOutcome: "needs-cleanup"
    };
  }
  return {
    qaStatus: "fail",
    failureClass: "bad-packet-shape",
    cleanupBurden: "high",
    acceptanceOutcome: "rejected"
  };
}
function isFrontierGauntletTask(task) {
  if (typeof task.prompt === "string" && FRONTIER_GAUNTLET_PROMPT_ANCHOR.test(task.prompt.trimStart())) {
    return true;
  }
  return [task.metadata?.goalRef, task.metadata?.checkpointRef].some(
    (ref) => typeof ref === "string" && ref.startsWith(FRONTIER_GAUNTLET_GOAL_PREFIX)
  );
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
function evaluateFrontierPacket(prompt, result) {
  const strippedLines = result.split(/\r?\n/).map(
    (line) => line.replace(/[*_`]/g, "").replace(/^[\s>#-]+/, "").trim()
  );
  const reasons = [];
  const labelMatches = FRONTIER_OUTPUT_LABELS.map((label) => ({
    label,
    indexes: strippedLines.map((line, index) => line.startsWith(`${label}:`) ? index : -1).filter((index) => index >= 0)
  }));
  const missing = labelMatches.filter(({ indexes }) => indexes.length === 0).map(({ label }) => label);
  if (missing.length > 0) reasons.push(`missing-labels:${missing.join("|")}`);
  const duplicate = labelMatches.filter(({ indexes }) => indexes.length > 1).map(({ label }) => label);
  if (duplicate.length > 0) reasons.push(`duplicate-labels:${duplicate.join("|")}`);
  const empty = labelMatches.filter(
    ({ label, indexes }) => indexes.length === 1 && strippedLines[indexes[0]] === `${label}:`
  ).map(({ label }) => label);
  if (empty.length > 0) reasons.push(`empty-labels:${empty.join("|")}`);
  const orderedIndexes = labelMatches.map(({ indexes }) => indexes[0]).filter((index) => index !== void 0);
  if (orderedIndexes.length === FRONTIER_OUTPUT_LABELS.length && orderedIndexes.some((index, offset) => offset > 0 && index <= orderedIndexes[offset - 1])) {
    reasons.push("label-order");
  }
  const promptShas = new Set((prompt.match(HEX_RUN_40_PLUS) ?? []).map((sha) => sha.toLowerCase()));
  if (promptShas.size > 0) {
    for (const run of new Set(result.match(HEX_RUN_40_PLUS) ?? [])) {
      if (!promptShas.has(run.toLowerCase())) {
        reasons.push(`sha-foreign:${run.slice(0, 8)}`);
      }
    }
    const cleaned = result.replace(/\\[a-zA-Z]+|[${}]|\s+/g, "").toLowerCase();
    for (const sha of promptShas) {
      const exactCount = countOccurrences(result, sha);
      if (exactCount === 0) reasons.push(`sha-missing:${sha.slice(0, 8)}`);
      if (/\bexactly once\b/i.test(prompt) && exactCount !== 1) {
        reasons.push(`sha-count:${sha.slice(0, 8)}=${exactCount}`);
      }
      if (countOccurrences(cleaned, sha) > countOccurrences(result, sha)) {
        reasons.push(`sha-altered:${sha.slice(0, 8)}`);
      }
    }
  }
  if (reasons.length === 0) {
    return {
      qaStatus: "pass",
      cleanupBurden: "none",
      acceptanceOutcome: "accepted",
      lastEvidence: "frontier-shape:exact-once-ordered-nonempty-labels+sha-verbatim"
    };
  }
  return {
    qaStatus: "fail",
    failureClass: "bad-packet-shape",
    cleanupBurden: "medium",
    acceptanceOutcome: "rejected",
    lastEvidence: `frontier-fidelity:${reasons.join(",")}`
  };
}
function normalizePacketQaResult(packetShape, prompt, result, metadata) {
  if (isFrontierGauntletTask({ prompt, metadata })) {
    return { result, repaired: false, evaluation: evaluateFrontierPacket(prompt, result) };
  }
  if (isNovelGrowthTestPrompt(prompt) && hasNovelGrowthFinalLabels(result)) {
    if (hasVerifiedNovelGrowthArtifact(prompt, result)) {
      return {
        result,
        repaired: false,
        evaluation: {
          qaStatus: "pass",
          cleanupBurden: "none",
          acceptanceOutcome: "accepted"
        }
      };
    }
    return {
      result,
      repaired: false,
      evaluation: {
        qaStatus: "warn",
        cleanupBurden: "low",
        acceptanceOutcome: "needs-cleanup",
        lastEvidence: "label-only-fallback:novel-growth-normalize"
      }
    };
  }
  const shape = packetShape === "experiment-readout" || isNovelGrowthTestPrompt(prompt) && /\bexperiment readout\b/i.test(prompt) ? "experiment-readout" : packetShape;
  const evaluation = evaluatePacketQa(shape, result);
  if (!requiresPacketQa(shape) || evaluation.qaStatus === "pass") {
    return {
      result,
      repaired: false,
      evaluation
    };
  }
  if (shape === "experiment-readout") {
    return {
      result,
      repaired: false,
      evaluation
    };
  }
  const normalized = buildPacketQaTail(packetShape, prompt, result);
  const normalizedEvaluation = evaluatePacketQa(packetShape, normalized);
  if (normalizedEvaluation.qaStatus !== "pass") {
    return {
      result,
      repaired: false,
      evaluation
    };
  }
  const presentCount = PACKET_QA_LABELS.filter((label) => result.includes(`${label}:`)).length;
  return {
    result: normalized,
    repaired: true,
    evaluation: {
      qaStatus: "warn",
      failureClass: "bad-packet-shape",
      cleanupBurden: presentCount >= 2 ? "low" : "medium",
      acceptanceOutcome: "needs-cleanup"
    }
  };
}
function isNovelGrowthTestPrompt(prompt) {
  return /\bnovel growth test\b/i.test(prompt) || /\bngt-\d+\b/i.test(prompt);
}
function hasNovelGrowthFinalLabels(result) {
  const trimmed = result.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  return /^Clearest leverage point:/m.test(trimmed) && /^Measurable signal:/m.test(trimmed) && /^Next harder variation:/m.test(trimmed) && lastLine.startsWith("Next harder variation:");
}
function hasVerifiedNovelGrowthArtifact(prompt, result) {
  if (!isTaskQueueFlowNovelGrowthPrompt(prompt)) return false;
  const trimmed = result.trim();
  return /\bqueue lifecycle diagram\b/i.test(trimmed) && /\bbottleneck (?:fix|recommendation|risk|guard)\b/i.test(trimmed) && /\bqueue time-to-start\b/i.test(trimmed) && /\bduplicate task rate\b/i.test(trimmed);
}
function isTaskQueueFlowNovelGrowthPrompt(prompt) {
  const [taskSpecificPrompt] = prompt.split(
    /\n(?:Compact completion boundary|Final answer guard):/i
  );
  return /\b(?:task queue flow|queue lifecycle diagram|queue time-to-start|duplicate task rate)\b/i.test(
    taskSpecificPrompt ?? prompt
  );
}
function cleanupBurdenScore(burden) {
  switch (burden) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "none":
    default:
      return 0;
  }
}
function extractPacketQaValue(text, label) {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "im").exec(text);
  const value = match?.[1]?.trim();
  return value ? value : null;
}
function summarizePacketQaText(text, maxLength = 160) {
  const collapsed = text.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const sentenceMatch = /^[^.!?\n]+[.!?]?/.exec(collapsed);
  const sentence = sentenceMatch?.[0]?.trim() || collapsed;
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trim()}\u2026`;
}
function extractPromptObjective(prompt) {
  const objectiveMatch = /(?:^|\n)(?:objective|goal|title)\s*:\s*(.+)$/im.exec(prompt);
  if (objectiveMatch?.[1]?.trim()) {
    return summarizePacketQaText(objectiveMatch[1]);
  }
  return null;
}
function extractPromptNext(prompt) {
  const nextMatch = /(?:^|\n)(?:next(?: test)?|recommended next action)\s*:\s*(.+)$/im.exec(prompt);
  if (nextMatch?.[1]?.trim()) {
    return summarizePacketQaText(nextMatch[1]);
  }
  return null;
}
function stripTrailingPacketQaLines(text) {
  const lines = text.trimEnd().split("\n");
  while (lines.length > 0) {
    const line = lines[lines.length - 1].trim();
    const isPacketQaLine = PACKET_QA_LABELS.some((label) => line.startsWith(`${label}:`));
    if (!isPacketQaLine) break;
    lines.pop();
  }
  return lines.join("\n").trim();
}
function defaultObjective(packetShape) {
  switch (packetShape) {
    case "operator-briefing":
      return "Deliver the requested operator briefing packet.";
    case "evidence-backed-brief":
      return "Deliver an evidence-backed brief with clear facts, assumptions, and next action.";
    case "opportunity":
      return "Summarize the active opportunity and what to test next.";
    case "goal-checkpoint":
      return "Advance the current goal checkpoint toward the endpoint.";
    case "zodiac-specialist":
      return "Deliver the assigned specialist support packet.";
    case "generic":
    default:
      return "Deliver the requested packet clearly and concretely.";
  }
}
function defaultDone(packetShape) {
  switch (packetShape) {
    case "operator-briefing":
      return "Summarized what matters now, what is slipping, and the single recommended move.";
    case "evidence-backed-brief":
      return "Named inspected evidence, separated facts from assumptions, and gave one recommended next action.";
    case "opportunity":
      return "Summarized the current opportunity stage, evidence, and action path.";
    case "goal-checkpoint":
      return "Captured current checkpoint progress, drift, and the next validation step.";
    case "zodiac-specialist":
      return "Completed the requested specialist lane review and returned the narrow deliverable.";
    case "generic":
    default:
      return "Completed the requested packet.";
  }
}
function defaultNext(packetShape) {
  switch (packetShape) {
    case "operator-briefing":
      return "Take the single recommended next action surfaced in the briefing.";
    case "evidence-backed-brief":
      return "Run the recommended next action or one tighter evidence-gathering test.";
    case "opportunity":
      return "Run the next test, then update stage and evidence.";
    case "goal-checkpoint":
      return "Advance the checkpoint and re-check drift against the endpoint.";
    case "zodiac-specialist":
      return "Use this specialist packet to unblock the parent lane.";
    case "generic":
    default:
      return "Take the highest-leverage follow-up identified in the packet.";
  }
}
function defaultRisk(packetShape) {
  switch (packetShape) {
    case "operator-briefing":
      return "Packet QA repair was applied; verify critical details before acting.";
    case "evidence-backed-brief":
      return "Brief may be incomplete if referenced evidence was thin or stale.";
    case "opportunity":
      return "Stage or evidence may be stale if the underlying context changed.";
    case "goal-checkpoint":
      return "Checkpoint may drift if the next test is not run soon.";
    case "zodiac-specialist":
      return "Packet QA repair was applied; verify the specialist lane before downstream action.";
    case "generic":
    default:
      return "Packet QA repair was applied; confirm assumptions before acting.";
  }
}
function inferPacketQaObjective(packetShape, prompt, result) {
  return extractPacketQaValue(result, "Objective") || extractPromptObjective(prompt) || summarizePacketQaText(stripTrailingPacketQaLines(result)) || defaultObjective(packetShape);
}
function inferPacketQaDone(packetShape, result) {
  const stripped = stripTrailingPacketQaLines(result);
  return extractPacketQaValue(result, "Done") || summarizePacketQaText(stripped) || defaultDone(packetShape);
}
function inferPacketQaNext(packetShape, prompt, result) {
  return extractPacketQaValue(result, "Next") || extractPromptNext(prompt) || defaultNext(packetShape);
}
function inferPacketQaRisk(packetShape, result) {
  const riskValue = extractPacketQaValue(result, "Risk");
  if (riskValue) return riskValue;
  const riskLine = result.split("\n").map((line) => line.trim()).find((line) => /\b(risk|slipping|blocked|stale|fallback)\b/i.test(line));
  if (riskLine) {
    return summarizePacketQaText(riskLine);
  }
  return defaultRisk(packetShape);
}
function buildPacketQaTail(packetShape, prompt, result) {
  const body = stripTrailingPacketQaLines(result);
  const tail = [
    `Objective: ${inferPacketQaObjective(packetShape, prompt, result)}`,
    `Done: ${inferPacketQaDone(packetShape, result)}`,
    `Next: ${inferPacketQaNext(packetShape, prompt, result)}`,
    `Risk: ${inferPacketQaRisk(packetShape, result)}`
  ].join("\n");
  return body ? `${body}

${tail}` : tail;
}
function isAutonomyCurriculumTask(task) {
  const evidence = [task.metadata?.goalRef, task.metadata?.checkpointRef, task.prompt].filter((value) => typeof value === "string").join("\n");
  return /\bautonomy-curriculum[-:]/i.test(evidence) || /\b(?:aap|aaph)-\d{4}\b/i.test(evidence);
}

export {
  evaluateReadout,
  hasGoalCheckpointAttachment,
  applyRoutingHintToTaskMetadata,
  routingHintFromTaskMetadata,
  isNonTrivialTaskPacket,
  inferTaskPacketShape,
  requiresPacketQa,
  detectCannedRefusalResult,
  findMissingOperatorGrowthPackHeadings,
  classifyFailureFromMessage,
  normalizePacketQaResult,
  cleanupBurdenScore,
  isAutonomyCurriculumTask
};
