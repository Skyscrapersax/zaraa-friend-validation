#!/usr/bin/env node
/**
 * Friend-installer safety pin for ~/.zaraa/zaraa.config.json (or --config path).
 *
 * Fail-closed friend-beta surface:
 * - paper-only trading/predictions (no live auto-execute / background automation)
 * - overnight off; scheduler tasks disabled
 * - calendar / iMessage / voice / FaceTime / creative-joy off
 * - performance = minimal
 * - gateway.auth.apiKey present (minted only when missing/empty; never rotates a set key)
 *
 * Preserves existing gateway auth and unrelated keys. Safe to re-run on existing configs
 * so a reinstall cannot leave a live-trading or noisy friend config intact.
 *
 * On mutation of an existing file: writes a timestamped mode-0600 backup beside the config,
 * then replaces the live file via temp + rename (never silent credential loss). Restore path
 * is printed by the CLI as field names + a `cp` command — secret values are never logged.
 *
 * Does not start daemons, touch the live gateway, or place trades.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	realpathSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	FRIEND_POLYMARKET_SECRET_KEYS,
	FRIEND_TRADING_SECRET_KEYS,
} from "./friend-release-constants.mjs";

export { FRIEND_POLYMARKET_SECRET_KEYS, FRIEND_TRADING_SECRET_KEYS };

/** Keep only the newest N pre-pin backups beside a config (friend-beta disk bound). */
export const FRIEND_CONFIG_PRE_PIN_BACKUP_KEEP = 5;

/** Resolve symlinks so macOS /tmp vs /private/tmp CLI entry checks match. */
function realpathOrResolve(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Strip a leading UTF-8 BOM if present.
 * Windows PowerShell 5 `Set-Content -Encoding UTF8` writes BOM; Node JSON.parse rejects it.
 * @param {string} raw
 */
export function stripUtf8Bom(raw) {
	if (typeof raw !== "string" || raw.length === 0) return raw;
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Parse home config JSON; BOM-tolerant for Windows-created files.
 * @param {string} raw
 */
export function parseFriendConfigJson(raw) {
	return JSON.parse(stripUtf8Bom(raw));
}

function argValue(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Core accepts boolean true and string "true" as enabled (trading-mode / zaraa.ts). */
function isConfigTrue(value) {
	return value === true || value === "true";
}

/**
 * Money-moving credential keys stripped on friend install/update.
 * paperMode alone is not enough if CEX/Solana/Polymarket secrets remain in home config.
 * Values are never logged — only field names in `before.strippedCredentialFields`.
 * Defined once in friend-release-constants and re-exported for existing callers.
 */
const TRADING_SECRET_KEYS = FRIEND_TRADING_SECRET_KEYS;
const POLYMARKET_SECRET_KEYS = FRIEND_POLYMARKET_SECRET_KEYS;

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @param {string} prefix
 * @returns {string[]} removed field paths
 */
function stripSecretFields(obj, keys, prefix) {
	const removed = [];
	for (const key of keys) {
		// Fail-closed: any present secret key (including empty/whitespace string or non-string) is removed.
		if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] == null) continue;
		removed.push(`${prefix}.${key}`);
		delete obj[key];
	}
	return removed;
}

/**
 * Force friend paper-only + idle first-launch rails. Stricter than setup-wizard merge
 * (which may preserve explicit owner paperMode: false): installers always pin for friend beta.
 */
export function pinFriendConfigMoneySafety(config) {
	const next = isPlainObject(config) ? { ...config } : {};
	const trading = isPlainObject(next.trading) ? { ...next.trading } : {};
	const predictions = isPlainObject(next.predictions) ? { ...next.predictions } : {};
	const polymarket = isPlainObject(predictions.polymarket) ? { ...predictions.polymarket } : null;
	const scheduler = isPlainObject(next.scheduler) ? { ...next.scheduler } : {};
	const overnight = isPlainObject(scheduler.overnight) ? { ...scheduler.overnight } : {};
	const calendar = isPlainObject(next.calendar) ? { ...next.calendar } : {};
	const messaging = isPlainObject(next.messaging) ? { ...next.messaging } : {};
	const imessage = isPlainObject(messaging.imessage) ? { ...messaging.imessage } : {};
	const voice = isPlainObject(next.voice) ? { ...next.voice } : {};
	const facetime = isPlainObject(voice.facetime) ? { ...voice.facetime } : {};
	const autonomy = isPlainObject(next.autonomy) ? { ...next.autonomy } : {};
	const creativeJoy = isPlainObject(autonomy.creativeJoy) ? { ...autonomy.creativeJoy } : {};
	const gateway = isPlainObject(next.gateway) ? { ...next.gateway } : {};
	const auth = isPlainObject(gateway.auth) ? { ...gateway.auth } : {};
	const hadGatewayKey =
		typeof auth.apiKey === "string" && auth.apiKey.trim().length > 0;

	const tasksWereEnabled = Array.isArray(scheduler.tasks)
		? scheduler.tasks.some((task) => isPlainObject(task) && isConfigTrue(task.enabled))
		: false;

	const strippedCredentialFields = [
		...stripSecretFields(trading, TRADING_SECRET_KEYS, "trading"),
		...(polymarket
			? stripSecretFields(polymarket, POLYMARKET_SECRET_KEYS, "predictions.polymarket")
			: []),
	];

	const before = {
		tradingPaperMode: trading.paperMode,
		tradingAutoExecuteLive: trading.autoExecuteLive,
		tradingBackgroundAutomation: trading.backgroundAutomation,
		predictionsPaperMode: predictions.paperMode,
		predictionsAutoExecuteLive: predictions.autoExecuteLive,
		overnightEnabled: overnight.enabled,
		schedulerTasksEnabled: tasksWereEnabled,
		calendarEnabled: calendar.enabled,
		imessageEnabled: imessage.enabled,
		voiceEnabled: voice.enabled,
		facetimeEnabled: facetime.enabled,
		creativeJoyEnabled: creativeJoy.enabled,
		gatewayTrusted: gateway.trusted,
		autonomyMode: autonomy.mode,
		performance: next.performance,
		hadGatewayKey,
		strippedCredentialFields,
		hadLiveCredentials: strippedCredentialFields.length > 0,
	};

	// Capture live-risk before overwrite (string "true" counts as enabled).
	const hadLiveRisk =
		(trading.paperMode !== undefined && !isConfigTrue(trading.paperMode)) ||
		isConfigTrue(trading.autoExecuteLive) ||
		isConfigTrue(trading.backgroundAutomation) ||
		(predictions.paperMode !== undefined && !isConfigTrue(predictions.paperMode)) ||
		isConfigTrue(predictions.autoExecuteLive) ||
		isConfigTrue(overnight.enabled) ||
		tasksWereEnabled ||
		isConfigTrue(calendar.enabled) ||
		isConfigTrue(imessage.enabled) ||
		isConfigTrue(voice.enabled) ||
		isConfigTrue(facetime.enabled) ||
		isConfigTrue(creativeJoy.enabled) ||
		gateway.trusted !== false ||
		autonomy.mode !== "off" ||
		before.hadLiveCredentials;

	trading.paperMode = true;
	trading.autoExecuteLive = false;
	trading.backgroundAutomation = false;
	predictions.paperMode = true;
	predictions.autoExecuteLive = false;
	if (polymarket) {
		predictions.polymarket = polymarket;
	}
	overnight.enabled = false;
	scheduler.overnight = overnight;
	if (Array.isArray(scheduler.tasks)) {
		scheduler.tasks = scheduler.tasks.map((task) =>
			isPlainObject(task) ? { ...task, enabled: false } : task,
		);
	}

	calendar.enabled = false;
	imessage.enabled = false;
	messaging.imessage = imessage;
	voice.enabled = false;
	facetime.enabled = false;
	voice.facetime = facetime;
	creativeJoy.enabled = false;
	autonomy.creativeJoy = creativeJoy;
	autonomy.mode = "off";
	gateway.trusted = false;
	next.performance = "minimal";

	if (!hadGatewayKey) {
		auth.apiKey = randomBytes(32).toString("base64url");
	}
	gateway.auth = auth;
	next.gateway = gateway;

	next.trading = trading;
	next.predictions = predictions;
	next.scheduler = scheduler;
	next.calendar = calendar;
	next.messaging = messaging;
	next.voice = voice;
	next.autonomy = autonomy;

	const changed =
		hadLiveRisk ||
		before.tradingPaperMode !== true ||
		before.tradingAutoExecuteLive !== false ||
		before.tradingBackgroundAutomation !== false ||
		before.predictionsPaperMode !== true ||
		before.predictionsAutoExecuteLive !== false ||
		before.overnightEnabled !== false ||
		before.schedulerTasksEnabled === true ||
		before.calendarEnabled !== false ||
		before.imessageEnabled !== false ||
		before.voiceEnabled !== false ||
		before.facetimeEnabled !== false ||
		before.creativeJoyEnabled !== false ||
		before.gatewayTrusted !== false ||
		before.autonomyMode !== "off" ||
		before.performance !== "minimal" ||
		!hadGatewayKey ||
		before.hadLiveCredentials;

	return { config: next, changed, before };
}

/**
 * Timestamped sibling backup path for a pre-pin config snapshot.
 * @param {string} absConfigPath
 * @param {Date} [now]
 */
export function friendConfigPrePinBackupPath(absConfigPath, now = new Date()) {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return `${absConfigPath}.pre-friend-pin.${stamp}.json`;
}

/**
 * Exact restore command (field names only elsewhere — this only copies files).
 * @param {string} backupPath
 * @param {string} configPath
 */
export function friendConfigRestoreCommand(backupPath, configPath) {
	// Single-quote paths so shells treat spaces/specials literally; escape embedded quotes.
	const q = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
	return `cp ${q(backupPath)} ${q(configPath)}`;
}

/**
 * Write a mode-0600 sibling backup with O_CREAT|O_EXCL so a pre-planted
 * symlink/hard path at the timestamped name cannot siphon live credentials.
 * Never logs file contents.
 * @param {string} sourceAbs regular config file to snapshot
 * @param {string} backupAbs destination path (must not exist)
 * @returns {string} backupAbs
 */
export function writeFriendConfigBackupExclusive(sourceAbs, backupAbs) {
	const absSource = resolve(sourceAbs);
	const absBackup = resolve(backupAbs);
	if (absSource === absBackup) {
		throw new Error("Refusing to write backup over the live config path.");
	}
	// Destination parent is the config dir; pin already asserted it is not a symlink.
	// Still refuse if a backup path already exists (symlink, file, or dir) — never overwrite.
	if (existsSync(absBackup)) {
		let st = null;
		try {
			st = lstatSync(absBackup);
		} catch {
			st = null;
		}
		if (st?.isSymbolicLink()) {
			throw new Error(
				`Refusing to write pre-pin backup through existing symlink: ${absBackup}. ` +
					"Remove the symlink and retry the pin.",
			);
		}
		throw new Error(
			`Pre-pin backup path already exists: ${absBackup}. Retry pin (new timestamp) after removing the collision.`,
		);
	}
	let sourceStats;
	try {
		sourceStats = lstatSync(absSource);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot lstat config for backup ${absSource}: ${detail}`);
	}
	if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
		throw new Error(
			`Refusing to backup non-regular or symlink config: ${absSource}.`,
		);
	}
	const body = readFileSync(absSource);
	// O_EXCL: atomic create; fails if a symlink/file appears between existsSync and open.
	const fd = openSync(
		absBackup,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
		0o600,
	);
	try {
		writeFileSync(fd, body);
	} finally {
		closeSync(fd);
	}
	try {
		chmodSync(absBackup, 0o600);
	} catch {
		// best-effort mode tighten
	}
	return absBackup;
}

/**
 * Restore a pre-pin backup over the live config (cross-resource compensation).
 * Never logs file contents. Mode 0600 via exclusive temp + rename (same contract as pin).
 * Fail-closed: same path control as pin (no symlink config/parent, regular file only).
 * Never use copyFileSync into the live path: a TOCTOU symlink swap after assert would
 * follow the link and write the pre-pin body (including live credentials) out-of-tree.
 * @param {string} backupPath
 * @param {string} configPath
 */
export function restoreFriendConfigFromBackup(backupPath, configPath) {
	const absBackup = resolve(backupPath);
	const absConfig = resolve(configPath);
	if (!existsSync(absBackup)) {
		throw new Error(`Pre-pin backup missing; cannot restore ${absConfig} from ${absBackup}`);
	}
	// Refuse restore into symlink/dir/special — would mutate out-of-tree or fail opaquely.
	assertFriendConfigPathNotSymlink(absConfig);
	// Backup must also be a regular file (not a symlink to secrets elsewhere).
	let backupStats;
	try {
		backupStats = lstatSync(absBackup);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot lstat pre-pin backup ${absBackup}: ${detail}`);
	}
	if (backupStats.isSymbolicLink() || !backupStats.isFile()) {
		throw new Error(
			`Refusing to restore from non-regular or symlink backup: ${absBackup}. ` +
				"Use a plain JSON pre-pin backup file.",
		);
	}
	// Atomic exclusive temp + rename: never copyFileSync through a planted symlink/hard path.
	const body = readFileSync(absBackup, "utf8");
	writeConfigAtomically(absConfig, body);
	return { path: absConfig, restoredFrom: absBackup };
}

/**
 * Delete older pre-pin backups beside config, keeping the newest `keep` files.
 * Never logs file contents. Best-effort: unlink errors are ignored.
 * @param {string} absConfigPath
 * @param {number} [keep]
 * @returns {string[]} paths removed
 */
export function pruneFriendConfigPrePinBackups(
	absConfigPath,
	keep = FRIEND_CONFIG_PRE_PIN_BACKUP_KEEP,
) {
	const dir = dirname(absConfigPath);
	const base = basename(absConfigPath);
	const prefix = `${base}.pre-friend-pin.`;
	let names = [];
	try {
		names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
	} catch {
		return [];
	}
	const ranked = names
		.map((name) => {
			const full = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(full).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			return { full, mtimeMs, name };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
	const removed = [];
	for (const entry of ranked.slice(Math.max(0, keep))) {
		try {
			unlinkSync(entry.full);
			removed.push(entry.full);
		} catch {
			// ignore
		}
	}
	return removed;
}

/**
 * Ensure the config parent directory exists with mode 0700 (best-effort).
 * Prevents other local users from listing pre-pin backup basenames beside the config.
 * @param {string} dir
 */
export function ensureFriendConfigDir(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// best-effort on platforms that ignore directory mode
	}
}

/**
 * Fail-closed path control for friend home config:
 * - never pin through a config symlink (rename would replace the link; write could
 *   mutate an out-of-tree target with live credentials)
 * - never pin when the path exists but is not a regular file (directory/FIFO/device)
 * - never pin when the immediate parent directory is a symlink (temp+backup+rename
 *   would land credentials outside the operator-intended home config dir)
 * @param {string} abs
 */
export function assertFriendConfigPathNotSymlink(abs) {
	const parent = dirname(abs);
	if (existsSync(parent)) {
		let parentStats;
		try {
			parentStats = lstatSync(parent);
		} catch {
			parentStats = null;
		}
		if (parentStats?.isSymbolicLink()) {
			throw new Error(
				`Refusing to pin friend config under symlink parent directory: ${parent}. ` +
					"Replace the parent symlink with a real directory under the intended home path.",
			);
		}
		if (parentStats && !parentStats.isDirectory()) {
			throw new Error(
				`Refusing to pin friend config: parent path is not a directory: ${parent}.`,
			);
		}
	}
	// Use lstat even when existsSync is false: a dangling symlink exists for lstat
	// but existsSync returns false — never pin/write through a dangling link.
	let stats;
	try {
		stats = lstatSync(abs);
	} catch {
		return; // truly absent
	}
	if (stats.isSymbolicLink()) {
		throw new Error(
			`Refusing to pin friend config through symlink: ${abs}. ` +
				"Replace the symlink with a regular file under the intended home config path.",
		);
	}
	if (!stats.isFile()) {
		throw new Error(
			`Refusing to pin friend config: path is not a regular file: ${abs}. ` +
				"Expected a plain JSON config file (not a directory or special file).",
		);
	}
	// Hardlink nlink>1: atomic rename replaces only this directory entry; other links keep
	// the pre-strip inode (live credentials survive strip). Fail closed for friend beta.
	if (typeof stats.nlink === "number" && stats.nlink > 1) {
		throw new Error(
			`Refusing to pin friend config with hardlink count ${stats.nlink}: ${abs}. ` +
				"Copy to a unique regular file (nlink=1) under the intended home config path, then re-run pin.",
		);
	}
}

/**
 * Write a mode-0600 file with O_CREAT|O_EXCL (never follow a pre-planted symlink/hard path).
 * @param {string} absPath
 * @param {string|Buffer} body
 */
export function writeFileExclusive0600(absPath, body) {
	const abs = resolve(absPath);
	const fd = openSync(
		abs,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
		0o600,
	);
	try {
		writeFileSync(fd, body);
	} finally {
		closeSync(fd);
	}
	try {
		chmodSync(abs, 0o600);
	} catch {
		// best-effort mode tighten
	}
	return abs;
}

/**
 * Write config atomically: exclusive temp in same dir, mode 0600, rename over target, chmod 0600.
 * O_EXCL on the temp path so a pre-planted symlink cannot siphon the rewritten body (credentials/keys).
 * On any failure before rename, the original target is left untouched.
 * @param {string} abs
 * @param {string} body
 * @param {{ tmpSuffix?: string }} [options]  tmpSuffix is for hermetic collision tests only
 */
export function writeConfigAtomically(abs, body, options = {}) {
	const dir = dirname(abs);
	ensureFriendConfigDir(dir);
	const suffix =
		typeof options.tmpSuffix === "string" && options.tmpSuffix.length > 0
			? options.tmpSuffix
			: `${process.pid}.${randomBytes(4).toString("hex")}`;
	const tmp = join(dir, `.${basename(abs)}.friend-pin-tmp.${suffix}`);
	try {
		// Exclusive create — never writeFileSync through a pre-planted temp symlink.
		writeFileExclusive0600(tmp, body);
		renameSync(tmp, abs);
		try {
			chmodSync(abs, 0o600);
		} catch {
			// Best-effort tighten on platforms that ignore mode; rename already landed.
		}
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore cleanup (missing or still a hostile entry)
		}
		throw error;
	}
}

/**
 * Apply friend safety pin to a config file path.
 * Existing files that change get a timestamped 0600 backup first; write is atomic.
 * @param {string} configPath
 * @param {{ now?: Date, writeConfig?: (abs: string, body: string) => void }} [options]
 *   `writeConfig` is for tests that inject write failures; production uses temp+rename.
 */
export function applyFriendConfigSafetyFile(configPath, options = {}) {
	const abs = resolve(configPath);
	// Symlink refuse before any read/write/backup (adversarial path control).
	assertFriendConfigPathNotSymlink(abs);
	const existed = existsSync(abs);
	let existing = {};
	let rawExisting = null;
	if (existed) {
		try {
			rawExisting = readFileSync(abs, "utf8");
			existing = parseFriendConfigJson(rawExisting);
		} catch (error) {
			throw new Error(
				`Cannot parse config at ${abs}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const { config, changed, before } = pinFriendConfigMoneySafety(existing);
	const body = `${JSON.stringify(config, null, 2)}\n`;
	const writeConfig = options.writeConfig ?? writeConfigAtomically;

	// Backup only when we mutate semantics (credentials/flags). Always rewrite atomically
	// afterward so mode 0600 is applied even when rails were already paper-only (chmod on
	// an existing path is not enough on all platforms / umask histories).
	let backupPath = null;
	if (changed && existed && rawExisting != null) {
		backupPath = friendConfigPrePinBackupPath(abs, options.now ?? new Date());
		// Exclusive create — never follow a pre-planted symlink at the backup path.
		writeFriendConfigBackupExclusive(abs, backupPath);
	}

	try {
		writeConfig(abs, body);
	} catch (error) {
		// Backup remains; original is left intact when write fails before/without rename.
		// Do not prune on failure — operator may need every snapshot.
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Friend safety pin write failed for ${abs}: ${msg}` +
				(backupPath ? ` Pre-pin backup kept at ${backupPath}` : ""),
		);
	}

	// Bound disk use only after a successful write.
	const prunedBackupPaths = pruneFriendConfigPrePinBackups(abs);

	return {
		path: abs,
		changed,
		before,
		config,
		backupPath,
		restoreCommand: backupPath ? friendConfigRestoreCommand(backupPath, abs) : null,
		prunedBackupPaths,
	};
}

/**
 * Machine-readable pin result for the kit updater (cross-resource compensation).
 * Never includes secret values — field names only.
 * @param {ReturnType<typeof applyFriendConfigSafetyFile>} result
 */
function writePinResultJson(resultPath, result) {
	const absResult = resolve(resultPath);
	// Refuse writing compensation metadata through a symlink (path leak / overwrite).
	try {
		const st = lstatSync(absResult);
		if (st.isSymbolicLink()) {
			throw new Error(
				`Refusing to write pin result JSON through symlink: ${absResult}`,
			);
		}
		if (!st.isFile()) {
			throw new Error(
				`Refusing to write pin result JSON: not a regular file: ${absResult}`,
			);
		}
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? error.code : null;
		if (code !== "ENOENT") {
			throw error;
		}
		// ENOENT — path free to create
	}
	const payload = {
		path: result.path,
		changed: result.changed,
		backupPath: result.backupPath ?? null,
		restoreCommand: result.restoreCommand ?? null,
		strippedCredentialFields: Array.isArray(result.before?.strippedCredentialFields)
			? result.before.strippedCredentialFields
			: [],
	};
	// Atomic exclusive temp + rename: never writeFileSync through a planted path; mode 0600.
	const body = `${JSON.stringify(payload)}\n`;
	const dir = dirname(absResult);
	ensureFriendConfigDir(dir);
	const tmp = join(
		dir,
		`.${basename(absResult)}.pin-result-tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
	);
	try {
		writeFileExclusive0600(tmp, body);
		renameSync(tmp, absResult);
		try {
			chmodSync(absResult, 0o600);
		} catch {
			// best-effort
		}
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore cleanup
		}
		throw error;
	}
}

function runCli() {
	const configPath =
		argValue("--config", null) ?? resolve(homedir(), ".zaraa", "zaraa.config.json");
	const resultJsonPath = argValue("--result-json", null);
	try {
		const result = applyFriendConfigSafetyFile(configPath);
		if (resultJsonPath) {
			try {
				writePinResultJson(resolve(resultJsonPath), result);
			} catch (error) {
				if (result.backupPath) {
					restoreFriendConfigFromBackup(result.backupPath, result.path);
				}
				throw error;
			}
		}
		if (result.changed) {
			console.log(`OK   Friend safety rails pinned (paper-only + idle) at ${result.path}`);
			// Notes use truthiness helpers so stringly "false"/"true" are reported honestly.
			if (
				result.before.tradingPaperMode !== undefined &&
				!isConfigTrue(result.before.tradingPaperMode)
			) {
				console.log(
					`OK   Note: trading.paperMode was ${JSON.stringify(result.before.tradingPaperMode)}; installer forced paperMode true.`,
				);
			}
			if (isConfigTrue(result.before.tradingAutoExecuteLive)) {
				console.log("OK   Note: trading.autoExecuteLive was enabled; installer forced false.");
			}
			if (
				result.before.predictionsPaperMode !== undefined &&
				!isConfigTrue(result.before.predictionsPaperMode)
			) {
				console.log(
					`OK   Note: predictions.paperMode was ${JSON.stringify(result.before.predictionsPaperMode)}; installer forced paperMode true.`,
				);
			}
			if (isConfigTrue(result.before.overnightEnabled)) {
				console.log("OK   Note: scheduler.overnight.enabled was enabled; installer forced false.");
			}
			if (result.before.schedulerTasksEnabled === true) {
				console.log("OK   Note: scheduler tasks were enabled; installer forced all tasks off.");
			}
			if (result.before.hadGatewayKey === false) {
				console.log("OK   Note: gateway.auth.apiKey was missing; installer minted a new local key.");
			}
			if (
				Array.isArray(result.before.strippedCredentialFields) &&
				result.before.strippedCredentialFields.length > 0
			) {
				// Field names only — never echo secret values.
				console.log(
					`OK   Note: stripped live trading credentials: ${result.before.strippedCredentialFields.join(", ")}.`,
				);
			}
			if (result.backupPath && result.restoreCommand) {
				console.log(`OK   Pre-pin backup (mode 0600): ${result.backupPath}`);
				console.log(`OK   Restore previous config: ${result.restoreCommand}`);
			}
		} else {
			console.log(`OK   Friend safety rails already paper-only + idle at ${result.path}`);
		}
		return 0;
	} catch (error) {
		console.error(`ERR  ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

const entryPath = process.argv[1] ? realpathOrResolve(process.argv[1]) : "";
const modulePath = realpathOrResolve(fileURLToPath(import.meta.url));
if (entryPath && modulePath && entryPath === modulePath) {
	process.exitCode = runCli();
}
