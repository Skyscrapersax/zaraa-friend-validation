/**
 * Canonical JSON envelopes for `trade_get_price` / `trade_get_prices` tool outputs
 * (validated with Zod before returning from handlers).
 */

import { z } from "zod";
import type { Ticker } from "../crypto-client.js";

/** Percent string, e.g. "+1.25%" / "-2.00%" / "+0.00%" */
export const tradeChange24hPctStringSchema = z.string().regex(/^[+-][0-9]+\.[0-9]{2}%$/);

export const tradeSpotQuoteSchema = z.object({
	symbol: z.string(),
	price: z.number(),
	bid: z.number(),
	ask: z.number(),
	high24h: z.number(),
	low24h: z.number(),
	volume24h: z.number(),
	change24h: tradeChange24hPctStringSchema,
});

export type TradeSpotQuote = z.infer<typeof tradeSpotQuoteSchema>;

export const tradeGetPriceResponseSchema = z.object({
	result: tradeSpotQuoteSchema,
});

export const tradeSpotBatchErrSchema = z.object({
	symbol: z.string(),
	price: z.null(),
	error: z.string(),
});

export const tradeSpotBatchRowSchema = z.union([tradeSpotQuoteSchema, tradeSpotBatchErrSchema]);

export const tradeGetPricesResponseSchema = z.object({
	results: z.array(tradeSpotBatchRowSchema),
});

export function formatChange24hDisplay(change24h: number): string {
	const body = (change24h * 100).toFixed(2);
	const sign = change24h > 0 ? "+" : change24h < 0 ? "" : "+";
	return `${sign}${body}%`;
}

export function spotQuoteFromTicker(t: Ticker): TradeSpotQuote {
	return {
		symbol: t.symbol,
		price: t.last,
		bid: t.bid,
		ask: t.ask,
		high24h: t.high24h,
		low24h: t.low24h,
		volume24h: t.volume24h,
		change24h: formatChange24hDisplay(t.change24h),
	};
}
