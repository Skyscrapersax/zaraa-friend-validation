/**
 * Dual-desk media CTA aggressiveness (harvest ZLW-T0350 + media-trade dual desk).
 *
 * When the paper risk desk is in drawdown, suppress aggressive money CTAs.
 * Pure helper — never posts, never trades. Content guidance only.
 */

export type MediaCtaMode = "full" | "soft" | "education_only";

/** Drawdown % at/above which urgency/money CTAs soften. */
export const DUAL_DESK_SOFT_DRAWDOWN_PCT = 3;
/** Drawdown % at/above which only education/entertainment CTAs allowed. */
export const DUAL_DESK_EDUCATION_DRAWDOWN_PCT = 6;

export interface DualDeskCtaInput {
	/** Must be true for any mode other than education_only (live desk never drives media money CTAs). */
	paperMode: boolean;
	/** Session/portfolio drawdown percent (0–100). Null/undefined → full when paper. */
	drawdownPct?: number | null;
	/** Hard halt (circuit / kill) — force education-only. */
	tradingHalted?: boolean;
}

export interface DualDeskCtaResult {
	mode: MediaCtaMode;
	/** Allowed CTA types for caption packs. */
	allowedCtaTypes: Array<"direct" | "question" | "urgency" | "education">;
	suppressAggressiveMoney: boolean;
	reason: string;
	paperOnly: true;
	thresholds: {
		softDrawdownPct: number;
		educationDrawdownPct: number;
	};
}

/**
 * Map paper desk health → media CTA aggressiveness.
 * Live mode always education_only (no money CTAs driven by live risk signals).
 */
export function resolveDualDeskCtaMode(input: DualDeskCtaInput): DualDeskCtaResult {
	const thresholds = {
		softDrawdownPct: DUAL_DESK_SOFT_DRAWDOWN_PCT,
		educationDrawdownPct: DUAL_DESK_EDUCATION_DRAWDOWN_PCT,
	};

	if (!input.paperMode) {
		return {
			mode: "education_only",
			allowedCtaTypes: ["education", "question"],
			suppressAggressiveMoney: true,
			reason: "live mode — media never uses money CTAs from risk desk",
			paperOnly: true,
			thresholds,
		};
	}

	if (input.tradingHalted) {
		return {
			mode: "education_only",
			allowedCtaTypes: ["education", "question"],
			suppressAggressiveMoney: true,
			reason: "paper desk halted — education/entertainment CTAs only",
			paperOnly: true,
			thresholds,
		};
	}

	const dd =
		input.drawdownPct != null && Number.isFinite(input.drawdownPct)
			? Math.max(0, input.drawdownPct)
			: 0;

	if (dd >= DUAL_DESK_EDUCATION_DRAWDOWN_PCT) {
		return {
			mode: "education_only",
			allowedCtaTypes: ["education", "question"],
			suppressAggressiveMoney: true,
			reason: `paper drawdown ${dd.toFixed(1)}% ≥ ${DUAL_DESK_EDUCATION_DRAWDOWN_PCT}% — no money/urgency CTAs`,
			paperOnly: true,
			thresholds,
		};
	}

	if (dd >= DUAL_DESK_SOFT_DRAWDOWN_PCT) {
		return {
			mode: "soft",
			allowedCtaTypes: ["direct", "question", "education"],
			suppressAggressiveMoney: true,
			reason: `paper drawdown ${dd.toFixed(1)}% ≥ ${DUAL_DESK_SOFT_DRAWDOWN_PCT}% — soft CTAs only (no urgency money)`,
			paperOnly: true,
			thresholds,
		};
	}

	return {
		mode: "full",
		allowedCtaTypes: ["direct", "question", "urgency", "education"],
		suppressAggressiveMoney: false,
		reason: "paper desk healthy — full CTA pack allowed (still no return promises)",
		paperOnly: true,
		thresholds,
	};
}
