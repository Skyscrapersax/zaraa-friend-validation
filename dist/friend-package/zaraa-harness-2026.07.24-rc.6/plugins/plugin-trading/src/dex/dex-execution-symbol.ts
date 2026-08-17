/**
 * Conventions for routing signal-engine / executeTrade to on-chain execution (vs CEX).
 *
 * Symbols like `solana:SOL` mean "spot exposure to SOL on Solana" via Jupiter swaps.
 */

/** Stored on positions / trade_log when execution is Solana + Jupiter. */
export const DEX_EXECUTION_VENUE_SOLANA = "dex_solana";

const SOLANA_PREFIX = "solana:";

/** True if the symbol should use Jupiter / Solana swap execution instead of CryptoClient. */
export function isDexSolanaExecutionSymbol(symbol: string): boolean {
	const s = symbol.trim().toLowerCase();
	return s.startsWith(SOLANA_PREFIX) && s.length > SOLANA_PREFIX.length;
}

/**
 * Parse `solana:TOKEN` or `solana:BASE/QUOTE` → base token symbol
 * (e.g. `solana:SOL` → `SOL`, `solana:SOL/USDC` → `SOL`).
 * Returns null if not a Solana dex symbol.
 *
 * BUG FIX (2026-04-26): Previously returned `SOL/USDC` for pair-format symbols,
 * causing DexScreener to match the quote currency (USDC ≈ $1) instead of the base
 * currency (SOL ≈ $86). This produced phantom ~$99 losses on every SOL/USDC close,
 * tripped the drawdown circuit breaker, and halted all trading.
 */
export function parseSolanaDexTokenSymbol(symbol: string): string | null {
	if (!isDexSolanaExecutionSymbol(symbol)) return null;
	const raw = symbol.trim().slice(SOLANA_PREFIX.length).toUpperCase();
	// Handle pair format: "SOL/USDC" → "SOL" (extract base token before the slash)
	const slashIdx = raw.indexOf("/");
	return slashIdx >= 0 ? raw.slice(0, slashIdx) : raw;
}
