/**
 * TP distance cap shared by ATR-based strategies.
 *
 * High-ATR alt pairs (SOL, XRP) were producing TP targets 10–11% from entry
 * with effective R/R of 8–10x — unreachable in normal market conditions and
 * the dominant cause of the shadow-soak win-rate collapse on alts. This
 * utility caps both the effective R/R *and* the absolute TP distance, with
 * the smaller of the two winning. The ATR-based SL is left untouched (it's
 * working fine); only the TP target shrinks.
 *
 * Safety floor: the cap can never make the TP closer than the SL — that
 * would invert the trade's risk profile. If the inputs would force R/R < 1.0,
 * we clamp R/R to exactly 1.0 and log a warning.
 */

export const DEFAULT_MAX_RISK_REWARD_RATIO = 3.0;
export const DEFAULT_MAX_TP_PERCENT = 4.0;

export interface TpCapOptions {
	/** Hard ceiling on takeProfit distance / stopLoss distance. Default 3.0 */
	maxRiskRewardRatio?: number;
	/** Hard ceiling on |takeProfit - entry| / entry, expressed as percent (4 = 4%). Default 4.0 */
	maxTpPercent?: number;
	/** Symbol/strategy tag for log line — purely cosmetic */
	context?: string;
}

export interface TpCapResult {
	takeProfit: number;
	capped: boolean;
	reason?: "rr" | "abs" | "floor";
}

/**
 * Apply the TP cap. Returns the original TP unchanged when no cap binds;
 * otherwise returns the capped TP and emits a single log line.
 *
 * Direction is inferred from the relative position of TP and entry:
 *   - takeProfit > entry → long
 *   - takeProfit < entry → short
 *   - equal → no-op (returns original)
 *
 * Inputs that aren't strictly positive finite numbers fall through unchanged
 * (defensive; caller is expected to validate, but we don't want a NaN/0 to
 * silently push a TP across the entry).
 */
export function applyTpCap(
	entryPrice: number,
	stopLoss: number,
	takeProfit: number,
	opts: TpCapOptions = {},
): TpCapResult {
	if (
		!Number.isFinite(entryPrice) || entryPrice <= 0 ||
		!Number.isFinite(stopLoss) || stopLoss <= 0 ||
		!Number.isFinite(takeProfit) || takeProfit <= 0
	) {
		return { takeProfit, capped: false };
	}

	const isLong = takeProfit > entryPrice;
	const isShort = takeProfit < entryPrice;
	if (!isLong && !isShort) return { takeProfit, capped: false };

	// SL must sit on the opposite side of entry from TP for a real trade.
	// If it doesn't, the caller has a bug we shouldn't paper over — leave the
	// values alone and let the higher-level risk manager reject the signal.
	const slDistance = isLong ? entryPrice - stopLoss : stopLoss - entryPrice;
	if (slDistance <= 0) return { takeProfit, capped: false };

	const maxRR = opts.maxRiskRewardRatio ?? DEFAULT_MAX_RISK_REWARD_RATIO;
	const maxTpPct = opts.maxTpPercent ?? DEFAULT_MAX_TP_PERCENT;

	const originalTpDistance = Math.abs(takeProfit - entryPrice);
	const originalRR = originalTpDistance / slDistance;
	const originalTpPct = (originalTpDistance / entryPrice) * 100;

	// Each cap yields a candidate TP distance; the smaller (tighter) wins.
	const rrCapDistance = slDistance * Math.max(maxRR, 0);
	const absCapDistance = entryPrice * (Math.max(maxTpPct, 0) / 100);

	let cappedDistance = originalTpDistance;
	let reason: "rr" | "abs" | undefined;

	if (rrCapDistance < cappedDistance) {
		cappedDistance = rrCapDistance;
		reason = "rr";
	}
	if (absCapDistance < cappedDistance) {
		cappedDistance = absCapDistance;
		reason = "abs";
	}

	// Safety floor: never let TP be closer than SL. If the configured caps
	// would push R/R below 1.0, clamp back up to exactly the SL distance and
	// emit a warning so the misconfiguration is visible.
	let floorTriggered = false;
	if (cappedDistance < slDistance) {
		floorTriggered = true;
		cappedDistance = slDistance;
		console.warn(
			`[shadow] TP cap floor triggered${opts.context ? ` (${opts.context})` : ""}: ` +
				`requested R/R cap=${maxRR}, abs cap=${maxTpPct}% would yield R/R<1.0; ` +
				`clamping to R/R=1.0 (TP distance = SL distance)`,
		);
	}

	if (cappedDistance >= originalTpDistance) {
		return { takeProfit, capped: false };
	}

	const cappedTp = isLong ? entryPrice + cappedDistance : entryPrice - cappedDistance;
	const finalReason: "rr" | "abs" | "floor" = floorTriggered ? "floor" : (reason ?? "rr");

	console.log(
		`[shadow] TP capped${opts.context ? ` (${opts.context})` : ""}: ` +
			`original=${takeProfit.toFixed(4)} capped=${cappedTp.toFixed(4)} ` +
			`reason=${finalReason} ` +
			`(orig R/R=${originalRR.toFixed(2)}, orig TP%=${originalTpPct.toFixed(2)})`,
	);

	return { takeProfit: cappedTp, capped: true, reason: finalReason };
}
