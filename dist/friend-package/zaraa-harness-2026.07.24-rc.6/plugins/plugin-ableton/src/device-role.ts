/**
 * device-role.ts — pure helper that maps an AbletonOSC device class_name
 * to a mixing role understood by the AI layer.
 *
 * Classification is done by first-match substring search on the lowercased
 * class_name, using a priority-ordered keyword table. Unknown class names
 * fall through to "other".
 *
 * Pure and dependency-free; safe to import anywhere.
 */

export type DeviceRole =
	| "eq"
	| "dynamics"
	| "saturation"
	| "reverb"
	| "delay"
	| "utility"
	| "other";

/**
 * Priority-ordered mapping: first matching keyword wins.
 * Keywords are matched as substrings of the lowercased class_name.
 *
 * Ordering matters where one class_name might contain multiple keywords
 * (e.g. "FilterDelay" → "delay" via the "delay" keyword, not "filter").
 * More-specific keywords must precede generic ones.
 */
const ROLE_KEYWORDS: ReadonlyArray<readonly [string, DeviceRole]> = [
	// ── EQ ──
	["eq", "eq"],
	["equalizer", "eq"],
	// ── Dynamics ──
	["compressor", "dynamics"],
	["limiter", "dynamics"],
	["multiband", "dynamics"],
	["gate", "dynamics"],
	// ── Saturation / Distortion ──
	["saturator", "saturation"],
	["overdrive", "saturation"],
	["erosion", "saturation"],
	["vinyl", "saturation"],
	["pedal", "saturation"],
	["redux", "saturation"],
	// ── Reverb / Spatial ──
	["reverb", "reverb"],
	["corpus", "reverb"],
	// ── Delay — specific multi-word forms before generic "delay" ──
	["pingpong", "delay"],
	["delay", "delay"],
	// ── Utility / Mix Tools ──
	["utility", "utility"],
	["autopan", "utility"],
	["stereogain", "utility"],
];

/**
 * Classify an AbletonOSC `class_name` into a mixing role.
 *
 * @param className  The raw class_name string returned by AbletonOSC,
 *                   e.g. "Eq8", "Compressor2", "SaturatorDevice".
 * @returns          The role, or "other" for unrecognized class names.
 */
export function classifyDevice(className: string): DeviceRole {
	const lower = className.toLowerCase();
	for (const [keyword, role] of ROLE_KEYWORDS) {
		if (lower.includes(keyword)) return role;
	}
	return "other";
}
