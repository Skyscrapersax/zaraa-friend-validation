/**
 * MarketContextProvider — bridges learned patterns into strategy evaluation.
 *
 * The MarketLearner accumulates 200k+ market observations and distills them
 * into ~400 patterns (spread windows, momentum hours, imbalance shifts,
 * day patterns). This provider queries those patterns for the current
 * symbol/hour and infers a coarse regime, volatility level, and dominant
 * pattern set that strategies can use to skip, boost, or adjust signals.
 *
 * Reads are cached for 5 minutes per symbol to avoid DB thrashing on every
 * scan tick.
 */

/** Structural type — matches MarketLearner.getPatterns() to avoid circular deps. */
export interface PatternSource {
	getPatterns(pair?: string, minConfidence?: number): Array<{
		pair: string;
		type: string;
		confidence: number;
		hourOfDay: number | null;
		details: Record<string, unknown>;
		description: string;
		occurrences: number;
	}>;
}

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "neutral";

export type VolatilityLevel = "low" | "medium" | "high";

export interface DominantPattern {
	type: string;
	confidence: number;
	description: string;
}

export interface MarketContext {
	/** Current symbol in strategy form (e.g. "BTC_USDT"). */
	symbol: string;
	/** Inferred regime from patterns at the current UTC hour. */
	regime: MarketRegime;
	/** 0–1; how strongly the patterns vote for the chosen regime vs alternatives. */
	regimeConfidence: number;
	/** Coarse volatility bucket from spread-window patterns at this hour. */
	volatilityLevel: VolatilityLevel;
	/** Top patterns active at this hour, sorted by confidence. */
	dominantPatterns: DominantPattern[];
	/** Mean confidence across patterns that influenced the inference. */
	overallConfidence: number;
	/** When this context was computed (epoch ms). */
	computedAt: number;
	/** UTC hour this context describes. */
	hour: number;
}

interface CacheEntry {
	context: MarketContext;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const VOLATILE_TTL_MS = 60 * 1000;
const MIN_PATTERN_CONFIDENCE = 0.5;

export interface MarketContextProviderOptions {
	/** Cache TTL in ms for normal/ranging regimes. Default: 5 min. */
	ttlMs?: number;
	/**
	 * Shortened cache TTL for high-volatility regimes. Default: 60s.
	 * Fast-moving markets need fresher pattern reads — a stale 5-min
	 * regime label can be the difference between catching the move
	 * and entering against it.
	 */
	volatileTtlMs?: number;
	/** Minimum pattern confidence to consider. Default: 0.5. */
	minPatternConfidence?: number;
	/** Optional clock for deterministic tests. Default: () => Date.now(). */
	now?: () => number;
}

export class MarketContextProvider {
	private cache = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly volatileTtlMs: number;
	private readonly minConfidence: number;
	private readonly now: () => number;

	constructor(
		private readonly source: PatternSource,
		opts: MarketContextProviderOptions = {},
	) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.volatileTtlMs = opts.volatileTtlMs ?? VOLATILE_TTL_MS;
		this.minConfidence = opts.minPatternConfidence ?? MIN_PATTERN_CONFIDENCE;
		this.now = opts.now ?? (() => Date.now());
	}

	/**
	 * Get inferred market context for the given symbol. Returns null when
	 * the source has no patterns for this pair so callers can degrade
	 * gracefully (no context is not an error).
	 */
	getContext(symbol: string): MarketContext | null {
		const ts = this.now();
		const hour = new Date(ts).getUTCHours();
		const cacheKey = `${symbol}|${hour}`;

		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > ts) return cached.context;

		const pair = toPairFormat(symbol);
		let patterns: ReturnType<PatternSource["getPatterns"]>;
		try {
			patterns = this.source.getPatterns(pair, this.minConfidence);
		} catch {
			return null;
		}
		if (!patterns || patterns.length === 0) return null;

		const context = inferContext(symbol, hour, patterns, ts);
		const ttl = context.volatilityLevel === "high" ? this.volatileTtlMs : this.ttlMs;
		this.cache.set(cacheKey, { context, expiresAt: ts + ttl });
		return context;
	}

	/** Drop all cached contexts. Useful for tests. */
	clearCache(): void {
		this.cache.clear();
	}
}

/**
 * MarketLearner stores pairs as "BTC/USDT"; strategies pass "BTC_USDT".
 * Convert here so callers don't have to think about it.
 */
function toPairFormat(symbol: string): string {
	return symbol.includes("/") ? symbol : symbol.replace("_", "/");
}

function inferContext(
	symbol: string,
	hour: number,
	patterns: ReturnType<PatternSource["getPatterns"]>,
	now: number,
): MarketContext {
	// Only consider patterns active at the current UTC hour, plus
	// hour-agnostic patterns (hourOfDay === null), since most learned
	// patterns are time-of-day-bucketed.
	const active = patterns.filter((p) => p.hourOfDay === null || p.hourOfDay === hour);

	if (active.length === 0) {
		return {
			symbol,
			regime: "neutral",
			regimeConfidence: 0,
			volatilityLevel: "medium",
			dominantPatterns: [],
			overallConfidence: 0,
			computedAt: now,
			hour,
		};
	}

	// Vote per regime, weighted by pattern confidence.
	const votes: Record<MarketRegime, number> = {
		trending_up: 0,
		trending_down: 0,
		ranging: 0,
		neutral: 0,
	};

	let spreadObservations = 0;
	let spreadSum = 0;

	for (const p of active) {
		const w = p.confidence;
		if (p.type === "momentum_hour") {
			const dir = String(p.details.direction ?? "");
			if (dir === "up") votes.trending_up += w;
			else if (dir === "down") votes.trending_down += w;
		} else if (p.type === "imbalance_shift") {
			const dir = String(p.details.direction ?? "");
			const ratio = numeric(p.details.avgImbalance ?? p.details.avgRatio);
			// Treat strong sustained imbalance as a directional bias —
			// scaled half-weight relative to momentum_hour because
			// imbalance is a thinner signal than realized price movement.
			const buy = dir === "buy" || (Number.isFinite(ratio) && ratio > 1.5);
			const sell = dir === "sell" || (Number.isFinite(ratio) && ratio < 1 / 1.5 && ratio > 0);
			if (buy) votes.trending_up += w * 0.5;
			else if (sell) votes.trending_down += w * 0.5;
		} else if (p.type === "spread_window") {
			// Wide-spread windows are when market makers profit — these
			// hours tend to be ranging/illiquid rather than trending.
			votes.ranging += w;
			const avgSpread = numeric(p.details.avgSpreadPct);
			if (Number.isFinite(avgSpread)) {
				spreadObservations++;
				spreadSum += avgSpread;
			}
		} else if (p.type === "day_pattern") {
			const dir = String(p.details.direction ?? "");
			if (dir === "up") votes.trending_up += w * 0.5;
			else if (dir === "down") votes.trending_down += w * 0.5;
		}
	}

	const total = votes.trending_up + votes.trending_down + votes.ranging;
	let regime: MarketRegime = "neutral";
	let regimeConfidence = 0;
	if (total > 0) {
		const entries = Object.entries(votes) as Array<[MarketRegime, number]>;
		entries.sort((a, b) => b[1] - a[1]);
		const [topRegime, topWeight] = entries[0];
		if (topWeight > 0) {
			regime = topRegime;
			regimeConfidence = Math.min(topWeight / total, 1);
		}
	}

	// Volatility from observed spreads at this hour.
	let volatilityLevel: VolatilityLevel = "medium";
	if (spreadObservations > 0) {
		const avgSpread = spreadSum / spreadObservations;
		if (avgSpread < 1) volatilityLevel = "low";
		else if (avgSpread > 5) volatilityLevel = "high";
		else volatilityLevel = "medium";
	}

	const dominantPatterns: DominantPattern[] = active
		.slice()
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 5)
		.map((p) => ({ type: p.type, confidence: p.confidence, description: p.description }));

	const overallConfidence = active.reduce((sum, p) => sum + p.confidence, 0) / active.length;

	return {
		symbol,
		regime,
		regimeConfidence,
		volatilityLevel,
		dominantPatterns,
		overallConfidence,
		computedAt: now,
		hour,
	};
}

function numeric(v: unknown): number {
	return typeof v === "number" ? v : NaN;
}
