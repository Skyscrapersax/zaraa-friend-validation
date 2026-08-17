import { CryptoClient } from "../crypto-client.js";
import type { Exchange, CandleData } from "./exchange.js";
import type { Ticker, OrderBook, Balance, TradeResult } from "../crypto-client.js";
import {
	TickerOutputSchema,
	OrderBookOutputSchema,
	CandleOutputSchema,
	BalanceOutputSchema,
	TradeResultOutputSchema,
	validateOutput,
} from "./exchange-schemas.js";

/**
 * Adapts the existing CryptoClient to the Exchange interface.
 */
export class CryptoComAdapter implements Exchange {
	readonly name = "crypto-com";
	readonly label = "Crypto.com Exchange";
	private client: CryptoClient;

	constructor(config: { apiKey?: string; apiSecret?: string } = {}) {
		this.client = new CryptoClient(config);
	}

	get hasCredentials(): boolean {
		return this.client.hasCredentials;
	}

	/** Expose the underlying client for direct use when needed */
	getClient(): CryptoClient {
		return this.client;
	}

	async getTicker(symbol: string): Promise<Ticker> {
		const raw = await this.client.getTicker(symbol);
		return validateOutput(TickerOutputSchema, raw, "crypto-com:ticker") as Ticker;
	}

	async getOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
		const raw = await this.client.getOrderBook(symbol, depth);
		return validateOutput(OrderBookOutputSchema, raw, "crypto-com:orderbook") as OrderBook;
	}

	async getCandles(symbol: string, timeframe: string): Promise<CandleData[]> {
		const raw = await this.client.getCandles(symbol, timeframe);
		return raw.map((c) => validateOutput(CandleOutputSchema, c, "crypto-com:candle") as CandleData);
	}

	async getBalances(): Promise<Balance[]> {
		const raw = await this.client.getBalances();
		return raw.map((b) => validateOutput(BalanceOutputSchema, b, "crypto-com:balance") as Balance);
	}

	async createOrder(params: {
		symbol: string;
		side: "BUY" | "SELL";
		type: "MARKET" | "LIMIT";
		qty: number;
		price?: number;
	}): Promise<TradeResult> {
		const raw = await this.client.createOrder(params);
		return validateOutput(TradeResultOutputSchema, raw, "crypto-com:createOrder") as TradeResult;
	}

	async cancelOrder(symbol: string, orderId: string): Promise<{ orderId: string; status: string }> {
		return this.client.cancelOrder(symbol, orderId);
	}

	async getOpenOrders(symbol?: string): Promise<TradeResult[]> {
		const raw = await this.client.getOpenOrders(symbol);
		return raw.map((o) => validateOutput(TradeResultOutputSchema, o, "crypto-com:openOrder") as TradeResult);
	}
}
