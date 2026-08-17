/**
 * Opus grind cycle gating: aligns with NotificationManager-style quiet windows
 * (HH:MM local). When `quietHours` is undefined, uses 23:00–07:00 overnight window.
 */

export type QuietHoursWindow = { start: string; end: string };

const DEFAULT_QUIET: QuietHoursWindow = { start: "23:00", end: "07:00" };

/** Parse "HH:MM" → minutes from midnight; returns undefined if invalid */
function parseTimeToMinutes(hhmm: string): number | undefined {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!m) return undefined;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
		return undefined;
	}
	return h * 60 + min;
}

/** True when `now` falls inside the quiet window (inclusive start, exclusive end for same-day ranges; overnight uses OR). */
export function isWithinQuietHours(
	quietHours: QuietHoursWindow | undefined,
	now: Date,
): boolean {
	const win = quietHours ?? DEFAULT_QUIET;
	const startMinutes = parseTimeToMinutes(win.start);
	const endMinutes = parseTimeToMinutes(win.end);
	if (startMinutes === undefined || endMinutes === undefined) {
		return false;
	}
	const currentMinutes = now.getHours() * 60 + now.getMinutes();

	if (startMinutes <= endMinutes) {
		return currentMinutes >= startMinutes && currentMinutes < endMinutes;
	}
	return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export type OpusGrindCycleMode = "lightweight" | "full";

export function resolveOpusGrindCycle(
	quietHours: QuietHoursWindow | undefined,
	now: Date,
): { quietHoursActive: boolean; cycleMode: OpusGrindCycleMode; window: QuietHoursWindow } {
	const window = quietHours ?? DEFAULT_QUIET;
	const quietHoursActive = isWithinQuietHours(quietHours, now);
	return {
		quietHoursActive,
		cycleMode: quietHoursActive ? "lightweight" : "full",
		window,
	};
}
