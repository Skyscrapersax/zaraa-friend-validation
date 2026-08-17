import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

export function readTaskActivitySummaryFromDb(tasksDbPath) {
	const empty = {
		available: true,
		running: 0,
		pending: 0,
		blocked: 0,
	};
	if (!tasksDbPath || !existsSync(tasksDbPath)) {
		return { ...empty, available: false, reason: "tasks.db missing" };
	}

	let db;
	try {
		db = new Database(tasksDbPath, { readonly: true, fileMustExist: true });
		const rows = db
			.prepare(`
				SELECT status, COUNT(*) AS count
				FROM tasks
				WHERE status IN ('running', 'pending', 'blocked')
				GROUP BY status
			`)
			.all();
		const summary = { ...empty };
		for (const row of rows) {
			const count = Number(row.count || 0);
			if (row.status === "running") summary.running = count;
			if (row.status === "pending") summary.pending = count;
			if (row.status === "blocked") summary.blocked = count;
		}
		return summary;
	} catch (err) {
		return {
			...empty,
			available: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	} finally {
		db?.close();
	}
}

/**
 * Whether SIGTERM should wait for in-flight work before exit.
 *
 * Pending/blocked queue depth must NOT delay shutdown — large queues (hundreds
 * of rows) previously caused full-grace drains under launchd thrash while no
 * work was actually running. Only **running** tasks (and optional active
 * generator) justify a short drain.
 */
export function shouldDrainShutdownForTaskActivity(activity = {}, options = {}) {
	const signal = String(options.signal ?? "SIGTERM").toUpperCase();
	const enabled = options.enabled !== false;
	const running = Math.max(0, Number(activity.running || 0));
	const pending = Math.max(0, Number(activity.pending || 0));
	const generatorActive = activity.generatorActive === true;
	if (!enabled || signal !== "SIGTERM") {
		return { drain: false, reason: null, running, pending, generatorActive };
	}
	// Pending alone never drains — queue can be huge while idle.
	if (running > 0 || generatorActive) {
		return {
			drain: true,
			reason: `active task work present: running=${running} pending=${pending} generatorActive=${generatorActive}`,
			running,
			pending,
			generatorActive,
		};
	}
	return { drain: false, reason: null, running, pending, generatorActive };
}

function readActiveProofWindowForSignal({
	proofStartPath,
	nowMs = Date.now(),
	windowMs = 24 * 60 * 60 * 1000,
} = {}) {
	if (!proofStartPath || !existsSync(proofStartPath)) return null;
	try {
		const saved = JSON.parse(readFileSync(proofStartPath, "utf-8"));
		const startMs = Date.parse(saved?.start);
		if (!Number.isFinite(startMs)) return null;
		const endMs = startMs + Math.max(1, Number(windowMs || 0));
		if (nowMs < startMs || nowMs >= endMs) return null;
		return { startMs, endMs, end: new Date(endMs).toISOString() };
	} catch {
		return null;
	}
}

/**
 * Proof-scoped daemons (explicit ZARAA_PROOF_START_PATH, e.g. ship-rc5) should
 * self-stop after the 24h window so they do not idle forever in /var/folders.
 * Live 2026-07-25: com.zaraa.ship-rc5.daemon still running ~30h after start.
 * Main com.zaraa.daemon is never force-exited here (uses proof only for SIGTERM guard).
 */
export function shouldExitForExpiredProofWindow(options = {}) {
	const proofStartPath =
		typeof options.proofStartPath === "string" && options.proofStartPath.trim()
			? options.proofStartPath.trim()
			: null;
	if (!proofStartPath) return { exit: false, reason: null };
	const serviceLabel = String(options.serviceLabel ?? "");
	if (serviceLabel === "com.zaraa.daemon" && options.allowMainDaemon !== true) {
		return { exit: false, reason: null };
	}
	const nowMs = Number(options.nowMs ?? Date.now());
	const windowMs = Math.max(1, Number(options.windowMs ?? 24 * 60 * 60 * 1000));
	if (!existsSync(proofStartPath)) return { exit: false, reason: null };
	const active = readActiveProofWindowForSignal({ proofStartPath, nowMs, windowMs });
	if (active) return { exit: false, reason: null, activeUntil: active.end };
	try {
		const saved = JSON.parse(readFileSync(proofStartPath, "utf-8"));
		const startMs = Date.parse(saved?.start);
		if (!Number.isFinite(startMs)) return { exit: false, reason: null };
		if (nowMs < startMs) return { exit: false, reason: null }; // not started yet
		const endIso = new Date(startMs + windowMs).toISOString();
		return {
			exit: true,
			reason: `proof window expired (started ${saved.start}, ended ${endIso})`,
			startedAt: saved.start,
			endedAt: endIso,
		};
	} catch {
		return { exit: false, reason: null };
	}
}

function readRecentRestartIntentEvents(path, nowMs, windowMs) {
	if (!path || !existsSync(path)) return [];
	const cutoff = nowMs - Math.max(0, Number(windowMs || 0));
	try {
		return readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((event) => {
				if (!event || typeof event !== "object") return false;
				const ts = Date.parse(event.timestamp);
				return Number.isFinite(ts) && ts >= cutoff && ts <= nowMs + 1000;
			});
	} catch {
		return [];
	}
}

const DEFAULT_PROOF_RESET_ALLOWED_SOURCES = new Set([
	"codex.proof-signal-guard",
]);

export function isProofResetSourceAllowed(source, allowedSources = DEFAULT_PROOF_RESET_ALLOWED_SOURCES) {
	const normalized = String(source ?? "").trim();
	if (!normalized) return false;
	const allowed = allowedSources instanceof Set ? allowedSources : new Set(allowedSources ?? []);
	return allowed.has(normalized);
}

function isProofResetReasonAllowed(reason) {
	return String(reason ?? "").trim() === "load-proof-reset-tight-reason-gate";
}

export function shouldBlockSignalShutdownForActiveProof(options = {}) {
	const signal = String(options.signal ?? "SIGTERM").toUpperCase();
	const serviceLabel = options.serviceLabel ?? "com.zaraa.daemon";
	if (signal !== "SIGTERM" || serviceLabel !== "com.zaraa.daemon") {
		return { block: false, reason: null };
	}
	const nowMs = Number(options.nowMs ?? Date.now());
	const activeProof = readActiveProofWindowForSignal({
		proofStartPath: options.proofStartPath,
		nowMs,
		windowMs: options.proofWindowMs,
	});
	if (!activeProof) return { block: false, reason: null };

	const recentIntents = readRecentRestartIntentEvents(
		options.restartIntentPath,
		nowMs,
		options.allowIntentWindowMs ?? 5 * 60 * 1000,
	);
	const allowed = recentIntents.some(
		(event) => {
			const intentMs = Date.parse(event.timestamp);
			return (
				Number.isFinite(intentMs) &&
				intentMs >= activeProof.startMs &&
				event.serviceLabel === serviceLabel &&
				isProofResetSourceAllowed(event.source, options.proofResetAllowedSources) &&
				isProofResetReasonAllowed(event.reason) &&
				event.proofWindowBypass === "force-proof-reset" &&
				event.proofResetAllowed === true &&
				event.proofResetTokenVerified === true
			);
		},
	);
	if (allowed) return { block: false, reason: null };

	const secondSignalForceWindowMs = Math.max(0, Number(options.secondSignalForceWindowMs ?? 30 * 1000));
	const lastBlockedSignalMs = Number(options.lastBlockedSignalMs ?? 0);
	if (secondSignalForceWindowMs > 0 && Number.isFinite(lastBlockedSignalMs) && lastBlockedSignalMs > 0) {
		const elapsedMs = nowMs - lastBlockedSignalMs;
		if (elapsedMs >= 0 && elapsedMs <= secondSignalForceWindowMs) {
			return {
				block: false,
				forced: true,
				reason:
					`Second ${signal} received ${Math.ceil(elapsedMs / 1000)}s after proof guard block; ` +
					`forcing shutdown for ${serviceLabel}.`,
			};
		}
	}

	return {
		block: true,
		reason:
			`Blocked ${signal}: active 24h proof window for ${serviceLabel} runs until ${activeProof.end}; ` +
			`send ${signal} again within ${Math.ceil(secondSignalForceWindowMs / 1000)}s to force shutdown, ` +
			"or record an allowed proof-reset intent before signaling the daemon.",
	};
}

function normalizeRestartTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	const timestamp = value?.timestampMs ?? value?.timestamp ?? value?.at;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	if (typeof timestamp === "string") {
		const parsed = Date.parse(timestamp);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function readRestartTimestamps(path) {
	try {
		if (!path || !existsSync(path)) return [];
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.map(normalizeRestartTimestamp).filter((value) => value != null);
	} catch {
		return [];
	}
}

function scopedRestartLogPath(path, serviceLabel) {
	const label = String(serviceLabel ?? "")
		.trim()
		.replace(/[^a-z0-9._-]+/gi, "-")
		.replace(/^-+|-+$/g, "");
	if (!label) return path;
	if (path.endsWith(".json")) return `${path.slice(0, -5)}.${label}.json`;
	return `${path}.${label}`;
}

export function resolveDaemonServiceLabel(options = {}) {
	const explicit =
		options.zaraaServiceLabel?.trim?.() ||
		options.zaraaLaunchdLabel?.trim?.() ||
		options.launchdLabel?.trim?.();
	if (explicit) return explicit;
	const validationSignal = [options.zaraaDataDir, options.zaraaDaemonLockDir]
		.map((value) => String(value ?? "").toLowerCase())
		.some((value) => value.includes("validation"));
	return validationSignal ? "com.zaraa.validation-daemon" : "com.zaraa.daemon";
}

function pidFileLabelSuffix(serviceLabel) {
	return String(serviceLabel ?? "")
		.trim()
		.replace(/[^a-z0-9._-]+/gi, "-")
		.replace(/^-+|-+$/g, "");
}

export function resolveDaemonPidFilePath(options = {}) {
	const explicit = options.zaraaPidFile?.trim?.() || options.pidFile?.trim?.();
	if (explicit) return explicit;
	const home = options.homeDir ?? homedir();
	const serviceLabel =
		options.serviceLabel ??
		resolveDaemonServiceLabel({
			zaraaServiceLabel: options.zaraaServiceLabel,
			zaraaLaunchdLabel: options.zaraaLaunchdLabel,
			launchdLabel: options.launchdLabel,
			zaraaDataDir: options.zaraaDataDir,
			zaraaDaemonLockDir: options.zaraaDaemonLockDir,
		});
	if (serviceLabel === "com.zaraa.daemon") {
		return join(home, ".zaraa", "zaraa.pid");
	}
	const suffix = pidFileLabelSuffix(serviceLabel) || "daemon";
	return join(home, ".zaraa", `zaraa.${suffix}.pid`);
}

export function shouldRemoveDaemonPidFile(options = {}) {
	return String(options.pidFileContent ?? "").trim() === String(options.pid ?? "").trim();
}

export function resolveStartupRuntimePauseMs(options = {}) {
	const explicitValue = options.zaraaStartupRuntimePauseMs;
	if (explicitValue !== undefined && explicitValue !== null && String(explicitValue).trim() !== "") {
		const parsed = Number(explicitValue);
		return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
	}

	const serviceLabel =
		options.serviceLabel ??
		resolveDaemonServiceLabel({
			zaraaServiceLabel: options.zaraaServiceLabel,
			zaraaLaunchdLabel: options.zaraaLaunchdLabel,
			launchdLabel: options.launchdLabel,
			zaraaDataDir: options.zaraaDataDir,
			zaraaDaemonLockDir: options.zaraaDaemonLockDir,
		});
	const validationDaemon =
		serviceLabel === "com.zaraa.validation-daemon" ||
		[options.zaraaDataDir, options.zaraaDaemonLockDir]
			.map((value) => String(value ?? "").toLowerCase())
			.some((value) => value.includes("validation"));

	return options.preferResponsiveStartupQuietWindow === true && validationDaemon ? 180_000 : 0;
}

export function buildStartupDiagnosticChatBody(options = {}) {
	const crashWarning = options.crashLoop
		? "CRASH LOOP DETECTED: 3+ restarts in 10 minutes. "
		: "";
	const now = Number(options.now ?? Date.now());
	const requestId =
		options.requestId ??
		`startup-diagnostic-${Number.isFinite(now) ? now : Date.now()}`;

	return {
		requestId,
		message: `${crashWarning}Partner startup check: (1) health ok? (2) paperMode? (3) open positions/pending tasks? (4) one Next for the operator. Send a short iMessage summary — one truth packet, not a wall of logs.`,
		taskType: "chat",
		routing: { model: "gpt-5.5-low" },
		routingAvoidBillingModes: ["local"],
		source: "startup-diagnostic",
	};
}

function appendRestartTimestamp(path, timestamp) {
	const restarts = [...readRestartTimestamps(path), timestamp].slice(-10);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(restarts), { mode: 0o600 });
	return restarts;
}

/** Match a restart-log entry to a preceding graceful SIGTERM exit intent (kickstart/deploy). */
export const PLANNED_RESTART_MATCH_MS = 120_000;

/**
 * Parse daemon restart-intents.jsonl lines into graceful-exit timestamps (ms).
 * SIGTERM / gracefulShutdown / supervisor restart = planned operator/supervisor stop.
 * Mirrors packages/core partner-alerts so daemon crashLoop and partner alerts agree.
 */
export function parseGracefulExitTimestampsFromIntents(lines) {
	if (!Array.isArray(lines)) return [];
	const out = [];
	for (const line of lines) {
		if (typeof line !== "string" || !line.trim()) continue;
		try {
			const o = JSON.parse(line);
			const ts = o.timestamp ? Date.parse(o.timestamp) : Number.NaN;
			if (!Number.isFinite(ts)) continue;
			const source = String(o.source ?? "");
			const signal = String(o.signal ?? "");
			const reason = String(o.reason ?? "");
			if (
				signal === "SIGTERM" ||
				/gracefulShutdown/i.test(source) ||
				/supervisor restart/i.test(reason)
			) {
				out.push(ts);
			}
		} catch {
			/* skip bad lines */
		}
	}
	return out;
}

/**
 * Count restarts in window that were *not* preceded by a planned graceful exit.
 * Level-up launchctl kickstarts must not trip crashLoop / crashStormAlert.
 */
export function countUnplannedRestartsInWindow(
	restartTimestamps,
	plannedExitTimestamps,
	nowMs,
	windowMs,
	matchWindowMs = PLANNED_RESTART_MATCH_MS,
) {
	if (!Array.isArray(restartTimestamps)) return 0;
	const planned = Array.isArray(plannedExitTimestamps)
		? plannedExitTimestamps.filter((v) => typeof v === "number" && Number.isFinite(v))
		: [];
	const cutoff = nowMs - windowMs;
	let n = 0;
	for (const t of restartTimestamps) {
		if (typeof t !== "number" || !Number.isFinite(t) || t <= cutoff) continue;
		const isPlanned = planned.some((g) => g <= t && t - g <= matchWindowMs);
		if (!isPlanned) n++;
	}
	return n;
}

function resolvePlannedExitTimestamps(options = {}) {
	if (Array.isArray(options.plannedExitTimestamps)) {
		return options.plannedExitTimestamps.filter((v) => typeof v === "number" && Number.isFinite(v));
	}
	const intentPath =
		typeof options.restartIntentPath === "string" && options.restartIntentPath.trim()
			? options.restartIntentPath.trim()
			: null;
	if (!intentPath) return null;
	try {
		if (!existsSync(intentPath)) return [];
		const text = readFileSync(intentPath, "utf8");
		return parseGracefulExitTimestampsFromIntents(text.split("\n"));
	} catch {
		return [];
	}
}

export function recordDaemonRestart(options = {}) {
	const path = options.path;
	const timestamp = Number(options.now ?? Date.now());
	const windowMs = Math.max(1, Number(options.windowMs ?? 10 * 60 * 1000));
	const threshold = Math.max(1, Number(options.threshold ?? 3));
	const scopedPath = scopedRestartLogPath(path, options.serviceLabel);
	if (!path || !Number.isFinite(timestamp)) {
		return { crashLoop: false, recentCount: 0, globalPath: path ?? null, scopedPath };
	}
	try {
		const previousScopedRestarts = readRestartTimestamps(scopedPath);
		appendRestartTimestamp(path, timestamp);
		const scopedRestarts =
			scopedPath === path
				? readRestartTimestamps(path)
				: appendRestartTimestamp(scopedPath, timestamp);
		const cutoff = timestamp - windowMs;
		const totalRecentCount = scopedRestarts.filter((value) => value > cutoff).length;
		const previousTotalRecentCount = previousScopedRestarts.filter((value) => value > cutoff).length;
		// When restart intents are available (path or explicit list), only *unplanned*
		// restarts trip crashLoop / storm / back-online — intentional kickstarts no longer
		// put the daemon into crash-loop budget mode or re-warn every level-up cycle.
		const planned = resolvePlannedExitTimestamps(options);
		const recentCount =
			planned === null
				? totalRecentCount
				: countUnplannedRestartsInWindow(scopedRestarts, planned, timestamp, windowMs);
		const previousRecentCount =
			planned === null
				? previousTotalRecentCount
				: countUnplannedRestartsInWindow(previousScopedRestarts, planned, timestamp, windowMs);
		return {
			crashLoop: recentCount >= threshold,
			crashStormAlert: previousRecentCount < threshold && recentCount >= threshold,
			backOnlineAlert: previousRecentCount === 1 && recentCount === 2,
			recentCount,
			totalRecentCount,
			globalPath: path,
			scopedPath,
		};
	} catch {
		return { crashLoop: false, recentCount: 0, globalPath: path, scopedPath };
	}
}

function isProcessAlive(pid, processKill = process.kill) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		processKill(pid, 0);
		return true;
	} catch (err) {
		if (err?.code === "EPERM") return true;
		return false;
	}
}

function defaultReadProcessCommand(pid) {
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

/**
 * A stale lock owner.json can outlive the daemon it named — the OS is free
 * to reuse that pid for an unrelated process once the daemon exits. Live
 * 2026-07-27: owner.json still pointed at a dead validation-daemon pid that
 * macOS had reassigned to an unrelated system daemon, so isProcessAlive()
 * kept reporting a "live" owner and every restart attempt busy-waited the
 * full liveOwnerWaitMs before giving up — a persistent boot loop.
 *
 * Returns true/false when the command line is readable, or null when it
 * can't be determined (ps failure, permission) — callers must treat null as
 * "still possibly a live owner" rather than assume staleness.
 */
function looksLikeZaraaDaemonCommand(command) {
	const trimmed = String(command ?? "").trim();
	if (!trimmed) return null;
	const parts = trimmed.split(/\s+/);
	const executable = parts[0]?.split("/").pop();
	if (executable !== "node" && executable !== "bun") return false;
	return parts.some((arg) => /(?:^|\/)scripts\/zaraa-(?:validation-)?daemon\.mjs$/.test(arg));
}

function waitForPotentialOwnerWrite(ms) {
	if (ms <= 0) return;
	const start = Date.now();
	while (Date.now() - start < ms) {
		// Tight spin; lock acquisition is early process bootstrap path.
	}
}

/**
 * How long a kickstart successor should poll a live singleton owner before
 * failing. Must cover predecessor SIGTERM task drain or KeepAlive thrash
 * restarts the successor while the old pid still holds the lock.
 *
 * - explicitWaitMs (ZARAA_DAEMON_LOCK_WAIT_MS): hard override when set
 * - else: sigtermTaskDrainMs + marginMs (default margin 15s)
 *
 * Live 2026-07-26 residual: fixed 90s default was shorter than default
 * SIGTERM drain (180s) and recreated the thrash window after coupling
 * wait-for-predecessor landed.
 */
export function resolveSingletonLiveOwnerWaitMs(options = {}) {
	const explicitRaw = options.explicitWaitMs;
	if (explicitRaw !== undefined && explicitRaw !== null && String(explicitRaw).trim() !== "") {
		const n = Number(explicitRaw);
		if (Number.isFinite(n)) return Math.max(0, n);
	}
	const drainMs = Math.max(0, Number(options.sigtermTaskDrainMs ?? 180_000));
	const marginMs = Math.max(0, Number(options.marginMs ?? 15_000));
	return drainMs + marginMs;
}

export function tryAcquireSingletonProcessLock(options = {}) {
	const home = options.homeDir ?? homedir();
	const lockDir = options.lockDir ?? join(home, ".zaraa", "locks", "zaraa-daemon.lock");
	const ownerPath = join(lockDir, "owner.json");
	const pid = Number(options.pid ?? process.pid);
	const processKill = options.processKill ?? process.kill;
	const readProcessCommand = options.readProcessCommand ?? defaultReadProcessCommand;
	const maxAttempts = Math.max(1, Number(options.maxAttempts ?? 3));
	const ownerStabilizeMs = Number(options.ownerStabilizeMs ?? 30);
	const now = Number(options.now ?? Date.now());
	// When a live predecessor holds the lock (kickstart / SIGTERM drain), wait
	// and retry instead of immediately failing — KeepAlive otherwise thrash-
	// restarts the successor while the old pid drains (live 2026-07-26 residual).
	// Default 0 preserves fast-fail for tests; daemon.mjs couples to drain+margin.
	const liveOwnerWaitMs = Math.max(0, Number(options.liveOwnerWaitMs ?? 0));
	const liveOwnerPollMs = Math.max(20, Number(options.liveOwnerPollMs ?? 2_000));
	const sleepFn =
		typeof options.sleepFn === "function" ? options.sleepFn : waitForPotentialOwnerWrite;
	const deadline = now + liveOwnerWaitMs;

	mkdirSync(join(lockDir, ".."), { recursive: true });

	let lastObservedPid = null;
	let attempt = 0;
	// Bound total iterations even when waiting for a live owner.
	const hardCap = Math.max(maxAttempts, liveOwnerWaitMs > 0 ? Math.ceil(liveOwnerWaitMs / liveOwnerPollMs) + maxAttempts : maxAttempts);
	while (attempt < hardCap) {
		attempt += 1;
		try {
			mkdirSync(lockDir);
			writeFileSync(
				ownerPath,
				JSON.stringify({
					pid,
					startedAt: now,
				}),
				"utf-8",
			);
			let released = false;
			return {
				acquired: true,
				lockDir,
				existingPid: null,
				release: () => {
					if (released) return;
					released = true;
					// Guarded release: only remove the lock if this pid still owns
					// it. A late release from a predecessor must never clobber a
					// lock that a successor re-acquired (or that was re-asserted
					// after external deletion, e.g. iCloud tombstone convergence).
					const currentOwner = readJsonFile(ownerPath);
					const currentOwnerPid =
						currentOwner && typeof currentOwner === "object" && Number.isInteger(currentOwner.pid)
							? Number(currentOwner.pid)
							: null;
					if (currentOwnerPid !== null && currentOwnerPid !== pid) return;
					rmSync(lockDir, { recursive: true, force: true });
				},
			};
		} catch (err) {
			if (err?.code !== "EEXIST") {
				throw err;
			}
		}

		const owner = readJsonFile(ownerPath);
		const existingPid =
			owner && typeof owner === "object" && Number.isInteger(owner.pid) ? Number(owner.pid) : null;
		lastObservedPid = existingPid;
		if (existingPid && existingPid !== pid && isProcessAlive(existingPid, processKill)) {
			// The pid is alive, but pids get reused once the daemon that owned it
			// exits — confirm it's actually a zaraa daemon before treating it as a
			// live predecessor. A non-daemon process at this pid means owner.json
			// is stale from a prior run; don't busy-wait on it.
			if (looksLikeZaraaDaemonCommand(readProcessCommand(existingPid)) === false) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			// Predecessor still draining (kickstart race): wait then retry.
			if (Date.now() < deadline) {
				sleepFn(liveOwnerPollMs);
				continue;
			}
			return {
				acquired: false,
				lockDir,
				existingPid,
				release: () => {},
			};
		}

		// If the lock exists without a readable owner payload, another process
		// may still be writing the owner file. Give it a tiny window to settle
		// before removing anything.
		if (!existingPid) {
			if (attempt < hardCap) {
				waitForPotentialOwnerWrite(ownerStabilizeMs * Math.min(attempt, 3));
				continue;
			}
			rmSync(lockDir, { recursive: true, force: true });
			continue;
		}

		// Stale owner (dead pid): remove and retry.
		rmSync(lockDir, { recursive: true, force: true });
	}

	return {
		acquired: false,
		lockDir,
		existingPid: lastObservedPid,
		release: () => {},
	};
}

/**
 * Pure decision for the singleton-lock self-heal watchdog: given the pid
 * recorded in owner.json (or null if the file is missing/malformed) and this
 * process's own pid, decide whether to re-assert ownership, warn about a
 * split-brain (a different live-looking owner), or do nothing.
 *   - ownerPid === myPid        → "noop" (healthy, we already own it)
 *   - ownerPid !== null/!==myPid → "warn-split-brain" (never steal)
 *   - ownerPid === null          → "reassert" (lock dir/owner file vanished)
 */
export function shouldReassertLock({ ownerPid, myPid } = {}) {
	const normalizedOwnerPid = Number.isInteger(ownerPid) ? ownerPid : null;
	if (normalizedOwnerPid === myPid) return "noop";
	if (normalizedOwnerPid !== null) return "warn-split-brain";
	return "reassert";
}

export function shouldExitAsOrphanedHarnessChild({
	hasCustomLockDir,
	initialParentPid,
	currentParentPid,
} = {}) {
	// Only harness-spawned daemons (custom lock dir) opt into parent-liveness
	// supervision; production daemons legitimately run under launchd (ppid 1),
	// so reparenting checks must never apply to them.
	if (!hasCustomLockDir) return false;
	if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) return false;
	if (!Number.isInteger(currentParentPid)) return false;
	return currentParentPid !== initialParentPid;
}

function stripProviderNamespace(modelName) {
	if (typeof modelName !== "string") return "";
	const normalized = modelName.trim().toLowerCase();
	const delimiterIndex = normalized.lastIndexOf(":");
	return delimiterIndex >= 0 ? normalized.slice(delimiterIndex + 1) : normalized;
}

function modelNamesEquivalent(left, right) {
	const normalizedLeft = stripProviderNamespace(left);
	const normalizedRight = stripProviderNamespace(right);
	return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function isLoopbackLocalProvider(provider) {
	if (!provider || !Array.isArray(provider.models)) return false;
	if (provider.type === "ollama") return true;
	if (
		provider.type !== "openai-compatible" &&
		provider.type !== "openai" &&
		provider.type !== "custom"
	) {
		return false;
	}
	return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(provider.baseUrl || "");
}

export function providerHasModel(provider, modelName) {
	return Array.isArray(provider?.models) && provider.models.some((model) => model === modelName);
}

export function configHasProviderForModel(config, modelName) {
	return (
		Array.isArray(config?.providers) &&
		config.providers.some((provider) => providerHasModel(provider, modelName))
	);
}

export function findLegacyProviderForModel(modelName, options = {}) {
	const candidates = [];
	const tmpDir = options.tmpDir ?? "/private/tmp";
	const home = options.homeDir ?? homedir();
	const backupDir = options.backupDir ?? join(home, ".zaraa", "backups");
	const homeConfigDir = options.homeConfigDir ?? join(home, ".zaraa");

	try {
		const overlayFiles = readdirSync(tmpDir)
			.filter((file) => /^zaraa-overnight-refine-overlay-.*\.json$/i.test(file))
			.map((file) => join(tmpDir, file));
		candidates.push(...overlayFiles);
	} catch {}

	try {
		const backupFiles = readdirSync(backupDir)
			.filter((file) => /^zaraa\.config\..*\.json$/i.test(file))
			.map((file) => join(backupDir, file));
		candidates.push(...backupFiles);
	} catch {}

	try {
		const homeBackupFiles = readdirSync(homeConfigDir)
			.filter((file) => /^zaraa\.config\.backup-.*\.json$/i.test(file))
			.map((file) => join(homeConfigDir, file));
		candidates.push(...homeBackupFiles);
	} catch {}

	const sortedCandidates = candidates
		.filter((file, index) => candidates.indexOf(file) === index)
		.sort((left, right) => {
			try {
				return statSync(right).mtimeMs - statSync(left).mtimeMs;
			} catch {
				return 0;
			}
		});

	for (const path of sortedCandidates) {
		const parsed = readJsonFile(path);
		const provider = parsed?.providers?.find(
			(candidate) => isLoopbackLocalProvider(candidate) && providerHasModel(candidate, modelName),
		);
		if (provider) {
			return { provider, path };
		}
	}

	return null;
}

function buildUrl(baseUrl, pathName) {
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(pathName, normalizedBase).toString();
}

export function normalizeLoopbackBaseUrl(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
		return baseUrl;
	}

	try {
		const url = new URL(baseUrl);
		if (url.hostname === "localhost") {
			url.hostname = "127.0.0.1";
			return url.toString().replace(/\/$/, "");
		}
	} catch {
		// Leave non-URL strings untouched and let the caller handle them.
	}

	return baseUrl;
}

function getProbeUrls(provider) {
	const normalizedBaseUrl = normalizeLoopbackBaseUrl(provider?.baseUrl);
	if (provider?.type === "ollama") {
		return [buildUrl(normalizedBaseUrl || "http://127.0.0.1:11434", "api/tags")];
	}

	if (!normalizedBaseUrl) return [];
	const normalizedBase = normalizedBaseUrl.replace(/\/+$/, "");
	if (/\/v1$/i.test(normalizedBase)) {
		return [buildUrl(normalizedBase, "models")];
	}

	return [buildUrl(normalizedBase, "models"), buildUrl(normalizedBase, "v1/models")];
}

function extractModelNames(payload) {
	if (!payload || typeof payload !== "object") return [];

	const modelEntries = Array.isArray(payload.models)
		? payload.models
		: Array.isArray(payload.data)
			? payload.data
			: [];

	return modelEntries
		.map((entry) => entry?.name ?? entry?.model ?? entry?.id ?? null)
		.filter((name) => typeof name === "string" && name.length > 0);
}

/**
 * Detailed probe: distinguishes WHY a restore probe failed so callers can
 * treat a startup race (endpoint not up yet) differently from a genuinely
 * missing/unhealthy model. Reasons:
 *   - "model-found"          → healthy
 *   - "not-loopback"         → provider isn't a loopback local provider (or model not declared)
 *   - "no-fetch"             → no fetch implementation available
 *   - "model-missing"        → endpoint answered with a model list that lacks the model
 *   - "endpoint-unreachable" → no probe URL ever responded (connection refused / timeout);
 *                              typical during the daemon↔ollama launchd startup race
 */
export async function probeLoopbackLocalProviderModelDetailed(
	provider,
	modelName,
	options = {},
) {
	if (!isLoopbackLocalProvider(provider) || !providerHasModel(provider, modelName)) {
		return { healthy: false, reason: "not-loopback" };
	}

	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") return { healthy: false, reason: "no-fetch" };

	const timeoutMs = Math.max(250, Number(options.timeoutMs ?? 1_500));
	const attempts = Math.max(1, Number(options.attempts ?? 3));
	const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 750));
	const normalizedModelName = modelName.toLowerCase();
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		let endpointResponded = false;

		for (const url of getProbeUrls(provider)) {
			try {
				const response = await fetchImpl(url, {
					signal: AbortSignal.timeout(timeoutMs),
				});
				endpointResponded = true;
				if (!response.ok) continue;

				const payload = await response.json().catch(() => null);
				const modelNames = extractModelNames(payload);
				if (modelNames.some((candidate) => candidate.toLowerCase() === normalizedModelName)) {
					return { healthy: true, reason: "model-found" };
				}
				if (modelNames.length > 0) {
					return { healthy: false, reason: "model-missing" };
				}
			} catch {
				// Keep trying other probe URLs before giving up.
			}
		}

		if (endpointResponded) {
			return { healthy: false, reason: "model-missing" };
		}
		if (attempt < attempts - 1 && retryDelayMs > 0) {
			await sleep(retryDelayMs);
		}
	}

	return { healthy: false, reason: "endpoint-unreachable" };
}

export async function probeLoopbackLocalProviderModel(
	provider,
	modelName,
	options = {},
) {
	const { healthy } = await probeLoopbackLocalProviderModelDetailed(
		provider,
		modelName,
		options,
	);
	return healthy;
}

/**
 * Background re-probe chain for a startup-race probe failure ("endpoint-unreachable").
 * Instead of immediately starting the long restore cooldown, the caller can defer the
 * decision: if any deferred probe finds the model healthy, onHealthy() fires (typically
 * clearing the failure record so the next restart restores immediately); if every
 * deferred probe fails, onExhausted(lastReason) fires (typically recording the failure
 * to start the cooldown). Timers are unref'd so they never hold the process open.
 * Fully injectable (probeFn / setTimeoutImpl) for unit testing.
 */
/**
 * How often to re-log "skipping local provider restore" while still in cooldown.
 * Was 1h: level-up kickstarts every 15m re-warned once/hour for permanent
 * model-missing (qwen3.5-zaraa). Align with legacy-session-store 24h thrash stop.
 */
export const LOCAL_PROVIDER_RESTORE_SKIP_LOG_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * How long after a failed restore probe before re-probing on the next boot.
 * Was 6h: permanent model-missing still re-probed during long level-up days
 * (failedAt refreshed ~6h after prior fail). Match skip-log 24h thrash stop.
 */
export const LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * Permanent model-missing (qwen gone from Ollama) is not a transient race.
 * Live 2026-07-25: after the 24h probe cool-down expired, every kickstart still
 * re-walked overlay backups + 3s probe, then re-failed model-missing.
 * Hold model-missing for 7d so level-up/deploy storms do not re-scan daily.
 */
export const LOCAL_PROVIDER_RESTORE_MODEL_MISSING_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/** Default model for legacy local-deep restore (override / disable via env). */
export const DEFAULT_LOCAL_DEEP_RESTORE_MODEL = "qwen3.5-zaraa";

/**
 * Resolve which local-deep model to attempt restoring from overlay backups.
 * - env unset/null → default qwen3.5-zaraa (back-compat)
 * - env empty / whitespace → disabled (null) — thrash stop for permanent miss
 * - env non-empty → that model key
 */
export function resolveLocalDeepRestoreModel(envValue) {
	if (envValue === undefined || envValue === null) return DEFAULT_LOCAL_DEEP_RESTORE_MODEL;
	const trimmed = String(envValue).trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Probe cool-down for a ledger reason. model-missing uses the 7d permanent-miss
 * window (at least as long as the base cool-down / env override).
 */
export function resolveLocalProviderRestoreProbeCooldownMs(
	reason,
	baseCooldownMs = LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS,
) {
	const base =
		Number.isFinite(baseCooldownMs) && baseCooldownMs > 0
			? baseCooldownMs
			: LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS;
	if (reason === "model-missing") {
		return Math.max(base, LOCAL_PROVIDER_RESTORE_MODEL_MISSING_COOLDOWN_MS);
	}
	return base;
}

/**
 * True when a failure ledger entry is still inside the probe cooldown window.
 * Used to skip findLegacyProvider + deep-trace scans on every kickstart.
 */
export function shouldSkipRestoreDueToRecentFailure(ageMs, cooldownMs) {
	if (!Number.isFinite(ageMs) || ageMs < 0) return false;
	if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
	return ageMs <= cooldownMs;
}

/**
 * Canonical path for local-provider restore-failure cooldown ledger.
 * Live 2026-07-25 dual-file thrash: both `~/.zaraa/local-provider-restore-failures.json`
 * and `~/.zaraa/data/local-provider-restore-failures.json` existed with divergent
 * lastLogAt, so hourly skip-log rate-limit was ineffective across restarts.
 * Prefer env override, else dataDir when known, else home default — always one path.
 */
export function resolveLocalProviderRestoreFailureLogPath(input = {}) {
	const envPath =
		typeof input.envPath === "string" && input.envPath.trim() ? input.envPath.trim() : null;
	if (envPath) return envPath;
	const dataDir =
		typeof input.dataDir === "string" && input.dataDir.trim() ? input.dataDir.trim() : null;
	const defaultPath =
		typeof input.defaultPath === "string" && input.defaultPath.trim()
			? input.defaultPath.trim()
			: null;
	if (dataDir) {
		const sep = dataDir.includes("\\") && !dataDir.includes("/") ? "\\" : "/";
		const base = dataDir.endsWith(sep) ? dataDir.slice(0, -1) : dataDir;
		return `${base}${sep}local-provider-restore-failures.json`;
	}
	return defaultPath;
}

/**
 * Merge two restore-failure ledger objects, keeping the max failedAt/lastLogAt
 * per model so migrating dual files never rewinds cooldown windows.
 * reason prefers the entry that contributed the max failedAt (newer probe).
 */
export function mergeLocalProviderRestoreFailureLedgers(primary, secondary) {
	const out = {};
	const keys = new Set([
		...Object.keys(primary && typeof primary === "object" ? primary : {}),
		...Object.keys(secondary && typeof secondary === "object" ? secondary : {}),
	]);
	for (const key of keys) {
		const a = normalizeLocalProviderRestoreFailureEntry(primary?.[key]);
		const b = normalizeLocalProviderRestoreFailureEntry(secondary?.[key]);
		if (!a && !b) continue;
		if (!a) {
			out[key] = b;
			continue;
		}
		if (!b) {
			out[key] = a;
			continue;
		}
		const newer = a.failedAt >= b.failedAt ? a : b;
		const entry = {
			failedAt: Math.max(a.failedAt, b.failedAt),
			lastLogAt: Math.max(a.lastLogAt, b.lastLogAt),
		};
		if (newer.reason) entry.reason = newer.reason;
		else if (a.reason) entry.reason = a.reason;
		else if (b.reason) entry.reason = b.reason;
		out[key] = entry;
	}
	return out;
}

/**
 * Normalize restore-failure ledger values.
 * Legacy shape: `{ "qwen3.5-zaraa": <failedAtMs> }`
 * Current shape: `{ "qwen3.5-zaraa": { failedAt, lastLogAt, reason? } }`
 */
export function normalizeLocalProviderRestoreFailureEntry(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return { failedAt: raw, lastLogAt: 0 };
	}
	if (raw && typeof raw === "object") {
		const failedAt = Number(raw.failedAt);
		if (!Number.isFinite(failedAt) || failedAt <= 0) return null;
		const lastLogAt = Number(raw.lastLogAt);
		const reason =
			typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : undefined;
		const entry = {
			failedAt,
			lastLogAt: Number.isFinite(lastLogAt) && lastLogAt > 0 ? lastLogAt : 0,
		};
		if (reason) entry.reason = reason;
		return entry;
	}
	return null;
}

/** True when a cooldown skip warn may be emitted (first time or after logCooldownMs). */
export function shouldLogLocalProviderRestoreSkip(
	entry,
	nowMs = Date.now(),
	logCooldownMs = LOCAL_PROVIDER_RESTORE_SKIP_LOG_COOLDOWN_MS,
) {
	if (!entry) return true;
	const last = Number(entry.lastLogAt) || 0;
	if (last <= 0) return true;
	if (!Number.isFinite(nowMs) || !Number.isFinite(logCooldownMs) || logCooldownMs <= 0) return true;
	return nowMs - last >= logCooldownMs;
}

export function scheduleLocalProviderRestoreReprobe(
	provider,
	modelName,
	options = {},
) {
	const delaysMs = Array.isArray(options.delaysMs) && options.delaysMs.length > 0
		? options.delaysMs.map((n) => Math.max(0, Number(n) || 0))
		: [90_000, 300_000, 900_000];
	const probeFn = options.probeFn ?? probeLoopbackLocalProviderModelDetailed;
	const probeOptions = { timeoutMs: 10_000, attempts: 2, ...(options.probeOptions ?? {}) };
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const onHealthy = typeof options.onHealthy === "function" ? options.onHealthy : () => {};
	const onExhausted = typeof options.onExhausted === "function" ? options.onExhausted : () => {};

	let index = 0;
	let lastReason = "endpoint-unreachable";

	const runNext = () => {
		if (index >= delaysMs.length) {
			onExhausted(lastReason);
			return;
		}
		const delay = delaysMs[index];
		index += 1;
		const timer = setTimeoutImpl(async () => {
			try {
				const { healthy, reason } = await probeFn(provider, modelName, probeOptions);
				if (healthy) {
					onHealthy();
					return;
				}
				lastReason = reason ?? "probe-failed";
			} catch {
				lastReason = "probe-error";
			}
			runNext();
		}, delay);
		if (timer && typeof timer.unref === "function") timer.unref();
	};

	runNext();
}

export function getLatencySensitiveLocalModelRestoreHealth(modelName, options = {}) {
	const normalizedModelName = stripProviderNamespace(modelName);
	if (!normalizedModelName.includes("qwen3.5-zaraa")) {
		return {
			degraded: false,
			reason: null,
			traceCount: 0,
			recentAverageLatencyMs: null,
		};
	}

	const home = options.homeDir ?? homedir();
	const dataDir = options.dataDir ?? join(home, ".zaraa", "data");
	const traceDbPath = options.traceDbPath ?? join(dataDir, "traces.db");
	if (!existsSync(traceDbPath)) {
		return {
			degraded: false,
			reason: null,
			traceCount: 0,
			recentAverageLatencyMs: null,
		};
	}

	const lookbackMs = Math.max(60_000, Number(options.lookbackMs ?? 12 * 60 * 60_000));
	const recentTraceLimit = Math.max(3, Number(options.recentTraceLimit ?? 6));
	const timeoutGradeLatencyMs = Math.max(
		20_000,
		Number(options.timeoutGradeLatencyMs ?? 30_000),
	);
	const nearCliffLatencyMs = Math.max(
		20_000,
		Math.min(timeoutGradeLatencyMs, Number(options.nearCliffLatencyMs ?? 25_000)),
	);
	const degradedAverageLatencyMs = Math.max(
		timeoutGradeLatencyMs,
		Number(options.degradedAverageLatencyMs ?? 36_000),
	);
	const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
	let db;

	try {
		db = new Database(traceDbPath, { readonly: true, fileMustExist: true });
		const rows = db
			.prepare(
				`
					SELECT model, success, latencyMs, timestamp
					FROM traces
					WHERE taskType = 'deep'
						AND timestamp >= ?
						AND (
							LOWER(model) = ?
							OR LOWER(model) LIKE ?
						)
					ORDER BY timestamp DESC
					LIMIT ?
				`,
			)
			.all(sinceIso, normalizedModelName, `%:${normalizedModelName}`, recentTraceLimit);

		const traces = rows.filter((row) => modelNamesEquivalent(row.model, normalizedModelName));
		if (traces.length === 0) {
			return {
				degraded: false,
				reason: null,
				traceCount: 0,
				recentAverageLatencyMs: null,
			};
		}

		const recentWindow = traces.slice(0, Math.min(traces.length, 3));
		const averageLatencyMs = Math.round(
			recentWindow.reduce((total, trace) => total + Number(trace.latencyMs || 0), 0) /
				recentWindow.length,
		);
		const recentFailure = recentWindow.find((trace) => !trace.success);
		if (recentFailure) {
			return {
				degraded: true,
				reason: `recent deep failure at ${Number(recentFailure.latencyMs || 0)}ms`,
				traceCount: traces.length,
				recentAverageLatencyMs: averageLatencyMs,
			};
		}

		if (recentWindow.some((trace) => Number(trace.latencyMs || 0) >= timeoutGradeLatencyMs)) {
			return {
				degraded: true,
				reason: `recent deep trace reached ${timeoutGradeLatencyMs}ms timeout grade`,
				traceCount: traces.length,
				recentAverageLatencyMs: averageLatencyMs,
			};
		}

		if (
			recentWindow.length >= 3 &&
			recentWindow.every((trace) => Number(trace.latencyMs || 0) >= nearCliffLatencyMs)
		) {
			return {
				degraded: true,
				reason: `three recent deep traces stayed above ${nearCliffLatencyMs}ms`,
				traceCount: traces.length,
				recentAverageLatencyMs: averageLatencyMs,
			};
		}

		if (
			recentWindow.length >= 3 &&
			averageLatencyMs >= degradedAverageLatencyMs
		) {
			return {
				degraded: true,
				reason: `recent deep average ${averageLatencyMs}ms exceeds ${degradedAverageLatencyMs}ms`,
				traceCount: traces.length,
				recentAverageLatencyMs: averageLatencyMs,
			};
		}

		return {
			degraded: false,
			reason: null,
			traceCount: traces.length,
			recentAverageLatencyMs: averageLatencyMs,
		};
	} catch {
		return {
			degraded: false,
			reason: null,
			traceCount: 0,
			recentAverageLatencyMs: null,
		};
	} finally {
		db?.close();
	}
}
