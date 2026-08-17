/**
 * Flare DEX client — uses Flare EVM RPC + DexScreener.
 * Covers SparkDEX, BlazeSwap, and Enosys on Flare Network.
 */

import { z } from "zod";

const FLARE_RPC = "https://flare-api.flare.network/ext/C/rpc";
const DEXSCREENER = "https://api.dexscreener.com";
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

// ── Zod schemas for API responses ──

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

const DexScreenerSearchResponseSchema = z.object({
	pairs: z.array(DexScreenerPairSchema).nullable().optional(),
}).passthrough();

const RpcResultStringSchema = z.object({
	result: z.string(),
}).passthrough();

/** Scaling factor for BigInt price calculations to avoid precision loss */
const BIGINT_PRECISION = 10n ** 18n;

export interface FlarePair {
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

export interface FlarePoolReserves {
	pairAddress: string;
	token0: string;
	token1: string;
	reserve0: bigint;
	reserve1: bigint;
	price: number;
	liquidity: number;
	timestamp: number;
}

/** Well-known Flare tokens */
export const FLARE_TOKENS: Record<string, { address: string; name: string; decimals: number }> = {
	WFLR: { address: "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d", name: "Wrapped FLR", decimals: 18 },
	"USDC.e": { address: "0xFbDa5F676cB37624f28265A144A48B0d6e87d3b6", name: "USDC.e", decimals: 6 },
	"USDT.e": { address: "0x96B41289D90444B8adD57e6F265DB5aE8651DF29", name: "USDT.e", decimals: 6 },
	WETH: { address: "0x1502FA4be69d526124D453619276FacCab275d3D", name: "Wrapped ETH", decimals: 18 },
	sFLR: { address: "0x12e605bc104e93B45e1aD99F9e555f659051c2BB", name: "Sceptre Staked FLR", decimals: 18 },
	SFLR: { address: "0x12e605bc104e93B45e1aD99F9e555f659051c2BB", name: "Sceptre Staked FLR", decimals: 18 },
};

/** Default Flare pairs to watch */
export const FLARE_WATCH_TOKENS = ["WFLR", "sFLR"];

export class FlareClient {
	private rpcUrl: string;

	constructor(rpcUrl?: string) {
		this.rpcUrl = rpcUrl ?? FLARE_RPC;
	}

	/** Get DEX pairs for a token via DexScreener */
	async getTokenPairs(tokenSymbol: string): Promise<FlarePair[]> {
		const url = `${DEXSCREENER}/latest/dex/search?q=${tokenSymbol}%20flare`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`DexScreener error ${res.status}`);

		const raw = await safeJsonParse<unknown>(res, `DexScreener getTokenPairs(${tokenSymbol})`);
		const parsed = DexScreenerSearchResponseSchema.safeParse(raw);
		if (!parsed.success) {
			console.warn(`[flare-client] DexScreener response validation failed: ${parsed.error.message}`);
			return [];
		}

		const results: FlarePair[] = [];
		for (const p of parsed.data.pairs ?? []) {
			if (p.chainId !== "flare") continue;
			const pairParsed = DexScreenerPairSchema.safeParse(p);
			if (!pairParsed.success) {
				console.warn("[flare-client] skipping invalid pair entry:", pairParsed.error.message);
				continue;
			}
			results.push(this.normalizePair(pairParsed.data));
		}
		return results.sort((a, b) => b.liquidity - a.liquidity);
	}

	/** Get the best (highest liquidity) pair for a token */
	async getBestPair(tokenSymbol: string): Promise<FlarePair | null> {
		const pairs = await this.getTokenPairs(tokenSymbol);
		return pairs[0] ?? null;
	}

	/** Read Uniswap V2 pool reserves directly from chain */
	async getPoolReserves(pairAddress: string): Promise<FlarePoolReserves | null> {
		try {
			// getReserves() → (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
			const reservesHex = await this.ethCall(pairAddress, "0x0902f1ac");
			if (!reservesHex || reservesHex === "0x" || reservesHex.length < 130) return null;

			const reserve0 = BigInt("0x" + reservesHex.slice(2, 66));
			const reserve1 = BigInt("0x" + reservesHex.slice(66, 130));

			// token0()
			const token0Hex = await this.ethCall(pairAddress, "0x0dfe1681");
			const token0 = "0x" + (token0Hex?.slice(26) ?? "");

			// token1()
			const token1Hex = await this.ethCall(pairAddress, "0xd21220a7");
			const token1 = "0x" + (token1Hex?.slice(26) ?? "");

			// Calculate price (token1 per token0) using BigInt arithmetic to avoid precision loss
			let price: number;
			if (reserve0 > 0n) {
				const scaledPrice = (reserve1 * BIGINT_PRECISION) / reserve0;
				price = Number(scaledPrice) / Number(BIGINT_PRECISION);
			} else {
				price = 0;
			}
			// Very rough liquidity estimate in USD (needs price oracle for accuracy)
			// Use BigInt scaling to avoid precision loss for large reserves
			const liquidityScaled = ((reserve0 + reserve1) * 100n) / (10n ** 18n);
			const liquidity = Number(liquidityScaled) / 10000; // 100n scale / 100 to get *0.01

			return {
				pairAddress,
				token0,
				token1,
				reserve0,
				reserve1,
				price,
				liquidity,
				timestamp: Date.now(),
			};
		} catch (err) {
			console.debug("[flare-client] pool reserves fetch failed:", err instanceof Error ? err.message : err);
			return null;
		}
	}

	/** Get synthetic order book from pool data */
	async getSyntheticOrderBook(tokenSymbol: string): Promise<{
		pair: string;
		dex: string;
		priceUsd: number;
		liquidity: number;
		syntheticBids: { price: number; depth: number }[];
		syntheticAsks: { price: number; depth: number }[];
		estimatedSpreadPct: number;
		timestamp: number;
	} | null> {
		const pair = await this.getBestPair(tokenSymbol);
		if (!pair) return null;

		const price = pair.priceUsd;
		const liquidity = pair.liquidity;
		const halfLiq = liquidity / 2;

		const syntheticBids: { price: number; depth: number }[] = [];
		const syntheticAsks: { price: number; depth: number }[] = [];

		for (const pctMove of [0.005, 0.01, 0.02, 0.05, 0.1]) {
			const tradeSize = halfLiq * (1 - 1 / (1 + pctMove));
			syntheticBids.push({ price: price * (1 - pctMove), depth: tradeSize });
			syntheticAsks.push({ price: price * (1 + pctMove), depth: tradeSize });
		}

		if (liquidity <= 0) return null; // guard Infinity spread from zero/negative liquidity
		const estimatedSpreadPct = Math.max(0.02, 2 / Math.sqrt(liquidity / 1000));

		return {
			pair: pair.label,
			dex: pair.dex,
			priceUsd: price,
			liquidity,
			syntheticBids,
			syntheticAsks,
			estimatedSpreadPct,
			timestamp: Date.now(),
		};
	}

	/** Get current block number */
	async getBlockNumber(): Promise<number> {
		const res = await fetch(this.rpcUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const raw = await safeJsonParse<unknown>(res, "Flare RPC eth_blockNumber");
		const parsed = RpcResultStringSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`Flare RPC eth_blockNumber: invalid response: ${parsed.error.message}`);
		}
		return parseInt(parsed.data.result, 16);
	}

	private async ethCall(to: string, data: string): Promise<string | null> {
		const res = await fetch(this.rpcUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0", id: 1,
				method: "eth_call",
				params: [{ to, data }, "latest"],
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const raw = await safeJsonParse<unknown>(res, `Flare RPC eth_call(${to})`);
		const parsed = RpcResultStringSchema.safeParse(raw);
		if (!parsed.success) {
			console.warn(`[flare-client] eth_call response validation failed: ${parsed.error.message}`);
			return null;
		}
		return parsed.data.result;
	}

	private normalizePair(raw: z.infer<typeof DexScreenerPairSchema>): FlarePair {
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
