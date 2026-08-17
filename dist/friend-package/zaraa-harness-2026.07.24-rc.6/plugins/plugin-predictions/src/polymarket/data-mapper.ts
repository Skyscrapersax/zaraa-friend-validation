/**
 * PolymarketDataMapper — Converts Polymarket Gamma API responses to internal PredictionMarket type.
 *
 * Cycle 009: Bridge between raw Polymarket API data and ScanPipeline input.
 *
 * The Gamma API returns markets with fields like outcomePrices (JSON string array),
 * conditionId, clobTokenIds, etc. This mapper normalizes them to our PredictionMarket
 * type with consistent number fields, proper status mapping, and category classification.
 */
import { z } from "zod";
import type { PredictionMarket, MarketStatus } from "../types.js";
import { classifyCategory } from "../engine/market-scanner.js";

// ── Zod schema for Gamma API market validation ──
const GammaMarketSchema = z.object({
	condition_id: z.string().min(1).optional(),
	conditionId: z.string().min(1).optional(),
	question: z.string().min(1),
	slug: z.string().default(""),
	category: z.string().optional(),
	outcomePrices: z.union([z.string(), z.array(z.string())]),
	outcomes: z.union([z.string(), z.array(z.string())]),
	volume: z.union([z.string(), z.number()]).optional(),
	volume24hr: z.union([z.string(), z.number()]).optional(),
	liquidity: z.union([z.string(), z.number()]),
	end_date_iso: z.string().optional(),
	endDate: z.string().optional(),
	active: z.boolean(),
	closed: z.boolean(),
	created_at: z.string().optional(),
	createdAt: z.string().optional(),
	updated_at: z.string().optional(),
	updatedAt: z.string().optional(),
	clob_token_ids: z.union([z.string(), z.array(z.string())]).optional(),
	clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
	description: z.string().optional(),
	new: z.boolean().optional(),
	image: z.string().optional(),
}).passthrough().refine(
	(market) => Boolean(market.condition_id || market.conditionId),
	"condition_id or conditionId is required",
);

// ── Gamma API Response Types ──

/** Raw market object from Polymarket Gamma API */
export interface GammaMarket {
	/** Condition ID (unique market identifier) */
	condition_id?: string;
	conditionId?: string;
	/** The question being predicted */
	question: string;
	/** URL slug */
	slug: string;
	/** Market category (may be empty) */
	category?: string;
	/** Outcome prices as JSON string array, e.g. '["0.55","0.45"]' or already parsed */
	outcomePrices: string | string[];
	/** Outcomes as JSON string array, e.g. '["Yes","No"]' */
	outcomes: string | string[];
	/** Total volume (string or number) */
	volume?: string | number;
	/** 24-hour volume (may not always be present) */
	volume24hr?: string | number;
	/** Liquidity in USD */
	liquidity: string | number;
	/** When the market resolves/expires (ISO string) */
	end_date_iso?: string;
	endDate?: string;
	/** Whether the market is active */
	active: boolean;
	/** Whether the market is closed */
	closed: boolean;
	/** When market was created (ISO string) */
	created_at?: string;
	createdAt?: string;
	/** Last update (ISO string) */
	updated_at?: string;
	updatedAt?: string;
	/** CLOB token IDs for YES and NO outcomes */
	clob_token_ids?: string | string[];
	clobTokenIds?: string | string[];
	/** Description of the market */
	description?: string;
	/** Whether this is a new market */
	new?: boolean;
	/** Market image */
	image?: string;
}

/** Orderbook data from CLOB API */
export interface CLOBOrderBook {
	bids: Array<{ price: string; size: string }>;
	asks: Array<{ price: string; size: string }>;
}

// ── Mapper ──

/**
 * Parse a value that might be a JSON string array or already an array.
 */
function parseStringArray(val: string | string[] | undefined): string[] {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	try {
		const parsed = JSON.parse(val);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		console.debug("[predictions] parseStringArray failed:", err instanceof Error ? err.message : err);
		return [];
	}
}

/**
 * Parse a numeric value that might be string or number.
 * Warns when a non-empty value cannot be parsed to a finite number.
 */
function parseNum(val: string | number | undefined, fallback = 0, fieldName = "unknown"): number {
	if (val === undefined || val === null || val === "") return fallback;
	const n = typeof val === "number" ? val : Number(val);
	if (!Number.isFinite(n)) {
		console.warn(`[predictions] parseNum: non-finite value for field "${fieldName}": raw=${JSON.stringify(val)}, using fallback=${fallback}`);
		return fallback;
	}
	return n;
}

export function getConditionId(gamma: Pick<GammaMarket, "condition_id" | "conditionId">): string {
	return gamma.condition_id || gamma.conditionId || "";
}

function getExpiryIso(gamma: Pick<GammaMarket, "end_date_iso" | "endDate">): string | undefined {
	return gamma.end_date_iso || gamma.endDate;
}

function getCreatedAt(gamma: Pick<GammaMarket, "created_at" | "createdAt">): string | undefined {
	return gamma.created_at || gamma.createdAt;
}

function getUpdatedAt(gamma: Pick<GammaMarket, "updated_at" | "updatedAt">): string | undefined {
	return gamma.updated_at || gamma.updatedAt;
}

function getClobTokenIds(gamma: Pick<GammaMarket, "clob_token_ids" | "clobTokenIds">): string | string[] | undefined {
	return gamma.clob_token_ids ?? gamma.clobTokenIds;
}

/**
 * Map Gamma API market status to internal MarketStatus.
 */
function mapStatus(gamma: GammaMarket): MarketStatus {
	if (gamma.closed) return "closed";
	if (gamma.active) return "open";
	return "closed";
}

/**
 * Convert a single Gamma API market to our internal PredictionMarket format.
 *
 * @param gamma - Raw Gamma API market object
 * @param book - Optional CLOB orderbook for bid/ask data
 */
export function toInternalMarket(gamma: GammaMarket, book?: CLOBOrderBook): PredictionMarket {
	const outcomePrices = parseStringArray(gamma.outcomePrices);
	const yesPrice = parseNum(outcomePrices[0], 0.5);
	const noPrice = parseNum(outcomePrices[1], 1 - yesPrice);

	// Best bid/ask from orderbook (or estimate from price)
	let yesBid: number;
	let yesAsk: number;

	if (book && book.bids.length > 0 && book.asks.length > 0) {
		yesBid = parseNum(book.bids[0].price, yesPrice - 0.01);
		yesAsk = parseNum(book.asks[0].price, yesPrice + 0.01);
	} else {
		// Estimate: tight spread around price for liquid markets, wider for thin
		const liquidity = parseNum(gamma.liquidity);
		const spreadEstimate = liquidity > 10000 ? 0.01 : liquidity > 1000 ? 0.03 : 0.05;
		yesBid = Math.max(0.01, yesPrice - spreadEstimate / 2);
		yesAsk = Math.min(0.99, yesPrice + spreadEstimate / 2);
	}

	// Category: use Gamma's if available, otherwise classify from question
	const rawCategory = gamma.category?.toLowerCase().trim() || "";
	const category = rawCategory && rawCategory !== "default" && rawCategory !== ""
		? rawCategory
		: classifyCategory(gamma.question);

	const totalVolume = parseNum(gamma.volume);
	const volume24h = parseNum(gamma.volume24hr, totalVolume * 0.05); // Estimate 5% of total if missing
	const outcomeTokenIds = extractTokenIds(gamma);

	return {
		id: getConditionId(gamma),
		exchange: "polymarket",
		question: gamma.question,
		slug: gamma.slug || "",
		category,
		yesPrice,
		noPrice,
		yesBid,
		yesAsk,
		volume24h,
		totalVolume,
		liquidity: parseNum(gamma.liquidity),
		expiresAt: getExpiryIso(gamma) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
		status: mapStatus(gamma),
		createdAt: getCreatedAt(gamma),
		updatedAt: getUpdatedAt(gamma) || new Date().toISOString(),
		outcomeTokenIds,
	};
}

/**
 * Convert a batch of Gamma API markets to internal format.
 *
 * @param gammaMarkets - Array of raw Gamma API market objects
 * @param books - Optional map of condition ID -> CLOB orderbook
 */
export function toInternalBatch(
	gammaMarkets: GammaMarket[],
	books?: Map<string, CLOBOrderBook>,
): PredictionMarket[] {
	const results: PredictionMarket[] = [];
	for (const raw of gammaMarkets) {
		const parsed = GammaMarketSchema.safeParse(raw);
		if (!parsed.success) {
			console.warn("[predictions] invalid Gamma market skipped:", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "));
			continue;
		}
		const gamma = parsed.data as GammaMarket;
		const book = books?.get(getConditionId(gamma));
		results.push(toInternalMarket(gamma, book));
	}
	return results;
}

/**
 * Extract CLOB token IDs from a Gamma market.
 * Token ID for the YES outcome is needed for orderbook/price queries.
 */
export function extractTokenIds(gamma: GammaMarket): { yes: string | null; no: string | null } {
	const ids = parseStringArray(getClobTokenIds(gamma));
	return {
		yes: ids[0] || null,
		no: ids[1] || null,
	};
}
