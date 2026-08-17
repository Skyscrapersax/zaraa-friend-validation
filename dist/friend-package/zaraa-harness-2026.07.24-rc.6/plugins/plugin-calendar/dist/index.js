// src/handlers.ts
import { execFile } from "child_process";

// src/jxa/calendar.ts
function toJxaLiteral(value) {
  return JSON.stringify(value ?? null);
}
var COLLECT_EVENTS_FN = `
function collectEvents(app, calName, startDate, endDate) {
  var out = [];
  var cals = calName ? app.calendars.whose({ name: calName }) : app.calendars;
  var n = cals.length;
  for (var i = 0; i < n; i++) {
    var cal = cals[i];
    var thisCalName = cal.name();
    var evts = cal.events.whose({
      _and: [{ startDate: { _greaterThanEquals: startDate } }, { startDate: { _lessThan: endDate } }],
    });
    var m = evts.length;
    for (var j = 0; j < m; j++) {
      var e = evts[j];
      var loc = null;
      try { loc = e.location(); } catch (err) { loc = null; }
      var notes = null;
      try { notes = e.notes(); } catch (err) { notes = null; }
      out.push({
        id: e.uid(),
        calendarName: thisCalName,
        title: e.summary(),
        startISO: e.startDate().toISOString(),
        endISO: e.endDate().toISOString(),
        location: loc || undefined,
        notes: notes || undefined,
        allDay: e.alldayEvent(),
      });
    }
  }
  out.sort(function (a, b) { return a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0; });
  return out;
}`;
function buildTodayScript(params) {
  const calName = toJxaLiteral(params.calendarName ?? null);
  return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var calName = ${calName};
  var start = new Date(); start.setHours(0, 0, 0, 0);
  var end = new Date(start.getTime()); end.setDate(end.getDate() + 1);
  return JSON.stringify(collectEvents(app, calName, start, end));
})();`;
}
function buildWeekScript(params) {
  const calName = toJxaLiteral(params.calendarName ?? null);
  const offset = toJxaLiteral(params.weekOffset ?? 0);
  return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var calName = ${calName};
  var offset = ${offset};
  var start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + offset * 7);
  var end = new Date(start.getTime()); end.setDate(end.getDate() + 7);
  return JSON.stringify(collectEvents(app, calName, start, end));
})();`;
}
function buildUpcomingScript(params) {
  const limit = toJxaLiteral(params.limit);
  const days = toJxaLiteral(params.days ?? 14);
  return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var limit = ${limit};
  var days = ${days};
  var start = new Date();
  var end = new Date(start.getTime()); end.setDate(end.getDate() + days);
  var all = collectEvents(app, null, start, end);
  return JSON.stringify(all.slice(0, limit));
})();`;
}
function buildCreateScript(params) {
  const title = toJxaLiteral(params.title);
  const startISO = toJxaLiteral(params.startISO);
  const endISO = toJxaLiteral(params.endISO);
  const calName = toJxaLiteral(params.calendarName ?? null);
  const location = toJxaLiteral(params.location ?? null);
  const notes = toJxaLiteral(params.notes ?? null);
  const allDay = toJxaLiteral(params.allDay ?? false);
  return `
(function () {
  var app = Application("Calendar");
  var calName = ${calName};
  var cal;
  if (calName) {
    var matches = app.calendars.whose({ name: calName });
    if (matches.length === 0) { throw new Error("Calendar not found: " + calName); }
    cal = matches[0];
  } else {
    var writable = app.calendars.whose({ writable: true });
    if (writable.length === 0) { throw new Error("No writable calendar available"); }
    cal = writable[0];
  }
  var props = {
    summary: ${title},
    startDate: new Date(${startISO}),
    endDate: new Date(${endISO}),
    alldayEvent: ${allDay},
  };
  var location = ${location};
  if (location) { props.location = location; }
  var notes = ${notes};
  if (notes) { props.notes = notes; }
  var evt = app.Event(props);
  cal.events.push(evt);
  return JSON.stringify({ id: evt.uid(), calendarName: cal.name() });
})();`;
}

// src/jxa/reminders.ts
var PRIORITY_TO_INT = {
  none: 0,
  high: 1,
  medium: 5,
  low: 9
};
var PRIORITY_NAME_FN = `
function priorityName(p) {
  if (p === 0) return "none";
  if (p >= 1 && p <= 4) return "high";
  if (p === 5) return "medium";
  if (p >= 6) return "low";
  return "none";
}`;
function buildListScript(params) {
  const listName = toJxaLiteral(params.listName ?? null);
  const includeCompleted = toJxaLiteral(params.includeCompleted ?? false);
  return `
(function () {
  var app = Application("Reminders");
  ${PRIORITY_NAME_FN}
  var listName = ${listName};
  var includeCompleted = ${includeCompleted};
  var lists = listName ? app.lists.whose({ name: listName }) : app.lists;
  var out = [];
  var n = lists.length;
  for (var i = 0; i < n; i++) {
    var lst = lists[i];
    var thisListName = lst.name();
    var rems = includeCompleted ? lst.reminders : lst.reminders.whose({ completed: false });
    var m = rems.length;
    for (var j = 0; j < m; j++) {
      var r = rems[j];
      var due = null;
      try { var d = r.dueDate(); if (d) { due = d.toISOString(); } } catch (err) { due = null; }
      var notes = null;
      try { notes = r.body(); } catch (err) { notes = null; }
      out.push({
        id: r.id(),
        listName: thisListName,
        title: r.name(),
        dueISO: due || undefined,
        completed: r.completed(),
        priority: priorityName(r.priority()),
        notes: notes || undefined,
      });
    }
  }
  return JSON.stringify(out);
})();`;
}
function buildCreateScript2(params) {
  const title = toJxaLiteral(params.title);
  const dueISO = toJxaLiteral(params.dueISO ?? null);
  const listName = toJxaLiteral(params.listName ?? null);
  const priorityInt = toJxaLiteral(PRIORITY_TO_INT[params.priority ?? "none"] ?? 0);
  const notes = toJxaLiteral(params.notes ?? null);
  return `
(function () {
  var app = Application("Reminders");
  var listName = ${listName};
  var lst;
  if (listName) {
    var matches = app.lists.whose({ name: listName });
    if (matches.length === 0) { throw new Error("Reminder list not found: " + listName); }
    lst = matches[0];
  } else {
    lst = app.defaultList();
  }
  var props = { name: ${title}, priority: ${priorityInt} };
  var dueISO = ${dueISO};
  if (dueISO) { props.dueDate = new Date(dueISO); }
  var notes = ${notes};
  if (notes) { props.body = notes; }
  var rem = app.Reminder(props);
  lst.reminders.push(rem);
  return JSON.stringify({ id: rem.id(), listName: lst.name() });
})();`;
}
function buildCompleteScript(params) {
  const title = toJxaLiteral(params.title);
  const listName = toJxaLiteral(params.listName ?? null);
  return `
(function () {
  var app = Application("Reminders");
  var title = ${title};
  var listName = ${listName};
  var lists = listName ? app.lists.whose({ name: listName }) : app.lists;
  var n = lists.length;
  for (var i = 0; i < n; i++) {
    var matches = lists[i].reminders.whose({ _and: [{ name: title }, { completed: false }] });
    if (matches.length > 0) {
      var r = matches[0];
      r.completed = true;
      return JSON.stringify({ id: r.id(), listName: lists[i].name(), completed: true });
    }
  }
  throw new Error("Reminder not found: " + title);
})();`;
}

// src/types.ts
import { z } from "zod";
var calendarTodaySchema = z.object({
  calendarName: z.string().min(1).optional()
});
var calendarWeekSchema = z.object({
  calendarName: z.string().min(1).optional(),
  weekOffset: z.number().int().min(0).max(52).optional()
});
var calendarUpcomingSchema = z.object({
  limit: z.number().int().min(1).max(50),
  days: z.number().int().min(1).max(365).optional()
});
var calendarCreateSchema = z.object({
  title: z.string().min(1),
  startISO: z.string().datetime({ offset: true }),
  endISO: z.string().datetime({ offset: true }),
  calendarName: z.string().min(1).optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  allDay: z.boolean().optional()
});
var reminderListSchema = z.object({
  listName: z.string().min(1).optional(),
  includeCompleted: z.boolean().optional()
});
var reminderCreateSchema = z.object({
  title: z.string().min(1),
  dueISO: z.string().datetime({ offset: true }).optional(),
  listName: z.string().min(1).optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
  notes: z.string().optional()
});
var reminderCompleteSchema = z.object({
  title: z.string().min(1),
  listName: z.string().min(1).optional()
});

// src/handlers.ts
var REMINDER_DEGRADE_HINT = "DEGRADE: call todo_add with the same title (put due date in the title if known). Do not claim an Apple reminder was created. After todo_add, tell the Human to grant macOS Automation/Reminders if they want Apple Reminders.";
var REMINDER_TCC_HUMAN_STEPS = "Human: System Settings \u2192 Privacy & Security \u2192 Automation \u2192 allow Calendar and Reminders for the Zaraa host (launchd node / Terminal), also Calendars + Reminders privacy lists, then restart the daemon (pnpm -s zaraa:ui-restart:execute). Verify with pnpm -s zaraa:reminders-tcc \u2014 do not claim success until reminders.status=granted.";
function friendlyExecError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  if (/-1743\b|-10000\b|not authorized|not allowed|Automation|permission|AppleEvent handler failed/i.test(
    raw
  )) {
    return new Error(
      `Automation/TCC permission denied for Calendar/Reminders. ${REMINDER_TCC_HUMAN_STEPS} ${REMINDER_DEGRADE_HINT} (detail: ${raw})`
    );
  }
  if (/-600|isn't running|not running|Application can.t be found/i.test(raw)) {
    return new Error(
      `Calendar.app or Reminders.app is not available. Open the app once (Spotlight: Calendar / Reminders) and retry. ${REMINDER_DEGRADE_HINT} (detail: ${raw})`
    );
  }
  return new Error(raw);
}
function defaultExec(timeoutMs) {
  return (script) => new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
function parseJxaJson(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return [];
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Failed to parse Calendar/Reminders output: ${trimmed.slice(0, 200)}`);
  }
}
function createCalendarHandlers(deps = {}) {
  const timeoutMs = deps.timeoutMs ?? 15e3;
  const exec = deps.exec ?? defaultExec(timeoutMs);
  async function run(script) {
    try {
      return await exec(script);
    } catch (err) {
      throw friendlyExecError(err);
    }
  }
  return {
    async calendar_today(args) {
      const params = calendarTodaySchema.parse(args ?? {});
      const out = await run(buildTodayScript(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async calendar_week(args) {
      const params = calendarWeekSchema.parse(args ?? {});
      const out = await run(buildWeekScript(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async calendar_upcoming(args) {
      const params = calendarUpcomingSchema.parse(args ?? {});
      const out = await run(buildUpcomingScript(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async calendar_create(args) {
      const params = calendarCreateSchema.parse(args ?? {});
      const out = await run(buildCreateScript(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async reminder_list(args) {
      const params = reminderListSchema.parse(args ?? {});
      const out = await run(buildListScript(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async reminder_create(args) {
      const params = reminderCreateSchema.parse(args ?? {});
      const out = await run(buildCreateScript2(params));
      return JSON.stringify(parseJxaJson(out));
    },
    async reminder_complete(args) {
      const params = reminderCompleteSchema.parse(args ?? {});
      const out = await run(buildCompleteScript(params));
      return JSON.stringify(parseJxaJson(out));
    }
  };
}

// src/index.ts
var manifest = {
  name: "calendar",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["calendar.read", "calendar.write", "reminders"],
  trust: "core",
  tools: [
    {
      name: "calendar_today",
      description: "Get today's calendar events. Optionally filter by calendar name.",
      parameters: {
        type: "object",
        properties: {
          calendarName: {
            type: "string",
            description: "Optional: only return events from this calendar."
          }
        }
      }
    },
    {
      name: "calendar_week",
      description: "Get calendar events for a week. weekOffset 0 = this week, 1 = next week.",
      parameters: {
        type: "object",
        properties: {
          calendarName: {
            type: "string",
            description: "Optional: only return events from this calendar."
          },
          weekOffset: {
            type: "number",
            description: "0 = this week (default), 1 = next week, etc."
          }
        }
      }
    },
    {
      name: "calendar_upcoming",
      description: "Get the next N upcoming calendar events within a lookahead window.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max number of events to return (1-50)."
          },
          days: {
            type: "number",
            description: "Lookahead window in days (default 14)."
          }
        },
        required: ["limit"]
      }
    },
    {
      name: "calendar_create",
      description: "Create a calendar event.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title." },
          startISO: {
            type: "string",
            description: "Start time, ISO-8601 with offset (e.g. 2026-05-30T14:00:00-04:00)."
          },
          endISO: {
            type: "string",
            description: "End time, ISO-8601 with offset."
          },
          calendarName: {
            type: "string",
            description: "Optional target calendar; defaults to first writable calendar."
          },
          location: { type: "string", description: "Optional event location." },
          notes: { type: "string", description: "Optional event notes." },
          allDay: { type: "boolean", description: "Whether this is an all-day event." }
        },
        required: ["title", "startISO", "endISO"]
      },
      requiresApproval: true
    },
    {
      name: "reminder_list",
      description: "List macOS Reminders (zone \u2265 guarded; needs Automation TCC). If unavailable or TCC-denied, say so and use todo_list for personal Quests instead.",
      parameters: {
        type: "object",
        properties: {
          listName: {
            type: "string",
            description: "Optional: only return reminders from this list."
          },
          includeCompleted: {
            type: "boolean",
            description: "Include completed reminders (default false)."
          }
        }
      }
    },
    {
      name: "reminder_create",
      description: "Create a macOS Reminders.app reminder (zone \u2265 guarded, approval-gated, Automation TCC). If this tool is missing this turn, zone is sandbox, or the result mentions TCC/Automation denied: DEGRADE immediately to todo_add with the same title (due in title if known). Never claim an Apple reminder was created without a successful tool result.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Reminder title." },
          dueISO: {
            type: "string",
            description: "Optional due date/time, ISO-8601 with offset."
          },
          listName: {
            type: "string",
            description: "Optional target list; defaults to the default Reminders list."
          },
          priority: {
            type: "string",
            enum: ["none", "low", "medium", "high"],
            description: "Reminder priority (default none)."
          },
          notes: { type: "string", description: "Optional reminder notes." }
        },
        required: ["title"]
      },
      requiresApproval: true
    },
    {
      name: "reminder_complete",
      description: "Mark the first matching incomplete macOS reminder as done (zone \u2265 guarded; TCC required). If unavailable, complete via todo_complete on the matching personal Quest instead when applicable.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the reminder to complete." },
          listName: {
            type: "string",
            description: "Optional list to search; otherwise all lists are searched."
          }
        },
        required: ["title"]
      },
      requiresApproval: true
    }
  ]
};
export {
  createCalendarHandlers,
  manifest
};
