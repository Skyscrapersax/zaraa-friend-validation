import { resolveFeeRate, type FeeSchedule } from "./fee-schedule.js";

export interface TradeCostResult {
	adjustedPrice: number;
	feeAmount: number;
	feeRate: number;
	slippageBps: number;
}

export function applySlippage(
	price: number,
	side: "BUY" | "SELL",
	slippageBps: number,
): number {
	if (slippageBps === 0) return price;
	const multiplier =
		side === "BUY" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
	return price * multiplier;
}

export function computeTradeCost(params: {
	price: number;
	qty: number;
	side: "BUY" | "SELL";
	orderType: "MARKET" | "LIMIT";
	venue: string;
	feeSchedule: FeeSchedule[];
	slippageBps: number;
}): TradeCostResult {
	const adjustedPrice = applySlippage(params.price, params.side, params.slippageBps);
	const feeRate = resolveFeeRate(params.venue, params.orderType, params.feeSchedule);
	const feeAmount = feeRate * params.qty * adjustedPrice;
	return {
		adjustedPrice,
		feeAmount,
		feeRate,
		slippageBps: params.slippageBps,
	};
}
