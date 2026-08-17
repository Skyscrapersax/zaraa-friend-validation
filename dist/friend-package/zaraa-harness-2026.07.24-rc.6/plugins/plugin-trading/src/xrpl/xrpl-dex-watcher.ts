/**
 * XRPL DEX Watcher — monitors order books and detects trading opportunities.
 *
 * Capabilities:
 * - Scans multiple trading pairs on XRPL DEX
 * - Detects spread capture opportunities (market making)
 * - Finds order book imbalances (momentum signals)
 * - Tracks volume and liquidity changes
 * - Compares order book vs AMM pricing (arb detection)
 * - All observations feed into the Market Learner
 */

import type { XRPLClient, XRPLCurrency, XRPLOrderBook } from "./xrpl-client.js";
import type { MarketLearner } from "./market-learner.js";

export interface WatchedPair {
	base: XRPLCurrency;
	quote: XRPLCurrency;
	label: string;
}

export interface Opportunity {
	type: "spread_capture" | "momentum" | "imbalance" | "depth_gap";
	pair: string;
	confidence: number; // 0-1
	description: string;
	details: Record<string, unknown>;
	detectedAt: number;
}

export interface DEXSnapshot {
	pair: string;
	midPrice: number | null;
	spreadPct: number | null;
	bidDepth: number; // total XRP value on bid side
	askDepth: number; // total XRP value on ask side
	imbalanceRatio: number; // bid_depth / ask_depth (>1 = buying pressure)
	topBidPrice: number | null;
	topAskPrice: number | null;
	bidLevels: number;
	askLevels: number;
	timestamp: number;
}

export interface DEXWatcherConfig {
	/** Minimum spread % to flag as spread capture opportunity */
	minSpreadPctForCapture: number;
	/** Minimum imbalance ratio to flag momentum */
	minImbalanceRatio: number;
	/** Minimum confidence threshold for reporting opportunities */
	minConfidence: number;
}

const DEFAULT_CONFIG: DEXWatcherConfig = {
	minSpreadPctForCapture: 0.5,
	minImbalanceRatio: 2.0,
	minConfidence: 0.4,
};

export class XRPLDEXWatcher {
	private client: XRPLClient;
	private learner: MarketLearner | null;
	private pairs: WatchedPair[];
	private config: DEXWatcherConfig;
	private lastSnapshots = new Map<string, DEXSnapshot>();
	private snapshotHistory = new Map<string, DEXSnapshot[]>();
	private readonly MAX_HISTORY = 288; // ~24h at 5-min intervals

	constructor(
		client: XRPLClient,
		pairs: WatchedPair[],
		config: Partial<DEXWatcherConfig> = {},
		learner: MarketLearner | null = null,
	) {
		this.client = client;
		this.pairs = pairs;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.learner = learner;
	}

	/** Scan all watched pairs and return opportunities */
	async scan(): Promise<{
		snapshots: DEXSnapshot[];
		opportunities: Opportunity[];
		errors: string[];
	}> {
		const snapshots: DEXSnapshot[] = [];
		const opportunities: Opportunity[] = [];
		const errors: string[] = [];

		for (const pair of this.pairs) {
			try {
				const book = await this.client.getOrderBook(pair.base, pair.quote, 25);
				const snapshot = this.buildSnapshot(pair.label, book);
				snapshots.push(snapshot);

				// Store snapshot
				this.lastSnapshots.set(pair.label, snapshot);
				const history = this.snapshotHistory.get(pair.label) ?? [];
				history.push(snapshot);
				if (history.length > this.MAX_HISTORY) history.shift();
				this.snapshotHistory.set(pair.label, history);

				// Detect opportunities
				const opps = this.detectOpportunities(pair.label, snapshot, book);
				opportunities.push(...opps);

				// Feed to learner
				if (this.learner) {
					this.learner.recordObservation({
						pair: pair.label,
						midPrice: snapshot.midPrice,
						spreadPct: snapshot.spreadPct,
						bidDepth: snapshot.bidDepth,
						askDepth: snapshot.askDepth,
						imbalanceRatio: snapshot.imbalanceRatio,
						timestamp: snapshot.timestamp,
					});
				}
			} catch (err) {
				errors.push(`${pair.label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { snapshots, opportunities, errors };
	}

	/** Get the latest snapshot for a pair */
	getLatest(pair: string): DEXSnapshot | undefined {
		return this.lastSnapshots.get(pair);
	}

	/** Get snapshot history for a pair */
	getHistory(pair: string, limit = 50): DEXSnapshot[] {
		const history = this.snapshotHistory.get(pair) ?? [];
		return history.slice(-limit);
	}

	/** Get summary across all pairs */
	getSummary(): {
		pairs: { label: string; midPrice: number | null; spreadPct: number | null; imbalance: number }[];
		bestSpread: { pair: string; spreadPct: number } | null;
		strongestImbalance: { pair: string; ratio: number; direction: "buy" | "sell" } | null;
	} {
		const pairs = Array.from(this.lastSnapshots.entries()).map(([label, s]) => ({
			label,
			midPrice: s.midPrice,
			spreadPct: s.spreadPct,
			imbalance: s.imbalanceRatio,
		}));

		const withSpread = pairs.filter((p) => p.spreadPct != null && p.spreadPct > 0);
		const bestSpread = withSpread.length > 0
			? withSpread.reduce((best, p) => (p.spreadPct! > best.spreadPct! ? p : best))
			: null;

		const strongestImbalance = pairs.length > 0
			? pairs.reduce((best, p) => {
				const ratio = Math.max(p.imbalance, 1 / (p.imbalance || 1));
				const bestRatio = Math.max(best.imbalance, 1 / (best.imbalance || 1));
				return ratio > bestRatio ? p : best;
			})
			: null;

		return {
			pairs,
			bestSpread: bestSpread ? { pair: bestSpread.label, spreadPct: bestSpread.spreadPct! } : null,
			strongestImbalance: strongestImbalance ? {
				pair: strongestImbalance.label,
				ratio: strongestImbalance.imbalance,
				direction: strongestImbalance.imbalance > 1 ? "buy" : "sell",
			} : null,
		};
	}

	/** Update watched pairs */
	setPairs(pairs: WatchedPair[]): void {
		this.pairs = pairs;
	}

	addPair(pair: WatchedPair): void {
		if (!this.pairs.some((p) => p.label === pair.label)) {
			this.pairs.push(pair);
		}
	}

	getPairs(): WatchedPair[] {
		return [...this.pairs];
	}

	private buildSnapshot(label: string, book: XRPLOrderBook): DEXSnapshot {
		const bidDepth = book.bids.reduce((sum, b) => sum + b.price * b.quantity, 0);
		const askDepth = book.asks.reduce((sum, a) => sum + a.price * a.quantity, 0);
		const imbalanceRatio = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? 999 : 1;

		return {
			pair: label,
			midPrice: book.midPrice,
			spreadPct: book.spreadPct,
			bidDepth,
			askDepth,
			imbalanceRatio,
			topBidPrice: book.bids[0]?.price ?? null,
			topAskPrice: book.asks[0]?.price ?? null,
			bidLevels: book.bids.length,
			askLevels: book.asks.length,
			timestamp: book.timestamp,
		};
	}

	private detectOpportunities(
		pair: string,
		snapshot: DEXSnapshot,
		book: XRPLOrderBook,
	): Opportunity[] {
		const opps: Opportunity[] = [];

		// 1. Spread Capture — wide spreads mean market-making potential
		if (snapshot.spreadPct != null && snapshot.spreadPct >= this.config.minSpreadPctForCapture) {
			const confidence = Math.min(snapshot.spreadPct / 3, 1); // 3%+ spread = max confidence
			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "spread_capture",
					pair,
					confidence,
					description: `${pair} spread is ${snapshot.spreadPct.toFixed(2)}% — place buy at ${snapshot.topBidPrice?.toFixed(6)} and sell at ${snapshot.topAskPrice?.toFixed(6)} for ${snapshot.spreadPct.toFixed(2)}% capture`,
					details: {
						spreadPct: snapshot.spreadPct,
						midPrice: snapshot.midPrice,
						bidPrice: snapshot.topBidPrice,
						askPrice: snapshot.topAskPrice,
						bidDepth: snapshot.bidDepth,
						askDepth: snapshot.askDepth,
					},
					detectedAt: Date.now(),
				});
			}
		}

		// 2. Order Book Imbalance — strong directional pressure
		if (snapshot.imbalanceRatio >= this.config.minImbalanceRatio ||
			snapshot.imbalanceRatio <= 1 / this.config.minImbalanceRatio) {
			const ratio = Math.max(snapshot.imbalanceRatio, 1 / snapshot.imbalanceRatio);
			const direction = snapshot.imbalanceRatio > 1 ? "buying" : "selling";
			const confidence = Math.min((ratio - 1) / 4, 0.9); // Caps at 0.9

			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "imbalance",
					pair,
					confidence,
					description: `${pair} has ${ratio.toFixed(1)}x ${direction} pressure — bid depth ${snapshot.bidDepth.toFixed(2)} vs ask depth ${snapshot.askDepth.toFixed(2)}`,
					details: {
						imbalanceRatio: snapshot.imbalanceRatio,
						direction,
						bidDepth: snapshot.bidDepth,
						askDepth: snapshot.askDepth,
					},
					detectedAt: Date.now(),
				});
			}
		}

		// 3. Depth Gap — thin order book levels (easy to move price)
		const thinSide = snapshot.bidLevels < 5 ? "bid" : snapshot.askLevels < 5 ? "ask" : null;
		if (thinSide) {
			const levels = thinSide === "bid" ? snapshot.bidLevels : snapshot.askLevels;
			const confidence = Math.min((5 - levels) / 5, 0.7);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "depth_gap",
					pair,
					confidence,
					description: `${pair} has thin ${thinSide} side (${levels} levels) — price could move quickly on ${thinSide === "bid" ? "sell" : "buy"} pressure`,
					details: { side: thinSide, levels, bidLevels: snapshot.bidLevels, askLevels: snapshot.askLevels },
					detectedAt: Date.now(),
				});
			}
		}

		// 4. Momentum — detect trending price from snapshot history
		const history = this.snapshotHistory.get(pair) ?? [];
		if (history.length >= 6) {
			const recent = history.slice(-6);
			const prices = recent.map((s) => s.midPrice).filter((p): p is number => p != null);
			if (prices.length >= 4) {
				const first = prices[0];
				const last = prices[prices.length - 1];
				const changePct = ((last - first) / first) * 100;
				// Check if movement is consistently in one direction
				let ups = 0;
				let downs = 0;
				for (let i = 1; i < prices.length; i++) {
					if (prices[i] > prices[i - 1]) ups++;
					else if (prices[i] < prices[i - 1]) downs++;
				}
				const consistency = Math.max(ups, downs) / (prices.length - 1);

				if (Math.abs(changePct) >= 1 && consistency >= 0.6) {
					const direction = changePct > 0 ? "up" : "down";
					const confidence = Math.min(Math.abs(changePct) / 5 * consistency, 0.85);
					if (confidence >= this.config.minConfidence) {
						opps.push({
							type: "momentum",
							pair,
							confidence,
							description: `${pair} trending ${direction} ${Math.abs(changePct).toFixed(2)}% over last ${recent.length} snapshots (${(consistency * 100).toFixed(0)}% consistent)`,
							details: { changePct, direction, consistency, priceStart: first, priceEnd: last },
							detectedAt: Date.now(),
						});
					}
				}
			}
		}

		return opps;
	}
}
