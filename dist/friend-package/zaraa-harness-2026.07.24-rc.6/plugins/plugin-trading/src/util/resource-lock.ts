/**
 * File-based lock for daily discipline logging (multi-process safe).
 * Same pattern as packages/core/src/utils/file-lock.ts — kept local to avoid a core dependency.
 */
import { writeFileSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
	timeoutMs?: number;
	retryIntervalMs?: number;
	staleThresholdMs?: number;
}

export interface LockHandle {
	release: () => void;
	path: string;
}

export async function acquireLock(resourcePath: string, options: LockOptions = {}): Promise<LockHandle> {
	const lockPath = `${resourcePath}.lock`;
	const timeoutMs = options.timeoutMs ?? 5000;
	const retryIntervalMs = options.retryIntervalMs ?? 50;
	const staleThresholdMs = options.staleThresholdMs ?? 30_000;

	const deadline = Date.now() + timeoutMs;
	let released = false;

	const release = () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(lockPath);
		} catch {
			// ignore
		}
	};

	while (Date.now() < deadline) {
		try {
			mkdirSync(dirname(lockPath), { recursive: true });
			writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
			return { release, path: lockPath };
		} catch (err: unknown) {
			const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") throw err;

			try {
				const st = statSync(lockPath);
				const age = Date.now() - st.mtimeMs;
				if (age > staleThresholdMs) {
					try {
						unlinkSync(lockPath);
					} catch {
						// race
					}
					continue;
				}
			} catch {
				continue;
			}

			await new Promise((r) => setTimeout(r, retryIntervalMs));
		}
	}

	throw new Error(`Failed to acquire lock on ${resourcePath} within ${timeoutMs}ms`);
}

export async function withLock<T>(resourcePath: string, fn: () => T | Promise<T>, options?: LockOptions): Promise<T> {
	const lock = await acquireLock(resourcePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/**
 * Try once to acquire the lock (no wait/retry loop). Returns null if another holder is active
 * and the lock file is not stale. Used for overlapping cron / API discipline runs.
 */
export function tryAcquireLock(
	resourcePath: string,
	options: Pick<LockOptions, "staleThresholdMs"> = {},
): LockHandle | null {
	const lockPath = `${resourcePath}.lock`;
	const staleThresholdMs = options.staleThresholdMs ?? 30_000;
	let released = false;

	const release = () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(lockPath);
		} catch {
			// ignore
		}
	};

	const attempt = (): LockHandle | null => {
		try {
			mkdirSync(dirname(lockPath), { recursive: true });
			writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
			return { release, path: lockPath };
		} catch (err: unknown) {
			const code =
				err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") throw err;
			return null;
		}
	};

	const first = attempt();
	if (first) return first;

	try {
		const st = statSync(lockPath);
		const age = Date.now() - st.mtimeMs;
		if (age <= staleThresholdMs) return null;
		try {
			unlinkSync(lockPath);
		} catch {
			return null;
		}
	} catch {
		return null;
	}

	return attempt();
}
