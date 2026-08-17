// src/handlers.ts
import { z } from "zod";

// src/transport.ts
function resolveOscRoot(moduleValue) {
  const maybe = moduleValue;
  const root = typeof maybe.UDPPort === "function" ? maybe : maybe.default;
  if (!root || typeof root !== "object" || typeof root.UDPPort !== "function") {
    throw new Error("osc UDPPort export not found");
  }
  return root;
}
function normalizeArg(arg) {
  if (arg === null) return null;
  if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
    return arg;
  }
  if (typeof arg === "object" && arg && "value" in arg) {
    return normalizeArg(arg.value);
  }
  return String(arg);
}
function normalizePacket(packet) {
  if (!packet || typeof packet !== "object") return null;
  const maybe = packet;
  if (typeof maybe.address !== "string" || !maybe.address.startsWith("/")) return null;
  const args = Array.isArray(maybe.args) ? maybe.args.map(normalizeArg) : [];
  return { address: maybe.address, args };
}
var AbletonOscUdpTransport = class {
  host;
  sendPort;
  receivePort;
  timeoutMs;
  port = null;
  openPromise = null;
  pending = [];
  constructor(options = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.sendPort = options.sendPort ?? 11e3;
    this.receivePort = options.receivePort ?? 11001;
    this.timeoutMs = options.timeoutMs ?? 1500;
  }
  async send(address, args = []) {
    const port = await this.open();
    port.send({ address, args }, this.host, this.sendPort);
  }
  async request(address, args = [], timeoutMs = this.timeoutMs) {
    const port = await this.open();
    return new Promise((resolve, reject) => {
      const pending = {
        address,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter((item) => item !== pending);
          reject(new Error(`AbletonOSC request timed out: ${address}`));
        }, timeoutMs)
      };
      this.pending.push(pending);
      port.send({ address, args }, this.host, this.sendPort);
    });
  }
  async close() {
    if (!this.port) return;
    this.port.close();
    this.port = null;
    this.openPromise = null;
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error("AbletonOSC transport closed"));
    }
  }
  async open() {
    if (this.port) return this.port;
    if (this.openPromise) return this.openPromise;
    this.openPromise = import("osc").then(
      (oscModule) => new Promise((resolve, reject) => {
        const osc = resolveOscRoot(oscModule);
        const port = new osc.UDPPort({
          localAddress: "127.0.0.1",
          localPort: this.receivePort,
          remoteAddress: this.host,
          remotePort: this.sendPort,
          metadata: false
        });
        port.on("ready", () => {
          this.port = port;
          resolve(port);
        });
        port.on("error", (err) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        port.on("message", (packet) => this.handleMessage(packet));
        port.open();
      })
    );
    return this.openPromise;
  }
  handleMessage(packet) {
    const reply = normalizePacket(packet);
    if (!reply) return;
    if (reply.address === "/live/error") {
      const pending2 = this.pending.shift();
      if (!pending2) return;
      clearTimeout(pending2.timer);
      pending2.reject(new Error(`AbletonOSC error: ${reply.args.join(" ")}`));
      return;
    }
    const index = this.pending.findIndex((pending2) => pending2.address === reply.address);
    if (index === -1) return;
    const [pending] = this.pending.splice(index, 1);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }
};

// src/device-role.ts
var ROLE_KEYWORDS = [
  // ── EQ ──
  ["eq", "eq"],
  ["equalizer", "eq"],
  // ── Dynamics ──
  ["compressor", "dynamics"],
  ["limiter", "dynamics"],
  ["multiband", "dynamics"],
  ["gate", "dynamics"],
  // ── Saturation / Distortion ──
  ["saturator", "saturation"],
  ["overdrive", "saturation"],
  ["erosion", "saturation"],
  ["vinyl", "saturation"],
  ["pedal", "saturation"],
  ["redux", "saturation"],
  // ── Reverb / Spatial ──
  ["reverb", "reverb"],
  ["corpus", "reverb"],
  // ── Delay — specific multi-word forms before generic "delay" ──
  ["pingpong", "delay"],
  ["delay", "delay"],
  // ── Utility / Mix Tools ──
  ["utility", "utility"],
  ["autopan", "utility"],
  ["stereogain", "utility"]
];
function classifyDevice(className) {
  const lower = className.toLowerCase();
  for (const [keyword, role] of ROLE_KEYWORDS) {
    if (lower.includes(keyword)) return role;
  }
  return "other";
}

// src/handlers.ts
var tempoSchema = z.object({
  bpm: z.number().min(20).max(999)
});
var createTrackSchema = z.object({
  index: z.number().int().min(-1).optional(),
  name: z.string().trim().min(1).max(120).optional()
});
var clipTargetSchema = z.object({
  trackIndex: z.number().int().min(0),
  clipIndex: z.number().int().min(0)
});
var trackTargetSchema = z.object({
  trackIndex: z.number().int().min(0)
});
var deviceTargetSchema = trackTargetSchema.extend({
  deviceIndex: z.number().int().min(0)
});
var listClipSlotsSchema = trackTargetSchema.extend({
  startScene: z.number().int().min(0).optional().default(0),
  sceneCount: z.number().int().min(1).max(64).optional().default(8)
});
var listScenesSchema = z.object({
  startScene: z.number().int().min(0).optional().default(0),
  sceneCount: z.number().int().min(1).max(64).optional().default(8)
});
var createClipSchema = clipTargetSchema.extend({
  lengthBeats: z.number().positive().max(1024),
  overwrite: z.boolean().optional()
});
var getClipNotesSchema = clipTargetSchema.extend({
  startPitch: z.number().int().min(0).max(127).optional(),
  pitchSpan: z.number().int().min(1).max(128).optional(),
  startBeat: z.number().min(0).optional(),
  timeSpan: z.number().positive().optional()
});
var noteSchema = z.object({
  pitch: z.number().int().min(0).max(127),
  startBeat: z.number().min(0),
  durationBeats: z.number().positive(),
  velocity: z.number().int().min(1).max(127),
  muted: z.boolean().optional()
});
var addNotesSchema = clipTargetSchema.extend({
  notes: z.array(noteSchema).min(1).max(512)
});
var playStopSchema = z.object({
  action: z.enum(["play", "stop"])
});
var setTrackPanSchema = trackTargetSchema.extend({
  pan: z.number().min(-1).max(1)
});
var setTrackVolumeSchema = trackTargetSchema.extend({
  volume: z.number().min(0).max(1)
});
var setTrackMuteSchema = trackTargetSchema.extend({
  mute: z.boolean()
});
var setTrackSoloSchema = trackTargetSchema.extend({
  solo: z.boolean()
});
var fireSceneSchema = z.object({
  sceneIndex: z.number().int().min(0)
});
var setDeviceParameterSchema = deviceTargetSchema.extend({
  parameterIndex: z.number().int().min(0),
  value: z.number()
});
var deleteClipSchema = z.object({
  trackIndex: z.number().int().min(0),
  clipIndex: z.number().int().min(0),
  confirm: z.boolean()
});
var trackMixerTargetSchema = trackTargetSchema;
function firstNumber(args, label) {
  const value = args[0];
  if (typeof value !== "number") throw new Error(`AbletonOSC ${label} reply missing number`);
  return value;
}
function lastNumber(args, label) {
  const value = args.at(-1);
  if (typeof value !== "number") throw new Error(`AbletonOSC ${label} reply missing number`);
  return value;
}
function asNumberOrNull(value) {
  if (typeof value !== "number") return null;
  return value;
}
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|1|yes)$/i.test(value);
  return false;
}
function thirdBoolean(args, label) {
  if (args.length < 3) throw new Error(`AbletonOSC ${label} reply missing boolean`);
  return toBoolean(args[2] ?? false);
}
function approxEqual(actual, expected, epsilon = 1e-3) {
  return Math.abs(actual - expected) <= epsilon;
}
function stripReplyPrefix(args, prefix) {
  let offset = 0;
  for (const expected of prefix) {
    if (args[offset] !== expected) break;
    offset++;
  }
  return args.slice(offset);
}
function parseIndexedValues(args, prefix = []) {
  const rest = stripReplyPrefix(args, prefix);
  const values = /* @__PURE__ */ new Map();
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
function stringValue(values, index) {
  const value = values.get(index);
  return typeof value === "string" ? value : "";
}
function numberValue(values, index) {
  const value = values.get(index);
  return typeof value === "number" ? value : null;
}
function booleanValue(values, index) {
  return toBoolean(values.get(index) ?? false);
}
function parseNotes(args) {
  const rest = args.slice(2);
  const notes = [];
  for (let i = 0; i < rest.length; i += 5) {
    const [pitch, startBeat, durationBeats, velocity, muted] = rest.slice(i, i + 5);
    if (typeof pitch !== "number" || typeof startBeat !== "number" || typeof durationBeats !== "number" || typeof velocity !== "number") {
      continue;
    }
    notes.push({
      pitch,
      startBeat,
      durationBeats,
      velocity,
      muted: toBoolean(muted ?? false)
    });
  }
  return notes;
}
function notesContainAll(readBack, expected) {
  return expected.every(
    (note) => readBack.some(
      (candidate) => candidate.pitch === note.pitch && approxEqual(candidate.startBeat, note.startBeat) && approxEqual(candidate.durationBeats, note.durationBeats) && candidate.velocity === note.velocity && candidate.muted === (note.muted ?? false)
    )
  );
}
function createAbletonHandlers(deps = {}) {
  const transport = deps.transport ?? new AbletonOscUdpTransport({
    host: deps.host,
    sendPort: deps.sendPort,
    receivePort: deps.receivePort,
    timeoutMs: deps.timeoutMs
  });
  return {
    async ableton_ping(_args) {
      const reply = await transport.request("/live/test");
      const ok = reply.args[0] === "ok";
      if (!ok) throw new Error(`AbletonOSC ping failed: ${String(reply.args[0] ?? "")}`);
      return JSON.stringify({ ok, reply: reply.args[0] });
    },
    async ableton_get_session(_args) {
      const [version, tempo, numerator, denominator, trackCount, selectedTrack] = await Promise.all([
        transport.request("/live/application/get/version"),
        transport.request("/live/song/get/tempo"),
        transport.request("/live/song/get/signature_numerator"),
        transport.request("/live/song/get/signature_denominator"),
        transport.request("/live/song/get/num_tracks"),
        transport.request("/live/view/get/selected_track")
      ]);
      return JSON.stringify({
        version: {
          major: firstNumber(version.args, "version major"),
          minor: Number(version.args[1] ?? 0)
        },
        tempo: firstNumber(tempo.args, "tempo"),
        timeSignature: {
          numerator: firstNumber(numerator.args, "signature numerator"),
          denominator: firstNumber(denominator.args, "signature denominator")
        },
        trackCount: firstNumber(trackCount.args, "track count"),
        selectedTrack: firstNumber(selectedTrack.args, "selected track")
      });
    },
    async ableton_list_tracks(_args) {
      const [trackCountReply, trackNamesReply, selectedTrackReply] = await Promise.all([
        transport.request("/live/song/get/num_tracks"),
        transport.request("/live/song/get/track_names"),
        transport.request("/live/view/get/selected_track")
      ]);
      const trackCount = firstNumber(trackCountReply.args, "track count");
      const trackNames = parseIndexedValues(trackNamesReply.args);
      return JSON.stringify({
        trackCount,
        selectedTrack: firstNumber(selectedTrackReply.args, "selected track"),
        tracks: Array.from({ length: trackCount }, (_, index) => ({
          index,
          name: stringValue(trackNames, index)
        }))
      });
    },
    async ableton_list_clip_slots(args) {
      const params = listClipSlotsSchema.parse(args ?? {});
      const namesReply = await transport.request("/live/track/get/clips/name", [
        params.trackIndex
      ]);
      const clipNames = parseIndexedValues(namesReply.args, [params.trackIndex]);
      const slots = [];
      for (let clipIndex = params.startScene; clipIndex < params.startScene + params.sceneCount; clipIndex++) {
        const hasClip = thirdBoolean(
          (await transport.request("/live/clip_slot/get/has_clip", [
            params.trackIndex,
            clipIndex
          ])).args,
          "clip slot"
        );
        slots.push({
          clipIndex,
          hasClip,
          name: stringValue(clipNames, clipIndex)
        });
      }
      return JSON.stringify({
        trackIndex: params.trackIndex,
        startScene: params.startScene,
        sceneCount: params.sceneCount,
        slots
      });
    },
    async ableton_list_scenes(args) {
      const params = listScenesSchema.parse(args ?? {});
      const [sceneCountReply, sceneNamesReply] = await Promise.all([
        transport.request("/live/song/get/num_scenes"),
        transport.request("/live/song/get/scenes/name")
      ]);
      const sceneCount = firstNumber(sceneCountReply.args, "scene count");
      const availableCount = Math.max(0, sceneCount - params.startScene);
      const requestedCount = Math.min(params.sceneCount, availableCount);
      const names = parseIndexedValues(sceneNamesReply.args);
      const scenes = Array.from({ length: requestedCount }, (_, index) => {
        const sceneIndex = params.startScene + index;
        return {
          sceneIndex,
          name: stringValue(names, sceneIndex)
        };
      });
      return JSON.stringify({
        sceneCount,
        startScene: params.startScene,
        requestedCount,
        scenes
      });
    },
    async ableton_get_clip_notes(args) {
      const params = getClipNotesSchema.parse(args ?? {});
      const rangeArgs = [
        params.startPitch,
        params.pitchSpan,
        params.startBeat,
        params.timeSpan
      ];
      const hasRange = rangeArgs.every((value) => value !== void 0);
      const requestArgs = hasRange ? [
        params.trackIndex,
        params.clipIndex,
        params.startPitch,
        params.pitchSpan,
        params.startBeat,
        params.timeSpan
      ] : [params.trackIndex, params.clipIndex];
      const reply = await transport.request("/live/clip/get/notes", requestArgs);
      return JSON.stringify({
        trackIndex: params.trackIndex,
        clipIndex: params.clipIndex,
        notes: parseNotes(reply.args)
      });
    },
    async ableton_get_selection(_args) {
      const [
        selectedTrackReply,
        selectedSceneReply,
        selectedClipReply,
        selectedDeviceReply,
        trackNamesReply,
        sceneNamesReply
      ] = await Promise.all([
        transport.request("/live/view/get/selected_track"),
        transport.request("/live/view/get/selected_scene"),
        transport.request("/live/view/get/selected_clip"),
        transport.request("/live/view/get/selected_device"),
        transport.request("/live/song/get/track_names"),
        transport.request("/live/song/get/scenes/name")
      ]);
      const selectedTrack = firstNumber(selectedTrackReply.args, "selected track");
      const selectedScene = firstNumber(selectedSceneReply.args, "selected scene");
      const trackNames = parseIndexedValues(trackNamesReply.args);
      const sceneNames = parseIndexedValues(sceneNamesReply.args);
      return JSON.stringify({
        selectedTrack: {
          index: selectedTrack,
          name: stringValue(trackNames, selectedTrack)
        },
        selectedScene: {
          index: selectedScene,
          name: stringValue(sceneNames, selectedScene)
        },
        selectedClip: {
          trackIndex: asNumberOrNull(selectedClipReply.args[0]),
          sceneIndex: asNumberOrNull(selectedClipReply.args[1])
        },
        selectedDevice: {
          trackIndex: asNumberOrNull(selectedDeviceReply.args[0]),
          deviceIndex: asNumberOrNull(selectedDeviceReply.args[1])
        }
      });
    },
    async ableton_list_devices(args) {
      const params = trackTargetSchema.parse(args ?? {});
      const [countReply, namesReply, typesReply, classNamesReply] = await Promise.all([
        transport.request("/live/track/get/num_devices", [params.trackIndex]),
        transport.request("/live/track/get/devices/name", [params.trackIndex]),
        transport.request("/live/track/get/devices/type", [params.trackIndex]),
        transport.request("/live/track/get/devices/class_name", [params.trackIndex])
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
            role: classifyDevice(className)
          };
        })
      });
    },
    async ableton_get_device_parameters(args) {
      const params = deviceTargetSchema.parse(args ?? {});
      const prefix = [params.trackIndex, params.deviceIndex];
      const [countReply, namesReply, valuesReply, minsReply, maxesReply, quantizedReply] = await Promise.all([
        transport.request("/live/device/get/num_parameters", prefix),
        transport.request("/live/device/get/parameters/name", prefix),
        transport.request("/live/device/get/parameters/value", prefix),
        transport.request("/live/device/get/parameters/min", prefix),
        transport.request("/live/device/get/parameters/max", prefix),
        transport.request("/live/device/get/parameters/is_quantized", prefix)
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
          isQuantized: booleanValue(quantized, parameterIndex)
        }))
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
        "track count"
      );
      const requestedIndex = params.index ?? -1;
      await transport.send("/live/song/create_midi_track", [requestedIndex]);
      const after = firstNumber(
        (await transport.request("/live/song/get/num_tracks")).args,
        "track count"
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
            `Track name read-back mismatch: expected ${params.name}, got ${actualName}`
          );
        }
      }
      return JSON.stringify({ trackIndex, trackCount: after, name: params.name, verified: true });
    },
    async ableton_create_midi_clip(args) {
      const params = createClipSchema.parse(args ?? {});
      const target = [params.trackIndex, params.clipIndex];
      const before = thirdBoolean(
        (await transport.request("/live/clip_slot/get/has_clip", target)).args,
        "clip slot"
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
        "clip slot"
      );
      if (!hasClip) {
        throw new Error("Clip create read-back mismatch: slot is still empty");
      }
      return JSON.stringify({
        trackIndex: params.trackIndex,
        clipIndex: params.clipIndex,
        hasClip,
        verified: true
      });
    },
    async ableton_add_notes(args) {
      const params = addNotesSchema.parse(args ?? {});
      const noteArgs = params.notes.flatMap((note) => [
        note.pitch,
        note.startBeat,
        note.durationBeats,
        note.velocity,
        note.muted ?? false
      ]);
      await transport.send("/live/clip/add/notes", [
        params.trackIndex,
        params.clipIndex,
        ...noteArgs
      ]);
      const reply = await transport.request("/live/clip/get/notes", [
        params.trackIndex,
        params.clipIndex
      ]);
      const readBack = parseNotes(reply.args);
      if (!notesContainAll(readBack, params.notes)) {
        throw new Error("MIDI note read-back mismatch");
      }
      return JSON.stringify({
        trackIndex: params.trackIndex,
        clipIndex: params.clipIndex,
        noteCount: params.notes.length,
        verified: true
      });
    },
    async ableton_fire_clip(args) {
      const params = clipTargetSchema.parse(args ?? {});
      await transport.send("/live/clip_slot/fire", [params.trackIndex, params.clipIndex]);
      const reply = await transport.request("/live/track/get/fired_slot_index", [
        params.trackIndex
      ]);
      const firedSlot = Number(reply.args[1] ?? -1);
      if (firedSlot !== params.clipIndex) {
        throw new Error(
          `Clip fire read-back mismatch: expected slot ${params.clipIndex}, got ${firedSlot}`
        );
      }
      return JSON.stringify({ ...params, firedSlot, verified: true });
    },
    async ableton_play_stop(args) {
      const params = playStopSchema.parse(args ?? {});
      const shouldPlay = params.action === "play";
      await transport.send(shouldPlay ? "/live/song/start_playing" : "/live/song/stop_playing");
      const isPlaying = toBoolean(
        (await transport.request("/live/song/get/is_playing")).args[0] ?? false
      );
      if (isPlaying !== shouldPlay) {
        throw new Error(
          `Transport read-back mismatch: expected is_playing=${shouldPlay}, got ${isPlaying}`
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
          `Pan read-back mismatch: set ${params.pan}, got ${actual}`
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
        transport.request("/live/track/get/solo", [ti])
      ]);
      const sendResults = await Promise.allSettled(
        Array.from(
          { length: 8 },
          (_, i) => transport.request("/live/track/get/send", [ti, i])
        )
      );
      const sendLevels = sendResults.map((r) => r.status === "fulfilled" ? firstNumber(r.value.args, "send") : null).filter((v) => v !== null);
      return JSON.stringify({
        trackIndex: ti,
        volume: firstNumber(volReply.args, "volume"),
        panning: firstNumber(panReply.args, "panning"),
        mute: toBoolean(muteReply.args[0] ?? false),
        solo: toBoolean(soloReply.args[0] ?? false),
        sendLevels
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
      await transport.send("/live/scene/fire", [params.sceneIndex]);
      return JSON.stringify({ sceneIndex: params.sceneIndex, fired: true });
    },
    async ableton_set_device_parameter(args) {
      const params = setDeviceParameterSchema.parse(args ?? {});
      await transport.send("/live/device/set/parameter/value", [
        params.trackIndex,
        params.deviceIndex,
        params.parameterIndex,
        params.value
      ]);
      const reply = await transport.request("/live/device/get/parameter/value", [
        params.trackIndex,
        params.deviceIndex,
        params.parameterIndex
      ]);
      const actual = firstNumber(reply.args, "device parameter value");
      return JSON.stringify({
        trackIndex: params.trackIndex,
        deviceIndex: params.deviceIndex,
        parameterIndex: params.parameterIndex,
        requested: params.value,
        actual,
        verified: approxEqual(actual, params.value)
      });
    }
  };
}

// src/manifest.ts
var ABLETON_TOOL_NAME_RE = /^ableton_[a-z][a-z0-9_]*$/;
function validateAbletonManifest(m) {
  for (const tool of m.tools) {
    if (!tool.name || !ABLETON_TOOL_NAME_RE.test(tool.name)) {
      throw new TypeError(
        `Ableton manifest: tool ${JSON.stringify(tool.name)} has a missing or malformed OSC route name. Names must match ${ABLETON_TOOL_NAME_RE} (e.g. "ableton_ping").`
      );
    }
    if (!tool.description || !tool.description.trim()) {
      throw new TypeError(
        `Ableton manifest: tool "${tool.name}" is missing a description.`
      );
    }
    const params = tool.parameters;
    if (typeof params !== "object" || params === null || params["type"] !== "object") {
      throw new TypeError(
        `Ableton manifest: tool "${tool.name}" parameters must have type: "object". Got: ${JSON.stringify(params)}.`
      );
    }
  }
}
var manifest = {
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
      parameters: { type: "object", properties: {} }
    },
    {
      name: "ableton_get_session",
      description: "Read Ableton Live session status through AbletonOSC: version, tempo, time signature, track count, selected track.",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "ableton_list_tracks",
      description: "Read Ableton Live track count, track names, and selected track.",
      parameters: { type: "object", properties: {} }
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
            description: "Number of clip slots to inspect. Default 8, max 64."
          }
        },
        required: ["trackIndex"]
      }
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
            description: "Number of scenes to inspect. Default 8, max 64."
          }
        }
      }
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
          timeSpan: { type: "number", description: "Optional beat span." }
        },
        required: ["trackIndex", "clipIndex"]
      }
    },
    {
      name: "ableton_get_selection",
      description: "Read current Live selection: selected track, selected scene, selected clip slot, and selected device.",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "ableton_list_devices",
      description: "Read devices on one Ableton track: name, type, and class name.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." }
        },
        required: ["trackIndex"]
      }
    },
    {
      name: "ableton_get_device_parameters",
      description: "Read exposed parameter names, values, ranges, and quantization for one device.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          deviceIndex: { type: "number", description: "Zero-based device index." }
        },
        required: ["trackIndex", "deviceIndex"]
      }
    },
    {
      name: "ableton_set_tempo",
      description: "Set Ableton Live tempo in BPM and verify by reading /live/song/get/tempo.",
      parameters: {
        type: "object",
        properties: {
          bpm: { type: "number", description: "Tempo in BPM, 20-999." }
        },
        required: ["bpm"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_create_midi_track",
      description: "Create a MIDI track at an index (-1=end) and verify track count/name read-back.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "number", description: "Track index, or -1/end by default." },
          name: { type: "string", description: "Optional track name to set and verify." }
        }
      },
      requiresApproval: true
    },
    {
      name: "ableton_create_midi_clip",
      description: "Create a MIDI clip in a clip slot after checking occupancy; requires overwrite=true to replace.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          clipIndex: { type: "number", description: "Zero-based clip slot index." },
          lengthBeats: { type: "number", description: "Clip length in beats." },
          overwrite: {
            type: "boolean",
            description: "Delete existing slot clip before creation."
          }
        },
        required: ["trackIndex", "clipIndex", "lengthBeats"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_add_notes",
      description: "Add MIDI notes to a clip and verify written notes by reading /live/clip/get/notes.",
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
                muted: { type: "boolean", description: "Optional mute flag." }
              },
              required: ["pitch", "startBeat", "durationBeats", "velocity"]
            }
          }
        },
        required: ["trackIndex", "clipIndex", "notes"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_fire_clip",
      description: "Fire an Ableton clip slot and verify the track fired-slot index.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          clipIndex: { type: "number", description: "Zero-based clip slot index." }
        },
        required: ["trackIndex", "clipIndex"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_play_stop",
      description: "Start or stop Ableton playback and verify /live/song/get/is_playing.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["play", "stop"] }
        },
        required: ["action"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_set_track_pan",
      description: "Set a track panning value (-1=hard left, 0=center, 1=hard right) and verify via /live/track/get/panning.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          pan: { type: "number", description: "Pan value -1 (left) to 1 (right)." }
        },
        required: ["trackIndex", "pan"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_set_track_volume",
      description: "Set a track volume (0.0=silent to 1.0=max, ~0.85\u22480 dB) and verify via /live/track/get/volume.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          volume: { type: "number", description: "Volume 0.0 (silent) to 1.0 (max); ~0.85 \u2248 0 dB." }
        },
        required: ["trackIndex", "volume"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_set_track_mute",
      description: "Mute or unmute a track and verify via /live/track/get/mute.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          mute: { type: "boolean", description: "true to mute, false to unmute." }
        },
        required: ["trackIndex", "mute"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_set_track_solo",
      description: "Solo or un-solo a track and verify via /live/track/get/solo.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." },
          solo: { type: "boolean", description: "true to solo, false to un-solo." }
        },
        required: ["trackIndex", "solo"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_fire_scene",
      description: "Fire (launch) a scene by index via /live/scene/fire \u2014 triggers all clips in that scene row.",
      parameters: {
        type: "object",
        properties: {
          sceneIndex: { type: "number", description: "Zero-based scene index." }
        },
        required: ["sceneIndex"]
      },
      requiresApproval: true
    },
    {
      name: "ableton_get_track_mixer",
      description: "Read a track's mixer state \u2014 volume, panning, mute, solo, and send levels \u2014 via /live/track/get/*.",
      parameters: {
        type: "object",
        properties: {
          trackIndex: { type: "number", description: "Zero-based track index." }
        },
        required: ["trackIndex"]
      }
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
          value: { type: "number", description: "Target value; clamped to the parameter's min/max range." }
        },
        required: ["trackIndex", "deviceIndex", "parameterIndex", "value"]
      },
      requiresApproval: true
    }
  ]
};
validateAbletonManifest(manifest);

// src/index.ts
function createAbletonPlugin(config, deps = {}) {
  if (!config?.enabled) return null;
  const handlers = createAbletonHandlers({
    ...deps,
    host: deps.host ?? config.host,
    sendPort: deps.sendPort ?? config.sendPort,
    receivePort: deps.receivePort ?? config.receivePort,
    timeoutMs: deps.timeoutMs ?? config.timeoutMs
  });
  return { manifest, handlers };
}
export {
  AbletonOscUdpTransport,
  createAbletonHandlers,
  createAbletonPlugin,
  manifest
};
