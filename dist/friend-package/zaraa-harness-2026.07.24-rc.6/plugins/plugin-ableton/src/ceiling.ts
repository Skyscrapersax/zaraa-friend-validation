/**
 * True-peak / ceiling validator for the Ableton plugin.
 *
 * Given a measured true-peak (dBFS) and a ceiling (dBTP), returns whether the
 * master is within the ceiling and the gain trim required to bring it there.
 *
 * Convention:
 *   - Values are in dBFS / dBTP (0 = digital full-scale, negatives below FS).
 *   - trim > 0  means signal is under ceiling; can be raised.
 *   - trim < 0  means signal is over ceiling; must be lowered.
 *   - withinCeiling === true when measuredPeakDb <= ceilingDb.
 */

export interface CeilingValidationResult {
	/** True when the measured peak is at or below the ceiling. */
	withinCeiling: boolean;
	/** Gain trim in dB required to meet the ceiling (negative = must reduce). */
	requiredTrimDb: number;
	/** The measured peak that was supplied, in dBFS. */
	measuredPeakDb: number;
	/** The ceiling that was applied, in dBTP. */
	ceilingDb: number;
}

/**
 * Validate a measured true-peak against a ceiling.
 *
 * @param measuredPeakDb  Measured true-peak in dBFS (e.g. -0.3).
 * @param ceilingDb       Target ceiling in dBTP (e.g. -1.0). Defaults to -1.0 dBTP.
 * @returns               CeilingValidationResult with withinCeiling and requiredTrimDb.
 */
export function validateTruePeakCeiling(
	measuredPeakDb: number,
	ceilingDb: number = -1.0,
): CeilingValidationResult {
	const requiredTrimDb = ceilingDb - measuredPeakDb;
	const withinCeiling = measuredPeakDb <= ceilingDb;
	return { withinCeiling, requiredTrimDb, measuredPeakDb, ceilingDb };
}
