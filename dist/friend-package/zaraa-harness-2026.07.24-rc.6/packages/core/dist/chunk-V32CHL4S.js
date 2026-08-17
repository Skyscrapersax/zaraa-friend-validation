import {
  __export
} from "./chunk-R5U7XKVJ.js";

// src/creative/finalcut.ts
var finalcut_exports = {};
__export(finalcut_exports, {
  createHandlers: () => createHandlers,
  manifest: () => manifest
});
var manifest = {
  name: "finalcut",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["creative.nle"],
  trust: "core",
  tools: [
    {
      name: "fcp_get_info",
      description: "Get current Final Cut Pro project name, duration, and frame rate",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "fcp_import_media",
      description: "Import a media file into the current Final Cut Pro library",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the media file to import"
          }
        },
        required: ["path"]
      },
      requiresApproval: true
    },
    {
      name: "fcp_create_project",
      description: "Create a new Final Cut Pro project",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Project name"
          },
          fps: {
            type: "number",
            description: "Frame rate (optional, e.g. 24, 30, 60)"
          }
        },
        required: ["name"]
      },
      requiresApproval: true
    },
    {
      name: "fcp_export",
      description: "Export/share the current Final Cut Pro project",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["h264", "prores", "hevc"],
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
    fcp_get_info: async (_args) => {
      const name = await osa.run(
        'tell application "Final Cut Pro" to get name of front document'
      );
      const duration = await osa.run(
        'tell application "Final Cut Pro" to get duration of front document'
      );
      const fps = await osa.run(
        'tell application "Final Cut Pro" to get frame rate of front document'
      );
      return JSON.stringify({
        name,
        duration: Number(duration),
        fps: Number(fps)
      });
    },
    fcp_import_media: async (args) => {
      const path = args.path;
      await osa.run(
        `tell application "Final Cut Pro" to import "${path}"`
      );
      return `Imported media from ${path}`;
    },
    fcp_create_project: async (args) => {
      const name = args.name;
      const fps = args.fps;
      if (fps !== void 0 && fps <= 0) {
        throw new Error("Frame rate must be greater than 0");
      }
      const fpsClause = fps ? ` with frame rate ${fps}` : "";
      await osa.run(
        `tell application "Final Cut Pro" to make new project with name "${name}"${fpsClause}`
      );
      return `Created project "${name}"${fps ? ` at ${fps} fps` : ""}`;
    },
    fcp_export: async (args) => {
      const format = args.format;
      const path = args.path;
      await osa.run(
        `tell application "Final Cut Pro" to export front document as ${format} to "${path}"`
      );
      return `Exported to ${path} as ${format}`;
    }
  };
}

export {
  manifest,
  createHandlers,
  finalcut_exports
};
