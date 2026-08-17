import { execFile } from "node:child_process";

import {
	buildCreateScript as buildCalCreateScript,
	buildTodayScript,
	buildUpcomingScript,
	buildWeekScript,
} from "./jxa/calendar.js";
import {
	buildCompleteScript as buildRemCompleteScript,
	buildCreateScript as buildRemCreateScript,
	buildListScript as buildRemListScript,
} from "./jxa/reminders.js";
import {
	calendarCreateSchema,
	calendarTodaySchema,
	calendarUpcomingSchema,
	calendarWeekSchema,
	reminderCompleteSchema,
	reminderCreateSchema,
	reminderListSchema,
} from "./types.js";

/**
 * Injectable JXA executor. The default implementation shells out to
 * `osascript -l JavaScript -e <script>` and resolves with stdout. Tests inject
 * a fake so they never invoke the real osascript binary.
 */
export type JxaExec = (script: string) => Promise<string>;

export interface CalendarHandlerDeps {
	exec?: JxaExec;
	/** Timeout (ms) for the osascript subprocess. Default 15000. */
	timeoutMs?: number;
}

export interface CalendarToolHandlers {
	calendar_today(args: unknown): Promise<string>;
	calendar_week(args: unknown): Promise<string>;
	calendar_upcoming(args: unknown): Promise<string>;
	calendar_create(args: unknown): Promise<string>;
	reminder_list(args: unknown): Promise<string>;
	reminder_create(args: unknown): Promise<string>;
	reminder_complete(args: unknown): Promise<string>;
}

/**
 * Operator + model guidance when Calendar/Reminders JXA fails.
 * Dogfood D5: never leave the model with a vague "tool not available" —
 * always include Human TCC steps and an immediate todo_add degrade path.
 */
export const REMINDER_DEGRADE_HINT =
	"DEGRADE: call todo_add with the same title (put due date in the title if known). Do not claim an Apple reminder was created. After todo_add, tell the Human to grant macOS Automation/Reminders if they want Apple Reminders.";

export const REMINDER_TCC_HUMAN_STEPS =
	"Human: System Settings → Privacy & Security → Automation → allow Calendar and Reminders for the Zaraa host (launchd node / Terminal), also Calendars + Reminders privacy lists, then restart the daemon (pnpm -s zaraa:ui-restart:execute). Verify with pnpm -s zaraa:reminders-tcc — do not claim success until reminders.status=granted.";

/** Hint surfaced when an app is missing or Automation permission was denied. */
export function friendlyExecError(err: unknown): Error {
	const raw = err instanceof Error ? err.message : String(err);
	if (
		/-1743\b|-10000\b|not authorized|not allowed|Automation|permission|AppleEvent handler failed/i.test(
			raw,
		)
	) {
		return new Error(
			`Automation/TCC permission denied for Calendar/Reminders. ${REMINDER_TCC_HUMAN_STEPS} ${REMINDER_DEGRADE_HINT} (detail: ${raw})`,
		);
	}
	if (/-600|isn't running|not running|Application can.t be found/i.test(raw)) {
		return new Error(
			`Calendar.app or Reminders.app is not available. Open the app once (Spotlight: Calendar / Reminders) and retry. ${REMINDER_DEGRADE_HINT} (detail: ${raw})`,
		);
	}
	return new Error(raw);
}

/** Default executor: run a JXA program through osascript and return stdout. */
function defaultExec(timeoutMs: number): JxaExec {
	return (script: string) =>
		new Promise<string>((resolve, reject) => {
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
				},
			);
		});
}

/** Parse JXA stdout (a JSON string) into a typed value, with a clear error. */
function parseJxaJson<T>(stdout: string): T {
	const trimmed = (stdout ?? "").trim();
	if (!trimmed) {
		// An empty result for a read tool means "no rows".
		return [] as unknown as T;
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new Error(`Failed to parse Calendar/Reminders output: ${trimmed.slice(0, 200)}`);
	}
}

/**
 * Build the macOS Calendar + Reminders tool handlers.
 *
 * The JXA executor is injectable so tests can pass a fake and never run the
 * real `osascript`. At runtime the daemon uses the default executor, which
 * shells out to osascript — that is intended (the daemon's job), and matches
 * how the existing core calendar tools reach Calendar.app.
 */
export function createCalendarHandlers(deps: CalendarHandlerDeps = {}): CalendarToolHandlers {
	const timeoutMs = deps.timeoutMs ?? 15000;
	const exec: JxaExec = deps.exec ?? defaultExec(timeoutMs);

	async function run(script: string): Promise<string> {
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
			const out = await run(buildCalCreateScript(params));
			return JSON.stringify(parseJxaJson(out));
		},

		async reminder_list(args) {
			const params = reminderListSchema.parse(args ?? {});
			const out = await run(buildRemListScript(params));
			return JSON.stringify(parseJxaJson(out));
		},

		async reminder_create(args) {
			const params = reminderCreateSchema.parse(args ?? {});
			const out = await run(buildRemCreateScript(params));
			return JSON.stringify(parseJxaJson(out));
		},

		async reminder_complete(args) {
			const params = reminderCompleteSchema.parse(args ?? {});
			const out = await run(buildRemCompleteScript(params));
			return JSON.stringify(parseJxaJson(out));
		},
	};
}
