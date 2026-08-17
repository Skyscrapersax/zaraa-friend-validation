import type { TradingStore } from "../trading-store.js";
import type { BreakerRow, TradingCircuitBreaker } from "./trading-circuit-breaker.js";
import {
	buildAutomatedRiskLockSnapshot,
	type AutomatedRiskLockSnapshot,
} from "./automated-risk-lock.js";

export interface KillGateInput {
	store: TradingStore;
	circuitBreaker?: TradingCircuitBreaker | null;
	/** Match paper vs live P&L for daily loss cap (from `paper_mode` setting). */
	isPaperMode: boolean;
	/**
	 * Optional precomputed automated-risk-lock snapshot. Each build does multiple
	 * DB reads + equity resolution; the execution hot path computes it once and
	 * threads it through both enforceAutomatedRiskLock and this gate to avoid
	 * rebuilding the same snapshot 2-3× per entry attempt.
	 */
	precomputedRiskLock?: AutomatedRiskLockSnapshot;
}

export interface KillGateResult {
	allowed: boolean;
	reason?: string;
}

export interface KillGateSnapshot {
	newEntriesAllowed: boolean;
	blockReason?: string;
	tradingState: string;
	tradingKillSwitch: boolean;
	dailyLossCapUsd: number | null;
	todayTotalPnl: number;
	dailyCapBreached: boolean;
	automatedRiskLockTriggered: boolean;
	automatedRiskReason?: string;
	dailyLossHardStopPct: number;
	dailyLossThresholdUsd: number;
	initialEquity: number;
	currentDrawdownPct: number;
	maxTotalDrawdownPct: number;
	primaryExchange: string;
	venueHalted: boolean;
	circuitBreakerHalted: boolean;
	circuitBreakerReasons: string[];
	/**
	 * Per-breaker raw state. Lets dashboards/operators see exactly which of
	 * the four breakers (consecutive_loss, drawdown, velocity, policy_volume)
	 * is tripped without parsing the human-readable `circuitBreakerReasons`
	 * strings. Empty when the breaker is not wired in.
	 */
	breakerStates: BreakerRow[];
}

function todayUtcDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function parseDailyCap(raw: string | undefined): number | null {
	if (raw == null || raw.trim() === "") return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n;
}

function haltedVenueSet(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

/**
 * Hard gates for **new entries** (signal engine, execution manager, trade_buy).
 * Does not apply to stop-monitor exits (handled in trade_sell).
 */
export function evaluateTradingKillGate(input: KillGateInput): KillGateResult {
	const { store, circuitBreaker, isPaperMode } = input;

	if (store.getTradingState() === "LOCKED" || store.getTradingState() === "HALTED") {
		return {
			allowed: false,
			reason: `Trading state is ${store.getTradingState()} by the automated risk monitor. New entries are blocked.`,
		};
	}

	if (store.getSetting("trading_kill_switch") === "true") {
		return {
			allowed: false,
			reason: "Trading kill switch is ON (setting trading_kill_switch). New entries are blocked.",
		};
	}

	// Cache getStatus() once — it calls autoResetExpiredBreakers() (a DB scan +
	// side effects) on every invocation; calling it twice doubles that work on
	// the per-trade hot path. Matches buildKillGateSnapshot's single-call pattern.
	const cbStatus = circuitBreaker?.getStatus();
	if (cbStatus?.halted) {
		const reasons = cbStatus.reasons.join("; ");
		return {
			allowed: false,
			reason: `Circuit breaker halted: ${reasons}`,
		};
	}

	const cap = parseDailyCap(store.getSetting("daily_loss_cap_usd"));
	if (cap != null) {
		const summary = store.getDailyPnLSummary(todayUtcDate(), isPaperMode);
		if (summary.totalPnl <= -cap) {
			return {
				allowed: false,
				reason: `Daily loss cap reached: today's realized P&L is $${summary.totalPnl.toFixed(2)} (cap −$${cap.toFixed(2)} via daily_loss_cap_usd).`,
			};
		}
	}

	const automatedRisk =
		input.precomputedRiskLock ??
		buildAutomatedRiskLockSnapshot({ store, isPaperMode });
	if (automatedRisk.triggered) {
		return {
			allowed: false,
			reason: automatedRisk.reason ?? "Automated risk lock blocked new entries.",
		};
	}

	const primary = (store.getSetting("primary_exchange") || "crypto_com").trim();
	const halted = haltedVenueSet(store.getSetting("trading_halt_exchanges"));
	if (halted.size > 0 && halted.has(primary.toLowerCase())) {
		return {
			allowed: false,
			reason: `Exchange halted for new entries: ${primary} is listed in trading_halt_exchanges.`,
		};
	}

	return { allowed: true };
}

/**
 * Snapshot for dashboards and trade_risk_status (includes fields even when allowed).
 */
export function buildKillGateSnapshot(input: KillGateInput): KillGateSnapshot {
	const { store, circuitBreaker, isPaperMode } = input;
	const date = todayUtcDate();
	const summary = store.getDailyPnLSummary(date, isPaperMode);
	const cap = parseDailyCap(store.getSetting("daily_loss_cap_usd"));
	const automatedRisk =
		input.precomputedRiskLock ??
		buildAutomatedRiskLockSnapshot({ store, isPaperMode });
	const primary = (store.getSetting("primary_exchange") || "crypto_com").trim();
	const halted = haltedVenueSet(store.getSetting("trading_halt_exchanges"));
	const venueHalted = halted.size > 0 && halted.has(primary.toLowerCase());
	const breakerStatus = circuitBreaker?.getStatus();
	const circuitBreakerHalted = breakerStatus?.halted ?? false;
	const circuitBreakerReasons = breakerStatus?.reasons ?? [];
	const breakerStates = circuitBreaker?.getPersistedStates() ?? [];

	// Reuse the snapshot we just built so the gate doesn't rebuild it a third time.
	const gate = evaluateTradingKillGate({ ...input, precomputedRiskLock: automatedRisk });
	return {
		newEntriesAllowed: gate.allowed,
		blockReason: gate.reason,
		tradingState: store.getTradingState(),
		tradingKillSwitch: store.getSetting("trading_kill_switch") === "true",
		dailyLossCapUsd: cap,
		todayTotalPnl: summary.totalPnl,
		dailyCapBreached: cap != null && summary.totalPnl <= -cap,
		automatedRiskLockTriggered: automatedRisk.triggered,
		automatedRiskReason: automatedRisk.reason,
		dailyLossHardStopPct: automatedRisk.dailyLossHardStopPct,
		dailyLossThresholdUsd: automatedRisk.dailyLossThresholdUsd,
		initialEquity: automatedRisk.initialEquity,
		currentDrawdownPct: automatedRisk.drawdownRatio * 100,
		maxTotalDrawdownPct: automatedRisk.maxTotalDrawdownPct * 100,
		primaryExchange: primary,
		venueHalted,
		circuitBreakerHalted,
		circuitBreakerReasons,
		breakerStates,
	};
}
