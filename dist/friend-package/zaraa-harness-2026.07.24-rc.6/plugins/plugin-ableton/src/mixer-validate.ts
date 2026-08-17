/**
 * Mixer-value validation for the Ableton plugin.
 *
 * Validates and clamps the three mixer parameter types used by AbletonOSC:
 *   - volume  [0, 1]   (0 = silence, 1 = unity gain)
 *   - pan     [-1, 1]  (-1 = hard left, 0 = centre, +1 = hard right)
 *   - send    [0, 1]   (same scale as volume)
 *
 * All functions throw a RangeError on NaN or out-of-range input so callers
 * get a clear signal without having to inspect clamped-but-wrong values.
 */

export type MixerParamType = "volume" | "pan" | "send";

interface MixerRange {
	min: number;
	max: number;
}

const RANGES: Record<MixerParamType, MixerRange> = {
	volume: { min: 0, max: 1 },
	pan:    { min: -1, max: 1 },
	send:   { min: 0, max: 1 },
};

/**
 * Validate a raw mixer value for the given parameter type.
 *
 * Returns the value unchanged when it is in range.
 * Throws {@link RangeError} when the value is NaN or outside [min, max].
 *
 * @param type   "volume" | "pan" | "send"
 * @param value  Raw number to validate
 */
export function validateMixerValue(type: MixerParamType, value: number): number {
	if (Number.isNaN(value)) {
		throw new RangeError(`${type}: NaN is not a valid mixer value`);
	}
	const { min, max } = RANGES[type];
	if (value < min || value > max) {
		throw new RangeError(
			`${type}: ${value} is out of range [${min}, ${max}]`,
		);
	}
	return value;
}

/**
 * Clamp a mixer value into the valid range for the given parameter type,
 * without throwing. NaN is always rejected (throws) — clamping NaN is
 * meaningless and would hide data-pipeline bugs.
 *
 * @param type   "volume" | "pan" | "send"
 * @param value  Raw number to clamp
 */
export function clampMixerValue(type: MixerParamType, value: number): number {
	if (Number.isNaN(value)) {
		throw new RangeError(`${type}: NaN cannot be clamped`);
	}
	const { min, max } = RANGES[type];
	return Math.min(max, Math.max(min, value));
}
