import type { PluginManifest } from "@zaraa/shared";

export { createCalendarHandlers } from "./handlers.js";
export type {
	CalendarHandlerDeps,
	CalendarToolHandlers,
	JxaExec,
} from "./handlers.js";
export type { CalendarEvent, Reminder } from "./types.js";

/**
 * macOS Calendar + Reminders plugin. Zone `guarded`: reads are scoped,
 * writes require approval. Implementation is JXA via `osascript -l JavaScript`
 * (design doc Option A). Tool names are namespaced `calendar_*` / `reminder_*`
 * and do NOT collide with core's `cal_*` provider-backed tools.
 */
export const manifest: PluginManifest = {
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
						description: "Optional: only return events from this calendar.",
					},
				},
			},
		},
		{
			name: "calendar_week",
			description:
				"Get calendar events for a week. weekOffset 0 = this week, 1 = next week.",
			parameters: {
				type: "object",
				properties: {
					calendarName: {
						type: "string",
						description: "Optional: only return events from this calendar.",
					},
					weekOffset: {
						type: "number",
						description: "0 = this week (default), 1 = next week, etc.",
					},
				},
			},
		},
		{
			name: "calendar_upcoming",
			description: "Get the next N upcoming calendar events within a lookahead window.",
			parameters: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Max number of events to return (1-50).",
					},
					days: {
						type: "number",
						description: "Lookahead window in days (default 14).",
					},
				},
				required: ["limit"],
			},
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
						description: "Start time, ISO-8601 with offset (e.g. 2026-05-30T14:00:00-04:00).",
					},
					endISO: {
						type: "string",
						description: "End time, ISO-8601 with offset.",
					},
					calendarName: {
						type: "string",
						description: "Optional target calendar; defaults to first writable calendar.",
					},
					location: { type: "string", description: "Optional event location." },
					notes: { type: "string", description: "Optional event notes." },
					allDay: { type: "boolean", description: "Whether this is an all-day event." },
				},
				required: ["title", "startISO", "endISO"],
			},
			requiresApproval: true,
		},
		{
			name: "reminder_list",
			description:
				"List macOS Reminders (zone ≥ guarded; needs Automation TCC). If unavailable or TCC-denied, say so and use todo_list for personal Quests instead.",
			parameters: {
				type: "object",
				properties: {
					listName: {
						type: "string",
						description: "Optional: only return reminders from this list.",
					},
					includeCompleted: {
						type: "boolean",
						description: "Include completed reminders (default false).",
					},
				},
			},
		},
		{
			name: "reminder_create",
			description:
				"Create a macOS Reminders.app reminder (zone ≥ guarded, approval-gated, Automation TCC). If this tool is missing this turn, zone is sandbox, or the result mentions TCC/Automation denied: DEGRADE immediately to todo_add with the same title (due in title if known). Never claim an Apple reminder was created without a successful tool result.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "Reminder title." },
					dueISO: {
						type: "string",
						description: "Optional due date/time, ISO-8601 with offset.",
					},
					listName: {
						type: "string",
						description: "Optional target list; defaults to the default Reminders list.",
					},
					priority: {
						type: "string",
						enum: ["none", "low", "medium", "high"],
						description: "Reminder priority (default none).",
					},
					notes: { type: "string", description: "Optional reminder notes." },
				},
				required: ["title"],
			},
			requiresApproval: true,
		},
		{
			name: "reminder_complete",
			description:
				"Mark the first matching incomplete macOS reminder as done (zone ≥ guarded; TCC required). If unavailable, complete via todo_complete on the matching personal Quest instead when applicable.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "Title of the reminder to complete." },
					listName: {
						type: "string",
						description: "Optional list to search; otherwise all lists are searched.",
					},
				},
				required: ["title"],
			},
			requiresApproval: true,
		},
	],
};
