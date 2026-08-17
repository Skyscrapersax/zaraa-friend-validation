/**
 * Dollar-Cost Averaging (DCA) Strategy
 *
 * Automatically buys a fixed USD amount of specified crypto assets on a schedule
 * (hourly/daily/weekly), regardless of price. Optionally buys extra when price
 * dips below a moving average. Tracks average cost basis and performance.
 */
import { z } from "zod";
import { sma } from "../indicators/index.js";

// ── Zod Schemas ──

export const DCAIntervalSchema = z.enum(["hourly", "daily", "weekly"]);
export type DCAInterval = z.infer<typeof DCAIntervalSchema>;

export const DCAConfigSchema = z.object({
	symbol: z.string().min(1),
	amountUsd: z.number().positive(),
	interval: DCAIntervalSchema,
	dipBonusPct: z.number().min(0).max(100).optional(),
	dipBonusMultiplier: z.number().min(1).max(10).default(2),
	enabled: z.boolean().default(true),
});
export type DCAConfig = z.infer<typeof DCAConfigSchema>;

export const DCAConfigureInputSchema = z.object({
	pairs: z.array(DCAConfigSchema).min(1).max(20),
});
export const DCAStateSchema = z.object({
	symbol: z.string().min(1),
	totalInvestedUsd: z.number().finite().nonnegative(),
	totalQtyBought: z.number().finite().nonnegative(),
	avgCostBasis: z.number().finite().nonnegative(),
	lastBuyAt: z.string().nullable(),
	buyCount: z.number().int().nonnegative(),
});

export interface DCAState {
	symbol: string;
	totalInvestedUsd: number;
	totalQtyBought: number;
	avgCostBasis: number;
	lastBuyAt: string | null;
	buyCount: number;
}

// ── Interval helpers ──

const INTERVAL_MS: Record<DCAInterval, number> = {
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Check whether a DCA buy is due based on interval and last buy time.
 * Returns true if enough time has elapsed since the last buy (or if no buy
 * has happened yet).
 */
export function isDue(config: DCAConfig, state: DCAState, now?: Date): boolean {
	if (!config.enabled) return false;
	if (!state.lastBuyAt) return true;
	const last = new Date(state.lastBuyAt).getTime();
	const current = (now ?? new Date()).getTime();
	return current - last >= INTERVAL_MS[config.interval];
}
/**
 * Calculate the buy quantity for a DCA order.
 * If smaPrice is provided and the current price is dipBonusPct% below it,
 * the buy amount is multiplied by dipBonusMultiplier.
 */
export function calculateBuyAmount(
	config: DCAConfig,
	currentPrice: number,
	smaPrice?: number,
	maxTradeUsd?: number,
): { amountUsd: number; isDipBuy: boolean } {
	if (currentPrice <= 0) throw new Error("currentPrice must be positive");

	let amountUsd = config.amountUsd;
	let isDipBuy = false;

	if (
		smaPrice != null &&
		smaPrice > 0 &&
		config.dipBonusPct != null &&
		config.dipBonusPct > 0
	) {
		const threshold = smaPrice * (1 - config.dipBonusPct / 100);
		if (currentPrice < threshold) {
			amountUsd *= config.dipBonusMultiplier ?? 2;
			isDipBuy = true;
		}
	}

	// Clamp to max_trade_usd so dip bonus can never exceed the safety cap
	if (maxTradeUsd != null && maxTradeUsd > 0) {
		amountUsd = Math.min(amountUsd, maxTradeUsd);
	}

	return { amountUsd, isDipBuy };
}
/**
 * Update DCA state after a successful buy.
 * Returns a new state object (immutable).
 */
export function updateState(
	state: DCAState,
	boughtQty: number,
	spentUsd: number,
	buyTime?: Date,
): DCAState {
	const newTotalInvested = state.totalInvestedUsd + spentUsd;
	const newTotalQty = state.totalQtyBought + boughtQty;
	return {
		symbol: state.symbol,
		totalInvestedUsd: newTotalInvested,
		totalQtyBought: newTotalQty,
		avgCostBasis: newTotalQty > 0 ? newTotalInvested / newTotalQty : 0,
		lastBuyAt: (buyTime ?? new Date()).toISOString(),
		buyCount: state.buyCount + 1,
	};
}

/** Create a fresh DCA state for a symbol. */
export function emptyState(symbol: string): DCAState {
	return {
		symbol,
		totalInvestedUsd: 0,
		totalQtyBought: 0,
		avgCostBasis: 0,
		lastBuyAt: null,
		buyCount: 0,
	};
}
// ── Persistence helpers (use TradingStore.getSetting/setSetting) ──

const DCA_CONFIG_KEY = "dca_configs";
const DCA_STATE_PREFIX = "dca_state_";

export interface DCAStore {
	getSetting(key: string): string | undefined;
	setSetting(key: string, value: string): void;
}

/** Load all DCA configs from the store. */
export function loadConfigs(store: DCAStore): DCAConfig[] {
	const raw = store.getSetting(DCA_CONFIG_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return z.array(DCAConfigSchema).parse(parsed);
	} catch {
		return [];
	}
}

/** Save all DCA configs to the store. */
export function saveConfigs(store: DCAStore, configs: DCAConfig[]): void {
	store.setSetting(DCA_CONFIG_KEY, JSON.stringify(configs));
}

/** Load DCA state for a symbol. */
export function loadState(store: DCAStore, symbol: string): DCAState {
	const raw = store.getSetting(DCA_STATE_PREFIX + symbol);
	if (!raw) return emptyState(symbol);
	try {
		return DCAStateSchema.parse(JSON.parse(raw));
	} catch {
		return emptyState(symbol);
	}
}

/** Save DCA state for a symbol. */
export function saveState(store: DCAStore, state: DCAState): void {
	store.setSetting(DCA_STATE_PREFIX + state.symbol, JSON.stringify(state));
}

/**
 * Compute the SMA price from recent closing prices.
 * Uses a 20-period SMA by default — returns the latest value or undefined
 * when insufficient data is available.
 */
export function computeSmaPrice(
	closingPrices: number[],
	period = 20,
): number | undefined {
	const values = sma(closingPrices, period);
	return values.length > 0 ? values[values.length - 1] : undefined;
}
