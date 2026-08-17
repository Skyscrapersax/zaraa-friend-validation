/**
 * Loudness utilities for the Ableton plugin.
 *
 * Provides a Utility-gain trim calculator that converts a measured
 * integrated LUFS reading to the dB gain required to reach a target.
 * The result is clamped to ±GAIN_TRIM_MAX_DB so it stays within a
 * safe hardware/software headroom window.
 */

/** Maximum absolute gain trim, in dB. Mirrors a typical Ableton Utility range. */
export const GAIN_TRIM_MAX_DB = 12;

/**
 * Compute the gain trim (in dB) needed to bring a measured integrated-LUFS
 * reading to the target LUFS.
 *
 * Formula:  trim = target − measured
 * A signal that is *too loud* (measured > target) yields a negative trim.
 * A signal that is *too quiet* (measured < target) yields a positive trim.
 *
 * The result is clamped to [−GAIN_TRIM_MAX_DB, +GAIN_TRIM_MAX_DB].
 *
 * @param measuredLufs  Integrated LUFS from a loudness meter (e.g. −23.0).
 * @param targetLufs    Desired integrated LUFS (e.g. −14.0 for streaming).
 * @returns Gain trim in dB, clamped to ±GAIN_TRIM_MAX_DB.
 */
export function computeGainTrimDb(measuredLufs: number, targetLufs: number): number {
	const trim = targetLufs - measuredLufs;
	return Math.min(GAIN_TRIM_MAX_DB, Math.max(-GAIN_TRIM_MAX_DB, trim));
}
