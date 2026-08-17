import { randomUUID } from "node:crypto";

/** Source of the order for audit / operator grep. */
export type TradingOrderAuditSource = "trade_buy" | "trade_sell" | "trade_dex_swap" | "execution_manager";

/**
 * Grep-friendly id: `grep zord_ ~/.zaraa/data/audit/audit.jsonl`
 * (matches `orderAuditCorrelationId` in tool responses.)
 */
export function generateTradingOrderCorrelationId(): string {
	return `zord_${randomUUID()}`;
}

export interface TradingOrderAuditPayload {
	correlationId: string;
	source: TradingOrderAuditSource;
	symbol: string;
	side: string;
	mode: "PAPER" | "LIVE" | "SHADOW";
	orderId?: string;
	positionId?: string;
	qty: number;
	/** Short human summary for audit `result` field */
	resultSummary: string;
}
