/**
 * Regime reconciliation — bridges the two parallel regime detectors:
 *
 *   1. ADX-based (mathematical, per-bar) — produced from the current ADX
 *      reading (see mean-reversion's `applyMeanReversionRegimeGate`).
 *   2. MarketContextProvider (pattern-based, hour-bucketed) — distilled
 *      from MarketLearner pattern observations.
 *
 * They use different vocabularies and can disagree. This module:
 *   - Normalizes both into a single `ReconciledRegimeKind`.
 *   - Picks the more conservative (higher-risk) regime on disagreement.
 *   - Returns a confidence multiplier strategies should apply when the
 *     signals conflict, since conflicting signals should size smaller.
 */
import type { MarketContext } from "./market-context.js";

export type ReconciledRegimeKind = "ranging" | "trending" | "volatile" | "neutral";

export interface AdxRegimeInput {
	kind: ReconciledRegimeKind;
}

export interface PatternRegimeInput {
	kind: ReconciledRegimeKind;
	direction: "up" | "down" | null;
	confidence: number;
}

export interface ReconciliationResult {
	regime: ReconciledRegimeKind;
	agreed: boolean;
	confidenceMultiplier: number;
	direction?: "up" | "down" | null;
}

/**
 * Risk ranking — higher = more conservative regime to assume.
 *
 *   volatile > trending > ranging > neutral
 *
 * On disagreement we pick the higher-ranked regime so that mean-reversion
 * strategies don't take signals during a learner-flagged trend just
 * because ADX happens to read low at that moment, and trend strategies
 * don't get suckered into a chop tape.
 */
const RISK_RANK: Record<ReconciledRegimeKind, number> = {
	neutral: 0,
	ranging: 1,
	trending: 2,
	volatile: 3,
};

/** Confidence multiplier applied to a signal when the two detectors disagree. */
export const DISAGREEMENT_CONFIDENCE_DISCOUNT = 0.8;

// ADX classification thresholds — match mean-reversion's gate spec.
const ADX_RANGING_MAX = 20;
const ADX_TRENDING_MIN = 25;
const ADX_VOLATILE_MIN = 35;

/**
 * Map a raw ADX reading into a normalized regime bucket.
 *
 * Returns null when ADX is missing/invalid OR sits inside the ambiguous
 * 20–25 band — both mean "no actionable opinion", which is semantically
 * cleaner than a "neutral" kind that would manufacture spurious
 * disagreements with a confident pattern source.
 */
export function classifyAdxRegime(adx: number | null | undefined): AdxRegimeInput | null {
	if (adx == null || !Number.isFinite(adx)) return null;
	if (adx >= ADX_VOLATILE_MIN) return { kind: "volatile" };
	if (adx >= ADX_TRENDING_MIN) return { kind: "trending" };
	if (adx < ADX_RANGING_MAX) return { kind: "ranging" };
	return null;
}

/**
 * Map a MarketContext into a normalized regime bucket.
 *
 * Returns null when the context is missing, the pattern regime is
 * "neutral" (the learner has nothing to say), or the pattern confidence
 * is below `minConfidence` (the learner's vote is too weak to weigh
 * against ADX). Same rationale as classifyAdxRegime.
 */
export function classifyPatternRegime(
	context: MarketContext | null | undefined,
	minConfidence = 0,
): PatternRegimeInput | null {
	if (!context) return null;
	if (context.regimeConfidence < minConfidence) return null;
	switch (context.regime) {
		case "trending_up":
			return { kind: "trending", direction: "up", confidence: context.regimeConfidence };
		case "trending_down":
			return { kind: "trending", direction: "down", confidence: context.regimeConfidence };
		case "ranging":
			return { kind: "ranging", direction: null, confidence: context.regimeConfidence };
		case "neutral":
		default:
			return null;
	}
}

/**
 * Reconcile ADX-based and pattern-based regime classifications.
 *
 * Returns the regime to act on, whether the two agreed, and a confidence
 * multiplier (1.0 when agreed or only one source is available, 0.8 when
 * they disagreed).
 */
export function reconcileRegime(
	adx: AdxRegimeInput | null | undefined,
	pattern: PatternRegimeInput | null | undefined,
): ReconciliationResult {
	if (!adx && !pattern) {
		return { regime: "neutral", agreed: true, confidenceMultiplier: 1.0 };
	}
	if (!adx && pattern) {
		return {
			regime: pattern.kind,
			agreed: true,
			confidenceMultiplier: 1.0,
			direction: pattern.direction,
		};
	}
	if (adx && !pattern) {
		return { regime: adx.kind, agreed: true, confidenceMultiplier: 1.0 };
	}

	// Both present.
	const a = adx as AdxRegimeInput;
	const p = pattern as PatternRegimeInput;

	if (a.kind === p.kind) {
		return {
			regime: a.kind,
			agreed: true,
			confidenceMultiplier: 1.0,
			direction: p.direction,
		};
	}

	const winner = RISK_RANK[a.kind] >= RISK_RANK[p.kind] ? a.kind : p.kind;
	return {
		regime: winner,
		agreed: false,
		confidenceMultiplier: DISAGREEMENT_CONFIDENCE_DISCOUNT,
		direction: winner === p.kind ? p.direction : undefined,
	};
}
