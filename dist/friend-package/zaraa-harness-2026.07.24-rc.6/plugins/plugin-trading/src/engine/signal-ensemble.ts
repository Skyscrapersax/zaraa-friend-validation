/**
 * Signal Ensemble — multi-strategy consensus voting for quant swarm Phase 1.
 *
 * Collects signals from multiple strategies for the same symbol,
 * applies weighted voting, and produces a consensus signal only when
 * enough strategies agree on direction.
 *
 * Phase 2: Market regime-aware voting. When a RegimeAnalysis is provided,
 * each strategy's confidence is modulated by how well it suits the current
 * market conditions (e.g., trend-following gets boosted in trending markets).
 */
import type { Signal } from "../strategies/strategy.js";
import type { RegimeAnalysis } from "../strategies/market-regime.js";
import { applyRegimeWeight } from "../strategies/market-regime.js";

export interface EnsembleConfig {
	/** Minimum number of strategies that must agree on direction (default: 2) */
	minConsensus: number;
	/** Confidence boost when consensus is reached: final = avg + boost * (agreeing/total) (default: 0.1) */
	consensusBoost: number;
	/** Cap on final confidence (default: 0.95) */
	maxConfidence: number;
}

const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
	minConsensus: 2,
	consensusBoost: 0.1,
	maxConfidence: 0.95,
};

export interface EnsembleVote {
	strategyName: string;
	signal: Signal;
}

export interface EnsembleResult {
	/** The consensus signal (null if no consensus) */
	signal: Signal | null;
	/** All individual votes that were cast */
	votes: EnsembleVote[];
	/** Strategies that agreed with the winning direction */
	agreeing: string[];
	/** Strategies that disagreed */
	dissenting: string[];
	/** Summary for journal/logging */
	summary: string;
	/** Market regime used for weighting (if provided) */
	regime?: RegimeAnalysis;
}

export class SignalEnsemble {
	private config: EnsembleConfig;

	constructor(config: Partial<EnsembleConfig> = {}) {
		this.config = { ...DEFAULT_ENSEMBLE_CONFIG, ...config };
	}

	/**
	 * Vote on a set of signals for the same symbol.
	 * Returns a consensus signal if enough strategies agree on direction,
	 * or null if no consensus is reached.
	 *
	 * When a RegimeAnalysis is provided, each strategy's vote weight is
	 * modulated by how well-suited it is to the current market regime.
	 * For example, in a trending market, trend-following votes carry more
	 * weight and mean-reversion votes carry less.
	 *
	 * When a `gradeMultiplier` is provided, each strategy's vote weight is
	 * additionally scaled by its allocation multiplier (the quartile grade
	 * produced by the strategy-grader: 1.0/0.75/0.5/0.25, or 0 when archived).
	 * This closes the outcome→weight loop at runtime — measured-weak strategies
	 * lose influence over both consensus direction and the resulting confidence
	 * (and therefore downstream sizing). Multipliers only ever scale weight
	 * DOWN; a missing/invalid grade is treated as a neutral 1.
	 */
	vote(
		votes: EnsembleVote[],
		regime?: RegimeAnalysis,
		gradeMultiplier?: (strategyName: string) => number,
	): EnsembleResult {
		if (votes.length === 0) {
			return { signal: null, votes: [], agreeing: [], dissenting: [], summary: "No signals" };
		}

		// A bad or missing grade must never amplify a vote — clamp to a neutral 1.
		const grade = (strategyName: string): number => {
			if (!gradeMultiplier) return 1;
			const m = gradeMultiplier(strategyName);
			return Number.isFinite(m) && m >= 0 ? m : 1;
		};

		// Apply regime weights and per-strategy grade multipliers to each vote's confidence
		// (non-destructive — uses effective confidence for voting/sizing, never mutates the signal).
		const effectiveConfidence = new Map<EnsembleVote, number>();
		for (const v of votes) {
			const base = v.signal.confidence;
			const regimeAdj = regime ? applyRegimeWeight(base, v.strategyName, regime) : base;
			effectiveConfidence.set(v, regimeAdj * grade(v.strategyName));
		}

		// Single signal — pass through (no ensemble needed)
		if (votes.length === 1) {
			const v = votes[0];
			const conf = effectiveConfidence.get(v) ?? v.signal.confidence;
			return {
				signal: { ...v.signal, confidence: Math.round(conf * 1000) / 1000 },
				votes,
				agreeing: [v.strategyName],
				dissenting: [],
				summary: `Single strategy: ${v.strategyName} (${v.signal.direction}, conf=${conf.toFixed(2)}${regime ? ` regime=${regime.regime}` : ""})`,
				regime,
			};
		}

		// Count votes by direction, weighted by regime-adjusted confidence
		const longVotes = votes.filter((v) => v.signal.direction === "long");
		const shortVotes = votes.filter((v) => v.signal.direction === "short");

		const longWeight = longVotes.reduce((sum, v) => sum + (effectiveConfidence.get(v) ?? v.signal.confidence), 0);
		const shortWeight = shortVotes.reduce((sum, v) => sum + (effectiveConfidence.get(v) ?? v.signal.confidence), 0);

		// Determine winning direction
		const winningDirection: "long" | "short" = longWeight >= shortWeight ? "long" : "short";
		const agreeing = winningDirection === "long" ? longVotes : shortVotes;
		const dissenting = winningDirection === "long" ? shortVotes : longVotes;

		// Check minimum consensus
		if (agreeing.length < this.config.minConsensus) {
			const summary = `No consensus: ${longVotes.length} long vs ${shortVotes.length} short (need ${this.config.minConsensus})`;
			return {
				signal: null,
				votes,
				agreeing: agreeing.map((v) => v.strategyName),
				dissenting: dissenting.map((v) => v.strategyName),
				summary,
				regime,
			};
		}

		// Build consensus signal — use regime-adjusted confidence for averaging
		const avgConfidence = agreeing.reduce((sum, v) => sum + (effectiveConfidence.get(v) ?? v.signal.confidence), 0) / agreeing.length;
		const consensusRatio = agreeing.length / votes.length;
		const boostedConfidence = Math.min(
			avgConfidence + this.config.consensusBoost * consensusRatio,
			this.config.maxConfidence,
		);

		// Use highest effective-confidence signal as the base (best entry/stops)
		const bestVote = agreeing.reduce((best, v) =>
			(effectiveConfidence.get(v) ?? v.signal.confidence) > (effectiveConfidence.get(best) ?? best.signal.confidence) ? v : best,
		);

		// Average entry price across agreeing strategies for stability
		const avgEntry = agreeing.reduce((sum, v) => sum + v.signal.entryPrice, 0) / agreeing.length;

		// Use the tightest stop-loss (most conservative)
		const stopLosses = agreeing
			.map((v) => v.signal.stopLoss)
			.filter((sl): sl is number => sl !== undefined);
		const tightestStop = stopLosses.length > 0
			? (winningDirection === "long"
				? Math.max(...stopLosses)  // highest stop for long = tightest
				: Math.min(...stopLosses)) // lowest stop for short = tightest
			: bestVote.signal.stopLoss;

		// Use the most conservative take-profit
		const takeProfits = agreeing
			.map((v) => v.signal.takeProfit)
			.filter((tp): tp is number => tp !== undefined);
		const conservativeTP = takeProfits.length > 0
			? (winningDirection === "long"
				? Math.min(...takeProfits)  // lowest TP for long = most conservative
				: Math.max(...takeProfits)) // highest TP for short = most conservative
			: bestVote.signal.takeProfit;

		const reasons = agreeing.map((v) => `${v.strategyName}: ${v.signal.reason}`);
		const consensusSignal: Signal = {
			symbol: bestVote.signal.symbol,
			direction: winningDirection,
			confidence: Math.round(boostedConfidence * 1000) / 1000,
			reason: `[Ensemble ${agreeing.length}/${votes.length}] ${reasons.join(" | ")}`,
			entryPrice: Math.round(avgEntry * 1e8) / 1e8,
			stopLoss: tightestStop,
			takeProfit: conservativeTP,
			timestamp: Date.now(),
		};

		const summary = [
			`Consensus: ${agreeing.length}/${votes.length} ${winningDirection}`,
			`conf=${boostedConfidence.toFixed(3)} (avg=${avgConfidence.toFixed(3)} +boost)`,
			`agreeing=[${agreeing.map((v) => v.strategyName).join(",")}]`,
			dissenting.length > 0 ? `dissenting=[${dissenting.map((v) => v.strategyName).join(",")}]` : "",
			regime ? `regime=${regime.regime}(${regime.confidence.toFixed(2)})` : "",
		].filter(Boolean).join(" ");

		return {
			signal: consensusSignal,
			votes,
			agreeing: agreeing.map((v) => v.strategyName),
			dissenting: dissenting.map((v) => v.strategyName),
			summary,
			regime,
		};
	}

	getConfig(): EnsembleConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<EnsembleConfig>): void {
		Object.assign(this.config, updates);
	}
}
