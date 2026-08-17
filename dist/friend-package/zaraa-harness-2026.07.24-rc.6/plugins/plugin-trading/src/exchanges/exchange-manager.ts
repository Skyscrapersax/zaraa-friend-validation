import type { Exchange } from "./exchange.js";
import type { Balance } from "../crypto-client.js";

export interface PriceComparison {
	symbol: string;
	prices: {
		exchange: string;
		bid: number;
		ask: number;
		last: number;
	}[];
	bestBid: { exchange: string; price: number };
	bestAsk: { exchange: string; price: number };
	spreadOpportunity: number | null;
}

export interface AggregatedBalances {
	byExchange: {
		exchange: string;
		balances: { currency: string; available: number; locked: number; total: number }[];
	}[];
	totals: { currency: string; total: number }[];
}

/**
 * Manages multiple exchange connections.
 * Routes operations and compares prices across exchanges.
 */
export class ExchangeManager {
	private exchanges = new Map<string, Exchange>();
	private defaultExchange: string | null = null;

	register(exchange: Exchange): void {
		this.exchanges.set(exchange.name, exchange);
		if (this.exchanges.size === 1) {
			this.defaultExchange = exchange.name;
		}
	}

	remove(name: string): boolean {
		const removed = this.exchanges.delete(name);
		if (removed && this.defaultExchange === name) {
			const first = this.exchanges.keys().next();
			this.defaultExchange = first.done ? null : first.value;
		}
		return removed;
	}

	setDefault(name: string): void {
		if (!this.exchanges.has(name)) {
			throw new Error(`Exchange not registered: ${name}`);
		}
		this.defaultExchange = name;
	}

	get(name: string): Exchange | undefined {
		return this.exchanges.get(name);
	}

	getDefault(): Exchange | undefined {
		return this.defaultExchange ? this.exchanges.get(this.defaultExchange) : undefined;
	}

	getDefaultName(): string | null {
		return this.defaultExchange;
	}

	list(): { name: string; label: string; hasCredentials: boolean; isDefault: boolean }[] {
		return Array.from(this.exchanges.values()).map((ex) => ({
			name: ex.name,
			label: ex.label,
			hasCredentials: ex.hasCredentials,
			isDefault: ex.name === this.defaultExchange,
		}));
	}

	get size(): number {
		return this.exchanges.size;
	}

	/**
	 * Compare prices for a symbol across all registered exchanges.
	 */
	async comparePrices(symbol: string): Promise<PriceComparison> {
		const results = await Promise.allSettled(
			Array.from(this.exchanges.entries()).map(async ([name, ex]) => {
				const ticker = await ex.getTicker(symbol);
				return { exchange: name, bid: ticker.bid, ask: ticker.ask, last: ticker.last };
			}),
		);

		const prices = results
			.filter((r): r is PromiseFulfilledResult<{ exchange: string; bid: number; ask: number; last: number }> =>
				r.status === "fulfilled",
			)
			.map((r) => r.value);

		if (prices.length === 0) {
			return {
				symbol,
				prices: [],
				bestBid: { exchange: "", price: 0 },
				bestAsk: { exchange: "", price: 0 },
				spreadOpportunity: null,
			};
		}

		const bestBid = prices.reduce((best, p) => (p.bid > best.bid ? p : best));
		const bestAsk = prices.reduce((best, p) => (p.ask < best.ask ? p : best));

		// Arbitrage opportunity: buy on cheapest ask, sell on highest bid
		const spreadOpportunity = prices.length > 1
			? bestBid.bid - bestAsk.ask
			: null;

		return {
			symbol,
			prices,
			bestBid: { exchange: bestBid.exchange, price: bestBid.bid },
			bestAsk: { exchange: bestAsk.exchange, price: bestAsk.ask },
			spreadOpportunity,
		};
	}

	/**
	 * Aggregate balances across all exchanges with credentials.
	 */
	async aggregateBalances(): Promise<AggregatedBalances> {
		const results = await Promise.allSettled(
			Array.from(this.exchanges.entries())
				.filter(([, ex]) => ex.hasCredentials)
				.map(async ([name, ex]) => {
					const balances = await ex.getBalances();
					return { exchange: name, balances };
				}),
		);

		const byExchange = results
			.filter((r): r is PromiseFulfilledResult<{ exchange: string; balances: Balance[] }> =>
				r.status === "fulfilled",
			)
			.map((r) => r.value);

		// Aggregate totals by currency
		const totalsMap = new Map<string, number>();
		for (const ex of byExchange) {
			for (const b of ex.balances) {
				totalsMap.set(b.currency, (totalsMap.get(b.currency) ?? 0) + b.total);
			}
		}

		const totals = Array.from(totalsMap.entries())
			.map(([currency, total]) => ({ currency, total }))
			.filter((t) => t.total > 0)
			.sort((a, b) => b.total - a.total);

		return { byExchange, totals };
	}
}
