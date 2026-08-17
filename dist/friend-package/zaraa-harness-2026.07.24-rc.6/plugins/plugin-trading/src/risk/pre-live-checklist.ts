import type { TradingStore } from "../trading-store.js";
import type { TradingCircuitBreaker } from "./trading-circuit-breaker.js";

/** Written when `trade_verify_exchange` succeeds (public + private API). */
export const PRELIVE_EXCHANGE_VERIFIED_AT_KEY = "prelive_exchange_verified_at";

/** How long exchange verification remains valid for enabling live mode. */
export const PRELIVE_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum closed shadow trades required as live-readiness evidence. */
export const PRELIVE_MIN_SHADOW_TRADES = 20;

export interface PreLiveChecklistInput {
	store: TradingStore;
	hasCredentials: boolean;
	/** Raw `process.env.PAPER_TRADING` — `"true"` forces paper and blocks DB live mode. */
	paperTradingEnv?: string;
	/**
	 * When true, `zaraa.config.json` still has `trading.paperMode: true`.
	 * Signal engine thresholds stay on paper until restart after changing config.
	 */
	zaraaTradingPaperMode?: boolean;
	circuitBreaker?: TradingCircuitBreaker | null;
	/**
	 * Closed-shadow-trade evidence for the `shadow_performance` gate. Pass the
	 * executor's lifetime numbers (`getShadowPerformance()`). Omit or pass null
	 * when shadow mode is unavailable — the gate then fails closed.
	 */
	shadowEvidence?: { closedTrades: number; totalPnl: number } | null;
	/** For tests */
	nowMs?: number;
}

export interface PreLiveChecklistItem {
	id: string;
	passed: boolean;
	message: string;
}

export interface PreLiveChecklistResult {
	allPassed: boolean;
	items: PreLiveChecklistItem[];
	/** Operator reminders — not scored */
	reminders: string[];
}

function parseLimit(raw: string | undefined, maxCap: number): { ok: boolean; value?: number } {
	if (raw == null || raw.trim() === "") return { ok: false };
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || n > maxCap) return { ok: false };
	return { ok: true, value: n };
}

export function recordPreLiveExchangeVerified(store: TradingStore, verified: boolean): void {
	if (verified) {
		store.setSetting(PRELIVE_EXCHANGE_VERIFIED_AT_KEY, new Date().toISOString());
	}
}

/**
 * Gates enabling **live** trading (`paper_mode: false`). All items must pass.
 */
export function evaluatePreLiveChecklist(input: PreLiveChecklistInput): PreLiveChecklistResult {
	const now = input.nowMs ?? Date.now();
	const reminders: string[] = [
		"Confirm the exchange API key is trade-only (no withdrawal permission) and IP-restricted if the venue supports it.",
	];

	const items: PreLiveChecklistItem[] = [];

	const envForcedPaper = input.paperTradingEnv === "true";
	items.push({
		id: "paper_trading_env",
		passed: !envForcedPaper,
		message: envForcedPaper
			? "PAPER_TRADING=true is set — the process cannot use live execution. Unset it before enabling live mode."
			: "PAPER_TRADING env does not force paper mode.",
	});

	items.push({
		id: "api_credentials",
		passed: input.hasCredentials,
		message: input.hasCredentials
			? "Exchange API credentials are configured (trading.apiKey / trading.apiSecret)."
			: "No API credentials — set trading.apiKey and trading.apiSecret in zaraa.config.json.",
	});

	const verifiedAtRaw = input.store.getSetting(PRELIVE_EXCHANGE_VERIFIED_AT_KEY);
	let verifyPassed = false;
	let verifyDetail = "";
	if (!verifiedAtRaw) {
		verifyDetail = "Run trade_verify_exchange successfully (within the last 24h).";
	} else {
		const t = Date.parse(verifiedAtRaw);
		if (!Number.isFinite(t)) {
			verifyDetail = "Stored verification timestamp is invalid — run trade_verify_exchange again.";
		} else if (now - t > PRELIVE_VERIFY_TTL_MS) {
			const hours = Math.round((now - t) / 3600000);
			verifyDetail = `Last exchange verify was ${hours}h ago (limit 24h). Run trade_verify_exchange again.`;
		} else {
			verifyPassed = true;
			verifyDetail = `Exchange verified at ${verifiedAtRaw} (within 24h).`;
		}
	}
	items.push({
		id: "exchange_verified_recent",
		passed: verifyPassed,
		message: verifyDetail,
	});

	const maxTrade = parseLimit(input.store.getSetting("max_trade_usd"), 500);
	const daily = parseLimit(input.store.getSetting("daily_limit_usd"), 2000);
	items.push({
		id: "max_trade_usd",
		passed: maxTrade.ok,
		message: maxTrade.ok
			? `Per-trade limit set ($${maxTrade.value}).`
			: "Set max_trade_usd (positive, ≤ $500) via trade_set_limit.",
	});
	items.push({
		id: "daily_limit_usd",
		passed: daily.ok,
		message: daily.ok
			? `Daily buy limit set ($${daily.value}).`
			: "Set daily_limit_usd (positive, ≤ $2000) via trade_set_limit.",
	});

	const ev = input.shadowEvidence;
	let shadowPassed = false;
	let shadowMsg: string;
	if (ev == null) {
		shadowMsg =
			"No shadow-trading evidence available — run shadow mode and accumulate " +
			`${PRELIVE_MIN_SHADOW_TRADES}+ closed trades before enabling live.`;
	} else if (ev.closedTrades < PRELIVE_MIN_SHADOW_TRADES) {
		shadowMsg = `Only ${ev.closedTrades} closed shadow trades — need ${PRELIVE_MIN_SHADOW_TRADES}+ as live-readiness evidence.`;
	} else if (ev.totalPnl <= 0) {
		shadowMsg = `Shadow P&L is $${ev.totalPnl.toFixed(2)} over ${ev.closedTrades} trades — must be positive before risking real funds.`;
	} else {
		shadowPassed = true;
		shadowMsg = `Shadow evidence OK: ${ev.closedTrades} closed trades, P&L $${ev.totalPnl.toFixed(2)}.`;
	}
	items.push({
		id: "shadow_performance",
		passed: shadowPassed,
		message: shadowMsg,
	});

	const killOn = input.store.getSetting("trading_kill_switch") === "true";
	items.push({
		id: "kill_switch_off",
		passed: !killOn,
		message: killOn
			? "trading_kill_switch is ON — clear with trade_set_kill_switch before live."
			: "Global trading kill switch is off.",
	});

	if (input.circuitBreaker) {
		const st = input.circuitBreaker.getStatus();
		items.push({
			id: "circuit_breaker_clear",
			passed: !st.halted,
			message: st.halted
				? `Circuit breaker is halted: ${st.reasons.join("; ")}`
				: "Circuit breaker is not halted.",
		});
	} else {
		// Fail closed, like shadow_performance: a missing breaker must never
		// silently drop the gate from the checklist.
		items.push({
			id: "circuit_breaker_clear",
			passed: false,
			message:
				"No circuit breaker instance available — wire TradingCircuitBreaker before enabling live.",
		});
	}

	if (input.zaraaTradingPaperMode !== false) {
		items.push({
			id: "zaraa_config_paper_mode",
			passed: false,
			message:
				input.zaraaTradingPaperMode === true
					? "trading.paperMode is still true in zaraa.config.json — signal engine uses paper thresholds until you set it false and restart the daemon."
					: "trading.paperMode was not verified from zaraa.config.json — live trading remains blocked.",
		});
	} else {
		items.push({
			id: "zaraa_config_paper_mode",
			passed: true,
			message: "zaraa.config.json has trading.paperMode explicitly false.",
		});
	}

	const allPassed = items.every((i) => i.passed);
	return { allPassed, items, reminders };
}
