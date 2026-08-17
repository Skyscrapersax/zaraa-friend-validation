/**
 * Paper stop-loss decision tree (harvest ZLW-T0319 / ZLW-T0343).
 *
 * Plain style thresholds for paperMode suggestions only.
 * Never mutates live orders; refuses to emit exit/reduce when paperMode is false.
 */

export type TradeStyle = "scalp" | "swing" | "position";
export type StopLossAction = "hold" | "reduce" | "exit" | "blocked";

/** Version string surfaced on status endpoints for operator audit. */
export const PAPER_SL_TREE_VERSION = "sl_tree/v1";

export interface PaperStopLossTreeConfig {
	/** % below entry (long) / above entry (short) that triggers exit. */
	hardStopPct: Record<TradeStyle, number>;
	/** Intermediate reduce threshold as fraction of hard stop (0–1). Default 0.6. */
	reduceFraction: number;
	version: string;
}

/** Harvest defaults: 2% scalp / 5% swing / 8% position. */
export const DEFAULT_PAPER_SL_TREE: PaperStopLossTreeConfig = {
	hardStopPct: {
		scalp: 2,
		swing: 5,
		position: 8,
	},
	reduceFraction: 0.6,
	version: PAPER_SL_TREE_VERSION,
};

export interface PaperStopLossCheckInput {
	/** Must be true — live mode always returns blocked. */
	paperMode: boolean;
	style: TradeStyle;
	side: "long" | "short";
	entryPrice: number;
	currentPrice: number;
	/** Optional override tree (e.g. from config). */
	tree?: Partial<PaperStopLossTreeConfig>;
}

export interface PaperStopLossCheckResult {
	action: StopLossAction;
	style: TradeStyle;
	/** Adverse move from entry as a percent (always ≥ 0 when adverse). */
	adversePct: number;
	hardStopPct: number;
	reduceAtPct: number;
	version: string;
	reason: string;
}

function mergeTree(partial?: Partial<PaperStopLossTreeConfig>): PaperStopLossTreeConfig {
	return {
		hardStopPct: {
			...DEFAULT_PAPER_SL_TREE.hardStopPct,
			...(partial?.hardStopPct ?? {}),
		},
		reduceFraction:
			partial?.reduceFraction ?? DEFAULT_PAPER_SL_TREE.reduceFraction,
		version: partial?.version ?? DEFAULT_PAPER_SL_TREE.version,
	};
}

function adverseMovePct(
	side: "long" | "short",
	entryPrice: number,
	currentPrice: number,
): number {
	if (!(entryPrice > 0) || !(currentPrice > 0)) return 0;
	if (side === "long") {
		return Math.max(0, ((entryPrice - currentPrice) / entryPrice) * 100);
	}
	return Math.max(0, ((currentPrice - entryPrice) / entryPrice) * 100);
}

/**
 * Evaluate paper stop-loss tree for one position snapshot.
 * Returns hold / reduce / exit suggestion — never executes.
 */
export function checkPaperStopLoss(
	input: PaperStopLossCheckInput,
): PaperStopLossCheckResult {
	const tree = mergeTree(input.tree);
	const hard = tree.hardStopPct[input.style];
	const reduceAt = hard * tree.reduceFraction;

	const base = {
		style: input.style,
		hardStopPct: hard,
		reduceAtPct: reduceAt,
		version: tree.version,
	};

	if (!input.paperMode) {
		return {
			...base,
			action: "blocked",
			adversePct: 0,
			reason: "paperMode required — live execution refused by stop-loss tree",
		};
	}

	if (
		!Number.isFinite(input.entryPrice) ||
		!Number.isFinite(input.currentPrice) ||
		input.entryPrice <= 0 ||
		input.currentPrice <= 0
	) {
		return {
			...base,
			action: "hold",
			adversePct: 0,
			reason: "invalid prices — hold pending good quote",
		};
	}

	const adversePct = adverseMovePct(
		input.side,
		input.entryPrice,
		input.currentPrice,
	);

	if (adversePct >= hard) {
		return {
			...base,
			action: "exit",
			adversePct,
			reason: `adverse ${adversePct.toFixed(2)}% ≥ hardStop ${hard}% (${input.style})`,
		};
	}
	if (adversePct >= reduceAt) {
		return {
			...base,
			action: "reduce",
			adversePct,
			reason: `adverse ${adversePct.toFixed(2)}% ≥ reduceAt ${reduceAt.toFixed(2)}% (${input.style})`,
		};
	}
	return {
		...base,
		action: "hold",
		adversePct,
		reason: `adverse ${adversePct.toFixed(2)}% < reduceAt ${reduceAt.toFixed(2)}% — hold`,
	};
}

/**
 * Batch-check open paper positions. Live (paperMode=false) returns all blocked.
 */
export function checkPaperStopLossBatch(
	paperMode: boolean,
	positions: Array<{
		id: string;
		style: TradeStyle;
		side: "long" | "short";
		entryPrice: number;
		currentPrice: number;
	}>,
	tree?: Partial<PaperStopLossTreeConfig>,
): Array<{ id: string } & PaperStopLossCheckResult> {
	return positions.map((p) => ({
		id: p.id,
		...checkPaperStopLoss({
			paperMode,
			style: p.style,
			side: p.side,
			entryPrice: p.entryPrice,
			currentPrice: p.currentPrice,
			tree,
		}),
	}));
}

/** Compact status blob for runtime/operator dashboards. */
export function getPaperStopLossTreeStatus(
	tree?: Partial<PaperStopLossTreeConfig>,
): {
	version: string;
	hardStopPct: Record<TradeStyle, number>;
	reduceFraction: number;
	paperOnly: true;
} {
	const merged = mergeTree(tree);
	return {
		version: merged.version,
		hardStopPct: { ...merged.hardStopPct },
		reduceFraction: merged.reduceFraction,
		paperOnly: true,
	};
}

export interface PaperSlScenarioResult {
	name: string;
	pass: boolean;
	expected: StopLossAction;
	actual: StopLossAction;
	reason: string;
}

/**
 * Harvest monthly-style paper SL scenario battery (never executes trades).
 * Returns per-scenario pass/fail for operator / CI self-check.
 */
export function runPaperStopLossScenarios(
	tree?: Partial<PaperStopLossTreeConfig>,
): {
	version: string;
	passed: number;
	failed: number;
	results: PaperSlScenarioResult[];
	paperOnly: true;
} {
	const merged = mergeTree(tree);
	const cases: Array<{
		name: string;
		expected: StopLossAction;
		input: PaperStopLossCheckInput;
	}> = [
		{
			name: "live-blocked",
			expected: "blocked",
			input: {
				paperMode: false,
				style: "swing",
				side: "long",
				entryPrice: 100,
				currentPrice: 90,
				tree: merged,
			},
		},
		{
			name: "swing-hold-1pct",
			expected: "hold",
			input: {
				paperMode: true,
				style: "swing",
				side: "long",
				entryPrice: 100,
				currentPrice: 99,
				tree: merged,
			},
		},
		{
			// reduce at 0.6 * 5% = 3%
			name: "swing-reduce-3pct",
			expected: "reduce",
			input: {
				paperMode: true,
				style: "swing",
				side: "long",
				entryPrice: 100,
				currentPrice: 96.5,
				tree: merged,
			},
		},
		{
			name: "swing-exit-5pct",
			expected: "exit",
			input: {
				paperMode: true,
				style: "swing",
				side: "long",
				entryPrice: 100,
				currentPrice: 95,
				tree: merged,
			},
		},
		{
			name: "scalp-exit-2pct",
			expected: "exit",
			input: {
				paperMode: true,
				style: "scalp",
				side: "long",
				entryPrice: 100,
				currentPrice: 98,
				tree: merged,
			},
		},
		{
			name: "position-hold-4pct",
			expected: "hold",
			input: {
				paperMode: true,
				style: "position",
				side: "long",
				entryPrice: 100,
				currentPrice: 96,
				tree: merged,
			},
		},
		{
			name: "short-exit-on-rise",
			expected: "exit",
			input: {
				paperMode: true,
				style: "swing",
				side: "short",
				entryPrice: 100,
				currentPrice: 105.5,
				tree: merged,
			},
		},
	];

	const results: PaperSlScenarioResult[] = cases.map((c) => {
		const r = checkPaperStopLoss(c.input);
		return {
			name: c.name,
			pass: r.action === c.expected,
			expected: c.expected,
			actual: r.action,
			reason: r.reason,
		};
	});
	const failed = results.filter((r) => !r.pass).length;
	return {
		version: merged.version,
		passed: results.length - failed,
		failed,
		results,
		paperOnly: true,
	};
}

/**
 * Always-on invalidation level rule (harvest ZLW-T0331).
 * PaperMode only — never implies live order placement.
 * Long: exit if price ≤ invalidation; short: exit if price ≥ invalidation.
 */
export function checkPaperInvalidation(input: {
	paperMode: boolean;
	side: "long" | "short";
	currentPrice: number;
	/** Explicit thesis break level (required for a real check). */
	invalidationLevel: number | null | undefined;
}): {
	breached: boolean;
	action: "hold" | "exit" | "blocked" | "missing_level";
	reason: string;
	paperOnly: true;
} {
	if (!input.paperMode) {
		return {
			breached: false,
			action: "blocked",
			reason: "paperMode required — live invalidation auto-exit refused",
			paperOnly: true,
		};
	}
	const inv = input.invalidationLevel;
	if (inv == null || !Number.isFinite(inv) || inv <= 0) {
		return {
			breached: false,
			action: "missing_level",
			reason: "no invalidation level set — require invalidation before size-up",
			paperOnly: true,
		};
	}
	if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
		return {
			breached: false,
			action: "hold",
			reason: "invalid quote — hold pending good price",
			paperOnly: true,
		};
	}
	const breached =
		input.side === "long"
			? input.currentPrice <= inv
			: input.currentPrice >= inv;
	if (breached) {
		return {
			breached: true,
			action: "exit",
			reason: `price ${input.currentPrice} breached invalidation ${inv} (${input.side})`,
			paperOnly: true,
		};
	}
	return {
		breached: false,
		action: "hold",
		reason: `price ${input.currentPrice} inside invalidation ${inv}`,
		paperOnly: true,
	};
}
