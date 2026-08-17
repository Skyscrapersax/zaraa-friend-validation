import {
  __export
} from "./chunk-R5U7XKVJ.js";

// src/creative/logic-pro.ts
var logic_pro_exports = {};
__export(logic_pro_exports, {
  createHandlers: () => createHandlers,
  manifest: () => manifest
});
var manifest = {
  name: "logic-pro",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["creative.daw"],
  trust: "core",
  tools: [
    {
      name: "lp_get_info",
      description: "Get current Logic Pro project information including name, tempo, time signature, and track count",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "lp_set_tempo",
      description: "Set the tempo of the current Logic Pro project (5-990 BPM)",
      parameters: {
        type: "object",
        properties: {
          bpm: {
            type: "number",
            description: "Tempo in BPM (5-990)"
          }
        },
        required: ["bpm"]
      },
      requiresApproval: true
    },
    {
      name: "lp_add_track",
      description: "Add a new software instrument or audio track to the Logic Pro project",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["software-instrument", "audio"],
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
      name: "lp_export",
      description: "Export/bounce the Logic Pro project to an audio file",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["aiff", "wav", "mp3", "aac"],
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
    lp_get_info: async (_args) => {
      const name = await osa.run(
        'tell application "Logic Pro" to get name of front document'
      );
      const tempo = await osa.run(
        'tell application "Logic Pro" to get tempo of front document'
      );
      return JSON.stringify({ name, tempo: Number(tempo) });
    },
    lp_set_tempo: async (args) => {
      const bpm = args.bpm;
      if (bpm < 5 || bpm > 990) {
        throw new Error("Tempo must be between 5 and 990 BPM");
      }
      await osa.run(
        `tell application "Logic Pro" to set tempo of front document to ${Math.round(bpm)}`
      );
      return `Tempo set to ${Math.round(bpm)} BPM`;
    },
    lp_add_track: async (args) => {
      const trackType = args.type;
      const name = args.name;
      const script = trackType === "software-instrument" ? 'tell application "Logic Pro" to make new software instrument track at front document' : 'tell application "Logic Pro" to make new audio track at front document';
      await osa.run(script);
      if (name) {
        await osa.run(
          `tell application "Logic Pro" to set name of last track of front document to "${name}"`
        );
      }
      return `Added ${trackType} track${name ? ` "${name}"` : ""}`;
    },
    lp_export: async (args) => {
      const format = args.format;
      const path = args.path;
      await osa.run(
        `tell application "Logic Pro" to export front document as ${format} to "${path}"`
      );
      return `Exported to ${path} as ${format}`;
    }
  };
}

export {
  manifest,
  createHandlers,
  logic_pro_exports
};
