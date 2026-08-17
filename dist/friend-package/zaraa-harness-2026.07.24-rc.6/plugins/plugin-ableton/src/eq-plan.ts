/**
 * EQ Eight band-plan serializer for Ableton Live (pure, side-effect-free).
 *
 * Converts a high-level band description into an ordered list of
 * device-parameter set operations for AbletonOSC.
 *
 * EQ Eight layout (0-based parameter indices):
 *   Param 0   : device-level (unused here)
 *   Per band, base = EQ_BAND_BASE + bandIndex * EQ_BAND_STRIDE:
 *     base+0 : Mode (filter-type integer code)
 *     base+1 : Frequency (Hz)
 *     base+2 : Gain (dB)
 *     base+3 : Resonance (Q)
 *     base+4 : internal (skipped)
 *     base+5 : Active (0=off; only emitted when false)
 */

import { z } from "zod";

export const EQ_BAND_COUNT = 8;
export const EQ_BAND_STRIDE = 6;
export const EQ_BAND_BASE = 1;

export const EQ_PARAM_OFFSET = {
	mode:      0,
	frequency: 1,
	gain:      2,
	resonance: 3,
	active:    5,
} as const;

export const EQ_FILTER_TYPES = [
	"lowcut",
	"lowshelf",
	"bell",
	"notch",
	"highshelf",
	"highcut",
] as const;

export type EqFilterType = (typeof EQ_FILTER_TYPES)[number];

export const EQ_FILTER_TYPE_CODE: Readonly<Record<EqFilterType, number>> = {
	lowcut:    0,
	lowshelf:  1,
	bell:      2,
	notch:     3,
	highshelf: 4,
	highcut:   5,
} as const;

export const eqBandSchema = z.object({
	bandIndex:  z.number().int().min(0).max(EQ_BAND_COUNT - 1),
	frequency:  z.number().min(10).max(22_000),
	gainDb:     z.number().min(-15).max(15),
	q:          z.number().min(0.1).max(18),
	filterType: z.enum(EQ_FILTER_TYPES),
	enabled:    z.boolean().optional(),
});

export type EqBand = z.infer<typeof eqBandSchema>;

export interface EqParamOp {
	parameterIndex: number;
	value: number;
	label: string;
}

export function eqParamIndex(
	bandIndex: number,
	param: keyof typeof EQ_PARAM_OFFSET,
): number {
	if (bandIndex < 0 || bandIndex >= EQ_BAND_COUNT) {
		throw new RangeError(
			'bandIndex must be 0-' + (EQ_BAND_COUNT - 1) + ', got ' + bandIndex,
		);
	}
	return EQ_BAND_BASE + bandIndex * EQ_BAND_STRIDE + EQ_PARAM_OFFSET[param];
}

export function serializeEqBand(raw: EqBand): EqParamOp[] {
	const band = eqBandSchema.parse(raw);
	const bi = band.bandIndex;
	const base = EQ_BAND_BASE + bi * EQ_BAND_STRIDE;
	const en = band.enabled !== false;

	const ops: EqParamOp[] = [
		{
			parameterIndex: base + EQ_PARAM_OFFSET.mode,
			value: EQ_FILTER_TYPE_CODE[band.filterType],
			label: 'band' + bi + '.mode=' + band.filterType,
		},
		{
			parameterIndex: base + EQ_PARAM_OFFSET.frequency,
			value: band.frequency,
			label: 'band' + bi + '.freq=' + band.frequency + 'Hz',
		},
		{
			parameterIndex: base + EQ_PARAM_OFFSET.gain,
			value: band.gainDb,
			label: 'band' + bi + '.gain=' + band.gainDb + 'dB',
		},
		{
			parameterIndex: base + EQ_PARAM_OFFSET.resonance,
			value: band.q,
			label: 'band' + bi + '.q=' + band.q,
		},
	];

	if (!en) {
		ops.push({
			parameterIndex: base + EQ_PARAM_OFFSET.active,
			value: 0,
			label: 'band' + bi + '.active=false',
		});
	}

	return ops.sort((a, b) => a.parameterIndex - b.parameterIndex);
}

export function serializeEqPlan(bands: EqBand[]): EqParamOp[] {
	return bands
		.flatMap(serializeEqBand)
		.sort((a, b) => a.parameterIndex - b.parameterIndex);
}
