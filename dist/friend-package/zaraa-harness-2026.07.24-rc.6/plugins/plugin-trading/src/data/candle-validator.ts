import type { Candle } from "./candle-store.js";

/**
 * Validates OHLC integrity for a single candle bar.
 *
 * Rules enforced:
 *  - openTime must be a finite number
 *  - open, high, low, close must be finite and > 0
 *  - volume must be finite and >= 0
 *  - high >= low
 *  - high >= max(open, close)
 *  - low  <= min(open, close)
 *
 * This is a pure function — no side effects, no schema mutation.
 */
export function isValidCandle(c: Candle): boolean {
	if (!Number.isFinite(c.openTime)) return false;
	if (!Number.isFinite(c.open)  || c.open  <= 0) return false;
	if (!Number.isFinite(c.high)  || c.high  <= 0) return false;
	if (!Number.isFinite(c.low)   || c.low   <= 0) return false;
	if (!Number.isFinite(c.close) || c.close <= 0) return false;
	if (!Number.isFinite(c.volume) || c.volume < 0) return false;

	// OHLC structural consistency
	if (c.high < c.low) return false;
	if (c.high < c.open || c.high < c.close) return false;
	if (c.low  > c.open || c.low  > c.close) return false;

	return true;
}

/**
 * Filter a batch of candles, dropping any that fail OHLC integrity checks.
 * Emits a single `console.warn` for each dropped bar (with the drop count
 * per batch visible to the caller via the returned array length delta).
 */
export function sanitizeCandles(candles: Candle[]): Candle[] {
	const valid: Candle[] = [];
	for (const c of candles) {
		if (isValidCandle(c)) {
			valid.push(c);
		} else {
			console.warn(
				`[candle-validator] dropping invalid candle ${c.symbol}/${c.timeframe} openTime=${c.openTime}` +
				` o=${c.open} h=${c.high} l=${c.low} cl=${c.close} v=${c.volume}`,
			);
		}
	}
	return valid;
}
