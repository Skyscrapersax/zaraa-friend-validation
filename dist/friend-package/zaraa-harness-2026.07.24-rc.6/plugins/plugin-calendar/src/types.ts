import { z } from "zod";

/**
 * A calendar event as returned by the macOS Calendar.app scripting bridge.
 * Dates are emitted as ISO-8601 strings by the JXA layer.
 */
export interface CalendarEvent {
	id: string;
	calendarName: string;
	title: string;
	startISO: string;
	endISO: string;
	location?: string;
	notes?: string;
	allDay: boolean;
}

/**
 * A reminder as returned by the macOS Reminders.app scripting bridge.
 */
export interface Reminder {
	id: string;
	listName: string;
	title: string;
	dueISO?: string;
	completed: boolean;
	priority: "none" | "low" | "medium" | "high";
	notes?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas — validated at the handler boundary, mirroring the design doc.
// ---------------------------------------------------------------------------

export const calendarTodaySchema = z.object({
	calendarName: z.string().min(1).optional(),
});
export type CalendarTodayParams = z.infer<typeof calendarTodaySchema>;

export const calendarWeekSchema = z.object({
	calendarName: z.string().min(1).optional(),
	weekOffset: z.number().int().min(0).max(52).optional(),
});
export type CalendarWeekParams = z.infer<typeof calendarWeekSchema>;

export const calendarUpcomingSchema = z.object({
	limit: z.number().int().min(1).max(50),
	days: z.number().int().min(1).max(365).optional(),
});
export type CalendarUpcomingParams = z.infer<typeof calendarUpcomingSchema>;

export const calendarCreateSchema = z.object({
	title: z.string().min(1),
	startISO: z.string().datetime({ offset: true }),
	endISO: z.string().datetime({ offset: true }),
	calendarName: z.string().min(1).optional(),
	location: z.string().optional(),
	notes: z.string().optional(),
	allDay: z.boolean().optional(),
});
export type CalendarCreateParams = z.infer<typeof calendarCreateSchema>;

export const reminderListSchema = z.object({
	listName: z.string().min(1).optional(),
	includeCompleted: z.boolean().optional(),
});
export type ReminderListParams = z.infer<typeof reminderListSchema>;

export const reminderCreateSchema = z.object({
	title: z.string().min(1),
	dueISO: z.string().datetime({ offset: true }).optional(),
	listName: z.string().min(1).optional(),
	priority: z.enum(["none", "low", "medium", "high"]).optional(),
	notes: z.string().optional(),
});
export type ReminderCreateParams = z.infer<typeof reminderCreateSchema>;

export const reminderCompleteSchema = z.object({
	title: z.string().min(1),
	listName: z.string().min(1).optional(),
});
export type ReminderCompleteParams = z.infer<typeof reminderCompleteSchema>;
