// src/runtime/task-fanout-guard.ts
var CANNED_REFUSAL_TREADMILL_GOAL = "make zaraa a true research partner";
var SLIPPING_GOAL_RE = /\bslipping[-\s]?goal\b/;
var CANNED_REFUSAL_RE = /\bcanned[-\s]?refusal\b/;
var QUALITY_REJECTED_RE = /\bquality_rejected\b/;
var HUMAN_SOURCE_NEEDED_RE = /\bhuman source needed:/;
var NO_TASK_CREATE_RE = /\bdo\s+not\s+call\s+`?task_create`?\s+or\s+`?task_plan`?\b/i;
var NO_DELEGATE_RE = /\bdo\s+not\s+(?:delegate|create\s+(?:child|specialist|follow-?up)\s+tasks?|use\s+zodiac)\b/i;
var SINGLE_AGENT_ONLY_RE = /\bsingle-agent\s+only\b/i;
var SIP_CODE_RE = /\bsip-\d{4}\b/i;
var SELF_IMPROVEMENT_TASK_RE = /\bself-improvement\s+(?:task|patch)\b/i;
var SIP_PATCH_KIND_RE = /\b(?:self-improvement|patch|wave|teach\s*&\s*compound)\b/i;
function isCannedRefusalTreadmillGoalRef(ref) {
  const normalized = ref.replace(/[\s-]+/g, " ").trim().toLowerCase();
  return normalized.includes(CANNED_REFUSAL_TREADMILL_GOAL);
}
function shouldSuppressCannedRefusalTreadmillPrompt(prompt) {
  const normalized = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized.includes(CANNED_REFUSAL_TREADMILL_GOAL)) return false;
  return SLIPPING_GOAL_RE.test(normalized) || CANNED_REFUSAL_RE.test(normalized) || QUALITY_REJECTED_RE.test(normalized) || HUMAN_SOURCE_NEEDED_RE.test(normalized);
}
function shouldSuppressCannedRefusalTreadmillAutonomyTask(prompt, goalRef) {
  const ref = goalRef?.trim();
  if (ref && !isCannedRefusalTreadmillGoalRef(ref)) {
    const normalized = prompt.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized.includes(CANNED_REFUSAL_TREADMILL_GOAL)) return false;
    return CANNED_REFUSAL_RE.test(normalized) || QUALITY_REJECTED_RE.test(normalized) || HUMAN_SOURCE_NEEDED_RE.test(normalized);
  }
  return shouldSuppressCannedRefusalTreadmillPrompt(prompt);
}
function shouldSuppressTaskFanoutForPrompt(prompt) {
  const explicitNoTaskFanout = NO_TASK_CREATE_RE.test(prompt) || NO_DELEGATE_RE.test(prompt) || SINGLE_AGENT_ONLY_RE.test(prompt);
  const controlledSelfImprovement = SIP_CODE_RE.test(prompt) && SELF_IMPROVEMENT_TASK_RE.test(prompt);
  const controlledSipPatch = SIP_CODE_RE.test(prompt) && SIP_PATCH_KIND_RE.test(prompt);
  return explicitNoTaskFanout || controlledSelfImprovement || controlledSipPatch || shouldSuppressCannedRefusalTreadmillPrompt(prompt);
}
function isTaskFanoutToolName(toolName) {
  return toolName === "task_create" || toolName === "task_plan" || toolName.startsWith("zodiac_");
}

// src/tasks/task-ingress.ts
function createTaskThroughIngress(taskStore, input) {
  return taskStore.create(input);
}

export {
  isCannedRefusalTreadmillGoalRef,
  shouldSuppressCannedRefusalTreadmillPrompt,
  shouldSuppressCannedRefusalTreadmillAutonomyTask,
  shouldSuppressTaskFanoutForPrompt,
  isTaskFanoutToolName,
  createTaskThroughIngress
};
