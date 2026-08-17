/**
 * Stellar DEX client — talks to Horizon API.
 * Stellar has a native order-book DEX built into the protocol (like XRPL).
 */

const HORIZON = "https://horizon.stellar.org";
const TIMEOUT_MS = 15_000;

export interface StellarAsset {
	type: "native" | "credit_alphanum4" | "credit_alphanum12";
	code?: string;
	issuer?: string;
}

export interface StellarOrderBookEntry {
	price: number;
	amount: number;
}

export interface StellarOrderBook {
	base: StellarAsset;
	counter: StellarAsset;
	bids: StellarOrderBookEntry[];
	asks: StellarOrderBookEntry[];
	midPrice: number | null;
	spread: number | null;
	spreadPct: number | null;
	timestamp: number;
}

export interface StellarTrade {
	id: string;
	baseAmount: number;
	counterAmount: number;
	price: number;
	timestamp: string;
	baseIsSeller: boolean;
}

/** Well-known Stellar tokens */
export const STELLAR_ASSETS: Record<string, StellarAsset & { name: string }> = {
	XLM: { type: "native", name: "Stellar Lumens" },
	USDC: { type: "credit_alphanum4", code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", name: "USDC (Centre)" },
	AQUA: { type: "credit_alphanum4", code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", name: "Aquarius" },
	MOBI: { type: "credit_alphanum4", code: "MOBI", issuer: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH", name: "Mobius" },
	ETH: { type: "credit_alphanum4", code: "ETH", issuer: "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR", name: "Stellar ETH" },
};

/** Common Stellar DEX trading pairs */
export const STELLAR_PAIRS: { base: StellarAsset; counter: StellarAsset; label: string }[] = [
	{ base: { type: "native" }, counter: STELLAR_ASSETS.USDC, label: "XLM/USDC" },
	{ base: STELLAR_ASSETS.AQUA, counter: { type: "native" }, label: "AQUA/XLM" },
	{ base: STELLAR_ASSETS.MOBI, counter: { type: "native" }, label: "MOBI/XLM" },
	{ base: STELLAR_ASSETS.ETH, counter: { type: "native" }, label: "ETH/XLM" },
];

export class StellarClient {
	private horizon: string;

	constructor(horizon?: string) {
		this.horizon = horizon ?? HORIZON;
	}

	/** Get order book for a trading pair */
	async getOrderBook(base: StellarAsset, counter: StellarAsset, limit = 20): Promise<StellarOrderBook> {
		const params = new URLSearchParams();
		this.setAssetParams(params, "selling", base);
		this.setAssetParams(params, "buying", counter);
		params.set("limit", String(limit));

		const url = `${this.horizon}/order_book?${params}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);

		const data = await res.json() as {
			bids: { price: string; amount: string }[];
			asks: { price: string; amount: string }[];
		};

		const bids = data.bids.map((b) => ({ price: Number(b.price), amount: Number(b.amount) }));
		const asks = data.asks.map((a) => ({ price: Number(a.price), amount: Number(a.amount) }));

		const bestBid = bids[0]?.price ?? null;
		const bestAsk = asks[0]?.price ?? null;
		const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
		const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
		const spreadPct = spread != null && midPrice != null && midPrice > 0
			? (spread / midPrice) * 100
			: null;

		return { base, counter, bids, asks, midPrice, spread, spreadPct, timestamp: Date.now() };
	}

	/** Get recent trades for a pair */
	async getTrades(base: StellarAsset, counter: StellarAsset, limit = 50): Promise<StellarTrade[]> {
		const params = new URLSearchParams();
		this.setAssetParams(params, "base", base);
		this.setAssetParams(params, "counter", counter);
		params.set("limit", String(limit));
		params.set("order", "desc");

		const url = `${this.horizon}/trades?${params}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);

		const data = await res.json() as {
			_embedded: {
				records: {
					id: string;
					base_amount: string;
					counter_amount: string;
					price: { n: number; d: number };
					ledger_close_time: string;
					base_is_seller: boolean;
				}[];
			};
		};

		return data._embedded.records.map((r) => ({
			id: r.id,
			baseAmount: Number(r.base_amount),
			counterAmount: Number(r.counter_amount),
			price: r.price.n / r.price.d,
			timestamp: r.ledger_close_time,
			baseIsSeller: r.base_is_seller,
		}));
	}

	/** Get account balances */
	async getAccountBalances(address: string): Promise<{
		xlm: number;
		tokens: { code: string; issuer: string; balance: number }[];
	}> {
		const res = await fetch(`${this.horizon}/accounts/${address}`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);

		const data = await res.json() as {
			balances: {
				asset_type: string;
				asset_code?: string;
				asset_issuer?: string;
				balance: string;
			}[];
		};

		let xlm = 0;
		const tokens: { code: string; issuer: string; balance: number }[] = [];

		for (const b of data.balances) {
			if (b.asset_type === "native") {
				xlm = Number(b.balance);
			} else if (b.asset_code && b.asset_issuer) {
				tokens.push({
					code: b.asset_code,
					issuer: b.asset_issuer,
					balance: Number(b.balance),
				});
			}
		}

		return { xlm, tokens };
	}

	/** Get trade aggregations (candle-like data) */
	async getTradeAggregations(
		base: StellarAsset,
		counter: StellarAsset,
		resolution: number = 3600000, // 1 hour in ms
		limit = 50,
	): Promise<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }[]> {
		const params = new URLSearchParams();
		this.setAssetParams(params, "base", base);
		this.setAssetParams(params, "counter", counter);
		params.set("resolution", String(resolution));
		params.set("limit", String(limit));
		params.set("order", "desc");

		const url = `${this.horizon}/trade_aggregations?${params}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);

		const data = await res.json() as {
			_embedded: {
				records: {
					timestamp: string;
					open: string;
					high: string;
					low: string;
					close: string;
					base_volume: string;
				}[];
			};
		};

		return data._embedded.records.map((r) => ({
			timestamp: Number(r.timestamp),
			open: Number(r.open),
			high: Number(r.high),
			low: Number(r.low),
			close: Number(r.close),
			volume: Number(r.base_volume),
		}));
	}

	private setAssetParams(params: URLSearchParams, prefix: string, asset: StellarAsset): void {
		// Auto-detect correct type from code length if not native
		let type = asset.type;
		if (type !== "native" && asset.code) {
			type = asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
		}
		params.set(`${prefix}_asset_type`, type);
		if (asset.code) params.set(`${prefix}_asset_code`, asset.code);
		if (asset.issuer) params.set(`${prefix}_asset_issuer`, asset.issuer);
	}
}
