#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
	restoreFriendConfigFromBackup,
	stripUtf8Bom,
} from "./friend-config-safety.mjs";

const args = process.argv.slice(2);

function argValue(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const sourceDir = resolve(argValue("--source", process.cwd()));
const targetDir = resolve(argValue("--target", join(homedir(), "zaraa")));
const skipInstall = args.includes("--skip-install");
const skipPreflight = args.includes("--skip-preflight");
const allowOverwrite = args.includes("--allow-overwrite");
const manifestPath = join(sourceDir, "dist", "release", "zaraa-friend-release-manifest.json");

/** Sibling of target: new kit is built here before promotion. */
const STAGING_SUFFIX = ".zaraa-update-staging";
/** Sibling of target: previous successful install kept for one-version rollback. */
const PREVIOUS_SUFFIX = ".zaraa-previous";
const INSTALLED_RELEASE_MARKER = ".zaraa-installed-release.json";

function fail(message) {
	console.error(`ERR  ${message}`);
	process.exit(1);
}

function ok(message) {
	console.log(`OK   ${message}`);
}

function resolveHomeConfigPath() {
	const explicit = argValue("--home-config", null);
	if (explicit) return resolve(explicit);
	if ("ZARAA_CONFIG_PATH" in process.env) {
		const configPath = process.env.ZARAA_CONFIG_PATH?.trim();
		if (!configPath) fail("ZARAA_CONFIG_PATH must be a non-empty path");
		return resolve(configPath);
	}
	if (!("ZARAA_HOME_DIR" in process.env)) return join(homedir(), ".zaraa", "zaraa.config.json");
	const rawHome = process.env.ZARAA_HOME_DIR?.trim();
	if (!rawHome || !isAbsolute(rawHome)) fail("ZARAA_HOME_DIR must be a non-empty absolute path");
	const runtimeHome = resolve(rawHome);
	if (dirname(runtimeHome) === runtimeHome) fail("ZARAA_HOME_DIR cannot be a filesystem root");
	return join(runtimeHome, ".zaraa", "zaraa.config.json");
}

function step(message) {
	console.log("");
	console.log(`-- ${message} --`);
}

/**
 * @typedef {{ homeConfig: string, backupPath: string | null, restoreCommand: string | null, changed: boolean }} PinCompensation
 */

/**
 * Re-pin friend safety rails on the home config when present.
 * Update never overwrites ~/.zaraa, but a prior live-risk or noisy config must not
 * survive a kit update. Call *before* live swap / installed-release marker so a pin
 * failure leaves the previous install claim intact (and staging cleaned by caller).
 *
 * When pin mutates home config, returns backupPath so callers can restore if a later
 * swap/marker step fails (cross-resource compensation: install tree + home config).
 *
 * Kit dir should be the staged tree (or same-dir target) so the new pin script is used.
 * Override path via --home-config or ZARAA_CONFIG_PATH (tests / non-default homes).
 * @param {string} kitDir
 * @returns {PinCompensation | null}
 */
function pinFriendHomeConfig(kitDir) {
	const homeConfig = resolveHomeConfigPath();
	try {
		lstatSync(homeConfig);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const safetyScript = join(kitDir, "scripts", "friend-config-safety.mjs");
	if (!existsSync(safetyScript)) {
		// Friend-beta: a kit without the pin script cannot prove paper-only after update.
		throw new Error(
			`friend-config-safety.mjs missing at ${safetyScript}. ` +
				"Refusing to complete update without money/idle rail pin capability.",
		);
	}
	step("Pinning friend paper-only + idle safety rails");
	// Write compensation metadata beside the home config (mode 0600 via pin script),
	// never under world-writable tmpdir — backup paths must not land in /tmp.
	const resultJson = join(
		dirname(homeConfig),
		`.zaraa-friend-pin-result.${process.pid}.${randomBytes(4).toString("hex")}.json`,
	);
	try {
		mkdirSync(dirname(homeConfig), { recursive: true, mode: 0o700 });
		try {
			chmodSync(dirname(homeConfig), 0o700);
		} catch {
			// best-effort
		}
		const pin = spawnSync(
			process.execPath,
			[safetyScript, "--config", homeConfig, "--result-json", resultJson],
			{ stdio: "inherit" },
		);
		if (pin.status !== 0) {
			// Friend-beta: do not claim a successful update if money rails could not be pinned.
			throw new Error(
				`friend-config-safety pin failed for ${homeConfig}. ` +
					"Fix the config file (must be valid JSON) and re-run the updater, or run: " +
					`node ${safetyScript} --config ${homeConfig}`,
			);
		}
		// Fail closed: without machine-readable pin result we cannot compensate home
		// config if a later swap fails (cross-resource integrity).
		if (!existsSync(resultJson)) {
			throw new Error(
				`friend-config-safety pin produced no result JSON at ${resultJson}. ` +
					"Refusing to continue update without pin compensation metadata.",
			);
		}
		let parsed;
		try {
			// BOM-tolerant: same Windows UTF-8 writer class as home config (defensive).
			parsed = JSON.parse(stripUtf8Bom(readFileSync(resultJson, "utf8")));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`friend-config-safety pin result JSON unreadable at ${resultJson}: ${detail}. ` +
					"Refusing to continue update without pin compensation metadata.",
			);
		}
		/** @type {PinCompensation} */
		const compensation = {
			homeConfig,
			backupPath: null,
			restoreCommand: null,
			changed: parsed.changed === true,
		};
		if (typeof parsed.backupPath === "string" && parsed.backupPath.length > 0) {
			compensation.backupPath = parsed.backupPath;
		}
		if (typeof parsed.restoreCommand === "string" && parsed.restoreCommand.length > 0) {
			compensation.restoreCommand = parsed.restoreCommand;
		}
		// If pin reports a mutation, backup path is required for cross-resource restore.
		if (compensation.changed && !compensation.backupPath) {
			throw new Error(
				`friend-config-safety pin changed ${homeConfig} but returned no backupPath. ` +
					"Refusing to continue update without a restore path for home config.",
			);
		}
		return compensation;
	} finally {
		try {
			if (existsSync(resultJson)) unlinkSync(resultJson);
		} catch {
			// ignore
		}
	}
}

/**
 * If pin mutated home config and a later update step fails, restore pre-pin backup.
 * Install tree rollback is separate (previous sibling); this is the home-config half.
 * Uses restoreFriendConfigFromBackup (symlink backup refuse + config path control).
 * @param {PinCompensation | null} compensation
 * @param {string} reason
 */
function compensateHomeConfigAfterFailedUpdate(compensation, reason) {
	if (!compensation?.backupPath || !compensation.homeConfig) {
		return;
	}
	if (!existsSync(compensation.backupPath)) {
		console.error(
			`ERR  Update failed after pin (${reason}); pre-pin backup missing at ${compensation.backupPath}. ` +
				"Home config may remain paper-pinned; restore manually if needed.",
		);
		return;
	}
	try {
		restoreFriendConfigFromBackup(compensation.backupPath, compensation.homeConfig);
		ok(
			`Restored home config from pre-pin backup after update failure (${reason}). ` +
				`Backup kept at ${compensation.backupPath}`,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(
			`ERR  Failed to restore home config after update failure (${reason}): ${detail}. ` +
				(compensation.restoreCommand
					? `Run after materializing a regular file: ${compensation.restoreCommand}`
					: `Backup: ${compensation.backupPath}`),
		);
	}
}

/**
 * Test-only failure injection (never set in friend installs).
 * ZARAA_FRIEND_KIT_UPDATE_INJECT=after-pin | after-swap
 */
function maybeInjectUpdateFailure(phase) {
	if (process.env.ZARAA_FRIEND_KIT_UPDATE_INJECT === phase) {
		throw new Error(`Injected friend-kit update failure at ${phase} (test only)`);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isInside(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	// win32 path.relative() returns an absolute path across drives
	// ("C:\\Temp\\...") — that is not containment. Rejecting only a
	// POSIX "/" prefix made official Windows CI refuse D:\\kit →
	// C:\\Users\\...\\Temp\\install\\zaraa ("target cannot live inside
	// the source kit").
	if (rel === "") return true;
	if (isAbsolute(rel) || rel.startsWith("..")) return false;
	return true;
}

function shouldSkipSource(name, sourcePath) {
	if (
		new Set([
			".DS_Store",
			".git",
			".turbo",
			".vite",
			"coverage",
			"node_modules",
		]).has(name)
	) {
		return true;
	}

	const rel = relative(sourceDir, sourcePath);
	return rel === join("dist", "friend-package") || rel.startsWith(`${join("dist", "friend-package")}/`);
}

function shouldPreserveTarget(name) {
	return new Set(["node_modules", ".git", ".turbo", ".zaraa-local"]).has(name);
}

/**
 * @param {string} source
 * @param {string} target
 * @param {{ applySourceSkips?: boolean }} [options]
 *   applySourceSkips (default true): skip kit-only junk when copying from the release source.
 *   Set false when carrying preserved local dirs (node_modules/.git/.zaraa-local) into staging.
 */
function copyRecursive(source, target, options = {}) {
	const applySourceSkips = options.applySourceSkips !== false;
	// lstat: do not follow links. Kit sources must not smuggle owner secrets via symlink.
	const stats = lstatSync(source);
	if (stats.isSymbolicLink()) {
		if (applySourceSkips) {
			// Release source trees are plain files; a symlink is an unexpected leak path.
			throw new Error(`Refusing to copy symlink from friend kit source: ${source}`);
		}
		// Preserved local dirs (node_modules) use symlinks; recreate the link, do not resolve content.
		mkdirSync(dirname(target), { recursive: true });
		if (existsSync(target)) {
			rmSync(target, { recursive: true, force: true });
		}
		symlinkSync(readlinkSync(source), target);
		return;
	}
	if (stats.isDirectory()) {
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source)) {
			const sourcePath = join(source, entry);
			if (applySourceSkips && shouldSkipSource(entry, sourcePath)) {
				continue;
			}
			copyRecursive(sourcePath, join(target, entry), options);
		}
		return;
	}
	if (!stats.isFile()) {
		return;
	}

	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(source, target);
}

function removePath(path) {
	if (existsSync(path)) {
		rmSync(path, { recursive: true, force: true });
	}
}

/**
 * Assert target is safe to replace (empty, has prior install marker, or --allow-overwrite).
 * Does not delete anything — live install is only moved after staging succeeds.
 */
function assertTargetReplaceable(dir) {
	if (!existsSync(dir)) {
		return;
	}
	const entries = readdirSync(dir);
	const hasMarker = entries.includes(INSTALLED_RELEASE_MARKER);
	const meaningfulEntries = entries.filter((entry) => !shouldPreserveTarget(entry));

	if (meaningfulEntries.length > 0 && !hasMarker && !allowOverwrite) {
		fail(
			`Refusing to replace ${dir}: no ${INSTALLED_RELEASE_MARKER} present and directory is non-empty. ` +
				"Point --target at an empty directory or a previously installed Zaraa kit, or pass --allow-overwrite to force.",
		);
	}
}

/**
 * Copy local-only preserved entries from a prior install into staging so friend state
 * (and optional git/turbo/node_modules) survives the atomic swap.
 */
function carryPreservedIntoStaging(fromDir, stagingDir) {
	if (!existsSync(fromDir)) {
		return;
	}
	for (const entry of readdirSync(fromDir)) {
		if (!shouldPreserveTarget(entry)) {
			continue;
		}
		const fromPath = join(fromDir, entry);
		const toPath = join(stagingDir, entry);
		if (existsSync(toPath)) {
			continue;
		}
		// Do not apply kit source skips — these names are intentionally preserved.
		copyRecursive(fromPath, toPath, { applySourceSkips: false });
		ok(`Carried preserved ${entry} into staging`);
	}
}

function run(command, commandArgs, cwd) {
	const result = spawnSync(command, commandArgs, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		throw new Error(`${command} ${commandArgs.join(" ")} failed.`);
	}
}

/**
 * Promote staging → live only after staging install+preflight succeed.
 * If the second rename fails after the first, restore previous → target.
 */
function atomicSwapStagingToTarget(staging, target, previous) {
	removePath(previous);
	if (existsSync(target)) {
		renameSync(target, previous);
	}
	try {
		renameSync(staging, target);
	} catch (error) {
		if (!existsSync(target) && existsSync(previous)) {
			try {
				renameSync(previous, target);
			} catch {
				// Fall through with original error + recovery hint.
			}
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Atomic swap failed (${detail}). ` +
				(existsSync(target)
					? "Live install was restored from previous."
					: `Manual recovery: if ${previous} exists, move it back to ${target}.`),
		);
	}
}

/**
 * Write installed-release marker with exclusive temp + rename.
 * Never writeFileSync through a pre-planted marker symlink (integrity / out-of-tree write).
 */
function writeInstalledMarker(dir, manifest, source) {
	const markerPath = join(dir, INSTALLED_RELEASE_MARKER);
	// lstat always: dangling symlink must not be treated as missing.
	try {
		const st = lstatSync(markerPath);
		if (st.isSymbolicLink()) {
			throw new Error(
				`Refusing to write installed-release marker through symlink: ${markerPath}`,
			);
		}
		if (typeof st.nlink === "number" && st.nlink > 1) {
			throw new Error(
				`Refusing to write installed-release marker with hardlink count ${st.nlink}: ${markerPath}`,
			);
		}
		if (!st.isFile()) {
			throw new Error(
				`Refusing to write installed-release marker over non-file: ${markerPath}`,
			);
		}
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	const body = `${JSON.stringify(
		{
			version: manifest.version ?? null,
			channel: manifest.channel ?? null,
			installedAt: new Date().toISOString(),
			source,
			artifactCount: Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0,
		},
		null,
		2,
	)}\n`;
	const tmp = join(dir, `.${INSTALLED_RELEASE_MARKER}.tmp.${process.pid}.${Date.now()}`);
	const fd = openSync(
		tmp,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
		0o600,
	);
	try {
		writeFileSync(fd, body);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, markerPath);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}

if (!existsSync(manifestPath)) {
	fail(`Missing release manifest at ${manifestPath}. Run this from an unpacked Zaraa friend kit.`);
}

if (sourceDir !== targetDir) {
	if (isInside(sourceDir, targetDir)) {
		fail("Target directory cannot live inside the source kit; that would copy the package into itself.");
	}
	// Inverse overlap: kit unpacked under --target would be deleted if we cleaned target first.
	if (isInside(targetDir, sourceDir)) {
		fail(
			"Source kit cannot live inside the target directory; cleaning or swapping the target would delete the source before copy.",
		);
	}
}

const manifest = readJson(manifestPath);
const stagingDir = `${targetDir}${STAGING_SUFFIX}`;
const previousDir = `${targetDir}${PREVIOUS_SUFFIX}`;

console.log("");
console.log("Zaraa friend-kit updater");
console.log(`Source: ${sourceDir}`);
console.log(`Target: ${targetDir}`);
console.log(`Version: ${manifest.version ?? "unknown"}`);

if (sourceDir !== targetDir) {
	// Refuse path tricks where staging/previous would collide with source or nest badly.
	if (isInside(sourceDir, stagingDir) || isInside(stagingDir, sourceDir)) {
		fail("Source kit overlaps the update staging path; choose a different --target.");
	}
	if (isInside(sourceDir, previousDir) || isInside(previousDir, sourceDir)) {
		fail("Source kit overlaps the previous-install path; choose a different --target.");
	}

	assertTargetReplaceable(targetDir);

	/** @type {PinCompensation | null} */
	let pinCompensation = null;
	let hadLiveInstall = false;
	let swapCompleted = false;
	let markerWritten = false;
	try {
		step("Staging release files");
		removePath(stagingDir);
		mkdirSync(dirname(stagingDir), { recursive: true });
		copyRecursive(sourceDir, stagingDir);
		carryPreservedIntoStaging(targetDir, stagingDir);
		ok(`Staged ${basename(sourceDir)} into ${stagingDir}`);

		// pnpm uses absolute directory junctions on Windows. Installing before the
		// rename leaves node_modules pointing at the removed staging path, so promote
		// first there; the existing catch path restores the previous install on failure.
		const installAfterSwap = process.platform === "win32";
		const workDir = installAfterSwap ? targetDir : stagingDir;
		if (installAfterSwap) {
			step("Promoting Windows staging before dependency refresh");
			hadLiveInstall = existsSync(targetDir);
			atomicSwapStagingToTarget(stagingDir, targetDir, previousDir);
			swapCompleted = true;
			if (hadLiveInstall) {
				ok(`Moved previous install to ${previousDir}`);
			}
			ok(`Promoted staging to ${targetDir}`);
			maybeInjectUpdateFailure("after-swap");
		}

		if (!skipInstall) {
			step("Refreshing dependencies (staging)");
			run("pnpm", ["install", "--frozen-lockfile"], workDir);
			ok("Dependencies are refreshed in staging.");
		} else {
			ok("Skipped dependency refresh.");
		}

		if (!skipPreflight) {
			step("Running preflight (staging)");
			run("pnpm", ["ship:preflight"], workDir);
		} else {
			ok("Skipped preflight.");
		}

		// Pin home config from the *staged* kit before live swap. A pin failure must not
		// claim a new install or leave the live tree half-migrated.
		pinCompensation = pinFriendHomeConfig(workDir);
		// If pin succeeded but swap/marker fails, restore home config from backup.
		maybeInjectUpdateFailure("after-pin");

		// POSIX pnpm links are relative, so keep live install untouched until all checks pass.
		if (!swapCompleted) {
			step("Swapping staging into live install");
			hadLiveInstall = existsSync(targetDir);
			atomicSwapStagingToTarget(stagingDir, targetDir, previousDir);
			swapCompleted = true;
			if (hadLiveInstall) {
				ok(`Moved previous install to ${previousDir}`);
			}
			ok(`Promoted staging to ${targetDir}`);
			maybeInjectUpdateFailure("after-swap");
		}

		// Marker only after successful swap so a failed update cannot claim a new version
		// and cannot leave the live tree half-deleted.
		step("Writing installed release marker");
		writeInstalledMarker(targetDir, manifest, sourceDir);
		markerWritten = true;
		pinCompensation = null;
		ok(`Wrote ${INSTALLED_RELEASE_MARKER}`);

		if (existsSync(previousDir)) {
			ok(`Previous install retained at ${previousDir} (one-version rollback).`);
		}
	} catch (error) {
		let detail = error instanceof Error ? error.message : String(error);
		if (swapCompleted && !markerWritten) {
			try {
				removePath(targetDir);
				if (hadLiveInstall) {
					if (!existsSync(previousDir)) {
						throw new Error(`previous install missing at ${previousDir}`);
					}
					renameSync(previousDir, targetDir);
					ok(`Restored previous live install after failed promotion: ${targetDir}`);
				} else {
					ok(`Removed failed promoted install: ${targetDir}`);
				}
			} catch (rollbackError) {
				const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
				detail += ` Install rollback failed (${rollbackDetail}). Manual recovery: if ${previousDir} exists, move it back to ${targetDir}.`;
			}
		}
		// If pin mutated home config before this failure, restore pre-pin backup.
		compensateHomeConfigAfterFailedUpdate(
			pinCompensation,
			detail,
		);
		removePath(stagingDir);
		fail(detail);
	}
} else {
	ok("Source and target are the same directory; skipping copy.");

	/** @type {PinCompensation | null} */
	let pinCompensation = null;
	try {
		if (!skipInstall) {
			step("Refreshing dependencies");
			run("pnpm", ["install", "--frozen-lockfile"], targetDir);
			ok("Dependencies are refreshed.");
		} else {
			ok("Skipped dependency refresh.");
		}

		if (!skipPreflight) {
			step("Running preflight");
			run("pnpm", ["ship:preflight"], targetDir);
		} else {
			ok("Skipped preflight.");
		}

		// Same-dir update: pin before marker so a pin failure cannot claim the new version.
		pinCompensation = pinFriendHomeConfig(targetDir);
		maybeInjectUpdateFailure("after-pin");

		// Marker only after successful install+preflight+pin so a failed update cannot claim a new version.
		step("Writing installed release marker");
		writeInstalledMarker(targetDir, manifest, sourceDir);
		ok(`Wrote ${INSTALLED_RELEASE_MARKER}`);
		pinCompensation = null;
	} catch (error) {
		compensateHomeConfigAfterFailedUpdate(
			pinCompensation,
			error instanceof Error ? error.message : String(error),
		);
		fail(error instanceof Error ? error.message : String(error));
	}
}

console.log("");
console.log("Update complete.");
// Friend-beta: package-local commands only (never owner-style gateway dev scripts).
console.log(`Start Zaraa with: cd ${targetDir} && pnpm start`);
console.log(`Verify: cd ${targetDir} && pnpm doctor`);
if (sourceDir !== targetDir && existsSync(previousDir)) {
	console.log(`Rollback if needed: rm -rf ${targetDir} && mv ${previousDir} ${targetDir}`);
}
