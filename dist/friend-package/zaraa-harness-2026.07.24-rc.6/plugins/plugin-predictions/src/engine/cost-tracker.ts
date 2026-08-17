/**
 * Forecast Cost Tracker — Track per-forecast costs and compute cost efficiency.
 *
 * Cycle 005 addition:
 * - Records input/output token counts and cost per model call
 * - Computes cost per dollar of expected value (cost/EV ratio)
 * - Identifies categories and markets where forecasting is cost-inefficient
 * - Enables tiered model routing optimization decisions
 *
 * Key metric: Cost Per Dollar of Expected Value
 * - If a forecast costs $0.05 and identifies $2.00 of EV, ratio = 0.025 (excellent)
 * - If a forecast costs $0.05 and identifies $0.01 of EV, ratio = 5.0 (terrible)
 * - Markets with consistently poor ratios should use cheaper models or be skipped
 */

export interface ModelCallCost {
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface ForecastCostRecord {
	marketId: string;
	category: string;
	models: ModelCallCost[];
	totalCostUsd: number;
	/** Was this forecast actionable (generated a +EV signal)? */
	resultedInTrade: boolean;
	/** Expected value of the signal (0 if no signal) */
	expectedValue: number;
	/** Cost per dollar of expected value (Infinity if no EV, lower is better) */
	costPerDollarEV: number;
	timestamp: number;
}

export interface CostSummary {
	totalForecasts: number;
	totalCostUsd: number;
	avgCostPerForecast: number;
	actionableForecasts: number;
	actionableRate: number;
	avgCostPerActionableForecast: number;
	avgCostPerDollarEV: number;
	costByCategory: Record<string, { count: number; totalCost: number; avgCostPerDollarEV: number }>;
	costByModel: Record<string, { calls: number; totalCost: number; totalTokens: number }>;
}

/**
 * Model pricing table (per million tokens, standard API rates as of March 2026).
 * Used to estimate costs when actual billing data is unavailable.
 */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
	"claude-opus-4-6": { inputPerMTok: 5.00, outputPerMTok: 25.00 },
	"claude-opus-4.5": { inputPerMTok: 5.00, outputPerMTok: 25.00 },
	"claude-sonnet-4.6": { inputPerMTok: 3.00, outputPerMTok: 15.00 },
	"claude-haiku-4.5": { inputPerMTok: 1.00, outputPerMTok: 5.00 },
	"gpt-4o": { inputPerMTok: 2.50, outputPerMTok: 10.00 },
	"gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.60 },
	"gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10.00 },
	// Local models are free
	"ollama": { inputPerMTok: 0, outputPerMTok: 0 },
};

/**
 * Estimate cost of a model call based on token counts and pricing table.
 *
 * @param model - Model name (matched against MODEL_PRICING keys)
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param batchDiscount - Whether batch API pricing applies (50% off)
 * @returns Estimated cost in USD
 */
export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	batchDiscount = false,
): number {
	// Find matching pricing (prefix match for flexibility)
	let pricing = MODEL_PRICING.ollama; // default to free for unknown/local
	for (const [key, value] of Object.entries(MODEL_PRICING)) {
		if (model.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(model.toLowerCase())) {
			pricing = value;
			break;
		}
	}

	const multiplier = batchDiscount ? 0.5 : 1.0;
	const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok * multiplier;
	const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok * multiplier;

	return Math.round((inputCost + outputCost) * 100000) / 100000;
}

export class ForecastCostTracker {
	private records: ForecastCostRecord[] = [];

	/**
	 * Record the cost of a forecast operation.
	 */
	record(
		marketId: string,
		category: string,
		models: ModelCallCost[],
		resultedInTrade: boolean,
		expectedValue: number,
	): ForecastCostRecord {
		const totalCostUsd = models.reduce((sum, m) => sum + m.costUsd, 0);
		const costPerDollarEV = expectedValue > 0
			? Math.round((totalCostUsd / expectedValue) * 10000) / 10000
			: totalCostUsd > 0 ? Infinity : 0;

		const record: ForecastCostRecord = {
			marketId,
			category,
			models,
			totalCostUsd: Math.round(totalCostUsd * 100000) / 100000,
			resultedInTrade,
			expectedValue,
			costPerDollarEV,
			timestamp: Date.now(),
		};

		this.records.push(record);
		return record;
	}

	/**
	 * Get a summary of all recorded forecast costs.
	 */
	getSummary(): CostSummary {
		if (this.records.length === 0) {
			return {
				totalForecasts: 0,
				totalCostUsd: 0,
				avgCostPerForecast: 0,
				actionableForecasts: 0,
				actionableRate: 0,
				avgCostPerActionableForecast: 0,
				avgCostPerDollarEV: 0,
				costByCategory: {},
				costByModel: {},
			};
		}

		const totalCostUsd = this.records.reduce((s, r) => s + r.totalCostUsd, 0);
		const actionable = this.records.filter((r) => r.resultedInTrade);
		const actionableCost = actionable.reduce((s, r) => s + r.totalCostUsd, 0);
		const finiteEVRecords = actionable.filter((r) => r.costPerDollarEV !== Infinity && r.costPerDollarEV > 0);
		const avgCostPerDollarEV = finiteEVRecords.length > 0
			? finiteEVRecords.reduce((s, r) => s + r.costPerDollarEV, 0) / finiteEVRecords.length
			: 0;

		// Cost by category
		const costByCategory: Record<string, { count: number; totalCost: number; avgCostPerDollarEV: number }> = {};
		for (const r of this.records) {
			if (!costByCategory[r.category]) {
				costByCategory[r.category] = { count: 0, totalCost: 0, avgCostPerDollarEV: 0 };
			}
			costByCategory[r.category].count++;
			costByCategory[r.category].totalCost += r.totalCostUsd;
		}
		for (const cat of Object.keys(costByCategory)) {
			const catRecords = this.records.filter(
				(r) => r.category === cat && r.resultedInTrade && r.costPerDollarEV !== Infinity && r.costPerDollarEV > 0,
			);
			costByCategory[cat].avgCostPerDollarEV = catRecords.length > 0
				? catRecords.reduce((s, r) => s + r.costPerDollarEV, 0) / catRecords.length
				: 0;
			costByCategory[cat].totalCost = Math.round(costByCategory[cat].totalCost * 100000) / 100000;
		}

		// Cost by model
		const costByModel: Record<string, { calls: number; totalCost: number; totalTokens: number }> = {};
		for (const r of this.records) {
			for (const m of r.models) {
				if (!costByModel[m.model]) {
					costByModel[m.model] = { calls: 0, totalCost: 0, totalTokens: 0 };
				}
				costByModel[m.model].calls++;
				costByModel[m.model].totalCost += m.costUsd;
				costByModel[m.model].totalTokens += m.inputTokens + m.outputTokens;
			}
		}
		for (const model of Object.keys(costByModel)) {
			costByModel[model].totalCost = Math.round(costByModel[model].totalCost * 100000) / 100000;
		}

		return {
			totalForecasts: this.records.length,
			totalCostUsd: Math.round(totalCostUsd * 100000) / 100000,
			avgCostPerForecast: Math.round((totalCostUsd / this.records.length) * 100000) / 100000,
			actionableForecasts: actionable.length,
			actionableRate: Math.round((actionable.length / this.records.length) * 100) / 100,
			avgCostPerActionableForecast: actionable.length > 0
				? Math.round((actionableCost / actionable.length) * 100000) / 100000
				: 0,
			avgCostPerDollarEV: Math.round(avgCostPerDollarEV * 10000) / 10000,
			costByCategory,
			costByModel,
		};
	}

	/**
	 * Get all records (for export/analysis).
	 */
	getRecords(): ForecastCostRecord[] {
		return [...this.records];
	}

	/**
	 * Get the number of recorded forecasts.
	 */
	get count(): number {
		return this.records.length;
	}

	/**
	 * Clear all records (for testing or periodic reset).
	 */
	clear(): void {
		this.records = [];
	}

	/**
	 * Get the worst cost/EV categories (candidates for cheaper model routing).
	 *
	 * @param threshold - Categories with avgCostPerDollarEV above this are "wasteful"
	 * @returns Categories sorted by worst cost efficiency first
	 */
	getWastefulCategories(threshold = 1.0): Array<{ category: string; avgCostPerDollarEV: number; count: number }> {
		const summary = this.getSummary();
		return Object.entries(summary.costByCategory)
			.filter(([_, data]) => data.avgCostPerDollarEV > threshold)
			.map(([category, data]) => ({
				category,
				avgCostPerDollarEV: data.avgCostPerDollarEV,
				count: data.count,
			}))
			.sort((a, b) => b.avgCostPerDollarEV - a.avgCostPerDollarEV);
	}
}
