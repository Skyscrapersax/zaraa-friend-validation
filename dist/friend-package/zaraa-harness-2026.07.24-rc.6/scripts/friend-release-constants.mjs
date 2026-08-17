import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared paths and friend-release rules.
 * Staging skip basenames align with friend-bundle-audit forbidden basenames where they overlap.
 */

export const FRIEND_PACKAGE_ROOT_REL = "dist/friend-package";
export const FRIEND_PACKAGE_LATEST_REL = `${FRIEND_PACKAGE_ROOT_REL}/latest.json`;
export const FRIEND_RELEASE_MANIFEST_REL = "dist/release/zaraa-friend-release-manifest.json";

function runGit(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
		throw new Error(`Release source Git check failed: ${detail}`);
	}
	return result.stdout.trim();
}

/**
 * iCloud-evicted ("dataless") file: non-zero size, zero allocated blocks.
 * Same detection as scripts/zaraa-secret-scan.mjs. `stat` does not materialise
 * the file, so unlike a read it cannot hang.
 */
export function isDatalessFile(root, relativePath) {
	try {
		const stat = statSync(join(root, relativePath));
		return stat.size > 0 && stat.blocks === 0;
	} catch {
		return false;
	}
}

/** Path out of a `git status --porcelain=v1` line, including the rename target. */
export function porcelainPath(line) {
	const raw = line.slice(3).trim();
	return (raw.split(" -> ").pop() ?? raw).replace(/^"|"$/g, "");
}

/** Fail closed unless source is one stable, clean Git commit. */
export function inspectFriendReleaseSource(root, expectedRevision) {
	const revision = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
	const changes = runGit(root, [
		"status",
		"--porcelain=v1",
		"--untracked-files=normal",
		"--ignore-submodules=none",
	]);
	const checkedRevision = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (revision !== checkedRevision) {
		throw new Error("Release source HEAD moved during verification. Retry from a stable checkout.");
	}
	if (changes) {
		const lines = changes.split("\n").filter(Boolean);
		const listed = lines
			.slice(0, 10)
			.map((line) => `  ${line}`)
			.join("\n");
		// Git reports an iCloud-evicted file as modified because it cannot read
		// it. That is indistinguishable from real uncommitted work in porcelain
		// output, and reading the file to check would hang — which is why the
		// secret scanner skips them too. Still refuse: an unreadable file is
		// unknown, never assumed unchanged. But name the actual cause, or the
		// operator hunts for uncommitted work that does not exist.
		const evicted = lines.filter((line) => isDatalessFile(root, porcelainPath(line)));
		if (evicted.length === lines.length) {
			throw new Error(
				`Refusing friend release: all ${lines.length} file(s) Git reports as changed are iCloud-evicted (dataless) and cannot be read, so Git cannot tell whether they differ. The working tree may in fact be clean. Materialise them, or release from a checkout outside iCloud:\n${listed}`,
			);
		}
		const note = evicted.length
			? `\n\n${evicted.length} of ${lines.length} are iCloud-evicted (dataless), not necessarily edited.`
			: "";
		throw new Error(`Refusing friend release from dirty source:\n${listed}${note}`);
	}
	if (expectedRevision !== undefined && expectedRevision !== revision) {
		throw new Error(
			`Release manifest revision ${expectedRevision || "missing"} does not match source HEAD ${revision}. Regenerate with \`pnpm ship:manifest\`.`,
		);
	}
	return { vcs: "git", revision, clean: true };
}

/** Workspace trees required by staged runtime manifests. */
export const FRIEND_PACKAGE_STAGED_DIRECTORIES = [
	"packages/core",
	"packages/web",
	"packages/cli",
	"packages/gui",
	"packages/shared",
	"packages/sandbox",
	"packages/deerflow-compat",
	"packages/predict",
	"packages/trading-kernel",
	"plugins",
];

export const FRIEND_TRADING_SECRET_KEYS = [
	"apiKey",
	"apiSecret",
	"solanaDexSecretKey",
	"liveModeLock",
];
export const FRIEND_POLYMARKET_SECRET_KEYS = ["apiKey", "apiSecret", "apiPassphrase", "privateKey"];

export function missingFriendPackageLatestMessage(relPath = FRIEND_PACKAGE_LATEST_REL) {
	return `${relPath} is missing. Generate it with \`pnpm ship:manifest\` then \`pnpm ship:package\`. Use \`pnpm ship:candidate\` to build and verify a fresh validation candidate.`;
}

/** Basenames skipped when staging friend package trees (friend-package.mjs). */
export const FRIEND_PACKAGE_STAGING_SKIP_BASENAMES = new Set([
	".DS_Store",
	".git",
	".npmrc",
	".turbo",
	".vite",
	".zaraa",
	":memory:",
	"__fixtures__",
	"coverage",
	"fixtures",
	"install-output.log",
	"node_modules",
	"target",
]);

export function friendPackageStagingShouldSkip(name) {
	if (name === ".env" || name.startsWith(".env.")) {
		return true;
	}
	// SQLite URI filenames are leaked local state; host-built native addons can
	// embed owner source paths and are optional because shipped wrappers fall back.
	if (name.startsWith("file:") || name.endsWith(".node")) {
		return true;
	}
	// Never ship live or pre-mutation home-config snapshots into a friend kit.
	if (
		name === "zaraa.config.json" ||
		name.includes("pre-friend-pin") ||
		name.includes("pre-setup-wizard")
	) {
		return true;
	}
	if (name === "__tests__" || name === "__snapshots__") {
		return true;
	}
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)) {
		return true;
	}
	if (
		/\.(?:jsonl|key|log(?:\.\d+)?|ndjson|p12|pem|pfx|(?:db|sqlite|sqlite3)(?:-(?:journal|shm|wal))?)$/i.test(
			name,
		)
	) {
		return true;
	}
	if (
		/^(?:ab-.+\.json|(?:bench-.+-results|pack-\d+-(?:progress|results(?:-[^.]+)?)|task-test-(?:progress|results))\.json|pack-\d+-scorecard\.md|.+-ids\.json)$/i.test(
			name,
		)
	) {
		return true;
	}
	if (
		/^(?:g400|grow421|optimize-rounds|sip450-smoke|iter50-.+|nemotron-ultra-.+|qwen35-r.+)$/i.test(
			name,
		)
	) {
		return true;
	}
	// Volatile test scratch dirs (e.g. tmp-zara-policy-XXXXXX) are created and
	// deleted by concurrently running suites; walking them races the deleter and
	// can hang the copy, and they must never ship in a friend package.
	if (name.startsWith("tmp-zara-")) {
		return true;
	}
	return FRIEND_PACKAGE_STAGING_SKIP_BASENAMES.has(name);
}

/**
 * Path-aware staging skip for friend kits.
 * relativeDir is the directory containing name, relative to the package/source root
 * (posix separators, no leading ./ , no trailing slash). Example: name=src,
 * relativeDir=packages/core → skip (friend runtime ships packages pkg dist only).
 * Plugins keep their src trees (plugins/... is not under packages/pkg).
 */
export function friendPackageStagingShouldSkipEntry(name, relativeDir = "") {
	if (friendPackageStagingShouldSkip(name)) {
		return true;
	}
	const rel = String(relativeDir || "")
		.replaceAll("\\", "/")
		.replace(/^\.\/?/, "")
		.replace(/\/$/, "");
	// packages/<pkg>/src is not a friend runtime surface.
	if (name === "src" && /^packages\/[^/]+$/.test(rel)) {
		return true;
	}
	return false;
}

/**
 * Forbidden bundle/archive path basenames (friend-bundle-audit.mjs).
 * Keep overlapping entries identical to friendPackageStagingShouldSkip.
 */
export const FRIEND_BUNDLE_FORBIDDEN_BASENAMES = new Set([
	...FRIEND_PACKAGE_STAGING_SKIP_BASENAMES,
	".env",
	".env.local",
	".env.production",
	".env.development",
	"npm-cache",
	"pnpm-store",
	"zaraa.config.json",
]);

export const FRIEND_BUNDLE_FORBIDDEN_PATH_REGEXES = [
	/(^|\/)file:[^/]*(\/|$)/i,
	/(^|\/)[^/]+\.node$/i,
	/(^|\/)tmp-zara-[^/]*(\/|$)/,
	/(^|\/)(:memory:|__fixtures__|__tests__|__snapshots__|fixtures)(\/|$)/,
	// Friend kits must not ship monorepo package source trees (dist-only runtime).
	/(^|\/)packages\/[^/]+\/src(\/|$)/,
	/(^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i,
	/(^|\/)[^/]+\.(?:jsonl|key|log(?:\.\d+)?|ndjson|p12|pem|pfx|(?:db|sqlite|sqlite3)(?:-(?:journal|shm|wal))?)$/i,
	/(^|\/)(?:ab-.+\.json|(?:bench-.+-results|pack-\d+-(?:progress|results(?:-[^.]+)?)|task-test-(?:progress|results))\.json|pack-\d+-scorecard\.md|[^/]+-ids\.json)$/i,
	/(^|\/)(?:g400|grow421|optimize-rounds|sip450-smoke|iter50-[^/]+|nemotron-ultra-[^/]+|qwen35-r[^/]+)(\/|$)/i,
	/(^|\/)\.zaraa(\/|$)/,
	/(^|\/)node_modules(\/|$)/,
	/(^|\/)\.git(\/|$)/,
	/(^|\/)(\.bash_history|\.zsh_history|\.ssh|cookies|local storage)(\/|$)/i,
	/(^|\/)(install-output\.log|zaraa\.config\.json|\.npmrc|\.env(?:\.[^/]*)?)(\/|$)/i,
	// Pre-mutation config backups contain live credentials; never ship them.
	/(^|\/)[^/]*pre-friend-pin[^/]*(\/|$)/i,
	/(^|\/)[^/]*pre-setup-wizard[^/]*(\/|$)/i,
];
