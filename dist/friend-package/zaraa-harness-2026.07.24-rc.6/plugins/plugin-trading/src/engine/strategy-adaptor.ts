/**
 * StrategyAdaptor — Phase 2 Quant Swarm: Adaptive strategy weighting.
 *
 * Closes the feedback loop between trade outcomes and future signal confidence.
 * After each trade closes, the adaptor queries the leaderboard for recent
 * performance and computes per-strategy weight multipliers that modulate
 * signal confidence in the next evaluation cycle.
 *
 * Strategies that consistently profit get boosted. Strategies that consistently
 * lose get suppressed. The adaptation is gradual (EMA-smoothed) to avoid
 * whipsawing on a single bad trade.
 *
 * Design choices:
 * - Multipliers range [0.3, 1.5] — never fully disables a strategy (keeps
 *   exploration alive), never boosts more than 50% (prevents overconfidence).
 * - Uses EMA with alpha=0.3 — reacts to recent trades without forgetting history.
 * - Requires minimum 5 closed trades before adjusting (avoids noise from small samples).
 * - Integrates with existing SignalEngine via getStrategyWeight() lookup.
 */
import type Database from "better-sqlite3";
import type { LeaderboardStore, StrategyMetrics } from "../leaderboard/leaderboard-store.js";

export interface StrategyAdaptorConfig {
	/** Minimum closed trades before adapting a strategy's weight (default: 5) */
	minTrades: number;
	/** EMA smoothing factor for weight updates (default: 0.3, higher = more reactive) */
	alpha: number;
	/** Minimum weight multiplier — never fully suppress (default: 0.3) */
	minWeight: number;
	/** Maximum weight multiplier — never over-boost (default: 1.5) */
	maxWeight: number;
	/** Lookback period for performance evaluation (default: "30d") */
	period: "7d" | "30d" | "90d" | "all";
	/** Sharpe ratio threshold below which a strategy is penalized (default: 0) */
	sharpePenaltyThreshold: number;
	/** Max drawdown (as negative number) beyond which strategy is penalized (default: -50) */
	drawdownPenaltyThreshold: number;
}

const DEFAULT_CONFIG: StrategyAdaptorConfig = {
	minTrades: 5,
	alpha: 0.3,
	minWeight: 0.3,
	maxWeight: 1.5,
	period: "30d",
	sharpePenaltyThreshold: 0,
	drawdownPenaltyThreshold: -50,
};

export interface StrategyWeight {
	strategyName: string;
	weight: number;
	reason: string;
	metrics: {
		winRate: number;
		totalPnl: number;
		sharpeRatio: number;
		maxDrawdown: number;
		numTrades: number;
	};
}

export class StrategyAdaptor {
	private config: StrategyAdaptorConfig;
	private leaderboard: LeaderboardStore;
	/** EMA-smoothed weights per strategy (persisted across update cycles) */
	private weights = new Map<string, number>();
	/** Last computed weight details (for dashboard/debugging) */
	private lastWeights: StrategyWeight[] = [];
	/** Per-strategy trade counts for updateFromTrade's minTrades gate */
	private tradeCounts = new Map<string, number>();
	private db: Database.Database | null;
	private regimeWeights = new Map<string, { weight: number; tradeCount: number; winRate: number; avgPnl: number }>();

	constructor(leaderboard: LeaderboardStore, config: Partial<StrategyAdaptorConfig> = {}, db?: Database.Database) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.leaderboard = leaderboard;
		this.db = db ?? null;
		if (this.db) this.loadRegimeWeights();
	}

	/**
	 * Recompute strategy weights from leaderboard data.
	 * Call this after each trade closes (or periodically on a timer).
	 */
	update(): StrategyWeight[] {
		const metrics = this.leaderboard.getLeaderboard(this.config.period);
		if (metrics.length === 0) return this.lastWeights;

		const results: StrategyWeight[] = [];

		for (const m of metrics) {
			// Skip strategies with insufficient data
			if (m.numTrades < this.config.minTrades) {
				results.push({
					strategyName: m.strategyName,
					weight: 1.0,
					reason: `Insufficient data (${m.numTrades}/${this.config.minTrades} trades)`,
					metrics: { winRate: m.winRate, totalPnl: m.totalPnl, sharpeRatio: m.sharpeRatio, maxDrawdown: m.maxDrawdown, numTrades: m.numTrades },
				});
				continue;
			}

			// Compute raw weight from multiple performance signals
			const rawWeight = this.computeRawWeight(m);

			// EMA smooth against previous weight to avoid whipsaw
			const prevWeight = this.weights.get(m.strategyName) ?? 1.0;
			const smoothed = this.config.alpha * rawWeight + (1 - this.config.alpha) * prevWeight;

			// Clamp to [minWeight, maxWeight]
			const clamped = Math.max(this.config.minWeight, Math.min(this.config.maxWeight, smoothed));
			const rounded = Math.round(clamped * 1000) / 1000;

			this.weights.set(m.strategyName, rounded);

			const reason = this.explainWeight(m, rounded);
			results.push({
				strategyName: m.strategyName,
				weight: rounded,
				reason,
				metrics: { winRate: m.winRate, totalPnl: m.totalPnl, sharpeRatio: m.sharpeRatio, maxDrawdown: m.maxDrawdown, numTrades: m.numTrades },
			});
		}

		this.lastWeights = results;
		return results;
	}

	/**
	 * Get the current adaptive weight for a strategy.
	 * Returns 1.0 if the strategy hasn't been evaluated yet.
	 */
	getStrategyWeight(strategyName: string): number {
		return this.weights.get(strategyName) ?? 1.0;
	}

	/**
	 * Get all current weights (for dashboard display).
	 */
	getAllWeights(): StrategyWeight[] {
		return [...this.lastWeights];
	}

	/**
	 * Directly set a strategy's weight (bypasses EMA smoothing).
	 * Used by PerformanceReviewer to suppress F-grade strategies immediately.
	 * The weight is clamped to [minWeight, maxWeight].
	 */
	setStrategyWeight(strategyName: string, weight: number, reason?: string): void {
		const clamped = Math.max(this.config.minWeight, Math.min(this.config.maxWeight, weight));
		const rounded = Math.round(clamped * 1000) / 1000;
		this.weights.set(strategyName, rounded);

		// Update lastWeights if there's an existing entry
		const existing = this.lastWeights.find((w) => w.strategyName === strategyName);
		if (existing) {
			existing.weight = rounded;
			if (reason) existing.reason = reason;
		}
	}

	/**
	 * Compute raw weight from strategy metrics.
	 *
	 * The weight is a composite of:
	 * - Win rate contribution (0-1): higher win rate → higher weight
	 * - Sharpe ratio contribution: positive Sharpe → boost, negative → penalty
	 * - Drawdown penalty: deep drawdowns reduce weight
	 * - Profit factor: profitable strategies get a bonus
	 */
	private computeRawWeight(m: StrategyMetrics): number {
		let weight = 1.0;

		// Win rate: map [0.3, 0.7] → [0.7, 1.3] (linear interpolation)
		// Below 30% win rate → penalty, above 70% → bonus
		const wrContribution = 0.7 + (Math.max(0, Math.min(1, m.winRate)) - 0.3) * 1.5;
		weight *= wrContribution;

		// Sharpe ratio: positive → boost, negative → penalty
		if (m.sharpeRatio > 1.0) {
			weight *= 1.1; // good risk-adjusted returns
		} else if (m.sharpeRatio < this.config.sharpePenaltyThreshold) {
			weight *= 0.8; // negative risk-adjusted returns
		}

		// Drawdown penalty: scale down if max drawdown exceeds threshold
		if (m.maxDrawdown < this.config.drawdownPenaltyThreshold) {
			const excess = Math.abs(m.maxDrawdown) - Math.abs(this.config.drawdownPenaltyThreshold);
			const penalty = Math.max(0.5, 1.0 - excess * 0.005); // -0.5% per dollar of excess drawdown
			weight *= penalty;
		}

		// Profit factor bonus: if average return is positive, slight boost
		if (m.avgReturn > 0) {
			weight *= 1.05;
		} else if (m.avgReturn < 0) {
			weight *= 0.9;
		}

		return weight;
	}

	private explainWeight(m: StrategyMetrics, weight: number): string {
		const parts: string[] = [];
		if (weight >= 1.2) parts.push("performing well");
		else if (weight >= 0.9) parts.push("neutral");
		else if (weight >= 0.5) parts.push("underperforming");
		else parts.push("strongly suppressed");

		parts.push(`WR=${(m.winRate * 100).toFixed(0)}%`);
		parts.push(`PnL=$${m.totalPnl.toFixed(2)}`);
		if (m.sharpeRatio !== 0) parts.push(`Sharpe=${m.sharpeRatio.toFixed(2)}`);
		if (m.maxDrawdown < 0) parts.push(`DD=$${m.maxDrawdown.toFixed(2)}`);

		return parts.join(", ");
	}

	/**
	 * Update weights incrementally after a single trade closes.
	 * More responsive than full update() — uses the same EMA logic
	 * but only processes the delta from one trade.
	 *
	 * Skips if the strategy has fewer than minTrades total (tracked internally).
	 */
	updateFromTrade(strategyName: string, pnl: number, isWin: boolean): void {
		// Track cumulative trade count per strategy
		const count = (this.tradeCounts.get(strategyName) ?? 0) + 1;
		this.tradeCounts.set(strategyName, count);

		// Skip adaptation until we have enough data
		if (count < this.config.minTrades) return;

		const prevWeight = this.weights.get(strategyName) ?? 1.0;

		// Target weight: wins nudge toward maxWeight, losses nudge toward minWeight.
		// The magnitude of the nudge is proportional to the distance to the target,
		// smoothed by the same alpha as the full update() method.
		const target = isWin ? this.config.maxWeight : this.config.minWeight;
		const smoothed = this.config.alpha * target + (1 - this.config.alpha) * prevWeight;

		// Clamp to [minWeight, maxWeight]
		const clamped = Math.max(this.config.minWeight, Math.min(this.config.maxWeight, smoothed));
		const rounded = Math.round(clamped * 1000) / 1000;

		this.weights.set(strategyName, rounded);

		// Update lastWeights entry if it exists (keeps dashboard consistent)
		const existing = this.lastWeights.find((w) => w.strategyName === strategyName);
		if (existing) {
			existing.weight = rounded;
			existing.reason = `Trade-level update: ${isWin ? "win" : "loss"} (PnL=$${pnl.toFixed(2)})`;
		}
	}

	/** Get the internal trade count for a strategy (used by tests and diagnostics). */
	getTradeCount(strategyName: string): number {
		return this.tradeCounts.get(strategyName) ?? 0;
	}

	getConfig(): StrategyAdaptorConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<StrategyAdaptorConfig>): void {
		Object.assign(this.config, updates);
	}

	getRegimeWeight(strategyName: string, regime: string): number {
		const key = `${strategyName}|${regime}`;
		const entry = this.regimeWeights.get(key);
		if (!entry || entry.tradeCount < this.config.minTrades) return 1.0;
		return entry.weight;
	}

	updateRegimeWeight(
		strategyName: string,
		regime: string,
		data: { weight: number; tradeCount: number; winRate: number; avgPnl: number },
	): void {
		const clamped = Math.max(this.config.minWeight, Math.min(this.config.maxWeight, data.weight));
		const rounded = Math.round(clamped * 1000) / 1000;
		const key = `${strategyName}|${regime}`;
		this.regimeWeights.set(key, { weight: rounded, tradeCount: data.tradeCount, winRate: data.winRate, avgPnl: data.avgPnl });

		if (this.db) {
			this.db.prepare(`
				INSERT INTO strategy_regime_weights (strategy_name, regime, weight, trade_count, win_rate, avg_pnl, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(strategy_name, regime) DO UPDATE SET
					weight = excluded.weight, trade_count = excluded.trade_count,
					win_rate = excluded.win_rate, avg_pnl = excluded.avg_pnl,
					updated_at = excluded.updated_at
			`).run(strategyName, regime, rounded, data.tradeCount, data.winRate, data.avgPnl, new Date().toISOString());
		}
	}

	getAllRegimeWeights(): Array<{ strategyName: string; regime: string; weight: number; tradeCount: number; winRate: number; avgPnl: number }> {
		const result: Array<{ strategyName: string; regime: string; weight: number; tradeCount: number; winRate: number; avgPnl: number }> = [];
		for (const [key, data] of this.regimeWeights) {
			const [strategyName, regime] = key.split("|");
			result.push({ strategyName, regime, ...data });
		}
		return result;
	}

	private loadRegimeWeights(): void {
		if (!this.db) return;
		try {
			const rows = this.db.prepare("SELECT * FROM strategy_regime_weights").all() as Array<{
				strategy_name: string; regime: string; weight: number;
				trade_count: number; win_rate: number; avg_pnl: number;
			}>;
			for (const row of rows) {
				this.regimeWeights.set(`${row.strategy_name}|${row.regime}`, {
					weight: row.weight, tradeCount: row.trade_count,
					winRate: row.win_rate, avgPnl: row.avg_pnl,
				});
			}
		} catch { /* table may not exist yet */ }
	}
}
