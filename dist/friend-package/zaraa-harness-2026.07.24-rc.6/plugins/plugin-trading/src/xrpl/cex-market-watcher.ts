/**
 * CEX Market Watcher — monitors centralized exchange pairs (Crypto.com)
 * and feeds observations into the Market Learner.
 *
 * Mirrors the XRPL DEX Watcher pattern but uses Crypto.com ticker + order book data.
 * Tracks: FLR, SOL, XLM, and any other USDT pairs you add.
 */

import type { CryptoClient, Ticker, OrderBook } from "../crypto-client.js";
import type { MarketLearner } from "./market-learner.js";

export interface CexWatchedSymbol {
	symbol: string; // e.g., "FLR_USDT"
	label: string;  // e.g., "FLR/USDT"
}

export interface CexSnapshot {
	symbol: string;
	label: string;
	last: number;
	bid: number;
	ask: number;
	spreadPct: number;
	high24h: number;
	low24h: number;
	volume24h: number;
	change24h: number;
	bidDepth: number;
	askDepth: number;
	imbalanceRatio: number;
	timestamp: number;
}

export interface CexOpportunity {
	type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "volume_spike";
	symbol: string;
	confidence: number;
	description: string;
	details: Record<string, unknown>;
	detectedAt: number;
}

export interface CexWatcherConfig {
	minSpreadPctForCapture: number;
	minImbalanceRatio: number;
	minConfidence: number;
	/** % change in 24h to flag as high volatility */
	volatilityThreshold: number;
}

const DEFAULT_CONFIG: CexWatcherConfig = {
	minSpreadPctForCapture: 0.15,
	minImbalanceRatio: 2.0,
	minConfidence: 0.3,
	volatilityThreshold: 5,
};

export class CexMarketWatcher {
	private client: CryptoClient;
	private learner: MarketLearner | null;
	private symbols: CexWatchedSymbol[];
	private config: CexWatcherConfig;
	private lastSnapshots = new Map<string, CexSnapshot>();
	private snapshotHistory = new Map<string, CexSnapshot[]>();
	private readonly MAX_HISTORY = 288;

	constructor(
		client: CryptoClient,
		symbols: CexWatchedSymbol[],
		config: Partial<CexWatcherConfig> = {},
		learner: MarketLearner | null = null,
	) {
		this.client = client;
		this.symbols = symbols;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.learner = learner;
	}

	/** Scan all watched symbols — fetches ticker + order book, detects opportunities */
	async scan(): Promise<{
		snapshots: CexSnapshot[];
		opportunities: CexOpportunity[];
		errors: string[];
	}> {
		const snapshots: CexSnapshot[] = [];
		const opportunities: CexOpportunity[] = [];
		const errors: string[] = [];

		for (const sym of this.symbols) {
			try {
				const [ticker, book] = await Promise.all([
					this.client.getTicker(sym.symbol),
					this.client.getOrderBook(sym.symbol, 20),
				]);

				const snapshot = this.buildSnapshot(sym, ticker, book);
				snapshots.push(snapshot);

				// Store
				this.lastSnapshots.set(sym.label, snapshot);
				const history = this.snapshotHistory.get(sym.label) ?? [];
				history.push(snapshot);
				if (history.length > this.MAX_HISTORY) history.shift();
				this.snapshotHistory.set(sym.label, history);

				// Detect opportunities
				const opps = this.detectOpportunities(sym.label, snapshot);
				opportunities.push(...opps);

				// Feed to learner
				if (this.learner) {
					this.learner.recordObservation({
						pair: sym.label,
						midPrice: (snapshot.bid + snapshot.ask) / 2,
						spreadPct: snapshot.spreadPct,
						bidDepth: snapshot.bidDepth,
						askDepth: snapshot.askDepth,
						imbalanceRatio: snapshot.imbalanceRatio,
						timestamp: snapshot.timestamp,
					});
				}
			} catch (err) {
				errors.push(`${sym.label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { snapshots, opportunities, errors };
	}

	getLatest(label: string): CexSnapshot | undefined {
		return this.lastSnapshots.get(label);
	}

	getHistory(label: string, limit = 50): CexSnapshot[] {
		const history = this.snapshotHistory.get(label) ?? [];
		return history.slice(-limit);
	}

	getSummary(): {
		symbols: { label: string; last: number; change24h: string; spreadPct: number; imbalance: number }[];
		mostVolatile: { label: string; change24h: number } | null;
		bestSpread: { label: string; spreadPct: number } | null;
		strongestImbalance: { label: string; ratio: number; direction: "buy" | "sell" } | null;
	} {
		const entries = Array.from(this.lastSnapshots.entries()).map(([label, s]) => ({
			label,
			last: s.last,
			change24h: `${s.change24h > 0 ? "+" : ""}${(s.change24h * 100).toFixed(2)}%`,
			change24hRaw: s.change24h,
			spreadPct: s.spreadPct,
			imbalance: s.imbalanceRatio,
		}));

		const mostVolatile = entries.length > 0
			? entries.reduce((best, e) => Math.abs(e.change24hRaw) > Math.abs(best.change24hRaw) ? e : best)
			: null;

		const withSpread = entries.filter((e) => e.spreadPct > 0);
		const bestSpread = withSpread.length > 0
			? withSpread.reduce((best, e) => e.spreadPct > best.spreadPct ? e : best)
			: null;

		const strongestImbalance = entries.length > 0
			? entries.reduce((best, e) => {
				const ratio = Math.max(e.imbalance, 1 / (e.imbalance || 1));
				const bestRatio = Math.max(best.imbalance, 1 / (best.imbalance || 1));
				return ratio > bestRatio ? e : best;
			})
			: null;

		return {
			symbols: entries.map(({ change24hRaw: _, ...rest }) => rest),
			mostVolatile: mostVolatile ? { label: mostVolatile.label, change24h: mostVolatile.change24hRaw } : null,
			bestSpread: bestSpread ? { label: bestSpread.label, spreadPct: bestSpread.spreadPct } : null,
			strongestImbalance: strongestImbalance ? {
				label: strongestImbalance.label,
				ratio: strongestImbalance.imbalance,
				direction: strongestImbalance.imbalance > 1 ? "buy" : "sell",
			} : null,
		};
	}

	setSymbols(symbols: CexWatchedSymbol[]): void {
		this.symbols = symbols;
	}

	addSymbol(sym: CexWatchedSymbol): void {
		if (!this.symbols.some((s) => s.symbol === sym.symbol)) {
			this.symbols.push(sym);
		}
	}

	getSymbols(): CexWatchedSymbol[] {
		return [...this.symbols];
	}

	private buildSnapshot(sym: CexWatchedSymbol, ticker: Ticker, book: OrderBook): CexSnapshot {
		const bidDepth = book.bids.reduce((sum, b) => sum + b.price * b.qty, 0);
		const askDepth = book.asks.reduce((sum, a) => sum + a.price * a.qty, 0);
		const mid = (ticker.bid + ticker.ask) / 2;
		const spread = ticker.ask - ticker.bid;
		const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;
		const imbalanceRatio = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? 999 : 1;

		return {
			symbol: sym.symbol,
			label: sym.label,
			last: ticker.last,
			bid: ticker.bid,
			ask: ticker.ask,
			spreadPct,
			high24h: ticker.high24h,
			low24h: ticker.low24h,
			volume24h: ticker.volume24h,
			change24h: ticker.change24h,
			bidDepth,
			askDepth,
			imbalanceRatio,
			timestamp: Date.now(),
		};
	}

	private detectOpportunities(label: string, snapshot: CexSnapshot): CexOpportunity[] {
		const opps: CexOpportunity[] = [];

		// 1. Spread capture
		if (snapshot.spreadPct >= this.config.minSpreadPctForCapture) {
			const confidence = Math.min(snapshot.spreadPct / 0.5, 0.9);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "spread_capture",
					symbol: label,
					confidence,
					description: `${label} spread is ${snapshot.spreadPct.toFixed(3)}% — bid $${snapshot.bid.toFixed(6)} / ask $${snapshot.ask.toFixed(6)}`,
					details: { spreadPct: snapshot.spreadPct, bid: snapshot.bid, ask: snapshot.ask },
					detectedAt: Date.now(),
				});
			}
		}

		// 2. Order book imbalance
		if (snapshot.imbalanceRatio >= this.config.minImbalanceRatio ||
			snapshot.imbalanceRatio <= 1 / this.config.minImbalanceRatio) {
			const ratio = Math.max(snapshot.imbalanceRatio, 1 / snapshot.imbalanceRatio);
			const direction = snapshot.imbalanceRatio > 1 ? "buying" : "selling";
			const confidence = Math.min((ratio - 1) / 4, 0.9);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "imbalance",
					symbol: label,
					confidence,
					description: `${label} has ${ratio.toFixed(1)}x ${direction} pressure — bid depth $${snapshot.bidDepth.toFixed(0)} vs ask depth $${snapshot.askDepth.toFixed(0)}`,
					details: { imbalanceRatio: snapshot.imbalanceRatio, direction, bidDepth: snapshot.bidDepth, askDepth: snapshot.askDepth },
					detectedAt: Date.now(),
				});
			}
		}

		// 3. High volatility — big 24h move
		const absChange = Math.abs(snapshot.change24h * 100);
		if (absChange >= this.config.volatilityThreshold) {
			const direction = snapshot.change24h > 0 ? "up" : "down";
			const confidence = Math.min(absChange / 15, 0.85);
			if (confidence >= this.config.minConfidence) {
				opps.push({
					type: "volatility",
					symbol: label,
					confidence,
					description: `${label} moved ${direction} ${absChange.toFixed(1)}% in 24h — high: $${snapshot.high24h.toFixed(6)}, low: $${snapshot.low24h.toFixed(6)}`,
					details: { change24h: snapshot.change24h, high24h: snapshot.high24h, low24h: snapshot.low24h, direction },
					detectedAt: Date.now(),
				});
			}
		}

		// 4. Momentum from snapshot history
		const history = this.snapshotHistory.get(label) ?? [];
		if (history.length >= 6) {
			const recent = history.slice(-6);
			const prices = recent.map((s) => s.last);
			const first = prices[0];
			const last = prices[prices.length - 1];
			const changePct = ((last - first) / first) * 100;

			let ups = 0;
			let downs = 0;
			for (let i = 1; i < prices.length; i++) {
				if (prices[i] > prices[i - 1]) ups++;
				else if (prices[i] < prices[i - 1]) downs++;
			}
			const consistency = Math.max(ups, downs) / (prices.length - 1);

			if (Math.abs(changePct) >= 0.5 && consistency >= 0.6) {
				const direction = changePct > 0 ? "up" : "down";
				const confidence = Math.min(Math.abs(changePct) / 3 * consistency, 0.85);
				if (confidence >= this.config.minConfidence) {
					opps.push({
						type: "momentum",
						symbol: label,
						confidence,
						description: `${label} trending ${direction} ${Math.abs(changePct).toFixed(2)}% over last ${recent.length} snapshots (${(consistency * 100).toFixed(0)}% consistent)`,
						details: { changePct, direction, consistency, priceStart: first, priceEnd: last },
						detectedAt: Date.now(),
					});
				}
			}
		}

		return opps;
	}
}
