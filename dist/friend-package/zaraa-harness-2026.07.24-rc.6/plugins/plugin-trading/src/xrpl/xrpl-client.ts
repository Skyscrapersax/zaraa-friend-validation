/**
 * Lightweight XRPL JSON-RPC client.
 * Uses native fetch + Zod validation.
 * Connects to public XRPL nodes for DEX data.
 */

import { z } from "zod";

const DEFAULT_RPC = "https://xrplcluster.com";
const REQUEST_TIMEOUT_MS = 15_000;

// ── Safe JSON parse helper ──

async function safeJsonParse<T>(res: Response, context: string): Promise<T> {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${context}: expected JSON but got: ${text.slice(0, 200)}`);
	}
}

// ── Zod schema for XRPL response wrapper ──

const XrplResponseSchema = z.object({
	result: z.object({
		status: z.string().optional(),
		error_message: z.string().optional(),
	}).passthrough(),
}).passthrough();

export interface XRPLCurrency {
	/** "XRP" for native, or token code (e.g., "SOLO", "USD") */
	currency: string;
	/** Issuer address — omitted for XRP */
	issuer?: string;
}

export interface XRPLAmount {
	currency: string;
	issuer?: string;
	value: string;
}

export interface XRPLOffer {
	Account: string;
	Sequence: number;
	TakerGets: string | XRPLAmount;
	TakerPays: string | XRPLAmount;
	quality?: string;
	Flags?: number;
}

export interface XRPLBookEntry {
	price: number;
	quantity: number;
	account: string;
}

export interface XRPLOrderBook {
	base: XRPLCurrency;
	quote: XRPLCurrency;
	bids: XRPLBookEntry[];
	asks: XRPLBookEntry[];
	midPrice: number | null;
	spread: number | null;
	spreadPct: number | null;
	timestamp: number;
}

export interface XRPLTrustLine {
	account: string;
	currency: string;
	balance: string;
	limit: string;
}

export interface XRPLClientConfig {
	rpcUrl?: string;
}

/** Well-known XRPL token issuers */
export const KNOWN_ISSUERS: Record<string, { currency: string; issuer: string; name: string }> = {
	SOLO: { currency: "534F4C4F00000000000000000000000000000000", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", name: "Sologenic" },
	CSC: { currency: "CSC", issuer: "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr", name: "CasinoCoin" },
	CORE: { currency: "434F524500000000000000000000000000000000", issuer: "rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D", name: "Coreum" },
	USD_GATEHUB: { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", name: "GateHub USD" },
	USD_BITSTAMP: { currency: "USD", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", name: "Bitstamp USD" },
	ELS: { currency: "454C5300000000000000000000000000000000", issuer: "rHXuEaRYnnJHbDeuBH5w8yPh5uwNVh5zAg", name: "Equilibrium" },
};

/** Common XRPL DEX trading pairs */
export const DEX_PAIRS: { base: XRPLCurrency; quote: XRPLCurrency; label: string }[] = [
	{ base: { currency: "XRP" }, quote: { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }, label: "XRP/USD" },
	{ base: { currency: "534F4C4F00000000000000000000000000000000", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz" }, quote: { currency: "XRP" }, label: "SOLO/XRP" },
	{ base: { currency: "CSC", issuer: "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr" }, quote: { currency: "XRP" }, label: "CSC/XRP" },
	{ base: { currency: "434F524500000000000000000000000000000000", issuer: "rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D" }, quote: { currency: "XRP" }, label: "CORE/XRP" },
];

export class XRPLClient {
	private rpcUrl: string;

	constructor(config: XRPLClientConfig = {}) {
		this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC;
	}

	/** Send a JSON-RPC request to the XRPL node */
	private async rpc<T>(method: string, params: Record<string, unknown>[] = [{}]): Promise<T> {
		const res = await fetch(this.rpcUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, params }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`XRPL RPC error ${res.status}: ${await res.text()}`);
		}

		const raw = await safeJsonParse<unknown>(res, `XRPL RPC ${method}`);
		const parsed = XrplResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`XRPL RPC ${method}: invalid response shape: ${parsed.error.message}`);
		}
		const result = parsed.data.result;
		if (result.status === "error") {
			throw new Error(`XRPL error (${method}): ${result.error_message ?? "unknown"}`);
		}
		return result as T;
	}

	/** Get order book for a currency pair */
	async getOrderBook(
		base: XRPLCurrency,
		quote: XRPLCurrency,
		limit = 20,
	): Promise<XRPLOrderBook> {
		const takerGets = base.currency === "XRP"
			? { currency: "XRP" }
			: { currency: base.currency, issuer: base.issuer };
		const takerPays = quote.currency === "XRP"
			? { currency: "XRP" }
			: { currency: quote.currency, issuer: quote.issuer };

		// Asks: people selling base for quote
		const askResult = await this.rpc<{ offers: XRPLOffer[] }>("book_offers", [{
			taker_gets: takerGets,
			taker_pays: takerPays,
			limit,
		}]);

		// Bids: people buying base with quote (reverse book)
		const bidResult = await this.rpc<{ offers: XRPLOffer[] }>("book_offers", [{
			taker_gets: takerPays,
			taker_pays: takerGets,
			limit,
		}]);

		const asks = askResult.offers.map((o) => this.parseOffer(o, "ask", base));
		const bids = bidResult.offers.map((o) => this.parseOffer(o, "bid", base));

		// Sort: bids descending, asks ascending
		bids.sort((a, b) => b.price - a.price);
		asks.sort((a, b) => a.price - b.price);

		const bestBid = bids[0]?.price ?? null;
		const bestAsk = asks[0]?.price ?? null;
		const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
		const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
		const spreadPct = spread != null && midPrice != null && midPrice > 0
			? (spread / midPrice) * 100
			: null;

		return {
			base, quote,
			bids, asks,
			midPrice, spread, spreadPct,
			timestamp: Date.now(),
		};
	}

	/** Get account info (balance, sequence, etc.) */
	async getAccountInfo(address: string): Promise<{
		balance: number;
		sequence: number;
		ownerCount: number;
		reserve: number;
	}> {
		const result = await this.rpc<{
			account_data: {
				Balance: string;
				Sequence: number;
				OwnerCount: number;
			};
		}>("account_info", [{ account: address, ledger_index: "validated" }]);

		const drops = Number(result.account_data.Balance);
		const ownerCount = result.account_data.OwnerCount;
		// Base reserve: 10 XRP + 2 XRP per owned object
		const reserve = 10 + ownerCount * 2;

		return {
			balance: drops / 1_000_000,
			sequence: result.account_data.Sequence,
			ownerCount,
			reserve,
		};
	}

	/** Get trust lines for an account */
	async getTrustLines(address: string): Promise<XRPLTrustLine[]> {
		const result = await this.rpc<{
			lines: { account: string; currency: string; balance: string; limit: string }[];
		}>("account_lines", [{ account: address, ledger_index: "validated" }]);

		return result.lines;
	}

	/** Get server info (fee, ledger sequence, etc.) */
	async getServerInfo(): Promise<{
		ledgerIndex: number;
		baseFeeXRP: number;
		serverState: string;
	}> {
		const result = await this.rpc<{
			info: {
				validated_ledger: { seq: number; base_fee_xrp: number };
				server_state: string;
			};
		}>("server_info");

		return {
			ledgerIndex: result.info.validated_ledger.seq,
			baseFeeXRP: result.info.validated_ledger.base_fee_xrp,
			serverState: result.info.server_state,
		};
	}

	/** Parse a raw XRPL offer into a price/quantity entry */
	private parseOffer(
		offer: XRPLOffer,
		side: "bid" | "ask",
		base: XRPLCurrency,
	): XRPLBookEntry {
		const gets = this.parseAmount(offer.TakerGets);
		const pays = this.parseAmount(offer.TakerPays);

		let price: number;
		let quantity: number;

		if (side === "ask") {
			// Selling base for quote: price = pays/gets
			quantity = gets.value;
			price = quantity > 0 ? pays.value / quantity : 0;
		} else {
			// Buying base with quote: price = gets/pays
			quantity = pays.value;
			price = quantity > 0 ? gets.value / quantity : 0;
		}

		return { price, quantity, account: offer.Account };
	}

	/** Parse an XRPL amount (drops string for XRP, or {currency, value, issuer} for tokens) */
	private parseAmount(amount: string | XRPLAmount): { currency: string; value: number } {
		if (typeof amount === "string") {
			// XRP in drops
			return { currency: "XRP", value: Number(amount) / 1_000_000 };
		}
		return { currency: amount.currency, value: Number(amount.value) };
	}
}
