/**
 * Expected Value Calculator — Core math for prediction market trading.
 *
 * Computes expected value, Kelly criterion position sizing, and
 * cross-market inefficiency detection (KL divergence).
 *
 * Cycle 003 additions:
 * - Confidence-adjusted Kelly sizing (reduces size when ensemble confidence is low)
 * - Position concentration limits (max per market, max total, category limits)
 * - Based on research: quarter-Kelly with LLM estimates is the FLOOR, not conservative,
 *   because LLM probability estimates have 3-5% error bands (Browne & Whitt 1996)
 *
 * Cycle 004 additions:
 * - Time-decay Kelly: reduce sizing near expiry (theta risk increases non-linearly)
 * - CTF arbitrage: detect YES+NO price deviation from $1.00 (Gnosis CTF invariant)
 * - Regime detection: volume acceleration, spread dynamics, price volatility signals
 */
import type { PredictionMarket, PredictionSignal } from "../types.js";

export interface EVResult {
	/** Expected value per dollar risked (gross, before fees) */
	ev: number;
	/** Expected value net of trading fees */
	netEV: number;
	/** Edge: model probability - market probability */
	edge: number;
	/** Full Kelly fraction (based on net EV) */
	kellyFraction: number;
	/** Quarter Kelly (conservative) */
	quarterKelly: number;
	/** Whether this is a positive EV bet after fees */
	isPositiveEV: boolean;
	/** Total fee rate applied (0-1) */
	feeRate: number;
}

// ── Polymarket Fee Model (effective March 30, 2026) ──

export type FeeCategory = "crypto" | "politics" | "finance" | "culture" | "weather" | "other";

/** Peak taker fee by category (fraction, not percent) */
const PEAK_FEES: Record<FeeCategory, number> = {
	crypto: 0.018,    // 1.80%
	politics: 0.010,  // 1.00%
	finance: 0.010,
	culture: 0.010,
	weather: 0.010,
	other: 0.010,
};

/**
 * Calculate Polymarket taker fee as a function of probability.
 * Fee is maximized at p=0.50 and approaches 0 at p=0 or p=1.
 * Formula: fee(p) = peak_fee * 4 * p * (1 - p)
 */
export function polymarketFee(probability: number, category: FeeCategory = "crypto"): number {
	const peak = PEAK_FEES[category] ?? PEAK_FEES.other;
	return peak * 4 * probability * (1 - probability);
}

/**
 * Calculate expected value for a binary outcome bet, net of Polymarket trading fees.
 *
 * @param modelProb - Your estimated true probability (0-1)
 * @param marketPrice - Market's current price for Yes token (0-1)
 * @param side - "yes" or "no"
 * @param category - Market category for fee calculation (default: "crypto")
 */
export function toFeeCategory(category: string | undefined): FeeCategory {
	const key = (category ?? "other").toLowerCase();
	if (key === "crypto" || key === "politics" || key === "finance" || key === "culture" || key === "weather") {
		return key;
	}
	return "other";
}

export function calculateEV(modelProb: number, marketPrice: number, side: "yes" | "no", category?: FeeCategory): EVResult {
	// For "yes": you pay marketPrice, win $1 with probability modelProb
	// For "no": you pay (1 - marketPrice), win $1 with probability (1 - modelProb)
	const betProb = side === "yes" ? modelProb : 1 - modelProb;
	const betPrice = side === "yes" ? marketPrice : 1 - marketPrice;

	// Gross EV = (prob * payout) - cost = prob * 1 - betPrice
	const ev = betProb - betPrice;
	const edge = betProb - betPrice;

	// Fee on entry (paid on betPrice) + fee on exit if winning (paid on $1 payout)
	const entryFee = polymarketFee(betPrice, category);
	const exitFee = polymarketFee(betPrice, category); // same rate applies on exit
	const totalFeeRate = entryFee + betProb * exitFee; // exit fee only if win
	const netEV = ev - totalFeeRate;

	// Kelly criterion uses net-of-fees edge for correct sizing
	// Net payout on win = (1 - exitFee) - betPrice * (1 + entryFee/betPrice)
	// Simplified: b = net_profit / cost = ((1 - exitFee) - betPrice * (1 + entryFee)) / (betPrice * (1 + entryFee))
	const effectiveCost = betPrice + entryFee;
	const netPayout = 1 - exitFee;
	const b = effectiveCost > 0 && netPayout > effectiveCost ? (netPayout - effectiveCost) / effectiveCost : 0;
	const p = betProb;
	const q = 1 - p;
	const kelly = b > 0 ? Math.max(0, (b * p - q) / b) : 0;

	const r4 = (n: number) => Math.round(n * 10000) / 10000;
	return {
		ev: r4(ev),
		netEV: r4(netEV),
		edge: r4(edge),
		kellyFraction: r4(kelly),
		quarterKelly: r4(kelly * 0.25),
		isPositiveEV: netEV > 0,
		feeRate: r4(entryFee + exitFee),
	};
}

// ── Confidence-Adjusted Kelly (Cycle 003) ──

/**
 * Position sizing limits to prevent concentration risk.
 * Based on research: estimation error is the #1 killer with Kelly sizing.
 * Quarter-Kelly with LLM estimates is the FLOOR, not conservative.
 */
export interface PositionLimits {
	/** Maximum fraction of bankroll per single market (default: 0.05 = 5%) */
	maxPerMarket: number;
	/** Maximum total exposure across all prediction markets (default: 0.30 = 30%) */
	maxTotalExposure: number;
	/** Maximum exposure in any single category (default: 0.15 = 15%) */
	maxPerCategory: number;
}

export const DEFAULT_POSITION_LIMITS: PositionLimits = {
	maxPerMarket: 0.05,
	maxTotalExposure: 0.30,
	maxPerCategory: 0.15,
};

/**
 * Adjust Kelly sizing based on ensemble confidence level.
 * When confidence is LOW, reduce position size proportionally.
 *
 * Research basis (Cycle 003):
 * - Browne & Whitt (1996): 3% estimation error with full Kelly = catastrophic
 * - MacLean et al. (2004): Fractional Kelly superior in practice due to estimation error
 * - Quarter Kelly provides ~75% of full Kelly growth with dramatically less volatility
 *
 * @param quarterKelly - Base quarter-Kelly fraction from calculateEV
 * @param confidence - Ensemble confidence (0-1)
 * @param confidenceThreshold - Confidence level at which full quarter-Kelly is used (default: 0.7)
 * @returns Adjusted position size as fraction of bankroll
 */
export function confidenceAdjustedKelly(
	quarterKelly: number,
	confidence: number,
	confidenceThreshold = 0.7,
): number {
	if (quarterKelly <= 0) return 0;
	// Scale: at confidence >= threshold, use full quarter-Kelly
	// At confidence = 0, use 0
	// Linear interpolation between
	const scaleFactor = Math.min(1.0, confidence / confidenceThreshold);
	return Math.round(quarterKelly * scaleFactor * 10000) / 10000;
}

/**
 * Apply position limits to a proposed bet size.
 *
 * @param proposedSize - Proposed dollar amount to bet
 * @param bankroll - Total bankroll
 * @param currentExposure - Current total exposure across all markets
 * @param currentCategoryExposure - Current exposure in this market's category
 * @param limits - Position limit configuration
 * @returns Capped dollar amount
 */
export function applyPositionLimits(
	proposedSize: number,
	bankroll: number,
	currentExposure = 0,
	currentCategoryExposure = 0,
	limits: PositionLimits = DEFAULT_POSITION_LIMITS,
): number {
	if (bankroll <= 0 || proposedSize <= 0) return 0;

	// Cap 1: Max per market
	let capped = Math.min(proposedSize, bankroll * limits.maxPerMarket);

	// Cap 2: Max total exposure
	const remainingTotal = Math.max(0, bankroll * limits.maxTotalExposure - currentExposure);
	capped = Math.min(capped, remainingTotal);

	// Cap 3: Max per category
	const remainingCategory = Math.max(0, bankroll * limits.maxPerCategory - currentCategoryExposure);
	capped = Math.min(capped, remainingCategory);

	return Math.round(capped * 100) / 100;
}

/**
 * KL Divergence between two probability distributions.
 * Used to detect cross-market inefficiencies.
 *
 * @param p - Model probabilities [p_yes, p_no]
 * @param q - Market probabilities [q_yes, q_no]
 * @returns KL(P || Q) — higher = more divergent = bigger potential edge
 */
export function klDivergence(p: [number, number], q: [number, number]): number {
	// Clamp to avoid log(0)
	const eps = 1e-10;
	const p0 = Math.max(eps, Math.min(1 - eps, p[0]));
	const p1 = Math.max(eps, Math.min(1 - eps, p[1]));
	const q0 = Math.max(eps, Math.min(1 - eps, q[0]));
	const q1 = Math.max(eps, Math.min(1 - eps, q[1]));

	return p0 * Math.log(p0 / q0) + p1 * Math.log(p1 / q1);
}

/**
 * Detect cross-market inefficiencies between two markets for correlated events.
 * When two markets should be related but their prices diverge, there's an arb opportunity.
 *
 * @param primary - The main market
 * @param related - A correlated market
 * @param expectedCorrelation - How correlated these markets should be (0-1)
 * @returns Divergence score and whether it's actionable
 */
export function detectInefficiency(
	primary: PredictionMarket,
	related: PredictionMarket,
	expectedCorrelation: number,
): { divergence: number; actionable: boolean; suggestion: string } {
	const pProb: [number, number] = [primary.yesPrice, primary.noPrice];
	const rProb: [number, number] = [related.yesPrice, related.noPrice];

	// Expected related probability given correlation
	const expectedRelated = primary.yesPrice * expectedCorrelation + related.yesPrice * (1 - expectedCorrelation);
	const adjustedQ: [number, number] = [expectedRelated, 1 - expectedRelated];

	const divergence = klDivergence(rProb, adjustedQ);
	const actionable = divergence > 0.05; // Threshold for actionable inefficiency

	let suggestion = "";
	if (actionable) {
		if (related.yesPrice < expectedRelated - 0.05) {
			suggestion = `${related.slug} underpriced relative to ${primary.slug} — consider buying YES`;
		} else if (related.yesPrice > expectedRelated + 0.05) {
			suggestion = `${related.slug} overpriced relative to ${primary.slug} — consider buying NO`;
		}
	}

	return {
		divergence: Math.round(divergence * 10000) / 10000,
		actionable,
		suggestion,
	};
}

/**
 * Bayesian probability update.
 * Update a prior probability given new evidence.
 *
 * @param prior - Prior probability (0-1)
 * @param likelihoodGivenTrue - P(evidence | event is true)
 * @param likelihoodGivenFalse - P(evidence | event is false)
 * @returns Updated posterior probability
 */
export function bayesianUpdate(
	prior: number,
	likelihoodGivenTrue: number,
	likelihoodGivenFalse: number,
): number {
	const numerator = likelihoodGivenTrue * prior;
	const denominator = numerator + likelihoodGivenFalse * (1 - prior);
	if (denominator === 0) return prior;
	return Math.max(0.01, Math.min(0.99, numerator / denominator));
}

// ── Time-Decay Kelly Adjustment (Cycle 004) ──

/**
 * Adjust Kelly sizing based on time remaining until market resolution.
 * Markets near expiry have higher "theta" — price convergence accelerates,
 * meaning both the opportunity and the risk are amplified.
 *
 * Research basis (Cycle 004):
 * - Near-expiry markets converge rapidly toward 0 or 1
 * - Small information advantage creates outsized returns near expiry
 * - BUT wrong bets also lose faster — theta cuts both ways
 * - Binary settlement (0 or 1) means inventory risk is non-linear near resolution
 *
 * @param kellySize - Base Kelly-adjusted position size (from confidenceAdjustedKelly)
 * @param hoursToExpiry - Hours until market resolution
 * @returns Adjusted position size
 */
export function timeDecayKellyAdjustment(
	kellySize: number,
	hoursToExpiry: number,
): number {
	if (kellySize <= 0 || hoursToExpiry < 0) return 0;

	// Very near expiry (< 2 hours): reduce to 50% — too risky, binary convergence
	if (hoursToExpiry < 2) {
		return Math.round(kellySize * 0.50 * 10000) / 10000;
	}
	// Near expiry (2-24 hours): slight reduction to 80% — elevated theta risk
	if (hoursToExpiry < 24) {
		return Math.round(kellySize * 0.80 * 10000) / 10000;
	}
	// Medium term (1-7 days): full size — sweet spot for information advantage
	if (hoursToExpiry < 168) {
		return kellySize;
	}
	// Long term (7-30 days): slight reduction to 90% — more uncertainty, base rates dominate
	if (hoursToExpiry < 720) {
		return Math.round(kellySize * 0.90 * 10000) / 10000;
	}
	// Very long term (30+ days): reduce to 70% — extreme uncertainty, model confidence inflated
	return Math.round(kellySize * 0.70 * 10000) / 10000;
}

// ── CTF Arbitrage Detection (Cycle 004) ──

/**
 * Check if a market's YES + NO prices deviate from the $1.00 CTF invariant.
 * The Conditional Token Framework (Gnosis) guarantees that a YES + NO pair
 * can always be redeemed for $1.00. When market prices deviate, there's
 * a risk-free arbitrage opportunity.
 *
 * Research basis (Cycle 004):
 * - $40M+ extracted in risk-free arb profits since 2024 (arXiv 2508.03474)
 * - 7,000+ mispriced markets found in 86M bets (Apr 2024 - Apr 2025)
 * - Windows last seconds — primarily exploited by bots
 *
 * @param yesPrice - Current YES token price
 * @param noPrice - Current NO token price
 * @param threshold - Minimum deviation to flag (default: 0.015 = 1.5 cents)
 * @returns Arbitrage opportunity details
 */
export function detectCTFArbitrage(
	yesPrice: number,
	noPrice: number,
	threshold = 0.015,
): { hasArbitrage: boolean; deviation: number; direction: "buy_pair" | "sell_pair" | "none"; profitPerPair: number } {
	const sum = yesPrice + noPrice;
	const deviation = sum - 1.0;

	if (Math.abs(deviation) < threshold) {
		return { hasArbitrage: false, deviation: Math.round(deviation * 10000) / 10000, direction: "none", profitPerPair: 0 };
	}

	if (deviation < -threshold) {
		// Sum < $1.00: Buy both YES + NO for less than $1, redeem for $1
		return {
			hasArbitrage: true,
			deviation: Math.round(deviation * 10000) / 10000,
			direction: "buy_pair",
			profitPerPair: Math.round(Math.abs(deviation) * 10000) / 10000,
		};
	}

	// Sum > $1.00: Mint pair for $1 from CTF, sell both for > $1
	return {
		hasArbitrage: true,
		deviation: Math.round(deviation * 10000) / 10000,
		direction: "sell_pair",
		profitPerPair: Math.round(Math.abs(deviation) * 10000) / 10000,
	};
}

// ── Regime Detection Signals (Cycle 004) ──

/**
 * Market regime indicators for prediction markets.
 * When regime shifts are detected, position sizing should be reduced
 * and forecasts should weight recent evidence more heavily.
 *
 * Research basis (Cycle 004):
 * - HMM models detect regime shifts with better state segregation
 * - Top Polymarket traders reduce exposure during regime transitions
 * - Three signals: volume acceleration, spread dynamics, price volatility
 */
export interface RegimeSignals {
	/** Volume in last 24h divided by 7-day average. >3x = regime shift */
	volumeAcceleration: number;
	/** Current spread divided by baseline spread. >2x = uncertainty regime */
	spreadExpansion: number;
	/** Whether a regime shift is detected */
	regimeShift: boolean;
	/** Suggested position size multiplier (0.3-1.0) */
	sizingMultiplier: number;
}

/**
 * Detect regime shifts in a prediction market using volume and spread signals.
 *
 * @param volume24h - Current 24-hour volume
 * @param avgVolume7d - Average daily volume over 7 days
 * @param currentSpread - Current bid-ask spread
 * @param baselineSpread - Historical average spread for this market
 * @returns Regime signals with sizing recommendation
 */
export function detectRegimeShift(
	volume24h: number,
	avgVolume7d: number,
	currentSpread: number,
	baselineSpread: number,
): RegimeSignals {
	// Volume acceleration: how much faster is trading than normal
	const volumeAcceleration = avgVolume7d > 0 ? volume24h / avgVolume7d : 1.0;

	// Spread expansion: how much wider is the spread than normal
	const spreadExpansion = baselineSpread > 0 ? currentSpread / baselineSpread : 1.0;

	// Regime shift detected if either signal is extreme
	const regimeShift = volumeAcceleration > 3.0 || spreadExpansion > 2.0;

	// Sizing multiplier: reduce position sizes during regime shifts
	let sizingMultiplier = 1.0;
	if (regimeShift) {
		// Inverse of the stronger signal, floored at 0.3
		const maxSignal = Math.max(volumeAcceleration / 3.0, spreadExpansion / 2.0);
		sizingMultiplier = Math.max(0.3, 1.0 / maxSignal);
	}

	return {
		volumeAcceleration: Math.round(volumeAcceleration * 100) / 100,
		spreadExpansion: Math.round(spreadExpansion * 100) / 100,
		regimeShift,
		sizingMultiplier: Math.round(sizingMultiplier * 100) / 100,
	};
}

// ── Binary Implied Volatility (Cycle 005) ──

/**
 * Compute implied volatility for a binary prediction market contract.
 * Binary IV measures remaining uncertainty — higher IV = more opportunity.
 *
 * Formula: IV = price * (1 - price) * sqrt(hoursToExpiry / 168)
 *
 * Research basis (Cycle 005):
 * - Binary IV is maximal at price=0.50 (maximum uncertainty)
 * - IV decreases as price approaches 0 or 1 (nearly resolved)
 * - Time scaling: sqrt(hours/168) normalizes to 1 at 7 days
 * - Markets with low IV have small potential payoffs even if edge exists
 * - Use as a signal quality filter: prioritize high-IV markets
 *
 * @param price - Current market price (0-1)
 * @param hoursToExpiry - Hours until market resolution
 * @returns IV score (0-0.25, higher = more uncertainty/opportunity)
 */
export function computeBinaryIV(price: number, hoursToExpiry: number): number {
	if (price <= 0 || price >= 1 || hoursToExpiry <= 0) return 0;
	const priceFactor = price * (1 - price); // max at 0.50 = 0.25
	const timeFactor = Math.sqrt(Math.max(0, hoursToExpiry) / 168); // normalized to 7 days
	return Math.round(priceFactor * timeFactor * 10000) / 10000;
}

/**
 * Classify a market's opportunity quality based on IV and edge.
 *
 * @param iv - Binary implied volatility from computeBinaryIV
 * @param edge - Absolute edge (|modelProb - marketPrice|)
 * @returns Opportunity class: "prime" | "decent" | "marginal" | "skip"
 */
export function classifyOpportunity(
	iv: number,
	edge: number,
): "prime" | "decent" | "marginal" | "skip" {
	// Prime: high IV and high edge — the sweet spot
	if (iv >= 0.15 && edge >= 0.05) return "prime";
	// Decent: moderate IV with good edge, or high IV with small edge
	if ((iv >= 0.08 && edge >= 0.03) || (iv >= 0.15 && edge >= 0.02)) return "decent";
	// Marginal: some opportunity but not worth full ensemble cost
	if (iv >= 0.05 && edge >= 0.02) return "marginal";
	// Skip: low IV or tiny edge — not worth trading
	return "skip";
}

// ── New Market Detection (Cycle 005) ──

/**
 * Determine if a market is newly created and likely mispriced.
 * New markets (< 48h old) are systematically mispriced due to:
 * - Limited information (fewer analysts)
 * - Low participation (thin order books)
 * - Anchor bias (initial price setter's bias propagates)
 *
 * Research basis (Cycle 005):
 * - Early movers capture 2-5% edge that disappears as markets mature
 * - Price stabilization occurs as volume increases and sophisticated traders arrive
 * - Window of opportunity: hours to days for liquid markets
 *
 * @param createdAt - ISO timestamp of market creation
 * @param totalVolume - Total volume traded since creation
 * @param liquidity - Current liquidity in USD
 * @returns Whether the market is new and a priority score (higher = more opportunity)
 */
export function detectNewMarket(
	createdAt: string,
	totalVolume: number,
	liquidity: number,
): { isNew: boolean; priorityScore: number; ageHours: number } {
	const now = Date.now();
	const created = new Date(createdAt).getTime();
	if (isNaN(created)) return { isNew: false, priorityScore: 0, ageHours: Infinity };

	const ageHours = (now - created) / (1000 * 60 * 60);

	// Not new if older than 48 hours
	if (ageHours > 48) return { isNew: false, priorityScore: 0, ageHours: Math.round(ageHours * 10) / 10 };

	// Must have minimum liquidity to be tradeable
	if (liquidity < 500) return { isNew: false, priorityScore: 0, ageHours: Math.round(ageHours * 10) / 10 };

	// Priority scoring (higher = more opportunity):
	// - Recency: newer markets score higher (inverse of age)
	const recencyScore = Math.max(0, 1 - ageHours / 48); // 1.0 at birth, 0.0 at 48h

	// - Volume efficiency: low total volume relative to liquidity = less efficient pricing
	const volumeRatio = totalVolume > 0 ? Math.min(1, liquidity / totalVolume) : 1.0;

	// Combined priority: recency dominates (70%), volume inefficiency (30%)
	const priorityScore = Math.round((recencyScore * 0.7 + volumeRatio * 0.3) * 100) / 100;

	return {
		isNew: true,
		priorityScore,
		ageHours: Math.round(ageHours * 10) / 10,
	};
}

// ── Closing Line Value (Cycle 006) ──

/**
 * Compute Closing Line Value — the gold standard metric for forecasting skill.
 *
 * CLV compares your forecast accuracy to the market's closing price accuracy.
 * Positive CLV = your forecast was closer to the outcome than the market consensus.
 * This is the single strongest predictor of long-term profitability.
 *
 * Research basis (Cycle 006):
 * - Sports betting: "positive CLV is the single strongest predictor of long-term success"
 * - Pinnacle/Buchdahl: "+2% CLV consistently is considered sharp"
 * - Statistical power: as few as 50 forecasts with positive CLV demonstrates significance
 * - CLV > win rate and Brier score for measuring relative skill vs. the market
 *
 * @param forecastProb - Your ensemble forecast probability (0-1)
 * @param closingPrice - Final market price before resolution (0-1)
 * @param outcome - Actual binary outcome (0 or 1)
 * @returns CLV metrics
 */
export function computeCLV(
	forecastProb: number,
	closingPrice: number,
	outcome: 0 | 1,
): { clv: number; forecastError: number; marketError: number; beatMarket: boolean } {
	const forecastError = Math.abs(forecastProb - outcome);
	const marketError = Math.abs(closingPrice - outcome);
	const clv = marketError - forecastError; // positive = you were closer to truth

	return {
		clv: Math.round(clv * 10000) / 10000,
		forecastError: Math.round(forecastError * 10000) / 10000,
		marketError: Math.round(marketError * 10000) / 10000,
		beatMarket: clv > 0,
	};
}

/**
 * Compute rolling CLV statistics from a series of forecasts.
 * Determines whether the ensemble is adding value vs. just tracking the market.
 *
 * @param records - Array of {forecastProb, closingPrice, outcome} tuples
 * @returns Aggregate CLV stats
 */
export function aggregateCLV(
	records: Array<{ forecastProb: number; closingPrice: number; outcome: 0 | 1 }>,
): { avgCLV: number; beatMarketRate: number; count: number; isSharp: boolean } {
	if (records.length === 0) {
		return { avgCLV: 0, beatMarketRate: 0, count: 0, isSharp: false };
	}

	let totalCLV = 0;
	let beatCount = 0;

	for (const r of records) {
		const result = computeCLV(r.forecastProb, r.closingPrice, r.outcome);
		totalCLV += result.clv;
		if (result.beatMarket) beatCount++;
	}

	const avgCLV = totalCLV / records.length;

	return {
		avgCLV: Math.round(avgCLV * 10000) / 10000,
		beatMarketRate: Math.round((beatCount / records.length) * 10000) / 10000,
		count: records.length,
		// Sharp threshold: +2% average CLV with statistical significance (50+ samples)
		isSharp: avgCLV >= 0.02 && records.length >= 50,
	};
}

// ── Herding / Contrarian Indicator (Cycle 006) ──

/**
 * Detect herding behavior in prediction markets.
 * When consensus is too strong (price near extremes) with declining volume,
 * the crowd may be over-reacting — creating a contrarian opportunity.
 *
 * Research basis (Cycle 006):
 * - Warwick: "Behavior consistent with herding occurs frequently in prediction markets"
 * - ScienceDirect: "Systematic relationship between price trends and accuracy — consistent with over-reaction"
 * - Incentive structure: safer for forecasters to cluster together → systematic mispricing at extremes
 *
 * @param currentPrice - Current market yes price (0-1)
 * @param priceHistory - Recent price snapshots (newest first, at least 3 data points)
 * @param volume24h - Current 24h volume
 * @param avgVolume7d - Average 7-day daily volume
 * @returns Herding analysis with contrarian signal
 */
export interface HerdingSignal {
	/** How strongly the market is herding (0-1, higher = more herding) */
	herdingScore: number;
	/** Whether a contrarian signal is active */
	isContrarian: boolean;
	/** Direction of potential contrarian trade */
	contrarianSide: "yes" | "no" | "none";
	/** How far price has moved from 0.5 (0 = centered, 0.5 = extreme) */
	extremity: number;
	/** Velocity of price movement (rate of change) */
	priceVelocity: number;
	/** Volume declining while price moving = classic herding signal */
	volumeDeclining: boolean;
}

export function detectHerding(
	currentPrice: number,
	priceHistory: number[],
	volume24h: number,
	avgVolume7d: number,
): HerdingSignal {
	// Extremity: how far from 0.5 (maximum uncertainty)
	const extremity = Math.abs(currentPrice - 0.5);

	// Price velocity: average rate of change in recent history
	let priceVelocity = 0;
	if (priceHistory.length >= 2) {
		const changes: number[] = [];
		for (let i = 0; i < priceHistory.length - 1; i++) {
			changes.push(priceHistory[i] - priceHistory[i + 1]);
		}
		priceVelocity = changes.reduce((s, v) => s + v, 0) / changes.length;
	}

	// Volume declining: current volume below 7d average
	const volumeRatio = avgVolume7d > 0 ? volume24h / avgVolume7d : 1.0;
	const volumeDeclining = volumeRatio < 0.7; // 30% below average

	// Herding score: high extremity + high velocity + declining volume
	const extremityFactor = Math.max(0, (extremity - 0.2) / 0.3); // kicks in above 0.7 or below 0.3
	const velocityFactor = Math.min(1, Math.abs(priceVelocity) * 10); // 0.10 price movement = max
	const volumeFactor = volumeDeclining ? 0.8 : 0.2; // declining volume amplifies herding signal

	const herdingScore = Math.min(1, extremityFactor * 0.4 + velocityFactor * 0.35 + volumeFactor * 0.25);

	// Contrarian signal: herding score above threshold AND price at extreme
	const isContrarian = herdingScore > 0.6 && extremity > 0.35;

	// Contrarian direction: fade the crowd
	let contrarianSide: "yes" | "no" | "none" = "none";
	if (isContrarian) {
		contrarianSide = currentPrice > 0.5 ? "no" : "yes"; // fade toward 0.5
	}

	return {
		herdingScore: Math.round(herdingScore * 10000) / 10000,
		isContrarian,
		contrarianSide,
		extremity: Math.round(extremity * 10000) / 10000,
		priceVelocity: Math.round(priceVelocity * 10000) / 10000,
		volumeDeclining,
	};
}

// ── Conformal Prediction Bands (Cycle 006) ──

/**
 * Compute conformal prediction interval for an ensemble forecast.
 *
 * Split conformal prediction provides distribution-free, statistically
 * guaranteed uncertainty bounds. If alpha=0.10, the true outcome falls
 * inside the prediction interval at least 90% of the time.
 *
 * Research basis (Cycle 006):
 * - ConU (arXiv 2407.00499): self-consistency as nonconformity score
 * - TECP: token-entropy for coverage guarantees
 * - Key property: finite-sample coverage guarantees on black-box models
 *
 * @param calibrationScores - Array of |forecast - outcome| from resolved forecasts (the calibration set)
 * @param forecast - Current ensemble forecast probability (0-1)
 * @param alpha - Significance level (default 0.10 = 90% coverage)
 * @returns Prediction interval and derived confidence
 */
export interface ConformalInterval {
	/** Lower bound of prediction interval (clamped to [0,1]) */
	lower: number;
	/** Upper bound of prediction interval (clamped to [0,1]) */
	upper: number;
	/** Width of interval (upper - lower, narrower = better calibrated) */
	width: number;
	/** The quantile threshold used */
	quantile: number;
	/** Derived confidence from interval width */
	confidence: "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
	/** Coverage level (1 - alpha) */
	coverageLevel: number;
}

export function computeConformalInterval(
	calibrationScores: number[],
	forecast: number,
	alpha = 0.10,
): ConformalInterval {
	if (calibrationScores.length < 10) {
		// Insufficient calibration data — return maximum uncertainty
		return {
			lower: 0,
			upper: 1,
			width: 1,
			quantile: 0.5,
			confidence: "VERY_LOW",
			coverageLevel: 1 - alpha,
		};
	}

	// Sort scores ascending
	const sorted = [...calibrationScores].sort((a, b) => a - b);
	const n = sorted.length;

	// Compute the (1 - alpha) quantile using the standard conformal formula
	const idx = Math.ceil((n + 1) * (1 - alpha)) - 1;
	const quantile = sorted[Math.min(idx, n - 1)];

	// Prediction interval
	const lower = Math.max(0, forecast - quantile);
	const upper = Math.min(1, forecast + quantile);
	const width = upper - lower;

	// Derive confidence from width
	let confidence: ConformalInterval["confidence"];
	if (width < 0.15) confidence = "VERY_HIGH";
	else if (width < 0.25) confidence = "HIGH";
	else if (width < 0.35) confidence = "MEDIUM";
	else if (width < 0.50) confidence = "LOW";
	else confidence = "VERY_LOW";

	return {
		lower: Math.round(lower * 10000) / 10000,
		upper: Math.round(upper * 10000) / 10000,
		width: Math.round(width * 10000) / 10000,
		quantile: Math.round(quantile * 10000) / 10000,
		confidence,
		coverageLevel: 1 - alpha,
	};
}

// ── Metacognition: Per-Category Accuracy Tracker (Cycle 006) ──

/**
 * Metacognitive accuracy tracker — monitors per-category forecast performance
 * in real-time and auto-adjusts confidence based on recent accuracy trends.
 *
 * Research basis (Cycle 006):
 * - Microsoft: "Metacognition = monitoring reasoning + controlling response"
 * - arXiv 2509.19783: Secondary agent monitors primary agent for failure prediction
 * - 5-dimension state vector: confidence, coherence, coverage, depth, calibration
 *
 * When a category's recent accuracy is declining, the tracker recommends
 * increasing Platt scaling compression (reducing confidence).
 * When accuracy is improving, it recommends relaxing compression.
 */
export interface MetacognitiveState {
	category: string;
	/** Rolling Brier score (lower = better) */
	rollingBrier: number;
	/** Rolling CLV (higher = better) */
	rollingCLV: number;
	/** Number of resolved forecasts in window */
	sampleSize: number;
	/** Trend: is accuracy improving or declining? */
	trend: "improving" | "stable" | "declining";
	/** Recommended Platt scale adjustment multiplier (0.5 = more compression, 1.5 = less) */
	plattAdjustment: number;
	/** Overall health: is this category worth forecasting? */
	health: "excellent" | "good" | "fair" | "poor";
}

export function computeMetacognitiveState(
	category: string,
	recentForecasts: Array<{ forecastProb: number; closingPrice: number; outcome: 0 | 1 }>,
	windowSize = 20,
): MetacognitiveState {
	if (recentForecasts.length === 0) {
		return {
			category,
			rollingBrier: 0,
			rollingCLV: 0,
			sampleSize: 0,
			trend: "stable",
			plattAdjustment: 1.0,
			health: "fair",
		};
	}

	// Use only the most recent windowSize forecasts
	const window = recentForecasts.slice(0, windowSize);

	// Rolling Brier score
	let brierSum = 0;
	for (const f of window) {
		brierSum += (f.forecastProb - f.outcome) ** 2;
	}
	const rollingBrier = brierSum / window.length;

	// Rolling CLV
	const clvResult = aggregateCLV(window);
	const rollingCLV = clvResult.avgCLV;

	// Trend detection: compare first half to second half
	let trend: MetacognitiveState["trend"] = "stable";
	if (window.length >= 6) {
		const half = Math.floor(window.length / 2);
		const recentHalf = window.slice(0, half);
		const olderHalf = window.slice(half);

		const recentBrier = recentHalf.reduce((s, f) => s + (f.forecastProb - f.outcome) ** 2, 0) / recentHalf.length;
		const olderBrier = olderHalf.reduce((s, f) => s + (f.forecastProb - f.outcome) ** 2, 0) / olderHalf.length;

		const brierDelta = recentBrier - olderBrier;
		if (brierDelta < -0.02) trend = "improving"; // recent Brier lower = better
		else if (brierDelta > 0.02) trend = "declining"; // recent Brier higher = worse
	}

	// Platt adjustment based on trend and absolute performance
	let plattAdjustment = 1.0;
	if (trend === "declining") {
		plattAdjustment = 0.7; // increase compression (more conservative)
	} else if (trend === "improving" && rollingBrier < 0.2) {
		plattAdjustment = 1.2; // relax compression (model is well calibrated)
	}

	// Health assessment
	let health: MetacognitiveState["health"];
	if (rollingBrier < 0.15 && rollingCLV > 0.02) health = "excellent";
	else if (rollingBrier < 0.25 && rollingCLV > 0) health = "good";
	else if (rollingBrier < 0.35) health = "fair";
	else health = "poor";

	return {
		category,
		rollingBrier: Math.round(rollingBrier * 10000) / 10000,
		rollingCLV: Math.round(rollingCLV * 10000) / 10000,
		sampleSize: window.length,
		trend,
		plattAdjustment,
		health,
	};
}

// ── Shannon Entropy: Market Information Content (Cycle 007) ──

/**
 * Compute Shannon entropy of a prediction market price — measures how much
 * information the current price contains about the outcome.
 *
 * Shannon entropy H(X) = -sum(p * log2(p)) for binary outcome = -p*log2(p) - (1-p)*log2(1-p)
 *
 * Research basis (Cycle 007):
 * - ScienceDirect: Shannon entropy of discretized returns measures market efficiency
 * - PMC: Higher entropy ↔ higher market efficiency ↔ higher liquidity
 * - Entropy is maximized at p=0.50 (1 bit — maximum uncertainty, minimum information)
 * - Entropy approaches 0 as p→0 or p→1 (certainty — maximum information)
 * - Use as a FILTER: low-entropy markets have already priced in information,
 *   making it harder to find an edge. High-entropy markets are still "deciding."
 *
 * @param price - Current market price (0-1)
 * @returns Entropy in bits (0-1 for binary), plus derived efficiency rating
 */
export interface MarketEntropy {
	/** Shannon entropy in bits (0 = certain, 1 = maximum uncertainty) */
	entropy: number;
	/** Information content: 1 - entropy (0 = no info, 1 = fully resolved) */
	informationContent: number;
	/** Surprise value if YES outcome occurs: -log2(price) */
	surpriseIfYes: number;
	/** Surprise value if NO outcome occurs: -log2(1-price) */
	surpriseIfNo: number;
	/** Market information efficiency rating */
	efficiency: "resolved" | "high_info" | "moderate" | "uncertain" | "maximum_uncertainty";
}

export function computeMarketEntropy(price: number): MarketEntropy {
	// Clamp to avoid log(0)
	const p = Math.max(1e-10, Math.min(1 - 1e-10, price));
	const q = 1 - p;

	const entropy = -(p * Math.log2(p) + q * Math.log2(q));
	const informationContent = 1 - entropy;

	const surpriseIfYes = -Math.log2(p);
	const surpriseIfNo = -Math.log2(q);

	// Efficiency rating based on entropy
	let efficiency: MarketEntropy["efficiency"];
	if (entropy < 0.20) efficiency = "resolved"; // price near 0 or 1
	else if (entropy < 0.50) efficiency = "high_info"; // market has learned a lot
	else if (entropy < 0.80) efficiency = "moderate"; // some info incorporated
	else if (entropy < 0.95) efficiency = "uncertain"; // still deciding
	else efficiency = "maximum_uncertainty"; // near 50/50 — no consensus

	return {
		entropy: Math.round(entropy * 10000) / 10000,
		informationContent: Math.round(informationContent * 10000) / 10000,
		surpriseIfYes: Math.round(surpriseIfYes * 10000) / 10000,
		surpriseIfNo: Math.round(surpriseIfNo * 10000) / 10000,
		efficiency,
	};
}

/**
 * Measure how much information was gained between two prices (e.g., open → current).
 * Positive = market learned toward resolution. Negative = market became more uncertain.
 *
 * Uses KL divergence of [p_new, 1-p_new] from [p_old, 1-p_old].
 *
 * @param oldPrice - Previous price
 * @param newPrice - Current price
 * @returns Information gain in bits (positive = market learned, negative = became uncertain)
 */
export function computeInformationGain(oldPrice: number, newPrice: number): number {
	const oldEntropy = computeMarketEntropy(oldPrice).entropy;
	const newEntropy = computeMarketEntropy(newPrice).entropy;
	// Information gain = decrease in entropy
	return Math.round((oldEntropy - newEntropy) * 10000) / 10000;
}

// ── Kalman Filter: Price State Estimation (Cycle 007) ──

/**
 * 1-D Kalman filter for tracking the "true" probability in a noisy prediction market.
 *
 * Prediction markets have noisy prices — thin liquidity, random arrivals,
 * wash trading (Columbia: ~25% of Polymarket volume). The Kalman filter
 * separates signal from noise by maintaining an estimate + uncertainty.
 *
 * Research basis (Cycle 007):
 * - Kalman filter achieves <2% mean absolute error on stock price tracking
 * - For prediction markets: process noise (Q) models how fast true probability changes,
 *   measurement noise (R) models market microstructure noise
 * - When R >> Q, filter trusts its prediction more (thin market)
 * - When Q >> R, filter tracks measurements closely (efficient market)
 *
 * @param state - Previous state estimate (probability)
 * @param uncertainty - Previous state uncertainty (variance)
 * @param measurement - New observed price
 * @param processNoise - How fast the true probability can change (Q, default 0.001)
 * @param measurementNoise - How noisy the market price is (R, default 0.01)
 * @returns Updated state estimate and uncertainty
 */
export interface KalmanState {
	/** Estimated true probability (filtered) */
	estimate: number;
	/** Uncertainty of the estimate (variance) */
	uncertainty: number;
	/** Kalman gain (0-1): how much the new measurement was trusted */
	kalmanGain: number;
	/** Residual: difference between measurement and prediction */
	residual: number;
	/** Signal quality: inverse of measurement noise / total uncertainty */
	signalQuality: "strong" | "moderate" | "weak" | "noise";
}

export function kalmanUpdate(
	state: number,
	uncertainty: number,
	measurement: number,
	processNoise = 0.001,
	measurementNoise = 0.01,
): KalmanState {
	// Prediction step
	const predictedState = state;
	const predictedUncertainty = uncertainty + processNoise;

	// Update step
	const kalmanGain = predictedUncertainty / (predictedUncertainty + measurementNoise);
	const residual = measurement - predictedState;
	const newEstimate = predictedState + kalmanGain * residual;
	const newUncertainty = (1 - kalmanGain) * predictedUncertainty;

	// Clamp estimate to [0, 1] for probability
	const clampedEstimate = Math.max(0.01, Math.min(0.99, newEstimate));

	// Signal quality based on Kalman gain
	// High gain = trusting measurement (strong signal)
	// Low gain = ignoring measurement (noisy/weak signal)
	let signalQuality: KalmanState["signalQuality"];
	if (kalmanGain > 0.8) signalQuality = "strong";
	else if (kalmanGain > 0.5) signalQuality = "moderate";
	else if (kalmanGain > 0.2) signalQuality = "weak";
	else signalQuality = "noise";

	return {
		estimate: Math.round(clampedEstimate * 10000) / 10000,
		uncertainty: Math.round(newUncertainty * 100000) / 100000,
		kalmanGain: Math.round(kalmanGain * 10000) / 10000,
		residual: Math.round(residual * 10000) / 10000,
		signalQuality,
	};
}

/**
 * Run a full Kalman filter pass over a series of price observations.
 * Returns the final smoothed estimate and the full trajectory.
 *
 * @param observations - Array of observed prices (oldest first)
 * @param processNoise - Q parameter (default 0.001)
 * @param measurementNoise - R parameter (default 0.01)
 * @returns Final state and trajectory
 */
export function kalmanFilterSeries(
	observations: number[],
	processNoise = 0.001,
	measurementNoise = 0.01,
): { final: KalmanState; trajectory: number[] } {
	if (observations.length === 0) {
		return {
			final: { estimate: 0.5, uncertainty: 0.25, kalmanGain: 0, residual: 0, signalQuality: "noise" },
			trajectory: [],
		};
	}

	let state = observations[0];
	let uncertainty = 0.25; // Start with maximum uncertainty
	const trajectory: number[] = [];
	let lastResult: KalmanState = { estimate: state, uncertainty, kalmanGain: 0, residual: 0, signalQuality: "noise" };

	for (const obs of observations) {
		lastResult = kalmanUpdate(state, uncertainty, obs, processNoise, measurementNoise);
		state = lastResult.estimate;
		uncertainty = lastResult.uncertainty;
		trajectory.push(state);
	}

	return { final: lastResult, trajectory };
}

// ── Wash Trading Detection (Cycle 007) ──

/**
 * Detect potential wash trading patterns in a market using volume and trade behavior signals.
 *
 * Research basis (Cycle 007):
 * - Columbia University: ~25% of Polymarket volume is wash trading (Nov 2025)
 * - Peak of 60% fake volume in Dec 2024; sports/election markets most affected
 * - Key signals: round-number clustering, rapid open-close patterns, volume without
 *   price movement, Benford's Law violations in trade sizes
 * - Network-based detection: wallets forming closed trading clusters
 *
 * This implementation uses observable market-level signals (no wallet-level data needed).
 *
 * @param volume24h - 24-hour trading volume
 * @param priceChange24h - Absolute price change over 24 hours
 * @param tradeCount24h - Number of trades in 24 hours
 * @param avgTradeSize - Average trade size in USD
 * @param liquidity - Current liquidity in USD
 * @returns Wash trading risk assessment
 */
export interface WashTradingSignal {
	/** Overall wash trading risk score (0-1, higher = more suspicious) */
	riskScore: number;
	/** Whether wash trading is suspected */
	isSuspicious: boolean;
	/** Volume-to-price-movement ratio: high volume with no price change = suspicious */
	volumePriceRatio: number;
	/** Trade size uniformity: very uniform sizes suggest automated wash trading */
	sizeUniformityFlag: boolean;
	/** Volume-to-liquidity ratio: very high ratio = suspicious churn */
	volumeLiquidityRatio: number;
	/** Recommended volume discount factor (multiply reported volume by this) */
	volumeDiscountFactor: number;
	/** Specific flags triggered */
	flags: string[];
}

export function detectWashTrading(
	volume24h: number,
	priceChange24h: number,
	tradeCount24h: number,
	avgTradeSize: number,
	liquidity: number,
): WashTradingSignal {
	const flags: string[] = [];
	let riskScore = 0;

	// Signal 1: High volume with minimal price movement
	// Genuine trading moves prices; wash trading explicitly avoids moving prices
	const volumePriceRatio = priceChange24h > 0.001
		? volume24h / (priceChange24h * 1000)
		: volume24h > 0 ? Infinity : 0;
	if (volumePriceRatio > 500) {
		riskScore += 0.30;
		flags.push("high_volume_no_price_movement");
	} else if (volumePriceRatio > 200) {
		riskScore += 0.15;
		flags.push("elevated_volume_price_ratio");
	}

	// Signal 2: Volume-to-liquidity ratio
	// Normal markets: V/L ratio < 5x. Wash trading: V/L ratio > 10x
	const volumeLiquidityRatio = liquidity > 0 ? volume24h / liquidity : 0;
	if (volumeLiquidityRatio > 20) {
		riskScore += 0.30;
		flags.push("extreme_volume_liquidity_ratio");
	} else if (volumeLiquidityRatio > 10) {
		riskScore += 0.15;
		flags.push("elevated_volume_liquidity_ratio");
	}

	// Signal 3: Trade size uniformity (round numbers, very similar sizes)
	// Columbia study found wash trades cluster at sub-penny prices and round amounts
	const sizeUniformityFlag = avgTradeSize > 0 && avgTradeSize === Math.round(avgTradeSize);
	if (sizeUniformityFlag && tradeCount24h > 50) {
		riskScore += 0.15;
		flags.push("uniform_round_trade_sizes");
	}

	// Signal 4: Very high trade frequency relative to liquidity
	// Rapid open-close patterns are a hallmark of wash trading
	const tradesPerDollarLiq = liquidity > 0 ? tradeCount24h / liquidity : 0;
	if (tradesPerDollarLiq > 0.1) {
		riskScore += 0.15;
		flags.push("excessive_trade_frequency");
	}

	// Signal 5: Tiny average trade size (Columbia: sub-penny trades)
	if (avgTradeSize > 0 && avgTradeSize < 1) {
		riskScore += 0.10;
		flags.push("sub_dollar_trade_sizes");
	}

	riskScore = Math.min(1, riskScore);
	const isSuspicious = riskScore >= 0.40;

	// Discount factor: reduce trust in volume proportional to risk
	// At risk=0, full trust. At risk=1, discount to 25% (Columbia's floor estimate)
	const volumeDiscountFactor = Math.max(0.25, 1 - riskScore * 0.75);

	return {
		riskScore: Math.round(riskScore * 10000) / 10000,
		isSuspicious,
		volumePriceRatio: volumePriceRatio === Infinity ? Infinity : Math.round(volumePriceRatio * 100) / 100,
		sizeUniformityFlag,
		volumeLiquidityRatio: Math.round(volumeLiquidityRatio * 100) / 100,
		volumeDiscountFactor: Math.round(volumeDiscountFactor * 10000) / 10000,
		flags,
	};
}

// ── Market Impact Estimation (Cycle 007) ──

/**
 * Estimate the market impact (slippage) of a trade on a prediction market.
 *
 * Uses the square-root market impact model, which is empirically validated
 * across multiple asset classes and market structures.
 *
 * Research basis (Cycle 007):
 * - Berkeley: market impact proportional to sqrt(volume) for large orders
 * - Impact is linear for small orders, crosses to sqrt for large orders
 * - For prediction markets: liquidity is typically thin, so impact is amplified
 * - Practitioners use: impact = sigma * sqrt(Q/V) where Q=order size, V=daily volume
 *
 * @param orderSize - Proposed order size in USD
 * @param dailyVolume - Average daily volume in USD
 * @param liquidity - Current liquidity/depth in USD
 * @param currentSpread - Current bid-ask spread (0-1)
 * @returns Estimated impact and execution recommendations
 */
export interface MarketImpactEstimate {
	/** Estimated price impact as a fraction (e.g., 0.02 = 2% price movement) */
	estimatedImpact: number;
	/** Estimated cost of impact in USD */
	impactCostUsd: number;
	/** Total execution cost (spread + impact) as a fraction */
	totalExecutionCost: number;
	/** Participation rate: order size as fraction of daily volume */
	participationRate: number;
	/** Recommended execution strategy */
	strategy: "single_order" | "split_orders" | "twap" | "do_not_trade";
	/** If splitting, recommended number of slices */
	recommendedSlices: number;
	/** Maximum recommended single-order size */
	maxSingleOrderSize: number;
}

export function estimateMarketImpact(
	orderSize: number,
	dailyVolume: number,
	liquidity: number,
	currentSpread: number,
): MarketImpactEstimate {
	if (orderSize <= 0 || dailyVolume <= 0) {
		return {
			estimatedImpact: 0,
			impactCostUsd: 0,
			totalExecutionCost: 0,
			participationRate: 0,
			strategy: "single_order",
			recommendedSlices: 1,
			maxSingleOrderSize: 0,
		};
	}

	// Participation rate
	const participationRate = orderSize / dailyVolume;

	// Square-root impact model: impact = k * sqrt(Q / V)
	// k calibrated for thin prediction markets (higher than equities)
	const impactCoefficient = 0.10; // calibrated for prediction market thinness
	const estimatedImpact = impactCoefficient * Math.sqrt(participationRate);

	// Impact cost
	const impactCostUsd = orderSize * estimatedImpact;

	// Total cost: half-spread (crossing the spread) + impact
	const halfSpread = currentSpread / 2;
	const totalExecutionCost = halfSpread + estimatedImpact;

	// Execution strategy based on participation rate
	let strategy: MarketImpactEstimate["strategy"];
	let recommendedSlices = 1;

	if (participationRate > 0.20) {
		strategy = "do_not_trade"; // >20% of daily volume = too impactful
		recommendedSlices = 0;
	} else if (participationRate > 0.05) {
		strategy = "twap"; // 5-20%: use time-weighted average price
		recommendedSlices = Math.ceil(participationRate * 20); // ~5% per slice
	} else if (participationRate > 0.01) {
		strategy = "split_orders"; // 1-5%: split into 2-3 orders
		recommendedSlices = Math.ceil(participationRate * 50);
	} else {
		strategy = "single_order"; // <1%: no splitting needed
	}

	// Max single order: 1% of daily volume or 5% of liquidity, whichever is smaller
	const maxSingleOrderSize = Math.min(dailyVolume * 0.01, liquidity * 0.05);

	return {
		estimatedImpact: Math.round(estimatedImpact * 10000) / 10000,
		impactCostUsd: Math.round(impactCostUsd * 100) / 100,
		totalExecutionCost: Math.round(totalExecutionCost * 10000) / 10000,
		participationRate: Math.round(participationRate * 10000) / 10000,
		strategy,
		// do_not_trade returns 0 slices; all others return at least 1
		recommendedSlices: strategy === "do_not_trade" ? 0 : Math.max(1, recommendedSlices),
		maxSingleOrderSize: Math.round(maxSingleOrderSize * 100) / 100,
	};
}

// ── Barbell Portfolio Construction (Cycle 007) ──

/**
 * Barbell portfolio allocation for prediction market betting.
 *
 * Taleb's barbell strategy applied to prediction markets:
 * - 85-90% of bankroll in high-confidence, moderate-edge bets (the "safe" end)
 * - 10-15% in high-IV longshot contrarian bets (the "speculative" end)
 * - Avoid the middle: moderate-confidence, moderate-edge bets
 *
 * Research basis (Cycle 007):
 * - Taleb: 90% safe / 10% speculative; avoid medium risk (the "sucker" zone)
 * - Antifragility: barbell gains from volatility rather than being destroyed by it
 * - Prediction markets: longshots are systematically overpriced (longshot bias)
 *   BUT occasionally massive mis-pricings create asymmetric payoffs
 * - Safe end: high CLV, well-calibrated categories (politics)
 * - Speculative end: contrarian signals, new markets, high IV
 *
 * @param opportunities - Array of market opportunities with their characteristics
 * @param bankroll - Total bankroll in USD
 * @param speculativeAllocation - Fraction for speculative end (default 0.10)
 * @returns Barbell-allocated positions
 */
export interface BarbellOpportunity {
	marketId: string;
	edge: number;
	confidence: number;
	iv: number;
	isContrarian: boolean;
	isNewMarket: boolean;
	proposedSize: number;
}

export interface BarbellAllocation {
	/** Safe-end positions (high confidence, moderate edge) */
	safePositions: Array<{ marketId: string; allocatedSize: number; reason: string }>;
	/** Speculative-end positions (longshots, contrarian, new markets) */
	speculativePositions: Array<{ marketId: string; allocatedSize: number; reason: string }>;
	/** Markets in the "avoid" zone (medium risk) */
	avoidedMarkets: Array<{ marketId: string; reason: string }>;
	/** Total allocated to safe end */
	safeTotal: number;
	/** Total allocated to speculative end */
	speculativeTotal: number;
	/** Unallocated bankroll (held as cash) */
	cashReserve: number;
	/** Portfolio balance score (0-1, closer to target ratio = better) */
	balanceScore: number;
}

export function barbellAllocate(
	opportunities: BarbellOpportunity[],
	bankroll: number,
	speculativeAllocation = 0.10,
): BarbellAllocation {
	const safePositions: BarbellAllocation["safePositions"] = [];
	const speculativePositions: BarbellAllocation["speculativePositions"] = [];
	const avoidedMarkets: BarbellAllocation["avoidedMarkets"] = [];

	const safeBudget = bankroll * (1 - speculativeAllocation);
	const specBudget = bankroll * speculativeAllocation;

	let safeTotal = 0;
	let specTotal = 0;

	for (const opp of opportunities) {
		// Classify into barbell ends
		const isSpeculative = opp.isContrarian || opp.isNewMarket || opp.iv >= 0.20;
		const isSafe = opp.confidence >= 0.6 && opp.edge >= 0.03 && !opp.isContrarian;
		const isMiddle = !isSpeculative && !isSafe;

		if (isMiddle) {
			avoidedMarkets.push({
				marketId: opp.marketId,
				reason: "Middle zone: moderate confidence + moderate edge = poor risk/reward",
			});
			continue;
		}

		if (isSafe && safeTotal < safeBudget) {
			const size = Math.min(opp.proposedSize, safeBudget - safeTotal);
			if (size > 0) {
				safePositions.push({
					marketId: opp.marketId,
					allocatedSize: Math.round(size * 100) / 100,
					reason: `Safe end: conf=${opp.confidence.toFixed(2)}, edge=${opp.edge.toFixed(3)}`,
				});
				safeTotal += size;
			}
		} else if (isSpeculative && specTotal < specBudget) {
			// Speculative positions are capped at smaller individual sizes
			const maxSpecSize = specBudget * 0.25; // Max 25% of spec budget per position
			const size = Math.min(opp.proposedSize, maxSpecSize, specBudget - specTotal);
			if (size > 0) {
				const reasons: string[] = [];
				if (opp.isContrarian) reasons.push("contrarian");
				if (opp.isNewMarket) reasons.push("new_market");
				if (opp.iv >= 0.20) reasons.push(`high_iv=${opp.iv.toFixed(2)}`);
				speculativePositions.push({
					marketId: opp.marketId,
					allocatedSize: Math.round(size * 100) / 100,
					reason: `Speculative end: ${reasons.join(", ")}`,
				});
				specTotal += size;
			}
		}
	}

	const cashReserve = bankroll - safeTotal - specTotal;
	const targetRatio = speculativeAllocation;
	const totalAllocated = safeTotal + specTotal;
	const actualRatio = totalAllocated > 0 ? specTotal / totalAllocated : 0;
	const balanceScore = totalAllocated > 0 ? Math.max(0, 1 - Math.abs(actualRatio - targetRatio) * 5) : 0;

	return {
		safePositions,
		speculativePositions,
		avoidedMarkets,
		safeTotal: Math.round(safeTotal * 100) / 100,
		speculativeTotal: Math.round(specTotal * 100) / 100,
		cashReserve: Math.round(cashReserve * 100) / 100,
		balanceScore: Math.round(balanceScore * 10000) / 10000,
	};
}

// ── Transfer Learning Calibration (Cycle 007) ──

/**
 * Cross-category calibration transfer — rapidly calibrate forecasts in a new
 * or under-sampled category by borrowing calibration data from similar categories.
 *
 * Research basis (Cycle 007):
 * - Transfer learning improves predictions when source and target share patterns
 * - ScienceDirect: "similarity between source and target is more important than dataset size"
 * - Few-shot calibration: only 5-10 samples needed if transfer source is good
 * - For prediction markets: politics→economics transfer is strong (both structural),
 *   crypto→sports transfer is weak (fundamentally different dynamics)
 *
 * @param targetCategory - The under-sampled category needing calibration
 * @param sourceBrierScores - Map of category → recent Brier scores
 * @param minSamples - Minimum samples before a category is "sufficient" (default 30)
 * @returns Transfer recommendation
 */
export interface TransferCalibration {
	/** Target category needing calibration help */
	targetCategory: string;
	/** Whether transfer is recommended */
	shouldTransfer: boolean;
	/** Source category to borrow calibration from */
	sourceCategory: string | null;
	/** Similarity score between source and target (0-1) */
	similarityScore: number;
	/** Blending weight: how much to trust transfer vs. own data */
	blendWeight: number;
	/** Transferred Platt parameters (weighted blend) */
	transferredPlattA: number;
}

// Category similarity matrix — manually curated from domain expertise
// Higher = more transferable calibration
const CATEGORY_SIMILARITY: Record<string, Record<string, number>> = {
	politics: { economics: 0.7, science: 0.4, tech: 0.3, sports: 0.1, crypto: 0.2, weather: 0.2, entertainment: 0.2 },
	economics: { politics: 0.7, tech: 0.5, crypto: 0.4, science: 0.3, sports: 0.1, weather: 0.3, entertainment: 0.1 },
	crypto: { economics: 0.4, tech: 0.5, politics: 0.2, science: 0.2, sports: 0.1, weather: 0.1, entertainment: 0.1 },
	tech: { economics: 0.5, crypto: 0.5, science: 0.6, politics: 0.3, sports: 0.1, weather: 0.1, entertainment: 0.3 },
	science: { tech: 0.6, weather: 0.5, politics: 0.4, economics: 0.3, crypto: 0.2, sports: 0.1, entertainment: 0.1 },
	sports: { entertainment: 0.3, politics: 0.1, economics: 0.1, crypto: 0.1, tech: 0.1, science: 0.1, weather: 0.2 },
	weather: { science: 0.5, economics: 0.3, politics: 0.2, crypto: 0.1, tech: 0.1, sports: 0.2, entertainment: 0.1 },
	entertainment: { sports: 0.3, tech: 0.3, politics: 0.2, economics: 0.1, crypto: 0.1, science: 0.1, weather: 0.1 },
};

export function computeTransferCalibration(
	targetCategory: string,
	sourceBrierScores: Record<string, { brier: number; sampleCount: number; plattA: number }>,
	minSamples = 30,
): TransferCalibration {
	const targetData = sourceBrierScores[targetCategory];
	const targetHasSufficientData = targetData && targetData.sampleCount >= minSamples;

	// If target already has sufficient data, no transfer needed
	if (targetHasSufficientData) {
		return {
			targetCategory,
			shouldTransfer: false,
			sourceCategory: null,
			similarityScore: 0,
			blendWeight: 0,
			transferredPlattA: targetData.plattA,
		};
	}

	// Find the best source category: highest similarity * lowest Brier * sufficient data
	const similarities = CATEGORY_SIMILARITY[targetCategory] ?? {};
	let bestSource: string | null = null;
	let bestScore = 0;
	let bestSimilarity = 0;

	for (const [cat, data] of Object.entries(sourceBrierScores)) {
		if (cat === targetCategory) continue;
		if (data.sampleCount < minSamples) continue;

		const similarity = similarities[cat] ?? 0.1;
		// Score = similarity * (1 - brier) — prefer similar categories with good performance
		const score = similarity * (1 - Math.min(1, data.brier));

		if (score > bestScore) {
			bestScore = score;
			bestSource = cat;
			bestSimilarity = similarity;
		}
	}

	if (!bestSource || bestSimilarity < 0.2) {
		// No good transfer source available
		return {
			targetCategory,
			shouldTransfer: false,
			sourceCategory: null,
			similarityScore: 0,
			blendWeight: 0,
			transferredPlattA: targetData?.plattA ?? 0.75, // default
		};
	}

	const sourceData = sourceBrierScores[bestSource];

	// Blend weight depends on how much target data we have
	// With 0 target samples: use 100% transfer
	// With minSamples/2: use 50% transfer
	const targetSamples = targetData?.sampleCount ?? 0;
	const blendWeight = Math.max(0, 1 - targetSamples / minSamples);

	// Blended Platt A parameter
	const targetPlattA = targetData?.plattA ?? 0.75;
	const transferredPlattA = blendWeight * sourceData.plattA + (1 - blendWeight) * targetPlattA;

	return {
		targetCategory,
		shouldTransfer: true,
		sourceCategory: bestSource,
		similarityScore: Math.round(bestSimilarity * 10000) / 10000,
		blendWeight: Math.round(blendWeight * 10000) / 10000,
		transferredPlattA: Math.round(transferredPlattA * 10000) / 10000,
	};
}

// ── Portfolio Correlation Matrix (Cycle 012) ──

/**
 * Category-based default correlation coefficients for prediction market positions.
 *
 * Intra-category: high (same topic = correlated outcomes)
 * Cross-category: low to zero (different topics = independent events)
 *
 * These are prior estimates based on market structure. Replace with empirical
 * rolling correlations once enough price history is accumulated.
 *
 * Research basis: prediction market category correlation analysis (Cycle 012)
 */
const CATEGORY_CORRELATIONS: Record<string, Record<string, number>> = {
	politics:    { politics: 0.60, crypto: 0.10, sports: 0.05, weather: 0.00, economics: 0.30, science: 0.10, entertainment: 0.05, default: 0.15 },
	crypto:      { politics: 0.10, crypto: 0.50, sports: 0.05, weather: 0.00, economics: 0.20, science: 0.05, entertainment: 0.05, default: 0.10 },
	sports:      { politics: 0.05, crypto: 0.05, sports: 0.10, weather: 0.05, economics: 0.05, science: 0.05, entertainment: 0.10, default: 0.05 },
	weather:     { politics: 0.00, crypto: 0.00, sports: 0.05, weather: 0.15, economics: 0.05, science: 0.10, entertainment: 0.00, default: 0.05 },
	economics:   { politics: 0.30, crypto: 0.20, sports: 0.05, weather: 0.05, economics: 0.50, science: 0.10, entertainment: 0.05, default: 0.15 },
	science:     { politics: 0.10, crypto: 0.05, sports: 0.05, weather: 0.10, economics: 0.10, science: 0.30, entertainment: 0.05, default: 0.10 },
	entertainment: { politics: 0.05, crypto: 0.05, sports: 0.10, weather: 0.00, economics: 0.05, science: 0.05, entertainment: 0.30, default: 0.05 },
	default:     { politics: 0.15, crypto: 0.10, sports: 0.05, weather: 0.05, economics: 0.15, science: 0.10, entertainment: 0.05, default: 0.20 },
};

/**
 * Get the estimated correlation between two prediction market categories.
 * Returns a value in [0, 1] representing how correlated positions in these
 * categories are expected to be.
 */
export function getCategoryCorrelation(catA: string, catB: string): number {
	const rowA = CATEGORY_CORRELATIONS[catA] ?? CATEGORY_CORRELATIONS.default;
	return rowA[catB] ?? CATEGORY_CORRELATIONS.default[catB] ?? 0.10;
}

export interface PortfolioCorrelationResult {
	/** Average pairwise correlation across all positions */
	averageCorrelation: number;
	/** Portfolio diversification ratio: weighted avg vol / portfolio vol */
	diversificationRatio: number;
	/** Category concentration: how much of portfolio is in one category */
	maxCategoryConcentration: number;
	/** Suggested action based on correlation analysis */
	suggestion: "well_diversified" | "moderately_concentrated" | "highly_concentrated" | "single_category_risk";
	/** Pairwise correlation matrix (only for positions passed in) */
	correlationPairs: Array<{ catA: string; catB: string; correlation: number }>;
}

/**
 * Analyze portfolio-level correlation risk across active positions.
 *
 * Uses category-based correlation priors to estimate how correlated the
 * current portfolio is. Higher correlation = less diversification benefit.
 *
 * @param positions - Array of { category, weight } for each open position
 *   where weight = position size / total portfolio value
 */
export function analyzePortfolioCorrelation(
	positions: Array<{ category: string; weight: number; probability: number }>,
): PortfolioCorrelationResult {
	if (positions.length === 0) {
		return {
			averageCorrelation: 0,
			diversificationRatio: 1,
			maxCategoryConcentration: 0,
			suggestion: "well_diversified",
			correlationPairs: [],
		};
	}

	if (positions.length === 1) {
		return {
			averageCorrelation: 1,
			diversificationRatio: 1,
			maxCategoryConcentration: 1,
			suggestion: "single_category_risk",
			correlationPairs: [],
		};
	}

	// Normalize weights
	const totalWeight = positions.reduce((s, p) => s + p.weight, 0);
	const normalizedPositions = positions.map((p) => ({
		...p,
		weight: totalWeight > 0 ? p.weight / totalWeight : 1 / positions.length,
	}));

	// Compute pairwise correlations
	const pairs: Array<{ catA: string; catB: string; correlation: number }> = [];
	let weightedCorrelationSum = 0;
	let weightProductSum = 0;

	for (let i = 0; i < normalizedPositions.length; i++) {
		for (let j = i + 1; j < normalizedPositions.length; j++) {
			const a = normalizedPositions[i];
			const b = normalizedPositions[j];
			const corr = getCategoryCorrelation(a.category, b.category);

			pairs.push({ catA: a.category, catB: b.category, correlation: corr });

			const weightProduct = a.weight * b.weight;
			weightedCorrelationSum += corr * weightProduct;
			weightProductSum += weightProduct;
		}
	}

	const averageCorrelation = weightProductSum > 0
		? Math.round((weightedCorrelationSum / weightProductSum) * 10000) / 10000
		: 0;

	// Portfolio variance using correlation matrix
	// var(P) = sum_i sum_j w_i * w_j * sigma_i * sigma_j * rho_ij
	// For binary: sigma_i = sqrt(p_i * (1 - p_i))
	let portfolioVariance = 0;
	let weightedAvgVariance = 0;

	for (let i = 0; i < normalizedPositions.length; i++) {
		const pi = normalizedPositions[i];
		const sigmaI = Math.sqrt(pi.probability * (1 - pi.probability));

		weightedAvgVariance += pi.weight * sigmaI;

		for (let j = 0; j < normalizedPositions.length; j++) {
			const pj = normalizedPositions[j];
			const sigmaJ = Math.sqrt(pj.probability * (1 - pj.probability));
			const rho = i === j ? 1 : getCategoryCorrelation(pi.category, pj.category);

			portfolioVariance += pi.weight * pj.weight * sigmaI * sigmaJ * rho;
		}
	}

	const portfolioVol = Math.sqrt(Math.max(0, portfolioVariance));
	const diversificationRatio = portfolioVol > 0
		? Math.round((weightedAvgVariance / portfolioVol) * 10000) / 10000
		: 1;

	// Category concentration
	const categoryWeights = new Map<string, number>();
	for (const p of normalizedPositions) {
		categoryWeights.set(p.category, (categoryWeights.get(p.category) ?? 0) + p.weight);
	}
	const maxCategoryConcentration = Math.round(Math.max(...categoryWeights.values()) * 10000) / 10000;

	// Suggestion based on thresholds
	let suggestion: PortfolioCorrelationResult["suggestion"];
	if (maxCategoryConcentration > 0.80) {
		suggestion = "single_category_risk";
	} else if (averageCorrelation > 0.40 || maxCategoryConcentration > 0.60) {
		suggestion = "highly_concentrated";
	} else if (averageCorrelation > 0.20 || maxCategoryConcentration > 0.40) {
		suggestion = "moderately_concentrated";
	} else {
		suggestion = "well_diversified";
	}

	return {
		averageCorrelation,
		diversificationRatio,
		maxCategoryConcentration,
		suggestion,
		correlationPairs: pairs,
	};
}

/**
 * Compute inverse-volatility (naive risk parity) weights for binary positions.
 *
 * Each position's weight is proportional to 1/sigma where sigma = sqrt(p*(1-p)).
 * Markets near 50/50 (highest uncertainty) get SMALLER allocations.
 * Markets at 80/20 (lower uncertainty) get LARGER allocations.
 *
 * @param positions - Array of position probabilities and current sizes
 * @param totalBudget - Total dollars to allocate
 * @returns Suggested dollar allocation per position
 */
export function riskParityWeights(
	positions: Array<{ marketId: string; probability: number; currentSize: number }>,
	totalBudget: number,
): Array<{ marketId: string; suggestedSize: number; weight: number }> {
	if (positions.length === 0) return [];

	// Compute inverse volatility for each position
	const inverseVols = positions.map((p) => {
		const vol = Math.sqrt(p.probability * (1 - p.probability));
		// Prevent division by zero for extreme probabilities
		return { marketId: p.marketId, inverseVol: vol > 0.01 ? 1 / vol : 100 };
	});

	const totalInverseVol = inverseVols.reduce((s, iv) => s + iv.inverseVol, 0);

	return inverseVols.map((iv) => {
		const weight = Math.round((iv.inverseVol / totalInverseVol) * 10000) / 10000;
		return {
			marketId: iv.marketId,
			suggestedSize: Math.round(totalBudget * weight * 100) / 100,
			weight,
		};
	});
}

/**
 * Generate a prediction signal from EV analysis.
 */
export function generateSignal(
	market: PredictionMarket,
	modelProbability: number,
	bankroll: number,
	reason: string,
): PredictionSignal | null {
	// Check both sides — net of Polymarket taker fees (#63).
	const category = toFeeCategory(market.category);
	const yesEV = calculateEV(modelProbability, market.yesPrice, "yes", category);
	const noEV = calculateEV(modelProbability, market.yesPrice, "no", category);

	// Pick the better side by net EV so a fat gross loser-after-fees cannot win.
	const best = yesEV.netEV > noEV.netEV ? { side: "yes" as const, ev: yesEV } : { side: "no" as const, ev: noEV };

	if (!best.ev.isPositiveEV) return null;

	// Confidence based on edge magnitude and liquidity
	const edgeConfidence = Math.min(1, Math.abs(best.ev.edge) * 5); // 20% edge = full confidence
	const liquidityConfidence = Math.min(1, market.liquidity / 10000); // $10k liquidity = full confidence
	const confidence = edgeConfidence * 0.7 + liquidityConfidence * 0.3;

	if (confidence < 0.3) return null; // Too low confidence

	return {
		marketId: market.id,
		exchange: market.exchange,
		question: market.question,
		side: best.side,
		modelProbability,
		marketPrice: market.yesPrice,
		expectedValue: best.ev.netEV,
		confidence: Math.round(confidence * 1000) / 1000,
		kellyFraction: best.ev.kellyFraction,
		quarterKellySize: Math.round(bankroll * best.ev.quarterKelly * 100) / 100,
		reason,
		timestamp: Date.now(),
	};
}
