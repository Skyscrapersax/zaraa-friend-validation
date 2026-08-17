/**
 * PaperExecutor — Paper trading execution for prediction market signals.
 *
 * Cycle 009: Records prediction signals as paper trades without any on-chain
 * interaction. Tracks positions, P&L, and performance metrics.
 *
 * This follows the same pattern as plugin-trading's ExecutionManager but is
 * purpose-built for prediction market binary outcomes where:
 * - Contracts settle at $0 or $1 (not continuous prices)
 * - Position size is in dollars (not shares)
 * - P&L = (outcome ? $1 : $0) * shares - avgPrice * shares
 * - No stop-losses (hold to resolution unless manually closed)
 */
import type { PredictionSignal, PredictionPosition } from "../types.js";

// ── Types ──

export interface PaperTrade {
	id: string;
	marketId: string;
	exchange: "polymarket" | "kalshi";
	question: string;
	category: string;
	side: "yes" | "no";
	entryPrice: number;
	size: number; // dollars risked
	shares: number; // shares = size / entryPrice
	timestamp: number;
	status: "open" | "closed" | "resolved";
	exitPrice?: number;
	exitTimestamp?: number;
	outcome?: 0 | 1; // binary outcome
	pnl?: number;
	reason: string;
}

export interface PaperPortfolio {
	trades: PaperTrade[];
	totalInvested: number;
	totalPnl: number;
	winCount: number;
	lossCount: number;
	openPositionCount: number;
	resolvedCount: number;
}

export interface PaperExecutorConfig {
	/** Maximum dollars at risk across all positions (default: 1000) */
	maxTotalExposure: number;
	/** Maximum dollars at risk per market (default: 50) */
	maxPerMarketExposure: number;
	/** Maximum dollars at risk per category (default: 150) */
	maxPerCategoryExposure: number;
	/** Maximum number of open positions (default: 20) */
	maxOpenPositions: number;
}

const DEFAULT_CONFIG: PaperExecutorConfig = {
	maxTotalExposure: 1000,
	maxPerMarketExposure: 50,
	maxPerCategoryExposure: 150,
	maxOpenPositions: 20,
};

// ── Kill Switch ──

export interface KillSwitchState {
	active: boolean;
	level: "none" | "signal" | "execution" | "halt";
	reason?: string;
	activatedAt?: string;
}

// ── Executor ──

export class PaperExecutor {
	private config: PaperExecutorConfig;
	private trades: PaperTrade[] = [];
	private tradeCounter = 0;
	private killSwitch: KillSwitchState = { active: false, level: "none" };

	/** Consecutive loss counter for kill switch auto-trigger */
	private consecutiveLosses = 0;
	/** Daily P&L tracking */
	private dailyPnl = new Map<string, number>(); // date string -> P&L
	/** Peak equity for max drawdown calculation */
	private peakEquity = 0;
	/** Maximum drawdown (peak-to-trough) */
	private maxDrawdown = 0;

	constructor(config: Partial<PaperExecutorConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Execute a batch of prediction signals in paper mode.
	 * Returns which signals were accepted and which were rejected.
	 */
	executeBatch(signals: PredictionSignal[]): Array<{ signal: PredictionSignal; accepted: boolean; reason: string; tradeId?: string }> {
		return signals.map((signal) => this.executeSingle(signal));
	}

	/**
	 * Execute a single prediction signal in paper mode.
	 * @param category - Market category for per-category exposure enforcement
	 */
	executeSingle(signal: PredictionSignal, category = "default"): { signal: PredictionSignal; accepted: boolean; reason: string; tradeId?: string } {
		// Kill switch check
		if (this.killSwitch.active && this.killSwitch.level !== "none") {
			return { signal, accepted: false, reason: `Kill switch active: ${this.killSwitch.reason}` };
		}

		// Position limit check
		const openTrades = this.trades.filter((t) => t.status === "open");
		if (openTrades.length >= this.config.maxOpenPositions) {
			return { signal, accepted: false, reason: `Max open positions reached (${this.config.maxOpenPositions})` };
		}

		// Duplicate check
		const existingPosition = openTrades.find((t) => t.marketId === signal.marketId && t.side === signal.side);
		if (existingPosition) {
			return { signal, accepted: false, reason: `Already have ${signal.side} position on ${signal.marketId}` };
		}

		// Calculate position size in dollars
		const positionSize = Math.min(
			signal.quarterKellySize,
			this.config.maxPerMarketExposure,
		);

		if (positionSize <= 0) {
			return { signal, accepted: false, reason: "Position size too small" };
		}

		// Total exposure check
		const totalExposure = openTrades.reduce((sum, t) => sum + t.size, 0);
		if (totalExposure + positionSize > this.config.maxTotalExposure) {
			return { signal, accepted: false, reason: `Total exposure limit: $${totalExposure.toFixed(2)} + $${positionSize.toFixed(2)} > $${this.config.maxTotalExposure}` };
		}

		// Per-category exposure check — enforce maxPerCategoryExposure
		const categoryExposure = openTrades
			.filter((t) => t.category === category)
			.reduce((sum, t) => sum + t.size, 0);
		if (categoryExposure + positionSize > this.config.maxPerCategoryExposure) {
			return { signal, accepted: false, reason: `Category '${category}' exposure limit: $${categoryExposure.toFixed(2)} + $${positionSize.toFixed(2)} > $${this.config.maxPerCategoryExposure}` };
		}

		// Create paper trade — guard against edge prices that cause division by zero or near-infinite shares
		const entryPrice = signal.side === "yes" ? signal.marketPrice : 1 - signal.marketPrice;
		if (entryPrice <= 0.01 || entryPrice >= 0.99) {
			return { signal, accepted: false, reason: `Entry price ${entryPrice.toFixed(4)} outside safe bounds (0.01–0.99)` };
		}
		const trade: PaperTrade = {
			id: `paper-${++this.tradeCounter}-${Date.now()}`,
			marketId: signal.marketId,
			exchange: signal.exchange,
			question: signal.question,
			category,
			side: signal.side,
			entryPrice: entryPrice,
			size: positionSize,
			shares: positionSize / entryPrice,
			timestamp: Date.now(),
			status: "open",
			reason: signal.reason,
		};

		this.trades.push(trade);

		return { signal, accepted: true, reason: "Paper trade recorded", tradeId: trade.id };
	}

	/**
	 * Resolve a market with its outcome. Updates all open positions for this market.
	 */
	resolveMarket(marketId: string, outcome: 0 | 1): PaperTrade[] {
		const resolved: PaperTrade[] = [];

		for (const trade of this.trades) {
			if (trade.marketId === marketId && trade.status === "open") {
				trade.status = "resolved";
				trade.outcome = outcome;
				trade.exitTimestamp = Date.now();

				// P&L calculation for binary outcomes
				// YES side: win $1 per share if outcome=1, lose entry price per share if outcome=0
				// NO side: win $1 per share if outcome=0, lose entry price per share if outcome=1
				const isWin = (trade.side === "yes" && outcome === 1) || (trade.side === "no" && outcome === 0);

				if (isWin) {
					// Won: receive $1 per share, paid entryPrice per share
					trade.exitPrice = 1;
					trade.pnl = (1 - trade.entryPrice) * trade.shares;
					this.consecutiveLosses = 0;
				} else {
					// Lost: receive $0 per share, paid entryPrice per share
					trade.exitPrice = 0;
					trade.pnl = -trade.entryPrice * trade.shares;
					this.consecutiveLosses++;
				}

				// Track daily P&L
				const dateKey = new Date().toISOString().split("T")[0];
				const currentDailyPnl = this.dailyPnl.get(dateKey) ?? 0;
				this.dailyPnl.set(dateKey, currentDailyPnl + (trade.pnl ?? 0));

				// Track max drawdown (peak-to-trough)
				const totalPnl = this.trades
					.filter((t) => t.status === "resolved" || t.status === "closed")
					.reduce((s, t) => s + (t.pnl ?? 0), 0);
				if (totalPnl > this.peakEquity) this.peakEquity = totalPnl;
				const currentDrawdown = this.peakEquity - totalPnl;
				if (currentDrawdown > this.maxDrawdown) this.maxDrawdown = currentDrawdown;

				// Auto-trigger kill switch on consecutive losses
				if (this.consecutiveLosses >= 5) {
					this.activateKillSwitch("signal", `${this.consecutiveLosses} consecutive losses`);
				}

				// Auto-trigger kill switch on daily drawdown
				const todayPnl = this.dailyPnl.get(dateKey) ?? 0;
				const drawdownPct = Math.abs(todayPnl) / this.config.maxTotalExposure;
				if (todayPnl < 0 && drawdownPct > 0.05) {
					this.activateKillSwitch("execution", `Daily drawdown ${(drawdownPct * 100).toFixed(1)}% > 5%`);
				}

				resolved.push(trade);
			}
		}

		return resolved;
	}

	/**
	 * Close a position early (before resolution) at a given price.
	 */
	closePosition(tradeId: string, exitPrice: number): PaperTrade | null {
		const trade = this.trades.find((t) => t.id === tradeId && t.status === "open");
		if (!trade) return null;

		trade.status = "closed";
		trade.exitPrice = exitPrice;
		trade.exitTimestamp = Date.now();

		// P&L for early close
		if (trade.side === "yes") {
			trade.pnl = (exitPrice - trade.entryPrice) * trade.shares;
		} else {
			// NO side: profit when price drops from entry
			trade.pnl = (trade.entryPrice - exitPrice) * trade.shares;
		}

		return trade;
	}

	// ── Kill Switch ──

	activateKillSwitch(level: "signal" | "execution" | "halt", reason: string): void {
		this.killSwitch = {
			active: true,
			level,
			reason,
			activatedAt: new Date().toISOString(),
		};
	}

	deactivateKillSwitch(): void {
		this.killSwitch = { active: false, level: "none" };
	}

	getKillSwitchStatus(): KillSwitchState {
		return { ...this.killSwitch };
	}

	// ── Queries ──

	getOpenPositions(): PaperTrade[] {
		return this.trades.filter((t) => t.status === "open");
	}

	getResolvedTrades(): PaperTrade[] {
		return this.trades.filter((t) => t.status === "resolved");
	}

	getAllTrades(): PaperTrade[] {
		return [...this.trades];
	}

	/**
	 * Convert open trades to PredictionPosition format.
	 */
	getPositions(currentPrices: Map<string, number>): PredictionPosition[] {
		return this.getOpenPositions().map((trade) => {
			const currentPrice = currentPrices.get(trade.marketId) ?? trade.entryPrice;
			const unrealizedPnl = trade.side === "yes"
				? (currentPrice - trade.entryPrice) * trade.shares
				: (trade.entryPrice - currentPrice) * trade.shares;

			return {
				marketId: trade.marketId,
				exchange: trade.exchange,
				question: trade.question,
				side: trade.side,
				avgPrice: trade.entryPrice,
				size: trade.shares,
				currentPrice,
				unrealizedPnl,
				expectedValue: (trade.side === "yes"
					? currentPrice - trade.entryPrice
					: (1 - currentPrice) - (1 - trade.entryPrice)
				) * trade.shares,
			};
		});
	}

	/**
	 * Get portfolio summary.
	 */
	getPortfolio(): PaperPortfolio {
		const resolved = this.trades.filter((t) => t.status === "resolved" || t.status === "closed");
		const open = this.trades.filter((t) => t.status === "open");

		return {
			trades: [...this.trades],
			totalInvested: this.trades.reduce((sum, t) => sum + t.size, 0),
			totalPnl: resolved.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
			winCount: resolved.filter((t) => (t.pnl ?? 0) > 0).length,
			lossCount: resolved.filter((t) => (t.pnl ?? 0) <= 0).length,
			openPositionCount: open.length,
			resolvedCount: resolved.length,
		};
	}

	/**
	 * Get P&L summary by time period.
	 */
	getPnLSummary(): {
		total: number;
		today: number;
		last7d: number;
		last30d: number;
		winRate: number;
		avgWin: number;
		avgLoss: number;
		profitFactor: number;
		peakEquity: number;
		maxDrawdown: number;
		maxDrawdownPct: number;
	} {
		const resolved = this.trades.filter((t) => t.status === "resolved" || t.status === "closed");
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;

		const todayTrades = resolved.filter((t) => (t.exitTimestamp ?? 0) > now - day);
		const weekTrades = resolved.filter((t) => (t.exitTimestamp ?? 0) > now - 7 * day);
		const monthTrades = resolved.filter((t) => (t.exitTimestamp ?? 0) > now - 30 * day);

		const wins = resolved.filter((t) => (t.pnl ?? 0) > 0);
		const losses = resolved.filter((t) => (t.pnl ?? 0) <= 0);

		const totalWins = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
		const totalLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));

		return {
			total: resolved.reduce((s, t) => s + (t.pnl ?? 0), 0),
			today: todayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
			last7d: weekTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
			last30d: monthTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
			winRate: resolved.length > 0 ? wins.length / resolved.length : 0,
			avgWin: wins.length > 0 ? totalWins / wins.length : 0,
			avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
			profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
			peakEquity: this.peakEquity,
			maxDrawdown: this.maxDrawdown,
			maxDrawdownPct: this.peakEquity > 0 ? this.maxDrawdown / this.peakEquity : 0,
		};
	}

	// ── Signal Quality Self-Evaluation (Cycle 012) ──

	/**
	 * Compute a Signal Quality Score (SQS) for each resolved signal.
	 * Composite metric: accuracy + calibration + profitability + edge quality.
	 *
	 * Returns per-signal scores AND an aggregate portfolio score.
	 * This enables automated self-evaluation: which signals actually work?
	 */
	getSignalQualityScores(): SignalQualityReport {
		const resolved = this.trades.filter((t) => t.status === "resolved");
		if (resolved.length === 0) {
			return {
				scores: [],
				aggregate: {
					compositeScore: 0,
					accuracyScore: 0,
					calibrationScore: 0,
					profitabilityScore: 0,
					edgeQualityScore: 0,
					sampleSize: 0,
				},
				byCategory: {},
			};
		}

		const scores: SignalQualityEntry[] = [];
		const categoryBuckets = new Map<string, SignalQualityEntry[]>();

		for (const trade of resolved) {
			const isWin = (trade.pnl ?? 0) > 0;
			const outcome = trade.outcome ?? (isWin ? 1 : 0);

			// Accuracy: did we pick the right side?
			const sideCorrect = (trade.side === "yes" && outcome === 1) || (trade.side === "no" && outcome === 0);
			const accuracyScore = sideCorrect ? 1 : 0;

			// Calibration: how close was entry price to actual outcome probability?
			// Perfect calibration: entry price of 0.70 on a YES side should win ~70% of the time
			// For individual trades, measure Brier-style: (entryPrice - outcome)^2
			// Lower is better, convert to 0-1 score where 1 = perfect
			const impliedProb = trade.side === "yes" ? trade.entryPrice : 1 - trade.entryPrice;
			const brierComponent = (impliedProb - outcome) ** 2;
			const calibrationScore = Math.max(0, 1 - brierComponent * 4); // scale: 0.25 brier -> 0 score

			// Profitability: normalized P&L relative to size risked
			const returnOnRisk = trade.size > 0 ? (trade.pnl ?? 0) / trade.size : 0;
			// Scale: -1 (total loss) to +max. Clamp to [0, 1] range
			const profitabilityScore = Math.max(0, Math.min(1, (returnOnRisk + 1) / 2));

			// Edge quality: how much edge was there at entry?
			// Higher entry price on YES side = less edge (paying more for the contract)
			// Score based on distance from 0.50 in the right direction
			const edgeMagnitude = sideCorrect
				? Math.abs(0.5 - trade.entryPrice) // correct side: bigger distance = more edge captured
				: 0; // wrong side: no edge credit
			const edgeQualityScore = Math.min(1, edgeMagnitude * 4); // 0.25 edge = full score

			// Composite SQS
			const compositeScore =
				accuracyScore * 0.30
				+ calibrationScore * 0.25
				+ profitabilityScore * 0.25
				+ edgeQualityScore * 0.20;

			const entry: SignalQualityEntry = {
				tradeId: trade.id,
				marketId: trade.marketId,
				category: trade.category,
				side: trade.side,
				entryPrice: trade.entryPrice,
				outcome,
				pnl: trade.pnl ?? 0,
				compositeScore: Math.round(compositeScore * 10000) / 10000,
				accuracyScore,
				calibrationScore: Math.round(calibrationScore * 10000) / 10000,
				profitabilityScore: Math.round(profitabilityScore * 10000) / 10000,
				edgeQualityScore: Math.round(edgeQualityScore * 10000) / 10000,
			};

			scores.push(entry);

			// Bucket by category
			const bucket = categoryBuckets.get(trade.category) ?? [];
			bucket.push(entry);
			categoryBuckets.set(trade.category, bucket);
		}

		// Aggregate scores
		const aggregate = computeAggregateQuality(scores);

		// Per-category aggregates
		const byCategory: Record<string, AggregateQuality> = {};
		for (const [cat, entries] of categoryBuckets) {
			byCategory[cat] = computeAggregateQuality(entries);
		}

		return { scores, aggregate, byCategory };
	}

	/**
	 * Get the best and worst performing signal categories.
	 * Use this to decide which categories to keep scanning and which to avoid.
	 */
	getCategoryRankings(): Array<{ category: string; compositeScore: number; sampleSize: number; totalPnl: number }> {
		const report = this.getSignalQualityScores();
		return Object.entries(report.byCategory)
			.map(([category, agg]) => ({
				category,
				compositeScore: agg.compositeScore,
				sampleSize: agg.sampleSize,
				totalPnl: report.scores
					.filter((s) => s.category === category)
					.reduce((sum, s) => sum + s.pnl, 0),
			}))
			.sort((a, b) => b.compositeScore - a.compositeScore);
	}

	getConfig(): PaperExecutorConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<PaperExecutorConfig>): void {
		Object.assign(this.config, updates);
	}
}

// ── Signal Quality Types (Cycle 012) ──

export interface SignalQualityEntry {
	tradeId: string;
	marketId: string;
	category: string;
	side: "yes" | "no";
	entryPrice: number;
	outcome: 0 | 1;
	pnl: number;
	/** Composite Signal Quality Score (0-1, higher = better) */
	compositeScore: number;
	/** Did the signal direction match the outcome? (0 or 1) */
	accuracyScore: number;
	/** How well-calibrated was the entry price? (0-1) */
	calibrationScore: number;
	/** Normalized P&L relative to risk (0-1) */
	profitabilityScore: number;
	/** How much edge existed at entry? (0-1) */
	edgeQualityScore: number;
}

export interface AggregateQuality {
	compositeScore: number;
	accuracyScore: number;
	calibrationScore: number;
	profitabilityScore: number;
	edgeQualityScore: number;
	sampleSize: number;
}

export interface SignalQualityReport {
	scores: SignalQualityEntry[];
	aggregate: AggregateQuality;
	byCategory: Record<string, AggregateQuality>;
}

function computeAggregateQuality(entries: SignalQualityEntry[]): AggregateQuality {
	if (entries.length === 0) {
		return { compositeScore: 0, accuracyScore: 0, calibrationScore: 0, profitabilityScore: 0, edgeQualityScore: 0, sampleSize: 0 };
	}

	const n = entries.length;
	return {
		compositeScore: Math.round((entries.reduce((s, e) => s + e.compositeScore, 0) / n) * 10000) / 10000,
		accuracyScore: Math.round((entries.reduce((s, e) => s + e.accuracyScore, 0) / n) * 10000) / 10000,
		calibrationScore: Math.round((entries.reduce((s, e) => s + e.calibrationScore, 0) / n) * 10000) / 10000,
		profitabilityScore: Math.round((entries.reduce((s, e) => s + e.profitabilityScore, 0) / n) * 10000) / 10000,
		edgeQualityScore: Math.round((entries.reduce((s, e) => s + e.edgeQualityScore, 0) / n) * 10000) / 10000,
		sampleSize: n,
	};
}
