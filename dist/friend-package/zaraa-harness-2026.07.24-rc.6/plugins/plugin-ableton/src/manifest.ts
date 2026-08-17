import type { PluginManifest } from "@zaraa/shared";


/**
 * Tool name pattern for Ableton OSC route identifiers.
 * Every declared tool name doubles as the external routing address for that
 * OSC command; an empty or non-conforming name would silently break dispatch.
 */
const ABLETON_TOOL_NAME_RE = /^ableton_[a-z][a-z0-9_]*$/;

/**
 * Validates an Ableton plugin manifest at module load time.
 * Throws a descriptive TypeError if any tool entry:
 *   - has a missing or malformed name (must match ableton_[a-z][a-z0-9_]*)
 *   - has an empty description
 *   - has a parameters schema without type: "object"
 *
 * Exported so tests can exercise it with synthetic manifests.
 */
export function validateAbletonManifest(m: import("@zaraa/shared").PluginManifest): void {
	for (const tool of m.tools) {
		if (!tool.name || !ABLETON_TOOL_NAME_RE.test(tool.name)) {
			throw new TypeError(
				`Ableton manifest: tool ${JSON.stringify(tool.name)} has a missing or malformed OSC route name. ` +
				`Names must match ${ABLETON_TOOL_NAME_RE} (e.g. "ableton_ping").`
			);
		}
		if (!tool.description || !tool.description.trim()) {
			throw new TypeError(
				`Ableton manifest: tool "${tool.name}" is missing a description.`
			);
		}
		const params = tool.parameters as Record<string, unknown>;
		if (typeof params !== "object" || params === null || params["type"] !== "object") {
			throw new TypeError(
				`Ableton manifest: tool "${tool.name}" parameters must have type: "object". ` +
				`Got: ${JSON.stringify(params)}.`
			);
		}
	}
}

export const manifest: PluginManifest = {
	name: "ableton",
	version: "0.1.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["creative.daw", "ableton.osc"],
	trust: "core",
	tools: [
		{
			name: "ableton_ping",
			description: "Check AbletonOSC connectivity by sending /live/test and requiring an ok reply.",
			parameters: { type: "object", properties: {} },
		},
		{
			name: "ableton_get_session",
			description:
				"Read Ableton Live session status through AbletonOSC: version, tempo, time signature, track count, selected track.",
			parameters: { type: "object", properties: {} },
		},
		{
			name: "ableton_list_tracks",
			description: "Read Ableton Live track count, track names, and selected track.",
			parameters: { type: "object", properties: {} },
		},
		{
			name: "ableton_list_clip_slots",
			description: "Read bounded clip-slot occupancy and names for one Ableton track.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					startScene: { type: "number", description: "First clip slot index. Default 0." },
					sceneCount: {
						type: "number",
						description: "Number of clip slots to inspect. Default 8, max 64.",
					},
				},
				required: ["trackIndex"],
			},
		},
		{
			name: "ableton_list_scenes",
			description: "Read bounded scene names for the current song.",
			parameters: {
				type: "object",
				properties: {
					startScene: { type: "number", description: "First scene index. Default 0." },
					sceneCount: {
						type: "number",
						description: "Number of scenes to inspect. Default 8, max 64.",
					},
				},
			},
		},
		{
			name: "ableton_get_clip_notes",
			description: "Read MIDI notes from an Ableton clip, optionally over a pitch/time range.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					clipIndex: { type: "number", description: "Zero-based clip slot index." },
					startPitch: { type: "number", description: "Optional first MIDI pitch." },
					pitchSpan: { type: "number", description: "Optional pitch span." },
					startBeat: { type: "number", description: "Optional first beat." },
					timeSpan: { type: "number", description: "Optional beat span." },
				},
				required: ["trackIndex", "clipIndex"],
			},
		},
		{
			name: "ableton_get_selection",
			description:
				"Read current Live selection: selected track, selected scene, selected clip slot, and selected device.",
			parameters: { type: "object", properties: {} },
		},
		{
			name: "ableton_list_devices",
			description: "Read devices on one Ableton track: name, type, and class name.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
				},
				required: ["trackIndex"],
			},
		},
		{
			name: "ableton_get_device_parameters",
			description: "Read exposed parameter names, values, ranges, and quantization for one device.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					deviceIndex: { type: "number", description: "Zero-based device index." },
				},
				required: ["trackIndex", "deviceIndex"],
			},
		},
		{
			name: "ableton_set_tempo",
			description: "Set Ableton Live tempo in BPM and verify by reading /live/song/get/tempo.",
			parameters: {
				type: "object",
				properties: {
					bpm: { type: "number", description: "Tempo in BPM, 20-999." },
				},
				required: ["bpm"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_create_midi_track",
			description:
				"Create a MIDI track at an index (-1=end) and verify track count/name read-back.",
			parameters: {
				type: "object",
				properties: {
					index: { type: "number", description: "Track index, or -1/end by default." },
					name: { type: "string", description: "Optional track name to set and verify." },
				},
			},
			requiresApproval: true,
		},
		{
			name: "ableton_create_midi_clip",
			description:
				"Create a MIDI clip in a clip slot after checking occupancy; requires overwrite=true to replace.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					clipIndex: { type: "number", description: "Zero-based clip slot index." },
					lengthBeats: { type: "number", description: "Clip length in beats." },
					overwrite: {
						type: "boolean",
						description: "Delete existing slot clip before creation.",
					},
				},
				required: ["trackIndex", "clipIndex", "lengthBeats"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_add_notes",
			description:
				"Add MIDI notes to a clip and verify written notes by reading /live/clip/get/notes.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					clipIndex: { type: "number", description: "Zero-based clip slot index." },
					notes: {
						type: "array",
						items: {
							type: "object",
							properties: {
								pitch: { type: "number", description: "MIDI pitch 0-127." },
								startBeat: { type: "number", description: "Start in beats." },
								durationBeats: { type: "number", description: "Duration in beats." },
								velocity: { type: "number", description: "MIDI velocity 1-127." },
								muted: { type: "boolean", description: "Optional mute flag." },
							},
							required: ["pitch", "startBeat", "durationBeats", "velocity"],
						},
					},
				},
				required: ["trackIndex", "clipIndex", "notes"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_fire_clip",
			description: "Fire an Ableton clip slot and verify the track fired-slot index.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					clipIndex: { type: "number", description: "Zero-based clip slot index." },
				},
				required: ["trackIndex", "clipIndex"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_play_stop",
			description: "Start or stop Ableton playback and verify /live/song/get/is_playing.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["play", "stop"] },
				},
				required: ["action"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_set_track_pan",
			description: "Set a track panning value (-1=hard left, 0=center, 1=hard right) and verify via /live/track/get/panning.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					pan: { type: "number", description: "Pan value -1 (left) to 1 (right)." },
				},
				required: ["trackIndex", "pan"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_set_track_volume",
			description: "Set a track volume (0.0=silent to 1.0=max, ~0.85≈0 dB) and verify via /live/track/get/volume.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					volume: { type: "number", description: "Volume 0.0 (silent) to 1.0 (max); ~0.85 ≈ 0 dB." },
				},
				required: ["trackIndex", "volume"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_set_track_mute",
			description: "Mute or unmute a track and verify via /live/track/get/mute.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					mute: { type: "boolean", description: "true to mute, false to unmute." },
				},
				required: ["trackIndex", "mute"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_set_track_solo",
			description: "Solo or un-solo a track and verify via /live/track/get/solo.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					solo: { type: "boolean", description: "true to solo, false to un-solo." },
				},
				required: ["trackIndex", "solo"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_fire_scene",
			description: "Fire (launch) a scene by index via /live/scene/fire — triggers all clips in that scene row.",
			parameters: {
				type: "object",
				properties: {
					sceneIndex: { type: "number", description: "Zero-based scene index." },
				},
				required: ["sceneIndex"],
			},
			requiresApproval: true,
		},
		{
			name: "ableton_get_track_mixer",
			description: "Read a track's mixer state — volume, panning, mute, solo, and send levels — via /live/track/get/*.",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
				},
				required: ["trackIndex"],
			},
		},
		{
			name: "ableton_set_device_parameter",
			description: "Set a device parameter value via /live/device/set/parameter/value and read it back (Live clamps to the parameter's range, so reports requested vs actual).",
			parameters: {
				type: "object",
				properties: {
					trackIndex: { type: "number", description: "Zero-based track index." },
					deviceIndex: { type: "number", description: "Zero-based device index on the track." },
					parameterIndex: { type: "number", description: "Zero-based parameter index on the device." },
					value: { type: "number", description: "Target value; clamped to the parameter's min/max range." },
				},
				required: ["trackIndex", "deviceIndex", "parameterIndex", "value"],
			},
			requiresApproval: true,
		},
	],
};

// Guard at module load — throws immediately rather than failing silently at first call.
validateAbletonManifest(manifest);
