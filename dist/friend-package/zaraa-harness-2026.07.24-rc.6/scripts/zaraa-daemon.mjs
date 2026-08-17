import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

function resolveRuntimeHomeDir() {
  const raw = process.env.ZARAA_HOME_DIR;
  if (raw === undefined) return homedir();
  const value = raw.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error('ZARAA_HOME_DIR must be a non-empty absolute path');
  }
  const resolved = resolve(value);
  if (dirname(resolved) === resolved) throw new Error('ZARAA_HOME_DIR cannot be a filesystem root');
  return resolved;
}

const RUNTIME_HOME_DIR = resolveRuntimeHomeDir();
process.env.ZARAA_PROVIDER_BUDGET_SKIP_LOG_STATE ||= join(
  RUNTIME_HOME_DIR,
  '.zaraa',
  'state',
  'provider-budget-skip-log.json',
);

function installTimestampedStderr() {
  const write = process.stderr.write.bind(process.stderr);
  let pending = '';

  const writeLine = (line) => write(`${new Date().toISOString()} ${line}\n`);

  process.stderr.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk);
    const lines = `${pending}${text}`.split('\n');
    pending = lines.pop() ?? '';
    let ok = true;
    for (const line of lines) {
      ok = writeLine(line) && ok;
    }
    callback?.();
    return ok;
  };

  process.on('exit', () => {
    if (pending) {
      writeLine(pending);
      pending = '';
    }
  });
}

installTimestampedStderr();

function checkConfigFilePermissions() {
  const candidates = [
    join(RUNTIME_HOME_DIR, '.zaraa', 'zaraa.config.json'),
    join(RUNTIME_HOME_DIR, '.zaraa', 'config.json'),
  ];
  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    const mode = statSync(configPath).mode;
    const tooOpen = mode & 0o077;
    if (tooOpen) {
      const octal = '0' + (mode & 0o777).toString(8);
      console.warn(`[zaraa-daemon] SECURITY WARNING: ${configPath} has permissions ${octal} — run: chmod 600 "${configPath}"`);
    }
    break;
  }
}
checkConfigFilePermissions();
import {
  configHasProviderForModel,
  findLegacyProviderForModel,
  getLatencySensitiveLocalModelRestoreHealth,
  LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS,
  resolveLocalDeepRestoreModel,
  resolveLocalProviderRestoreProbeCooldownMs,
  shouldSkipRestoreDueToRecentFailure,
  normalizeLocalProviderRestoreFailureEntry,
  normalizeLoopbackBaseUrl,
  probeLoopbackLocalProviderModelDetailed,
  readJsonFile,
  readTaskActivitySummaryFromDb,
  recordDaemonRestart,
  resolveDaemonServiceLabel,
  resolveDaemonPidFilePath,
  resolveStartupRuntimePauseMs,
  scheduleLocalProviderRestoreReprobe,
  shouldBlockSignalShutdownForActiveProof,
  shouldDrainShutdownForTaskActivity,
  shouldExitAsOrphanedHarnessChild,
  shouldLogLocalProviderRestoreSkip,
  shouldRemoveDaemonPidFile,
  shouldReassertLock,
  tryAcquireSingletonProcessLock,
  resolveSingletonLiveOwnerWaitMs,
  resolveLocalProviderRestoreFailureLogPath as resolveRestoreFailureLogPathPure,
  mergeLocalProviderRestoreFailureLedgers,
  shouldExitForExpiredProofWindow,
} from './zaraa-daemon-lib.mjs';
import { writeDaemonExitIntent, writeDaemonStartIntent } from './lib/restart-intent.mjs';

const CORE_MODULE_URL = new URL('../packages/core/dist/launcher.js', import.meta.url).href;
const TASKS_DB_PATH = join(RUNTIME_HOME_DIR, '.zaraa', 'data', 'tasks.db');
const HEARTBEAT_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.ZARAA_DAEMON_HEARTBEAT_INTERVAL_MS ?? 10_000),
);
const SIGTERM_TASK_DRAIN_MS = Math.max(
  0,
  Number(process.env.ZARAA_SIGTERM_TASK_DRAIN_MS ?? 180_000),
);
const SIGTERM_TASK_DRAIN_POLL_MS = Math.max(
  250,
  Number(process.env.ZARAA_SIGTERM_TASK_DRAIN_POLL_MS ?? 2_000),
);
const PROOF_SIGNAL_GUARD_SECOND_SIGTERM_FORCE_MS = Math.max(
  5_000,
  Number(process.env.ZARAA_PROOF_SIGNAL_GUARD_SECOND_SIGTERM_FORCE_MS ?? 30_000),
);
if (
  process.env.ZARAA_SIGTERM_TASK_DRAIN !== '0' &&
  !process.env.ZARAA_LAUNCHER_SIGNAL_SHUTDOWN_TIMEOUT_MS
) {
  process.env.ZARAA_LAUNCHER_SIGNAL_SHUTDOWN_TIMEOUT_MS = String(SIGTERM_TASK_DRAIN_MS + 10_000);
}

// Pin the daemon event loop immediately. Some HTTP/server timers are unref'ed
// during startup, and launchd treats a short-lived daemon as crash-looping even
// when the gateway briefly becomes ready. Keep this referenced until graceful
// shutdown clears it.
const heartbeatTimer = setInterval(() => {
  rotateLogIfNeeded(join(RUNTIME_HOME_DIR, '.zaraa', 'logs', 'daemon.log'));
  rotateLogIfNeeded(join(RUNTIME_HOME_DIR, '.zaraa', 'logs', 'daemon-error.log'));
  rotateLogIfNeeded(join(RUNTIME_HOME_DIR, '.zaraa', 'crash.log'));
  console.log(`[zaraa-daemon] ${new Date().toISOString()} alive`);
}, HEARTBEAT_INTERVAL_MS);

function isTransientModuleReadError(err) {
  return (
    err?.syscall === 'read' ||
    err?.errno === -11 ||
    /\b(?:EAGAIN|Unknown system error -11)\b/i.test(String(err?.message ?? err))
  );
}

async function importCoreWithRetry(maxAttempts = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cacheBuster = attempt === 1 ? '' : `?retry=${attempt}-${Date.now()}`;
      return await import(`${CORE_MODULE_URL}${cacheBuster}`);
    } catch (err) {
      lastErr = err;
      if (!isTransientModuleReadError(err) || attempt === maxAttempts) break;
      const delayMs = 250 * attempt;
      console.warn(
        `[zaraa-daemon] Core module import hit transient read error; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// Lock model routing so runtime-mode auto-selection cannot rewrite config.models
// on every pause/resume cycle. Without this, "fast" mode keeps escalating to the
// subscription tier (composer-2-fast / gpt-5.5) and clobbering operator overrides
// every ~3 minutes. See zaraa.ts applyRuntimeModeRouting for the gate. Operators
// can override by setting ZARAA_LOCK_MODEL_ROUTING=false in their environment.
if (process.env.ZARAA_LOCK_MODEL_ROUTING === undefined) {
  process.env.ZARAA_LOCK_MODEL_ROUTING = 'true';
}
if (process.env.ZARAA_LOOPBACK_HTTP_PROVIDER_STARTUP_RECOVERY_TIMEOUT_MS === undefined) {
  process.env.ZARAA_LOOPBACK_HTTP_PROVIDER_STARTUP_RECOVERY_TIMEOUT_MS = '3000';
}

// Validation/sibling daemons must NOT poll ~/Library/Messages/chat.db.
// Only one daemon at a time may stand up the iMessage poller — otherwise
// both processes race the same chat.db with separate per-DataDir claim
// stores and the user sees duplicate or contention-stalled replies. The
// validation daemon plist sets a non-default ZARAA_DATA_DIR / lock dir
// containing "validation"; detect that here so the guard takes effect
// even if the plist hasn't been updated to set ZARAA_DISABLE_IMESSAGE
// explicitly. Operators can override by setting ZARAA_DISABLE_IMESSAGE=0.
if (process.env.ZARAA_DISABLE_IMESSAGE === undefined) {
  const validationSignal =
    process.env.ZARAA_DATA_DIR?.toLowerCase().includes('validation') ||
    process.env.ZARAA_DAEMON_LOCK_DIR?.toLowerCase().includes('validation');
  if (validationSignal) {
    process.env.ZARAA_DISABLE_IMESSAGE = '1';
  }
}

// ── Crash-loop detection ────────────────────────────────────────────
const RESTART_LOG = process.env.ZARAA_RESTART_LOG ?? join(RUNTIME_HOME_DIR, '.zaraa', 'restart-log.json');
const RESTART_INTENT_LOG = process.env.ZARAA_RESTART_INTENT_LOG ?? join(RUNTIME_HOME_DIR, '.zaraa', 'restart-intents.jsonl');
let lastProofSignalGuardBlock = { signal: null, atMs: 0 };
const SERVICE_LABEL = resolveDaemonServiceLabel({
  zaraaServiceLabel: process.env.ZARAA_SERVICE_LABEL,
  zaraaLaunchdLabel: process.env.ZARAA_LAUNCHD_LABEL,
  launchdLabel: process.env.LAUNCHD_LABEL,
  zaraaDataDir: process.env.ZARAA_DATA_DIR,
  zaraaDaemonLockDir: process.env.ZARAA_DAEMON_LOCK_DIR,
});
// Proof-scoped installs set ZARAA_PROOF_START_PATH explicitly (ship-rc5, clean-install
// soak). After the 24h window, exit cleanly so launchd does not keep a zombie proof
// daemon on shared Ollama/CPU (live 2026-07-25: ship-rc5 still up at ~30h).
{
  const explicitProofPath = process.env.ZARAA_PROOF_START_PATH?.trim();
  if (explicitProofPath) {
    const expired = shouldExitForExpiredProofWindow({
      proofStartPath: explicitProofPath,
      serviceLabel: SERVICE_LABEL,
      nowMs: Date.now(),
    });
    if (expired.exit) {
      console.warn(
        `[zaraa-daemon] ${SERVICE_LABEL}: ${expired.reason} — exiting (expired proof thrash stop)`,
      );
      process.exit(0);
    }
  }
}
const DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG =
  process.env.ZARAA_LOCAL_PROVIDER_RESTORE_FAILURE_LOG ??
  join(RUNTIME_HOME_DIR, '.zaraa', 'local-provider-restore-failures.json');
let dataDir = null;

function readExitQueueSummary() {
  try {
    const activity = readTaskActivitySummaryFromDb(TASKS_DB_PATH);
    return {
      running: activity.running,
      pending: activity.pending,
      blocked: activity.blocked,
    };
  } catch {
    return undefined;
  }
}

function writeDaemonProcessExitIntent({ source, reason, signal, extra } = {}) {
  return writeDaemonExitIntent({
    path: RESTART_INTENT_LOG,
    pid: process.pid,
    source,
    reason,
    signal,
    queue: readExitQueueSummary(),
    extra,
  });
}

function recordRestart() {
  return recordDaemonRestart({
    path: RESTART_LOG,
    serviceLabel: SERVICE_LABEL,
    // Exclude launchctl kickstart / deploy graceful exits from crashLoop (level-up thrash stop).
    restartIntentPath: RESTART_INTENT_LOG,
  });
}

function resolveLocalProviderRestoreFailureLogPath(forWrite = false) {
  // Single canonical path (env → dataDir → home). Dual-file thrash fixed 2026-07-25.
  const path = resolveRestoreFailureLogPathPure({
    envPath: process.env.ZARAA_LOCAL_PROVIDER_RESTORE_FAILURE_LOG,
    dataDir,
    defaultPath: DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG,
  });
  if (!path) return DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG;
  if (forWrite) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      accessSync(dirname(path), fsConstants.R_OK | fsConstants.W_OK);
      return path;
    } catch {
      // Fall back to home default if dataDir is unwritable.
      if (path !== DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG) {
        try {
          mkdirSync(dirname(DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG), { recursive: true });
          return DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG;
        } catch {
          /* ignore */
        }
      }
      return path;
    }
  }
  return path;
}

function readJsonObjectIfExists(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readLocalProviderRestoreFailures() {
  try {
    const failureLogPath = resolveLocalProviderRestoreFailureLogPath();
    const primary = readJsonObjectIfExists(failureLogPath);
    // One-shot merge of the legacy dual path so lastLogAt never rewinds.
    const legacyHome = DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG;
    if (
      failureLogPath &&
      legacyHome &&
      failureLogPath !== legacyHome &&
      existsSync(legacyHome)
    ) {
      const secondary = readJsonObjectIfExists(legacyHome);
      const merged = mergeLocalProviderRestoreFailureLedgers(primary, secondary);
      // Persist merge + drop legacy home immediately (don't wait for next skip log).
      writeLocalProviderRestoreFailures(merged);
      return merged;
    }
    return primary;
  } catch {
    return {};
  }
}

function writeLocalProviderRestoreFailures(failures) {
  try {
    const path = resolveLocalProviderRestoreFailureLogPath(true);
    writeFileSync(path, JSON.stringify(failures), { mode: 0o600 });
    // Drop legacy home dual-file so restarts don't re-merge stale lastLogAt.
    const legacyHome = DEFAULT_LOCAL_PROVIDER_RESTORE_FAILURE_LOG;
    if (path && legacyHome && path !== legacyHome && existsSync(legacyHome)) {
      try {
        rmSync(legacyHome, { force: true });
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // Non-fatal: startup should continue even if the cooldown cache can't be updated.
  }
}

function getRecentLocalProviderRestoreFailure(modelName, baseCooldownMs) {
  const failures = readLocalProviderRestoreFailures();
  const entry = normalizeLocalProviderRestoreFailureEntry(failures?.[modelName]);
  if (!entry) return null;
  // model-missing uses 7d cool-down even when env base is 24h (permanent miss thrash stop).
  const cooldownMs = resolveLocalProviderRestoreProbeCooldownMs(entry.reason, baseCooldownMs);
  if (cooldownMs <= 0) return null;
  const ageMs = Date.now() - entry.failedAt;
  if (ageMs > cooldownMs) return null;
  return {
    failedAt: entry.failedAt,
    ageMs,
    lastLogAt: entry.lastLogAt,
    reason: entry.reason,
    cooldownMs,
  };
}

function recordLocalProviderRestoreFailure(modelName, reason) {
  const failures = readLocalProviderRestoreFailures();
  const prev = normalizeLocalProviderRestoreFailureEntry(failures?.[modelName]);
  const nextReason =
    typeof reason === "string" && reason.trim()
      ? reason.trim()
      : prev?.reason;
  const next = {
    failedAt: Date.now(),
    lastLogAt: prev?.lastLogAt ?? 0,
  };
  if (nextReason) next.reason = nextReason;
  failures[modelName] = next;
  writeLocalProviderRestoreFailures(failures);
}

/** Rate-limit any "skipping qwen restore" warn to once per 24h across restarts. */
function logLocalProviderRestoreSkipOnce(modelName, message) {
  const failures = readLocalProviderRestoreFailures();
  const entry = normalizeLocalProviderRestoreFailureEntry(failures?.[modelName]) ?? {
    failedAt: Date.now(),
    lastLogAt: 0,
  };
  if (!shouldLogLocalProviderRestoreSkip(entry)) return false;
  console.warn(message);
  const next = { failedAt: entry.failedAt, lastLogAt: Date.now() };
  if (entry.reason) next.reason = entry.reason;
  failures[modelName] = next;
  writeLocalProviderRestoreFailures(failures);
  return true;
}

function clearLocalProviderRestoreFailure(modelName) {
  const failures = readLocalProviderRestoreFailures();
  if (!(modelName in failures)) return;
  delete failures[modelName];
  writeLocalProviderRestoreFailures(failures);
}

// ── Log rotation ─────────────────────────────────────────────────────
// Rotates the daemon log if it exceeds 10MB. Keeps last 3 rotated logs.
function rotateLogIfNeeded(logPath) {
  try {
    if (!existsSync(logPath)) return;
    const maxBytes = 10 * 1024 * 1024; // 10MB
    if (statSync(logPath).size < maxBytes) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(logPath, `${logPath}.${ts}`);
    // launchd keeps stdout/stderr file descriptors open; truncate the same inode
    // so uninterrupted daemon writes continue at the base path after rotation.
    writeFileSync(logPath, '');
    const dir = dirname(logPath);
    const base = logPath.slice(dir.length + 1);
    try {
      const rotated = readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`))
        .sort()
        .reverse()
        .slice(3);
      for (const f of rotated) rmSync(join(dir, f), { force: true });
    } catch {}
  } catch {
    // Non-fatal: log rotation failure should not prevent daemon startup.
  }
}

// ── Startup diagnostic (fire-and-forget) ────────────────────────────
async function startupDiagnostic(restart, zara) {
  try {
    const manager = zara.getNotificationManager?.();
    if (!manager) return;
    const channels = manager.getChannels().filter((name) => name === 'imessage' || name === 'os');
    if (channels.length === 0) return;
    const crashLogPath = join(RUNTIME_HOME_DIR, '.zaraa', 'crash.log');
    const lastError = existsSync(crashLogPath)
      ? readFileSync(crashLogPath, 'utf-8').trim().split(/\n\n+/).at(-1)?.split('\n').slice(0, 2).join(' — ').slice(0, 240)
      : undefined;
    if (restart.crashStormAlert) {
      await manager.notify(
        `Zaraa restarted ${restart.recentCount} times in 10 minutes — something is wrong.${lastError ? ` Last error: ${lastError}` : ''}`,
        { title: 'Zaraa crash storm', priority: 'high', channels, throttleKey: 'daemon-crash-storm' },
      );
    } else if (restart.backOnlineAlert) {
      await manager.notify('Back online. Gateway health: OK.', {
        title: 'Zaraa back online', priority: 'normal', channels, throttleKey: 'daemon-back-online',
      });
    }
  } catch (err) {
    console.warn(`[zaraa-daemon] Startup diagnostic error: ${err.message || err}`);
  }
}

// Ensure ~/.local/bin is in PATH so Claude CLI is reachable
const localBin = join(RUNTIME_HOME_DIR, '.local', 'bin');
if (!process.env.PATH?.includes(localBin)) {
  process.env.PATH = `${localBin}:${process.env.PATH}`;
}

function isWritableDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getWorkspaceFallbackDataDir() {
  const cwd = process.cwd();
  const explicitFallback = process.env.ZARAA_FALLBACK_DATA_DIR?.trim();
  const candidates = [];

  if (explicitFallback) {
    candidates.push(explicitFallback);
  }

  try {
    const timestampedDirs = readdirSync(cwd)
      .filter((entry) => entry.startsWith('.zaraa-data-runtime-'))
      .map((entry) => join(cwd, entry))
      .filter((entry) => {
        try {
          return statSync(entry).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((left, right) => {
        try {
          return statSync(right).mtimeMs - statSync(left).mtimeMs;
        } catch {
          return 0;
        }
      });
    candidates.push(...timestampedDirs);
  } catch {
    // Non-fatal: keep the deterministic workspace fallback below.
  }

  const freshWorkspaceDir = join(cwd, `.zaraa-data-runtime-${Math.floor(Date.now() / 1000)}`);
  candidates.push(freshWorkspaceDir);

  const defaultWorkspaceDir = join(cwd, '.zaraa-data-runtime');
  candidates.push(defaultWorkspaceDir);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isWritableDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveDataDir() {
  const explicitDataDir = process.env.ZARAA_DATA_DIR?.trim();
  if (explicitDataDir) {
    return explicitDataDir;
  }

  const defaultDataDir = join(RUNTIME_HOME_DIR, '.zaraa', 'data');
  if (isWritableDirectory(defaultDataDir)) {
    return defaultDataDir;
  }

  const workspaceFallback = getWorkspaceFallbackDataDir();
  if (workspaceFallback) {
    console.warn(
      `[zaraa-daemon] Default data dir is not writable (${defaultDataDir}); using workspace fallback ${workspaceFallback}`,
    );
    return workspaceFallback;
  }

  console.warn(
    `[zaraa-daemon] Default data dir is not writable (${defaultDataDir}); retrying with it because no writable fallback was found`,
  );
  return defaultDataDir;
}

dataDir = resolveDataDir();
const restart = recordRestart();
const crashLoop = restart.crashLoop;

// Auto-resolve the validation-daemon's mirror trading.db path so
// trade_paper_reset can clear poisoned peaks in BOTH databases without
// requiring the operator to set ZARAA_TRADING_MIRROR_DB by hand. The
// validation runtime config is the source of truth for the mirror
// dataDir; only do this on the live daemon (validation daemons signal
// themselves via the "validation" prefix in their data/lock dirs).
if (process.env.ZARAA_TRADING_MIRROR_DB === undefined) {
  const isValidationDaemon =
    process.env.ZARAA_DATA_DIR?.toLowerCase().includes('validation') ||
    process.env.ZARAA_DAEMON_LOCK_DIR?.toLowerCase().includes('validation');
  if (!isValidationDaemon) {
    try {
      const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));
      const validationConfigPath = join(repoRoot, 'scripts', 'trading-validation-runtime.config.json');
      if (existsSync(validationConfigPath)) {
        const validationConfig = JSON.parse(readFileSync(validationConfigPath, 'utf-8'));
        if (validationConfig?.dataDir && typeof validationConfig.dataDir === 'string') {
          const mirrorDataDir = validationConfig.dataDir.startsWith('/')
            ? validationConfig.dataDir
            : join(repoRoot, validationConfig.dataDir);
          process.env.ZARAA_TRADING_MIRROR_DB = join(mirrorDataDir, 'trading.db');
        }
      }
    } catch (err) {
      console.warn(
        '[zaraa-daemon] Could not auto-resolve validation mirror trading.db path:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Rotate logs before startup (item 5) ─────────────────────────────
const logDir = join(RUNTIME_HOME_DIR, '.zaraa', 'logs');
rotateLogIfNeeded(join(logDir, 'daemon.log'));
rotateLogIfNeeded(join(logDir, 'daemon-error.log'));
// crash.log is append-only inside the crash handlers; rotate it on startup
// so it never grows unbounded across many crash cycles.
rotateLogIfNeeded(join(RUNTIME_HOME_DIR, '.zaraa', 'crash.log'));

// ── Config JSON validation (item 8) ─────────────────────────────────
// Validate config is parseable JSON before starting. Full schema validation
// happens inside loadConfig (called by launch()), but catching JSON syntax
// errors here produces a clearer error message.
const configFilePath = join(RUNTIME_HOME_DIR, '.zaraa', 'zaraa.config.json');
if (existsSync(configFilePath)) {
  try {
    JSON.parse(readFileSync(configFilePath, 'utf-8'));
  } catch (err) {
    console.error(`[zaraa-daemon] FATAL: zaraa.config.json is not valid JSON: ${err.message}`);
    console.error('[zaraa-daemon] Fix the config file before starting the daemon.');
    writeDaemonProcessExitIntent({
      source: 'zaraa-daemon.configValidation',
      reason: `invalid zaraa.config.json: ${err.message}`,
    });
    process.exit(1);
  }
} else {
  console.warn('[zaraa-daemon] No zaraa.config.json found — using defaults.');
}

// ── DB backup (item 4) ───────────────────────────────────────────────
// Copy SQLite databases (+ WAL/SHM sidecars) to ~/.zaraa/backups/ with
// timestamp suffix. Runs before launch() so backups reflect pre-startup
// state. In crash-loop mode the backup remains active but bounded:
//   - skip per-DB when a backup younger than FRESH_BACKUP_AGE_MS exists
//   - skip files larger than MAX_DB_BACKUP_BYTES
//   - bail entirely when total time exceeds CRASH_LOOP_BACKUP_BUDGET_MS
// The pre-launch moment is the highest-risk time for DB corruption from
// a bad migration or partial recovery, so skipping outright (as the old
// code did) left no rollback target for the operator.
// Keeps only the last 5 backups per file pattern.
{
  const backupDir = join(RUNTIME_HOME_DIR, '.zaraa', 'backups');
  const FRESH_BACKUP_AGE_MS = 30 * 60 * 1000;
  // 512MB so the two largest, most-important DBs keep a pre-launch rollback
  // target: tasks.db (~218MB — the full task queue + autonomy run history, now
  // under a migration system that could fail mid-startup) and memory.db (~191MB
  // and growing ~40MB/week, so a 200MB cap would silently drop its backup within
  // days). The crash-loop path still bounds total copy time via
  // CRASH_LOOP_BACKUP_BUDGET_MS + hasFreshBackup, so raising the cap can't make
  // a crash loop slower; it only restores rollback coverage on healthy startups.
  const MAX_DB_BACKUP_BYTES = 512 * 1024 * 1024;
  const CRASH_LOOP_BACKUP_BUDGET_MS = 30_000;
  // trade-journal.db holds shadow trades + strategy_trades — losing it on
  // an unclean shutdown would erase journal/analytics history.
  const DB_BACKUP_LIST = ['memory.db', 'trading.db', 'tasks.db', 'trade-journal.db'];
  // SQLite WAL/SHM sidecars hold uncheckpointed pages. Restoring a .db
  // without them risks losing the most recent writes.
  const SQLITE_SIDECARS = ['', '-wal', '-shm'];
  try {
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const startedAt = Date.now();
    const budgetMs = crashLoop ? CRASH_LOOP_BACKUP_BUDGET_MS : Number.POSITIVE_INFINITY;

    outer: for (const dbName of DB_BACKUP_LIST) {
      if (Date.now() - startedAt > budgetMs) {
        console.warn(`[zaraa-daemon] DB backup budget (${budgetMs}ms) exhausted — skipping remaining DBs`);
        break;
      }
      if (crashLoop && hasFreshBackup(backupDir, dbName, FRESH_BACKUP_AGE_MS)) {
        // Already have a recent rollback target; don't burn startup time
        // copying it again.
        continue;
      }
      for (const suffix of SQLITE_SIDECARS) {
        if (Date.now() - startedAt > budgetMs) break outer;
        const src = join(dataDir, dbName + suffix);
        if (!existsSync(src)) continue;
        try {
          const size = statSync(src).size;
          if (size > MAX_DB_BACKUP_BYTES) {
            console.warn(`[zaraa-daemon] DB backup skipped for ${dbName}${suffix}: ${size} bytes exceeds ${MAX_DB_BACKUP_BYTES} cap`);
            continue;
          }
          copyFileSync(src, join(backupDir, `${dbName}${suffix}.${ts}`));
        } catch (err) {
          console.warn(`[zaraa-daemon] DB backup failed for ${dbName}${suffix}: ${err.message}`);
        }
      }
    }
    // Trim to 5 most-recent backups per file pattern (db + each sidecar).
    for (const dbName of DB_BACKUP_LIST) {
      for (const suffix of SQLITE_SIDECARS) {
        const prefix = `${dbName}${suffix}.`;
        try {
          const old = readdirSync(backupDir)
            .filter((f) => f.startsWith(prefix))
            .sort()
            .reverse()
            .slice(5);
          for (const f of old) rmSync(join(backupDir, f), { force: true });
        } catch {}
      }
    }
    console.log(`[zaraa-daemon] DB backup to ${backupDir}${crashLoop ? ' (crash-loop, bounded)' : ''}`);
  } catch (err) {
    console.warn(`[zaraa-daemon] DB backup step failed: ${err.message}`);
  }
}

function hasFreshBackup(backupDir, dbName, maxAgeMs) {
  if (!existsSync(backupDir)) return false;
  try {
    const matches = readdirSync(backupDir).filter((f) => f.startsWith(`${dbName}.`));
    if (matches.length === 0) return false;
    const cutoff = Date.now() - maxAgeMs;
    for (const f of matches) {
      try {
        if (statSync(join(backupDir, f)).mtimeMs >= cutoff) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}


// Wait for a live predecessor's graceful drain on kickstart. Default is
// SIGTERM drain + 15s (not a fixed 90s) so a long drain cannot outlive the
// successor's singleton wait and thrash KeepAlive (live 2026-07-26 residual).
// Override with ZARAA_DAEMON_LOCK_WAIT_MS when needed.
const singletonLock = tryAcquireSingletonProcessLock({
  homeDir: RUNTIME_HOME_DIR,
  lockDir: process.env.ZARAA_DAEMON_LOCK_DIR?.trim() || undefined,
  liveOwnerWaitMs: resolveSingletonLiveOwnerWaitMs({
    explicitWaitMs: process.env.ZARAA_DAEMON_LOCK_WAIT_MS,
    sigtermTaskDrainMs: SIGTERM_TASK_DRAIN_MS,
  }),
  liveOwnerPollMs: Number(process.env.ZARAA_DAEMON_LOCK_POLL_MS ?? 2_000),
});
if (!singletonLock.acquired) {
  console.warn(
    `[zaraa-daemon] Another daemon instance is already running` +
      (singletonLock.existingPid ? ` (pid ${singletonLock.existingPid})` : '') +
      ' — exiting.',
  );
  writeDaemonProcessExitIntent({
    source: 'zaraa-daemon.singletonLock',
    reason: 'another daemon instance is already running',
    extra: { existingPid: singletonLock.existingPid ?? null },
  });
  process.exit(0);
}

// ── PID file (item 7) ────────────────────────────────────────────────
// Main daemon owns the legacy ~/.zaraa/zaraa.pid. Sibling daemons get scoped
// pid files so they cannot make watchdogs target the wrong process.
const pidFile = resolveDaemonPidFilePath({
  serviceLabel: SERVICE_LABEL,
  homeDir: RUNTIME_HOME_DIR,
  zaraaPidFile: process.env.ZARAA_PID_FILE,
});
try {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
} catch {}

process.on('exit', () => {
  singletonLock.release();
  try {
    const pidFileContent = readFileSync(pidFile, 'utf-8');
    if (shouldRemoveDaemonPidFile({ pidFileContent, pid: process.pid })) {
      rmSync(pidFile, { force: true });
    }
  } catch {}
});

// ── Singleton-lock self-heal watchdog ────────────────────────────────
// The lock dir can vanish out from under a live daemon (observed
// 2026-07-06: validation lock lived under iCloud-synced ~/Documents and
// fileproviderd tombstone convergence deleted the re-created dir ~60s
// after acquisition). A lockless daemon is invisible to singleton
// arbitration, so a contender would boot a duplicate. Re-assert
// ownership periodically; never fight a live foreign owner.
const LOCK_SELF_HEAL_INTERVAL_MS = 60_000;
const lockSelfHealWatchdog = setInterval(() => {
  try {
    const ownerPath = join(singletonLock.lockDir, 'owner.json');
    let ownerPid = null;
    try {
      const parsed = JSON.parse(readFileSync(ownerPath, 'utf-8'));
      ownerPid = Number.isInteger(parsed?.pid) ? Number(parsed.pid) : null;
    } catch {}
    const decision = shouldReassertLock({ ownerPid, myPid: process.pid });
    if (decision === 'noop') return; // healthy — nothing to do
    if (decision === 'warn-split-brain') {
      // A different process claims the lock. Do not clobber it — log
      // loudly so supervision surfaces the split-brain instead.
      console.warn(
        `[zaraa-daemon] singleton lock at ${singletonLock.lockDir} is now ` +
          `owned by pid ${ownerPid} (this pid: ${process.pid}) — not re-asserting.`,
      );
      return;
    }
    mkdirSync(singletonLock.lockDir, { recursive: true });
    writeFileSync(
      join(singletonLock.lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );
    console.warn(
      `[zaraa-daemon] singleton lock dir was missing — re-asserted ownership at ${singletonLock.lockDir}.`,
    );
  } catch {
    // Watchdog must never throw; next tick retries.
  }
}, LOCK_SELF_HEAL_INTERVAL_MS);
lockSelfHealWatchdog.unref?.();

// ── Harness-orphan watchdog (supervision skew fix) ───────────────────
// Validation/test harnesses spawn daemons with ZARAA_DAEMON_LOCK_DIR set so
// the production singleton lock is bypassed. If the harness dies without
// tearing its child down, the daemon reparents (ppid → 1) and can outlive
// launchd restarts indefinitely. Detect reparenting and exit promptly.
if (process.env.ZARAA_DAEMON_LOCK_DIR?.trim()) {
  const harnessParentPid = process.ppid;
  const orphanWatchdog = setInterval(() => {
    const orphaned = shouldExitAsOrphanedHarnessChild({
      hasCustomLockDir: true,
      initialParentPid: harnessParentPid,
      currentParentPid: process.ppid,
    });
    if (!orphaned) return;
    clearInterval(orphanWatchdog);
    console.warn(
      `[zaraa-daemon] Harness parent (pid ${harnessParentPid}) exited — ` +
        'shutting down orphaned harness daemon.',
    );
    writeDaemonProcessExitIntent({
      source: 'zaraa-daemon.harnessOrphanWatchdog',
      reason: 'harness parent exited; daemon must not outlive its harness',
      extra: { harnessParentPid, currentParentPid: process.ppid },
    });
    singletonLock.release();
    process.exit(0);
  }, 15_000);
  orphanWatchdog.unref?.();
}

// ── Process crash handlers (R4) ──────────────────────────────────────
// Registered early, before any async work, so uncaught exceptions and
// unhandled rejections always get logged and trigger a graceful stop.
let stop; // assigned later by launch(); crash handlers check before calling

const CRASH_LOG_PATH = join(RUNTIME_HOME_DIR, '.zaraa', 'crash.log');

function writeCrashLog(label, err) {
  try {
    const timestamp = new Date().toISOString();
    // Sanitise: strip anything that looks like an API key or token
    const raw = err instanceof Error
      ? `${err.message}\n${err.stack || '(no stack)'}`
      : String(err ?? '(unknown error)');
    const sanitised = raw.replace(
      /(?:key|token|secret|password|authorization)[^\s=:]*[\s=:]+\S+/gi,
      '[REDACTED]',
    );
    const entry = `[${timestamp}] ${label}\n${sanitised}\n\n`;
    mkdirSync(dirname(CRASH_LOG_PATH), { recursive: true });
    appendFileSync(CRASH_LOG_PATH, entry, { mode: 0o600 });
  } catch {
    // Crash handler must never throw — swallow silently.
  }
}

async function crashShutdown(label, err) {
  writeCrashLog(label, err);
  console.error(`[zaraa-daemon] ${label}:`, err);
  writeDaemonProcessExitIntent({
    source: 'zaraa-daemon.crashShutdown',
    reason: err instanceof Error ? err.message : String(err ?? label),
    signal: label,
  });

  // Attempt graceful stop with a 5-second hard deadline
  const forceTimer = setTimeout(() => {
    writeDaemonProcessExitIntent({
      source: 'zaraa-daemon.crashShutdown.forceExit',
      reason: 'forced exit after crash shutdown timeout',
      signal: label,
    });
    process.exit(1);
  }, 5000);
  forceTimer.unref?.();
  try {
    // Mark the daemon_starts row so uptime reports distinguish crashes from
    // operator-initiated stops. Safe no-op if startup hadn't reached recordDaemonStart.
    await recordDaemonStop(label).catch(() => {});
    if (typeof stop === 'function') {
      await stop();
    }
  } catch {
    // Best-effort — don't let shutdown errors delay exit.
  }
  writeDaemonProcessExitIntent({
    source: 'zaraa-daemon.crashShutdown.exit',
    reason: 'crash shutdown complete; exiting for supervisor restart',
    signal: label,
  });
  // Belt-and-braces: 'exit' hooks also release, but crash paths have been
  // observed leaking harness lock dirs (see 2026-07-06 orphan incident).
  singletonLock.release();
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  // Always exit — Node docs say continuing after uncaughtException is unsafe
  crashShutdown('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  crashShutdown('unhandledRejection', reason);
});

const port = Number(process.env.ZARAA_GATEWAY_PORT || 3927);
const startupDiagnosticDelayMs = Number(
  process.env.ZARAA_STARTUP_DIAGNOSTIC_DELAY_MS || 600_000,
);
let preferResponsiveStartupQuietWindow = crashLoop;
const configOverrideRaw = process.env.ZARAA_CONFIG_OVERRIDE_JSON?.trim();
let configOverride;

if (configOverrideRaw) {
  try {
    configOverride = JSON.parse(configOverrideRaw);
  } catch (err) {
    console.error(
      `[zaraa-daemon] Invalid ZARAA_CONFIG_OVERRIDE_JSON: ${err.message || err}`,
    );
    writeDaemonProcessExitIntent({
      source: 'zaraa-daemon.configOverride',
      reason: `invalid ZARAA_CONFIG_OVERRIDE_JSON: ${err.message || err}`,
    });
    process.exit(1);
  }
}

if (!configOverrideRaw) {
  const currentConfig = readJsonFile(configFilePath);
  // Empty ZARAA_TRY_RESTORE_LOCAL_DEEP_MODEL disables restore (permanent miss thrash stop).
  // Unset → default qwen3.5-zaraa for back-compat.
  const explicitLocalDeepModel = resolveLocalDeepRestoreModel(
    process.env.ZARAA_TRY_RESTORE_LOCAL_DEEP_MODEL,
  );
  if (
    explicitLocalDeepModel &&
    crashLoop &&
    currentConfig &&
    !configHasProviderForModel(currentConfig, explicitLocalDeepModel)
  ) {
    preferResponsiveStartupQuietWindow = true;
    recordLocalProviderRestoreFailure(explicitLocalDeepModel);
    logLocalProviderRestoreSkipOnce(
      explicitLocalDeepModel,
      `[zaraa-daemon] Crash loop active — skipping ${explicitLocalDeepModel} local provider restore to keep startup on the responsive path`,
    );
  } else if (
    explicitLocalDeepModel &&
    currentConfig &&
    !configHasProviderForModel(currentConfig, explicitLocalDeepModel)
  ) {
    const restoreProbeCooldownMs = Math.max(
      0,
      Number(
        process.env.ZARAA_LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS ??
          LOCAL_PROVIDER_RESTORE_PROBE_COOLDOWN_MS,
      ),
    );
    // Early ledger check — skip findLegacyProvider + deep-trace scans during cooldown
    // (live 2026-07-25: every kickstart still walked overlay backups for missing qwen).
    const recentRestoreFailure = getRecentLocalProviderRestoreFailure(
      explicitLocalDeepModel,
      restoreProbeCooldownMs,
    );
    if (
      recentRestoreFailure &&
      shouldSkipRestoreDueToRecentFailure(
        recentRestoreFailure.ageMs,
        recentRestoreFailure.cooldownMs ?? restoreProbeCooldownMs,
      )
    ) {
      preferResponsiveStartupQuietWindow = true;
      const ageSeconds = Math.max(1, Math.round(recentRestoreFailure.ageMs / 1000));
      const reasonTag = recentRestoreFailure.reason
        ? `; reason=${recentRestoreFailure.reason}`
        : "";
      logLocalProviderRestoreSkipOnce(
        explicitLocalDeepModel,
        `[zaraa-daemon] Skipping ${explicitLocalDeepModel} local provider restore — failure ledger still cooling (${ageSeconds}s ago; no overlay scan${reasonTag})`,
      );
    } else {
      const legacyProvider = findLegacyProviderForModel(explicitLocalDeepModel, {
        homeDir: RUNTIME_HOME_DIR,
      });
      if (legacyProvider) {
        const restoreHealth = getLatencySensitiveLocalModelRestoreHealth(explicitLocalDeepModel, {
          dataDir,
        });
        if (restoreHealth.degraded) {
          preferResponsiveStartupQuietWindow = true;
          logLocalProviderRestoreSkipOnce(
            explicitLocalDeepModel,
            `[zaraa-daemon] Skipping ${explicitLocalDeepModel} local provider restore from ${legacyProvider.path} because recent deep traces are still degraded (${restoreHealth.reason})`,
          );
        } else {
          const normalizedLegacyProvider = {
            ...legacyProvider.provider,
            baseUrl: normalizeLoopbackBaseUrl(legacyProvider.provider.baseUrl),
          };
          const restoreProbeMs = Math.max(
            250,
            Number(
              process.env.ZARAA_LOCAL_PROVIDER_RESTORE_PROBE_MS ??
                process.env.ZARAA_LOOPBACK_HTTP_PROVIDER_STARTUP_RECOVERY_TIMEOUT_MS ??
                3_000,
            ),
          );
          const probeResult = await probeLoopbackLocalProviderModelDetailed(
            normalizedLegacyProvider,
            explicitLocalDeepModel,
            { timeoutMs: restoreProbeMs },
          );
          if (probeResult.healthy) {
            clearLocalProviderRestoreFailure(explicitLocalDeepModel);
            configOverride = {
              providers: [...(currentConfig.providers || []), normalizedLegacyProvider],
            };
            console.warn(
              `[zaraa-daemon] Restoring ${explicitLocalDeepModel} local provider from ${legacyProvider.path}`,
            );
          } else if (probeResult.reason === 'endpoint-unreachable') {
            // Startup race: the daemon often boots before ollama-serve binds its
            // port. A connection-refused probe says nothing about model health, so
            // don't start the multi-hour cooldown off it — defer the decision to
            // background re-probes and let a transient race self-heal.
            preferResponsiveStartupQuietWindow = true;
            console.warn(
              `[zaraa-daemon] ${explicitLocalDeepModel} local provider endpoint unreachable during the quick ${restoreProbeMs}ms probe (likely startup race) — deferring cooldown decision to background re-probes`,
            );
            scheduleLocalProviderRestoreReprobe(
              normalizedLegacyProvider,
              explicitLocalDeepModel,
              {
                onHealthy: () => {
                  clearLocalProviderRestoreFailure(explicitLocalDeepModel);
                  console.warn(
                    `[zaraa-daemon] Deferred probe found ${explicitLocalDeepModel} healthy — failure record cleared; provider restores on next daemon restart`,
                  );
                },
                onExhausted: (lastReason) => {
                  recordLocalProviderRestoreFailure(explicitLocalDeepModel, lastReason);
                  console.warn(
                    `[zaraa-daemon] Deferred re-probes for ${explicitLocalDeepModel} exhausted (${lastReason}) — recording restore failure to start the cooldown`,
                  );
                },
              },
            );
          } else {
            preferResponsiveStartupQuietWindow = true;
            // Persist probe reason so model-missing gets the 7d cool-down (no daily overlay re-scan).
            recordLocalProviderRestoreFailure(explicitLocalDeepModel, probeResult.reason);
            logLocalProviderRestoreSkipOnce(
              explicitLocalDeepModel,
              `[zaraa-daemon] Skipping ${explicitLocalDeepModel} local provider restore from ${legacyProvider.path} because the quick ${restoreProbeMs}ms probe failed (${probeResult.reason})`,
            );
          }
        }
      }
    }
  }
}

// Keep live validation windows clear after restarts before autonomy begins
// queuing reflective or trading-improvement work onto the responsive lane.
process.env.ZARAA_AUTONOMY_REFLECTION_START_DELAY_MS ??= '7200000';
process.env.ZARAA_AUTONOMY_MEMORY_REVIEW_START_DELAY_MS ??= '21600000';
process.env.ZARAA_AUTONOMY_GROWTH_START_DELAY_MS ??= '28800000';
process.env.ZARAA_AUTONOMY_TRADING_OPTIMIZATION_START_DELAY_MS ??= '32400000';

// Only log when *entering* the crash-loop window (crashStormAlert). Every restart
// while already ≥3 in 10m used to re-warn and thrash daemon-error.log during
// operator kickstarts / flapping deploys.
if (restart.crashStormAlert) {
  console.warn(
    `[zaraa-daemon] WARNING: Crash loop detected — ${restart.recentCount}+ restarts in the last 10 minutes`,
  );
}
const startupRuntimePauseMs = resolveStartupRuntimePauseMs({
  zaraaStartupRuntimePauseMs: process.env.ZARAA_STARTUP_RUNTIME_PAUSE_MS,
  preferResponsiveStartupQuietWindow,
  serviceLabel: SERVICE_LABEL,
  zaraaServiceLabel: process.env.ZARAA_SERVICE_LABEL,
  zaraaLaunchdLabel: process.env.ZARAA_LAUNCHD_LABEL,
  launchdLabel: process.env.LAUNCHD_LABEL,
  zaraaDataDir: process.env.ZARAA_DATA_DIR,
  zaraaDaemonLockDir: process.env.ZARAA_DAEMON_LOCK_DIR,
});
if (startupRuntimePauseMs > 0 && process.env.ZARAA_TASK_RUNNER_STARTUP_DELAY_MS === undefined) {
  process.env.ZARAA_TASK_RUNNER_STARTUP_DELAY_MS = String(startupRuntimePauseMs);
}
if (startupRuntimePauseMs > 0 && process.env.ZARAA_CRON_SCHEDULER_STARTUP_DELAY_MS === undefined) {
  process.env.ZARAA_CRON_SCHEDULER_STARTUP_DELAY_MS = String(startupRuntimePauseMs);
}

// ── Uptime tracking helpers (item 10) ────────────────────────────────
// Record daemon start/stop in trading.db daemon_starts table.
// The table is created on first use (no migration runner needed here).
let daemonStartRowId = null;

async function recordDaemonStart() {
  try {
    const tradingDbPath = join(dataDir, 'trading.db');
    if (!existsSync(tradingDbPath)) return;
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(tradingDbPath);
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daemon_starts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_time TEXT NOT NULL,
        stop_time TEXT,
        stop_reason TEXT
      )
    `).run();
    const row = db.prepare('INSERT INTO daemon_starts (start_time) VALUES (?)').run(new Date().toISOString());
    daemonStartRowId = row.lastInsertRowid;
    db.close();
    console.log(`[zaraa-daemon] Uptime tracking: start recorded (id=${daemonStartRowId})`);
  } catch (err) {
    console.warn(`[zaraa-daemon] Failed to record daemon start: ${err.message}`);
  }
}

async function recordDaemonStop(reason) {
  if (daemonStartRowId == null) return;
  try {
    const tradingDbPath = join(dataDir, 'trading.db');
    if (!existsSync(tradingDbPath)) return;
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(tradingDbPath);
    db.prepare('UPDATE daemon_starts SET stop_time = ?, stop_reason = ? WHERE id = ?').run(
      new Date().toISOString(), reason, daemonStartRowId,
    );
    db.close();
  } catch {}
}

try {
  const { launch } = await importCoreWithRetry();
  const result = await launch({
    homeDir: RUNTIME_HOME_DIR,
    configDir: join(RUNTIME_HOME_DIR, '.zaraa'),
    dataDir,
    port,
    config: configOverride,
    installSignalHandlers: false,
  });
  stop = result.stop;
  const { zara, port: listenPort } = result;
  const startupRuntimeMode = zara.getRuntimeMode();

  if (startupRuntimePauseMs > 0 && !startupRuntimeMode.paused) {
    await zara.setRuntimeMode('pause');
    console.log(
      `[zaraa-daemon] Runtime paused for ${startupRuntimePauseMs}ms after startup to keep post-restart validation lanes quiet`,
    );
    setTimeout(() => {
      zara
        .setRuntimeMode(startupRuntimeMode.mode, { persistConfig: false })
        .then((mode) => {
          console.log(
            `[zaraa-daemon] Runtime resumed in ${mode.mode} mode after startup quiet window`,
          );
        })
        .catch((err) => {
          console.warn(
            `[zaraa-daemon] Failed to resume runtime after startup quiet window: ${err.message || err}`,
          );
        });
    }, startupRuntimePauseMs).unref?.();
  }

  console.log(
    `[zaraa-daemon] Running | zone: ${zara.getZone()} | http://localhost:${listenPort} | data: ${dataDir}`,
  );

  // ── Startup health verification (item 2) ─────────────────────────
  // Verify the gateway is responsive. Non-blocking — log and continue.
  try {
    const healthRes = await fetch(`http://localhost:${listenPort}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (healthRes.ok) {
      console.log('[zaraa-daemon] Startup health check: gateway OK');
    } else {
      console.warn(`[zaraa-daemon] Startup health check: gateway returned ${healthRes.status}`);
    }
  } catch (err) {
    console.warn(`[zaraa-daemon] Startup health check: gateway unreachable — ${err.message}`);
  }

  // Record daemon start in trading.db
  await recordDaemonStart();
  writeDaemonStartIntent({
    path: RESTART_INTENT_LOG,
    pid: process.pid,
    ppid: process.ppid,
    serviceLabel: SERVICE_LABEL,
    reason:
      process.env.ZARAA_START_REASON ||
      (crashLoop ? 'daemon process started during crash-loop window' : 'daemon process started'),
    extra: {
      port: listenPort,
      dataDir,
      crashLoop,
      lockDir: process.env.ZARAA_DAEMON_LOCK_DIR || null,
    },
  });

  // ── Exchange connection probe with retry (item 9) ─────────────────
  // Non-blocking: probes exchange reachability and retries on failure.
  (async () => {
    try {
      const cfg = readJsonFile(configFilePath);
      const apiKey = cfg?.gateway?.auth?.apiKey ?? cfg?.apiKey;
      // Friend-beta / fail-closed: only probe when background automation is explicitly true.
      // Missing or stringly values must not enable exchange probes on idle installs.
      if (!apiKey || cfg?.trading?.backgroundAutomation !== true) return;
      let exchangeOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(`http://localhost:${listenPort}/api/trading/price/BTC_USDT`, {
            headers: { 'X-Api-Key': apiKey },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) { exchangeOk = true; break; }
        } catch {}
        if (attempt < 3) {
          console.warn(`[zaraa-daemon] Exchange probe attempt ${attempt}/3 failed — retrying in 10s`);
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
      if (exchangeOk) {
        console.log('[zaraa-daemon] Exchange connectivity: OK');
      } else {
        console.warn('[zaraa-daemon] Exchange connectivity: unreachable after 3 attempts — trading may be impaired');
      }
    } catch (err) {
      console.warn(`[zaraa-daemon] Exchange probe error: ${err.message}`);
    }
  })().catch(() => {});

  // Leave a wider buffer after restart so live validation and any first-user
  // turns can settle before the daemon sends its partner alert.
  setTimeout(() => {
    startupDiagnostic(restart, zara).catch((err) => {
      console.warn(`[zaraa-daemon] startupDiagnostic failed: ${err?.message ?? err}`);
    });
  }, Math.max(0, startupDiagnosticDelayMs)).unref?.();
} catch (err) {
  singletonLock.release();
  console.error(`[zaraa-daemon] Failed to start: ${err.message || err}`);
  if (err.stack) console.error(err.stack);
  writeDaemonProcessExitIntent({
    source: 'zaraa-daemon.startup',
    reason: `failed to start: ${err.message || err}`,
  });
  process.exit(1);
}

function hasActiveNovelTaskGeneratorProcess() {
  try {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status !== 0) return false;
    return String(result.stdout || '')
      .split('\n')
      .some((line) => {
        const trimmed = line.trim();
        if (!trimmed.includes('generate-novel-tasks.mjs')) return false;
        const [rawPid] = trimmed.split(/\s+/, 1);
        return Number(rawPid) !== process.pid;
      });
  } catch {
    return false;
  }
}

async function drainTaskWorkBeforeShutdown(signal) {
  const enabled = process.env.ZARAA_SIGTERM_TASK_DRAIN !== '0';
  const deadline = Date.now() + SIGTERM_TASK_DRAIN_MS;
  let loggedDrain = false;

  while (true) {
    const activity = {
      ...readTaskActivitySummaryFromDb(TASKS_DB_PATH),
      generatorActive: hasActiveNovelTaskGeneratorProcess(),
    };
    const decision = shouldDrainShutdownForTaskActivity(activity, { signal, enabled });
    if (!decision.drain) {
      if (loggedDrain) {
        console.log('[zaraa-daemon] Shutdown drain cleared; no interruptible task work remains');
      }
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      console.warn(
        `[zaraa-daemon] Shutdown drain deadline reached; proceeding with ${decision.reason}`,
      );
      return;
    }

    loggedDrain = true;
    console.warn(
      `[zaraa-daemon] Deferring ${signal} shutdown; ${decision.reason}; ${Math.ceil(remainingMs / 1000)}s grace left`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(SIGTERM_TASK_DRAIN_POLL_MS, remainingMs)),
    );
  }
}

// ── Graceful shutdown (item 1) ────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  const signalNowMs = Date.now();
  const proofSignalGuard = shouldBlockSignalShutdownForActiveProof({
    signal,
    serviceLabel: SERVICE_LABEL,
    proofStartPath: process.env.ZARAA_PROOF_START_PATH ?? join(RUNTIME_HOME_DIR, '.zaraa', 'state', 'zaraa-24h-proof-start.json'),
    restartIntentPath: RESTART_INTENT_LOG,
    nowMs: signalNowMs,
    lastBlockedSignalMs: lastProofSignalGuardBlock.signal === signal ? lastProofSignalGuardBlock.atMs : 0,
    secondSignalForceWindowMs: PROOF_SIGNAL_GUARD_SECOND_SIGTERM_FORCE_MS,
  });
  if (proofSignalGuard.block) {
    lastProofSignalGuardBlock = { signal, atMs: signalNowMs };
    console.error(`[zaraa-daemon] PROOF SIGNAL GUARD BLOCKED SHUTDOWN: ${proofSignalGuard.reason}`);
    return;
  }
  if (proofSignalGuard.forced) {
    console.error(`[zaraa-daemon] PROOF SIGNAL GUARD OVERRIDE: ${proofSignalGuard.reason}`);
  }
  lastProofSignalGuardBlock = { signal: null, atMs: 0 };
  console.log(`[zaraa-daemon] Shutting down gracefully... (${signal})`);
  const shutdownActivity = readTaskActivitySummaryFromDb(TASKS_DB_PATH);
  writeDaemonExitIntent({
    path: RESTART_INTENT_LOG,
    pid: process.pid,
    source: 'zaraa-daemon.gracefulShutdown',
    reason: signal,
    signal,
    queue: shutdownActivity,
  });
  const forceTimeoutMs = signal === 'SIGTERM'
    ? Math.max(10_000, SIGTERM_TASK_DRAIN_MS + 10_000)
    : 10_000;
  const forceTimer = setTimeout(() => {
    writeDaemonExitIntent({
      path: RESTART_INTENT_LOG,
      pid: process.pid,
      source: 'zaraa-daemon.forceExit',
      reason: `forced exit after ${Math.round(forceTimeoutMs / 1000)}s timeout`,
      signal,
      queue: readExitQueueSummary(),
    });
    console.error(`[zaraa-daemon] Forced exit after ${Math.round(forceTimeoutMs / 1000)}s timeout`);
    process.exit(1);
  }, forceTimeoutMs);
  forceTimer.unref(); // Don't keep process alive
  await drainTaskWorkBeforeShutdown(signal);
  await recordDaemonStop(signal);
  clearInterval(heartbeatTimer);
  try {
    await stop();
  } catch (err) {
    console.error('[zaraa-daemon] Error during shutdown:', err);
  }
  singletonLock.release();
  clearTimeout(forceTimer);
  writeDaemonExitIntent({
    path: RESTART_INTENT_LOG,
    pid: process.pid,
    source: 'zaraa-daemon.gracefulShutdown.exit',
    reason: 'graceful shutdown complete; exiting for supervisor restart',
    signal,
    queue: readExitQueueSummary(),
  });
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
