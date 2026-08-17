#!/usr/bin/env node
/**
 * Secret-scan guardrail (operator-ready plan Task 0.5 residue).
 *
 * The May-30 leak committed the LIVE gateway X-Api-Key into a markdown file
 * where it sat for 13 days. This scanner greps the doc-ish surfaces
 * (.claude/, docs/, scripts/) for:
 *   - OpenAI-style `sk-…` literals (incl. sk-proj-…)
 *   - long base64url tokens on api-key-context lines (the gateway key shape:
 *     43-char base64url)
 * so the next leak fails a preflight/pre-commit instead of shipping.
 *
 * Read-only; findings are MASKED (never echo the secret). Exit 1 on findings.
 *
 * Usage:
 *   node scripts/zaraa-secret-scan.mjs [--json] [--max-file-bytes=N] [rootDir]
 *   pnpm -s zaraa:secret-scan
 *
 * Pre-commit (operator, optional):
 *   echo 'pnpm -s zaraa:secret-scan' >> "$(git rev-parse --git-dir)/hooks/pre-commit"
 *   chmod +x "$(git rev-parse --git-dir)/hooks/pre-commit"
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_SCAN_DIRS = [".claude", "docs", "scripts"];
const TEXT_EXTENSIONS = new Set([
	".md",
	".mjs",
	".js",
	".ts",
	".tsx",
	".ps1",
	".map",
	".sh",
	".json",
	".jsonl",
	".yml",
	".yaml",
	".plist",
	".txt",
	".env",
	".toml",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{32,}\b/g;
const API_KEY_CONTEXT_RE = /x-api-key|api[_-]?key|apikey|authorization|bearer|\bkey\s*[:=]/i;
const API_KEY_CONTEXT_RADIUS = 512;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const BASE64URL_SECRET_SHAPE_RE = /[-_]/;
/** Pure hex of git-SHA (40) or sha256 (64) length — commit refs and content
 * hashes legitimately appear on "key rotation" doc lines. A hex-only gateway
 * key would slip through this exemption; ours is base64url with -/_. */
const HEX_DIGEST_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const PLACEHOLDER_TOKEN_RE = /…|\.\.\.|xxxx|your|example|placeholder|redacted|paste|<|>/i;
/** `$(jq …)` is the sanctioned key-access form — strip the SPAN (not the
 * whole line: Jun-12 review showed a literal pasted after the jq form was
 * skipped entirely). */
const SANCTIONED_SPAN_RE = /\$\(\s*jq\b[^)]*\)/g;

export function maskSecret(value) {
	return `${value.slice(0, 4)}…[${value.length}ch]`;
}

/** Scan one file's text. Returns findings: {kind, line, masked}. */
export function scanTextForSecrets(text, filePath) {
	const findings = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(SANCTIONED_SPAN_RE, " ");

		for (const match of line.matchAll(OPENAI_KEY_RE)) {
			const token = match[0];
			if (PLACEHOLDER_TOKEN_RE.test(token)) continue;
			findings.push({ kind: "openai-key", file: filePath, line: i + 1, masked: maskSecret(token) });
		}

		for (const match of line.matchAll(LONG_TOKEN_RE)) {
			const token = match[0];
			const tokenIndex = match.index ?? 0;
			const nearbyText = line.slice(
				Math.max(0, tokenIndex - API_KEY_CONTEXT_RADIUS),
				tokenIndex + token.length + API_KEY_CONTEXT_RADIUS,
			);
			// Minified bundles can be one physical line: require local context so an
			// unrelated apiKey label does not flag every long identifier in the file.
			if (!API_KEY_CONTEXT_RE.test(nearbyText)) continue;
			if (token.startsWith("sk-")) continue; // already reported above
			if (HEX_DIGEST_RE.test(token)) continue;
			// Placeholder shape is judged on the TOKEN, not the line —
			// Jun-12 review: any placeholder word in surrounding prose was
			// suppressing real keys on the same line.
			if (PLACEHOLDER_TOKEN_RE.test(token)) continue;
			// Mixed-case requirement: lowercase-only long tokens (task ids,
			// request ids, slugs) were the dominant doc false-positive, and
			// real keys of the gateway shape are mixed-case base64url.
			// Lowercase-only or uppercase-only secrets are a DOCUMENTED
			// blind spot of this tradeoff.
			if (!(/[A-Z]/.test(token) && /[a-z]/.test(token))) continue;
			if (!BASE64URL_SECRET_SHAPE_RE.test(token)) continue;
			findings.push({
				kind: "api-key-context",
				file: filePath,
				line: i + 1,
				masked: maskSecret(token),
			});
		}
	}
	return findings;
}

function* walkFiles(dir, rootDir, scanErrors) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code !== "ENOENT") {
			scanErrors.push({ file: relative(rootDir, dir), reason: "unreadable-dir" });
		}
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(full, rootDir, scanErrors);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function listGitScannableFiles(rootDir, dirs) {
	try {
		const normalizedRootDir = realpathSync(rootDir);
		const topLevel = realpathSync(
			execFileSync("git", ["-C", normalizedRootDir, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		);
		const rootPrefix = relative(topLevel, normalizedRootDir).replaceAll("\\", "/");
		const gitDirs = dirs.map((dir) => {
			if (!rootPrefix) return dir;
			return dir === "." ? rootPrefix : `${rootPrefix}/${dir}`;
		});
		const output = execFileSync(
			"git",
			["-C", topLevel, "ls-files", "-co", "--exclude-standard", "--", ...gitDirs],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return output
			.split(/\r?\n/)
			.filter(Boolean)
			.map((path) => join(topLevel, path));
	} catch {
		return null;
	}
}

function* scannableFiles(rootDir, dirs, scanErrors) {
	const gitFiles = listGitScannableFiles(rootDir, dirs);
	if (gitFiles) {
		yield* gitFiles;
		return;
	}
	for (const dir of dirs) {
		yield* walkFiles(join(rootDir, dir), rootDir, scanErrors);
	}
}

function hasTextExtension(path) {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Scan the configured dirs under rootDir. Read-only. */
export async function runSecretScan({
	rootDir = process.cwd(),
	dirs = DEFAULT_SCAN_DIRS,
	maxFileBytes = MAX_FILE_BYTES,
} = {}) {
	rootDir = realpathSync(rootDir);
	const findings = [];
	const skippedFiles = [];
	const scanErrors = [];
	let scannedFiles = 0;
	for (const file of scannableFiles(rootDir, dirs, scanErrors)) {
		if (!hasTextExtension(file)) continue;
		const relativePath = relative(rootDir, file);
		try {
			const stat = statSync(file);
			const size = stat.size;
			if (size > maxFileBytes) {
				skippedFiles.push({
					file: relativePath,
					bytes: size,
					reason: `larger-than-${maxFileBytes}-bytes`,
				});
				continue;
			}
			// iCloud-evicted ("dataless") file: non-zero size, zero allocated
			// blocks. readFileSync blocks until macOS materialises it, which
			// never returns while sync is wedged — so without this the whole
			// scan hangs instead of reporting, and the guardrail is simply dead.
			// Recorded as a skip, which the pass computation already treats as
			// not-clean: an unread file is unknown, never assumed safe.
			if (size > 0 && stat.blocks === 0) {
				skippedFiles.push({
					file: relativePath,
					bytes: size,
					reason: "dataless-not-materialised",
				});
				continue;
			}
			const text = readFileSync(file, "utf-8");
			scannedFiles++;
			findings.push(...scanTextForSecrets(text, relativePath));
		} catch {
			scanErrors.push({ file: relativePath, reason: "unreadable" });
		}
	}
	if (scannedFiles === 0 && skippedFiles.length === 0 && scanErrors.length === 0) {
		scanErrors.push({ file: dirs.join(","), reason: "no-scannable-files" });
	}
	return {
		mode: "secret_scan",
		generatedAt: new Date().toISOString(),
		pass: findings.length === 0 && skippedFiles.length === 0 && scanErrors.length === 0,
		readOnly: true,
		scannedDirs: dirs,
		scannedFiles,
		maxFileBytes,
		skippedFiles,
		scanErrors,
		findings,
	};
}

const isMain = process.argv[1]?.endsWith("zaraa-secret-scan.mjs");
if (isMain) {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const rootDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();
	// --dirs=a,b scans those subdirs of rootDir instead of the defaults
	// (lets operators scan out-of-tree artifact dirs like ~/zaraa-task-packs:
	// `node scripts/zaraa-secret-scan.mjs --dirs=. ~/zaraa-task-packs`).
	const dirsArg = args.find((a) => a.startsWith("--dirs="));
	const dirs = dirsArg ? dirsArg.slice("--dirs=".length).split(",").filter(Boolean) : undefined;
	const maxFileBytesArg = args.find((a) => a.startsWith("--max-file-bytes="));
	const maxFileBytes = maxFileBytesArg
		? Number.parseInt(maxFileBytesArg.slice("--max-file-bytes=".length), 10)
		: undefined;
	if (maxFileBytesArg && (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0)) {
		console.error("secret-scan FAIL — --max-file-bytes must be a positive integer");
		process.exit(2);
	}
	const result = await runSecretScan({
		rootDir,
		...(dirs ? { dirs } : {}),
		...(maxFileBytes ? { maxFileBytes } : {}),
	});
	if (json) {
		console.log(JSON.stringify(result, null, 2));
	} else if (result.pass) {
		console.log(
			`secret-scan PASS — ${result.scannedFiles} files clean (${result.scannedDirs.join(", ")})`,
		);
	} else {
		console.error(
			`secret-scan FAIL — ${result.findings.length} finding(s), ${result.skippedFiles.length + result.scanErrors.length} unscanned file(s):`,
		);
		for (const f of result.findings) {
			console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.masked}`);
		}
		for (const f of [...result.skippedFiles, ...result.scanErrors]) {
			console.error(`  ${f.file} [${f.reason}]`);
		}
	}
	process.exit(result.pass ? 0 : 1);
}
