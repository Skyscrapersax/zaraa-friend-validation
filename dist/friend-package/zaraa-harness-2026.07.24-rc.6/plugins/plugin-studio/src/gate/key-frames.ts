import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG } from "../util/media-bins.js";
import { phashFromPng } from "./phash.js";

/**
 * Extract key frames from an MP4 and perceptually hash them — the real-world
 * input to the quality gate's novelty check.
 *
 * One PNG is dumped per timestamp (seconds) via ffmpeg, pHashed, and the temp
 * PNGs are always cleaned up. Timestamps default to `[0, 1.0]` (first frame +
 * one second in); callers that know the clip duration should pass
 * `{ timestamps: [0, durationSec / 2] }` — first + middle frame, matching the
 * e2e contract. Timestamp 0 reads the literal first frame (no seek); nonzero
 * timestamps fast-seek (`-ss` before `-i`) to the nearest frame.
 *
 * Throws when ffmpeg cannot read the file or a timestamp lies beyond the clip.
 */
export async function extractKeyFrameHashes(
	mp4Path: string,
	opts: { timestamps?: number[] } = {},
): Promise<string[]> {
	const timestamps = opts.timestamps ?? [0, 1.0];
	const frameDir = mkdtempSync(join(tmpdir(), "studio-key-frames-"));
	try {
		return timestamps.map((ts, i) => {
			const png = join(frameDir, `frame-${i}.png`);
			const seek = ts > 0 ? ["-ss", String(ts)] : [];
			try {
				execFileSync(FFMPEG, ["-v", "error", ...seek, "-i", mp4Path, "-frames:v", "1", png], {
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (err) {
				// Surface ffmpeg's stderr diagnostic — the generic execFileSync
				// "Command failed: ..." message leaves the orchestrator with opaque
				// failed attempts. Last few lines only; full ffmpeg stderr is noisy.
				const stderr = (err as { stderr?: Buffer | string }).stderr;
				const stderrText = stderr ? stderr.toString() : String(err);
				throw new Error(
					`ffmpeg key-frame extraction failed for ${mp4Path} @ ${ts}s: ${stderrText.trim().split("\n").slice(-3).join(" | ")}`,
					{ cause: err },
				);
			}
			return phashFromPng(png);
		});
	} finally {
		rmSync(frameDir, { recursive: true, force: true });
	}
}
