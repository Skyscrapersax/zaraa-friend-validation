import {
  hasGoalCheckpointAttachment,
  isNonTrivialTaskPacket
} from "./chunk-VPAFC2NK.js";
import {
  createTaskThroughIngress,
  shouldSuppressTaskFanoutForPrompt
} from "./chunk-LYHYCBGR.js";
import "./chunk-R5U7XKVJ.js";

// src/tasks/task-tools.ts
var ZONE_LEVEL = {
  sandbox: 0,
  guarded: 1,
  trusted: 2
};
var VALID_STATUSES = /* @__PURE__ */ new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked"
]);
var VALID_QUEUE_MODES = /* @__PURE__ */ new Set(["all", "operator", "agent", "system"]);
var VALID_PRIORITIES = /* @__PURE__ */ new Set(["low", "normal", "high", "urgent"]);
function assertControlledSipFanoutAllowed(toolName, text) {
  if (/\bsip-\d{4}\b/i.test(text) && shouldSuppressTaskFanoutForPrompt(text)) {
    throw new Error(
      `${toolName} blocked for controlled SIP self-improvement patches. Return a named next patch candidate instead of queuing child tasks.`
    );
  }
}
function normalizeOptionalString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeExpiry(value) {
  const expiry = normalizeOptionalString(value);
  if (!expiry) return void 0;
  const parsed = new Date(expiry);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("expiry must be an ISO date or datetime string.");
  }
  return parsed.toISOString();
}
function normalizeTaskMetadata(args, prompt, source) {
  const metadata = {
    goalRef: normalizeOptionalString(args.goalRef ?? args.goal_ref) ?? null,
    checkpointRef: normalizeOptionalString(args.checkpointRef ?? args.checkpoint_ref) ?? null,
    whyNow: normalizeOptionalString(args.whyNow ?? args.why_now) ?? null,
    doneDefinition: normalizeOptionalString(args.doneDefinition ?? args.done_definition) ?? null,
    expiry: normalizeExpiry(args.expiry) ?? null,
    noChildTasks: args.noChildTasks === true || args.no_child_tasks === true ? true : null
  };
  const hasAnyValue = Object.values(metadata).some((value) => value !== null && value !== void 0);
  if (!hasAnyValue && !isNonTrivialTaskPacket(prompt, source)) {
    return void 0;
  }
  if (isNonTrivialTaskPacket(prompt, source) && !hasGoalCheckpointAttachment(metadata)) {
    return {
      ...metadata,
      whyNow: metadata.whyNow ?? "Unattached work surfaced for steering review."
    };
  }
  return metadata;
}
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
function normalizeZone(requestedZone, currentZone, onExceedsRequest) {
  if (requestedZone === void 0 || requestedZone === null || requestedZone === "") {
    return currentZone;
  }
  if (requestedZone !== "sandbox" && requestedZone !== "guarded" && requestedZone !== "trusted") {
    throw new Error("Invalid zone. Use sandbox, guarded, or trusted.");
  }
  if (ZONE_LEVEL[requestedZone] > ZONE_LEVEL[currentZone]) {
    onExceedsRequest?.(requestedZone, currentZone);
    throw new Error(
      `Cannot create tasks above the current request zone (${currentZone}). Requested ${requestedZone}: elevate the session/request zone first (e.g. operator trusted context or gateway zone), then retry.`
    );
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
function normalizeStatus(status) {
  if (status === void 0 || status === null || status === "") {
    return void 0;
  }
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    throw new Error(
      "Invalid status. Use pending, running, completed, failed, cancelled, or blocked."
    );
  }
  return status;
}
function normalizeQueueMode(raw) {
  if (raw === void 0 || raw === null || raw === "") {
    return void 0;
  }
  if (typeof raw !== "string") {
    throw new Error("Invalid queueMode. Use all, operator, agent, or system.");
  }
  const mode = raw.toLowerCase().trim();
  if (!VALID_QUEUE_MODES.has(mode)) {
    throw new Error("Invalid queueMode. Use all, operator, agent, or system.");
  }
  return mode;
}
function normalizeLimit(limit, defaultLimit = 25) {
  if (limit === void 0 || limit === null || limit === "") return defaultLimit;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("limit must be a number.");
  }
  return Math.max(1, Math.min(Math.trunc(limit), 100));
}
function buildConversationNotificationPreference(context) {
  if (!context?.sessionId || !context.replyChannel) return void 0;
  return {
    completion: true,
    channels: [context.replyChannel],
    sessionId: context.sessionId
  };
}
function extractTaskId(args) {
  const directCandidates = [args.id, args.taskId, args.task_id];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const raw = typeof args._rawArguments === "string" ? args._rawArguments : "";
  if (!raw) return "";
  const keyedMatch = raw.match(/["'`]?((?:task[_ ]?id)|id)["'`]?\s*:\s*["'`]([^"'`]+)["'`]/i);
  if (keyedMatch?.[2]) {
    return keyedMatch[2].trim();
  }
  const uuidMatch = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return uuidMatch?.[0] ?? "";
}
function recoverTaskCreateArgs(args) {
  const raw = typeof args._rawArguments === "string" ? args._rawArguments.trim() : "";
  if (!raw) return args;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...parsed, ...args };
    }
  } catch {
  }
  if (!raw.startsWith("{") && !raw.startsWith("[") && typeof args.prompt !== "string") {
    return { prompt: raw, ...args };
  }
  return args;
}
var manifest = {
  name: "tasks",
  version: "1.0.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["tasks.queue", "tasks.planning"],
  trust: "core",
  tools: [
    {
      name: "task_create",
      description: 'Queue a single background task for Zaraa to execute asynchronously. Always pass a JSON object like {"prompt":"...","priority":"high"}.',
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The task instruction or objective." },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Execution priority."
          },
          zone: {
            type: "string",
            enum: ["sandbox", "guarded", "trusted"],
            description: "Optional execution zone. Defaults to the current request zone and cannot exceed it."
          },
          queueMode: {
            type: "string",
            enum: ["all", "operator", "agent", "system"],
            description: "Optional queue lane. Defaults to all."
          },
          goalRef: {
            type: "string",
            description: "Goal identifier or title for steering attachment."
          },
          checkpointRef: {
            type: "string",
            description: "Current checkpoint identifier or checkpoint summary."
          },
          whyNow: {
            type: "string",
            description: "Why this task matters now."
          },
          doneDefinition: {
            type: "string",
            description: "Observable completion condition for the task."
          },
          expiry: {
            type: "string",
            description: "Optional ISO timestamp after which the packet should be reconsidered."
          },
          noChildTasks: {
            type: "boolean",
            description: "When true, the task must not spawn follow-ups, task_plan/task_create children, or Zodiac specialist lanes."
          }
        },
        required: ["prompt"]
      }
    },
    {
      name: "task_plan",
      description: "Break a goal into an ordered task list with dependencies, queue the tasks, and start processing them.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The higher-level goal to decompose into tasks." },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Priority applied to the created tasks."
          },
          zone: {
            type: "string",
            enum: ["sandbox", "guarded", "trusted"],
            description: "Optional execution zone. Defaults to the current request zone and cannot exceed it."
          },
          queueMode: {
            type: "string",
            enum: ["all", "operator", "agent", "system"],
            description: "Optional queue lane for all created steps. Defaults to all."
          },
          goalRef: {
            type: "string",
            description: "Optional goal identifier or title. Defaults to the goal text when omitted."
          },
          checkpointRef: {
            type: "string",
            description: "Optional checkpoint anchor for all planned steps."
          },
          whyNow: {
            type: "string",
            description: "Why this plan matters now."
          },
          doneDefinition: {
            type: "string",
            description: "Observable completion condition for the overall plan."
          },
          expiry: {
            type: "string",
            description: "Optional ISO timestamp after which the plan should be revisited."
          }
        },
        required: ["goal"]
      }
    },
    {
      name: "task_list",
      description: "List queued or completed tasks, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "running", "completed", "failed", "cancelled", "blocked"],
            description: "Optional task status filter."
          },
          limit: { type: "number", description: "Maximum number of tasks to return (1-100)." }
        },
        required: []
      }
    },
    {
      name: "task_get",
      description: 'Get one task with dependency details. Always pass a JSON object like {"id":"<task-id>"}; mentioning the id in prose is not enough.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task ID." }
        },
        required: ["id"]
      }
    },
    {
      name: "task_cancel",
      description: 'Cancel a pending task so it does not run. Always pass a JSON object like {"id":"<task-id>"}.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task ID." }
        },
        required: ["id"]
      }
    },
    {
      name: "task_requeue",
      description: 'Requeue a failed task so Zaraa can try it again. Always pass a JSON object like {"id":"<task-id>"}.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task ID." }
        },
        required: ["id"]
      }
    }
  ]
};
function createHandlers(deps) {
  return {
    task_create: async (args, context) => {
      const recoveredArgs = recoverTaskCreateArgs(args);
      const prompt = typeof recoveredArgs.prompt === "string" ? recoveredArgs.prompt.trim() : "";
      if (!prompt) {
        throw new Error("task_create requires a prompt.");
      }
      assertControlledSipFanoutAllowed("task_create", prompt);
      const currentZone = resolveCurrentZone(deps, context);
      const zone = normalizeZone(recoveredArgs.zone, currentZone, (requested, request) => {
        deps.emitTaskZonePolicySignal?.({
          reasonCode: "task_zone_exceeds_request",
          requestedZone: requested,
          requestZone: request
        });
      });
      const priority = normalizePriority(recoveredArgs.priority);
      const queueMode = normalizeQueueMode(recoveredArgs.queueMode);
      const metadata = normalizeTaskMetadata(recoveredArgs, prompt, "chat");
      const notifications = buildConversationNotificationPreference(context);
      const taskInput = {
        prompt,
        zone,
        priority,
        source: "chat",
        initiator: "agent",
        queueMode,
        ...metadata ? { metadata } : {}
      };
      const task = (() => {
        if (!deps.createTask) {
          return createTaskThroughIngress(deps.taskStore, taskInput);
        }
        const created = deps.createTask({
          ...taskInput,
          ...notifications ? { notifications } : {}
        });
        const hydrated = deps.taskStore.get(created.id);
        if (!hydrated) {
          throw new Error(`Created task ${created.id} could not be loaded.`);
        }
        return hydrated;
      })();
      deps.triggerProcessing?.();
      return enrichTask(deps.taskStore, task);
    },
    task_plan: async (args, context) => {
      if (!deps.planAndDispatch) {
        throw new Error("Task planning is not configured.");
      }
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (!goal) {
        throw new Error("task_plan requires a goal.");
      }
      assertControlledSipFanoutAllowed("task_plan", goal);
      const currentZone = resolveCurrentZone(deps, context);
      const zone = normalizeZone(args.zone, currentZone, (requested, request) => {
        deps.emitTaskZonePolicySignal?.({
          reasonCode: "task_zone_exceeds_request",
          requestedZone: requested,
          requestZone: request
        });
      });
      const priority = normalizePriority(args.priority);
      const queueMode = normalizeQueueMode(args.queueMode);
      const notifications = buildConversationNotificationPreference(context);
      return deps.planAndDispatch(goal, {
        zone,
        priority,
        initiator: "agent",
        queueMode,
        goalRef: normalizeOptionalString(args.goalRef ?? args.goal_ref) ?? goal,
        checkpointRef: normalizeOptionalString(args.checkpointRef ?? args.checkpoint_ref) ?? "plan-step",
        whyNow: normalizeOptionalString(args.whyNow ?? args.why_now),
        doneDefinition: normalizeOptionalString(args.doneDefinition ?? args.done_definition),
        expiry: normalizeExpiry(args.expiry),
        ...notifications ? { notifications } : {}
      });
    },
    task_list: async (args) => {
      const status = normalizeStatus(args.status);
      const limit = normalizeLimit(args.limit, 25);
      return {
        stats: deps.taskStore.stats(),
        // Surfaces Backlog Staleness Pressure (BSP) on the same cadence every
        // task_list call already runs on — no new heartbeat/health job needed.
        // See ~/.zaraa/knowledge/backlog-ranking-rubric.md: BSP has been
        // self-monitoring since task-store.ts landed it, but nothing outside
        // task-store.ts read it until now. Land the age-escalation SQL term
        // only once this is observed crossing above 0 in real operation.
        queueStaleness: deps.taskStore.getQueueSnapshot().staleness,
        review: deps.taskStore.getReviewSummary(limit),
        zodiacMetrics: deps.getZodiacMetricsReport?.() ?? null,
        tasks: deps.taskStore.list({
          ...status ? { status } : {},
          limit
        }).map((task) => enrichTask(deps.taskStore, task))
      };
    },
    task_get: async (args) => {
      const id = extractTaskId(args);
      if (!id) {
        throw new Error("task_get requires an id.");
      }
      const task = deps.taskStore.get(id);
      if (!task) {
        throw new Error(`Task ${id} not found.`);
      }
      return enrichTask(deps.taskStore, task);
    },
    task_cancel: async (args) => {
      const id = extractTaskId(args);
      if (!id) {
        throw new Error("task_cancel requires an id.");
      }
      const cancelled = deps.taskStore.cancel(id);
      if (!cancelled) {
        throw new Error("Task cannot be cancelled because it is not pending.");
      }
      const task = deps.taskStore.get(id);
      if (!task) {
        throw new Error(`Task ${id} not found after cancellation.`);
      }
      return enrichTask(deps.taskStore, task);
    },
    task_requeue: async (args) => {
      const id = extractTaskId(args);
      if (!id) {
        throw new Error("task_requeue requires an id.");
      }
      const requeued = deps.taskStore.requeue(id);
      if (!requeued) {
        throw new Error("Task cannot be requeued because it is not failed.");
      }
      deps.triggerProcessing?.();
      const task = deps.taskStore.get(id);
      if (!task) {
        throw new Error(`Task ${id} not found after requeue.`);
      }
      return enrichTask(deps.taskStore, task);
    }
  };
}
export {
  createHandlers,
  manifest
};
