import { SceneSpecSchema, type SceneSpec, type SceneSpecInput } from "../scene/scene-spec.js";

/**
 * Director — turns a BRIEF (content-calendar slot, track to promote, or a
 * free-form message) into a Zod-validated SceneSpec + caption via an LLM.
 *
 * The LLM designs the creative (message, mood, palette, caption); audio is
 * decided IN CODE from the brief, never trusted from the model.
 */

export interface DirectorBrief {
	message: string;
	availableTracks: Array<{
		file: string;
		suggestedStartSec?: number;
		suggestedEndSec?: number;
	}>;
}

export interface DirectorDeps {
	llm: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

const SYSTEM_PROMPT = `You are the Director for bleepybot, the animated mascot of the band "bleepythings". You design short vertical video clips (animated shorts) by emitting a single JSON scene spec.

AESTHETIC RUBRIC — in priority order:
1. LEAD WITH CHARM AND WATCHABILITY. bleepybot is cute and hold-your-gaze hypnotic FIRST. The operator's verdict on the first render: "cute — definitely made me want to look at it for a while." That is the bar. Every clip should make someone want to keep looking.
2. Moody/glitchy is an ACCENT, not the lead. Use the "glitch" mood sparingly, only when the comeback narrative calls for it, and never at the cost of the cute.
3. Hook in the first second. The first message line and the character's energy must land immediately.
4. Text is SHORT and PUNCHY: at most 4 lines, each a few words. One clear idea per clip — never two.
5. Duration: aim for 8-12 seconds. Long enough to hypnotize, short enough to loop.
6. Palette suggestions are welcome (hex colors) — keep them cohesive with a dark synthy stage; the defaults are a deep night bg with neon pink primary and teal accent.

OUTPUT FORMAT — emit ONLY a JSON object (no prose, no markdown fences) with these fields:
{
  "seed": integer (any; optional — one is generated if omitted),
  "durationSec": number between 2 and 15 (prefer 8-12),
  "fps": optional integer (default 30),
  "aspectRatios": optional array from ["1080x1920", "1080x1350"],
  "palette": optional { "bg": hex, "primary": hex, "accent": hex, "text": hex },
  "character": optional { "mood": one of ["idle", "charged", "sweep", "blink", "glitch"], "intensity": number 0-1 },
  "message": { "lines": array of 1-4 short strings, "style": optional string, "timingSec": optional array of numbers },
  "caption": { "text": short caption for the post, "hashtags": array of hashtag strings }
}

Do NOT include an "audio" field — audio is decided by the system, not by you.`;

function buildUserPrompt(brief: DirectorBrief): string {
	const trackNote =
		brief.availableTracks.length > 0
			? `A track is available for this clip (the system will attach it; design the clip to ride a music moment).`
			: `No track is available; the clip will use bleepybot's synthesized bleeps.`;
	return `BRIEF: ${brief.message}\n\nAUDIO CONTEXT: ${trackNote}\n\nEmit ONLY the JSON scene spec.`;
}

/** Strip a single ```/```json fence wrapper from LLM output (shared by director + brand judge). */
export function stripMarkdownFences(raw: string): string {
	const trimmed = raw.trim();
	const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
	return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseSpec(raw: string): SceneSpecInput {
	const json: unknown = JSON.parse(stripMarkdownFences(raw));
	// Validate the LLM's creative output; audio is overridden afterwards in code.
	SceneSpecSchema.parse(applySeedAndAudio(json as SceneSpecInput, []));
	return json as SceneSpecInput;
}

function applySeedAndAudio(
	spec: SceneSpecInput,
	availableTracks: DirectorBrief["availableTracks"],
): SceneSpecInput {
	const seed = typeof spec.seed === "number" ? spec.seed : Math.floor(Math.random() * 2 ** 31);
	const track = availableTracks[0];
	const audio: SceneSpecInput["audio"] = track
		? {
				source: "track",
				trackClip: {
					file: track.file,
					startSec: track.suggestedStartSec ?? 0,
					endSec: track.suggestedEndSec ?? (track.suggestedStartSec ?? 0) + spec.durationSec,
				},
			}
		: { source: "bleeps" };
	return { ...spec, seed, audio };
}

export async function direct(brief: DirectorBrief, deps: DirectorDeps): Promise<SceneSpec> {
	const userPrompt = buildUserPrompt(brief);

	let parsed: SceneSpecInput;
	try {
		parsed = parseSpec(await deps.llm(SYSTEM_PROMPT, userPrompt));
	} catch (firstErr) {
		const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
		const retryPrompt = `${userPrompt}\n\nYour previous output was invalid: ${errMsg}. Emit ONLY valid JSON.`;
		parsed = parseSpec(await deps.llm(SYSTEM_PROMPT, retryPrompt));
	}

	// Audio is a code decision, not an LLM decision; seed fills in if omitted.
	return SceneSpecSchema.parse(applySeedAndAudio(parsed, brief.availableTracks));
}
