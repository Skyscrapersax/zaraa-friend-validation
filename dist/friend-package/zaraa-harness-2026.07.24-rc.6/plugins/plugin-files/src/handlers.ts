import type { FsSandbox } from "@zaraa/sandbox";

export interface FileToolHandlers {
	file_read(args: { path: string; numbered?: boolean }): Promise<string>;
	file_write(args: { path: string; content: string }): Promise<string>;
	file_list(args: { path: string }): Promise<string>;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;

/**
 * Heuristic binary detector on utf8-decoded content: NUL bytes, replacement
 * characters (invalid utf8 sequences), and C0 control characters outside
 * whitespace. Raw binary in a tool result is useless to the model and poisons
 * synthesis — a PNG read this way produced answers describing "encrypted
 * binary fragments" instead of using the vision tool's actual analysis.
 */
function isBinaryContent(content: string): boolean {
	const probe = content.slice(0, 2048);
	if (probe.length === 0) return false;
	let suspicious = 0;
	for (let i = 0; i < probe.length; i++) {
		const c = probe.charCodeAt(i);
		if (c < 9 || c === 0xfffd || (c > 13 && c < 32)) suspicious++;
	}
	return suspicious / probe.length > 0.05;
}

export function createFileHandlers(sandbox: FsSandbox): FileToolHandlers {
	return {
		async file_read({ path, numbered }) {
			const content = await sandbox.read(path);
			if (isBinaryContent(content)) {
				const visionHint = IMAGE_EXT_RE.test(path)
					? " This is an image — use vision_analyze to inspect its content."
					: "";
				return `[binary file: ${path} (${content.length} bytes decoded) — content is not readable as text.${visionHint}]`;
			}
			if (numbered) {
				// Opt-in line numbering for path:line citation work — without it,
				// models re-read files repeatedly trying to derive line numbers
				// (2026-06-05 optimization rounds: grounded-code-reading turns
				// burned their whole iteration budget on unnumbered re-reads).
				return content
					.split("\n")
					.map((line, i) => `${i + 1}: ${line}`)
					.join("\n");
			}
			return content;
		},
		async file_write({ path, content }) {
			await sandbox.write(path, content);
			return `Written ${content.length} bytes to ${path}`;
		},
		async file_list({ path }) {
			const entries = await sandbox.list(path);
			return entries.join("\n");
		},
	};
}
