/**
 * Graph Builder — converts live market data from all sources into a
 * weighted currency graph for Bellman-Ford arbitrage detection.
 *
 * Creates bidirectional edges for every trading pair, using actual
 * bid/ask prices (not mid) to account for spread cost.
 */

import type { XRPLClient, XRPLCurrency, XRPLOrderBook } from "../xrpl/xrpl-client.js";
import type { StellarClient, StellarAsset, StellarOrderBook } from "../dex/stellar-client.js";
import type { SolanaClient } from "../dex/solana-client.js";
import type { FlareClient } from "../dex/flare-client.js";
import type { CryptoClient, Ticker } from "../crypto-client.js";
import { createEdge, type Edge } from "./bellman-ford.js";

/** Fee estimates per source (as fraction, e.g. 0.001 = 0.1%) */
const FEES: Record<string, number> = {
	xrpl: 0.0000,   // XRPL DEX: ~0 fees (only tiny XRP drops)
	stellar: 0.0001, // Stellar DEX: ~0.01% (negligible base fee)
	solana: 0.003,   // Solana DEX: ~0.3% (Raydium/Orca LP fees)
	flare: 0.003,    // Flare DEX: ~0.3% (SparkDEX/BlazeSwap)
	cex: 0.001,      // Crypto.com: ~0.1% taker fee
};

export interface GraphBuilderConfig {
	/** XRPL pairs to include */
	xrplPairs: { base: XRPLCurrency; quote: XRPLCurrency; label: string }[];
	/** Stellar pairs to include */
	stellarPairs: { base: StellarAsset; counter: StellarAsset; label: string }[];
	/** Solana tokens to query */
	solanaTokens: string[];
	/** Flare tokens to query */
	flareTokens: string[];
	/** CEX pairs to include */
	cexPairs: { symbol: string; base: string; quote: string }[];
	/** Custom fee overrides */
	fees?: Partial<typeof FEES>;
}

export interface GraphSnapshot {
	edges: Edge[];
	nodes: string[];
	timestamp: number;
	errors: string[];
}

export class GraphBuilder {
	private xrpl: XRPLClient | null;
	private stellar: StellarClient | null;
	private solana: SolanaClient | null;
	private flare: FlareClient | null;
	private cex: CryptoClient | null;
	private config: GraphBuilderConfig;
	private fees: Record<string, number>;

	constructor(
		sources: {
			xrpl?: XRPLClient;
			stellar?: StellarClient;
			solana?: SolanaClient;
			flare?: FlareClient;
			cex?: CryptoClient;
		},
		config: GraphBuilderConfig,
	) {
		this.xrpl = sources.xrpl ?? null;
		this.stellar = sources.stellar ?? null;
		this.solana = sources.solana ?? null;
		this.flare = sources.flare ?? null;
		this.cex = sources.cex ?? null;
		this.config = config;
		this.fees = { ...FEES, ...(config.fees as Record<string, number> | undefined) };
	}

	/**
	 * Build the complete currency graph from all available price sources.
	 * Returns bidirectional edges with actual bid/ask rates.
	 */
	async buildGraph(): Promise<GraphSnapshot> {
		const edges: Edge[] = [];
		const errors: string[] = [];

		// Fetch all sources in parallel
		const [xrplEdges, stellarEdges, solanaEdges, flareEdges, cexEdges] = await Promise.all([
			this.buildXRPLEdges().catch((e) => { errors.push(`xrpl: ${e.message}`); return [] as Edge[]; }),
			this.buildStellarEdges().catch((e) => { errors.push(`stellar: ${e.message}`); return [] as Edge[]; }),
			this.buildSolanaEdges().catch((e) => { errors.push(`solana: ${e.message}`); return [] as Edge[]; }),
			this.buildFlareEdges().catch((e) => { errors.push(`flare: ${e.message}`); return [] as Edge[]; }),
			this.buildCEXEdges().catch((e) => { errors.push(`cex: ${e.message}`); return [] as Edge[]; }),
		]);

		edges.push(...xrplEdges, ...stellarEdges, ...solanaEdges, ...flareEdges, ...cexEdges);

		// Add cross-chain bridge edges (same asset on different chains at 1:1 minus bridge fee)
		edges.push(...this.buildBridgeEdges(edges));

		const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))];

		return { edges, nodes, timestamp: Date.now(), errors };
	}

	// ── XRPL DEX ──

	private async buildXRPLEdges(): Promise<Edge[]> {
		if (!this.xrpl) return [];
		const edges: Edge[] = [];

		for (const pair of this.config.xrplPairs) {
			try {
				const book = await this.xrpl.getOrderBook(pair.base, pair.quote, 10);
				edges.push(...this.orderBookToEdges(book, pair.label, "xrpl"));
			} catch (err) {
				console.debug("[graph-builder] xrpl pair failed:", err instanceof Error ? err.message : err);
			}
		}
		return edges;
	}

	private orderBookToEdges(book: XRPLOrderBook, label: string, source: string): Edge[] {
		const edges: Edge[] = [];
		const fee = this.fees[source] ?? 0;

		// Parse base/quote from label (e.g., "SOLO/XRP" → base=SOLO, quote=XRP)
		const [base, quote] = label.split("/");
		if (!base || !quote) return edges;

		const baseNode = `${source}:${base}`;
		const quoteNode = `${source}:${quote}`;

		// Best ask = cheapest price to buy base with quote
		// Buying base: pay ask price in quote → get 1 base
		// Edge: quote → base at rate (1/ask)
		if (book.asks.length > 0) {
			const bestAsk = book.asks[0];
			const askDepth = book.asks.reduce((s, a) => s + ("quantity" in a ? (a as { quantity: number }).quantity : (a as { amount: number }).amount), 0);
			if (bestAsk.price > 0) {
				edges.push(createEdge(
					quoteNode, baseNode,
					1 / bestAsk.price,
					label,
					source,
					askDepth * bestAsk.price, // depth in quote currency
					fee,
				));
			}
		}

		// Best bid = best price to sell base for quote
		// Selling base: get bid price in quote per 1 base
		// Edge: base → quote at rate (bid)
		if (book.bids.length > 0) {
			const bestBid = book.bids[0];
			const bidDepth = book.bids.reduce((s, b) => s + ("quantity" in b ? (b as { quantity: number }).quantity : (b as { amount: number }).amount), 0);
			if (bestBid.price > 0) {
				edges.push(createEdge(
					baseNode, quoteNode,
					bestBid.price,
					label,
					source,
					bidDepth,
					fee,
				));
			}
		}

		return edges;
	}

	// ── Stellar DEX ──

	private async buildStellarEdges(): Promise<Edge[]> {
		if (!this.stellar) return [];
		const edges: Edge[] = [];

		for (const pair of this.config.stellarPairs) {
			try {
				const book = await this.stellar.getOrderBook(pair.base, pair.counter, 10);
				edges.push(...this.stellarBookToEdges(book, pair.label));
			} catch (err) {
				console.debug("[graph-builder] stellar pair failed:", err instanceof Error ? err.message : err);
			}
		}
		return edges;
	}

	private stellarBookToEdges(book: StellarOrderBook, label: string): Edge[] {
		const edges: Edge[] = [];
		const fee = this.fees.stellar ?? 0;
		const [base, quote] = label.split("/");
		if (!base || !quote) return edges;

		const baseNode = `stellar:${base}`;
		const quoteNode = `stellar:${quote}`;

		if (book.asks.length > 0) {
			const bestAsk = book.asks[0];
			const askDepth = book.asks.reduce((s, a) => s + a.amount, 0);
			if (bestAsk.price > 0) {
				edges.push(createEdge(quoteNode, baseNode, 1 / bestAsk.price, label, "stellar", askDepth * bestAsk.price, fee));
			}
		}

		if (book.bids.length > 0) {
			const bestBid = book.bids[0];
			const bidDepth = book.bids.reduce((s, b) => s + b.amount, 0);
			if (bestBid.price > 0) {
				edges.push(createEdge(baseNode, quoteNode, bestBid.price, label, "stellar", bidDepth, fee));
			}
		}

		return edges;
	}

	// ── Solana DEX ──

	private async buildSolanaEdges(): Promise<Edge[]> {
		if (!this.solana) return [];
		const edges: Edge[] = [];
		const fee = this.fees.solana ?? 0;

		for (const token of this.config.solanaTokens) {
			try {
				const pair = await this.solana.getBestPair(token);
				if (!pair || pair.priceUsd <= 0) continue;

				const baseNode = `solana:${pair.baseToken.symbol}`;
				const quoteNode = `solana:${pair.quoteToken.symbol}`;
				const depth = pair.liquidity / 2;

				// Base → Quote (selling base)
				edges.push(createEdge(baseNode, quoteNode, pair.priceNative || pair.priceUsd, pair.label, "solana", depth, fee));
				// Quote → Base (buying base)
				const buyRate = pair.priceNative > 0 ? 1 / pair.priceNative : 1 / pair.priceUsd;
				edges.push(createEdge(quoteNode, baseNode, buyRate, pair.label, "solana", depth, fee));

				// Also add USD edges for cross-chain comparison
				if (pair.priceUsd > 0) {
					edges.push(createEdge(baseNode, "usd:USD", pair.priceUsd, `${pair.baseToken.symbol}/USD`, "solana", depth, fee));
					edges.push(createEdge("usd:USD", baseNode, 1 / pair.priceUsd, `${pair.baseToken.symbol}/USD`, "solana", depth, fee));
				}
			} catch (err) {
				console.debug("[graph-builder] solana token failed:", err instanceof Error ? err.message : err);
			}
		}
		return edges;
	}

	// ── Flare DEX ──

	private async buildFlareEdges(): Promise<Edge[]> {
		if (!this.flare) return [];
		const edges: Edge[] = [];
		const fee = this.fees.flare ?? 0;

		for (const token of this.config.flareTokens) {
			try {
				const pair = await this.flare.getBestPair(token);
				if (!pair || pair.priceUsd <= 0) continue;

				const baseNode = `flare:${pair.baseToken.symbol}`;
				const quoteNode = `flare:${pair.quoteToken.symbol}`;
				const depth = pair.liquidity / 2;

				edges.push(createEdge(baseNode, quoteNode, pair.priceNative || pair.priceUsd, pair.label, "flare", depth, fee));
				const buyRate = pair.priceNative > 0 ? 1 / pair.priceNative : 1 / pair.priceUsd;
				edges.push(createEdge(quoteNode, baseNode, buyRate, pair.label, "flare", depth, fee));

				if (pair.priceUsd > 0) {
					edges.push(createEdge(baseNode, "usd:USD", pair.priceUsd, `${pair.baseToken.symbol}/USD`, "flare", depth, fee));
					edges.push(createEdge("usd:USD", baseNode, 1 / pair.priceUsd, `${pair.baseToken.symbol}/USD`, "flare", depth, fee));
				}
			} catch (err) {
				console.debug("[graph-builder] flare token failed:", err instanceof Error ? err.message : err);
			}
		}
		return edges;
	}

	// ── CEX (Crypto.com) ──

	private async buildCEXEdges(): Promise<Edge[]> {
		if (!this.cex) return [];
		const edges: Edge[] = [];
		const fee = this.fees.cex ?? 0;

		for (const pair of this.config.cexPairs) {
			try {
				const ticker = await this.cex.getTicker(pair.symbol);
				edges.push(...this.tickerToEdges(ticker, pair.base, pair.quote, fee));
			} catch (err) {
				console.debug("[graph-builder] cex pair failed:", err instanceof Error ? err.message : err);
			}
		}
		return edges;
	}

	private tickerToEdges(ticker: Ticker, base: string, quote: string, fee: number): Edge[] {
		const edges: Edge[] = [];
		const baseNode = `cex:${base}`;
		const quoteNode = `cex:${quote}`;

		// Sell base (get bid price in quote)
		if (ticker.bid > 0) {
			edges.push(createEdge(baseNode, quoteNode, ticker.bid, ticker.symbol, "cex", ticker.volume24h * ticker.bid * 0.01, fee));
		}
		// Buy base (pay ask price in quote)
		if (ticker.ask > 0) {
			edges.push(createEdge(quoteNode, baseNode, 1 / ticker.ask, ticker.symbol, "cex", ticker.volume24h * 0.01, fee));
		}

		return edges;
	}

	// ── Cross-chain bridge edges ──

	private buildBridgeEdges(existingEdges: Edge[]): Edge[] {
		const bridgeEdges: Edge[] = [];
		// Estimated bridge/transfer cost as a fee
		const bridgeFee = 0.002; // 0.2% slippage for cross-chain conceptual link

		// Find the same asset across different chains and add conversion edges
		// This enables cross-chain arbitrage paths like:
		// cex:XRP → xrpl:XRP (withdraw to XRPL)
		// xrpl:XRP → xrpl:USD → stellar:USD → stellar:XLM → cex:XLM (cross-chain loop)

		const nodesByAsset = new Map<string, string[]>();
		const allNodes = new Set(existingEdges.flatMap((e) => [e.from, e.to]));

		for (const node of allNodes) {
			const [, asset] = node.split(":");
			if (!asset) continue;
			const normalized = asset.toUpperCase();
			const existing = nodesByAsset.get(normalized) ?? [];
			existing.push(node);
			nodesByAsset.set(normalized, existing);
		}

		// For assets that exist on multiple chains, add bridge edges at 1:1 minus fee
		for (const [, nodes] of nodesByAsset) {
			if (nodes.length < 2) continue;
			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					bridgeEdges.push(createEdge(nodes[i], nodes[j], 1, "bridge", "bridge", Infinity, bridgeFee));
					bridgeEdges.push(createEdge(nodes[j], nodes[i], 1, "bridge", "bridge", Infinity, bridgeFee));
				}
			}
		}

		// USD equivalence: link all USD-like nodes
		const usdNodes = [...allNodes].filter((n) => /:(USD|USDC|USDT)$/i.test(n));
		for (let i = 0; i < usdNodes.length; i++) {
			for (let j = i + 1; j < usdNodes.length; j++) {
				bridgeEdges.push(createEdge(usdNodes[i], usdNodes[j], 1, "usd-bridge", "bridge", Infinity, bridgeFee));
				bridgeEdges.push(createEdge(usdNodes[j], usdNodes[i], 1, "usd-bridge", "bridge", Infinity, bridgeFee));
			}
		}

		return bridgeEdges;
	}
}
