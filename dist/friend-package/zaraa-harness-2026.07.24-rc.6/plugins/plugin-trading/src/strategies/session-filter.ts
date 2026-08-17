/**
 * Trading Session Filter — Intraday session awareness for crypto markets.
 *
 * Crypto trades 24/7 but behavior differs by session:
 *
 *   Asian Session (00:00-08:00 UTC):
 *     - Lower volume, tighter ranges
 *     - Mean-reversion thrives, breakouts often fail
 *     - Key pairs: BTC, ETH, XRP (Asian market influence)
 *
 *   European Session (08:00-16:00 UTC):
 *     - Volume picks up, institutional flow
 *     - Breakouts more reliable, trends begin
 *     - Overlaps with late Asian session (08:00-09:00)
 *
 *   US Session (14:00-22:00 UTC):
 *     - Highest volume and volatility
 *     - Strong trends, momentum plays
 *     - Overlap with European session (14:00-16:00) is the highest-volume window
 *
 *   Off-hours (22:00-00:00 UTC):
 *     - Low liquidity, wider spreads
 *     - Higher risk of slippage and false signals
 *
 * The filter provides:
 *   1. Current session identification
 *   2. Strategy fitness scores per session
 *   3. Volume/volatility expectations for the current session
 *   4. Optimal entry windows (session overlaps)
 */

export type TradingSession = "asian" | "european" | "us" | "off_hours";

export interface SessionInfo {
	/** Current trading session */
	session: TradingSession;
	/** Whether we're in a session overlap (higher volume expected) */
	isOverlap: boolean;
	/** Which sessions overlap (empty if no overlap) */
	overlappingSessions: TradingSession[];
	/** Minutes until next session transition */
	minutesToNextSession: number;
	/** Per-strategy fitness score for the current session (0-1) */
	strategyFitness: Record<string, number>;
	/** Expected volume relative to daily average (0.5 = half, 1.5 = 150%) */
	expectedVolumeMultiplier: number;
	/** Human-readable description */
	description: string;
}

/** Session boundaries in UTC hours */
const SESSION_BOUNDARIES: Record<TradingSession, { start: number; end: number }> = {
	asian: { start: 0, end: 8 },
	european: { start: 8, end: 16 },
	us: { start: 14, end: 22 },
	off_hours: { start: 22, end: 24 }, // wraps to 0
};

/** Strategy fitness by session — higher = better suited */
const SESSION_STRATEGY_FITNESS: Record<TradingSession, Record<string, number>> = {
	asian: {
		"mean-reversion": 0.9,   // tight ranges = reversion heaven
		"trend-following": 0.5,  // BTC/SOL have significant Asian volume; strong trends persist
		"breakout": 0.4,         // can fire on Asian volatility (was 0.3, blocked by 0.35 threshold)
		"rsi-divergence": 0.7,   // divergences still valid at extremes
	},
	european: {
		"mean-reversion": 0.6,
		"trend-following": 0.8,  // institutional trends begin
		"breakout": 0.8,         // volume supports real breakouts
		"rsi-divergence": 0.7,
	},
	us: {
		"mean-reversion": 0.5,   // can work on dips but risky
		"trend-following": 0.9,  // strong momentum
		"breakout": 0.7,         // works but can be noisy
		"rsi-divergence": 0.8,   // good for catching reversals in volatile moves
	},
	off_hours: {
		"mean-reversion": 0.6,
		"trend-following": 0.3,  // low liquidity = unreliable
		"breakout": 0.2,         // very risky — thin books
		"rsi-divergence": 0.4,   // less reliable on low volume
	},
};

/** Expected volume multiplier relative to daily average */
const SESSION_VOLUME: Record<TradingSession, number> = {
	asian: 0.6,
	european: 1.0,
	us: 1.4,
	off_hours: 0.3,
};

/** Volume boost during session overlaps */
const OVERLAP_VOLUME_BOOST = 1.3;

/**
 * Get the current trading session information.
 * Accepts an optional Date for testing; defaults to now.
 */
export function getCurrentSession(now?: Date): SessionInfo {
	const date = now ?? new Date();
	const utcHour = date.getUTCHours();
	const utcMinute = date.getUTCMinutes();
	const currentTimeInMinutes = utcHour * 60 + utcMinute;

	// Determine primary session
	const session = getSession(utcHour);

	// Check for overlaps
	const overlappingSessions: TradingSession[] = [];
	const activeSessions = getActiveSessions(utcHour);
	if (activeSessions.length > 1) {
		for (const s of activeSessions) {
			if (s !== session) overlappingSessions.push(s);
		}
	}
	const isOverlap = overlappingSessions.length > 0;

	// Calculate minutes to next session transition
	const transitions = [0, 8, 14, 16, 22].map((h) => h * 60); // All transition points in minutes
	let minutesToNext = 24 * 60; // fallback: end of day
	for (const t of transitions) {
		const diff = t > currentTimeInMinutes
			? t - currentTimeInMinutes
			: t + 24 * 60 - currentTimeInMinutes;
		if (diff > 0 && diff < minutesToNext) {
			minutesToNext = diff;
		}
	}

	// Get strategy fitness, boosted slightly during overlaps
	const baseFitness = SESSION_STRATEGY_FITNESS[session];
	const strategyFitness: Record<string, number> = {};
	for (const [strat, fit] of Object.entries(baseFitness)) {
		// During overlaps, blend fitness from overlapping session
		if (isOverlap && overlappingSessions.length > 0) {
			const overlapFit = SESSION_STRATEGY_FITNESS[overlappingSessions[0]][strat] ?? fit;
			strategyFitness[strat] = round2(Math.max(fit, overlapFit));
		} else {
			strategyFitness[strat] = fit;
		}
	}

	// Volume expectation
	let expectedVolumeMultiplier = SESSION_VOLUME[session];
	if (isOverlap) {
		expectedVolumeMultiplier = round2(expectedVolumeMultiplier * OVERLAP_VOLUME_BOOST);
	}

	// Description
	const sessionNames: Record<TradingSession, string> = {
		asian: "Asian Session (00:00-08:00 UTC)",
		european: "European Session (08:00-16:00 UTC)",
		us: "US Session (14:00-22:00 UTC)",
		off_hours: "Off-Hours (22:00-00:00 UTC)",
	};
	let description = sessionNames[session];
	if (isOverlap) {
		description += ` [overlap with ${overlappingSessions.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(", ")}]`;
	}

	return {
		session,
		isOverlap,
		overlappingSessions,
		minutesToNextSession: minutesToNext,
		strategyFitness,
		expectedVolumeMultiplier,
		description,
	};
}

/**
 * Get the fitness multiplier for a strategy in the current session.
 * Can be used to scale confidence before ensemble voting.
 */
export function getSessionFitness(
	strategyName: string,
	sessionInfo?: SessionInfo,
): number {
	const info = sessionInfo ?? getCurrentSession();
	return info.strategyFitness[strategyName] ?? 0.5;
}

/**
 * Check if now is a good time to trade based on session characteristics.
 * Returns true if we're in a high-quality trading window.
 */
export function isHighQualityWindow(sessionInfo?: SessionInfo): boolean {
	const info = sessionInfo ?? getCurrentSession();
	// Overlaps and main sessions (not off-hours) are high quality
	return info.session !== "off_hours" || info.isOverlap;
}

// ── Internal helpers ──

function getSession(utcHour: number): TradingSession {
	// Primary session assignment (with US/EU overlap going to US)
	if (utcHour >= 22 || utcHour < 0) return "off_hours";
	if (utcHour >= 0 && utcHour < 8) return "asian";
	if (utcHour >= 8 && utcHour < 14) return "european";
	if (utcHour >= 14 && utcHour < 22) return "us";
	return "off_hours";
}

function getActiveSessions(utcHour: number): TradingSession[] {
	const active: TradingSession[] = [];
	for (const [session, { start, end }] of Object.entries(SESSION_BOUNDARIES)) {
		if (session === "off_hours") {
			// Wraps around midnight
			if (utcHour >= start || utcHour < 0) active.push(session as TradingSession);
		} else if (utcHour >= start && utcHour < end) {
			active.push(session as TradingSession);
		}
	}
	return active;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
