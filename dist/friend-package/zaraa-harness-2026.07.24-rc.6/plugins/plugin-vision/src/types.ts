import { z } from "zod";

export const visionAnalyzeSchema = z.object({
	imagePath: z.string().min(1, "imagePath is required"),
	question: z.string().optional(),
});

export type VisionAnalyzeArgs = z.infer<typeof visionAnalyzeSchema>;

export interface VisionPluginConfig {
	model?: string;
	baseUrl?: string;
	timeoutMs?: number;
	maxImageBytes?: number;
}

export const VISION_DEFAULTS = {
	model: "qwen2.5vl:7b",
	baseUrl: "http://127.0.0.1:11434",
	timeoutMs: 60_000,
	maxImageBytes: 8 * 1024 * 1024,
} as const;

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
