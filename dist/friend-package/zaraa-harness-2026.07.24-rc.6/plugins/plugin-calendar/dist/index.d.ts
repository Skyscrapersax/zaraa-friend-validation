import { PluginManifest } from '@zaraa/shared';

/**
 * Injectable JXA executor. The default implementation shells out to
 * `osascript -l JavaScript -e <script>` and resolves with stdout. Tests inject
 * a fake so they never invoke the real osascript binary.
 */
type JxaExec = (script: string) => Promise<string>;
interface CalendarHandlerDeps {
    exec?: JxaExec;
    /** Timeout (ms) for the osascript subprocess. Default 15000. */
    timeoutMs?: number;
}
interface CalendarToolHandlers {
    calendar_today(args: unknown): Promise<string>;
    calendar_week(args: unknown): Promise<string>;
    calendar_upcoming(args: unknown): Promise<string>;
    calendar_create(args: unknown): Promise<string>;
    reminder_list(args: unknown): Promise<string>;
    reminder_create(args: unknown): Promise<string>;
    reminder_complete(args: unknown): Promise<string>;
}
/**
 * Build the macOS Calendar + Reminders tool handlers.
 *
 * The JXA executor is injectable so tests can pass a fake and never run the
 * real `osascript`. At runtime the daemon uses the default executor, which
 * shells out to osascript — that is intended (the daemon's job), and matches
 * how the existing core calendar tools reach Calendar.app.
 */
declare function createCalendarHandlers(deps?: CalendarHandlerDeps): CalendarToolHandlers;

/**
 * A calendar event as returned by the macOS Calendar.app scripting bridge.
 * Dates are emitted as ISO-8601 strings by the JXA layer.
 */
interface CalendarEvent {
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
interface Reminder {
    id: string;
    listName: string;
    title: string;
    dueISO?: string;
    completed: boolean;
    priority: "none" | "low" | "medium" | "high";
    notes?: string;
}

/**
 * macOS Calendar + Reminders plugin. Zone `guarded`: reads are scoped,
 * writes require approval. Implementation is JXA via `osascript -l JavaScript`
 * (design doc Option A). Tool names are namespaced `calendar_*` / `reminder_*`
 * and do NOT collide with core's `cal_*` provider-backed tools.
 */
declare const manifest: PluginManifest;

export { type CalendarEvent, type CalendarHandlerDeps, type CalendarToolHandlers, type JxaExec, type Reminder, createCalendarHandlers, manifest };
