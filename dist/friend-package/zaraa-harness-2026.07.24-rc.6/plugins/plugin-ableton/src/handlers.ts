import { z } from "zod";
import type { AbletonOscTransport, OscValue } from "./transport.js";
import { AbletonOscUdpTransport } from "./transport.js";
import { classifyDevice } from "./device-role.js";

const tempoSchema = z.object({
	bpm: z.number().min(20).max(999),
});

const createTrackSchema = z.object({
	index: z.number().int().min(-1).optional(),
	name: z.string().trim().min(1).max(120).optional(),
});

const clipTargetSchema = z.object({
	trackIndex: z.number().int().min(0),
	clipIndex: z.number().int().min(0),
});

const trackTargetSchema = z.object({
	trackIndex: z.number().int().min(0),
});

const deviceTargetSchema = trackTargetSchema.extend({
	deviceIndex: z.number().int().min(0),
});

const listClipSlotsSchema = trackTargetSchema.extend({
	startScene: z.number().int().min(0).optional().default(0),
	sceneCount: z.number().int().min(1).max(64).optional().default(8),
});

const listScenesSchema = z.object({
	startScene: z.number().int().min(0).optional().default(0),
	sceneCount: z.number().int().min(1).max(64).optional().default(8),
});

const createClipSchema = clipTargetSchema.extend({
	lengthBeats: z.number().positive().max(1024),
	overwrite: z.boolean().optional(),
});

const getClipNotesSchema = clipTargetSchema.extend({
	startPitch: z.number().int().min(0).max(127).optional(),
	pitchSpan: z.number().int().min(1).max(128).optional(),
	startBeat: z.number().min(0).optional(),
	timeSpan: z.number().positive().optional(),
});

const noteSchema = z.object({
	pitch: z.number().int().min(0).max(127),
	startBeat: z.number().min(0),
	durationBeats: z.number().positive(),
	velocity: z.number().int().min(1).max(127),
	muted: z.boolean().optional(),
});

const addNotesSchema = clipTargetSchema.extend({
	notes: z.array(noteSchema).min(1).max(512),
});

const playStopSchema = z.object({
	action: z.enum(["play", "stop"]),
});
const setTrackPanSchema = trackTargetSchema.extend({
	pan: z.number().min(-1).max(1),
});

const setTrackVolumeSchema = trackTargetSchema.extend({
	volume: z.number().min(0).max(1),
});

const setTrackMuteSchema = trackTargetSchema.extend({
	mute: z.boolean(),
});

const setTrackSoloSchema = trackTargetSchema.extend({
	solo: z.boolean(),
});

const fireSceneSchema = z.object({
	sceneIndex: z.number().int().min(0),
});

const setDeviceParameterSchema = deviceTargetSchema.extend({
	parameterIndex: z.number().int().min(0),
	value: z.number(),
});

const deleteClipSchema = z.object({
	trackIndex: z.number().int().min(0),
	clipIndex: z.number().int().min(0),
	confirm: z.boolean(),
});

const trackMixerTargetSchema = trackTargetSchema; // trackIndex only

export interface AbletonHandlerDeps {
	transport?: AbletonOscTransport;
	timeoutMs?: number;
	host?: string;
	sendPort?: number;
	receivePort?: number;
}

export interface AbletonToolHandlers {
	ableton_ping(args: unknown): Promise<string>;
	ableton_get_session(args: unknown): Promise<string>;
	ableton_list_tracks(args: unknown): Promise<string>;
	ableton_list_clip_slots(args: unknown): Promise<string>;
	ableton_list_scenes(args: unknown): Promise<string>;
	ableton_get_clip_notes(args: unknown): Promise<string>;
	ableton_get_selection(args: unknown): Promise<string>;
	ableton_list_devices(args: unknown): Promise<string>;
	ableton_get_device_parameters(args: unknown): Promise<string>;
	ableton_set_tempo(args: unknown): Promise<string>;
	ableton_create_midi_track(args: unknown): Promise<string>;
	ableton_create_midi_clip(args: unknown): Promise<string>;
	ableton_add_notes(args: unknown): Promise<string>;
	ableton_fire_clip(args: unknown): Promise<string>;
	ableton_play_stop(args: unknown): Promise<string>;
	ableton_set_track_pan(args: unknown): Promise<string>;
	ableton_set_track_volume(args: unknown): Promise<string>;
	ableton_set_track_mute(args: unknown): Promise<string>;
	ableton_set_track_solo(args: unknown): Promise<string>;
	ableton_fire_scene(args: unknown): Promise<string>;
	ableton_set_device_parameter(args: unknown): Promise<string>;
	ableton_get_track_mixer(args: unknown): Promise<string>;
	// Index signature so this handler map is assignable to the
	// `Record<string, ToolHandler>` that ToolRegistry.registerPlugin expects
	// (mirrors how the video plugin types its handlers as a Record). Every named
	// member above already matches this shape, so it adds no looseness in practice.
	[tool: string]: (args: unknown) => Promise<string>;
}

function firstNumber(args: OscValue[], label: string): number {
	const value = args[0];
	if (typeof value !== "number") throw new Error(`AbletonOSC ${label} reply missing number`);
	return value;
}

function lastNumber(args: OscValue[], label: string): number {
	const value = args.at(-1);
	if (typeof value !== "number") throw new Error(`AbletonOSC ${label} reply missing number`);
	return value;
}

function asNumberOrNull(value: OscValue): number | null {
	if (typeof value !== "number") return null;
	return value;
}

function toBoolean(value: OscValue): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return /^(true|1|yes)$/i.test(value);
	return false;
}

function thirdBoolean(args: OscValue[], label: string): boolean {
	if (args.length < 3) throw new Error(`AbletonOSC ${label} reply missing boolean`);
	return toBoolean(args[2] ?? false);
}

function approxEqual(actual: number, expected: number, epsilon = 0.001): boolean {
	return Math.abs(actual - expected) <= epsilon;
}

function stripReplyPrefix(args: OscValue[], prefix: OscValue[]): OscValue[] {
	let offset = 0;
	for (const expected of prefix) {
		if (args[offset] !== expected) break;
		offset++;
	}
	return args.slice(offset);
}

function parseIndexedValues(
	args: OscValue[],
	prefix: OscValue[] = [],
): Map<number, OscValue> {
	const rest = stripReplyPrefix(args, prefix);
	const values = new Map<number, OscValue>();
	if (rest.length >= 2 && typeof rest[0] === "number") {
		for (let i = 0; i < rest.length - 1; i += 2) {
			const index = rest[i];
			if (typeof index === "number") values.set(index, rest[i + 1]);
		}
		return values;
	}
	rest.forEach((value, index) => {
		values.set(index, value);
	});
	return values;
}

function stringValue(values: Map<number, OscValue>, index: number): string {
	const value = values.get(index);
	return typeof value === "string" ? value : "";
}

function numberValue(values: Map<number, OscValue>, index: number): number | null {
	const value = values.get(index);
	return typeof value === "number" ? value : null;
}

function booleanValue(values: Map<number, OscValue>, index: number): boolean {
	return toBoolean(values.get(index) ?? false);
}

function parseNotes(args: OscValue[]) {
	const rest = args.slice(2);
	const notes = [];
	for (let i = 0; i < rest.length; i += 5) {
		const [pitch, startBeat, durationBeats, velocity, muted] = rest.slice(i, i + 5);
		if (
			typeof pitch !== "number" ||
			typeof startBeat !== "number" ||
			typeof durationBeats !== "number" ||
			typeof velocity !== "number"
		) {
			continue;
		}
		notes.push({
			pitch,
			startBeat,
			durationBeats,
			velocity,
			muted: toBoolean(muted ?? false),
		});
	}
	return notes;
}

function notesContainAll(
	readBack: ReturnType<typeof parseNotes>,
	expected: Array<z.infer<typeof noteSchema>>,
): boolean {
	return expected.every((note) =>
		readBack.some(
			(candidate) =>
				candidate.pitch === note.pitch &&
				approxEqual(candidate.startBeat, note.startBeat) &&
				approxEqual(candidate.durationBeats, note.durationBeats) &&
				candidate.velocity === note.velocity &&
				candidate.muted === (note.muted ?? false),
		),
	);
}

export function createAbletonHandlers(deps: AbletonHandlerDeps = {}): AbletonToolHandlers {
	const transport =
		deps.transport ??
		new AbletonOscUdpTransport({
			host: deps.host,
			sendPort: deps.sendPort,
			receivePort: deps.receivePort,
			timeoutMs: deps.timeoutMs,
		});

	return {
		async ableton_ping(_args) {
			const reply = await transport.request("/live/test");
			const ok = reply.args[0] === "ok";
			if (!ok) throw new Error(`AbletonOSC ping failed: ${String(reply.args[0] ?? "")}`);
			return JSON.stringify({ ok, reply: reply.args[0] });
		},

		async ableton_get_session(_args) {
			const [version, tempo, numerator, denominator, trackCount, selectedTrack] =
				await Promise.all([
					transport.request("/live/application/get/version"),
					transport.request("/live/song/get/tempo"),
					transport.request("/live/song/get/signature_numerator"),
					transport.request("/live/song/get/signature_denominator"),
					transport.request("/live/song/get/num_tracks"),
					transport.request("/live/view/get/selected_track"),
				]);
			return JSON.stringify({
				version: {
					major: firstNumber(version.args, "version major"),
					minor: Number(version.args[1] ?? 0),
				},
				tempo: firstNumber(tempo.args, "tempo"),
				timeSignature: {
					numerator: firstNumber(numerator.args, "signature numerator"),
					denominator: firstNumber(denominator.args, "signature denominator"),
				},
				trackCount: firstNumber(trackCount.args, "track count"),
				selectedTrack: firstNumber(selectedTrack.args, "selected track"),
			});
		},

		async ableton_list_tracks(_args) {
			const [trackCountReply, trackNamesReply, selectedTrackReply] = await Promise.all([
				transport.request("/live/song/get/num_tracks"),
				transport.request("/live/song/get/track_names"),
				transport.request("/live/view/get/selected_track"),
			]);
			const trackCount = firstNumber(trackCountReply.args, "track count");
			const trackNames = parseIndexedValues(trackNamesReply.args);
			return JSON.stringify({
				trackCount,
				selectedTrack: firstNumber(selectedTrackReply.args, "selected track"),
				tracks: Array.from({ length: trackCount }, (_, index) => ({
					index,
					name: stringValue(trackNames, index),
				})),
			});
		},

		async ableton_list_clip_slots(args) {
			const params = listClipSlotsSchema.parse(args ?? {});
			const namesReply = await transport.request("/live/track/get/clips/name", [
				params.trackIndex,
			]);
			const clipNames = parseIndexedValues(namesReply.args, [params.trackIndex]);
			const slots = [];
			for (
				let clipIndex = params.startScene;
				clipIndex < params.startScene + params.sceneCount;
				clipIndex++
			) {
				const hasClip = thirdBoolean(
					(
						await transport.request("/live/clip_slot/get/has_clip", [
							params.trackIndex,
							clipIndex,
						])
					).args,
					"clip slot",
				);
				slots.push({
					clipIndex,
					hasClip,
					name: stringValue(clipNames, clipIndex),
				});
			}
			return JSON.stringify({
				trackIndex: params.trackIndex,
				startScene: params.startScene,
				sceneCount: params.sceneCount,
				slots,
			});
		},

		async ableton_list_scenes(args) {
			const params = listScenesSchema.parse(args ?? {});
			const [sceneCountReply, sceneNamesReply] = await Promise.all([
				transport.request("/live/song/get/num_scenes"),
				transport.request("/live/song/get/scenes/name"),
			]);
			const sceneCount = firstNumber(sceneCountReply.args, "scene count");
			const availableCount = Math.max(0, sceneCount - params.startScene);
			const requestedCount = Math.min(params.sceneCount, availableCount);
			const names = parseIndexedValues(sceneNamesReply.args);
			const scenes = Array.from({ length: requestedCount }, (_, index) => {
				const sceneIndex = params.startScene + index;
				return {
					sceneIndex,
					name: stringValue(names, sceneIndex),
				};
			});
			return JSON.stringify({
				sceneCount,
				startScene: params.startScene,
				requestedCount: requestedCount,
				scenes,
			});
		},

		async ableton_get_clip_notes(args) {
			const params = getClipNotesSchema.parse(args ?? {});
			const rangeArgs = [
				params.startPitch,
				params.pitchSpan,
				params.startBeat,
				params.timeSpan,
			];
			const hasRange = rangeArgs.every((value) => value !== undefined);
			const requestArgs = hasRange
				? [
						params.trackIndex,
						params.clipIndex,
						params.startPitch!,
						params.pitchSpan!,
						params.startBeat!,
						params.timeSpan!,
					]
				: [params.trackIndex, params.clipIndex];
			const reply = await transport.request("/live/clip/get/notes", requestArgs);
			return JSON.stringify({
				trackIndex: params.trackIndex,
				clipIndex: params.clipIndex,
				notes: parseNotes(reply.args),
			});
		},

		async ableton_get_selection(_args) {
			const [
				selectedTrackReply,
				selectedSceneReply,
				selectedClipReply,
				selectedDeviceReply,
				trackNamesReply,
				sceneNamesReply,
			] = await Promise.all([
				transport.request("/live/view/get/selected_track"),
				transport.request("/live/view/get/selected_scene"),
				transport.request("/live/view/get/selected_clip"),
				transport.request("/live/view/get/selected_device"),
				transport.request("/live/song/get/track_names"),
				transport.request("/live/song/get/scenes/name"),
			]);
			const selectedTrack = firstNumber(selectedTrackReply.args, "selected track");
			const selectedScene = firstNumber(selectedSceneReply.args, "selected scene");
			const trackNames = parseIndexedValues(trackNamesReply.args);
			const sceneNames = parseIndexedValues(sceneNamesReply.args);
			return JSON.stringify({
				selectedTrack: {
					index: selectedTrack,
					name: stringValue(trackNames, selectedTrack),
				},
				selectedScene: {
					index: selectedScene,
					name: stringValue(sceneNames, selectedScene),
				},
				selectedClip: {
					trackIndex: asNumberOrNull(selectedClipReply.args[0]),
					sceneIndex: asNumberOrNull(selectedClipReply.args[1]),
				},
				selectedDevice: {
					trackIndex: asNumberOrNull(selectedDeviceReply.args[0]),
					deviceIndex: asNumberOrNull(selectedDeviceReply.args[1]),
				},
			});
		},

		async ableton_list_devices(args) {
			const params = trackTargetSchema.parse(args ?? {});
			const [countReply, namesReply, typesReply, classNamesReply] = await Promise.all([
				transport.request("/live/track/get/num_devices", [params.trackIndex]),
				transport.request("/live/track/get/devices/name", [params.trackIndex]),
				transport.request("/live/track/get/devices/type", [params.trackIndex]),
				transport.request("/live/track/get/devices/class_name", [params.trackIndex]),
			]);
			const deviceCount = lastNumber(countReply.args, "device count");
			const names = parseIndexedValues(namesReply.args, [params.trackIndex]);
			const types = parseIndexedValues(typesReply.args, [params.trackIndex]);
			const classNames = parseIndexedValues(classNamesReply.args, [params.trackIndex]);
			return JSON.stringify({
				trackIndex: params.trackIndex,
				deviceCount,
				devices: Array.from({ length: deviceCount }, (_, deviceIndex) => {
					const className = stringValue(classNames, deviceIndex);
					return {
						deviceIndex,
						name: stringValue(names, deviceIndex),
						type: numberValue(types, deviceIndex),
						className,
						role: classifyDevice(className),
					};
				}),
			});
		},

		async ableton_get_device_parameters(args) {
			const params = deviceTargetSchema.parse(args ?? {});
			const prefix = [params.trackIndex, params.deviceIndex];
			const [countReply, namesReply, valuesReply, minsReply, maxesReply, quantizedReply] =
				await Promise.all([
					transport.request("/live/device/get/num_parameters", prefix),
					transport.request("/live/device/get/parameters/name", prefix),
					transport.request("/live/device/get/parameters/value", prefix),
					transport.request("/live/device/get/parameters/min", prefix),
					transport.request("/live/device/get/parameters/max", prefix),
					transport.request("/live/device/get/parameters/is_quantized", prefix),
				]);
			const parameterCount = lastNumber(countReply.args, "parameter count");
			const names = parseIndexedValues(namesReply.args, prefix);
			const values = parseIndexedValues(valuesReply.args, prefix);
			const mins = parseIndexedValues(minsReply.args, prefix);
			const maxes = parseIndexedValues(maxesReply.args, prefix);
			const quantized = parseIndexedValues(quantizedReply.args, prefix);
			return JSON.stringify({
				trackIndex: params.trackIndex,
				deviceIndex: params.deviceIndex,
				parameterCount,
				parameters: Array.from({ length: parameterCount }, (_, parameterIndex) => ({
					parameterIndex,
					name: stringValue(names, parameterIndex),
					value: numberValue(values, parameterIndex),
					min: numberValue(mins, parameterIndex),
					max: numberValue(maxes, parameterIndex),
					isQuantized: booleanValue(quantized, parameterIndex),
				})),
			});
		},

		async ableton_set_tempo(args) {
			const params = tempoSchema.parse(args ?? {});
			await transport.send("/live/song/set/tempo", [params.bpm]);
			const reply = await transport.request("/live/song/get/tempo");
			const actual = firstNumber(reply.args, "tempo");
			if (!approxEqual(actual, params.bpm)) {
				throw new Error(`Tempo read-back mismatch: expected ${params.bpm}, got ${actual}`);
			}
			return JSON.stringify({ bpm: actual, verified: true });
		},

		async ableton_create_midi_track(args) {
			const params = createTrackSchema.parse(args ?? {});
			const before = firstNumber(
				(await transport.request("/live/song/get/num_tracks")).args,
				"track count",
			);
			const requestedIndex = params.index ?? -1;
			await transport.send("/live/song/create_midi_track", [requestedIndex]);
			const after = firstNumber(
				(await transport.request("/live/song/get/num_tracks")).args,
				"track count",
			);
			if (after !== before + 1) {
				throw new Error(`MIDI track read-back mismatch: expected ${before + 1}, got ${after}`);
			}
			const trackIndex = requestedIndex === -1 ? before : requestedIndex;
			if (params.name) {
				await transport.send("/live/track/set/name", [trackIndex, params.name]);
				const nameReply = await transport.request("/live/track/get/name", [trackIndex]);
				const actualName = String(nameReply.args[1] ?? "");
				if (actualName !== params.name) {
					throw new Error(
						`Track name read-back mismatch: expected ${params.name}, got ${actualName}`,
					);
				}
			}
			return JSON.stringify({ trackIndex, trackCount: after, name: params.name, verified: true });
		},

		async ableton_create_midi_clip(args) {
			const params = createClipSchema.parse(args ?? {});
			const target = [params.trackIndex, params.clipIndex] satisfies OscValue[];
			const before = thirdBoolean(
				(await transport.request("/live/clip_slot/get/has_clip", target)).args,
				"clip slot",
			);
			if (before && !params.overwrite) {
				throw new Error("Clip slot already occupied; pass overwrite=true to replace it");
			}
			if (before && params.overwrite) {
				await transport.send("/live/clip_slot/delete_clip", target);
			}
			await transport.send("/live/clip_slot/create_clip", [...target, params.lengthBeats]);
			const hasClip = thirdBoolean(
				(await transport.request("/live/clip_slot/get/has_clip", target)).args,
				"clip slot",
			);
			if (!hasClip) {
				throw new Error("Clip create read-back mismatch: slot is still empty");
			}
			return JSON.stringify({
				trackIndex: params.trackIndex,
				clipIndex: params.clipIndex,
				hasClip,
				verified: true,
			});
		},

		async ableton_add_notes(args) {
			const params = addNotesSchema.parse(args ?? {});
			const noteArgs = params.notes.flatMap((note) => [
				note.pitch,
				note.startBeat,
				note.durationBeats,
				note.velocity,
				note.muted ?? false,
			]);
			await transport.send("/live/clip/add/notes", [
				params.trackIndex,
				params.clipIndex,
				...noteArgs,
			]);
			const reply = await transport.request("/live/clip/get/notes", [
				params.trackIndex,
				params.clipIndex,
			]);
			const readBack = parseNotes(reply.args);
			if (!notesContainAll(readBack, params.notes)) {
				throw new Error("MIDI note read-back mismatch");
			}
			return JSON.stringify({
				trackIndex: params.trackIndex,
				clipIndex: params.clipIndex,
				noteCount: params.notes.length,
				verified: true,
			});
		},

		async ableton_fire_clip(args) {
			const params = clipTargetSchema.parse(args ?? {});
			await transport.send("/live/clip_slot/fire", [params.trackIndex, params.clipIndex]);
			const reply = await transport.request("/live/track/get/fired_slot_index", [
				params.trackIndex,
			]);
			const firedSlot = Number(reply.args[1] ?? -1);
			if (firedSlot !== params.clipIndex) {
				throw new Error(
					`Clip fire read-back mismatch: expected slot ${params.clipIndex}, got ${firedSlot}`,
				);
			}
			return JSON.stringify({ ...params, firedSlot, verified: true });
		},

		async ableton_play_stop(args) {
			const params = playStopSchema.parse(args ?? {});
			const shouldPlay = params.action === "play";
			await transport.send(shouldPlay ? "/live/song/start_playing" : "/live/song/stop_playing");
			const isPlaying = toBoolean(
				(await transport.request("/live/song/get/is_playing")).args[0] ?? false,
			);
			if (isPlaying !== shouldPlay) {
				throw new Error(
					`Transport read-back mismatch: expected is_playing=${shouldPlay}, got ${isPlaying}`,
				);
			}
			return JSON.stringify({ isPlaying, verified: true });
		},
		async ableton_set_track_pan(args) {
			const params = setTrackPanSchema.parse(args ?? {});
			await transport.send("/live/track/set/panning", [params.trackIndex, params.pan]);
			const reply = await transport.request("/live/track/get/panning", [params.trackIndex]);
			const actual = firstNumber(reply.args, "panning");
			if (!approxEqual(actual, params.pan)) {
				throw new Error(
					`Pan read-back mismatch: set ${params.pan}, got ${actual}`,
				);
			}
			return JSON.stringify({ trackIndex: params.trackIndex, pan: actual, verified: true });
		},
		async ableton_get_track_mixer(args) {
			const params = trackMixerTargetSchema.parse(args ?? {});
			const ti = params.trackIndex;
			const [volReply, panReply, muteReply, soloReply] = await Promise.all([
				transport.request("/live/track/get/volume", [ti]),
				transport.request("/live/track/get/panning", [ti]),
				transport.request("/live/track/get/mute", [ti]),
				transport.request("/live/track/get/solo", [ti]),
			]);
			// Sends: attempt indices 0-7; any that fail (track has fewer sends) are silently dropped.
			const sendResults = await Promise.allSettled(
				Array.from({ length: 8 }, (_, i) =>
					transport.request("/live/track/get/send", [ti, i]),
				),
			);
			const sendLevels = sendResults
				.map((r) => (r.status === "fulfilled" ? firstNumber(r.value.args, "send") : null))
				.filter((v): v is number => v !== null);
			return JSON.stringify({
				trackIndex: ti,
				volume: firstNumber(volReply.args, "volume"),
				panning: firstNumber(panReply.args, "panning"),
				mute: toBoolean(muteReply.args[0] ?? false),
				solo: toBoolean(soloReply.args[0] ?? false),
				sendLevels,
			});
		},
		async ableton_set_track_volume(args) {
			const params = setTrackVolumeSchema.parse(args ?? {});
			await transport.send("/live/track/set/volume", [params.trackIndex, params.volume]);
			const reply = await transport.request("/live/track/get/volume", [params.trackIndex]);
			const actual = firstNumber(reply.args, "volume");
			if (!approxEqual(actual, params.volume)) {
				throw new Error(`Volume read-back mismatch: set ${params.volume}, got ${actual}`);
			}
			return JSON.stringify({ trackIndex: params.trackIndex, volume: actual, verified: true });
		},
		async ableton_set_track_mute(args) {
			const params = setTrackMuteSchema.parse(args ?? {});
			await transport.send("/live/track/set/mute", [params.trackIndex, params.mute ? 1 : 0]);
			const reply = await transport.request("/live/track/get/mute", [params.trackIndex]);
			const actual = toBoolean(reply.args[0] ?? false);
			if (actual !== params.mute) {
				throw new Error(`Mute read-back mismatch: set ${params.mute}, got ${actual}`);
			}
			return JSON.stringify({ trackIndex: params.trackIndex, mute: actual, verified: true });
		},
		async ableton_set_track_solo(args) {
			const params = setTrackSoloSchema.parse(args ?? {});
			await transport.send("/live/track/set/solo", [params.trackIndex, params.solo ? 1 : 0]);
			const reply = await transport.request("/live/track/get/solo", [params.trackIndex]);
			const actual = toBoolean(reply.args[0] ?? false);
			if (actual !== params.solo) {
				throw new Error(`Solo read-back mismatch: set ${params.solo}, got ${actual}`);
			}
			return JSON.stringify({ trackIndex: params.trackIndex, solo: actual, verified: true });
		},
		async ableton_fire_scene(args) {
			const params = fireSceneSchema.parse(args ?? {});
			// AbletonOSC has no clean "which scene is currently playing" read-back, so
			// (unlike fire_clip, which reads /live/track/get/fired_slot_index) this fires
			// without a strict read-back assertion and returns the launched scene index.
			await transport.send("/live/scene/fire", [params.sceneIndex]);
			return JSON.stringify({ sceneIndex: params.sceneIndex, fired: true });
		},
		async ableton_set_device_parameter(args) {
			const params = setDeviceParameterSchema.parse(args ?? {});
			await transport.send("/live/device/set/parameter/value", [
				params.trackIndex,
				params.deviceIndex,
				params.parameterIndex,
				params.value,
			]);
			const reply = await transport.request("/live/device/get/parameter/value", [
				params.trackIndex,
				params.deviceIndex,
				params.parameterIndex,
			]);
			const actual = firstNumber(reply.args, "device parameter value");
			// Device parameters have per-parameter min/max ranges; if the target value is
			// outside the parameter's range Live clamps it, so the read-back can differ.
			// Report both rather than throwing on a clamp.
			return JSON.stringify({
				trackIndex: params.trackIndex,
				deviceIndex: params.deviceIndex,
				parameterIndex: params.parameterIndex,
				requested: params.value,
				actual,
				verified: approxEqual(actual, params.value),
			});
		},
	};
}
