/**
 * ExchangeResponseValidator — Zod-based validation for exchange API responses.
 *
 * Ensures ticker, order-fill, and balance payloads from external exchanges
 * conform to expected shapes before the trading engine acts on them.
 * Unknown fields are stripped; required fields and numeric ranges are enforced.
 */

import { z } from "zod";

// ── Schemas ──

/** Positive number (> 0) with coercion for stringified values */
const positiveNum = z.coerce.number().positive();

/** Non-negative number (>= 0) with coercion */
const nonNegativeNum = z.coerce.number().min(0);

export const TickerResponseSchema = z
  .object({
    price: positiveNum,
    volume: nonNegativeNum,
    bid: positiveNum,
    ask: positiveNum,
  })
  .strip();

export type TickerResponse = z.infer<typeof TickerResponseSchema>;

export const OrderFillSchema = z
  .object({
    orderId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.enum(["buy", "sell"]),
    qty: positiveNum,
    price: positiveNum,
    fee: nonNegativeNum,
    status: z.string().min(1),
  })
  .strip();

export type OrderFill = z.infer<typeof OrderFillSchema>;

export const BalanceSchema = z
  .object({
    currency: z.string().min(1),
    available: nonNegativeNum,
    locked: nonNegativeNum,
  })
  .strip();

export type Balance = z.infer<typeof BalanceSchema>;

// ── Validation helpers ──

class ExchangeValidationError extends Error {
  constructor(exchange: string, type: string, issues: z.ZodIssue[]) {
    const details = issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    super(`[${exchange}] Invalid ${type}: ${details}`);
    this.name = "ExchangeValidationError";
  }
}

function validate<T>(
  schema: z.ZodType<T>,
  data: unknown,
  exchange: string,
  type: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ExchangeValidationError(exchange, type, result.error.issues);
  }
  return result.data;
}

export function validateTickerResponse(
  data: unknown,
  exchange: string,
): TickerResponse {
  return validate(TickerResponseSchema, data, exchange, "ticker");
}

export function validateOrderFill(
  data: unknown,
  exchange: string,
): OrderFill {
  return validate(OrderFillSchema, data, exchange, "order fill");
}

export function validateBalance(
  data: unknown,
  exchange: string,
): Balance {
  return validate(BalanceSchema, data, exchange, "balance");
}
