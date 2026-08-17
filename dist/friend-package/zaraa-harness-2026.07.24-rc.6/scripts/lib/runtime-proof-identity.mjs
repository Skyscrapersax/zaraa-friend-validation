import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const DAEMON_START_TOLERANCE_MS = 5_000;
const DAEMON_START_DRIFT_MS = 10_000;

function defaultInputs(root) {
	const inputs = [
		{ path: "package.json", required: true },
		{ path: "pnpm-lock.yaml", required: true },
		{ path: "scripts/zaraa-daemon.mjs", required: true },
		{ path: "scripts/zaraa-daemon-lib.mjs", required: true },
		{ path: "scripts/lib/restart-intent.mjs", required: true },
		{ path: "scripts/zaraa-24h-proof.mjs", required: true },
		{ path: "scripts/lib/runtime-proof-identity.mjs", required: true },
		{ path: "packages/cli/package.json", required: true },
		{ path: "packages/cli/dist", required: true },
		{ path: "packages/core/package.json", required: true },
		{ path: "packages/core/dist", required: true },
		{ path: "packages/shared/package.json", required: true },
		{ path: "packages/shared/dist", required: true },
		{ path: "packages/sandbox/package.json", required: true },
		{ path: "packages/sandbox/dist", required: true },
		{ path: "packages/web/package.json", required: true },
		{ path: "packages/web/dist", required: true },
		{ path: "installers", required: false },
		{ path: "FRIEND_INSTALL.md", required: false },
		{ path: "START_HERE.html", required: false },
		{ path: ".zaraa-installed-release.json", required: false },
	];
	const pluginsDir = resolve(root, "plugins");
	if (!existsSync(pluginsDir)) return inputs;
	for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		inputs.push({ path: `plugins/${entry.name}/package.json`, required: false });
		inputs.push({ path: `plugins/${entry.name}/dist`, required: false });
	}
	return inputs;
}

function collectDirectoryFiles(path, files) {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = resolve(path, entry.name);
		if (entry.isDirectory()) collectDirectoryFiles(child, files);
		else if (
			entry.isFile() &&
			entry.name !== ".DS_Store" &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".map")
		) {
			files.push(child);
		}
	}
}

export function createFileRevision(path) {
	const stats = statSync(path);
	if (!stats.isFile()) throw new Error(`runtime proof input is not a file: ${path}`);
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	return {
		revision: `sha256:${sha256}`,
		sha256,
		size: stats.size,
		mtime: new Date(stats.mtimeMs).toISOString(),
	};
}

export function attachRuntimeConfigRevision(identity, configPath) {
	return {
		...identity,
		configRevision: { ...createFileRevision(configPath), path: resolve(configPath) },
	};
}

export function createRuntimeIdentity({ root = process.cwd(), inputs = defaultInputs(root) } = {}) {
	const files = [];
	for (const input of inputs) {
		const descriptor = typeof input === "string" ? { path: input, required: true } : input;
		const path = resolve(root, descriptor.path);
		if (!existsSync(path)) {
			if (descriptor.required) throw new Error(`missing runtime proof input: ${descriptor.path}`);
			continue;
		}
		if (statSync(path).isDirectory()) collectDirectoryFiles(path, files);
		else files.push(path);
	}
	files.sort((a, b) => a.localeCompare(b));
	if (files.length === 0) throw new Error("runtime proof identity has no files");

	const hash = createHash("sha256");
	let newestMtimeMs = 0;
	for (const path of files) {
		const normalized = relative(root, path).split(sep).join("/");
		hash.update(normalized);
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
		newestMtimeMs = Math.max(newestMtimeMs, statSync(path).mtimeMs);
	}

	return {
		schemaVersion: 1,
		sha256: hash.digest("hex"),
		platform: process.platform,
		architecture: process.arch,
		nodeAbi: process.versions.modules,
		fileCount: files.length,
		newestMtime: new Date(newestMtimeMs).toISOString(),
	};
}

export function bindRuntimeIdentity(identity, { observedAt, uptimeSeconds }) {
	const observedMs = Date.parse(observedAt);
	const uptime = Number(uptimeSeconds);
	const daemonStartedAt =
		Number.isFinite(observedMs) && Number.isFinite(uptime) && uptime >= 0
			? new Date(observedMs - uptime * 1_000).toISOString()
			: null;
	return { ...identity, daemonStartedAt };
}

export function runtimeIdentityBreakReasons(identity, baseline) {
	if (!identity?.sha256 || !identity?.daemonStartedAt || !identity?.newestMtime) {
		return ["runtime identity missing"];
	}
	if (!baseline?.sha256 || !baseline?.daemonStartedAt || !baseline?.newestMtime) {
		return ["runtime identity baseline missing"];
	}

	const reasons = [];
	if (identity.sha256 !== baseline.sha256) reasons.push("runtime artifacts changed");
	if (
		identity.platform !== baseline.platform ||
		identity.architecture !== baseline.architecture ||
		identity.nodeAbi !== baseline.nodeAbi
	) {
		reasons.push("runtime platform changed");
	}
	if (!identity.configRevision?.revision) reasons.push("runtime config revision missing");
	else if (!baseline.configRevision?.revision) reasons.push("runtime config baseline missing");
	else if (identity.configRevision.revision !== baseline.configRevision.revision) {
		reasons.push("runtime config changed");
	}
	if (!identity.configRevision?.path) reasons.push("runtime config path missing");
	else if (!baseline.configRevision?.path) reasons.push("runtime config baseline path missing");
	else if (identity.configRevision.path !== baseline.configRevision.path) {
		reasons.push("runtime config path changed");
	}
	const baselineStartMs = Date.parse(baseline.daemonStartedAt);
	const baselineBuildMs = Date.parse(baseline.newestMtime);
	const baselineConfigMs = Date.parse(baseline.configRevision?.mtime);
	const daemonStartMs = Date.parse(identity.daemonStartedAt);
	if (!Number.isFinite(baselineStartMs) || !Number.isFinite(baselineBuildMs)) {
		reasons.push("runtime identity timestamps invalid");
	} else if (baselineStartMs + DAEMON_START_TOLERANCE_MS < baselineBuildMs) {
		reasons.push("daemon predates runtime build");
	}
	if (!Number.isFinite(baselineConfigMs)) reasons.push("runtime config timestamp invalid");
	else if (
		Number.isFinite(baselineStartMs) &&
		baselineStartMs + DAEMON_START_TOLERANCE_MS < baselineConfigMs
	) {
		reasons.push("daemon predates runtime config");
	}
	if (!Number.isFinite(daemonStartMs)) reasons.push("daemon start timestamp invalid");
	else if (
		Number.isFinite(baselineStartMs) &&
		Math.abs(daemonStartMs - baselineStartMs) > DAEMON_START_DRIFT_MS
	) {
		reasons.push("daemon runtime changed");
	}
	return reasons;
}
