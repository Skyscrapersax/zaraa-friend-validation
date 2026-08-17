import type { TradingStore, Position } from "../trading-store.js";
import type { RiskManager } from "./risk-manager.js";

export interface PreTradeValidation {
	allowed: boolean;
	/** Human-readable rejection reason */
	reason?: string;
	/** Which check failed */
	failedAt?: "max_trade_usd" | "daily_limit_usd" | "risk_manager";
	/** Actual dollar value of this trade (qty × estimatedPrice) */
	dollarValue: number;
	/** Cumulative daily spend before this trade */
	dailySpend: number;
}

export interface PreTradeParams {
	qty: number;
	/** Estimated execution price (ask price for buys, bid for sells) */
	estimatedPrice: number;
	/** Is this a paper trade? Controls which daily spend counter is checked. */
	isPaper: boolean;
	/** Total account equity — used for percentage limit checks */
	accountEquity: number;
	/** Peak equity — used for drawdown check */
	peakEquity: number;
	/** Open positions snapshot — must be fetched inside the caller's lock */
	openPositions: Position[];
	/** Direction of the trade */
	side: "long" | "short";
	/** Symbol being traded — for per-asset position limit */
	symbol?: string;
	/** Consecutive losses count (for circuit breaker check) */
	consecutiveLosses?: number;
}

/**
 * Unified pre-trade validation pipeline.
 *
 * Runs ALL checks in sequence — the stricter limit always wins:
 *   1. Dollar per-trade limit  (max_trade_usd)
 *   2. Daily dollar limit      (daily_limit_usd)
 *   3. RiskManager % limits   (maxPositionPct, maxExposurePct, drawdown, etc.)
 *
 * Logs exact values at every step so divergences between signal size and
 * executed size are visible in the logs. This is intentional — the 37-45x
 * overruns were caused by the signal engine path bypassing dollar limits
 * while using a large live account equity for percentage calculations.
 *
 * This class is used by ExecutionManager (under an AsyncMutex) so the
 * read-check-execute cycle is atomic — concurrent signals cannot both
 * pass the exposure check before either position is recorded.
 */
export class PreTradeValidator {
	constructor(
		private store: TradingStore,
		private riskManager: RiskManager,
	) {}

	validate(params: PreTradeParams): PreTradeValidation {
		const { qty, estimatedPrice, isPaper, accountEquity, peakEquity, openPositions, side } = params;
		const dollarValue = qty * estimatedPrice;
		const dailySpend = this.store.getDailySpend(isPaper);

		// Auto-scale dollar limits from current equity × risk config so the
		// throttles grow with the account instead of stale-anchoring at the
		// startup seed values (e.g. $2.03 max_trade_usd at $1015 equity, the
		// pre-Apr-16 misconfiguration). The explicit setting still wins when
		// it is the *smaller* of the two — so an operator can pin a hard ceiling
		// without losing the safety floor when equity drops.
		const maxPositionPct = typeof this.riskManager.getConfig === "function"
			? (this.riskManager.getConfig().maxPositionPct ?? 5)
			: 5;
		const equityDerivedMaxTrade = accountEquity > 0
			? accountEquity * (maxPositionPct / 100)
			: 0;
		// Daily limit defaults to 4× the per-trade limit so a few normal-sized
		// signals don't immediately trip the daily cap. Operators can override.
		const equityDerivedDailyLimit = equityDerivedMaxTrade * 4;

		// ── Step 1: Dollar per-trade limit ────────────────────────────────────────
		// Explicit setting wins when present (operator override); equity-derived
		// kicks in only when the setting is unset/empty so the validator stops
		// stale-anchoring at startup-time defaults. Operators can DELETE the
		// explicit setting to opt into auto-scaling; until then existing limits
		// (and existing test expectations) are preserved.
		const explicitMaxTradeRaw = this.store.getSetting("max_trade_usd");
		const explicitMaxTrade = explicitMaxTradeRaw ? Number(explicitMaxTradeRaw) : undefined;
		const maxTrade = explicitMaxTrade && Number.isFinite(explicitMaxTrade) && explicitMaxTrade > 0
			? explicitMaxTrade
			: equityDerivedMaxTrade;
		console.log(
			`[pre-trade] dollar check: $${dollarValue.toFixed(2)} vs max_trade_usd=$${maxTrade.toFixed(2)} ` +
			`(explicit=${explicitMaxTrade ?? "—"}, equity-derived=$${equityDerivedMaxTrade.toFixed(2)}) ` +
			`[${dollarValue <= maxTrade ? "PASS" : "FAIL"}]`,
		);
		if (dollarValue > maxTrade) {
			return {
				allowed: false,
				reason: `Trade value $${dollarValue.toFixed(2)} exceeds max_trade_usd ($${maxTrade.toFixed(2)})`,
				failedAt: "max_trade_usd",
				dollarValue,
				dailySpend,
			};
		}

		// ── Step 2: Daily dollar limit ────────────────────────────────────────────
		// Same explicit-wins policy as max_trade_usd (see step 1).
		const explicitDailyRaw = this.store.getSetting("daily_limit_usd");
		const explicitDaily = explicitDailyRaw ? Number(explicitDailyRaw) : undefined;
		const dailyLimit = explicitDaily && Number.isFinite(explicitDaily) && explicitDaily > 0
			? explicitDaily
			: equityDerivedDailyLimit;
		console.log(
			`[pre-trade] daily check: spent=$${dailySpend.toFixed(2)} + new=$${dollarValue.toFixed(2)} ` +
			`vs daily_limit_usd=$${dailyLimit.toFixed(2)} ` +
			`(explicit=${explicitDaily ?? "—"}, equity-derived=$${equityDerivedDailyLimit.toFixed(2)}) ` +
			`[${dailySpend + dollarValue <= dailyLimit ? "PASS" : "FAIL"}]`,
		);
		if (dailySpend + dollarValue > dailyLimit) {
			return {
				allowed: false,
				reason: `Daily limit ($${dailyLimit.toFixed(2)}) would be exceeded: spent=$${dailySpend.toFixed(2)}, new=$${dollarValue.toFixed(2)}`,
				failedAt: "daily_limit_usd",
				dollarValue,
				dailySpend,
			};
		}

		// ── Step 3: RiskManager percentage limits ─────────────────────────────────
		const currentExposure = openPositions.reduce((s, p) => s + p.entryPrice * p.qty, 0);
		const positionPct = (dollarValue / accountEquity) * 100;
		const newExposurePct = ((currentExposure + dollarValue) / accountEquity) * 100;

		const riskValidation = this.riskManager.validateTrade({
			entryPrice: estimatedPrice,
			qty,
			side,
			symbol: params.symbol,
			accountEquity,
			peakEquity,
			openPositions,
			consecutiveLosses: params.consecutiveLosses ?? this.store.getConsecutiveLosses(),
		});

		console.log(
			`[pre-trade] risk check: position=${positionPct.toFixed(2)}% ` +
			`exposure=${newExposurePct.toFixed(2)}% equity=$${accountEquity.toFixed(2)} ` +
			`[${riskValidation.allowed ? "PASS" : "FAIL"}]` +
			(riskValidation.allowed ? "" : ` — ${riskValidation.reasons.join("; ")}`),
		);

		if (!riskValidation.allowed) {
			return {
				allowed: false,
				reason: `RiskManager: ${riskValidation.reasons.join("; ")}`,
				failedAt: "risk_manager",
				dollarValue,
				dailySpend,
			};
		}

		return { allowed: true, dollarValue, dailySpend };
	}
}
