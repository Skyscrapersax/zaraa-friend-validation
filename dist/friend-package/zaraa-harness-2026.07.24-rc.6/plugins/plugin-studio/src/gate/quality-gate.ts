import type { SceneSpec } from "../scene/scene-spec.js";
import { hamming } from "./phash.js";

/**
 * Quality + novelty gate — the keystone that prevents autonomous slop in the
 * video lane. Hard-checks (novelty vs recent renders, text legibility) run
 * first and fail outright; only then does the injected brand judge score the
 * spec, and the verdict falls out of thresholds: pass / escalate-to-operator /
 * fail. Pure logic + injected judge — no LLM call here (the real brandJudge is
 * wired by the orchestrator at registration).
 */

export interface GateInput {
	/** pHash hex strings of key frames sampled from the render. */
	keyFrameHashes: string[];
	spec: SceneSpec;
	/** pHash hex strings of recently shipped renders. */
	historyHashes: string[];
}

export interface GateDeps {
	brandJudge: (spec: SceneSpec) => Promise<{ score: number; reason: string }>;
}

export interface GateVerdict {
	verdict: "pass" | "escalate" | "fail";
	reason: string;
	confidence: number;
	/**
	 * For "fail" verdicts: whether a re-render with a varied seed could plausibly
	 * change the outcome. Novelty fails are seed-dependent (retryable); legibility
	 * and brand-judge fails are properties of the creative itself (not retryable —
	 * re-rendering burns chromium+ffmpeg cycles for an identical verdict).
	 * Undefined is treated as retryable for backward compatibility.
	 */
	retryable?: boolean;
}

/** Any key frame within this hamming distance of any history hash → not novel. */
export const DUP_DISTANCE_THRESHOLD = 6;
/** Any message line longer than this is unreadable on a phone at a glance. */
export const MAX_LINE_CHARS = 42;
/** Judge score at or above this → pass. */
export const PASS_THRESHOLD = 0.7;
/** Judge score at or above this (but below PASS_THRESHOLD) → escalate to operator. */
export const ESCALATE_FLOOR = 0.3;

export async function evaluate(input: GateInput, deps: GateDeps): Promise<GateVerdict> {
	// Hard check 1: novelty vs recent renders.
	for (const frame of input.keyFrameHashes) {
		for (const past of input.historyHashes) {
			const distance = hamming(frame, past);
			if (distance < DUP_DISTANCE_THRESHOLD) {
				return {
					verdict: "fail",
					reason: `not novel vs recent renders (hamming ${distance} < ${DUP_DISTANCE_THRESHOLD})`,
					confidence: 1,
					retryable: true, // a new seed yields new frames
				};
			}
		}
	}

	// Hard check 2: text legibility.
	for (const line of input.spec.message.lines) {
		if (line.length > MAX_LINE_CHARS) {
			return {
				verdict: "fail",
				reason: `text legibility: line too long for mobile (${line.length} > ${MAX_LINE_CHARS} chars)`,
				confidence: 1,
				retryable: false, // line length is seed-independent
			};
		}
	}

	// Soft check: brand fit via the injected judge.
	const { score, reason } = await deps.brandJudge(input.spec);
	if (score >= PASS_THRESHOLD) {
		return { verdict: "pass", reason, confidence: score };
	}
	if (score >= ESCALATE_FLOOR) {
		return { verdict: "escalate", reason, confidence: score };
	}
	// Brand-judge rejection is about the creative, not the render seed.
	return { verdict: "fail", reason, confidence: score, retryable: false };
}
