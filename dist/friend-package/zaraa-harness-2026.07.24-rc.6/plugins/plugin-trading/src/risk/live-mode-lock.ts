/**
 * Daily-rotating live mode confirmation lock.
 *
 * When `paper_mode=false`, every trade execution path MUST present today's
 * UTC-dated lock string before any exchange interaction.  The string format
 * deliberately rotates every day so that an old confirmation (e.g. left in
 * `zaraa.config.json` from yesterday) cannot silently authorize today's
 * trading after a config reload, daemon restart, or DB anomaly.
 *
 * Both the handler-level path (handlers.ts) and the signal-engine
 * auto-execute path (execution-manager.ts `_execute()`) must call
 * `validateLiveModeLock` before placing a live order.
 */

/** Today's expected live-mode lock string, anchored to UTC date. */
export function expectedLiveModeLock(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return `I-CONFIRM-LIVE-TRADING-${y}-${m}-${d}`;
}

export interface LiveModeLockValidationResult {
	ok: boolean;
	/** Human-readable error reason, or null if validation passed. */
	reason: string | null;
	/** Today's expected lock string — useful for surfacing in error JSON. */
	expectedLock: string;
}

/**
 * Validates the supplied `liveModeLock` against today's expected value.
 *
 * Always passes in paper mode.  In live mode, returns `ok:false` with a
 * clear error reason whenever the lock is missing, stale, or malformed.
 */
export function validateLiveModeLock(
	liveModeLock: string | undefined | null,
	paperMode: boolean,
	now: Date = new Date(),
): LiveModeLockValidationResult {
	const expected = expectedLiveModeLock(now);
	if (paperMode) return { ok: true, reason: null, expectedLock: expected };
	if (liveModeLock === expected) return { ok: true, reason: null, expectedLock: expected };
	const reason = liveModeLock
		? `liveModeLock is stale ("${liveModeLock}"). Update to "${expected}" in zaraa.config.json to trade live today.`
		: `liveModeLock is required for live trading. Add "liveModeLock": "${expected}" to the trading block in zaraa.config.json.`;
	return { ok: false, reason, expectedLock: expected };
}
