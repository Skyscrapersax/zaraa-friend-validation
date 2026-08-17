import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SceneSpec } from "../scene/scene-spec.js";

/**
 * Exporter — writes a gate-passed render into an export-ready directory:
 * `{exportRoot}/{YYYY-MM-DD}/{slug}/` containing the MP4s (copied in), the
 * post caption (caption.txt) and the full scene spec (spec.json) for the
 * learning log / manual re-render. Pure filesystem; no LLM, no network.
 */

/** Lowercase, alnum+dash, no leading/trailing dashes, at most 40 chars. */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

/**
 * Export a render. Returns the created directory:
 * `{exportRoot}/{YYYY-MM-DD}/{first-message-line-slug}-{seed}/`.
 */
export function exportRender(
	spec: SceneSpec,
	caption: string,
	mp4Files: string[],
	exportRoot: string,
): string {
	const date = new Date().toISOString().slice(0, 10);
	const slug = `${slugify(spec.message.lines[0])}-${spec.seed}`;
	const dir = join(exportRoot, date, slug);
	mkdirSync(dir, { recursive: true });
	for (const file of mp4Files) {
		copyFileSync(file, join(dir, basename(file)));
	}
	writeFileSync(join(dir, "caption.txt"), caption);
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
	return dir;
}
