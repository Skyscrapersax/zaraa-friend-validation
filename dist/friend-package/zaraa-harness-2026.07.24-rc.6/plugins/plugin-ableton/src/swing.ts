/**
 * swing.ts — deterministic swing/groove offset for note start times.
 *
 * "Swing" pushes off-beat subdivision slots forward in time, creating the
 * characteristic uneven feel used in jazz, hip-hop, and electronic music.
 *
 * Grid model (default: 16th-note, 0.25 beats per slot):
 *   slot 0 → beat 0.00  (on-beat)
 *   slot 1 → beat 0.25  (off-beat) ← shifted by swing
 *   slot 2 → beat 0.50  (on-beat)
 *   slot 3 → beat 0.75  (off-beat) ← shifted by swing
 *   …
 *
 * Shift formula:
 *   shift = (swingPct / 100) × subdivision
 *
 * Examples with subdivision = 0.25:
 *   0%  swing → shift = 0.000 beats (no-op)
 *   50% swing → shift = 0.125 beats (classic triplet feel)
 *   100% swing → shift = 0.250 beats (off-beat lands on next on-beat)
 */

/** Default subdivision: 16th note in quarter-beat resolution. */
export const DEFAULT_SUBDIVISION = 0.25;

/**
 * Apply swing to a list of note start times expressed in beats.
 *
 * Off-beat detection uses rounded grid-step parity:
 *   gridStep = Math.round(t / subdivision)
 *   isOffBeat = gridStep % 2 !== 0
 *
 * Notes that do not lie exactly on the grid are rounded to the nearest
 * slot before the parity check, then shifted if off-beat.
 *
 * @param swingPct    Swing intensity [0–100]. Values are clamped to [0, 100].
 * @param starts      Note start times in beats (quarter-note resolution).
 * @param subdivision Grid step size in beats. Default: 0.25 (16th note).
 * @returns           New array; off-beat starts shifted forward, on-beats unchanged.
 */
export function applySwing(
	swingPct: number,
	starts: number[],
	subdivision: number = DEFAULT_SUBDIVISION,
): number[] {
	const pct = Math.max(0, Math.min(100, swingPct));
	const shift = (pct / 100) * subdivision;

	return starts.map((t) => {
		const gridStep = Math.round(t / subdivision);
		const isOffBeat = gridStep % 2 !== 0;
		return isOffBeat ? t + shift : t;
	});
}
