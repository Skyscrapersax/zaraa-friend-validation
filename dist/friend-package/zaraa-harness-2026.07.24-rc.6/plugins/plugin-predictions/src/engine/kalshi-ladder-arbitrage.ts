import type { KalshiMarket } from "../kalshi/kalshi-client.js";

const DEFAULT_CONTRACTS = 100;
const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_KALSHI_TAKER_COEFFICIENT = 0.07;
const DEFAULT_KALSHI_MAKER_COEFFICIENT = 0.0175;
const INDEX_TAKER_COEFFICIENT = 0.035;
const INDEX_MAKER_COEFFICIENT = 0.00875;

export interface KalshiFeeInput {
	contracts: number;
	price: number;
	coefficient?: number;
}

export interface KalshiLadderArbitrageOptions {
	contracts?: number;
	feeMode?: "maker" | "taker";
	minNetProfitUsd?: number;
	maxResults?: number;
}

export interface KalshiLadderArbitrageOpportunity {
	exchange: "kalshi";
	strategyName: "kalshi_monotone_ladder";
	executionMode: "maker" | "taker";
	eventTicker: string;
	groupKey: string;
	buyYesTicker: string;
	buyYesPrice: number;
	buyNoTicker: string;
	buyNoPrice: number;
	lowerStrike: number;
	higherStrike: number;
	contracts: number;
	grossCostUsd: number;
	guaranteedPayoutUsd: number;
	grossProfitUsd: number;
	yesFeeUsd: number;
	noFeeUsd: number;
	totalFeesUsd: number;
	netProfitUsd: number;
	netReturnOnCost: number;
	maxContractsByAskSize: number | null;
	lowerQuestion: string;
	higherQuestion: string;
	ruleSnapshot: {
		lower: string | null;
		higher: string | null;
	};
	paperOnly: true;
	warning: string;
	proofNotes: string;
}

interface LadderMarket {
	raw: KalshiMarket;
	ticker: string;
	eventTicker: string;
	label: string;
	template: string;
	strike: number;
	yesAsk: number;
	noAsk: number;
	yesAskSize: number | null;
	noAskSize: number | null;
	groupKey: string;
}

export function calculateKalshiFee(input: KalshiFeeInput): number {
	const contracts = Math.max(0, input.contracts);
	const price = clamp01(input.price);
	const coefficient = input.coefficient ?? DEFAULT_KALSHI_TAKER_COEFFICIENT;
	if (contracts <= 0 || price <= 0 || price >= 1 || coefficient <= 0) return 0;
	return round2(Math.ceil((coefficient * contracts * price * (1 - price)) * 100 - 1e-9) / 100);
}

export function findKalshiLadderArbitrage(
	markets: KalshiMarket[],
	options: KalshiLadderArbitrageOptions = {},
): KalshiLadderArbitrageOpportunity[] {
	const contracts = Math.max(1, Math.floor(options.contracts ?? DEFAULT_CONTRACTS));
	const feeMode = options.feeMode ?? "taker";
	const minNetProfitUsd = options.minNetProfitUsd ?? 0;
	const maxResults = Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS));
	const grouped = new Map<string, LadderMarket[]>();

	for (const market of markets) {
		const ladderMarket = toLadderMarket(market);
		if (!ladderMarket) continue;
		const group = grouped.get(ladderMarket.groupKey);
		if (group) group.push(ladderMarket);
		else grouped.set(ladderMarket.groupKey, [ladderMarket]);
	}

	const opportunities: KalshiLadderArbitrageOpportunity[] = [];
	for (const [groupKey, group] of grouped.entries()) {
		group.sort((a, b) => a.strike - b.strike || a.ticker.localeCompare(b.ticker));
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const opportunity = evaluatePair(groupKey, group[i], group[j], contracts, feeMode);
				if (opportunity && opportunity.netProfitUsd >= minNetProfitUsd) {
					opportunities.push(opportunity);
				}
			}
		}
	}

	return opportunities
		.sort((a, b) => b.netProfitUsd - a.netProfitUsd || b.netReturnOnCost - a.netReturnOnCost)
		.slice(0, maxResults);
}

function toLadderMarket(market: KalshiMarket): LadderMarket | null {
	const eventTicker = market.event_ticker ?? "";
	const ticker = market.ticker ?? "";
	const strike = parseNumber(market.floor_strike);
	const yesAsk = parseNumber(market.yes_ask_dollars);
	const noAsk = parseNumber(market.no_ask_dollars);
	const yesAskSize = parseNullableNumber(market.yes_ask_size_fp);
	const noAskSize = parseNullableNumber(market.no_ask_size_fp);
	const label = bestLabel(market);

	if (!eventTicker || !ticker || !Number.isFinite(strike)) return null;
	if (!isActionablePrice(yesAsk) || !isActionablePrice(noAsk)) return null;
	if (!isMonotoneAboveLabel(label)) return null;

	const template = normalizeTemplate(label);
	const customKey = normalizeCustomStrike(market.custom_strike);
	const groupKey = `${eventTicker}:${template}:${customKey}`;

	return {
		raw: market,
		ticker,
		eventTicker,
		label,
		template,
		strike,
		yesAsk,
		noAsk,
		yesAskSize,
		noAskSize,
		groupKey,
	};
}

function evaluatePair(
	groupKey: string,
	lower: LadderMarket,
	higher: LadderMarket,
	contracts: number,
	feeMode: "maker" | "taker",
): KalshiLadderArbitrageOpportunity | null {
	if (higher.strike <= lower.strike) return null;

	const grossCostUsd = round2((lower.yesAsk + higher.noAsk) * contracts);
	const guaranteedPayoutUsd = contracts;
	const grossProfitUsd = round2(guaranteedPayoutUsd - grossCostUsd);
	if (grossProfitUsd <= 0) return null;

	const yesFeeUsd = calculateKalshiFee({
		contracts,
		price: lower.yesAsk,
		coefficient: inferKalshiFeeCoefficient(lower.raw, feeMode),
	});
	const noFeeUsd = calculateKalshiFee({
		contracts,
		price: higher.noAsk,
		coefficient: inferKalshiFeeCoefficient(higher.raw, feeMode),
	});
	const totalFeesUsd = round2(yesFeeUsd + noFeeUsd);
	const netProfitUsd = round2(grossProfitUsd - totalFeesUsd);
	if (netProfitUsd <= 0) return null;

	return {
		exchange: "kalshi",
		strategyName: "kalshi_monotone_ladder",
		executionMode: feeMode,
		eventTicker: lower.eventTicker,
		groupKey,
		buyYesTicker: lower.ticker,
		buyYesPrice: lower.yesAsk,
		buyNoTicker: higher.ticker,
		buyNoPrice: higher.noAsk,
		lowerStrike: lower.strike,
		higherStrike: higher.strike,
		contracts,
		grossCostUsd,
		guaranteedPayoutUsd,
		grossProfitUsd,
		yesFeeUsd,
		noFeeUsd,
		totalFeesUsd,
		netProfitUsd,
		netReturnOnCost: grossCostUsd > 0 ? round4(netProfitUsd / grossCostUsd) : 0,
		maxContractsByAskSize: minNullable(lower.yesAskSize, higher.noAskSize),
		lowerQuestion: lower.raw.yes_sub_title ?? lower.raw.title,
		higherQuestion: higher.raw.yes_sub_title ?? higher.raw.title,
		ruleSnapshot: {
			lower: lower.raw.rules_primary ?? null,
			higher: higher.raw.rules_primary ?? null,
		},
		paperOnly: true,
		warning: "paper-only signal; do not place live trades from this scanner",
		proofNotes: feeMode === "maker"
			? "Monotone ladder guarantee if both legs fill: lower threshold YES plus higher threshold NO pays at least $1; maker mode requires both passive legs to fill."
			: "Monotone ladder guarantee: lower threshold YES plus higher threshold NO pays at least $1 across all settlement values.",
	};
}

function inferKalshiFeeCoefficient(market: KalshiMarket, feeMode: "maker" | "taker"): number {
	const ticker = market.ticker.toUpperCase();
	if (ticker.startsWith("INX") || ticker.startsWith("NASDAQ100")) {
		return feeMode === "maker" ? INDEX_MAKER_COEFFICIENT : INDEX_TAKER_COEFFICIENT;
	}
	return feeMode === "maker" ? DEFAULT_KALSHI_MAKER_COEFFICIENT : DEFAULT_KALSHI_TAKER_COEFFICIENT;
}

function bestLabel(market: KalshiMarket): string {
	return String(market.yes_sub_title || market.title || market.subtitle || "");
}

function isMonotoneAboveLabel(label: string): boolean {
	const normalized = label.toLowerCase();
	if (/\b(to|between|from|range)\b/.test(normalized)) return false;
	return /\b(above|over)\b\s*\$?\s*\d/.test(normalized)
		|| /\d+(?:\.\d+)?\s*(?:°|degrees?|runs?|points?)?\s+or\s+above\b/.test(normalized);
}

function normalizeTemplate(label: string): string {
	return label
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/\$?\d+(?:\.\d+)?/g, "#")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeCustomStrike(value: Record<string, unknown> | null | undefined): string {
	if (!value) return "{}";
	const entries = Object.entries(value)
		.filter(([key]) => !/floor|strike|value|threshold/i.test(key))
		.sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(Object.fromEntries(entries));
}

function parseNumber(value: string | number | null | undefined): number {
	if (value === undefined || value === null || value === "") return Number.NaN;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseNullableNumber(value: string | number | null | undefined): number | null {
	const parsed = parseNumber(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function isActionablePrice(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value < 1;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function minNullable(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}
