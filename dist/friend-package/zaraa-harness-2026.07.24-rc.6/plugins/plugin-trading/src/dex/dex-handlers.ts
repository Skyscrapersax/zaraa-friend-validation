/**
 * Tool handlers for multi-chain DEX watching (Stellar, Solana, Flare).
 */

import type { StellarClient } from "./stellar-client.js";
import type { SolanaClient } from "./solana-client.js";
import type { FlareClient } from "./flare-client.js";
import type { MultiDEXWatcher } from "./multi-dex-watcher.js";
import type { MarketLearner } from "../xrpl/market-learner.js";

export interface DEXHandlerDeps {
	stellar: StellarClient;
	solana: SolanaClient;
	flare: FlareClient;
	watcher: MultiDEXWatcher;
	learner: MarketLearner;
}

export function createDEXHandlers(deps: DEXHandlerDeps) {
	const { stellar, solana, flare, watcher, learner } = deps;

	return {
		/** Scan all on-chain DEXes: Stellar, Solana, Flare */
		dex_scan_all: async (): Promise<string> => {
			const result = await watcher.scanAll();
			return JSON.stringify({
				snapshots: result.snapshots.map((s) => ({
					chain: s.chain,
					pair: s.pair,
					dex: s.dex,
					price: s.midPrice != null ? `$${s.midPrice.toFixed(6)}` : null,
					spreadPct: s.spreadPct?.toFixed(3) + "%",
					volume24h: `$${s.volume24h.toFixed(0)}`,
					change24h: `${(s.change24h * 100).toFixed(2)}%`,
					liquidity: `$${s.liquidity.toFixed(0)}`,
					imbalance: s.imbalanceRatio.toFixed(2),
					txns: s.txns24h ? `${s.txns24h.buys}B/${s.txns24h.sells}S` : null,
				})),
				opportunities: result.opportunities.map((o) => ({
					chain: o.chain,
					type: o.type,
					pair: o.pair,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
				scannedAt: new Date().toISOString(),
			});
		},

		/** Scan only Stellar DEX */
		dex_scan_stellar: async (): Promise<string> => {
			const result = await watcher.scanStellar();
			return JSON.stringify({
				chain: "stellar",
				snapshots: result.snapshots.map((s) => ({
					pair: s.pair,
					price: s.midPrice?.toFixed(6),
					spreadPct: s.spreadPct?.toFixed(3) + "%",
					bidDepth: s.bidDepth.toFixed(2),
					askDepth: s.askDepth.toFixed(2),
					imbalance: s.imbalanceRatio.toFixed(2),
				})),
				opportunities: result.opportunities.map((o) => ({
					type: o.type,
					pair: o.pair,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
			});
		},

		/** Scan only Solana DEXes */
		dex_scan_solana: async (): Promise<string> => {
			const result = await watcher.scanSolana();
			return JSON.stringify({
				chain: "solana",
				snapshots: result.snapshots.map((s) => ({
					pair: s.pair,
					dex: s.dex,
					price: `$${s.midPrice?.toFixed(4)}`,
					volume24h: `$${s.volume24h.toFixed(0)}`,
					change24h: `${(s.change24h * 100).toFixed(2)}%`,
					liquidity: `$${s.liquidity.toFixed(0)}`,
					txns: s.txns24h ? `${s.txns24h.buys}B/${s.txns24h.sells}S` : null,
				})),
				opportunities: result.opportunities.map((o) => ({
					type: o.type, pair: o.pair,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
			});
		},

		/** Scan only Flare DEXes */
		dex_scan_flare: async (): Promise<string> => {
			const result = await watcher.scanFlare();
			return JSON.stringify({
				chain: "flare",
				snapshots: result.snapshots.map((s) => ({
					pair: s.pair,
					dex: s.dex,
					price: `$${s.midPrice?.toFixed(6)}`,
					volume24h: `$${s.volume24h.toFixed(0)}`,
					change24h: `${(s.change24h * 100).toFixed(2)}%`,
					liquidity: `$${s.liquidity.toFixed(0)}`,
					txns: s.txns24h ? `${s.txns24h.buys}B/${s.txns24h.sells}S` : null,
				})),
				opportunities: result.opportunities.map((o) => ({
					type: o.type, pair: o.pair,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
			});
		},

		/** Get Stellar DEX order book for a specific pair */
		dex_stellar_orderbook: async (args: Record<string, unknown>): Promise<string> => {
			const pairLabel = args.pair as string;
			if (!pairLabel) throw new Error("pair is required (e.g., 'XLM/USDC')");

			const { STELLAR_PAIRS } = await import("./stellar-client.js");
			const pair = STELLAR_PAIRS.find((p) => p.label.toLowerCase() === pairLabel.toLowerCase());
			if (!pair) {
				return JSON.stringify({ error: `Unknown pair: ${pairLabel}. Available: ${STELLAR_PAIRS.map((p) => p.label).join(", ")}` });
			}

			const book = await stellar.getOrderBook(pair.base, pair.counter, (args.depth as number) ?? 20);
			return JSON.stringify({
				pair: pairLabel,
				midPrice: book.midPrice?.toFixed(7),
				spread: book.spread?.toFixed(8),
				spreadPct: book.spreadPct?.toFixed(4) + "%",
				bids: book.bids.slice(0, 15).map((b) => ({ price: b.price.toFixed(7), amount: b.amount.toFixed(4) })),
				asks: book.asks.slice(0, 15).map((a) => ({ price: a.price.toFixed(7), amount: a.amount.toFixed(4) })),
			});
		},

		/** Get Solana DEX pool info and synthetic depth for a token */
		dex_solana_depth: async (args: Record<string, unknown>): Promise<string> => {
			const token = args.token as string;
			if (!token) throw new Error("token is required (e.g., 'SOL', 'JUP', 'RAY')");

			const book = await solana.getSyntheticOrderBook(token);
			if (!book) return JSON.stringify({ error: `No DEX data found for ${token} on Solana` });

			return JSON.stringify({
				token,
				dex: book.dex,
				pair: book.pair,
				price: `$${book.priceUsd.toFixed(4)}`,
				liquidity: `$${book.liquidity.toFixed(0)}`,
				estimatedSpread: book.estimatedSpreadPct.toFixed(4) + "%",
				depth: {
					bids: book.syntheticBids.map((b) => ({ priceLevel: `$${b.price.toFixed(4)}`, depthUsd: `$${b.depth.toFixed(0)}` })),
					asks: book.syntheticAsks.map((a) => ({ priceLevel: `$${a.price.toFixed(4)}`, depthUsd: `$${a.depth.toFixed(0)}` })),
				},
			});
		},

		/** Get Flare DEX pool info and synthetic depth for a token */
		dex_flare_depth: async (args: Record<string, unknown>): Promise<string> => {
			const token = args.token as string;
			if (!token) throw new Error("token is required (e.g., 'WFLR', 'sFLR')");

			const book = await flare.getSyntheticOrderBook(token);
			if (!book) return JSON.stringify({ error: `No DEX data found for ${token} on Flare` });

			return JSON.stringify({
				token,
				dex: book.dex,
				pair: book.pair,
				price: `$${book.priceUsd.toFixed(6)}`,
				liquidity: `$${book.liquidity.toFixed(0)}`,
				estimatedSpread: book.estimatedSpreadPct.toFixed(4) + "%",
				depth: {
					bids: book.syntheticBids.map((b) => ({ priceLevel: `$${b.price.toFixed(6)}`, depthUsd: `$${b.depth.toFixed(0)}` })),
					asks: book.syntheticAsks.map((a) => ({ priceLevel: `$${a.price.toFixed(6)}`, depthUsd: `$${a.depth.toFixed(0)}` })),
				},
			});
		},

		/** Get multi-chain DEX summary */
		dex_summary: async (): Promise<string> => {
			await watcher.scanAll();
			const summary = watcher.getSummary();
			return JSON.stringify({
				totalPairsTracked: summary.totalPairsTracked,
				chains: summary.chains.map((c) => ({
					chain: c.chain,
					pairs: c.pairs.map((p) => ({
						pair: p.pair,
						price: p.price != null ? `$${p.price.toFixed(6)}` : null,
						change24h: `${(p.change24h * 100).toFixed(2)}%`,
						volume24h: `$${p.volume24h.toFixed(0)}`,
						liquidity: `$${p.liquidity.toFixed(0)}`,
					})),
				})),
			});
		},

		/** Get learned patterns across all on-chain DEXes */
		dex_learned_patterns: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string | undefined;
			const chain = args.chain as string | undefined;
			const minConfidence = (args.min_confidence as number) ?? 0.2;

			// Run learning
			const allPairs = Array.from(new Set([
				...watcher.getConfig().stellarPairs.map((p) => `stellar:${p.label}`),
				...watcher.getConfig().solanaTokens.map((t) => `solana:${t}`),
				...watcher.getConfig().flareTokens.map((t) => `flare:${t}`),
			]));

			for (const p of allPairs) {
				if (!pair || p.includes(pair)) {
					learner.learnPatterns(p);
				}
			}

			let patterns = learner.getPatterns(pair, minConfidence);
			if (chain) {
				patterns = patterns.filter((p) => p.pair.startsWith(chain + ":"));
			}

			return JSON.stringify({
				patterns: patterns.map((p) => ({
					type: p.type,
					pair: p.pair,
					confidence: (p.confidence * 100).toFixed(0) + "%",
					description: p.description,
					hour: p.hourOfDay != null ? `${p.hourOfDay}:00 UTC` : null,
					occurrences: p.occurrences,
				})),
			});
		},

		/** Get Stellar recent trades for a pair */
		dex_stellar_trades: async (args: Record<string, unknown>): Promise<string> => {
			const pairLabel = args.pair as string;
			if (!pairLabel) throw new Error("pair is required (e.g., 'XLM/USDC')");

			const { STELLAR_PAIRS } = await import("./stellar-client.js");
			const pair = STELLAR_PAIRS.find((p) => p.label.toLowerCase() === pairLabel.toLowerCase());
			if (!pair) {
				return JSON.stringify({ error: `Unknown pair: ${pairLabel}` });
			}

			const trades = await stellar.getTrades(pair.base, pair.counter, (args.limit as number) ?? 25);
			return JSON.stringify({
				pair: pairLabel,
				trades: trades.map((t) => ({
					price: t.price.toFixed(7),
					amount: t.baseAmount.toFixed(4),
					side: t.baseIsSeller ? "SELL" : "BUY",
					time: t.timestamp,
				})),
			});
		},
	};
}
