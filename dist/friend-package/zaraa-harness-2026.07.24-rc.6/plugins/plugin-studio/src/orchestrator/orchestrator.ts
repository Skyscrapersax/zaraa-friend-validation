import type { DirectorBrief } from "../director/director.js";
import type { GateInput, GateVerdict } from "../gate/quality-gate.js";
import type { SceneSpec } from "../scene/scene-spec.js";
import type { StudioStore } from "../store/studio-store.js";

/**
 * Orchestrator — the autonomy contract for the shorts pipeline:
 * brief → director → render → gate; pass = export + log; fail = bounded
 * retries with spec VARIATION, then ESCALATE to the operator.
 *
 * It must never loop unboundedly — bounded-retry-then-escalate is the fix for
 * the system's known "churn-as-completion" failure mode. Pure routing over
 * injected deps; no LLM/ffmpeg/sqlite knowledge lives here.
 */

export interface OrchestratorDeps {
	/** Retry budget AFTER the initial attempt (total attempts = maxRetries + 1). */
	maxRetries: number;
	director: (brief: DirectorBrief) => Promise<SceneSpec>;
	render: (spec: SceneSpec) => Promise<string[]>;
	keyFrameHashes: (mp4OrFrames: string[]) => Promise<string[]>;
	gate: (input: GateInput) => Promise<GateVerdict>;
	store: StudioStore;
	/** Bound by the caller over an export root; returns the export dir. */
	exportRender: (spec: SceneSpec, caption: string, files: string[]) => string;
}

export interface OrchestratorResult {
	verdict: "pass" | "escalate";
	exportDir?: string;
	reason: string;
	attempts: number;
	bestConfidence: number;
}

/** Caption for export: spec caption + hashtags, falling back to the first message line. */
function captionFor(spec: SceneSpec): string {
	if (spec.caption) {
		return [spec.caption.text, spec.caption.hashtags.join(" ")]
			.filter((part) => part.length > 0)
			.join("\n");
	}
	return spec.message.lines[0];
}

/** Vary the spec for a retry: same creative, new deterministic seed. */
function varySpec(base: SceneSpec, attempt: number): SceneSpec {
	return { ...base, seed: (base.seed + attempt * 7919) | 0 };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runStudioBrief(
	brief: DirectorBrief,
	deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
	let baseSpec: SceneSpec;
	try {
		baseSpec = await deps.director(brief);
	} catch (err) {
		// A director throw (LLM down, bad output) is an operator matter, not an
		// unhandled crash: record the escalate so the contract holds.
		deps.store.recordRender({
			specJson: JSON.stringify({ brief }),
			verdict: "escalate",
			confidence: 0,
			files: [],
		});
		return {
			verdict: "escalate",
			reason: `director failed: ${errorMessage(err)}`,
			attempts: 0,
			bestConfidence: 0,
		};
	}

	let bestConfidence = 0;
	let lastReason = "no attempts ran";
	let lastError: string | undefined;
	let lastSpec = baseSpec;
	let lastFiles: string[] = [];
	// Hashes computed for the CURRENT attempt only; undefined when the attempt
	// threw before hashing (the final escalate record must not carry stale hashes).
	let lastHashes: string[] | undefined;

	for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
		const spec = attempt === 0 ? baseSpec : varySpec(baseSpec, attempt);
		lastSpec = spec;
		lastHashes = undefined;
		try {
			const files = await deps.render(spec);
			lastFiles = files;
			const hashes = await deps.keyFrameHashes(files);
			lastHashes = hashes;
			// historyHashes is [] by design: the registration layer binds a gate that
			// closes over real shipped-render history; the orchestrator stays pure routing.
			const result = await deps.gate({ keyFrameHashes: hashes, spec, historyHashes: [] });
			lastError = undefined;
			lastReason = result.reason;
			if (result.confidence > bestConfidence) bestConfidence = result.confidence;

			if (result.verdict === "pass") {
				const exportDir = deps.exportRender(spec, captionFor(spec), files);
				deps.store.recordRender({
					specJson: JSON.stringify(spec),
					verdict: "pass",
					confidence: result.confidence,
					files,
					keyHashes: hashes,
				});
				return {
					verdict: "pass",
					exportDir,
					reason: result.reason,
					attempts: attempt + 1,
					bestConfidence,
				};
			}

			if (result.verdict === "escalate") {
				// Gate is unsure → operator call. Do not burn retries on ambiguity.
				deps.store.recordRender({
					specJson: JSON.stringify(spec),
					verdict: "escalate",
					confidence: result.confidence,
					files,
					keyHashes: hashes,
				});
				return {
					verdict: "escalate",
					reason: result.reason,
					attempts: attempt + 1,
					bestConfidence,
				};
			}

			// verdict === "fail": a seed-independent fail (legibility, brand) yields
			// the same verdict on every re-render — escalate now instead of burning
			// chromium+ffmpeg cycles. Undefined stays retryable for back-compat.
			if (result.retryable === false) {
				deps.store.recordRender({
					specJson: JSON.stringify(spec),
					verdict: "escalate",
					confidence: result.confidence,
					files,
					keyHashes: hashes,
				});
				return {
					verdict: "escalate",
					reason: result.reason,
					attempts: attempt + 1,
					bestConfidence,
				};
			}
			// Retryable fail → retry with a varied spec until the budget is spent.
		} catch (err) {
			// A thrown render/hash/gate error (host-busy, ffmpeg, Playwright crash)
			// counts as a failed attempt: confidence 0, continue into the retry budget.
			lastError = errorMessage(err);
			lastReason = `error: ${lastError}`;
		}
	}

	// Retry budget exhausted → escalate (never loop unboundedly). Hashes only
	// when the final attempt got far enough to compute them.
	deps.store.recordRender({
		specJson: JSON.stringify(lastSpec),
		verdict: "escalate",
		confidence: bestConfidence,
		files: lastFiles,
		keyHashes: lastHashes,
	});
	return {
		verdict: "escalate",
		reason:
			lastError !== undefined
				? `error: ${lastError}`
				: `retry budget exhausted after ${deps.maxRetries + 1} attempts; last gate reason: ${lastReason}`,
		attempts: deps.maxRetries + 1,
		bestConfidence,
	};
}
