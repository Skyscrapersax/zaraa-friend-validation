/**
 * Scales-and-modes lookup for the Ableton plugin.
 *
 * Exports interval patterns (semitones from root) for:
 *   - All seven diatonic modes (Ionian … Locrian)
 *   - Harmonic minor
 *   - Major and minor pentatonic
 *
 * Use generateScaleNotes(root, scaleName) to get concrete MIDI note numbers.
 * All functions are pure with no side effects.
 */

/** Semitone intervals from the root for every supported scale. */
export const SCALE_INTERVALS: Readonly<Record<string, readonly number[]>> = {
	// ── Seven diatonic modes ────────────────────────────────────────────
	/** W W H W W W H */
	ionian:      [0, 2, 4, 5, 7, 9, 11],
	/** W H W W W H W */
	dorian:      [0, 2, 3, 5, 7, 9, 10],
	/** H W W W H W W */
	phrygian:    [0, 1, 3, 5, 7, 8, 10],
	/** W W W H W W H */
	lydian:      [0, 2, 4, 6, 7, 9, 11],
	/** W W H W W H W */
	mixolydian:  [0, 2, 4, 5, 7, 9, 10],
	/** W H W W H W W (natural minor) */
	aeolian:     [0, 2, 3, 5, 7, 8, 10],
	/** H W W H W W W */
	locrian:     [0, 1, 3, 5, 6, 8, 10],

	// ── Additional scales ──────────────────────────────────────────────
	/** W H W W H Aug H (raised 7th) */
	"harmonic-minor":    [0, 2, 3, 5, 7, 8, 11],
	/** W W 1.5 W W 1.5 (5-note) */
	"pentatonic-major":  [0, 2, 4, 7, 9],
	/** 1.5 W W 1.5 W (5-note) */
	"pentatonic-minor":  [0, 3, 5, 7, 10],
} as const;

/** Union of every scale name recognised by this module. */
export type ScaleName = keyof typeof SCALE_INTERVALS;

/** All recognised scale names, sorted alphabetically. */
export const SCALE_NAMES: readonly ScaleName[] = Object.keys(SCALE_INTERVALS).sort() as ScaleName[];

/**
 * Generate concrete MIDI note numbers for one octave of a scale.
 *
 * @param root      MIDI note number of the root (0-127). Values outside [0, 127]
 *                  are accepted; caller is responsible for keeping output in range.
 * @param scaleName One of the keys in SCALE_INTERVALS.
 * @returns         Array of MIDI note numbers (root + each interval offset).
 * @throws          RangeError if scaleName is not recognised.
 */
export function generateScaleNotes(root: number, scaleName: ScaleName): number[] {
	const intervals = SCALE_INTERVALS[scaleName];
	if (!intervals) {
		throw new RangeError(
			`Unknown scale "${scaleName}". Valid names: ${SCALE_NAMES.join(", ")}.`,
		);
	}
	return intervals.map((interval) => root + interval);
}
