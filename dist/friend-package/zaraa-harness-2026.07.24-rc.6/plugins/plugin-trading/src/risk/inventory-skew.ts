const DEFAULT_MAX_QUOTE_SKEW_BPS = 50;
const DEFAULT_HEDGE_THRESHOLD_PCT = 0.5;
const DEFAULT_DEADBAND_PCT = 0.02;
const MAX_SIZE_MULTIPLIER = 2;

export interface InventorySkewInput {
	symbol: string;
	inventoryUnits: number;
	targetUnits: number;
	maxInventoryUnits: number;
	midPrice: number;
	baseQuoteSizeUsd: number;
	maxQuoteSkewBps?: number;
	hedgeThresholdPct?: number;
	deadbandPct?: number;
}

export interface InventoryHedgeRecommendation {
	symbol: string;
	side: "buy" | "sell";
	units: number;
	notionalUsd: number;
	reason: string;
}

export interface InventorySkewResult {
	symbol: string;
	inventoryPressure: number;
	reservationPriceShiftBps: number;
	bidPriceAdjustmentBps: number;
	askPriceAdjustmentBps: number;
	maxBidSizeUsd: number;
	maxAskSizeUsd: number;
	blockBid: boolean;
	blockAsk: boolean;
	hedge: InventoryHedgeRecommendation | null;
}

export function evaluateInventorySkew(input: InventorySkewInput): InventorySkewResult | null {
	if (!isValidInput(input)) return null;

	const maxQuoteSkewBps = input.maxQuoteSkewBps ?? DEFAULT_MAX_QUOTE_SKEW_BPS;
	const hedgeThresholdPct = input.hedgeThresholdPct ?? DEFAULT_HEDGE_THRESHOLD_PCT;
	const deadbandPct = input.deadbandPct ?? DEFAULT_DEADBAND_PCT;
	const rawDeviation = input.inventoryUnits - input.targetUnits;
	const deadbandUnits = input.maxInventoryUnits * deadbandPct;
	const deviationUnits = Math.abs(rawDeviation) <= deadbandUnits ? 0 : rawDeviation;
	const inventoryPressure = clamp(deviationUnits / input.maxInventoryUnits, -1, 1);
	const absPressure = Math.abs(inventoryPressure);
	const reservationPriceShiftBps = normalizeZero(-inventoryPressure * maxQuoteSkewBps);

	const bidScale = clamp(1 - inventoryPressure, 0, MAX_SIZE_MULTIPLIER);
	const askScale = clamp(1 + inventoryPressure, 0, MAX_SIZE_MULTIPLIER);
	const maxBidSizeUsd = round(input.baseQuoteSizeUsd * bidScale, 8);
	const maxAskSizeUsd = round(input.baseQuoteSizeUsd * askScale, 8);

	const blockBid = inventoryPressure >= 1;
	const blockAsk = inventoryPressure <= -1;
	const hedge = absPressure >= hedgeThresholdPct && deviationUnits !== 0
		? buildHedge(input.symbol, deviationUnits, inventoryPressure, input.midPrice, hedgeThresholdPct)
		: null;

	return {
		symbol: input.symbol,
		inventoryPressure,
		reservationPriceShiftBps,
		bidPriceAdjustmentBps: reservationPriceShiftBps,
		askPriceAdjustmentBps: reservationPriceShiftBps,
		maxBidSizeUsd,
		maxAskSizeUsd,
		blockBid,
		blockAsk,
		hedge,
	};
}

function buildHedge(
	symbol: string,
	deviationUnits: number,
	inventoryPressure: number,
	midPrice: number,
	hedgeThresholdPct: number,
): InventoryHedgeRecommendation {
	const units = round(Math.abs(deviationUnits), 8);
	return {
		symbol,
		side: deviationUnits > 0 ? "sell" : "buy",
		units,
		notionalUsd: round(units * midPrice, 8),
		reason: `inventory pressure ${(inventoryPressure * 100).toFixed(2)}% exceeds hedge threshold ${(hedgeThresholdPct * 100).toFixed(2)}%`,
	};
}

function isValidInput(input: InventorySkewInput): boolean {
	if (!input || typeof input.symbol !== "string" || input.symbol.trim() === "") return false;
	if (!isFiniteNumber(input.inventoryUnits) || !isFiniteNumber(input.targetUnits)) return false;
	if (!isPositiveFinite(input.maxInventoryUnits) || !isPositiveFinite(input.midPrice)) return false;
	if (!isNonNegativeFinite(input.baseQuoteSizeUsd)) return false;
	if (input.baseQuoteSizeUsd === 0) return false;
	if (input.maxQuoteSkewBps != null && !isNonNegativeFinite(input.maxQuoteSkewBps)) return false;
	if (input.hedgeThresholdPct != null && !isPctOpenClosed(input.hedgeThresholdPct)) return false;
	if (input.deadbandPct != null && !isPctOpenClosed(input.deadbandPct)) return false;
	const worstNotional = Math.max(Math.abs(input.inventoryUnits), Math.abs(input.targetUnits)) * input.midPrice;
	return Number.isFinite(worstNotional);
}

function isFiniteNumber(value: number): boolean {
	return Number.isFinite(value);
}

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function isPctOpenClosed(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value < 1;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

function normalizeZero(value: number): number {
	return Object.is(value, -0) ? 0 : value;
}
