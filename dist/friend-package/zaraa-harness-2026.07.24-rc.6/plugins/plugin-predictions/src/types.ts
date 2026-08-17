/**
 * Prediction Market Types — shared data structures for Polymarket, Kalshi, etc.
 *
 * Prediction markets trade binary outcome contracts (Yes/No) that settle at $0 or $1.
 * The price of a Yes token IS the implied probability (e.g., $0.72 = 72% chance).
 */

/** Supported prediction market exchanges */
export type PredictionExchange = "polymarket" | "kalshi";

/** Market status */
export type MarketStatus = "open" | "closed" | "resolved";

/** A prediction market contract */
export interface PredictionMarket {
	/** Unique market ID on the exchange */
	id: string;
	/** Which exchange this market is on */
	exchange: PredictionExchange;
	/** The question being predicted */
	question: string;
	/** Short slug/ticker */
	slug: string;
	/** Category (politics, crypto, sports, weather, etc.) */
	category: string;
	/** Current Yes price (0-1, = implied probability) */
	yesPrice: number;
	/** Current No price (0-1, = 1 - yesPrice) */
	noPrice: number;
	/** Best bid for Yes token */
	yesBid: number;
	/** Best ask for Yes token */
	yesAsk: number;
	/** 24h volume in USD */
	volume24h: number;
	/** Total volume in USD */
	totalVolume: number;
	/** Total liquidity in USD */
	liquidity: number;
	/** When the market expires/resolves */
	expiresAt: string;
	/** Market status */
	status: MarketStatus;
	/** When the market was created (ISO timestamp, optional — not all APIs provide this) */
	createdAt?: string;
	/** Last updated timestamp */
	updatedAt: string;
	/** Outcome token ids when the exchange exposes per-side execution assets. */
	outcomeTokenIds?: {
		yes: string | null;
		no: string | null;
	};
}

/** An order book entry */
export interface BookEntry {
	price: number;
	size: number;
}

/** Order book for a market */
export interface PredictionOrderBook {
	marketId: string;
	exchange: PredictionExchange;
	bids: BookEntry[];
	asks: BookEntry[];
	midpoint: number;
	spread: number;
	timestamp: string;
}

/** A trade on a prediction market */
export interface PredictionTrade {
	id: string;
	marketId: string;
	exchange: PredictionExchange;
	side: "yes" | "no";
	price: number;
	size: number;
	timestamp: string;
}

/** Position in a prediction market */
export interface PredictionPosition {
	marketId: string;
	exchange: PredictionExchange;
	question: string;
	side: "yes" | "no";
	avgPrice: number;
	size: number;
	currentPrice: number;
	unrealizedPnl: number;
	/** Expected value = (probability * $1 - avgPrice) * size */
	expectedValue: number;
}

/** Signal from the prediction market analyzer */
export interface PredictionSignal {
	marketId: string;
	exchange: PredictionExchange;
	question: string;
	/** Buy yes or buy no */
	side: "yes" | "no";
	/** Model's estimated true probability (0-1) */
	modelProbability: number;
	/** Market's current price (= implied probability) */
	marketPrice: number;
	/** Expected value net of Polymarket taker fees */
	expectedValue: number;
	/** Confidence in the signal (0-1) */
	confidence: number;
	/** Suggested position size as fraction of bankroll (Kelly criterion) */
	kellyFraction: number;
	/** Quarter-Kelly position size (conservative) */
	quarterKellySize: number;
	/** Reason for the signal */
	reason: string;
	timestamp: number;
}

/** Configuration for connecting to a prediction exchange */
export interface PredictionExchangeConfig {
	exchange: PredictionExchange;
	/** API key or private key */
	apiKey?: string;
	/** API secret (for Kalshi) */
	apiSecret?: string;
	/** Whether to use sandbox/testnet */
	sandbox?: boolean;
}
