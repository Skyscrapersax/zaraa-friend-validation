import type { CrossVenueMispricingCandidate } from "./cross-venue-mispricing.js";

const DEFAULT_PAPER_CAP_USD = 50;

export interface CrossVenuePaperFill {
	fillId: string;
	ts: string;
	pairKey: string;
	question: string;
	buyExchange: string;
	buyMarketId: string;
	buyPrice: number;
	sellExchange: string;
	sellMarketId: string;
	sellPrice: number;
	netEdge: number;
	capUsd: number;
	notionalUsd: number;
	simulatedPnlUsd: number;
	strategyName: "cross_venue_arb";
}

export interface SimulatePaperFillsOptions {
	paperCapUsd?: number;
	nowMs?: number;
}

/**
 * Pure paper-fill simulator. Given a list of detected mispricing candidates,
 * size each one at min(paperCap, smaller-leg liquidity) and credit paper PnL
 * = notional * netEdge. No live orders, no DB writes — pure transform.
 *
 * `nowMs` lets callers seed deterministic timestamps in tests.
 */
export function simulateCrossVenuePaperFills(
	candidates: CrossVenueMispricingCandidate[],
	options: SimulatePaperFillsOptions = {},
): CrossVenuePaperFill[] {
	const cap = Math.max(0, options.paperCapUsd ?? DEFAULT_PAPER_CAP_USD);
	if (cap === 0) return [];
	const now = options.nowMs ?? Date.now();
	const fills: CrossVenuePaperFill[] = [];
	let i = 0;
	for (const candidate of candidates) {
		const liquidityFloor = Math.max(0, candidate.liquidityFloor);
		if (liquidityFloor <= 0 || candidate.netEdge <= 0) continue;
		const notional = Math.min(cap, liquidityFloor);
		if (notional <= 0) continue;
		const pnl = notional * candidate.netEdge;
		fills.push({
			fillId: `cva-${now}-${i++}`,
			ts: new Date(now).toISOString(),
			pairKey: candidate.pairKey,
			question: candidate.question,
			buyExchange: candidate.buy.exchange,
			buyMarketId: candidate.buy.marketId,
			buyPrice: candidate.buy.yesAsk,
			sellExchange: candidate.sell.exchange,
			sellMarketId: candidate.sell.marketId,
			sellPrice: candidate.sell.yesBid,
			netEdge: candidate.netEdge,
			capUsd: cap,
			notionalUsd: notional,
			simulatedPnlUsd: round4(pnl),
			strategyName: "cross_venue_arb",
		});
	}
	return fills;
}

export function summarizePaperFills(fills: CrossVenuePaperFill[]): {
	count: number;
	cumulativePnlUsd: number;
	avgEdgeBps: number;
} {
	if (!fills.length) return { count: 0, cumulativePnlUsd: 0, avgEdgeBps: 0 };
	const cumulative = fills.reduce((s, f) => s + f.simulatedPnlUsd, 0);
	const avgEdge = fills.reduce((s, f) => s + f.netEdge, 0) / fills.length;
	return {
		count: fills.length,
		cumulativePnlUsd: round4(cumulative),
		avgEdgeBps: Math.round(avgEdge * 10000),
	};
}

function round4(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 10000) / 10000;
}
