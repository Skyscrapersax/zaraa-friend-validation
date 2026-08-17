#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	summarize24hProof,
	summarizeFriendPackageVerification,
} from "./friend-build-preflight-policy.mjs";
import { verifyFriendPackage } from "./friend-package-verify.mjs";
import {
	attachRuntimeConfigRevision,
	createRuntimeIdentity,
} from "./lib/runtime-proof-identity.mjs";

const root = process.cwd();
const requireGateway = process.argv.includes("--require-gateway");
const requirePackage = process.argv.includes("--require-package");
const require24hProof = process.argv.includes("--require-24h-proof");
const gatewayUrl = process.env.ZARAA_GATEWAY_URL ?? "http://localhost:3927";
const checks = [];

function record(status, label, detail = "") {
	checks.push({ status, label, detail });
}

function pass(label, detail) {
	record("PASS", label, detail);
}

function warn(label, detail) {
	record("WARN", label, detail);
}

function fail(label, detail) {
	record("FAIL", label, detail);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { __error: error instanceof Error ? error.message : String(error) };
	}
}

function checkNodeVersion() {
	const major = Number(process.versions.node.split(".")[0]);
	if (Number.isNaN(major) || major < 22) {
		fail("Node runtime", `Expected Node >=22.0.0, found ${process.version}.`);
		return;
	}

	pass("Node runtime", `${process.version} satisfies the desktop harness requirement.`);
}

function checkPackageManager() {
	const pkgPath = join(root, "package.json");
	const pkg = readJson(pkgPath);

	if (pkg.__error) {
		fail("Package manifest", `Could not read package.json: ${pkg.__error}`);
		return;
	}

	if (!String(pkg.packageManager ?? "").startsWith("pnpm@")) {
		fail("Package manager", "package.json should pin pnpm via packageManager.");
		return;
	}

	pass("Package manager", pkg.packageManager);
}

function checkBuildArtifacts() {
	const webIndex = join(root, "packages", "web", "dist", "index.html");
	const coreEntry = join(root, "packages", "core", "dist", "index.js");

	if (existsSync(webIndex)) {
		pass("Web build artifact", "packages/web/dist/index.html exists.");
	} else {
		fail("Web build artifact", "Run `pnpm --filter @zaraa/web build` before packaging.");
	}

	if (existsSync(coreEntry)) {
		pass("Core build artifact", "packages/core/dist/index.js exists.");
	} else {
		fail("Core build artifact", "Run `pnpm --filter @zaraa/core build` before packaging.");
	}
}

/** Same override surface as friend-kit-update / friend-config-safety (tests + non-default homes). */
function resolveFriendHomeConfigPath() {
	const rawRuntimeHome = process.env.ZARAA_HOME_DIR;
	let runtimeHome = homedir();
	if (rawRuntimeHome !== undefined) {
		const value = rawRuntimeHome.trim();
		if (!value || !isAbsolute(value)) {
			throw new Error("ZARAA_HOME_DIR must be a non-empty absolute path");
		}
		runtimeHome = resolve(value);
		if (dirname(runtimeHome) === runtimeHome) {
			throw new Error("ZARAA_HOME_DIR cannot be a filesystem root");
		}
	}
	const fromEnv = process.env.ZARAA_CONFIG_PATH;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return fromEnv.trim();
	}
	return join(runtimeHome, ".zaraa", "zaraa.config.json");
}

function checkLocalGatewayConfig() {
	const configPath = resolveFriendHomeConfigPath();
	const displayPath =
		configPath === join(homedir(), ".zaraa", "zaraa.config.json")
			? "~/.zaraa/zaraa.config.json"
			: configPath;

	if (!existsSync(configPath)) {
		fail("Local gateway config", `${displayPath} is missing.`);
		return;
	}

	const config = readJson(configPath);
	if (config.__error) {
		fail("Local gateway config", `Could not parse config JSON: ${config.__error}`);
		return;
	}

	const apiKey = config.gateway?.auth?.apiKey ?? config.apiKey;
	if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
		fail("Gateway API key", "Config exists, but no gateway auth key was found.");
		return;
	}

	pass("Gateway API key", "Present in local config. Secret value intentionally not printed.");
}

function checkReleaseManifest() {
	const manifestPath = join(root, "dist", "release", "zaraa-friend-release-manifest.json");
	if (!existsSync(manifestPath)) {
		warn("Release manifest", "Not generated yet. Run `pnpm ship:manifest` before sharing a build.");
		return;
	}

	const manifest = readJson(manifestPath);
	if (manifest.__error) {
		fail("Release manifest", `Could not parse manifest JSON: ${manifest.__error}`);
		return;
	}

	if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
		fail("Release manifest", "Manifest exists but does not list packaged artifacts.");
		return;
	}

	pass(
		"Release manifest",
		`${manifest.version ?? "unknown version"} on ${manifest.channel ?? "unknown channel"} with ${
			manifest.artifacts.length
		} artifact(s).`,
	);
}

function checkFriendPackage() {
	const latestPath = join(root, "dist", "friend-package", "latest.json");
	if (!existsSync(latestPath)) {
		warn(
			"Friend package",
			"No staged friend package found yet. Run `pnpm ship:package` before sharing.",
		);
		return;
	}

	const result = verifyFriendPackage({ root, writeReport: true, syncPublic: true });
	for (const check of result.checks) {
		if (check.status === "FAIL") {
			if (requirePackage) {
				fail(`Package ${check.label}`, check.detail);
			} else {
				warn(`Package ${check.label}`, `${check.detail} Use --require-package to make this fatal.`);
			}
		} else if (check.status === "WARN") {
			warn(`Package ${check.label}`, check.detail);
		}
	}

	const summary = summarizeFriendPackageVerification(result, { requirePackage });
	if (summary.status === "FAIL") {
		fail("Friend package verification", summary.detail);
	} else if (summary.status === "WARN") {
		warn("Friend package verification", summary.detail);
	} else {
		pass("Friend package verification", summary.detail);
	}
}

function check24hProof() {
	if (!require24hProof) return;

	// Proof artifacts live beside the home config directory (…/data), not always under ~/.zaraa.
	const configPath = resolveFriendHomeConfigPath();
	const homeDirForProof = join(configPath, "..");
	const dataDir = join(homeDirForProof, "data");
	const latest = existsSync(dataDir)
		? readdirSync(dataDir)
				.filter((name) => /^zaraa-24h-proof-\d{8}T\d{6}Z\.summary\.json$/.test(name))
				.sort()
				.at(-1)
		: null;
	if (!latest) {
		fail("24h runtime proof", `No 24h proof summary found in ${dataDir}.`);
		return;
	}

	let currentRuntimeIdentity;
	try {
		currentRuntimeIdentity = attachRuntimeConfigRevision(
			createRuntimeIdentity({ root }),
			configPath,
		);
	} catch (error) {
		fail(
			"24h runtime proof",
			`Current runtime identity unavailable: ${error instanceof Error ? error.message : String(error)}.`,
		);
		return;
	}
	const result = summarize24hProof(readJson(join(dataDir, latest)), latest, {
		currentRuntimeIdentity,
	});
	if (result.status === "PASS") pass("24h runtime proof", result.detail);
	else fail("24h runtime proof", result.detail);
}

function getFirstAssetPathFromHtml(html) {
	const match =
		html.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/) ??
		html.match(/<link[^>]+href="([^"]*\/assets\/[^"]+\.css)"/);

	return match?.[1] ?? null;
}

function getFirstBuiltAssetPath() {
	const webIndex = join(root, "packages", "web", "dist", "index.html");
	if (!existsSync(webIndex)) {
		return null;
	}

	return getFirstAssetPathFromHtml(readFileSync(webIndex, "utf8"));
}

async function fetchWithTimeout(url, timeoutMs = 2500) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function checkLiveGateway() {
	let healthResponse;
	try {
		healthResponse = await fetchWithTimeout(new URL("/health", gatewayUrl));
	} catch (error) {
		const detail = `Gateway not reachable at ${gatewayUrl}: ${
			error instanceof Error ? error.message : String(error)
		}`;
		if (requireGateway) {
			fail("Live gateway health", detail);
		} else {
			warn("Live gateway health", `${detail}. Use --require-gateway to make this fatal.`);
		}
		return;
	}

	if (!healthResponse.ok) {
		const detail = `Expected /health 2xx at ${gatewayUrl}, got ${healthResponse.status}.`;
		if (requireGateway) {
			fail("Live gateway health", detail);
		} else {
			warn("Live gateway health", detail);
		}
		return;
	}

	pass("Live gateway health", `${gatewayUrl}/health returned ${healthResponse.status}.`);

	const shellResponse = await fetchWithTimeout(new URL("/brain-map", gatewayUrl));
	const shellCache = shellResponse.headers.get("cache-control") ?? "";
	const shellHtml = shellResponse.ok ? await shellResponse.text() : "";
	if (shellResponse.ok && shellCache.includes("no-store")) {
		pass("Dashboard shell cache", `/brain-map uses Cache-Control: ${shellCache}`);
	} else {
		fail(
			"Dashboard shell cache",
			`Expected /brain-map to be no-store, got status ${shellResponse.status} and Cache-Control: ${
				shellCache || "(missing)"
			}.`,
		);
	}

	const assetPath = getFirstAssetPathFromHtml(shellHtml) ?? getFirstBuiltAssetPath();
	if (!assetPath) {
		warn(
			"Immutable asset cache",
			"No built JS/CSS asset was found in the live dashboard shell or packages/web/dist/index.html.",
		);
		return;
	}

	const assetResponse = await fetchWithTimeout(new URL(assetPath, gatewayUrl));
	const assetCache = assetResponse.headers.get("cache-control") ?? "";
	if (assetResponse.ok && assetCache.includes("immutable")) {
		pass("Immutable asset cache", `${assetPath} uses Cache-Control: ${assetCache}`);
		return;
	}

	fail(
		"Immutable asset cache",
		`Expected ${assetPath} to be immutable, got status ${assetResponse.status} and Cache-Control: ${
			assetCache || "(missing)"
		}.`,
	);
}

function printSummary() {
	console.log("\nZaraa friend-build preflight\n");
	for (const check of checks) {
		const line = `${check.status.padEnd(4)}  ${check.label}`;
		console.log(check.detail ? `${line} - ${check.detail}` : line);
	}

	const failures = checks.filter((check) => check.status === "FAIL");
	const warnings = checks.filter((check) => check.status === "WARN");

	console.log("");
	if (failures.length > 0) {
		console.log(
			`Preflight failed with ${failures.length} blocker(s) and ${warnings.length} warning(s).`,
		);
		process.exitCode = 1;
		return;
	}

	if (warnings.length > 0) {
		console.log(`Preflight passed with ${warnings.length} warning(s).`);
		return;
	}

	console.log("Preflight passed. Zaraa is ready for the next packaging slice.");
}

checkNodeVersion();
checkPackageManager();
checkBuildArtifacts();
checkLocalGatewayConfig();
checkReleaseManifest();
checkFriendPackage();
check24hProof();
await checkLiveGateway();
printSummary();
