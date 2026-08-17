/**
 * Validates `trade_risk_status`-shaped payloads for internally consistent halt / gate semantics.
 * Catches fabricated or merged JSON where `newEntriesAllowed` disagrees with halt flags or state.
 */

export type TradeRiskStatusSemanticsResult =
	| { ok: true }
	| { ok: false; conflicts: string[] };

function isRecord(x: unknown): x is Record<string, unknown> {
	return x != null && typeof x === "object" && !Array.isArray(x);
}

/**
 * @param payload — parsed `trade_risk_status` object (or partial for tests)
 */
export function validateTradeRiskStatusSemantics(
	payload: unknown,
): TradeRiskStatusSemanticsResult {
	const conflicts: string[] = [];

	if (!isRecord(payload)) {
		return { ok: false, conflicts: ["payload must be a plain object"] };
	}

	const eg = payload.emergencyGates;
	if (!isRecord(eg)) {
		return { ok: false, conflicts: ["emergencyGates must be an object"] };
	}

	if (typeof eg.newEntriesAllowed !== "boolean") {
		return {
			ok: false,
			conflicts: ["emergencyGates.newEntriesAllowed must be a boolean"],
		};
	}

	const newEntriesAllowed = eg.newEntriesAllowed === true;
	const tradingState = eg.tradingState;

	if (newEntriesAllowed) {
		if (tradingState === "HALTED" || tradingState === "LOCKED") {
			conflicts.push(
				"halt_semantics: newEntriesAllowed is true but tradingState is HALTED or LOCKED",
			);
		}
		if (eg.tradingKillSwitch === true) {
			conflicts.push("halt_semantics: newEntriesAllowed is true but tradingKillSwitch is true");
		}
		if (eg.circuitBreakerHalted === true) {
			conflicts.push(
				"halt_semantics: newEntriesAllowed is true but circuitBreakerHalted is true",
			);
		}
		if (eg.dailyCapBreached === true) {
			conflicts.push("halt_semantics: newEntriesAllowed is true but dailyCapBreached is true");
		}
		if (eg.venueHalted === true) {
			conflicts.push("halt_semantics: newEntriesAllowed is true but venueHalted is true");
		}
		if (eg.automatedRiskLockTriggered === true) {
			conflicts.push(
				"halt_semantics: newEntriesAllowed is true but automatedRiskLockTriggered is true",
			);
		}
	} else {
		const haltState = tradingState === "HALTED" || tradingState === "LOCKED";
		const anyFlag =
			eg.tradingKillSwitch === true ||
			eg.circuitBreakerHalted === true ||
			eg.dailyCapBreached === true ||
			eg.venueHalted === true ||
			eg.automatedRiskLockTriggered === true ||
			haltState;
		const br = eg.blockReason;
		const hasBlockReason = typeof br === "string" && br.trim().length > 0;
		if (!anyFlag && !hasBlockReason && tradingState === "OK") {
			conflicts.push(
				"halt_semantics: newEntriesAllowed is false but tradingState is OK with no halt flags and no blockReason",
			);
		}
	}

	return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts };
}
