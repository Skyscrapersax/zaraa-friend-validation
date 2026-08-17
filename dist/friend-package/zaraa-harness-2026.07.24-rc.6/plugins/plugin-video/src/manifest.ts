import type { PluginManifest, PluginToolDefinition } from "@zaraa/shared";

const tools: PluginToolDefinition[] = [
  {
    name: "watch_video",
    description:
      "Watch a video (URL or local path) and return a grounded text report (scene descriptions + transcript) you can answer from. " +
      "Runs fully locally. Optionally focus a time range with start/end or zoom by re-calling.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1, description: "Video URL (yt-dlp supported) or local file path" },
        question: { type: "string", description: "Optional question to steer the description" },
        start: { type: "number", minimum: 0, description: "Focus start time (seconds)" },
        end: { type: "number", minimum: 0, description: "Focus end time (seconds)" },
        maxFrames: { type: "integer", minimum: 1, maximum: 100, description: "Override frame budget" },
        resolution: { type: "integer", enum: [512, 1024], description: "Frame width px (1024 for on-screen text)" },
      },
      required: ["source"],
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
];

export const VIDEO_MANIFEST: PluginManifest = {
  name: "video",
  version: "0.1.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["media.video"],
  trust: "verified",
  tools,
};
