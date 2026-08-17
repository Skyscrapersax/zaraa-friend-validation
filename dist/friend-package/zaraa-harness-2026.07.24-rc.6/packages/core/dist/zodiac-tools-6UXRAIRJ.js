import {
  ZODIAC_AUTO_CHAIN_KILL_RULE,
  ZODIAC_AUTO_CHAIN_LAST_EVIDENCE,
  ZODIAC_AUTO_CHAIN_NEXT_TEST,
  findZodiacDispatchDedup,
  orchestrateZodiacTeam,
  resolveZodiacParentTaskId,
  zodiacDispatchFingerprint
} from "./chunk-WDU3C6PH.js";
import {
  buildZodiacDispatchPrompt,
  getZodiacAgent,
  listZodiacAgents,
  routeZodiacTask
} from "./chunk-55GC5LHT.js";
import {
  createTaskThroughIngress,
  shouldSuppressCannedRefusalTreadmillPrompt,
  shouldSuppressTaskFanoutForPrompt
} from "./chunk-LYHYCBGR.js";
import "./chunk-R5U7XKVJ.js";

// src/zodiac/zodiac-tools.ts
var VALID_PRIORITIES = /* @__PURE__ */ new Set(["low", "normal", "high", "urgent"]);
function enrichTask(taskStore, task) {
  return {
    ...task,
    dependsOn: taskStore.getDependencies(task.id),
    dependents: taskStore.getDependents(task.id)
  };
}
function resolveCurrentZone(deps, context) {
  return context?.zone ?? deps.getCurrentZone();
}
function normalizeZone(requestedZone, currentZone) {
  if (requestedZone === void 0 || requestedZone === null || requestedZone === "") {
    return currentZone;
  }
  if (requestedZone !== "sandbox" && requestedZone !== "guarded" && requestedZone !== "trusted") {
    throw new Error("Invalid zone. Use sandbox, guarded, or trusted.");
  }
  const zoneLevel = { sandbox: 0, guarded: 1, trusted: 2 };
  if (zoneLevel[requestedZone] > zoneLevel[currentZone]) {
    throw new Error(`Cannot create tasks above the current request zone (${currentZone}).`);
  }
  return requestedZone;
}
function normalizePriority(priority) {
  if (priority === void 0 || priority === null || priority === "") {
    return "normal";
  }
  if (typeof priority !== "string" || !VALID_PRIORITIES.has(priority)) {
    throw new Error("Invalid priority. Use low, normal, high, or urgent.");
  }
  return priority;
}
function normalizeLimit(limit, defaultLimit = 3) {
  if (limit === void 0 || limit === null || limit === "") return defaultLimit;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("limit must be a number.");
  }
  return Math.max(1, Math.min(Math.trunc(limit), 5));
}
function normalizeOptionalString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function summarizeAgent(agent) {
  return {
    sign: agent.sign,
    codename: agent.codename,
    sector: agent.sector,
    mission: agent.mission,
    workerModelTarget: agent.workerModelTarget,
    preferredToolPrefixes: [...agent.preferredToolPrefixes],
    opportunityClass: agent.opportunityClass
  };
}
function buildForcedRoute(agent, originalObjective) {
  return {
    primary: {
      sign: agent.sign,
      codename: agent.codename,
      sector: agent.sector,
      score: 999,
      confidence: "high",
      reasons: [`forced:${agent.sign.toLowerCase()}`, `objective:${originalObjective.slice(0, 80)}`]
    },
    alternatives: [],
    forced: true
  };
}
function normalizePlannerTier(value) {
  if (value === void 0 || value === null || value === "") return "auto";
  if (value === "auto" || value === "coding" || value === "opus") return value;
  throw new Error("Invalid plannerTier. Use auto, coding, or opus.");
}
function choosePlannerTier(value, priority) {
  if (value === "coding" || value === "opus") return value;
  return priority === "urgent" ? "opus" : "coding";
}
function assertZodiacQueueAllowed(deps, objective, parts = []) {
  if (deps.getTaskGenerationPaused?.()) {
    throw new Error("Zodiac queueing is blocked because task generation is paused.");
  }
  const combined = [objective, ...parts.filter((part) => typeof part === "string")].join("\n");
  if (shouldSuppressCannedRefusalTreadmillPrompt(combined)) {
    throw new Error(
      "zodiac queueing blocked for canned-refusal treadmill. Archive or rewrite the slipping-goal source before queueing specialist tasks."
    );
  }
  if (shouldSuppressTaskFanoutForPrompt(combined)) {
    throw new Error(
      "zodiac queueing blocked for controlled SIP self-improvement patches. Return a named next patch candidate instead of queuing specialist tasks."
    );
  }
}
var manifest = {
  name: "zodiac",
  version: "1.0.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["agents.specialists", "tasks.queue"],
  trust: "core",
  tools: [
    {
      name: "zodiac_list_agents",
      description: "List the Zodiac Symphony specialist agents or inspect one sign in detail.",
      parameters: {
        type: "object",
        properties: {
          sign: { type: "string", description: "Optional zodiac sign or codename filter." },
          verbose: { type: "boolean", description: "Return full definitions instead of compact summaries." }
        },
        required: []
      }
    },
    {
      name: "zodiac_route_task",
      description: "Route an objective to the best-fit zodiac specialist and show the next best alternatives.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The task or objective to route." },
          topK: { type: "number", description: "How many ranked matches to return (1-5)." }
        },
        required: ["objective"]
      }
    },
    {
      name: "zodiac_dispatch",
      description: "Build or queue a sign-specific Zodiac Symphony task packet for Zaraa to execute.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The objective for the sign to handle." },
          sign: { type: "string", description: "Optional explicit sign. Omit to auto-route." },
          context: { type: "string", description: "Optional task context or background details." },
          deliverable: { type: "string", description: "Optional deliverable or output expectations." },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Priority for queued mode."
          },
          zone: {
            type: "string",
            enum: ["sandbox", "guarded", "trusted"],
            description: "Optional execution zone for queued mode."
          },
          mode: {
            type: "string",
            enum: ["queue", "draft"],
            description: "Queue the task or just return the composed prompt."
          },
          goalRef: {
            type: "string",
            description: "Optional steering goal attachment for the specialist task."
          },
          checkpointRef: {
            type: "string",
            description: "Optional steering checkpoint attachment for the specialist task."
          },
          whyNow: {
            type: "string",
            description: "Why this dispatch matters now."
          },
          doneDefinition: {
            type: "string",
            description: "Observable done condition for the specialist packet."
          },
          expiry: {
            type: "string",
            description: "Optional ISO timestamp after which the packet should be reconsidered."
          },
          parentId: {
            type: "string",
            description: "Optional real parent task UUID for queued specialist lineage. Non-UUID values are ignored."
          }
        },
        required: ["objective"]
      }
    },
    {
      name: "zodiac_orchestrate",
      description: "Spin up a small zodiac specialist team so Big Mama Zaraa can keep the main line while specialists handle narrow support work.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The parent objective the zodiac team should support." },
          context: { type: "string", description: "Optional background context for the team." },
          deliverable: { type: "string", description: "Optional parent deliverable or desired end state." },
          maxAgents: { type: "number", description: "How many specialist signs to activate (1-5)." },
          plannerTier: {
            type: "string",
            enum: ["auto", "coding", "opus"],
            description: "Which premium planning tier to use when composing the team plan."
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Priority for queued specialist tasks."
          },
          zone: {
            type: "string",
            enum: ["sandbox", "guarded", "trusted"],
            description: "Optional execution zone for queued mode."
          },
          mode: {
            type: "string",
            enum: ["queue", "draft"],
            description: "Queue the specialist tasks or just return the plan."
          },
          goalRef: {
            type: "string",
            description: "Optional shared goal attachment for all specialist tasks."
          },
          checkpointRef: {
            type: "string",
            description: "Optional shared checkpoint attachment for all specialist tasks."
          },
          whyNow: {
            type: "string",
            description: "Why the orchestration matters now."
          },
          doneDefinition: {
            type: "string",
            description: "Observable done condition for the orchestration packet."
          },
          expiry: {
            type: "string",
            description: "Optional ISO timestamp after which the orchestration should be revisited."
          },
          parentId: {
            type: "string",
            description: "Optional real parent task UUID for queued specialist lineage. Non-UUID values are ignored."
          }
        },
        required: ["objective"]
      }
    }
  ]
};
function createHandlers(deps) {
  return {
    zodiac_list_agents: async (args) => {
      const sign = typeof args.sign === "string" ? args.sign.trim() : "";
      const verbose = args.verbose === true;
      if (sign) {
        const agent = getZodiacAgent(sign);
        if (!agent) {
          throw new Error(`Unknown zodiac agent: ${sign}`);
        }
        return verbose ? agent : summarizeAgent(agent);
      }
      const agents = listZodiacAgents();
      return verbose ? agents : agents.map((agent) => summarizeAgent(agent));
    },
    zodiac_route_task: async (args) => {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) {
        throw new Error("zodiac_route_task requires an objective.");
      }
      const topK = normalizeLimit(args.topK, 3);
      const result = routeZodiacTask(objective, topK);
      return {
        objective,
        primary: result.primary,
        alternatives: result.alternatives.slice(0, Math.max(0, topK - 1))
      };
    },
    zodiac_dispatch: async (args, context) => {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) {
        throw new Error("zodiac_dispatch requires an objective.");
      }
      const requestedSign = typeof args.sign === "string" ? args.sign.trim() : "";
      const route = routeZodiacTask(objective, 3);
      const agent = requestedSign ? getZodiacAgent(requestedSign) : getZodiacAgent(route.primary.sign);
      if (!agent) {
        throw new Error(`Unknown zodiac agent: ${requestedSign}`);
      }
      const dedupHash = zodiacDispatchFingerprint(agent.sign, objective);
      const prompt = buildZodiacDispatchPrompt({
        agent,
        objective,
        context: typeof args.context === "string" ? args.context : void 0,
        deliverable: typeof args.deliverable === "string" ? args.deliverable : void 0,
        dedupHash
      });
      const mode = args.mode === "draft" ? "draft" : "queue";
      if (mode === "draft") {
        return {
          mode,
          agent: summarizeAgent(agent),
          route: requestedSign ? buildForcedRoute(agent, objective) : route,
          prompt
        };
      }
      assertZodiacQueueAllowed(deps, objective, [
        args.context,
        args.deliverable,
        args.goalRef,
        args.checkpointRef,
        args.doneDefinition
      ]);
      const currentZone = resolveCurrentZone(deps, context);
      const zone = normalizeZone(args.zone, currentZone);
      const priority = normalizePriority(args.priority);
      const resolvedParent = resolveZodiacParentTaskId(normalizeOptionalString(args.parentId)) ?? resolveZodiacParentTaskId(context?.sessionId);
      const dedupPrefix = `[Zodiac Dispatch: ${agent.sign}]
Dedup hash: ${dedupHash}`;
      if (!resolvedParent) {
        return {
          mode: "draft",
          agent: summarizeAgent(agent),
          route: requestedSign ? buildForcedRoute(agent, objective) : route,
          prompt,
          queueSuppressed: true,
          reason: "Zodiac queueing requires a real parent task UUID."
        };
      }
      const existingTask = findZodiacDispatchDedup(
        deps.taskStore,
        dedupPrefix,
        resolvedParent
      );
      if (existingTask) {
        return {
          mode,
          agent: summarizeAgent(agent),
          route: requestedSign ? buildForcedRoute(agent, objective) : route,
          task: enrichTask(deps.taskStore, existingTask),
          prompt: existingTask.prompt,
          deduplicated: true
        };
      }
      const metadata = {
        goalRef: normalizeOptionalString(args.goalRef) ?? objective,
        checkpointRef: normalizeOptionalString(args.checkpointRef) ?? `${agent.sign}: specialist packet`,
        whyNow: normalizeOptionalString(args.whyNow) ?? `Parallelize ${agent.sign}'s lane against the active objective.`,
        doneDefinition: normalizeOptionalString(args.doneDefinition) ?? (typeof args.deliverable === "string" ? args.deliverable.trim() : objective),
        expiry: normalizeOptionalString(args.expiry) ?? null,
        packetShape: "zodiac-specialist",
        nextTest: ZODIAC_AUTO_CHAIN_NEXT_TEST,
        killRule: ZODIAC_AUTO_CHAIN_KILL_RULE,
        lastEvidence: ZODIAC_AUTO_CHAIN_LAST_EVIDENCE
      };
      const created = createTaskThroughIngress(deps.taskStore, {
        prompt,
        zone,
        priority,
        source: "auto-chain",
        parentId: resolvedParent,
        metadata
      });
      deps.triggerProcessing?.();
      return {
        mode,
        agent: summarizeAgent(agent),
        route: requestedSign ? buildForcedRoute(agent, objective) : route,
        task: enrichTask(deps.taskStore, created),
        prompt
      };
    },
    zodiac_orchestrate: async (args, context) => {
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      if (!objective) {
        throw new Error("zodiac_orchestrate requires an objective.");
      }
      const currentZone = resolveCurrentZone(deps, context);
      const zone = normalizeZone(args.zone, currentZone);
      const priority = normalizePriority(args.priority);
      const plannerTier = choosePlannerTier(normalizePlannerTier(args.plannerTier), priority);
      const mode = args.mode === "draft" ? "draft" : "queue";
      if (mode === "queue") {
        assertZodiacQueueAllowed(deps, objective, [
          args.context,
          args.deliverable,
          args.goalRef,
          args.checkpointRef,
          args.doneDefinition
        ]);
      }
      const resolvedParent = resolveZodiacParentTaskId(normalizeOptionalString(args.parentId)) ?? resolveZodiacParentTaskId(context?.sessionId);
      if (mode === "queue" && !resolvedParent) {
        return {
          objective,
          mode,
          plannerTier,
          assignments: [],
          parentId: null,
          plannerFallback: false,
          queueSuppressed: true,
          queueSuppressionReason: "Zodiac queueing requires a real parent task UUID."
        };
      }
      return orchestrateZodiacTeam(
        {
          objective,
          context: typeof args.context === "string" ? args.context : void 0,
          deliverable: typeof args.deliverable === "string" ? args.deliverable : void 0,
          maxAgents: normalizeLimit(args.maxAgents, 3),
          plannerTier,
          mode,
          zone,
          priority,
          // Prefer the explicit arg, then the parent task's own stored goalRef,
          // then raw objective as the last resort. Falling straight to objective
          // (the old behavior) fragments goalRef into a new bucket on every
          // prompt wording tweak, which silently defeats every goalRef-keyed
          // dedup/treadmill check downstream (confirmed live, ngt-0059).
          goalRef: normalizeOptionalString(args.goalRef) ?? (resolvedParent ? deps.taskStore.goalRefForTask(resolvedParent) : null) ?? objective,
          checkpointRef: normalizeOptionalString(args.checkpointRef) ?? "zodiac-orchestration",
          whyNow: normalizeOptionalString(args.whyNow),
          doneDefinition: normalizeOptionalString(args.doneDefinition),
          expiry: normalizeOptionalString(args.expiry),
          parentId: resolvedParent
        },
        {
          plannerFn: deps.plannerFn,
          taskStore: deps.taskStore,
          triggerProcessing: deps.triggerProcessing
        }
      );
    }
  };
}
export {
  createHandlers,
  manifest
};
