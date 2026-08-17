import { stripMarkdownFences } from "../director/director.js";
import type { SceneSpec } from "../scene/scene-spec.js";

/**
 * Brand judge factory — produces the `brandJudge` the quality gate's GateDeps
 * expects, backed by an injected LLM call.
 *
 * THROW BEHAVIOR: on unparseable/invalid LLM output the judge retries ONCE
 * with a JSON-only nudge, then THROWS. `evaluate()` in gate/quality-gate.ts
 * does NOT catch brandJudge throws — they propagate out of the gate. The
 * orchestrator (runStudioBrief) contains a thrown gate error as a failed
 * attempt (confidence 0) that consumes retry budget and ends in an "escalate"
 * record once the budget is spent. If the registration layer wants a judge
 * failure to escalate immediately instead of burning render retries, it must
 * catch around its gate wrapper itself.
 */

const SYSTEM_PROMPT = `You are the strict JSON-only Brand Judge for bleepybot, the animated mascot of the band "bleepythings", which is running an earnest comeback campaign. You receive a JSON scene spec describing a short animated clip and you score its brand fit.

RUBRIC — in priority order:
1. CHARM AND WATCHABILITY FIRST. The operator's verbatim taste verdict on the reference render is: "cute — made me want to look at it for a while". Score how strongly this spec would make someone want to keep looking. Cute, hold-your-gaze, loopable.
2. CHARACTER ON-MODEL. bleepybot is a friendly signal-sweeping robot. Glitch is an ACCENT, not the identity — a spec that leads with glitch, menace, or gloom is off-model.
3. MESSAGE TONE fits an earnest band comeback: warm, sincere, a little wistful is fine. No cringe hype, no engagement-bait, no offensive or off-brand content.
4. TEXT RESTRAINT: at most 4 short lines. Walls of text or long lines lose points.

OUTPUT FORMAT — respond with ONLY a JSON object, no prose, no markdown fences:
{"score": <number between 0 and 1>, "reason": "<one sentence>"}`;

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

/** Parse + validate a judge verdict; throws on anything malformed. */
function parseVerdict(raw: string): { score: number; reason: string } {
	const parsed: unknown = JSON.parse(stripMarkdownFences(raw));
	const obj = parsed as { score?: unknown; reason?: unknown };
	if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) {
		throw new Error("brand judge verdict missing a finite numeric score");
	}
	return {
		score: clamp01(obj.score),
		reason: typeof obj.reason === "string" ? obj.reason : "",
	};
}

/**
 * Create a brand judge over an injected LLM. The SceneSpec JSON is the user
 * prompt; the verdict must be `{"score": <0..1>, "reason": "<one sentence>"}`.
 * Retries once on bad output, then throws (see module jsdoc for containment).
 */
export function createBrandJudge(
	llm: (systemPrompt: string, userPrompt: string) => Promise<string>,
): (spec: SceneSpec) => Promise<{ score: number; reason: string }> {
	return async (spec) => {
		const userPrompt = JSON.stringify(spec);
		try {
			return parseVerdict(await llm(SYSTEM_PROMPT, userPrompt));
		} catch {
			const nudged = `${userPrompt}\n\nReturn ONLY the JSON object.`;
			try {
				return parseVerdict(await llm(SYSTEM_PROMPT, nudged));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`brand judge returned invalid output after retry: ${msg}`);
			}
		}
	};
}
