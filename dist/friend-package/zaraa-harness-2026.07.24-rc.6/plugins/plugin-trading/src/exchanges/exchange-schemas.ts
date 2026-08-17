/**
 * Centralized Zod output validation schemas for exchange API responses.
 *
 * These validate the *normalized* data (after field mapping and Number conversion)
 * before it reaches the trading engine. They catch:
 * - NaN from invalid string → Number() coercion (e.g. Number("") or Number(null))
 * - Infinity / -Infinity from edge cases
 * - Negative prices or volumes that indicate corrupt data
 * - Missing or wrong-typed fields
 *
 * Used by all exchange adapters at the output boundary.
 */
import { z } from "zod";

// ── Output Schemas ──────────────────────────────────────────────────────────

export const TickerOutputSchema = z.object({
	symbol: z.string().min(1),
	bid: z.number().finite().positive(),
	ask: z.number().finite().positive(),
	last: z.number().finite().positive(),
	high24h: z.number().finite().nonnegative(),
	low24h: z.number().finite().nonnegative(),
	volume24h: z.number().finite().nonnegative(),
	change24h: z.number().finite(),
});

export const OrderBookEntrySchema = z.object({
	price: z.number().finite().positive(),
	qty: z.number().finite().positive(),
});

export const OrderBookOutputSchema = z.object({
	symbol: z.string().min(1),
	bids: z.array(OrderBookEntrySchema),
	asks: z.array(OrderBookEntrySchema),
});

export const CandleOutputSchema = z.object({
	openTime: z.number().finite().nonnegative(),
	open: z.number().finite().positive(),
	high: z.number().finite().positive(),
	low: z.number().finite().positive(),
	close: z.number().finite().positive(),
	volume: z.number().finite().nonnegative(),
});

export const BalanceOutputSchema = z.object({
	currency: z.string().min(1),
	available: z.number().finite().nonnegative(),
	locked: z.number().finite().nonnegative(),
	total: z.number().finite().nonnegative(),
});

export const TradeResultOutputSchema = z.object({
	orderId: z.string().min(1),
	symbol: z.string().min(1),
	side: z.enum(["BUY", "SELL"]),
	type: z.enum(["MARKET", "LIMIT"]),
	qty: z.number().finite().nonnegative(),
	status: z.string().min(1),
}).passthrough();

// ── Validation Helper ───────────────────────────────────────────────────────

/**
 * Validates output data against a schema. On failure, throws a descriptive
 * error with the exchange name and field-level details.
 */
export function validateOutput<T>(
	schema: z.ZodType<T>,
	data: unknown,
	context: string,
): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		const details = result.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
		throw new Error(`Exchange validation failed (${context}): ${details}`);
	}
	return result.data;
}

// ── Type Exports ────────────────────────────────────────────────────────────

export type ValidatedTicker = z.infer<typeof TickerOutputSchema>;
export type ValidatedOrderBook = z.infer<typeof OrderBookOutputSchema>;
export type ValidatedCandle = z.infer<typeof CandleOutputSchema>;
export type ValidatedBalance = z.infer<typeof BalanceOutputSchema>;
export type ValidatedTradeResult = z.infer<typeof TradeResultOutputSchema>;
