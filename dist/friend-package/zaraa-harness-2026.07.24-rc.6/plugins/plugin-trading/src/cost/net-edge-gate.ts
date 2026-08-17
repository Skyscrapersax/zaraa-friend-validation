/**
 * D1 — Real net-edge gate. A strategy is only worth promoting if its expected
 * gross edge per round trip clears a multiple of the FULL cost stack, not the
 * 10-20 bps people assume. The stack is:
 *
 *   costBps = 2×takerFee + spread + sqrtImpact + (fixedCost / notional)
 *   hurdle  = multiple × costBps / (1 − shortTermTaxRate)
 *
 * Below a capital floor, fixed per-transaction costs (gas, withdrawal, minimum
 * order slices) dominate as a percentage of tiny notional, so the strategy class
 * is structurally uncertifiable regardless of bps.
 *
 * Callers MUST pass the WORST-tier taker fee (a tiny account gets no volume
 * discount) and a realistic per-symbol spread.
 *
 * See docs/research/2026-06-13-markets-understanding-build-spec.md (D1).
 */

export interface NetEdgeGateInput {
	/** Expected gross edge per round trip, in bps. */
	grossEdgeBps: number;
	/** Worst-tier taker fee, bps (charged per side; a round trip pays it twice). */
	takerFeeBps: number;
	/** Effective spread cost per round trip, bps. */
	spreadBps: number;
	/** Market-impact cost, bps (≈0 at tiny size on majors). */
	sqrtImpactBps?: number;
	/** Fixed per-round-trip cost in USD (gas, withdrawal slice). */
	fixedCostUsd?: number;
	/** Average trade notional, USD — for fixed-cost-as-bps and the capital floor. */
	avgTradeNotionalUsd: number;
	/** Short-term capital-gains rate, 0..1. Raises the hurdle. */
	shortTermTaxRate?: number;
	/** Required ratio of gross edge to tax-adjusted cost. Default 2. */
	multiple?: number;
	/**
	 * Notional below which the strategy class is structurally uncertifiable.
	 * Default $5,000. Pass `0` to disable the floor (per-trade bps filter only —
	 * used by the micro paper pre-trade gate at $25–$50 tickets).
	 */
	capitalFloorUsd?: number;
}

export interface NetEdgeGateResult {
	netEdgeBps: number;
	costBps: number;
	hurdleBps: number;
	pass: boolean;
	structurallyUncertifiable: boolean;
	reason: string;
}

export function computeNetEdgeGate(input: NetEdgeGateInput): NetEdgeGateResult {
	const multiple = input.multiple ?? 2;
	const capitalFloorUsd = input.capitalFloorUsd ?? 5_000;
	const tax = Math.min(Math.max(input.shortTermTaxRate ?? 0, 0), 0.99);
	const notional = input.avgTradeNotionalUsd;

	const fixedCostBps =
		notional > 0 ? ((input.fixedCostUsd ?? 0) / notional) * 10_000 : Number.POSITIVE_INFINITY;
	const costBps =
		2 * input.takerFeeBps + input.spreadBps + (input.sqrtImpactBps ?? 0) + fixedCostBps;
	const taxAdjustedCostBps = costBps / (1 - tax);
	const hurdleBps = multiple * taxAdjustedCostBps;
	const netEdgeBps = input.grossEdgeBps - taxAdjustedCostBps;

	// capitalFloorUsd === 0 disables the structural floor (explicit opt-in for
	// per-trade micro paper filters that still enforce the bps hurdle).
	if (
		capitalFloorUsd > 0 &&
		(!Number.isFinite(notional) || notional < capitalFloorUsd)
	) {
		return {
			netEdgeBps,
			costBps,
			hurdleBps,
			pass: false,
			structurallyUncertifiable: true,
			reason: `structurally uncertifiable: avg notional $${Number.isFinite(notional) ? notional.toFixed(0) : "0"} < $${capitalFloorUsd} capital floor — fixed costs dominate at this size`,
		};
	}

	const pass = input.grossEdgeBps > hurdleBps;
	return {
		netEdgeBps,
		costBps,
		hurdleBps,
		pass,
		structurallyUncertifiable: false,
		reason: pass
			? `pass: gross ${input.grossEdgeBps.toFixed(1)}bps > ${hurdleBps.toFixed(1)}bps hurdle (net ${netEdgeBps.toFixed(1)}bps after ${taxAdjustedCostBps.toFixed(1)}bps cost)`
			: `fail: gross ${input.grossEdgeBps.toFixed(1)}bps ≤ ${hurdleBps.toFixed(1)}bps hurdle (${multiple}× tax-adjusted cost ${taxAdjustedCostBps.toFixed(1)}bps) — margin insufficient`,
	};
}
