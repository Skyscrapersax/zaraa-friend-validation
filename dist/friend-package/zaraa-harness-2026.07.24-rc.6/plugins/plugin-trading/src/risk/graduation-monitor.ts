/**
 * Graduation Monitor — REPORT-ONLY evaluator for live trading graduation.
 *
 * This module is deliberately pure-function and side-effect-free.  It NEVER
 * modifies any flag (`paperMode`, `autoExecuteLive`, `liveModeLock`) and never
 * writes to the database.  Its single job: given current trade-journal state
 * + the current stage + stage thresholds, emit a verdict.
 *
 * The full graduation policy (entry / halt / advance criteria for Stages A/B/C)
 * is documented in `docs/plans/live-trading-graduation.md`.  This module
 * encodes the *paper-readiness* and *advance* criteria so operators have an
 * objective check before they consider any manual transition.
 *
 * Stage transitions remain manual — there is no API in this module that
 * would automate flipping a real-money switch.
 */

export type GraduationStage = "PAPER" | "A" | "B" | "C" | "POST_C";

/** A single closed trade pulled from the trade journal. */
export interface ClosedTradeRow {
	strategyName: string;
	symbol: string;
	pnl: number;
	rMultiple: number | null;
	enteredAt: string;
	exitedAt: string | null;
	regime?: string | null;
	isShadow?: number;
}

export interface StageThresholds {
	/** Min consecutive trading days at the stage before advancing. */
	minDaysAtStage: number;
	/** Min closed trades at the stage. */
	minClosedTrades: number;
	/** Min realized cumulative PnL since stage start (USD). */
	minPnlUsd: number;
	/** Min average R-multiple over stage trades. */
	minAvgR: number;
	/** Min win rate, computed as W / (W + L) excluding break-even. */
	minWinRate: number;
	/** Max average slippage in basis points (live data). */
	maxAvgSlippageBps: number;
	/** Max consecutive losing trades allowed. */
	maxConsecutiveLosses: number;
}

export interface PaperReadinessThresholds {
	minDaysOfPaperData: number;
	minClosedPaperTrades: number;
	minPaperPnlUsd: number;
	minAvgRPaper: number;
	minWinRatePaper: number;
	allowedStrategies: string[];
	allowedSymbols: string[];
	excludedSymbols: string[];
}

export interface PromotionEvidence {
	/** Confirms the candidate sample came from paper/shadow-only execution. */
	paperOnly?: boolean;
	/** Confirms market data used for the candidate signal set was fresh. */
	marketDataFresh?: boolean;
	/** Current paper exposure before promotion. */
	currentExposureUsd?: number;
	/** Max allowed paper exposure for promotion. */
	maxExposureUsd?: number;
	/** Fraction of eligible paper trades with strategy/symbol/regime attribution. */
	attributionCoverage?: number;
	/** Minimum attribution coverage required. Defaults to 90%. */
	minAttributionCoverage?: number;
}

export interface GraduationVerdict {
	stage: GraduationStage;
	canAdvance: boolean;
	advanceTo: GraduationStage | null;
	reasons: string[];
	blockers: string[];
	stats: {
		stageTrades: number;
		stageDays: number;
		stagePnlUsd: number;
		stageAvgR: number;
		stageWinRate: number;
		stageConsecutiveLosses: number;
	};
	paperStats: {
		totalTrades: number;
		paperPnl: number;
		avgR: number;
		winRate: number;
		daysOfData: number;
	};
}

export interface MonitorInput {
	/** Current declared stage. */
	stage: GraduationStage;
	/** All closed trades from the journal (paper + live). */
	allTrades: ClosedTradeRow[];
	/** Subset of trades considered "live" (not paper) — empty array if still in PAPER. */
	liveTrades: ClosedTradeRow[];
	/** ISO date when the current stage started. Required for stages A/B/C. */
	stageStartedAt?: string;
	/** Live slippage average in basis points (caller computes). */
	liveAvgSlippageBps?: number;
	/** Whether any circuit breaker has tripped during the current stage window. */
	circuitBreakerTrippedDuringStage?: boolean;
	/** Whether the daily-rotating live-mode lock is valid for today. */
	liveModeLockValid?: boolean;
	/** Whether the pre-live checklist passes. */
	preLiveChecklistPassed?: boolean;
	/** Explicit safety evidence required before PAPER can graduate. */
	promotionEvidence?: PromotionEvidence;
	/** Override default thresholds for testing or policy tuning. */
	stageThresholds?: Partial<Record<Exclude<GraduationStage, "PAPER" | "POST_C">, StageThresholds>>;
	paperReadiness?: Partial<PaperReadinessThresholds>;
}

export const DEFAULT_PAPER_READINESS: PaperReadinessThresholds = {
	minDaysOfPaperData: 30,
	minClosedPaperTrades: 100,
	minPaperPnlUsd: 0,
	minAvgRPaper: 0.2,
	minWinRatePaper: 0.6,
	allowedStrategies: ["ensemble(mean-reversion)"],
	allowedSymbols: ["SOL_USDT", "XLM_USDT"],
	excludedSymbols: ["ETH_USDT"],
};

export const DEFAULT_STAGE_THRESHOLDS: Record<
	Exclude<GraduationStage, "PAPER" | "POST_C">,
	StageThresholds
> = {
	A: {
		minDaysAtStage: 7,
		minClosedTrades: 15,
		minPnlUsd: 0,
		minAvgR: 0.15,
		minWinRate: 0.5,
		maxAvgSlippageBps: 30,
		maxConsecutiveLosses: 5,
	},
	B: {
		minDaysAtStage: 14,
		minClosedTrades: 40,
		minPnlUsd: 2.0,
		minAvgR: 0.18,
		minWinRate: 0.5,
		maxAvgSlippageBps: 30,
		maxConsecutiveLosses: 5,
	},
	C: {
		minDaysAtStage: 30,
		minClosedTrades: 100,
		minPnlUsd: 25.0,
		minAvgR: 0.2,
		minWinRate: 0.5,
		maxAvgSlippageBps: 30,
		maxConsecutiveLosses: 5,
	},
};

interface AggregateStats {
	trades: number;
	pnl: number;
	avgR: number;
	winRate: number;
	consecutiveLosses: number;
	daysSpanned: number;
}

function aggregate(trades: ClosedTradeRow[], stageStartedAt?: string): AggregateStats {
	const filtered = trades.filter((t) => {
		if (!stageStartedAt) return true;
		return t.enteredAt >= stageStartedAt;
	});
	if (filtered.length === 0) {
		return { trades: 0, pnl: 0, avgR: 0, winRate: 0, consecutiveLosses: 0, daysSpanned: 0 };
	}
	let pnl = 0;
	let rSum = 0;
	let rCount = 0;
	let wins = 0;
	let losses = 0;
	let consec = 0;
	let maxConsec = 0;
	const days = new Set<string>();
	const sorted = [...filtered].sort((a, b) => a.enteredAt.localeCompare(b.enteredAt));
	for (const t of sorted) {
		pnl += t.pnl;
		if (typeof t.rMultiple === "number" && Number.isFinite(t.rMultiple)) {
			rSum += t.rMultiple;
			rCount += 1;
		}
		if (t.pnl > 0) {
			wins += 1;
			consec = 0;
		} else if (t.pnl < 0) {
			losses += 1;
			consec += 1;
			if (consec > maxConsec) maxConsec = consec;
		}
		days.add(t.enteredAt.slice(0, 10));
	}
	const decided = wins + losses;
	const winRate = decided === 0 ? 0 : wins / decided;
	return {
		trades: filtered.length,
		pnl,
		avgR: rCount === 0 ? 0 : rSum / rCount,
		winRate,
		consecutiveLosses: maxConsec,
		daysSpanned: days.size,
	};
}

function nextStage(stage: GraduationStage): GraduationStage | null {
	switch (stage) {
		case "PAPER":
			return "A";
		case "A":
			return "B";
		case "B":
			return "C";
		case "C":
			return "POST_C";
		default:
			return null;
	}
}

/**
 * Pure evaluator.  Returns a verdict object describing whether the current
 * stage should be allowed to advance, and why / why not.
 *
 * The caller (CLI / dashboard / operator) is responsible for taking action
 * based on this verdict.  This function performs no I/O.
 */
export function evaluateGraduation(input: MonitorInput): GraduationVerdict {
	const paperReadiness: PaperReadinessThresholds = {
		...DEFAULT_PAPER_READINESS,
		...(input.paperReadiness ?? {}),
	};
	const thresholds = {
		...DEFAULT_STAGE_THRESHOLDS,
		...(input.stageThresholds ?? {}),
	} as Record<Exclude<GraduationStage, "PAPER" | "POST_C">, StageThresholds>;

	const reasons: string[] = [];
	const blockers: string[] = [];

	const allowedStratSet = new Set(paperReadiness.allowedStrategies);
	const allowedSymSet = new Set(paperReadiness.allowedSymbols);
	const excludedSymSet = new Set(paperReadiness.excludedSymbols);

	const eligiblePaperTrades = input.allTrades.filter(
		(t) =>
			allowedStratSet.has(t.strategyName) &&
			allowedSymSet.has(t.symbol) &&
			!excludedSymSet.has(t.symbol),
	);
	const paperAgg = aggregate(eligiblePaperTrades);
	const paperStats = {
		totalTrades: paperAgg.trades,
		paperPnl: paperAgg.pnl,
		avgR: paperAgg.avgR,
		winRate: paperAgg.winRate,
		daysOfData: paperAgg.daysSpanned,
	};

	const stageAgg = aggregate(input.liveTrades, input.stageStartedAt);

	const verdict: GraduationVerdict = {
		stage: input.stage,
		canAdvance: false,
		advanceTo: nextStage(input.stage),
		reasons,
		blockers,
		stats: {
			stageTrades: stageAgg.trades,
			stageDays: stageAgg.daysSpanned,
			stagePnlUsd: stageAgg.pnl,
			stageAvgR: stageAgg.avgR,
			stageWinRate: stageAgg.winRate,
			stageConsecutiveLosses: stageAgg.consecutiveLosses,
		},
		paperStats,
	};

	if (input.stage === "POST_C") {
		blockers.push("POST_C is the terminal automated stage. Further scaling requires manual policy review.");
		return verdict;
	}

	if (input.stage === "PAPER") {
		const evidence = input.promotionEvidence;
		const currentExposure = evidence?.currentExposureUsd;
		const maxExposure = evidence?.maxExposureUsd;
		const exposureKnown =
			typeof currentExposure === "number" &&
			Number.isFinite(currentExposure) &&
			typeof maxExposure === "number" &&
			Number.isFinite(maxExposure) &&
			maxExposure > 0;
		const attributionCoverage = evidence?.attributionCoverage;
		const minAttributionCoverage = evidence?.minAttributionCoverage ?? 0.9;
		const attributionKnown =
			typeof attributionCoverage === "number" &&
			Number.isFinite(attributionCoverage);
		const checks: Array<{ ok: boolean; msg: string }> = [
			{
				ok: paperAgg.daysSpanned >= paperReadiness.minDaysOfPaperData,
				msg: `Days of paper data: ${paperAgg.daysSpanned} (need ≥ ${paperReadiness.minDaysOfPaperData}).`,
			},
			{
				ok: paperAgg.trades >= paperReadiness.minClosedPaperTrades,
				msg: `Eligible paper trades: ${paperAgg.trades} (need ≥ ${paperReadiness.minClosedPaperTrades}).`,
			},
			{
				ok: paperAgg.pnl >= paperReadiness.minPaperPnlUsd,
				msg: `Paper PnL: $${paperAgg.pnl.toFixed(2)} (need ≥ $${paperReadiness.minPaperPnlUsd.toFixed(2)}).`,
			},
			{
				ok: paperAgg.avgR >= paperReadiness.minAvgRPaper,
				msg: `Paper avg R: ${paperAgg.avgR.toFixed(3)} (need ≥ ${paperReadiness.minAvgRPaper}).`,
			},
			{
				ok: paperAgg.winRate >= paperReadiness.minWinRatePaper,
				msg: `Paper win rate: ${(paperAgg.winRate * 100).toFixed(1)}% (need ≥ ${(paperReadiness.minWinRatePaper * 100).toFixed(0)}%).`,
			},
			{
				ok: input.preLiveChecklistPassed === true,
				msg: input.preLiveChecklistPassed
					? "Pre-live checklist passed."
					: "Pre-live checklist not passed (run evaluatePreLiveChecklist).",
			},
			{
				ok: input.liveModeLockValid === true,
				msg: input.liveModeLockValid
					? "Live-mode lock valid for today."
					: "Live-mode lock missing or stale.",
			},
			{
				ok: evidence?.paperOnly === true,
				msg: evidence?.paperOnly === true
					? "Paper-only evidence confirms no live fills in the promotion sample."
					: "Missing paper-only evidence for promotion sample.",
			},
			{
				ok: evidence?.marketDataFresh === true,
				msg: evidence?.marketDataFresh === true
					? "Market data freshness evidence passed."
					: "Market data freshness evidence missing or stale.",
			},
			{
				ok: exposureKnown && currentExposure <= maxExposure,
				msg: exposureKnown
					? `Exposure: $${currentExposure.toFixed(2)} (limit $${maxExposure.toFixed(2)}).`
					: "Exposure evidence missing or invalid.",
			},
			{
				ok:
					attributionKnown &&
					attributionCoverage >= minAttributionCoverage,
				msg: attributionKnown
					? `Attribution coverage: ${(attributionCoverage * 100).toFixed(1)}% (need ≥ ${(minAttributionCoverage * 100).toFixed(0)}%).`
					: "Attribution evidence missing or invalid.",
			},
		];

		for (const c of checks) {
			if (c.ok) reasons.push(c.msg);
			else blockers.push(c.msg);
		}
		verdict.canAdvance = blockers.length === 0;
		return verdict;
	}

	const t = thresholds[input.stage];
	if (!t) {
		blockers.push(`No thresholds defined for stage ${input.stage}.`);
		return verdict;
	}

	const stageChecks: Array<{ ok: boolean; msg: string }> = [
		{
			ok: stageAgg.daysSpanned >= t.minDaysAtStage,
			msg: `Days at stage ${input.stage}: ${stageAgg.daysSpanned} (need ≥ ${t.minDaysAtStage}).`,
		},
		{
			ok: stageAgg.trades >= t.minClosedTrades,
			msg: `Closed trades at stage ${input.stage}: ${stageAgg.trades} (need ≥ ${t.minClosedTrades}).`,
		},
		{
			ok: stageAgg.pnl >= t.minPnlUsd,
			msg: `Stage PnL: $${stageAgg.pnl.toFixed(2)} (need ≥ $${t.minPnlUsd.toFixed(2)}).`,
		},
		{
			ok: stageAgg.avgR >= t.minAvgR,
			msg: `Stage avg R: ${stageAgg.avgR.toFixed(3)} (need ≥ ${t.minAvgR}).`,
		},
		{
			ok: stageAgg.winRate >= t.minWinRate,
			msg: `Stage win rate: ${(stageAgg.winRate * 100).toFixed(1)}% (need ≥ ${(t.minWinRate * 100).toFixed(0)}%).`,
		},
		{
			ok: stageAgg.consecutiveLosses < t.maxConsecutiveLosses,
			msg: `Max consecutive losses: ${stageAgg.consecutiveLosses} (must be < ${t.maxConsecutiveLosses}).`,
		},
		{
			ok:
				input.liveAvgSlippageBps === undefined ||
				input.liveAvgSlippageBps <= t.maxAvgSlippageBps,
			msg:
				input.liveAvgSlippageBps === undefined
					? "Slippage data not provided (assumed within bounds)."
					: `Avg live slippage: ${input.liveAvgSlippageBps.toFixed(1)}bps (need ≤ ${t.maxAvgSlippageBps}bps).`,
		},
		{
			ok: !input.circuitBreakerTrippedDuringStage,
			msg: input.circuitBreakerTrippedDuringStage
				? "Circuit breaker tripped during this stage — graduation blocked."
				: "No circuit breaker trips during this stage.",
		},
	];

	for (const c of stageChecks) {
		if (c.ok) reasons.push(c.msg);
		else blockers.push(c.msg);
	}

	verdict.canAdvance = blockers.length === 0;
	return verdict;
}

/** Render a verdict as a human-readable report (multi-line string). */
export function formatGraduationReport(verdict: GraduationVerdict): string {
	const lines: string[] = [];
	lines.push("=".repeat(70));
	lines.push(`  GRADUATION MONITOR — Stage ${verdict.stage}`);
	lines.push("=".repeat(70));
	lines.push("");
	if (verdict.stage === "PAPER") {
		lines.push("Paper readiness check:");
		lines.push(`  total eligible paper trades: ${verdict.paperStats.totalTrades}`);
		lines.push(`  days of paper data:          ${verdict.paperStats.daysOfData}`);
		lines.push(`  paper avg R:                 ${verdict.paperStats.avgR.toFixed(3)}`);
		lines.push(`  paper win rate:              ${(verdict.paperStats.winRate * 100).toFixed(1)}%`);
		lines.push(`  paper PnL (USD):             $${verdict.paperStats.paperPnl.toFixed(2)}`);
	} else {
		lines.push(`Current stage stats:`);
		lines.push(`  trades:              ${verdict.stats.stageTrades}`);
		lines.push(`  days at stage:       ${verdict.stats.stageDays}`);
		lines.push(`  PnL (USD):           $${verdict.stats.stagePnlUsd.toFixed(2)}`);
		lines.push(`  avg R-multiple:      ${verdict.stats.stageAvgR.toFixed(3)}`);
		lines.push(`  win rate:            ${(verdict.stats.stageWinRate * 100).toFixed(1)}%`);
		lines.push(`  max consec losses:   ${verdict.stats.stageConsecutiveLosses}`);
	}
	lines.push("");
	if (verdict.reasons.length > 0) {
		lines.push("Passing checks:");
		for (const r of verdict.reasons) lines.push(`  [PASS] ${r}`);
		lines.push("");
	}
	if (verdict.blockers.length > 0) {
		lines.push("Blockers:");
		for (const b of verdict.blockers) lines.push(`  [BLOCK] ${b}`);
		lines.push("");
	}
	lines.push(
		`Verdict: ${verdict.canAdvance ? "READY TO ADVANCE" : "NOT READY"} ` +
			`${verdict.advanceTo ? `→ ${verdict.advanceTo}` : ""}`,
	);
	lines.push("");
	lines.push(
		"This is REPORT ONLY.  No flags will be modified.  Operator must manually update " +
			"zaraa.config.json (paperMode, liveModeLock) and restart daemons to graduate.",
	);
	lines.push("=".repeat(70));
	return lines.join("\n");
}
