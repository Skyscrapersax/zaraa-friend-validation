import type { Ticker, OrderBook, Balance, TradeResult } from "../crypto-client.js";

export interface CandleData {
	openTime: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

/**
 * Abstract exchange interface. Every exchange adapter implements this.
 * Allows the trading plugin to work with any exchange transparently.
 */
export interface Exchange {
	/** Unique identifier for this exchange instance (e.g., "crypto-com", "binance") */
	readonly name: string;
	/** Human-readable label */
	readonly label: string;
	/** Whether private (authenticated) endpoints are available */
	readonly hasCredentials: boolean;

	// ── Public ──
	getTicker(symbol: string): Promise<Ticker>;
	getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
	getCandles(symbol: string, timeframe: string): Promise<CandleData[]>;

	// ── Private (require credentials) ──
	getBalances(): Promise<Balance[]>;
	createOrder(params: {
		symbol: string;
		side: "BUY" | "SELL";
		type: "MARKET" | "LIMIT";
		qty: number;
		price?: number;
	}): Promise<TradeResult>;
	cancelOrder(symbol: string, orderId: string): Promise<{ orderId: string; status: string }>;
	getOpenOrders(symbol?: string): Promise<TradeResult[]>;
}

/**
 * Configuration for registering an exchange.
 */
export interface ExchangeConfig {
	name: string;
	label?: string;
	apiKey?: string;
	apiSecret?: string;
}
