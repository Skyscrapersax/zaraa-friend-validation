import type { PluginManifest } from "@zaraa/shared";

export { createVisionHandlers, type VisionHandlerDeps, type VisionToolHandlers } from "./handlers.js";
export { visionAnalyzeSchema, VISION_DEFAULTS, type VisionPluginConfig } from "./types.js";

/**
 * Local VLM vision plugin. Zone `guarded`: reads image files from disk,
 * sends base64 to the local ollama vision model via native /api/chat,
 * and returns a grounded text answer. Tool name `vision_analyze`.
 */
export const manifest: PluginManifest = {
	name: "vision",
	version: "0.1.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["vision.analyze"],
	trust: "core",
	tools: [
		{
			name: "vision_analyze",
			description:
				"Analyze an image file (screenshot, chart, error dialog, document photo) with the local vision model and return a grounded text answer. Use whenever a question concerns something visual on disk.",
			parameters: {
				type: "object",
				properties: {
					imagePath: {
						type: "string",
						description: "Absolute path to the image file (png/jpg/jpeg/webp/gif, ≤8MB)",
					},
					question: {
						type: "string",
						description: "What to determine from the image (default: precise full description)",
					},
				},
				required: ["imagePath"],
			},
		},
	],
};
