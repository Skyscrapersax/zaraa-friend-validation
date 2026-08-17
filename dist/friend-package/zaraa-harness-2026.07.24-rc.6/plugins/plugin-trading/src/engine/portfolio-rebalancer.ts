/**
 * Portfolio rebalancing engine.
 *
 * Connects the read-only portfolio analyzers (portfolio-allocator, allocation-optimizer)
 * to actionable trade execution via trade_buy / trade_sell handlers.
 *
 * Flow:
 *   1. computeRebalancePlan() — pure calculation, no side-effects
 *   2. executeRebalancePlan() — runs sells first (to free capital), then buys
 *
 * All trades go through the normal handler pipeline which enforces:
 *   - max_trade_usd per-trade cap
 *   - daily_limit_usd daily cap
 *   - risk manager validation
 *   - circuit breaker checks
 *   - paper/live mode
 */

import { z } from "zod";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface RebalanceConfig {
	/** Target allocation weights, symbol → fraction (must sum to ~1). e.g. {"BTC_USDT": 0.5, "ETH_USDT": 0.3, "SOL_USDT": 0.2} */
	targetAllocations: Record<string, number>;
	/** Only rebalance when total portfolio drift exceeds this % (default 5) */
	driftThresholdPct: number;
	/** Cap each rebalance trade at this % of total portfolio value (default 10) */
	maxTradePerRebalancePct: number;
	/** Whether automatic rebalancing is enabled */
	enabled: boolean;
}

export interface RebalanceTrade {
	symbol: string;
	direction: "buy" | "sell";
	amountUsd: number;
	reason: string;
}

export interface RebalancePlan {
	trades: RebalanceTrade[];
	currentAllocations: Record<string, number>;
	targetAllocations: Record<string, number>;
	totalDriftPct: number;
	totalPortfolioValueUsd: number;
	needsRebalance: boolean;
}

export interface RebalanceExecutionResult {
	plan: RebalancePlan;
	executed: Array<{
		symbol: string;
		direction: "buy" | "sell";
		requestedAmountUsd: number;
		success: boolean;
		resultJson?: string;
		error?: string;
	}>;
	summary: {
		totalTradesAttempted: number;
		totalTradesSucceeded: number;
		totalTradesFailed: number;
		totalSellsUsd: number;
		totalBuysUsd: number;
	};
}

export interface PositionSnapshot {
	symbol: string;
	/** Current market value in USD */
	valueUsd: number;
	/** Quantity held */
	qty: number;
	/** Current price per unit */
	currentPrice: number;
}

/** Handler functions used to execute trades */
export interface RebalanceHandlers {
	trade_buy: (args: Record<string, unknown>) => Promise<string>;
	trade_sell: (args: Record<string, unknown>) => Promise<string>;
}

// ── Zod schemas for handler input validation ──────────────────────────────────

export const RebalanceConfigureInputSchema = z.object({
	target_allocations: z.record(z.string(), z.number().min(0).max(1)),
	drift_threshold_pct: z.number().min(0.1).max(50).optional().default(5),
	max_trade_per_rebalance_pct: z.number().min(1).max(100).optional().default(10),
	enabled: z.boolean().optional().default(true),
});

// ── Settings persistence keys ─────────────────────────────────────────────────

export const REBALANCE_CONFIG_KEY = "rebalance_config";

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Compute a rebalance plan given config, current positions, and prices.
 * Pure function with no side-effects.
 */
export function computeRebalancePlan(
	config: RebalanceConfig,
	positions: PositionSnapshot[],
	cashUsd: number,
): RebalancePlan {
	const totalValue = positions.reduce((sum, p) => sum + p.valueUsd, 0) + cashUsd;

	if (totalValue <= 0) {
		return {
			trades: [],
			currentAllocations: {},
			targetAllocations: config.targetAllocations,
			totalDriftPct: 0,
			totalPortfolioValueUsd: 0,
			needsRebalance: false,
		};
	}

	// Compute current allocation weights
	const currentAllocations: Record<string, number> = {};
	for (const pos of positions) {
		currentAllocations[pos.symbol] = pos.valueUsd / totalValue;
	}

	// Compute drift per symbol
	const allSymbols = new Set([
		...Object.keys(config.targetAllocations),
		...Object.keys(currentAllocations),
	]);

	let totalDriftPct = 0;
	const trades: RebalanceTrade[] = [];

	for (const symbol of allSymbols) {
		const target = config.targetAllocations[symbol] ?? 0;
		const current = currentAllocations[symbol] ?? 0;
		const driftPct = Math.abs(current - target) * 100;
		totalDriftPct += driftPct;

		const diffUsd = (target - current) * totalValue;
		const maxTradeUsd = (config.maxTradePerRebalancePct / 100) * totalValue;
		const cappedAmountUsd = Math.min(Math.abs(diffUsd), maxTradeUsd);

		// Only generate a trade if the individual drift is meaningful (> 0.5%)
		if (driftPct < 0.5 || cappedAmountUsd < 1) continue;

		if (diffUsd > 0) {
			trades.push({
				symbol,
				direction: "buy",
				amountUsd: round2(cappedAmountUsd),
				reason: `Underweight: current ${(current * 100).toFixed(1)}% vs target ${(target * 100).toFixed(1)}% (drift ${driftPct.toFixed(1)}%)`,
			});
		} else {
			trades.push({
				symbol,
				direction: "sell",
				amountUsd: round2(cappedAmountUsd),
				reason: `Overweight: current ${(current * 100).toFixed(1)}% vs target ${(target * 100).toFixed(1)}% (drift ${driftPct.toFixed(1)}%)`,
			});
		}
	}

	// Sort: sells first (to free up capital), then buys
	trades.sort((a, b) => {
		if (a.direction === "sell" && b.direction === "buy") return -1;
		if (a.direction === "buy" && b.direction === "sell") return 1;
		// Within same direction, larger trades first
		return b.amountUsd - a.amountUsd;
	});

	const needsRebalance = totalDriftPct > config.driftThresholdPct;

	return {
		trades: needsRebalance ? trades : [],
		currentAllocations,
		targetAllocations: config.targetAllocations,
		totalDriftPct: round2(totalDriftPct),
		totalPortfolioValueUsd: round2(totalValue),
		needsRebalance,
	};
}

/**
 * Execute a rebalance plan by calling trade_buy / trade_sell handlers.
 * Sells are executed first to free up capital for buys.
 */
export async function executeRebalancePlan(
	plan: RebalancePlan,
	handlers: RebalanceHandlers,
	prices: Record<string, number>,
): Promise<RebalanceExecutionResult> {
	const executed: RebalanceExecutionResult["executed"] = [];
	let totalSellsUsd = 0;
	let totalBuysUsd = 0;

	for (const trade of plan.trades) {
		const price = prices[trade.symbol];
		if (!price || price <= 0) {
			executed.push({
				symbol: trade.symbol,
				direction: trade.direction,
				requestedAmountUsd: trade.amountUsd,
				success: false,
				error: `No valid price available for ${trade.symbol}`,
			});
			continue;
		}

		const qty = trade.amountUsd / price;

		try {
			let resultJson: string;
			if (trade.direction === "sell") {
				resultJson = await handlers.trade_sell({
					symbol: trade.symbol,
					qty,
					type: "MARKET",
				});
				const parsed = JSON.parse(resultJson);
				if (parsed.error) {
					executed.push({
						symbol: trade.symbol,
						direction: trade.direction,
						requestedAmountUsd: trade.amountUsd,
						success: false,
						resultJson,
						error: parsed.error,
					});
				} else {
					totalSellsUsd += trade.amountUsd;
					executed.push({
						symbol: trade.symbol,
						direction: trade.direction,
						requestedAmountUsd: trade.amountUsd,
						success: true,
						resultJson,
					});
				}
			} else {
				resultJson = await handlers.trade_buy({
					symbol: trade.symbol,
					qty,
					type: "MARKET",
				});
				const parsed = JSON.parse(resultJson);
				if (parsed.error) {
					executed.push({
						symbol: trade.symbol,
						direction: trade.direction,
						requestedAmountUsd: trade.amountUsd,
						success: false,
						resultJson,
						error: parsed.error,
					});
				} else {
					totalBuysUsd += trade.amountUsd;
					executed.push({
						symbol: trade.symbol,
						direction: trade.direction,
						requestedAmountUsd: trade.amountUsd,
						success: true,
						resultJson,
					});
				}
			}
		} catch (err) {
			executed.push({
				symbol: trade.symbol,
				direction: trade.direction,
				requestedAmountUsd: trade.amountUsd,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const succeeded = executed.filter((e) => e.success).length;
	const failed = executed.filter((e) => !e.success).length;

	return {
		plan,
		executed,
		summary: {
			totalTradesAttempted: executed.length,
			totalTradesSucceeded: succeeded,
			totalTradesFailed: failed,
			totalSellsUsd: round2(totalSellsUsd),
			totalBuysUsd: round2(totalBuysUsd),
		},
	};
}

/**
 * Load saved RebalanceConfig from the trading store.
 * Returns null if not configured.
 */
export function loadRebalanceConfig(
	getSetting: (key: string) => string | undefined,
): RebalanceConfig | null {
	const raw = getSetting(REBALANCE_CONFIG_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as RebalanceConfig;
	} catch {
		return null;
	}
}

/**
 * Save RebalanceConfig to the trading store.
 */
export function saveRebalanceConfig(
	setSetting: (key: string, value: string) => void,
	config: RebalanceConfig,
): void {
	setSetting(REBALANCE_CONFIG_KEY, JSON.stringify(config));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
