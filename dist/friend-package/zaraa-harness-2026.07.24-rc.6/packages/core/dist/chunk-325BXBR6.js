import {
  __export
} from "./chunk-R5U7XKVJ.js";

// src/creative/davinci.ts
var davinci_exports = {};
__export(davinci_exports, {
  createHandlers: () => createHandlers,
  manifest: () => manifest
});
var manifest = {
  name: "davinci-resolve",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["creative.nle", "creative.color"],
  trust: "core",
  tools: [
    {
      name: "dvr_get_project_info",
      description: "Get current DaVinci Resolve project information including name, timeline, and resolution",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "dvr_add_to_timeline",
      description: "Add a media clip to the current DaVinci Resolve timeline",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the media clip"
          },
          track: {
            type: "number",
            description: "Target track number (optional, defaults to 1)"
          }
        },
        required: ["path"]
      },
      requiresApproval: true
    },
    {
      name: "dvr_render",
      description: "Render the current DaVinci Resolve timeline",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["h264", "prores", "dnxhd"],
            description: "Render format"
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
      name: "dvr_color_grade_preset",
      description: "Apply a color grading preset to the current DaVinci Resolve timeline",
      parameters: {
        type: "object",
        properties: {
          preset: {
            type: "string",
            description: "Name of the color grading preset to apply"
          }
        },
        required: ["preset"]
      },
      requiresApproval: true
    }
  ]
};
function pyScript(code) {
  return `do shell script "python3 -c 'import DaVinciResolveScript as dvr; resolve = dvr.scriptapp("Resolve"); ${code}'"`;
}
function createHandlers(osa) {
  return {
    dvr_get_project_info: async (_args) => {
      const result = await osa.run(
        pyScript(
          'pm = resolve.GetProjectManager(); p = pm.GetCurrentProject(); print(p.GetName()); print(p.GetCurrentTimeline().GetName() if p.GetCurrentTimeline() else "None"); print(p.GetSetting("timelineResolutionWidth") + "x" + p.GetSetting("timelineResolutionHeight"))'
        )
      );
      const lines = result.split("\n");
      return JSON.stringify({
        project: lines[0] || "",
        timeline: lines[1] || "",
        resolution: lines[2] || ""
      });
    },
    dvr_add_to_timeline: async (args) => {
      const path = args.path;
      const track = args.track ?? 1;
      await osa.run(
        pyScript(
          `pm = resolve.GetProjectManager(); p = pm.GetCurrentProject(); mp = p.GetMediaPool(); mp.ImportMedia(["${path}"]); tl = p.GetCurrentTimeline(); mp.AppendToTimeline([{"clipInfo": {"mediaPoolItem": mp.GetRootFolder().GetClipList()[-1], "trackIndex": ${track}}}])`
        )
      );
      return `Added ${path} to timeline on track ${track}`;
    },
    dvr_render: async (args) => {
      const format = args.format;
      const path = args.path;
      await osa.run(
        pyScript(
          `pm = resolve.GetProjectManager(); p = pm.GetCurrentProject(); p.SetRenderSettings({"TargetDir": "${path}", "FormatWidth": p.GetSetting("timelineResolutionWidth"), "FormatHeight": p.GetSetting("timelineResolutionHeight"), "ExportVideo": True, "ExportAudio": True}); p.AddRenderJob(); p.StartRendering()`
        )
      );
      return `Rendering timeline as ${format} to ${path}`;
    },
    dvr_color_grade_preset: async (args) => {
      const preset = args.preset;
      await osa.run(
        pyScript(
          `pm = resolve.GetProjectManager(); p = pm.GetCurrentProject(); tl = p.GetCurrentTimeline(); item = tl.GetCurrentVideoItem(); item.ApplyGradingPreset("${preset}")`
        )
      );
      return `Applied color grading preset "${preset}"`;
    }
  };
}

export {
  manifest,
  createHandlers,
  davinci_exports
};
