import {
  __export
} from "./chunk-R5U7XKVJ.js";

// src/creative/ableton.ts
var ableton_exports = {};
__export(ableton_exports, {
  createHandlers: () => createHandlers,
  manifest: () => manifest
});
var manifest = {
  name: "ableton-live",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["creative.daw"],
  trust: "core",
  tools: [
    {
      name: "abl_get_session_info",
      description: "Get current Ableton Live Set info including name, tempo, and track count",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "abl_set_tempo",
      description: "Set the session tempo of the current Ableton Live Set (20-999 BPM)",
      parameters: {
        type: "object",
        properties: {
          bpm: {
            type: "number",
            description: "Tempo in BPM (20-999)"
          }
        },
        required: ["bpm"]
      },
      requiresApproval: true
    },
    {
      name: "abl_add_track",
      description: "Add a new audio or MIDI track to the current Ableton Live Set",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["audio", "midi"],
            description: "Track type"
          },
          name: {
            type: "string",
            description: "Optional track name"
          }
        },
        required: ["type"]
      },
      requiresApproval: true
    },
    {
      name: "abl_export_audio",
      description: "Export audio from the current Ableton Live session",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["wav", "aiff", "mp3"],
            description: "Export format"
          },
          path: {
            type: "string",
            description: "Output file path"
          }
        },
        required: ["format", "path"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(osa) {
  return {
    abl_get_session_info: async (_args) => {
      const name = await osa.run(
        'tell application "Ableton Live" to get name of current song'
      );
      const tempo = await osa.run(
        'tell application "Ableton Live" to get tempo of current song'
      );
      const trackCount = await osa.run(
        'tell application "Ableton Live" to get count of tracks of current song'
      );
      return JSON.stringify({
        name,
        tempo: Number(tempo),
        trackCount: Number(trackCount)
      });
    },
    abl_set_tempo: async (args) => {
      const bpm = args.bpm;
      if (bpm < 20 || bpm > 999) {
        throw new Error("Tempo must be between 20 and 999 BPM");
      }
      await osa.run(
        `tell application "Ableton Live" to set tempo of current song to ${Math.round(bpm)}`
      );
      return `Tempo set to ${Math.round(bpm)} BPM`;
    },
    abl_add_track: async (args) => {
      const trackType = args.type;
      const name = args.name;
      const script = trackType === "midi" ? 'tell application "Ableton Live" to make new midi track at current song' : 'tell application "Ableton Live" to make new audio track at current song';
      await osa.run(script);
      if (name) {
        await osa.run(
          `tell application "Ableton Live" to set name of last track of current song to "${name}"`
        );
      }
      return `Added ${trackType} track${name ? ` "${name}"` : ""}`;
    },
    abl_export_audio: async (args) => {
      const format = args.format;
      const path = args.path;
      await osa.run(
        `tell application "Ableton Live" to export current song as ${format} to "${path}"`
      );
      return `Exported to ${path} as ${format}`;
    }
  };
}

export {
  manifest,
  createHandlers,
  ableton_exports
};
