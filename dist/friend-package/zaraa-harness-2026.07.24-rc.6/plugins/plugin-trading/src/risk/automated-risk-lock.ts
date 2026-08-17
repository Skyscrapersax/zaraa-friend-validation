import type { TradingStore } from "../trading-store.js";
import { requireFreshLiveEquity } from "./live-equity.js";

// ── Stage-5 go-live auto-revert rail ─────────────────────────────────────────
// Settings keys for the live-mode go-live equity baseline.

/** Stored as a string (e.g. "10000") in the settings table. */
export const LIVE_BASELINE_EQUITY_KEY = "live_baseline_equity_usd";

/** ISO timestamp of when the baseline was recorded. */
export const LIVE_BASELINE_AT_KEY = "live_baseline_at";

/**
 * Record the go-live equity baseline at the moment paper_mode is flipped
 * false (live). Called from the `trade_set_limit` handler after the
 * pre-live checklist passes.
 *
 * Fails closed: if the equity resolved from the store is zero or negative
 * (no snapshot exists yet), throws an error so the caller can refuse the
 * live flip.
 */
export function recordGoLiveBaselineEquity(store: TradingStore): void {
	const snapshot = requireFreshLiveEquity(store);
	const equity = snapshot.equity;

	store.setSetting(LIVE_BASELINE_EQUITY_KEY, String(equity));
	store.setSetting(LIVE_BASELINE_AT_KEY, new Date().toISOString());
}

export interface AutoRevertResult {
	/** True when the revert was triggered and paper_mode was set to true. */
	reverted: boolean;
	/** Human-readable reason, present when reverted===true. */
	reason?: string;
}

function revertToPaper(store: TradingStore, reason: string): AutoRevertResult {
	console.warn(reason);
	store.setSetting("paper_mode", "true");
	store.setSetting(LIVE_BASELINE_EQUITY_KEY, "");
	store.setSetting(LIVE_BASELINE_AT_KEY, "");
	return { reverted: true, reason };
}

function assessLiveEquityAutoRevert(store: TradingStore): AutoRevertResult {
	if (store.getSetting("paper_mode") !== "false") return { reverted: false };

	const baselineRaw = store.getSetting(LIVE_BASELINE_EQUITY_KEY);
	if (!baselineRaw) {
		return {
			reverted: true,
			reason: "[auto-revert] Live equity baseline is missing. Live trading must revert to paper mode.",
		};
	}

	const baseline = Number(baselineRaw);
	if (!Number.isFinite(baseline) || baseline <= 0) {
		return {
			reverted: true,
			reason: "[auto-revert] Live equity baseline is invalid. Live trading must revert to paper mode.",
		};
	}

	let currentEquity: number;
	try {
		currentEquity = requireFreshLiveEquity(store).equity;
	} catch {
		return {
			reverted: true,
			reason:
				"[auto-revert] Fresh authenticated live equity is unavailable. Live trading must revert to paper mode.",
		};
	}

	if (currentEquity >= baseline * 0.95) return { reverted: false };

	const dropPct = (((baseline - currentEquity) / baseline) * 100).toFixed(2);
	return {
		reverted: true,
		reason:
			`[auto-revert] Live equity dropped ${dropPct}% from go-live baseline ` +
			`($${currentEquity.toFixed(2)} vs baseline $${baseline.toFixed(2)}). ` +
			"Live trading must revert to paper mode (stage-5 safety rail).",
	};
}

/**
 * Check whether the live account equity has dropped more than 5% from the
 * go-live baseline and, if so, automatically snap back to paper mode.
 *
 * Called on the existing risk-enforcement cadence (every trade attempt via
 * buildAutomatedRiskLockSnapshot). Zero overhead when paper_mode is true or
 * no baseline exists.
 *
 * Boundary: `currentEquity < baseline * 0.95`
 *   - Exactly 5.0% drop → does NOT fire (currentEquity === baseline * 0.95)
 *   - More than 5.0% drop → fires (currentEquity < baseline * 0.95)
 *
 * Baseline clearing: the baseline is cleared on revert so a future live
 * re-flip records a fresh baseline rather than reusing a stale one.
 *
 * Never throws — all errors are contained and logged to stderr.
 */
export function checkAndMaybeAutoRevertToPaper(store: TradingStore): AutoRevertResult {
	try {
		const assessment = assessLiveEquityAutoRevert(store);
		return assessment.reverted
			? revertToPaper(store, assessment.reason ?? "Live equity safety rail triggered.")
			: assessment;
	} catch (err) {
		// Never throw out of the enforcement loop. Still report a trigger so the
		// current live entry is blocked even if persisting paper_mode failed.
		console.error("[auto-revert] Unexpected error in checkAndMaybeAutoRevertToPaper:", err);
		return {
			reverted: true,
			reason:
				"[auto-revert] Safety enforcement failed. Live trading remains blocked pending operator review.",
		};
	}
}

export interface AutomatedRiskLockSnapshot {
	triggered: boolean;
	reason?: string;
	tradingState: string;
	initialEquity: number;
	currentDailyPnl: number;
	dailyLossHardStopPct: number;
	dailyLossThresholdUsd: number;
	peakEquity: number;
	currentEquity: number;
	drawdownRatio: number;
	maxTotalDrawdownPct: number;
}

function todayUtcDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function parsePositiveFraction(raw: string | undefined, fallback: number): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

function resolveRiskLockEquity(
	store: TradingStore,
	isPaperMode: boolean,
	peakEquity: number,
): number {
	if (!isPaperMode) {
		try {
			return requireFreshLiveEquity(store).equity;
		} catch {
			return Number.NaN;
		}
	}
	if (typeof store.resolveReportEquity === "function") {
		return store.resolveReportEquity(isPaperMode);
	}

	const latest = store.getLatestEquity();
	if (latest > 0) return latest;
	if (peakEquity > 0) return peakEquity;
	return store.getInitialEquity(isPaperMode);
}

export function buildAutomatedRiskLockSnapshot(input: {
	store: TradingStore;
	isPaperMode: boolean;
	/** Shadow evaluation uses live inputs but must not mutate paper_mode. */
	skipAutoRevert?: boolean;
}): AutomatedRiskLockSnapshot {
	const { store, isPaperMode, skipAutoRevert = false } = input;

	// Fail closed immediately so every caller observes paper mode after a trigger.
	const autoRevert =
		!isPaperMode && !skipAutoRevert
			? checkAndMaybeAutoRevertToPaper(store)
			: { reverted: false };

	const tradingState = store.getTradingState();
	const initialEquity = isPaperMode
		? store.getInitialEquity(true)
		: Number(store.getSetting(LIVE_BASELINE_EQUITY_KEY)) || store.getInitialLiveEquity();
	const currentDailyPnl = store.getDailyPnLSummary(todayUtcDate(), isPaperMode).totalPnl;
	const dailyLossHardStopPct = parsePositiveFraction(
		store.getSetting("daily_loss_hardstop_pct"),
		0.02,
	);
	const maxTotalDrawdownPct = parsePositiveFraction(
		store.getSetting("max_total_drawdown_pct"),
		0.07,
	);
	const peakEquity = isPaperMode ? store.getPeakEquity() : store.getPeakLiveEquity();
	const currentEquity = resolveRiskLockEquity(store, isPaperMode, peakEquity);
	const drawdownRatio = peakEquity > 0 ? Math.max(0, (peakEquity - currentEquity) / peakEquity) : 0;
	const dailyLossThresholdUsd = initialEquity * dailyLossHardStopPct;

	if (autoRevert.reverted) {
		return {
			triggered: true,
			reason: autoRevert.reason ?? "Live equity safety rail reverted trading to paper mode.",
			tradingState,
			initialEquity,
			currentDailyPnl,
			dailyLossHardStopPct,
			dailyLossThresholdUsd,
			peakEquity,
			currentEquity,
			drawdownRatio,
			maxTotalDrawdownPct,
		};
	}

	if (!isPaperMode && (!Number.isFinite(currentEquity) || currentEquity <= 0)) {
		return {
			triggered: true,
			reason:
				"Live equity is missing or invalid. New entries are blocked until a fresh positive equity snapshot is recorded.",
			tradingState,
			initialEquity,
			currentDailyPnl,
			dailyLossHardStopPct,
			dailyLossThresholdUsd,
			peakEquity,
			currentEquity,
			drawdownRatio,
			maxTotalDrawdownPct,
		};
	}

	if (currentDailyPnl < -dailyLossThresholdUsd) {
		return {
			triggered: true,
			reason:
				`Daily loss hard stop breached: today's realized P&L is $${currentDailyPnl.toFixed(2)} ` +
				`vs limit -$${dailyLossThresholdUsd.toFixed(2)} (${(dailyLossHardStopPct * 100).toFixed(2)}% of initial equity $${initialEquity.toFixed(2)}).`,
			tradingState,
			initialEquity,
			currentDailyPnl,
			dailyLossHardStopPct,
			dailyLossThresholdUsd,
			peakEquity,
			currentEquity,
			drawdownRatio,
			maxTotalDrawdownPct,
		};
	}

	if (drawdownRatio > maxTotalDrawdownPct) {
		return {
			triggered: true,
			reason:
				`Max total drawdown breached: current drawdown ${(drawdownRatio * 100).toFixed(2)}% ` +
				`exceeds ${(maxTotalDrawdownPct * 100).toFixed(2)}% (current equity $${currentEquity.toFixed(2)}, peak $${peakEquity.toFixed(2)}).`,
			tradingState,
			initialEquity,
			currentDailyPnl,
			dailyLossHardStopPct,
			dailyLossThresholdUsd,
			peakEquity,
			currentEquity,
			drawdownRatio,
			maxTotalDrawdownPct,
		};
	}

	return {
		triggered: tradingState === "LOCKED",
		reason:
			tradingState === "LOCKED" ? "Trading state is LOCKED pending operator review." : undefined,
		tradingState,
		initialEquity,
		currentDailyPnl,
		dailyLossHardStopPct,
		dailyLossThresholdUsd,
		peakEquity,
		currentEquity,
		drawdownRatio,
		maxTotalDrawdownPct,
	};
}
