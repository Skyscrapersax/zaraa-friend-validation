/**
 * Pre-trade profitability screen for paper/live signal execution.
 *
 * Estimates expected gross edge from the stop/take-profit geometry (risk-reward
 * × stop distance in bps), then runs the D1 net-edge gate with capital floor
 * disabled so $25–$50 paper tickets can still be filtered by bps economics.
 *
 * Goal: only enter when the planned TP can clear 2× round-trip fees+spread+slip
 * (and optional tax). Stops fee-bleed scalps that cannot pay for themselves.
 */

import {
	computeNetEdgeGate,
	type NetEdgeGateResult,
} from "./net-edge-gate.js";
import { resolveFeeRate, resolveVenue, getDefaultFeeSchedules, type FeeSchedule } from "./fee-schedule.js";

export interface PreTradeEdgeInput {
	symbol: string;
	direction: "long" | "short";
	entryPrice: number;
	stopLoss: number;
	takeProfit: number;
	/** Planned notional in USD (qty * entry). Used only for cost stack. */
	notionalUsd: number;
	/** Round-trip spread assumption, bps. Default 10. */
	spreadBps?: number;
	/** One-way modeled paper slip, bps (doubled for RT). Default 10. */
	slippageBps?: number;
	/** Required multiple of tax-adjusted cost. Default 2. */
	multiple?: number;
	/** Minimum reward:risk (TP dist / SL dist). Default 2. */
	minRiskReward?: number;
	/** Tax rate 0..1 applied to winners. Default 0 for pure paper expectancy. */
	shortTermTaxRate?: number;
	feeSchedule?: FeeSchedule[];
	/** Override taker fee bps (one side). */
	takerFeeBps?: number;
}

export interface PreTradeEdgeResult {
	pass: boolean;
	grossEdgeBps: number;
	riskReward: number;
	stopBps: number;
	tpBps: number;
	netEdge: NetEdgeGateResult;
	reason: string;
}

/** Absolute distance from entry to stop/TP as fraction of entry, in bps. */
export function priceDistanceBps(entry: number, level: number): number {
	if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(level)) return 0;
	return (Math.abs(level - entry) / entry) * 10_000;
}

/**
 * Gross edge proxy: full take-profit distance in bps (what we capture if TP hits).
 * Conservative: we do not blend win-rate here — the hurdle multiple covers that.
 */
export function estimateGrossEdgeBpsFromLevels(
	entry: number,
	stop: number,
	takeProfit: number,
): { grossEdgeBps: number; stopBps: number; tpBps: number; riskReward: number } {
	const stopBps = priceDistanceBps(entry, stop);
	const tpBps = priceDistanceBps(entry, takeProfit);
	const riskReward = stopBps > 0 ? tpBps / stopBps : 0;
	return { grossEdgeBps: tpBps, stopBps, tpBps, riskReward };
}

export function evaluatePreTradeEdge(input: PreTradeEdgeInput): PreTradeEdgeResult {
	const minRr = input.minRiskReward ?? 2;
	const spreadBps = input.spreadBps ?? 10;
	const slipOneWay = input.slippageBps ?? 10;
	const schedules = input.feeSchedule ?? getDefaultFeeSchedules();
	const venue = resolveVenue(input.symbol);
	const takerRate =
		input.takerFeeBps != null
			? input.takerFeeBps / 10_000
			: resolveFeeRate(venue, "MARKET", schedules);
	const takerFeeBps = takerRate * 10_000;

	const { grossEdgeBps, stopBps, tpBps, riskReward } = estimateGrossEdgeBpsFromLevels(
		input.entryPrice,
		input.stopLoss,
		input.takeProfit,
	);

	if (stopBps <= 0 || tpBps <= 0) {
		const netEdge = computeNetEdgeGate({
			grossEdgeBps: 0,
			takerFeeBps,
			spreadBps: spreadBps + 2 * slipOneWay,
			avgTradeNotionalUsd: Math.max(input.notionalUsd, 1),
			capitalFloorUsd: 0,
			shortTermTaxRate: input.shortTermTaxRate ?? 0,
			multiple: input.multiple ?? 2,
		});
		return {
			pass: false,
			grossEdgeBps,
			riskReward,
			stopBps,
			tpBps,
			netEdge,
			reason: "fail: missing or zero stop/take-profit geometry",
		};
	}

	if (riskReward < minRr) {
		const netEdge = computeNetEdgeGate({
			grossEdgeBps,
			takerFeeBps,
			spreadBps: spreadBps + 2 * slipOneWay,
			avgTradeNotionalUsd: Math.max(input.notionalUsd, 1),
			capitalFloorUsd: 0,
			shortTermTaxRate: input.shortTermTaxRate ?? 0,
			multiple: input.multiple ?? 2,
		});
		return {
			pass: false,
			grossEdgeBps,
			riskReward,
			stopBps,
			tpBps,
			netEdge,
			reason: `fail: reward:risk ${riskReward.toFixed(2)} < min ${minRr} (TP ${tpBps.toFixed(0)}bps / SL ${stopBps.toFixed(0)}bps)`,
		};
	}

	// Spread + both-side slip folded into spreadBps for the gate's cost stack
	// (gate already doubles taker fee).
	const netEdge = computeNetEdgeGate({
		grossEdgeBps,
		takerFeeBps,
		spreadBps: spreadBps + 2 * slipOneWay,
		sqrtImpactBps: 0,
		fixedCostUsd: 0,
		avgTradeNotionalUsd: Math.max(input.notionalUsd, 1),
		capitalFloorUsd: 0,
		shortTermTaxRate: input.shortTermTaxRate ?? 0,
		multiple: input.multiple ?? 2,
	});

	return {
		pass: netEdge.pass,
		grossEdgeBps,
		riskReward,
		stopBps,
		tpBps,
		netEdge,
		reason: netEdge.reason,
	};
}
