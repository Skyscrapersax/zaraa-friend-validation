import {
  ZODIAC_PLANNER_FIELD_MAX_BYTES,
  buildZodiacDispatchPrompt,
  capUtf8String,
  collapseRepeatedZodiacGlueInText,
  getZodiacAgent,
  listZodiacAgents,
  routeZodiacTask,
  stripNestedZodiacDispatchBlocksFromPlannerContext
} from "./chunk-55GC5LHT.js";
import {
  createTaskThroughIngress,
  isCannedRefusalTreadmillGoalRef
} from "./chunk-LYHYCBGR.js";

// src/zodiac/team-orchestrator.ts
import { createHash } from "crypto";
var ZODIAC_DISPATCH_PROMPT_MAX_BYTES = 24e3;
var SIGNAL_CAPRICORN_RE = /\b(finish|ship|execute|launch|rollout|deadline|milestone|deliver)\b/;
var SIGNAL_SCORPIO_RE = /\b(risk|audit|downside|hidden|assumption|failure)\b/;
var SIGNAL_CANCER_RE = /\b(follow[- ]?up|continuity|calendar|schedule|relationship|promise|reminder|meeting|commitment)\b/;
var SIGNAL_PISCES_RE = /\b(synth|pattern|strategy|brainstorm|direction|memo)\b/;
var SIGNAL_AQUARIUS_RE = /\b(automate|system|workflow|dashboard|template)\b/;
var JSON_FENCE_OPEN_RE = /^```(?:json)?\s*\n?/;
var JSON_FENCE_CLOSE_RE = /\n?```\s*$/;
var ZODIAC_AUTO_CHAIN_NEXT_TEST = "Run the specialist answer through the parent task acceptance check before dispatching more zodiac work.";
var ZODIAC_AUTO_CHAIN_KILL_RULE = "Stop if the specialist cannot produce a direct deliverable from prompt evidence without child tasks, zodiac recursion, or canned refusal.";
var ZODIAC_AUTO_CHAIN_LAST_EVIDENCE = "zodiac-auto-chain-proof:direct-specialist-deliverable-contract";
function zodiacDispatchFingerprint(sign, objective) {
  const normalized = `${sign.toLowerCase()}:${objective.replace(/\s+/g, " ").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
var ZODIAC_DISPATCH_DEDUP_STATUSES = [
  "pending",
  "running",
  "blocked",
  "failed",
  "completed"
];
var ZODIAC_DISPATCH_CROSS_PARENT_MAX_AGE_MS = 6 * 60 * 6e4;
function findZodiacDispatchDedup(taskStore, dedupPrefix, parentId) {
  const statuses = [...ZODIAC_DISPATCH_DEDUP_STATUSES];
  if (parentId) {
    const sameParent = taskStore.findTaskWithPromptPrefix(dedupPrefix, {
      source: "auto-chain",
      parentId,
      statuses
    });
    if (sameParent) return sameParent;
  }
  return taskStore.findTaskWithPromptPrefix(dedupPrefix, {
    source: "auto-chain",
    statuses,
    maxAgeMs: ZODIAC_DISPATCH_CROSS_PARENT_MAX_AGE_MS
  });
}
function zodiacTerminalRouteOutcome(error) {
  if (!error) return null;
  if (/\bno[- ]eligible(?: fallback)? (?:agent|provider|route)\b/i.test(error)) {
    return "no-eligible-agent";
  }
  if (/\b(?:timed? out|timeout|stuck: running|too slow)\b/i.test(error)) return "timeout";
  if (/\b(?:unavailable|not available|unreachable)\b/i.test(error)) return "unavailable";
  return null;
}
function parseZodiacDispatch(prompt) {
  const sign = prompt.match(/^\[Zodiac Dispatch:\s*([^\]]+)\]/)?.[1]?.trim();
  const objectiveMarker = "Specialist objective: ";
  const objectiveStart = prompt.lastIndexOf(objectiveMarker);
  const objectiveEnd = prompt.indexOf("\nContext:", objectiveStart);
  if (!sign || objectiveStart < 0 || objectiveEnd < 0) return null;
  const objective = prompt.slice(objectiveStart + objectiveMarker.length, objectiveEnd).trim();
  return objective ? { sign, objective } : null;
}
function dispatchZodiacTerminalFallback(terminalTask, outcome, taskStore) {
  if (!terminalTask.parentId || terminalTask.prompt.includes("Routing owner: routing-controller")) {
    return null;
  }
  const dispatch = parseZodiacDispatch(terminalTask.prompt);
  if (!dispatch) return null;
  const route = routeZodiacTask(dispatch.objective, 12);
  const fallback = [route.primary, ...route.alternatives].find(
    (candidate) => candidate.sign !== dispatch.sign
  );
  if (!fallback) return null;
  const agent = getZodiacAgent(fallback.sign);
  const terminalKey = `${terminalTask.id}:${outcome}:${fallback.sign}`;
  const dedupHash = createHash("sha256").update(terminalKey).digest("hex").slice(0, 16);
  const dedupPrefix = `[Zodiac Dispatch: ${fallback.sign}]
Dedup hash: ${dedupHash}`;
  const existing = taskStore.findTaskWithPromptPrefix(dedupPrefix, {
    source: "auto-chain",
    parentId: terminalTask.parentId
  });
  if (existing) {
    return { owner: "routing-controller", outcome, task: existing, deduplicated: true };
  }
  const prompt = buildZodiacDispatchPrompt({
    agent,
    parentObjective: dispatch.objective,
    objective: dispatch.objective,
    context: [
      "Routing owner: routing-controller",
      `Terminal event: ${terminalTask.id}:${outcome}`,
      `Failed route: ${dispatch.sign}`
    ].join("\n"),
    deliverable: "Recover the original specialist objective with one concise fallback handoff.",
    dedupHash
  });
  const task = createTaskThroughIngress(taskStore, {
    prompt,
    zone: terminalTask.zone,
    priority: terminalTask.priority,
    source: "auto-chain",
    parentId: terminalTask.parentId,
    silent: true,
    metadata: {
      goalRef: terminalTask.metadata?.goalRef ?? dispatch.objective,
      checkpointRef: `${terminalTask.metadata?.checkpointRef ?? "zodiac-routing"}:fallback:${fallback.sign.toLowerCase()}`,
      whyNow: `routing-controller recovery for ${terminalTask.id}:${outcome}`,
      doneDefinition: terminalTask.metadata?.doneDefinition ?? dispatch.objective,
      expiry: terminalTask.metadata?.expiry ?? null,
      packetShape: "zodiac-specialist",
      nextTest: ZODIAC_AUTO_CHAIN_NEXT_TEST,
      killRule: ZODIAC_AUTO_CHAIN_KILL_RULE,
      lastEvidence: `zodiac-terminal-fallback:${terminalKey}`
    }
  });
  return { owner: "routing-controller", outcome, task, deduplicated: false };
}
var TASK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveZodiacParentTaskId(candidate) {
  if (!candidate) return void 0;
  return TASK_UUID_PATTERN.test(candidate.trim()) ? candidate.trim() : void 0;
}
function normalizeMaxAgents(value) {
  if (!value || !Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(Math.trunc(value), 5));
}
function normalizeMode(value) {
  return value === "draft" ? "draft" : "queue";
}
function compact(text, fallback) {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
function buildPlannerPrompt(input) {
  const roster = listZodiacAgents().map((agent) => `- ${agent.sign}: ${agent.sector}`).join("\n");
  const parentObjective = capUtf8String(input.objective.trim(), ZODIAC_PLANNER_FIELD_MAX_BYTES);
  const parentContext = input.context?.trim() ? capUtf8String(input.context.trim(), ZODIAC_PLANNER_FIELD_MAX_BYTES) : "No extra context provided.";
  const parentDeliverable = input.deliverable?.trim() ? capUtf8String(input.deliverable.trim(), ZODIAC_PLANNER_FIELD_MAX_BYTES) : "Support Big Mama Zaraa with focused sub-work and a concise handoff.";
  const body = [
    "You are the orchestration captain for Zaraa's Zodiac Symphony.",
    "Choose the narrowest useful 1-5 specialist assignments that can run in parallel while Big Mama Zaraa keeps the main line.",
    "Prefer non-overlapping lanes. Make each assignment concrete, immediately actionable, and supportive of the parent objective.",
    "Return JSON only: an array of objects with sign, objective, context, deliverable, reason.",
    "",
    "Rules:",
    "- Keep each specialist inside its sector.",
    "- Do not duplicate the parent task or ask the same two signs to do the same thing.",
    "- When work touches markets, portfolio, or risk: specialists must rely on tool calls (`trade_get_price`, `trade_get_prices`, `trade_portfolio`, `trade_risk_status`) \u2014 not prose pretending data was fetched.",
    "- Use Capricorn when active execution tracking or closure pressure matters.",
    "- Use Scorpio when hidden downside, stale assumptions, or risk checks matter.",
    "- Use Pisces only when synthesis or pattern-pulling is truly needed.",
    "- Do not assign more than one synthesis-heavy sign unless necessary.",
    "",
    `Parent objective: ${parentObjective}`,
    `Parent context: ${parentContext}`,
    `Desired deliverable: ${parentDeliverable}`,
    `Max agents: ${normalizeMaxAgents(input.maxAgents)}`,
    "",
    "Available signs:",
    roster,
    "",
    "JSON array only, no markdown, no explanation."
  ].join("\n");
  return capUtf8String(body, 28e3);
}
function defaultDeliverableFor(sign, objective) {
  switch (sign) {
    case "Capricorn":
      return `A tight execution packet that keeps "${objective}" moving with owners, sequence, and next checkpoints.`;
    case "Scorpio":
      return `A concise downside audit for "${objective}" with failure modes, false-edge checks, and risk flags.`;
    case "Gemini":
      return `A clean communications packet or ask-summary that supports "${objective}".`;
    case "Virgo":
      return `A QA or cleanup handoff that raises the quality bar for "${objective}".`;
    case "Pisces":
      return `A synthesis note that pulls the scattered signal into a useful direction for "${objective}".`;
    default:
      return `A concise specialist handoff that materially advances "${objective}".`;
  }
}
function fallbackAssignments(input) {
  const maxAgents = normalizeMaxAgents(input.maxAgents);
  const normalized = input.objective.toLowerCase();
  const selected = [];
  const add = (sign) => {
    if (!selected.includes(sign) && selected.length < maxAgents) {
      selected.push(sign);
    }
  };
  const route = routeZodiacTask(input.objective, maxAgents + 2);
  add(route.primary.sign);
  for (const candidate of route.alternatives) {
    add(candidate.sign);
  }
  if (SIGNAL_CAPRICORN_RE.test(normalized)) {
    add("Capricorn");
  }
  if (SIGNAL_SCORPIO_RE.test(normalized)) {
    add("Scorpio");
  }
  if (SIGNAL_CANCER_RE.test(normalized)) {
    add("Cancer");
  }
  if (SIGNAL_PISCES_RE.test(normalized)) {
    add("Pisces");
  }
  if (SIGNAL_AQUARIUS_RE.test(normalized)) {
    add("Aquarius");
  }
  return selected.slice(0, maxAgents).map((sign) => {
    const agent = getZodiacAgent(sign);
    return {
      sign,
      objective: input.objective,
      context: input.context,
      deliverable: input.deliverable || defaultDeliverableFor(sign, input.objective),
      reason: `Fallback route selected ${sign} because it matches the parent objective's strongest lane: ${agent.sector}.`
    };
  });
}
function parsePlannerAssignments(content, input) {
  const cleaned = content.trim().replace(JSON_FENCE_OPEN_RE, "").replace(JSON_FENCE_CLOSE_RE, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Planner response was not a non-empty array.");
  }
  const maxAgents = normalizeMaxAgents(input.maxAgents);
  const assignments = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of parsed.slice(0, maxAgents)) {
    const agent = getZodiacAgent(typeof raw.sign === "string" ? raw.sign : "");
    if (!agent || seen.has(agent.sign)) continue;
    seen.add(agent.sign);
    assignments.push({
      sign: agent.sign,
      objective: compact(typeof raw.objective === "string" ? raw.objective : input.objective, input.objective),
      context: typeof raw.context === "string" ? raw.context.trim() : input.context,
      deliverable: compact(
        typeof raw.deliverable === "string" ? raw.deliverable : defaultDeliverableFor(agent.sign, input.objective),
        defaultDeliverableFor(agent.sign, input.objective)
      ),
      reason: compact(
        typeof raw.reason === "string" ? raw.reason : `Chosen because ${agent.sign} best fits this lane.`,
        `Chosen because ${agent.sign} best fits this lane.`
      )
    });
  }
  if (assignments.length === 0) {
    throw new Error("Planner returned no valid zodiac assignments.");
  }
  return assignments;
}
async function planAssignments(input, deps) {
  if (!deps.plannerFn) {
    return { assignments: fallbackAssignments(input), fallback: true, error: "No planner function provided" };
  }
  try {
    const response = await deps.plannerFn(buildPlannerPrompt(input), {
      taskType: input.plannerTier ?? "coding"
    });
    return { assignments: parsePlannerAssignments(response, input), fallback: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { assignments: fallbackAssignments(input), fallback: true, error: message };
  }
}
function enrichAssignments(input, assignments) {
  const parentObjective = input.objective.trim();
  return assignments.map((assignment) => {
    const agent = getZodiacAgent(assignment.sign);
    const baseContext = collapseRepeatedZodiacGlueInText(
      stripNestedZodiacDispatchBlocksFromPlannerContext(assignment.context?.trim() ?? "")
    );
    const rawDeliverable = assignment.deliverable?.trim();
    const deliverableForPrompt = rawDeliverable ? collapseRepeatedZodiacGlueInText(rawDeliverable) : void 0;
    const context = [
      baseContext || void 0,
      `Why this lane was chosen: ${assignment.reason.trim()}`
    ].filter(Boolean).join("\n");
    const prompt = buildZodiacDispatchPrompt({
      agent,
      parentObjective,
      objective: assignment.objective,
      context,
      deliverable: deliverableForPrompt,
      dedupHash: zodiacDispatchFingerprint(assignment.sign, assignment.objective)
    });
    return {
      ...assignment,
      prompt: capUtf8String(prompt, ZODIAC_DISPATCH_PROMPT_MAX_BYTES)
    };
  });
}
async function orchestrateZodiacTeam(input, deps) {
  const plannerTier = input.plannerTier ?? "coding";
  const mode = normalizeMode(input.mode);
  const resolvedParent = resolveZodiacParentTaskId(input.parentId);
  if (mode === "queue" && !resolvedParent) {
    return {
      objective: input.objective,
      mode,
      plannerTier,
      assignments: [],
      parentId: null,
      plannerFallback: false,
      queueSuppressed: true,
      queueSuppressionReason: "Zodiac queueing requires a real parent task UUID."
    };
  }
  const treadmillRef = [input.objective, input.goalRef].find(
    (ref) => typeof ref === "string" && isCannedRefusalTreadmillGoalRef(ref)
  );
  if (mode === "queue" && treadmillRef) {
    return {
      objective: input.objective,
      mode,
      plannerTier,
      assignments: [],
      parentId: resolvedParent ?? null,
      plannerFallback: false,
      queueSuppressed: true,
      queueSuppressionReason: `blocked:canned-refusal-source \u2014 zodiac auto-chain fan-out refused for the known canned-refusal treadmill goal (goalRef=${treadmillRef}). Repair or archive the slipping-goal source before orchestrating specialists.`
    };
  }
  const planResult = await planAssignments({ ...input, plannerTier }, deps);
  const assignments = enrichAssignments(input, planResult.assignments);
  if (mode === "queue") {
    if (!deps.taskStore) {
      throw new Error("Task store is required for zodiac queue orchestration.");
    }
    const zone = input.zone ?? "guarded";
    const priority = input.priority ?? "normal";
    let createdCount = 0;
    for (const assignment of assignments) {
      const dedupPrefix = `[Zodiac Dispatch: ${assignment.sign}]
Dedup hash: ${zodiacDispatchFingerprint(assignment.sign, assignment.objective)}`;
      const existingTask = findZodiacDispatchDedup(
        deps.taskStore,
        dedupPrefix,
        resolvedParent
      );
      if (existingTask) {
        assignment.taskId = existingTask.id;
        continue;
      }
      const task = createTaskThroughIngress(deps.taskStore, {
        prompt: assignment.prompt,
        zone,
        priority,
        source: "auto-chain",
        parentId: resolvedParent,
        silent: true,
        metadata: {
          goalRef: input.goalRef ?? input.objective,
          checkpointRef: `${input.checkpointRef ?? "zodiac-orchestration"}:${assignment.sign.toLowerCase()}`,
          whyNow: input.whyNow ?? `Parallel specialist support for ${assignment.sign} while Big Mama keeps the main line.`,
          doneDefinition: input.doneDefinition ?? assignment.deliverable ?? assignment.objective,
          expiry: input.expiry ?? null,
          packetShape: "zodiac-specialist",
          nextTest: ZODIAC_AUTO_CHAIN_NEXT_TEST,
          killRule: ZODIAC_AUTO_CHAIN_KILL_RULE,
          lastEvidence: ZODIAC_AUTO_CHAIN_LAST_EVIDENCE
        }
      });
      assignment.taskId = task.id;
      createdCount++;
    }
    if (createdCount > 0) {
      deps.triggerProcessing?.();
    }
  }
  return {
    objective: input.objective,
    mode,
    plannerTier,
    assignments,
    parentId: input.parentId ?? null,
    plannerFallback: planResult.fallback,
    plannerError: planResult.error
  };
}

export {
  ZODIAC_AUTO_CHAIN_NEXT_TEST,
  ZODIAC_AUTO_CHAIN_KILL_RULE,
  ZODIAC_AUTO_CHAIN_LAST_EVIDENCE,
  zodiacDispatchFingerprint,
  ZODIAC_DISPATCH_DEDUP_STATUSES,
  ZODIAC_DISPATCH_CROSS_PARENT_MAX_AGE_MS,
  findZodiacDispatchDedup,
  zodiacTerminalRouteOutcome,
  dispatchZodiacTerminalFallback,
  resolveZodiacParentTaskId,
  orchestrateZodiacTeam
};
