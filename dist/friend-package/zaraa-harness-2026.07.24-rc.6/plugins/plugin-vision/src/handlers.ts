import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import {
	visionAnalyzeSchema,
	VISION_DEFAULTS,
	SUPPORTED_IMAGE_EXTENSIONS,
	type VisionPluginConfig,
} from "./types.js";

export interface VisionHandlerDeps {
	/** Lazily reads the live vision config block so config edits apply without restart. */
	getConfig: () => VisionPluginConfig | undefined;
	/** Optional path gate — wired by the host to the same sandbox checks file_read uses.
	 *  Throws when the path is not readable under the current zone policy. */
	assertReadable?: (path: string) => void | Promise<void>;
}

export interface VisionToolHandlers {
	vision_analyze(args: unknown): Promise<string>;
}

const DEFAULT_QUESTION =
	"Describe this image precisely: visible text, UI elements, numbers, charts, and anything unusual.";

// Custom questions are often verdict-shaped ("did it succeed?") and the VLM
// answers in kind — the visible specifics (counts, verbatim strings) never
// reach the conversation, so downstream answers can't ground claims in them.
// The suffix elicits the evidence; the result framing below keeps it quotable
// through synthesis. (iter50 vision-grounding: VLM read "5691 passed" fine
// when asked for specifics, but verdict relays dropped the numbers.)
const EVIDENCE_SUFFIX =
	" Include the exact numbers, counts, and verbatim text visible in the image — specifics, not summaries.";

export function createVisionHandlers(deps: VisionHandlerDeps): VisionToolHandlers {
	return {
		async vision_analyze(args: unknown): Promise<string> {
			const parsed = visionAnalyzeSchema.safeParse(args ?? {});
			if (!parsed.success) {
				throw new Error(`invalid arguments — ${parsed.error.issues.map((i) => i.message).join("; ")}`);
			}
			const { imagePath, question } = parsed.data;
			const cfg = { ...VISION_DEFAULTS, ...(deps.getConfig() ?? {}) };

			const ext = extname(imagePath).toLowerCase();
			if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
				throw new Error(`unsupported image extension "${ext}" — use png/jpg/jpeg/webp/gif`);
			}
			if (!existsSync(imagePath)) {
				throw new Error(`image not found at ${imagePath}`);
			}

			// Gate path access through the host sandbox before reading.
			if (deps.assertReadable) {
				await deps.assertReadable(imagePath);
			}

			const size = statSync(imagePath).size;
			if (size > cfg.maxImageBytes) {
				throw new Error(`image too large (${size} bytes > ${cfg.maxImageBytes} max)`);
			}

			let base64: string;
			try {
				base64 = readFileSync(imagePath).toString("base64");
			} catch (err) {
				throw new Error(`failed to read image — ${err instanceof Error ? err.message : String(err)}`);
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
			try {
				const resp = await fetch(`${cfg.baseUrl}/api/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: cfg.model,
						stream: false,
						// Vision answers must be direct evidence, not deliberation:
						// thinking-mode VLMs (gemma-4 QAT) burn their token budget in
						// the reasoning channel and return empty/truncated content.
						// No-op for non-thinking models (qwen2.5vl).
						think: false,
						// Unload promptly: this host is RAM-constrained and the VLM must
						// not squat memory between calls.
						keep_alive: "2m",
						messages: [
							{
								role: "user",
								content: question?.trim()
									? `${question.trim()}${EVIDENCE_SUFFIX}`
									: DEFAULT_QUESTION,
								images: [base64],
							},
						],
					}),
					signal: controller.signal,
				});
				if (!resp.ok) {
					const detail = await resp.text().catch(() => "");
					throw new Error(`ollama returned ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
				}
				const data = (await resp.json()) as { message?: { content?: string } };
				const answer = data.message?.content?.trim();
				if (!answer || answer.length === 0) {
					throw new Error("vision model returned empty content");
				}
				// Frame as quotable evidence so synthesis keeps the specifics
				// instead of compressing to a verdict.
				return `Visual evidence (${basename(imagePath)}) — quote the exact numbers/strings below when confirming or refuting claims:\n${answer}`;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error(`timed out after ${cfg.timeoutMs}ms`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
