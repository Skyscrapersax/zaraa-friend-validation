/**
 * Solana DEX client — uses DexScreener API + Solana RPC.
 * Covers Jupiter, Raydium, Orca, and all major Solana DEXes.
 */

import { z } from "zod";

const DEXSCREENER = "https://api.dexscreener.com";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const TIMEOUT_MS = 15_000;

// ── Safe JSON parse helper ──

async function safeJsonParse<T>(res: Response, context: string): Promise<T> {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${context}: expected JSON but got: ${text.slice(0, 200)}`);
	}
}

// ── Zod schemas for DexScreener API responses ──

const DexScreenerTokenSchema = z.object({
	address: z.string(),
	symbol: z.string(),
	name: z.string(),
}).passthrough();

const DexScreenerPairSchema = z.object({
	pairAddress: z.string().optional(),
	chainId: z.string().optional(),
	dexId: z.string().optional(),
	baseToken: DexScreenerTokenSchema.optional(),
	quoteToken: DexScreenerTokenSchema.optional(),
	priceUsd: z.union([z.string(), z.number()]).optional(),
	priceNative: z.union([z.string(), z.number()]).optional(),
	volume: z.object({ h24: z.number().optional() }).passthrough().optional(),
	liquidity: z.object({ usd: z.number().optional() }).passthrough().optional(),
	priceChange: z.object({
		h24: z.number().optional(),
		h1: z.number().optional(),
		m5: z.number().optional(),
	}).passthrough().optional(),
	txns: z.object({
		h24: z.object({ buys: z.number().optional(), sells: z.number().optional() }).passthrough().optional(),
	}).passthrough().optional(),
}).passthrough();

const DexScreenerResponseSchema = z.union([
	z.array(DexScreenerPairSchema),
	z.object({ pairs: z.array(DexScreenerPairSchema).nullable().optional() }).passthrough(),
]);

const SolanaRpcResultSchema = z.object({
	result: z.number(),
}).passthrough();

export interface SolanaPair {
	pairAddress: string;
	dex: string;
	baseToken: { address: string; symbol: string; name: string };
	quoteToken: { address: string; symbol: string; name: string };
	label: string;
	priceUsd: number;
	priceNative: number;
	volume24h: number;
	liquidity: number;
	priceChange24h: number;
	priceChange1h: number;
	priceChange5m: number;
	txns24h: { buys: number; sells: number };
	timestamp: number;
}

export interface SolanaOrderBook {
	pair: string;
	dex: string;
	priceUsd: number;
	liquidity: number;
	/** Synthetic depth — estimated from liquidity pool (constant product AMM) */
	syntheticBids: { price: number; depth: number }[];
	syntheticAsks: { price: number; depth: number }[];
	midPrice: number;
	estimatedSpreadPct: number;
	timestamp: number;
}

/** Well-known Solana token addresses */
export const SOLANA_TOKENS: Record<string, { address: string; name: string; decimals: number }> = {
	SOL: { address: "So11111111111111111111111111111111111111112", name: "Solana", decimals: 9 },
	USDC: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USDC", decimals: 6 },
	USDT: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", name: "USDT", decimals: 6 },
	JUP: { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", name: "Jupiter", decimals: 6 },
	RAY: { address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", name: "Raydium", decimals: 6 },
	BONK: { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "Bonk", decimals: 5 },
	WIF: { address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", name: "dogwifhat", decimals: 6 },
};

/** Default Solana DEX pairs to watch */
export const SOLANA_WATCH_PAIRS = ["SOL", "JUP", "RAY", "BONK"];

export class SolanaClient {
	private rpcUrl: string;

	constructor(rpcUrl?: string) {
		this.rpcUrl = rpcUrl ?? SOLANA_RPC;
	}

	/** Get all DEX pairs for a token via DexScreener */
	async getTokenPairs(tokenSymbol: string): Promise<SolanaPair[]> {
		const token = SOLANA_TOKENS[tokenSymbol];
		const url = token
			? `${DEXSCREENER}/tokens/v1/solana/${token.address}`
			: `${DEXSCREENER}/latest/dex/search?q=${tokenSymbol}%20solana`;

		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`DexScreener error ${res.status}`);

		const raw = await safeJsonParse<unknown>(res, `DexScreener getTokenPairs(${tokenSymbol})`);
		const parsed = DexScreenerResponseSchema.safeParse(raw);
		if (!parsed.success) {
			console.warn(`[solana-client] DexScreener response validation failed: ${parsed.error.message}`);
			return [];
		}
		const data = parsed.data;
		const rawPairs = Array.isArray(data) ? data : (data.pairs ?? []);

		const results: SolanaPair[] = [];
		for (const p of rawPairs) {
			if (p.chainId != null && p.chainId !== "solana") continue;
			const pairParsed = DexScreenerPairSchema.safeParse(p);
			if (!pairParsed.success) {
				console.warn("[solana-client] skipping invalid pair entry:", pairParsed.error.message);
				continue;
			}
			results.push(this.normalizePair(pairParsed.data));
		}
		return results.sort((a, b) => b.liquidity - a.liquidity);
	}

	/** Get the best (highest liquidity) pair for a token */
	async getBestPair(tokenSymbol: string): Promise<SolanaPair | null> {
		const pairs = await this.getTokenPairs(tokenSymbol);
		return pairs[0] ?? null;
	}

	/** Get synthetic order book from AMM pool liquidity */
	async getSyntheticOrderBook(tokenSymbol: string): Promise<SolanaOrderBook | null> {
		const pair = await this.getBestPair(tokenSymbol);
		if (!pair) return null;

		const price = pair.priceUsd;
		const liquidity = pair.liquidity;

		// For constant-product AMMs (x*y=k), we can estimate depth at each price level
		// Price impact for a trade of size `dx`: new_price = price * (1 + dx/liquidity_one_side)^2
		// Approximate liquidity per side = total_liquidity / 2
		const halfLiq = liquidity / 2;

		const syntheticBids: { price: number; depth: number }[] = [];
		const syntheticAsks: { price: number; depth: number }[] = [];

		// Generate synthetic depth at 0.5%, 1%, 2%, 5%, 10% price levels
		for (const pctMove of [0.005, 0.01, 0.02, 0.05, 0.1]) {
			// For AMM: trade_size ≈ liquidity_half * (1 - 1/(1+pct_move))
			const tradeSize = halfLiq * (1 - 1 / (1 + pctMove));
			syntheticBids.push({
				price: price * (1 - pctMove),
				depth: tradeSize,
			});
			syntheticAsks.push({
				price: price * (1 + pctMove),
				depth: tradeSize,
			});
		}

		if (liquidity <= 0) return null; // guard Infinity spread from zero/negative liquidity

		// Estimate spread from liquidity — deeper pools = tighter spread
		// Very rough: spread ≈ 2 / sqrt(liquidity_usd / 1000)
		const estimatedSpreadPct = Math.max(0.01, 2 / Math.sqrt(liquidity / 1000));

		return {
			pair: pair.label,
			dex: pair.dex,
			priceUsd: price,
			liquidity,
			syntheticBids,
			syntheticAsks,
			midPrice: price,
			estimatedSpreadPct,
			timestamp: Date.now(),
		};
	}

	/** Get multiple token prices in one call */
	async getMultipleTokens(symbols: string[]): Promise<SolanaPair[]> {
		const results: SolanaPair[] = [];
		// Fetch in parallel
		const promises = symbols.map(async (sym) => {
			try {
				const pair = await this.getBestPair(sym);
				if (pair) results.push(pair);
			} catch (err) {
				console.debug("[solana-client] token fetch failed:", err instanceof Error ? err.message : err);
			}
		});
		await Promise.all(promises);
		return results;
	}

	/** Get Solana slot (block) number */
	async getSlot(): Promise<number> {
		const res = await fetch(this.rpcUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const raw = await safeJsonParse<unknown>(res, "Solana RPC getSlot");
		const parsed = SolanaRpcResultSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`Solana RPC getSlot: invalid response: ${parsed.error.message}`);
		}
		return parsed.data.result;
	}

	private normalizePair(raw: z.infer<typeof DexScreenerPairSchema>): SolanaPair {
		const base = raw.baseToken;
		const quote = raw.quoteToken;

		return {
			pairAddress: raw.pairAddress ?? "",
			dex: raw.dexId ?? "unknown",
			baseToken: {
				address: base?.address ?? "",
				symbol: base?.symbol ?? "",
				name: base?.name ?? "",
			},
			quoteToken: {
				address: quote?.address ?? "",
				symbol: quote?.symbol ?? "",
				name: quote?.name ?? "",
			},
			label: `${base?.symbol ?? "?"}/${quote?.symbol ?? "?"}`,
			priceUsd: Number(raw.priceUsd ?? 0),
			priceNative: Number(raw.priceNative ?? 0),
			volume24h: raw.volume?.h24 ?? 0,
			liquidity: raw.liquidity?.usd ?? 0,
			priceChange24h: (raw.priceChange?.h24 ?? 0) / 100,
			priceChange1h: (raw.priceChange?.h1 ?? 0) / 100,
			priceChange5m: (raw.priceChange?.m5 ?? 0) / 100,
			txns24h: {
				buys: raw.txns?.h24?.buys ?? 0,
				sells: raw.txns?.h24?.sells ?? 0,
			},
			timestamp: Date.now(),
		};
	}
}
