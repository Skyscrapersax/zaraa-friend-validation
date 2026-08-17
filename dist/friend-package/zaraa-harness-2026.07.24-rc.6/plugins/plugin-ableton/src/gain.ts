/**
 * gain.ts — pure dB ↔ linear gain conversion helpers for mixer level math.
 *
 * Conventions:
 *   0 dB  = unity gain (linear 1.0)
 *   -∞ dB = silence  (linear 0.0)
 *   +6 dB ≈ linear 2.0 (doubling of amplitude)
 *
 * These functions are side-effect-free and safe to call from any context.
 */

/** Smallest linear value treated as silence (avoids -Infinity dB). */
export const SILENCE_LINEAR = 1e-10;

/**
 * Convert a dB value to a linear amplitude multiplier.
 *
 * @param db - Level in decibels. -Infinity (or any value ≤ SILENCE_DB_THRESHOLD)
 *             returns 0 to avoid divide-by-zero in downstream math.
 * @returns Linear gain factor ≥ 0.
 */
export function dbToLinear(db: number): number {
	if (!Number.isFinite(db)) return db === -Infinity ? 0 : db; // NaN→NaN, +Infinity→Infinity
	return Math.pow(10, db / 20);
}

/**
 * Convert a linear amplitude multiplier to dB.
 *
 * @param linear - Amplitude value ≥ 0. Values ≤ 0 return -Infinity (silence).
 * @returns Level in decibels. Returns -Infinity for silence, NaN for negative input.
 */
export function linearToDb(linear: number): number {
	if (!Number.isFinite(linear) || linear < 0) return NaN;
	if (linear === 0) return -Infinity;
	return 20 * Math.log10(linear);
}
