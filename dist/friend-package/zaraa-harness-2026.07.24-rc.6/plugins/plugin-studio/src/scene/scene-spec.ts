import { z } from "zod";

/**
 * SceneSpec — the JSON contract between the Director (LLM) that designs a
 * bleepybot animated short and the scene engine that renders it.
 *
 * This is the data contract every later unit relies on; field names/types are
 * load-bearing. Defaults are applied on parse so the Director can emit a minimal
 * spec and rely on sane fills.
 */
export const SceneSpecSchema = z.object({
	seed: z.number().int(),
	durationSec: z.number().min(2).max(15),
	fps: z.number().int().positive().default(30),
	aspectRatios: z
		.array(z.enum(["1080x1920", "1080x1350"]))
		.nonempty()
		.default(["1080x1920", "1080x1350"]),
	palette: z
		.object({
			bg: z.string().default("#06080f"),
			primary: z.string().default("#ff2ea6"),
			accent: z.string().default("#2dd4bf"),
			text: z.string().default("#f6efe3"),
		})
		.default({}),
	character: z
		.object({
			mood: z.enum(["idle", "charged", "sweep", "blink", "glitch"]).default("charged"),
			intensity: z.number().min(0).max(1).default(0.7),
		})
		.default({}),
	message: z.object({
		lines: z.array(z.string()).min(1).max(4),
		style: z.string().default("kinetic"),
		timingSec: z.array(z.number()).default([]),
	}),
	audio: z
		.object({
			source: z.enum(["track", "bleeps"]).default("bleeps"),
			trackClip: z
				.object({
					file: z.string(),
					startSec: z.number(),
					endSec: z.number(),
				})
				.optional(),
			reactive: z.boolean().default(true),
		})
		.default({}),
	caption: z
		.object({
			text: z.string(),
			hashtags: z.array(z.string()).default([]),
		})
		.optional(),
});

export type SceneSpec = z.infer<typeof SceneSpecSchema>;
export type SceneSpecInput = z.input<typeof SceneSpecSchema>;
