import { parseSolanaDexTokenSymbol } from "./dex-execution-symbol.js";
import { SolanaClient } from "./solana-client.js";

/** Spot USD price for `solana:TOKEN` via DexScreener-backed client; null if unknown. */
export async function fetchDexSolanaUsdPrice(symbol: string): Promise<number | null> {
	const tok = parseSolanaDexTokenSymbol(symbol);
	if (!tok) return null;
	try {
		const client = new SolanaClient();
		const pair = await client.getBestPair(tok);
		return pair?.priceUsd ?? null;
	} catch {
		return null;
	}
}
