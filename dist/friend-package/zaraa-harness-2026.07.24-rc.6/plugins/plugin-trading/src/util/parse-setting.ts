/**
 * Parse a numeric risk/exchange setting, falling back to a safe default when the
 * stored value is missing, empty, non-numeric (NaN), negative, or non-finite.
 *
 * Why this matters: caps were read as `Number(store.getSetting(key) || "50")`.
 * A corrupted setting like "abc" is truthy, so `Number("abc")` yields NaN — and
 * `notionalUsd > NaN` is always false, silently disabling the cap and allowing
 * arbitrarily large trades. This guard returns the fallback instead.
 *
 * A stored 0 is preserved (a deliberate zero cap / block-all), matching the prior
 * `Number("0" || "50") === 0` behaviour; only missing/empty/invalid values fall back.
 */
export function parsePositiveSetting(raw: unknown, fallback: number): number {
	if (raw === null || raw === undefined || raw === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Strict variant: like {@link parsePositiveSetting} but throws `TypeError` when
 * the raw value is a non-numeric string (e.g. `"abc"`, `"12.3.4"`) instead of
 * silently falling back.  Use at validated config boundaries where a corrupted
 * setting must surface immediately rather than be masked by the safe default.
 *
 * @throws {TypeError} when `raw` is a string but does not represent a finite
 *   non-negative number.
 */
export function parsePositiveSettingStrict(raw: unknown, fallback: number): number {
	if (raw === null || raw === undefined || raw === "") return fallback;
	if (typeof raw === "string") {
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) {
			throw new TypeError(
				`parsePositiveSettingStrict: "${raw}" is not a valid non-negative number`,
			);
		}
		return n;
	}
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}
