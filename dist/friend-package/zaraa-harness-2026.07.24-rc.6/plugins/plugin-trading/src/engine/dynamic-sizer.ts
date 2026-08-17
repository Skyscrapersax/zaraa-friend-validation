export interface SizerInput {
	entryPrice: number;
	stopLoss: number;
	equity: number;
	maxTradeUsd: number;
	ensembleVoterCount: number;
	ensembleAgreeingCount: number;
	edgeVerdict: "confirmed" | "weak" | "no-edge";
	sizingModel?: "fixed_risk" | "fractional_kelly_0.25" | string;
	executionQualityScale?: number;
	/** Lifecycle gate from StrategyGrader (0 = halted, 1 = default). */
	strategyGradeScale?: number;
	/**
	 * One-leg fee rate (e.g. 0.00075 for crypto.com taker, 0.003 for Jupiter).
	 * Used to enforce the fee-aware notional floor — undersized trades are
	 * skipped because round-trip fees crush expected returns.
	 * Defaults to FEE_RATE_DEFAULT (crypto.com taker).
	 */
	feeRate?: number;
	/**
	 * Whether to reject trades below the fee-aware notional floor.
	 * Defaults to true for executable paper/live trades; callers can disable it
	 * for shadow-only signal collection where tiny notional is intentionally used.
	 */
	enforceFeeFloor?: boolean;
	/**
	 * Correlation-aware sizing scale (0.0–1.0). Multiplied into the final
	 * quantity AFTER risk-budget derivation but BEFORE the fee-floor check —
	 * a correlation-reduced trade that falls under the fee floor is skipped
	 * rather than executed at unprofitable notional. Defaults to 1.0
	 * (no reduction). Values outside [0,1] are clamped.
	 */
	correlationScale?: number;
	/**
	 * Current ATR as a fraction of price (e.g. 0.025 for 2.5% daily ATR).
	 * Paired with `medianAtrPct30d` to compute a vol-normalized risk multiplier.
	 */
	currentAtrPct?: number;
	/**
	 * Rolling 30-period (≈30d on daily candles) median ATR-pct, used as the
	 * neutral baseline for the vol-normalization multiplier.
	 */
	medianAtrPct30d?: number;
}

export interface SizerResult {
	qty: number;
	tier: "high" | "medium" | "low" | "skip" | "fee-floor";
	riskPct: number;
	entryPrice: number;
}

/** Default one-leg fee rate (crypto.com taker, matches fee-schedule.ts). */
export const FEE_RATE_DEFAULT = 0.00075;

/**
 * Reference calibration from the May 2026 audit: at the configured 0.075%
 * taker fee, break-even round-trip fee burden hit at ~$31.53 of notional.
 * Below this, the average trade is structurally unprofitable.
 */
const FEE_FLOOR_REFERENCE_RATE = 0.00075;
const FEE_FLOOR_REFERENCE_NOTIONAL_USD = 31.53;

/**
 * Minimum notional below which a trade is skipped on fee grounds.
 *
 * Scales linearly with the venue fee rate: a higher fee rate means tiny
 * positions are even less viable, so the floor rises. Formula is calibrated
 * from the audit such that a 0.075% taker fee gives a $31.53 floor.
 *
 * `feeRate === 0` short-circuits to no floor — covers fee-free venues
 * (XRPL native AMM) and shadow-mode scenarios where simulated fees aren't
 * billed against real equity.
 */
export function feeAwareMinNotional(feeRate: number): number {
	if (feeRate === 0) return 0;
	const safeRate = Number.isFinite(feeRate) && feeRate > 0 ? feeRate : FEE_RATE_DEFAULT;
	return FEE_FLOOR_REFERENCE_NOTIONAL_USD * (safeRate / FEE_FLOOR_REFERENCE_RATE);
}

/**
 * Compute position size based on signal confidence and risk constraints.
 *
 * `edgeVerdict` comes from the statistical edge validator (3 tests:
 * binomial, monte carlo, walk-forward).
 *   "confirmed" = 3/3 tests pass (strongest statistical evidence)
 *   "weak"      = 2/3 tests pass (edge detected, not unanimous)
 *   "no-edge"   = 0–1 tests pass (no statistical evidence)
 *
 * Tiers:
 *   high   = unanimous ensemble + confirmed edge         → 3% risk
 *   medium = majority vote (2+ agreeing)                 → 1.5% risk
 *   low    = single-strategy signal with any edge        → 0.5% risk
 *            (confirmed OR weak — 2/3 tests is still evidence, and single-
 *             strategy signals are the common case since the registered
 *             strategies detect mutually-exclusive regimes)
 *   skip   = single-strategy signal with no-edge         → 0 (don't trade)
 *
 * Hard constraints always enforced:
 *   - Never exceed 5% of equity per trade
 *   - Never exceed maxTradeUsd per trade
 */
export function computeDynamicQty(input: SizerInput): SizerResult {
	const {
		entryPrice,
		stopLoss,
		equity,
		maxTradeUsd,
		ensembleVoterCount,
		ensembleAgreeingCount,
		edgeVerdict,
		sizingModel,
		executionQualityScale,
		strategyGradeScale = 1,
		feeRate = FEE_RATE_DEFAULT,
		enforceFeeFloor = true,
		correlationScale,
		currentAtrPct,
		medianAtrPct30d,
	} = input;

	// Correlation-scale clamp: out-of-range values default to no scaling for
	// undefined/NaN, clamp negatives to 0 (skip), and cap >1 at 1 (no inflation).
	const corrScale =
		correlationScale === undefined || !Number.isFinite(correlationScale)
			? 1
			: Math.min(1, Math.max(0, correlationScale));

	// Volatility normalization: median/current, clamped to [0.5, 1.5]. Skipped
	// when either input is missing or non-positive — a zero/NaN ATR shouldn't
	// silently inflate risk.
	const volMultiplier =
		Number.isFinite(currentAtrPct) &&
		(currentAtrPct as number) > 0 &&
		Number.isFinite(medianAtrPct30d) &&
		(medianAtrPct30d as number) > 0
			? Math.min(1.5, Math.max(0.5, (medianAtrPct30d as number) / (currentAtrPct as number)))
			: 1;

	const riskDistance = Math.abs(entryPrice - stopLoss);
	if (riskDistance === 0 || entryPrice <= 0 || equity <= 0) {
		return { qty: 0, tier: "skip", riskPct: 0, entryPrice };
	}

	const isUnanimous =
		ensembleAgreeingCount === ensembleVoterCount && ensembleVoterCount > 1;
	const isMajority = ensembleAgreeingCount > 1;
	const hasConfirmedEdge = edgeVerdict === "confirmed";
	const hasAnyEdge = edgeVerdict === "confirmed" || edgeVerdict === "weak";

	let tier: SizerResult["tier"];
	let baseRiskPct: number;

	if (isUnanimous && hasConfirmedEdge) {
		tier = "high";
		baseRiskPct = 0.03;
	} else if (isMajority) {
		tier = "medium";
		baseRiskPct = 0.015;
	} else if (hasAnyEdge) {
		tier = "low";
		baseRiskPct = 0.005;
	} else {
		return { qty: 0, tier: "skip", riskPct: 0, entryPrice };
	}

	// Quarter-Kelly overlay: the existing confidence tiers act as the edge proxy,
	// then the Kelly fraction scales the final risk budget down to 25%.
	const kellyScaledRiskPct =
		sizingModel === "fractional_kelly_0.25" ? baseRiskPct * 0.25 : baseRiskPct;
	const qualityScale =
		Number.isFinite(executionQualityScale) && (executionQualityScale as number) > 0
			? Math.min(1, Math.max(0.35, executionQualityScale as number))
			: 1;
	// Grade and quality scale the risk budget BEFORE quantity derivation —
	// they affect how much risk to take, not how many tokens to buy.
	const grade =
		Number.isFinite(strategyGradeScale) && strategyGradeScale >= 0 ? strategyGradeScale : 1;
	const riskPct = kellyScaledRiskPct * qualityScale * grade * volMultiplier;

	const riskAmount = equity * riskPct;
	const riskQty = riskAmount / riskDistance;
	const riskNotional = riskQty * entryPrice;

	// Hard cap: maxTradeUsd — primary dollar limit per trade
	const maxQtyByDollarCap = maxTradeUsd / entryPrice;
	// Hard cap: 5% of equity — safety rail against degenerate tiny-stop scenarios
	// Only activated when the risk-derived notional would exceed 2× the account size,
	// which indicates an unrealistically tight stop inflating position size.
	const maxQtyByEquityCap = (equity * 0.05) / entryPrice;

	let qty: number;
	if (riskNotional > equity * 2) {
		qty = Math.min(riskQty, maxQtyByEquityCap, maxQtyByDollarCap);
	} else {
		qty = Math.min(riskQty, maxQtyByDollarCap);
	}
	qty = Math.round(qty * 1e8) / 1e8;

	// Belt-and-suspenders: no matter what upstream math produces, the output
	// can never exceed the dollar limit.
	if (qty * entryPrice > maxTradeUsd) {
		qty = Math.round((maxTradeUsd / entryPrice) * 1e8) / 1e8;
	}

	// Correlation scaling — applied AFTER hard caps so a stack of correlated
	// positions can only ever shrink notional, never expand it past maxTradeUsd.
	// The fee-floor check below sees the post-scale notional, so a reduced
	// trade that drops below break-even fees is skipped instead of executed.
	if (corrScale < 1) {
		qty = Math.round(qty * corrScale * 1e8) / 1e8;
	}

	if (qty <= 0) {
		return { qty: 0, tier: "skip", riskPct: 0, entryPrice };
	}

	// Fee-aware sizing floor (May 2026 audit): block undersized trades whose
	// notional cannot cover round-trip fees with reasonable margin. Audit found
	// average notional was $20 vs. ~$31.53 break-even at 0.075% fees — those
	// trades were structurally unprofitable. Skip rather than scale up: pushing
	// notional up would violate maxTradeUsd / risk caps, so we just stand down.
	const finalNotional = qty * entryPrice;
	const minNotional = feeAwareMinNotional(feeRate);
	if (enforceFeeFloor && finalNotional < minNotional) {
		return { qty: 0, tier: "fee-floor", riskPct: 0, entryPrice };
	}

	return { qty, tier, riskPct, entryPrice };
}
