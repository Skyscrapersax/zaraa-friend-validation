/**
 * Snapshot freshness utility — pure, side-effect-free.
 *
 * Used to flag stale shadow P&L snapshots so the learning loop can skip
 * or re-request them before making regime or weight decisions.
 */

/** Result returned by checkSnapshotFreshness. */
export interface SnapshotFreshnessResult {
	/** True when the snapshot is older than maxAgeMs. */
	stale: boolean;
	/** Elapsed milliseconds between snapshotTimestampMs and nowMs. */
	ageMs: number;
	/** Remaining milliseconds until staleness (negative when already stale). */
	remainingMs: number;
}

/**
 * Determine whether a shadow P&L snapshot is stale.
 *
 * A snapshot is considered stale when its age (nowMs - snapshotTimestampMs)
 * STRICTLY EXCEEDS maxAgeMs. A snapshot whose age equals maxAgeMs exactly
 * is still considered fresh (boundary = inclusive fresh side).
 *
 * @param snapshotTimestampMs  Unix epoch milliseconds when the snapshot was taken.
 * @param nowMs                Current time in Unix epoch milliseconds.
 * @param maxAgeMs             Maximum acceptable age in milliseconds.
 */
export function checkSnapshotFreshness(
	snapshotTimestampMs: number,
	nowMs: number,
	maxAgeMs: number,
): SnapshotFreshnessResult {
	const ageMs = nowMs - snapshotTimestampMs;
	const stale = ageMs > maxAgeMs;
	return { stale, ageMs, remainingMs: maxAgeMs - ageMs };
}

/**
 * Convenience overload: returns true when the snapshot is stale.
 * Equivalent to checkSnapshotFreshness(...).stale.
 */
export function isSnapshotStale(
	snapshotTimestampMs: number,
	nowMs: number,
	maxAgeMs: number,
): boolean {
	return checkSnapshotFreshness(snapshotTimestampMs, nowMs, maxAgeMs).stale;
}
