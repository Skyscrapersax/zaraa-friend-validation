/**
 * PerformanceReviewer — Autonomous 6-hour trading performance review cycle.
 *
 * Runs on a scheduled interval (every 6 hours) to assess all active trading
 * strategies, compute grades, detect problems, and take automatic corrective
 * actions (suppressing failing strategies, escalating dangerous drawdown).
 *
 * Grading rubric:
 *   A (90-100): Sharpe > 1.5, win rate > 60%, profitable
 *   B (75-89):  Sharpe > 0.5, win rate > 50%, profitable
 *   C (60-74):  Sharpe > 0,   win rate > 45%
 *   D (40-59):  Sharpe <= 0 or win rate < 45%
 *   F (0-39):   Negative P&L with 10+ trades, or drawdown > 10%
 *
 * Auto-actions:
 *   - F-grade strategy with 10+ trades -> suppress weight to 0.3
 *   - Portfolio drawdown > 5% -> ESCALATE:IMESSAGE warning
 *   - 3+ strategies at D or below -> RECOMMEND:PAUSE action
 *   - Circuit breaker tripped -> report which breakers and why
 */

import type { LeaderboardStore, StrategyMetrics } from "../leaderboard/leaderboard-store.js";
import type { StrategyAdaptor } from "./strategy-adaptor.js";
import type { TradingCircuitBreaker } from "../risk/trading-circuit-breaker.js";
import { resolvePaperMode } from "../risk/trading-mode.js";
import type { TradingStore } from "../trading-store.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface StrategyGrade {
	name: string;
	grade: Grade;
	score: number;
	weight: number;
	pnl: number;
	numTrades: number;
	winRate: number;
	sharpe: number;
	maxDrawdown: number;
}

export interface PerformanceReview {
	timestamp: string;
	grade: Grade;
	score: number; // 0-100
	pnl: { total: number; realized: number; unrealized: number };
	metrics: { winRate: number; sharpe: number; profitFactor: number; maxDrawdown: number };
	strategyGrades: Array<{ name: string; grade: string; weight: number; pnl: number; edgeVerdict?: string }>;
	warnings: string[];
	actions: string[]; // auto-actions taken
	recommendation: string;
}

export interface PerformanceReviewerDeps {
	leaderboard: LeaderboardStore;
	adaptor: StrategyAdaptor;
	circuitBreaker: TradingCircuitBreaker;
	store: TradingStore;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_WEIGHT = 0.3;
const DRAWDOWN_ESCALATION_PCT = 5;
const DRAWDOWN_F_GRADE_PCT = 10;
const MIN_TRADES_FOR_F_SUPPRESSION = 10;
const D_OR_BELOW_PAUSE_THRESHOLD = 3;

// ── PerformanceReviewer ──────────────────────────────────────────────────────

export class PerformanceReviewer {
	private leaderboard: LeaderboardStore;
	private adaptor: StrategyAdaptor;
	private circuitBreaker: TradingCircuitBreaker;
	private store: TradingStore;

	constructor(deps: PerformanceReviewerDeps) {
		this.leaderboard = deps.leaderboard;
		this.adaptor = deps.adaptor;
		this.circuitBreaker = deps.circuitBreaker;
		this.store = deps.store;
	}

	/**
	 * Run a full performance review. Returns structured assessment.
	 * Called every 6 hours by the cron scheduler.
	 */
	review(): PerformanceReview {
		const timestamp = new Date().toISOString();
		const warnings: string[] = [];
		const actions: string[] = [];

		// 1. Get leaderboard metrics for all strategies (30d)
		const metrics = this.leaderboard.getLeaderboard("30d");

		// 2. Get current positions and equity
		const openPositions = this.store.getOpenPositions();
		const peakEquity = this.store.getPeakEquity();
		const paperMode =
			typeof this.store.getSetting === "function"
				? resolvePaperMode(this.store)
				: true;
		// getLatestEquity() returns 0 when no positive snapshot exists (sentinel), not literal $0.
		// Using it raw produced bogus ~100% drawdowns and "current: $0.00" in ESCALATE:IMESSAGE lines.
		const currentEquity =
			typeof this.store.resolveReportEquity === "function"
				? this.store.resolveReportEquity(paperMode)
				: (() => {
						const latest = this.store.getLatestEquity();
						if (latest > 0) return latest;
						if (peakEquity > 0) return peakEquity;
						return typeof this.store.getInitialEquity === "function"
							? this.store.getInitialEquity(paperMode)
							: 1000;
					})();

		// Compute P&L breakdown
		const unrealizedPnl = openPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
		const realizedPnl = metrics.reduce((sum, m) => sum + m.totalPnl, 0);
		const totalPnl = realizedPnl + unrealizedPnl;

		// 3. Grade each strategy
		const strategyGrades = metrics.map((m) => this.gradeStrategy(m));

		// 4. Compute overall portfolio metrics
		const portfolioMetrics = this.computePortfolioMetrics(metrics, peakEquity, currentEquity);

		// 5. Check circuit breaker state
		const cbStatus = this.circuitBreaker.getStatus();
		if (cbStatus.halted) {
			for (const reason of cbStatus.reasons) {
				warnings.push(`CIRCUIT_BREAKER: ${reason}`);
			}
			actions.push(`Circuit breaker halted trading: ${cbStatus.reasons.length} breaker(s) tripped`);
		}

		// 6. Auto-actions
		// 6a. Suppress F-grade strategies with sufficient trade history
		for (const sg of strategyGrades) {
			if (sg.grade === "F" && sg.numTrades >= MIN_TRADES_FOR_F_SUPPRESSION) {
				this.adaptor.setStrategyWeight(sg.name, MIN_WEIGHT, `Suppressed by performance review: F grade with ${sg.numTrades} trades`);
				sg.weight = MIN_WEIGHT;
				actions.push(`Suppressed ${sg.name} weight to ${MIN_WEIGHT} (F grade, ${sg.numTrades} trades)`);
			}
		}

		// 6b. Drawdown escalation
		const drawdownPct = peakEquity > 0
			? ((peakEquity - currentEquity) / peakEquity) * 100
			: 0;

		if (drawdownPct > DRAWDOWN_ESCALATION_PCT) {
			warnings.push(`ESCALATE:IMESSAGE Portfolio drawdown ${drawdownPct.toFixed(2)}% exceeds ${DRAWDOWN_ESCALATION_PCT}% threshold (peak: $${peakEquity.toFixed(2)}, current: $${currentEquity.toFixed(2)})`);
		}

		// 6c. Multiple underperforming strategies -> recommend pause
		const dOrBelow = strategyGrades.filter((sg) => sg.grade === "D" || sg.grade === "F");
		if (dOrBelow.length >= D_OR_BELOW_PAUSE_THRESHOLD) {
			actions.push(`RECOMMEND:PAUSE ${dOrBelow.length} strategies at D or below: ${dOrBelow.map((s) => s.name).join(", ")}`);
		}

		// 6d. If ALL strategies are below C, recommend full pause
		if (strategyGrades.length > 0 && strategyGrades.every((sg) => sg.grade === "D" || sg.grade === "F")) {
			actions.push("RECOMMEND:PAUSE All strategies below C grade — consider pausing trading entirely");
		}

		// 7. Update strategy weights via adaptor
		this.adaptor.update();

		// 8. Compute overall grade
		const overallScore = this.computeOverallScore(strategyGrades, portfolioMetrics, cbStatus.halted);
		const overallGrade = scoreToGrade(overallScore);

		// Build recommendation
		const recommendation = this.buildRecommendation(overallGrade, strategyGrades, warnings, actions, drawdownPct);

		return {
			timestamp,
			grade: overallGrade,
			score: round2(overallScore),
			pnl: {
				total: round2(totalPnl),
				realized: round2(realizedPnl),
				unrealized: round2(unrealizedPnl),
			},
			metrics: portfolioMetrics,
			strategyGrades: strategyGrades.map((sg) => ({
				name: sg.name,
				grade: sg.grade,
				weight: sg.weight,
				pnl: sg.pnl,
			})),
			warnings,
			actions,
			recommendation,
		};
	}

	/**
	 * Grade a single strategy based on its metrics.
	 *
	 * F (0-39):  Negative P&L with 10+ trades, or drawdown > 10%
	 * D (40-59): Sharpe <= 0 or win rate < 45%
	 * C (60-74): Sharpe > 0, win rate > 45%
	 * B (75-89): Sharpe > 0.5, win rate > 50%, profitable
	 * A (90-100): Sharpe > 1.5, win rate > 60%, profitable
	 */
	private gradeStrategy(m: StrategyMetrics): StrategyGrade {
		const weight = this.adaptor.getStrategyWeight(m.strategyName);

		// Check F conditions first (hard failures)
		if (
			(m.totalPnl < 0 && m.numTrades >= MIN_TRADES_FOR_F_SUPPRESSION) ||
			(m.maxDrawdown < 0 && Math.abs(m.maxDrawdown) > DRAWDOWN_F_GRADE_PCT * (m.totalPnl > 0 ? m.totalPnl : 1))
		) {
			// Compute F score: 0-39 based on severity
			const fScore = Math.max(0, Math.min(39, 39 - Math.abs(m.totalPnl) * 0.1));
			return {
				name: m.strategyName,
				grade: "F",
				score: round2(fScore),
				weight,
				pnl: m.totalPnl,
				numTrades: m.numTrades,
				winRate: m.winRate,
				sharpe: m.sharpeRatio,
				maxDrawdown: m.maxDrawdown,
			};
		}

		// Compute score from multiple factors
		let score = 50; // baseline

		// Sharpe contribution: -20 to +30
		if (m.sharpeRatio > 1.5) score += 30;
		else if (m.sharpeRatio > 0.5) score += 15;
		else if (m.sharpeRatio > 0) score += 5;
		else score -= 20;

		// Win rate contribution: -15 to +20
		if (m.winRate > 0.6) score += 20;
		else if (m.winRate > 0.5) score += 10;
		else if (m.winRate > 0.45) score += 0;
		else score -= 15;

		// Profitability bonus/penalty
		if (m.totalPnl > 0) score += 10;
		else if (m.totalPnl < 0) score -= 10;

		// Drawdown penalty
		if (m.maxDrawdown < -50) score -= 10;
		else if (m.maxDrawdown < -20) score -= 5;

		// Clamp to 0-100
		score = Math.max(0, Math.min(100, score));
		const grade = scoreToGrade(score);

		return {
			name: m.strategyName,
			grade,
			score: round2(score),
			weight,
			pnl: m.totalPnl,
			numTrades: m.numTrades,
			winRate: m.winRate,
			sharpe: m.sharpeRatio,
			maxDrawdown: m.maxDrawdown,
		};
	}

	/**
	 * Compute aggregate portfolio metrics from all strategy data.
	 */
	private computePortfolioMetrics(
		metrics: StrategyMetrics[],
		peakEquity: number,
		latestEquity: number,
	): { winRate: number; sharpe: number; profitFactor: number; maxDrawdown: number } {
		if (metrics.length === 0) {
			return { winRate: 0, sharpe: 0, profitFactor: 0, maxDrawdown: 0 };
		}

		// Weighted average by trade count
		const totalTrades = metrics.reduce((s, m) => s + m.numTrades, 0);
		if (totalTrades === 0) {
			return { winRate: 0, sharpe: 0, profitFactor: 0, maxDrawdown: 0 };
		}

		const weightedWinRate = metrics.reduce((s, m) => s + m.winRate * m.numTrades, 0) / totalTrades;
		const weightedSharpe = metrics.reduce((s, m) => s + m.sharpeRatio * m.numTrades, 0) / totalTrades;

		// Profit factor: gross wins / gross losses
		const grossWins = metrics.filter((m) => m.totalPnl > 0).reduce((s, m) => s + m.totalPnl, 0);
		const grossLosses = Math.abs(metrics.filter((m) => m.totalPnl < 0).reduce((s, m) => s + m.totalPnl, 0));
		const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999.99 : 0;

		// Portfolio-level drawdown from equity curve
		const drawdownPct = peakEquity > 0
			? -((peakEquity - latestEquity) / peakEquity) * 100
			: 0;

		return {
			winRate: round2(weightedWinRate),
			sharpe: round2(weightedSharpe),
			profitFactor: round2(profitFactor),
			maxDrawdown: round2(drawdownPct),
		};
	}

	/**
	 * Compute overall portfolio score from strategy grades and portfolio metrics.
	 */
	private computeOverallScore(
		strategyGrades: StrategyGrade[],
		portfolioMetrics: { winRate: number; sharpe: number; profitFactor: number; maxDrawdown: number },
		circuitBreakerHalted: boolean,
	): number {
		if (strategyGrades.length === 0) return 50; // no data = neutral

		// Weighted average of strategy scores (by trade count)
		const totalTrades = strategyGrades.reduce((s, sg) => s + sg.numTrades, 0);
		let score: number;

		if (totalTrades > 0) {
			score = strategyGrades.reduce((s, sg) => s + sg.score * sg.numTrades, 0) / totalTrades;
		} else {
			score = strategyGrades.reduce((s, sg) => s + sg.score, 0) / strategyGrades.length;
		}

		// Circuit breaker penalty: -20 points
		if (circuitBreakerHalted) {
			score -= 20;
		}

		// Portfolio-level adjustments
		if (portfolioMetrics.profitFactor > 2) score += 5;
		if (portfolioMetrics.maxDrawdown < -10) score -= 10;

		return Math.max(0, Math.min(100, score));
	}

	/**
	 * Build a human-readable recommendation based on the review.
	 */
	private buildRecommendation(
		grade: Grade,
		strategyGrades: StrategyGrade[],
		warnings: string[],
		actions: string[],
		drawdownPct: number,
	): string {
		const parts: string[] = [];

		if (grade === "A") {
			parts.push("Portfolio performing excellently. Maintain current strategy allocation.");
		} else if (grade === "B") {
			parts.push("Portfolio performing well. Minor optimizations may improve returns.");
		} else if (grade === "C") {
			parts.push("Portfolio is marginal. Review underperforming strategies and tighten risk controls.");
		} else if (grade === "D") {
			parts.push("Portfolio underperforming. Strongly consider reducing exposure and reviewing all strategies.");
		} else {
			parts.push("Portfolio failing. Immediate review required. Consider pausing all trading.");
		}

		const fGrades = strategyGrades.filter((sg) => sg.grade === "F");
		if (fGrades.length > 0) {
			parts.push(`${fGrades.length} strategy(s) at F grade: ${fGrades.map((s) => s.name).join(", ")}.`);
		}

		if (drawdownPct > DRAWDOWN_ESCALATION_PCT) {
			parts.push(`Drawdown at ${drawdownPct.toFixed(1)}% — risk management alert.`);
		}

		if (actions.some((a) => a.includes("RECOMMEND:PAUSE"))) {
			parts.push("Multiple strategies underperforming — trading pause recommended.");
		}

		if (warnings.some((w) => w.includes("CIRCUIT_BREAKER"))) {
			parts.push("Circuit breaker active — trading halted until breakers reset.");
		}

		return parts.join(" ");
	}

	/**
	 * Format a performance review as a human-readable markdown report.
	 */
	formatReport(review: PerformanceReview): string {
		const lines: string[] = [];

		lines.push("# Performance Review");
		lines.push("");
		lines.push(`**Date:** ${review.timestamp}`);
		lines.push(`**Overall Grade:** ${review.grade} (${review.score}/100)`);
		lines.push("");

		// P&L Summary
		lines.push("## P&L Summary");
		lines.push("");
		lines.push("| Metric | Value |");
		lines.push("|--------|-------|");
		lines.push(`| Total P&L | $${review.pnl.total.toFixed(2)} |`);
		lines.push(`| Realized | $${review.pnl.realized.toFixed(2)} |`);
		lines.push(`| Unrealized | $${review.pnl.unrealized.toFixed(2)} |`);
		lines.push("");

		// Portfolio Metrics
		lines.push("## Portfolio Metrics");
		lines.push("");
		lines.push("| Metric | Value |");
		lines.push("|--------|-------|");
		lines.push(`| Win Rate | ${(review.metrics.winRate * 100).toFixed(1)}% |`);
		lines.push(`| Sharpe Ratio | ${review.metrics.sharpe.toFixed(2)} |`);
		lines.push(`| Profit Factor | ${review.metrics.profitFactor.toFixed(2)} |`);
		lines.push(`| Max Drawdown | ${review.metrics.maxDrawdown.toFixed(2)}% |`);
		lines.push("");

		// Strategy Grades
		if (review.strategyGrades.length > 0) {
			lines.push("## Strategy Grades");
			lines.push("");
			lines.push("| Strategy | Grade | Weight | P&L |");
			lines.push("|----------|-------|--------|-----|");
			for (const sg of review.strategyGrades) {
				lines.push(`| ${sg.name} | ${sg.grade} | ${sg.weight.toFixed(3)} | $${sg.pnl.toFixed(2)} |`);
			}
			lines.push("");
		}

		// Warnings
		if (review.warnings.length > 0) {
			lines.push("## Warnings");
			lines.push("");
			for (const w of review.warnings) {
				lines.push(`- ${w}`);
			}
			lines.push("");
		}

		// Actions
		if (review.actions.length > 0) {
			lines.push("## Auto-Actions Taken");
			lines.push("");
			for (const a of review.actions) {
				lines.push(`- ${a}`);
			}
			lines.push("");
		}

		// Recommendation
		lines.push("## Recommendation");
		lines.push("");
		lines.push(review.recommendation);
		lines.push("");

		return lines.join("\n");
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreToGrade(score: number): Grade {
	if (score >= 90) return "A";
	if (score >= 75) return "B";
	if (score >= 60) return "C";
	if (score >= 40) return "D";
	return "F";
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
