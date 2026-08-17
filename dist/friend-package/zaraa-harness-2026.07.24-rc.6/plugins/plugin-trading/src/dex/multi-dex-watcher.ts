/**
 * Multi-chain DEX Watcher — monitors Stellar, Solana, and Flare DEXes.
 * Feeds all observations into the shared MarketLearner.
 */

import type { StellarClient, StellarOrderBook } from "./stellar-client.js";
import { STELLAR_PAIRS } from "./stellar-client.js";
import type { SolanaClient, SolanaPair } from "./solana-client.js";
import type { FlareClient, FlarePair } from "./flare-client.js";
import type { MarketLearner } from "../xrpl/market-learner.js";

export interface ChainSnapshot {
	chain: "stellar" | "solana" | "flare";
	pair: string;
	dex: string;
	midPrice: number | null;
	spreadPct: number | null;
	bidDepth: number;
	askDepth: number;
	imbalanceRatio: number;
	volume24h: number;
	change24h: number;
	liquidity: number;
	txns24h: { buys: number; sells: number } | null;
	timestamp: number;
}

export interface ChainOpportunity {
	chain: "stellar" | "solana" | "flare";
	type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "liquidity_shift" | "buy_sell_ratio";
	pair: string;
	confidence: number;
	description: string;
	details: Record<string, unknown>;
	detectedAt: number;
}

export interface MultiDEXConfig {
	stellarPairs: typeof STELLAR_PAIRS;
	solanaTokens: string[];
	flareTokens: string[];
	minConfidence: number;
}

const DEFAULT_CONFIG: MultiDEXConfig = {
	stellarPairs: STELLAR_PAIRS,
	solanaTokens: ["SOL", "JUP", "RAY", "BONK"],
	flareTokens: ["WFLR", "sFLR"],
	minConfidence: 0.3,
};

export class MultiDEXWatcher {
	private stellar: StellarClient;
	private solana: SolanaClient;
	private flare: FlareClient;
	private learner: MarketLearner | null;
	private config: MultiDEXConfig;
	private lastSnapshots = new Map<string, ChainSnapshot>();
	private snapshotHistory = new Map<string, ChainSnapshot[]>();
	private readonly MAX_HISTORY = 288;

	constructor(
		stellar: StellarClient,
		solana: SolanaClient,
		flare: FlareClient,
		learner: MarketLearner | null = null,
		config: Partial<MultiDEXConfig> = {},
	) {
		this.stellar = stellar;
		this.solana = solana;
		this.flare = flare;
		this.learner = learner;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Scan all chains */
	async scanAll(): Promise<{
		snapshots: ChainSnapshot[];
		opportunities: ChainOpportunity[];
		errors: string[];
	}> {
		const [stellarResult, solanaResult, flareResult] = await Promise.all([
			this.scanStellar(),
			this.scanSolana(),
			this.scanFlare(),
		]);

		return {
			snapshots: [...stellarResult.snapshots, ...solanaResult.snapshots, ...flareResult.snapshots],
			opportunities: [...stellarResult.opportunities, ...solanaResult.opportunities, ...flareResult.opportunities],
			errors: [...stellarResult.errors, ...solanaResult.errors, ...flareResult.errors],
		};
	}

	/** Scan Stellar DEX */
	async scanStellar(): Promise<{ snapshots: ChainSnapshot[]; opportunities: ChainOpportunity[]; errors: string[] }> {
		const snapshots: ChainSnapshot[] = [];
		const opportunities: ChainOpportunity[] = [];
		const errors: string[] = [];

		for (const pair of this.config.stellarPairs) {
			try {
				const book = await this.stellar.getOrderBook(pair.base, pair.counter, 25);
				const snapshot = this.stellarToSnapshot(pair.label, book);
				snapshots.push(snapshot);
				this.storeSnapshot(snapshot);

				// Detect opportunities
				const opps = this.detectOpportunities(snapshot);
				opportunities.push(...opps);

				this.feedLearner(snapshot);
			} catch (err) {
				errors.push(`stellar:${pair.label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { snapshots, opportunities, errors };
	}

	/** Scan Solana DEXes */
	async scanSolana(): Promise<{ snapshots: ChainSnapshot[]; opportunities: ChainOpportunity[]; errors: string[] }> {
		const snapshots: ChainSnapshot[] = [];
		const opportunities: ChainOpportunity[] = [];
		const errors: string[] = [];

		for (const token of this.config.solanaTokens) {
			try {
				const pair = await this.solana.getBestPair(token);
				if (!pair) continue;
				const snapshot = this.dexscreenerToSnapshot("solana", pair);
				if (!snapshot) continue;
				snapshots.push(snapshot);
				this.storeSnapshot(snapshot);

				const opps = this.detectOpportunities(snapshot);
				opportunities.push(...opps);

				this.feedLearner(snapshot);
			} catch (err) {
				errors.push(`solana:${token}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { snapshots, opportunities, errors };
	}

	/** Scan Flare DEXes */
	async scanFlare(): Promise<{ snapshots: ChainSnapshot[]; opportunities: ChainOpportunity[]; errors: string[] }> {
		const snapshots: ChainSnapshot[] = [];
		const opportunities: ChainOpportunity[] = [];
		const errors: string[] = [];

		for (const token of this.config.flareTokens) {
			try {
				const pair = await this.flare.getBestPair(token);
				if (!pair) continue;
				const snapshot = this.dexscreenerToSnapshot("flare", pair);
				if (!snapshot) continue;
				snapshots.push(snapshot);
				this.storeSnapshot(snapshot);

				const opps = this.detectOpportunities(snapshot);
				opportunities.push(...opps);

				this.feedLearner(snapshot);
			} catch (err) {
				errors.push(`flare:${token}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { snapshots, opportunities, errors };
	}

	getLatest(key: string): ChainSnapshot | undefined {
		return this.lastSnapshots.get(key);
	}

	getHistory(key: string, limit = 50): ChainSnapshot[] {
		return (this.snapshotHistory.get(key) ?? []).slice(-limit);
	}

	getSummary(): {
		chains: {
			chain: string;
			pairs: { pair: string; price: number | null; change24h: number; volume24h: number; liquidity: number }[];
		}[];
		totalPairsTracked: number;
	} {
		const byChain = new Map<string, ChainSnapshot[]>();
		for (const s of this.lastSnapshots.values()) {
			const arr = byChain.get(s.chain) ?? [];
			arr.push(s);
			byChain.set(s.chain, arr);
		}

		const chains = Array.from(byChain.entries()).map(([chain, snaps]) => ({
			chain,
			pairs: snaps.map((s) => ({
				pair: s.pair,
				price: s.midPrice,
				change24h: s.change24h,
				volume24h: s.volume24h,
				liquidity: s.liquidity,
			})),
		}));

		return { chains, totalPairsTracked: this.lastSnapshots.size };
	}

	getConfig(): MultiDEXConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<MultiDEXConfig>): void {
		Object.assign(this.config, updates);
	}

	// ── Private helpers ──

	private stellarToSnapshot(label: string, book: StellarOrderBook): ChainSnapshot {
		const bidDepth = book.bids.reduce((sum, b) => sum + b.price * b.amount, 0);
		const askDepth = book.asks.reduce((sum, a) => sum + a.price * a.amount, 0);
		const imbalanceRatio = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? 999 : 1;

		return {
			chain: "stellar",
			pair: `stellar:${label}`,
			dex: "stellar-dex",
			midPrice: book.midPrice,
			spreadPct: book.spreadPct,
			bidDepth,
			askDepth,
			imbalanceRatio,
			volume24h: 0,
			change24h: 0,
			liquidity: bidDepth + askDepth,
			txns24h: null,
			timestamp: book.timestamp,
		};
	}

	private dexscreenerToSnapshot(chain: "solana" | "flare", pair: SolanaPair | FlarePair): ChainSnapshot | null {
		const liquidity = pair.liquidity;
		if (liquidity <= 0) return null; // guard Infinity spread from zero/negative liquidity
		const halfLiq = liquidity / 2;
		// Estimate spread from liquidity depth
		const estimatedSpreadPct = Math.max(0.01, 2 / Math.sqrt(liquidity / 1000));
		// Buy/sell ratio as imbalance proxy
		const buys = pair.txns24h?.buys ?? 0;
		const sells = pair.txns24h?.sells ?? 0;
		const imbalanceRatio = sells > 0 ? buys / sells : buys > 0 ? 5 : 1;

		return {
			chain,
			pair: `${chain}:${pair.label}`,
			dex: pair.dex,
			midPrice: pair.priceUsd,
			spreadPct: estimatedSpreadPct,
			bidDepth: halfLiq,
			askDepth: halfLiq,
			imbalanceRatio,
			volume24h: pair.volume24h,
			change24h: pair.priceChange24h,
			liquidity,
			txns24h: pair.txns24h,
			timestamp: pair.timestamp,
		};
	}

	private storeSnapshot(snapshot: ChainSnapshot): void {
		this.lastSnapshots.set(snapshot.pair, snapshot);
		const history = this.snapshotHistory.get(snapshot.pair) ?? [];
		history.push(snapshot);
		if (history.length > this.MAX_HISTORY) history.shift();
		this.snapshotHistory.set(snapshot.pair, history);
	}

	private feedLearner(snapshot: ChainSnapshot): void {
		if (!this.learner) return;
		this.learner.recordObservation({
			pair: snapshot.pair,
			midPrice: snapshot.midPrice,
			spreadPct: snapshot.spreadPct,
			bidDepth: snapshot.bidDepth,
			askDepth: snapshot.askDepth,
			imbalanceRatio: snapshot.imbalanceRatio,
			timestamp: snapshot.timestamp,
		});
	}

	private detectOpportunities(snapshot: ChainSnapshot): ChainOpportunity[] {
		const opps: ChainOpportunity[] = [];

		// 1. Spread capture (Stellar native DEX has real order books)
		if (snapshot.spreadPct != null && snapshot.spreadPct > 0.3) {
			const confidence = Math.min(snapshot.spreadPct / 2, 0.9);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					chain: snapshot.chain,
					type: "spread_capture",
					pair: snapshot.pair,
					confidence,
					description: `${snapshot.pair} spread is ${snapshot.spreadPct.toFixed(3)}% on ${snapshot.dex}`,
					details: { spreadPct: snapshot.spreadPct, midPrice: snapshot.midPrice },
					detectedAt: Date.now(),
				});
			}
		}

		// 2. High volatility
		if (Math.abs(snapshot.change24h) > 0.05) {
			const absChange = Math.abs(snapshot.change24h) * 100;
			const direction = snapshot.change24h > 0 ? "up" : "down";
			const confidence = Math.min(absChange / 15, 0.85);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					chain: snapshot.chain,
					type: "volatility",
					pair: snapshot.pair,
					confidence,
					description: `${snapshot.pair} moved ${direction} ${absChange.toFixed(1)}% in 24h — vol $${snapshot.volume24h.toFixed(0)}`,
					details: { change24h: snapshot.change24h, volume24h: snapshot.volume24h, direction },
					detectedAt: Date.now(),
				});
			}
		}

		// 3. Buy/sell ratio imbalance
		if (snapshot.txns24h) {
			const { buys, sells } = snapshot.txns24h;
			const total = buys + sells;
			if (total >= 10) {
				const ratio = sells > 0 ? buys / sells : buys > 0 ? 5 : 1;
				if (ratio > 2 || ratio < 0.5) {
					const direction = ratio > 1 ? "buying" : "selling";
					const confidence = Math.min(Math.abs(ratio - 1) / 3, 0.8);
					if (confidence >= this.config.minConfidence) {
						opps.push({
							chain: snapshot.chain,
							type: "buy_sell_ratio",
							pair: snapshot.pair,
							confidence,
							description: `${snapshot.pair} has ${ratio.toFixed(1)}x ${direction} ratio (${buys} buys / ${sells} sells in 24h)`,
							details: { buys, sells, ratio, direction },
							detectedAt: Date.now(),
						});
					}
				}
			}
		}

		// 4. Momentum from history
		const history = this.snapshotHistory.get(snapshot.pair) ?? [];
		if (history.length >= 6) {
			const recent = history.slice(-6);
			const prices = recent.map((s) => s.midPrice).filter((p): p is number => p != null);
			if (prices.length >= 4) {
				const first = prices[0];
				const last = prices[prices.length - 1];
				if (first <= 0) return []; // guard div-by-zero — stale zero prices cannot produce valid momentum
				const changePct = ((last - first) / first) * 100;
				let ups = 0;
				for (let i = 1; i < prices.length; i++) {
					if (prices[i] > prices[i - 1]) ups++;
				}
				const consistency = Math.max(ups, prices.length - 1 - ups) / (prices.length - 1);

				if (Math.abs(changePct) >= 0.5 && consistency >= 0.6) {
					const direction = changePct > 0 ? "up" : "down";
					const confidence = Math.min(Math.abs(changePct) / 5 * consistency, 0.85);
					if (confidence >= this.config.minConfidence) {
						opps.push({
							chain: snapshot.chain,
							type: "momentum",
							pair: snapshot.pair,
							confidence,
							description: `${snapshot.pair} trending ${direction} ${Math.abs(changePct).toFixed(2)}% over last ${recent.length} scans`,
							details: { changePct, direction, consistency },
							detectedAt: Date.now(),
						});
					}
				}
			}
		}

		// 5. Liquidity shift (sudden change in pool depth)
		if (history.length >= 2) {
			const prev = history[history.length - 2];
			if (prev.liquidity > 0 && snapshot.liquidity > 0) {
				const liqChange = ((snapshot.liquidity - prev.liquidity) / prev.liquidity) * 100;
				if (Math.abs(liqChange) > 10) {
					const direction = liqChange > 0 ? "added" : "removed";
					const confidence = Math.min(Math.abs(liqChange) / 30, 0.7);
					if (confidence >= this.config.minConfidence) {
						opps.push({
							chain: snapshot.chain,
							type: "liquidity_shift",
							pair: snapshot.pair,
							confidence,
							description: `${snapshot.pair} liquidity ${direction} ${Math.abs(liqChange).toFixed(1)}% ($${prev.liquidity.toFixed(0)} → $${snapshot.liquidity.toFixed(0)})`,
							details: { liqChange, prevLiquidity: prev.liquidity, currentLiquidity: snapshot.liquidity },
							detectedAt: Date.now(),
						});
					}
				}
			}
		}

		return opps;
	}
}
