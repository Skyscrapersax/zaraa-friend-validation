import {
  __export
} from "./chunk-R5U7XKVJ.js";

// src/creative/premiere.ts
var premiere_exports = {};
__export(premiere_exports, {
  createHandlers: () => createHandlers,
  manifest: () => manifest
});
var manifest = {
  name: "premiere-pro",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["creative.nle"],
  trust: "core",
  tools: [
    {
      name: "prm_get_project_info",
      description: "Get current Adobe Premiere Pro project information including name and path",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "prm_import_media",
      description: "Import a media file into the current Premiere Pro project",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path of the media to import"
          }
        },
        required: ["path"]
      },
      requiresApproval: true
    },
    {
      name: "prm_export_sequence",
      description: "Export the active sequence from Premiere Pro",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["h264", "prores"],
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
    },
    {
      name: "prm_get_timeline_info",
      description: "Get active sequence timeline info including name, duration, and video/audio track count",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(osa) {
  return {
    prm_get_project_info: async (_args) => {
      const name = await osa.run(
        'tell application "Adobe Premiere Pro" to get name of active project'
      );
      const path = await osa.run(
        'tell application "Adobe Premiere Pro" to get file path of active project'
      );
      return JSON.stringify({ name, path });
    },
    prm_import_media: async (args) => {
      const path = args.path;
      await osa.run(
        `do shell script "osascript -e 'tell application \\"Adobe Premiere Pro\\"' -e 'import file \\"${path}\\" into active project' -e 'end tell'"`
      );
      return `Imported ${path} into project`;
    },
    prm_export_sequence: async (args) => {
      const format = args.format;
      const path = args.path;
      const preset = format === "h264" ? "H.264" : "Apple ProRes";
      await osa.run(
        `do shell script "osascript -e 'tell application \\"Adobe Premiere Pro\\"' -e 'export active sequence to \\"${path}\\" using preset \\"${preset}\\"' -e 'end tell'"`
      );
      return `Exported active sequence to ${path} as ${format}`;
    },
    prm_get_timeline_info: async (_args) => {
      const name = await osa.run(
        'tell application "Adobe Premiere Pro" to get name of active sequence'
      );
      const duration = await osa.run(
        'tell application "Adobe Premiere Pro" to get duration of active sequence'
      );
      const videoTrackCount = await osa.run(
        'tell application "Adobe Premiere Pro" to get count of video tracks of active sequence'
      );
      const audioTrackCount = await osa.run(
        'tell application "Adobe Premiere Pro" to get count of audio tracks of active sequence'
      );
      return JSON.stringify({
        name,
        duration,
        videoTrackCount: Number(videoTrackCount),
        audioTrackCount: Number(audioTrackCount)
      });
    }
  };
}

export {
  manifest,
  createHandlers,
  premiere_exports
};
