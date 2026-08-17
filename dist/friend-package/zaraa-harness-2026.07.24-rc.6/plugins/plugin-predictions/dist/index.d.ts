/**
 * Prediction Market Types — shared data structures for Polymarket, Kalshi, etc.
 *
 * Prediction markets trade binary outcome contracts (Yes/No) that settle at $0 or $1.
 * The price of a Yes token IS the implied probability (e.g., $0.72 = 72% chance).
 */
/** Supported prediction market exchanges */
type PredictionExchange = "polymarket" | "kalshi";
/** Market status */
type MarketStatus = "open" | "closed" | "resolved";
/** A prediction market contract */
interface PredictionMarket {
    /** Unique market ID on the exchange */
    id: string;
    /** Which exchange this market is on */
    exchange: PredictionExchange;
    /** The question being predicted */
    question: string;
    /** Short slug/ticker */
    slug: string;
    /** Category (politics, crypto, sports, weather, etc.) */
    category: string;
    /** Current Yes price (0-1, = implied probability) */
    yesPrice: number;
    /** Current No price (0-1, = 1 - yesPrice) */
    noPrice: number;
    /** Best bid for Yes token */
    yesBid: number;
    /** Best ask for Yes token */
    yesAsk: number;
    /** 24h volume in USD */
    volume24h: number;
    /** Total volume in USD */
    totalVolume: number;
    /** Total liquidity in USD */
    liquidity: number;
    /** When the market expires/resolves */
    expiresAt: string;
    /** Market status */
    status: MarketStatus;
    /** When the market was created (ISO timestamp, optional — not all APIs provide this) */
    createdAt?: string;
    /** Last updated timestamp */
    updatedAt: string;
    /** Outcome token ids when the exchange exposes per-side execution assets. */
    outcomeTokenIds?: {
        yes: string | null;
        no: string | null;
    };
}
/** An order book entry */
interface BookEntry {
    price: number;
    size: number;
}
/** Order book for a market */
interface PredictionOrderBook {
    marketId: string;
    exchange: PredictionExchange;
    bids: BookEntry[];
    asks: BookEntry[];
    midpoint: number;
    spread: number;
    timestamp: string;
}
/** A trade on a prediction market */
interface PredictionTrade {
    id: string;
    marketId: string;
    exchange: PredictionExchange;
    side: "yes" | "no";
    price: number;
    size: number;
    timestamp: string;
}
/** Position in a prediction market */
interface PredictionPosition {
    marketId: string;
    exchange: PredictionExchange;
    question: string;
    side: "yes" | "no";
    avgPrice: number;
    size: number;
    currentPrice: number;
    unrealizedPnl: number;
    /** Expected value = (probability * $1 - avgPrice) * size */
    expectedValue: number;
}
/** Signal from the prediction market analyzer */
interface PredictionSignal {
    marketId: string;
    exchange: PredictionExchange;
    question: string;
    /** Buy yes or buy no */
    side: "yes" | "no";
    /** Model's estimated true probability (0-1) */
    modelProbability: number;
    /** Market's current price (= implied probability) */
    marketPrice: number;
    /** Expected value net of Polymarket taker fees */
    expectedValue: number;
    /** Confidence in the signal (0-1) */
    confidence: number;
    /** Suggested position size as fraction of bankroll (Kelly criterion) */
    kellyFraction: number;
    /** Quarter-Kelly position size (conservative) */
    quarterKellySize: number;
    /** Reason for the signal */
    reason: string;
    timestamp: number;
}
/** Configuration for connecting to a prediction exchange */
interface PredictionExchangeConfig {
    exchange: PredictionExchange;
    /** API key or private key */
    apiKey?: string;
    /** API secret (for Kalshi) */
    apiSecret?: string;
    /** Whether to use sandbox/testnet */
    sandbox?: boolean;
}

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

interface EVResult {
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
type FeeCategory = "crypto" | "politics" | "finance" | "culture" | "weather" | "other";
declare function calculateEV(modelProb: number, marketPrice: number, side: "yes" | "no", category?: FeeCategory): EVResult;
/**
 * Position sizing limits to prevent concentration risk.
 * Based on research: estimation error is the #1 killer with Kelly sizing.
 * Quarter-Kelly with LLM estimates is the FLOOR, not conservative.
 */
interface PositionLimits {
    /** Maximum fraction of bankroll per single market (default: 0.05 = 5%) */
    maxPerMarket: number;
    /** Maximum total exposure across all prediction markets (default: 0.30 = 30%) */
    maxTotalExposure: number;
    /** Maximum exposure in any single category (default: 0.15 = 15%) */
    maxPerCategory: number;
}
declare const DEFAULT_POSITION_LIMITS: PositionLimits;
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
declare function confidenceAdjustedKelly(quarterKelly: number, confidence: number, confidenceThreshold?: number): number;
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
declare function applyPositionLimits(proposedSize: number, bankroll: number, currentExposure?: number, currentCategoryExposure?: number, limits?: PositionLimits): number;
/**
 * KL Divergence between two probability distributions.
 * Used to detect cross-market inefficiencies.
 *
 * @param p - Model probabilities [p_yes, p_no]
 * @param q - Market probabilities [q_yes, q_no]
 * @returns KL(P || Q) — higher = more divergent = bigger potential edge
 */
declare function klDivergence(p: [number, number], q: [number, number]): number;
/**
 * Detect cross-market inefficiencies between two markets for correlated events.
 * When two markets should be related but their prices diverge, there's an arb opportunity.
 *
 * @param primary - The main market
 * @param related - A correlated market
 * @param expectedCorrelation - How correlated these markets should be (0-1)
 * @returns Divergence score and whether it's actionable
 */
declare function detectInefficiency(primary: PredictionMarket, related: PredictionMarket, expectedCorrelation: number): {
    divergence: number;
    actionable: boolean;
    suggestion: string;
};
/**
 * Bayesian probability update.
 * Update a prior probability given new evidence.
 *
 * @param prior - Prior probability (0-1)
 * @param likelihoodGivenTrue - P(evidence | event is true)
 * @param likelihoodGivenFalse - P(evidence | event is false)
 * @returns Updated posterior probability
 */
declare function bayesianUpdate(prior: number, likelihoodGivenTrue: number, likelihoodGivenFalse: number): number;
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
declare function timeDecayKellyAdjustment(kellySize: number, hoursToExpiry: number): number;
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
declare function detectCTFArbitrage(yesPrice: number, noPrice: number, threshold?: number): {
    hasArbitrage: boolean;
    deviation: number;
    direction: "buy_pair" | "sell_pair" | "none";
    profitPerPair: number;
};
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
interface RegimeSignals {
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
declare function detectRegimeShift(volume24h: number, avgVolume7d: number, currentSpread: number, baselineSpread: number): RegimeSignals;
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
declare function computeBinaryIV(price: number, hoursToExpiry: number): number;
/**
 * Classify a market's opportunity quality based on IV and edge.
 *
 * @param iv - Binary implied volatility from computeBinaryIV
 * @param edge - Absolute edge (|modelProb - marketPrice|)
 * @returns Opportunity class: "prime" | "decent" | "marginal" | "skip"
 */
declare function classifyOpportunity(iv: number, edge: number): "prime" | "decent" | "marginal" | "skip";
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
declare function detectNewMarket(createdAt: string, totalVolume: number, liquidity: number): {
    isNew: boolean;
    priorityScore: number;
    ageHours: number;
};
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
declare function computeCLV(forecastProb: number, closingPrice: number, outcome: 0 | 1): {
    clv: number;
    forecastError: number;
    marketError: number;
    beatMarket: boolean;
};
/**
 * Compute rolling CLV statistics from a series of forecasts.
 * Determines whether the ensemble is adding value vs. just tracking the market.
 *
 * @param records - Array of {forecastProb, closingPrice, outcome} tuples
 * @returns Aggregate CLV stats
 */
declare function aggregateCLV(records: Array<{
    forecastProb: number;
    closingPrice: number;
    outcome: 0 | 1;
}>): {
    avgCLV: number;
    beatMarketRate: number;
    count: number;
    isSharp: boolean;
};
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
interface HerdingSignal {
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
declare function detectHerding(currentPrice: number, priceHistory: number[], volume24h: number, avgVolume7d: number): HerdingSignal;
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
interface ConformalInterval {
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
declare function computeConformalInterval(calibrationScores: number[], forecast: number, alpha?: number): ConformalInterval;
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
interface MetacognitiveState {
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
declare function computeMetacognitiveState(category: string, recentForecasts: Array<{
    forecastProb: number;
    closingPrice: number;
    outcome: 0 | 1;
}>, windowSize?: number): MetacognitiveState;
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
interface MarketEntropy {
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
declare function computeMarketEntropy(price: number): MarketEntropy;
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
declare function computeInformationGain(oldPrice: number, newPrice: number): number;
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
interface KalmanState {
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
declare function kalmanUpdate(state: number, uncertainty: number, measurement: number, processNoise?: number, measurementNoise?: number): KalmanState;
/**
 * Run a full Kalman filter pass over a series of price observations.
 * Returns the final smoothed estimate and the full trajectory.
 *
 * @param observations - Array of observed prices (oldest first)
 * @param processNoise - Q parameter (default 0.001)
 * @param measurementNoise - R parameter (default 0.01)
 * @returns Final state and trajectory
 */
declare function kalmanFilterSeries(observations: number[], processNoise?: number, measurementNoise?: number): {
    final: KalmanState;
    trajectory: number[];
};
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
interface WashTradingSignal {
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
declare function detectWashTrading(volume24h: number, priceChange24h: number, tradeCount24h: number, avgTradeSize: number, liquidity: number): WashTradingSignal;
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
interface MarketImpactEstimate {
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
declare function estimateMarketImpact(orderSize: number, dailyVolume: number, liquidity: number, currentSpread: number): MarketImpactEstimate;
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
interface BarbellOpportunity {
    marketId: string;
    edge: number;
    confidence: number;
    iv: number;
    isContrarian: boolean;
    isNewMarket: boolean;
    proposedSize: number;
}
interface BarbellAllocation {
    /** Safe-end positions (high confidence, moderate edge) */
    safePositions: Array<{
        marketId: string;
        allocatedSize: number;
        reason: string;
    }>;
    /** Speculative-end positions (longshots, contrarian, new markets) */
    speculativePositions: Array<{
        marketId: string;
        allocatedSize: number;
        reason: string;
    }>;
    /** Markets in the "avoid" zone (medium risk) */
    avoidedMarkets: Array<{
        marketId: string;
        reason: string;
    }>;
    /** Total allocated to safe end */
    safeTotal: number;
    /** Total allocated to speculative end */
    speculativeTotal: number;
    /** Unallocated bankroll (held as cash) */
    cashReserve: number;
    /** Portfolio balance score (0-1, closer to target ratio = better) */
    balanceScore: number;
}
declare function barbellAllocate(opportunities: BarbellOpportunity[], bankroll: number, speculativeAllocation?: number): BarbellAllocation;
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
interface TransferCalibration {
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
declare function computeTransferCalibration(targetCategory: string, sourceBrierScores: Record<string, {
    brier: number;
    sampleCount: number;
    plattA: number;
}>, minSamples?: number): TransferCalibration;
/**
 * Get the estimated correlation between two prediction market categories.
 * Returns a value in [0, 1] representing how correlated positions in these
 * categories are expected to be.
 */
declare function getCategoryCorrelation(catA: string, catB: string): number;
interface PortfolioCorrelationResult {
    /** Average pairwise correlation across all positions */
    averageCorrelation: number;
    /** Portfolio diversification ratio: weighted avg vol / portfolio vol */
    diversificationRatio: number;
    /** Category concentration: how much of portfolio is in one category */
    maxCategoryConcentration: number;
    /** Suggested action based on correlation analysis */
    suggestion: "well_diversified" | "moderately_concentrated" | "highly_concentrated" | "single_category_risk";
    /** Pairwise correlation matrix (only for positions passed in) */
    correlationPairs: Array<{
        catA: string;
        catB: string;
        correlation: number;
    }>;
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
declare function analyzePortfolioCorrelation(positions: Array<{
    category: string;
    weight: number;
    probability: number;
}>): PortfolioCorrelationResult;
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
declare function riskParityWeights(positions: Array<{
    marketId: string;
    probability: number;
    currentSize: number;
}>, totalBudget: number): Array<{
    marketId: string;
    suggestedSize: number;
    weight: number;
}>;
/**
 * Generate a prediction signal from EV analysis.
 */
declare function generateSignal(market: PredictionMarket, modelProbability: number, bankroll: number, reason: string): PredictionSignal | null;

interface ForecastResult {
    /** Raw probability from the model (0-1) */
    probability: number;
    /** Calibrated probability after Platt scaling */
    calibratedProbability: number;
    /** Model confidence (0-1) */
    confidence: number;
    /** Model's reasoning text */
    reasoning: string;
    /** Which model produced this */
    model: string;
}
interface EnsembleForecast {
    /** Final calibrated probability */
    finalProbability: number;
    /** Overall confidence (0-1) */
    confidence: number;
    /** Individual model votes */
    votes: ForecastResult[];
    /** How the votes were combined */
    aggregationMethod: "trimmed_mean" | "weighted";
    /** Whether spread penalty was applied due to model disagreement */
    spreadPenaltyApplied: boolean;
}
/** A function that calls an LLM and returns the text response */
type ModelCaller = (model: string, prompt: string) => Promise<string>;
interface PlattParams {
    /** Logistic slope (< 1 compresses toward 0.5) */
    a: number;
    /** Logistic intercept (directional bias) */
    b: number;
}
/**
 * Category-specific calibration parameters derived from KalshiBench research.
 * Models are systematically overconfident at extremes — these compress toward 0.5.
 */
declare const CATEGORY_CALIBRATION: Record<string, PlattParams>;
/**
 * Apply Platt scaling to compress raw probability toward 0.5.
 * This corrects systematic overconfidence at the extremes.
 */
declare function plattScale(rawProb: number, params: PlattParams): number;
/**
 * Correct for the empirically-observed longshot bias in prediction markets.
 * Traders systematically overpay for longshots (low-probability events)
 * and underpay for favorites (high-probability events).
 */
declare function longshotBiasAdjustment(marketPrice: number): number;
interface LLMForecasterConfig {
    /** Model names to query */
    models: string[];
    /** Initial model weights (model name → weight, must sum to ~1) */
    modelWeights: Record<string, number>;
    /** Minimum ensemble spread to trigger spread penalty */
    spreadPenaltyThreshold: number;
    /** Custom calibration overrides by category */
    calibrationOverrides?: Record<string, PlattParams>;
}
declare class LLMForecaster {
    private config;
    private callModel;
    /** Per-model per-category Brier score history for adaptive reweighting */
    private brierScores;
    constructor(callModel: ModelCaller, config?: Partial<LLMForecasterConfig>);
    /**
     * Run ensemble forecast for a prediction market.
     * Each model estimates independently, results are aggregated with calibration.
     */
    forecast(market: PredictionMarket): Promise<EnsembleForecast>;
    /**
     * Get a single model's forecast with calibration applied.
     * Retries once on transient errors (timeout, network); fails fast on permanent errors (auth, quota).
     */
    private singleModelForecast;
    /**
     * Aggregate individual model votes into an ensemble forecast.
     * Uses trimmed mean (drop outliers) with model-weight weighting.
     */
    private aggregate;
    /**
     * Record the actual outcome after a market resolves.
     * Used to compute Brier scores and adaptively reweight models.
     */
    recordOutcome(model: string, category: string, predicted: number, actual: 0 | 1): void;
    /**
     * Adaptively adjust model weights based on historical Brier scores.
     * Models with lower (better) Brier scores get higher weights.
     */
    private updateWeights;
    /** Get current model weights (may have been adaptively updated) */
    getModelWeights(): Record<string, number>;
    /**
     * Batch forecast multiple markets efficiently.
     * Each market is forecast independently (preserving ensemble independence)
     * but all calls are launched in parallel with controlled concurrency.
     *
     * Cycle 005 addition:
     * - Parallel execution with configurable concurrency limit
     * - Returns partial results (doesn't fail if some markets fail)
     * - Tracks per-market timing for cost analysis
     *
     * @param markets - Array of markets to forecast
     * @param concurrency - Maximum parallel forecasts (default: 3)
     * @returns Map of marketId → forecast result (only successful forecasts)
     */
    batchForecast(markets: PredictionMarket[], concurrency?: number): Promise<Map<string, EnsembleForecast & {
        elapsedMs: number;
    }>>;
    /** Get Brier score history for a model+category */
    getBrierScores(model: string, category?: string): number[];
}
/**
 * Extract probability from structured forecaster response.
 * Checks CALIBRATION_CHECK first (may contain adjusted number),
 * then falls back to FINAL_PROBABILITY.
 */
declare function extractProbability(response: string): number;
/**
 * Extract confidence level from structured forecaster response.
 * Supports 5-level scale (Cycle 003): VERY_LOW, LOW, MEDIUM, HIGH, VERY_HIGH
 * Also considers contrarian check severity — if the model finds a strong
 * counter-argument, confidence is reduced even if stated as HIGH.
 */
declare function extractConfidence(response: string): number;

/**
 * Market Scanner — Scans prediction markets for positive EV opportunities.
 *
 * This is the prediction market equivalent of SignalEngine. It periodically
 * scans all open markets, applies probability models, and generates signals
 * for contracts with positive expected value.
 *
 * Models:
 * - Spread model: Large bid-ask spreads indicate mispricing opportunities
 * - Volume model: Volume-weighted probability estimation
 * - LLM Ensemble (opt-in): Multi-model probability estimation with Platt calibration
 *
 * Cycle 002 additions:
 * - Category classifier: 90+ regex rules for zero-cost market categorization
 * - Auto-classification feeds into category-specific Platt calibration
 */

interface MarketScannerConfig {
    /** Minimum expected value to generate a signal (default: 0.02 = 2 cents per dollar) */
    minEV: number;
    /** Minimum liquidity in USD to consider a market (default: 1000) */
    minLiquidity: number;
    /** Minimum volume in USD to consider a market (default: 500) */
    minVolume: number;
    /** Maximum spread to consider (default: 0.10 = 10%) */
    maxSpread: number;
    /** Bankroll for position sizing (default: 1000) */
    bankroll: number;
    /** Cooldown between scans of the same market in ms (default: 5 min) */
    cooldownMs: number;
}
interface ScanResult {
    signals: PredictionSignal[];
    marketsScanned: number;
    marketsFiltered: number;
    timestamp: number;
}
/** Function that fetches markets from an exchange */
type MarketFetcher = (exchange: PredictionExchange) => Promise<PredictionMarket[]>;
/**
 * Classify a market question into a category using regex rules.
 * Zero LLM cost — pure pattern matching. Returns "default" if no category matches.
 *
 * Scoring: counts the number of pattern matches per category.
 * The category with the most matches wins (minimum 1 match required).
 */
declare function classifyCategory(question: string): string;
declare class MarketScanner {
    private config;
    private lastScanTime;
    private fetchMarkets;
    private forecaster;
    constructor(fetchMarkets: MarketFetcher, config?: Partial<MarketScannerConfig>);
    /**
     * Enable LLM ensemble forecasting for probability estimation.
     * When set, analyzeMarket will use the ensemble for eligible markets
     * and fall back to the spread/volume model on failure.
     */
    setForecaster(forecaster: LLMForecaster): void;
    /**
     * Scan all markets on the given exchanges for +EV opportunities.
     */
    scan(exchanges?: PredictionExchange[]): Promise<ScanResult>;
    private isEligible;
    /**
     * Analyze a single market using available models.
     * If an LLM forecaster is configured, uses ensemble estimation with
     * the spread/volume model as fallback. Otherwise uses spread/volume only.
     */
    private analyzeMarket;
    /**
     * Classic spread/volume analysis — no LLM calls needed.
     * Used as the default when no forecaster is configured, or as fallback.
     */
    private analyzeMarketClassic;
    getConfig(): MarketScannerConfig;
    updateConfig(updates: Partial<MarketScannerConfig>): void;
    clearCooldowns(): void;
}

/**
 * Calibration Store — Track forecasts and outcomes for accuracy measurement.
 *
 * Stores every ensemble forecast alongside its eventual outcome.
 * Uses accumulated data to:
 * 1. Compute per-model Brier scores
 * 2. Fit Platt scaling parameters via logistic regression
 * 3. Identify which categories the ensemble is best/worst at
 */
interface ForecastRecord {
    id?: number;
    marketId: string;
    question: string;
    category: string;
    /** JSON-encoded model → probability map */
    modelForecasts: Record<string, number>;
    /** Final ensemble probability */
    ensembleForecast: number;
    /** Market price at time of forecast */
    marketPriceAtForecast: number;
    /** When the forecast was made */
    createdAt: number;
    /** 0 or 1, set after market resolves */
    outcome?: number;
    /** When the outcome was recorded */
    resolvedAt?: number;
}
interface CalibrationBucket {
    /** Midpoint of the bucket (e.g., 0.25 for 20-30% range) */
    midpoint: number;
    /** Average predicted probability in this bucket */
    avgPredicted: number;
    /** Actual outcome rate in this bucket */
    actualRate: number;
    /** Number of forecasts in this bucket */
    count: number;
}
interface CalibrationReport {
    /** Total forecasts with known outcomes */
    totalResolved: number;
    /** Overall Brier score (lower = better, 0 = perfect) */
    brierScore: number;
    /** Per-model Brier scores */
    modelBrierScores: Record<string, number>;
    /** Calibration buckets (10 buckets: 0-10%, 10-20%, ..., 90-100%) */
    buckets: CalibrationBucket[];
    /** Expected Calibration Error */
    ece: number;
    /** Per-category Brier scores */
    categoryBrierScores: Record<string, number>;
}
type Database$1 = {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: unknown[]): {
            lastInsertRowid: number | bigint;
        };
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Record<string, unknown>[];
    };
};
declare class CalibrationStore {
    private db;
    /** Count of rows dropped due to corrupted JSON — exposed for monitoring */
    droppedCorruptRows: number;
    constructor(db: Database$1);
    private initialize;
    /** Store a new forecast */
    saveForecast(record: Omit<ForecastRecord, "id">): number;
    /** Record the outcome after a market resolves */
    recordOutcome(marketId: string, outcome: 0 | 1): void;
    /** Get all resolved forecasts (with known outcomes) */
    getResolvedForecasts(category?: string): ForecastRecord[];
    /** Get forecasts for a specific market */
    getForecastsForMarket(marketId: string): ForecastRecord[];
    /** Count total forecasts */
    count(): number;
    /** Number of rows dropped due to corrupted JSON since process start */
    getDroppedCorruptRows(): number;
    /**
     * Generate a full calibration report from all resolved forecasts.
     */
    getCalibrationReport(): CalibrationReport;
    /**
     * Fit Platt scaling parameters from resolved forecasts.
     * Uses simple gradient descent on logistic regression.
     * Returns null if insufficient data (< 30 resolved).
     */
    fitPlattScaling(category?: string): {
        a: number;
        b: number;
    } | null;
}

/**
 * Forecast Cost Tracker — Track per-forecast costs and compute cost efficiency.
 *
 * Cycle 005 addition:
 * - Records input/output token counts and cost per model call
 * - Computes cost per dollar of expected value (cost/EV ratio)
 * - Identifies categories and markets where forecasting is cost-inefficient
 * - Enables tiered model routing optimization decisions
 *
 * Key metric: Cost Per Dollar of Expected Value
 * - If a forecast costs $0.05 and identifies $2.00 of EV, ratio = 0.025 (excellent)
 * - If a forecast costs $0.05 and identifies $0.01 of EV, ratio = 5.0 (terrible)
 * - Markets with consistently poor ratios should use cheaper models or be skipped
 */
interface ModelCallCost {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}
interface ForecastCostRecord {
    marketId: string;
    category: string;
    models: ModelCallCost[];
    totalCostUsd: number;
    /** Was this forecast actionable (generated a +EV signal)? */
    resultedInTrade: boolean;
    /** Expected value of the signal (0 if no signal) */
    expectedValue: number;
    /** Cost per dollar of expected value (Infinity if no EV, lower is better) */
    costPerDollarEV: number;
    timestamp: number;
}
interface CostSummary {
    totalForecasts: number;
    totalCostUsd: number;
    avgCostPerForecast: number;
    actionableForecasts: number;
    actionableRate: number;
    avgCostPerActionableForecast: number;
    avgCostPerDollarEV: number;
    costByCategory: Record<string, {
        count: number;
        totalCost: number;
        avgCostPerDollarEV: number;
    }>;
    costByModel: Record<string, {
        calls: number;
        totalCost: number;
        totalTokens: number;
    }>;
}
/**
 * Model pricing table (per million tokens, standard API rates as of March 2026).
 * Used to estimate costs when actual billing data is unavailable.
 */
declare const MODEL_PRICING: Record<string, {
    inputPerMTok: number;
    outputPerMTok: number;
}>;
/**
 * Estimate cost of a model call based on token counts and pricing table.
 *
 * @param model - Model name (matched against MODEL_PRICING keys)
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param batchDiscount - Whether batch API pricing applies (50% off)
 * @returns Estimated cost in USD
 */
declare function estimateCost(model: string, inputTokens: number, outputTokens: number, batchDiscount?: boolean): number;
declare class ForecastCostTracker {
    private records;
    /**
     * Record the cost of a forecast operation.
     */
    record(marketId: string, category: string, models: ModelCallCost[], resultedInTrade: boolean, expectedValue: number): ForecastCostRecord;
    /**
     * Get a summary of all recorded forecast costs.
     */
    getSummary(): CostSummary;
    /**
     * Get all records (for export/analysis).
     */
    getRecords(): ForecastCostRecord[];
    /**
     * Get the number of recorded forecasts.
     */
    get count(): number;
    /**
     * Clear all records (for testing or periodic reset).
     */
    clear(): void;
    /**
     * Get the worst cost/EV categories (candidates for cheaper model routing).
     *
     * @param threshold - Categories with avgCostPerDollarEV above this are "wasteful"
     * @returns Categories sorted by worst cost efficiency first
     */
    getWastefulCategories(threshold?: number): Array<{
        category: string;
        avgCostPerDollarEV: number;
        count: number;
    }>;
}

/**
 * Adapter that bridges Zaraa's ModelRouter into the LLMForecaster's ModelCaller interface.
 *
 * The forecaster expects: (model: string, prompt: string) => Promise<string>
 * The ModelRouter provides: getProvider(zone, taskType) → LLMProvider with .chat()
 *
 * This adapter creates a ModelCaller function that:
 * 1. Resolves the named model to a provider via ModelRouter
 * 2. Sends the prompt as a user message via chat()
 * 3. Returns the text response
 */

interface ModelCallerAdapterDeps {
    /** Get a provider by model name — typically ModelRouter.getProviderByName() */
    getProviderByName: (name: string) => {
        chat: (messages: Array<{
            role: string;
            content: string;
        }>, tools?: unknown[]) => Promise<{
            content: string;
        }>;
    } | undefined;
    /** Fallback provider for unknown model names — typically ModelRouter.getProvider(zone, "deep") */
    getFallbackProvider: () => {
        chat: (messages: Array<{
            role: string;
            content: string;
        }>, tools?: unknown[]) => Promise<{
            content: string;
        }>;
    };
}
/**
 * Create a ModelCaller function from a ModelRouter (or any provider lookup).
 * Used to connect the LLMForecaster to live model inference.
 */
declare function createModelCaller(deps: ModelCallerAdapterDeps): ModelCaller;

/**
 * ScanPipeline — Orchestrates all 24 analytical functions into a 6-stage DAG.
 *
 * Cycle 008: The integration layer that wires every analytical function from
 * ev-calculator.ts into the market scanning flow. Each stage is a pure transformation
 * with explicit data dependencies and decision gates.
 *
 * Pipeline stages:
 * 1. PRE-SCREEN  — Entropy filter + wash trading detection (free, no LLM)
 * 2. ENRICH      — Binary IV, new market, regime, herding, CTF arb, category (free)
 * 3. FORECAST    — LLM ensemble for top-priority markets, classic for rest
 * 4. CALIBRATE   — EV, Kelly sizing, conformal intervals, metacognitive health
 * 5. EXEC CHECK  — Market impact estimation, execution strategy
 * 6. PORTFOLIO   — Barbell allocation, signal ranking
 *
 * Design principles (from Cycle 008 research):
 * - In-process DAG (no external orchestrator needed for single-agent scanning)
 * - Feature store pattern: batch features at startup, real-time per-market per-scan
 * - Multi-factor signal aggregation with composite priority scoring
 * - ~80% LLM cost reduction through pre-screening and priority routing
 */

interface PipelineConfig {
    /** Minimum entropy to pass pre-screen (default: 0.30) */
    minEntropy: number;
    /** Minimum binary IV to pass enrichment (default: 0.05) */
    minIV: number;
    /** Entropy threshold for LLM routing — above this uses ensemble (default: 0.50) */
    llmEntropyThreshold: number;
    /** Maximum conformal interval width to generate signal (default: 0.50) */
    maxConformalWidth: number;
    /** Maximum execution cost as fraction of edge (default: 0.50) */
    maxExecutionCostRatio: number;
    /** Bankroll for position sizing (default: 1000) */
    bankroll: number;
    /** Minimum EV to generate a signal (default: 0.02) */
    minEV: number;
    /** Maximum markets to route to LLM (default: 10) */
    maxLLMMarkets: number;
    /** Speculative allocation fraction for barbell (default: 0.10) */
    speculativeAllocation: number;
}
/** Stage 1 output: pre-screened market with entropy and wash data */
interface PreScreenedMarket {
    market: PredictionMarket;
    entropy: MarketEntropy;
    washTrading: WashTradingSignal;
}
/** Stage 2 output: enriched market with all computed features */
interface EnrichedMarket extends PreScreenedMarket {
    iv: number;
    hoursToExpiry: number;
    isNewMarket: boolean;
    newMarketPriority: number;
    regime: RegimeSignals;
    herding: HerdingSignal;
    ctfArbitrage: {
        hasArbitrage: boolean;
        profitPerPair: number;
    };
    category: string;
    /** Composite priority score for LLM routing (0-1) */
    priorityScore: number;
}
/** Stage 3 output: market with probability forecast */
interface ForecastedMarket extends EnrichedMarket {
    modelProbability: number;
    confidence: number;
    forecastMethod: "ensemble" | "classic";
    forecastReason: string;
}
/** Stage 4 output: sized signal with calibration data */
interface SizedSignal {
    market: ForecastedMarket;
    signal: PredictionSignal;
    conformal: ConformalInterval;
    metacognitive: MetacognitiveState;
    adjustedSize: number;
    regimeSizingMultiplier: number;
}
/** Stage 5 output: execution-ready signal */
interface ExecutionReadySignal extends SizedSignal {
    impact: MarketImpactEstimate;
    executionStrategy: string;
    passedExecutionCheck: boolean;
}
/** Full pipeline result */
interface PipelineResult {
    /** Final signals sorted by expected value */
    signals: PredictionSignal[];
    /** Enriched signal data for each output signal */
    enrichedSignals: ExecutionReadySignal[];
    /** Barbell portfolio allocation (if signals exist) */
    portfolio: BarbellAllocation | null;
    /** Portfolio correlation analysis (Cycle 012) */
    correlation: PortfolioCorrelationResult | null;
    /** Pipeline metrics */
    metrics: PipelineMetrics;
}
interface PipelineMetrics {
    marketsReceived: number;
    passedPreScreen: number;
    passedEnrichment: number;
    forecastedByLLM: number;
    forecastedByClassic: number;
    passedSizing: number;
    passedExecutionCheck: number;
    finalSignals: number;
    totalTimeMs: number;
}
declare class ScanPipeline {
    private config;
    private forecaster;
    /** Calibration scores for conformal intervals (from resolved forecasts) */
    private calibrationScores;
    /** Per-category recent forecast data for metacognition */
    private categoryForecasts;
    /** Per-category Brier data for transfer calibration */
    private categoryBrierData;
    /** Price history per market for Kalman/herding (market ID → prices) */
    private priceHistory;
    /** Volume history per market for regime detection (market ID → avg7d) */
    private volumeHistory;
    /** Baseline spread per market */
    private baselineSpreads;
    /** Last-seen timestamp per market for stale eviction */
    private lastSeen;
    /** Current portfolio exposure tracking */
    private currentExposure;
    private categoryExposure;
    /** Maximum age before evicting market history (24 hours) */
    private static readonly STALE_THRESHOLD_MS;
    constructor(config?: Partial<PipelineConfig>);
    setForecaster(forecaster: LLMForecaster): void;
    setCalibrationScores(scores: number[]): void;
    setCategoryForecasts(data: Map<string, Array<{
        forecastProb: number;
        closingPrice: number;
        outcome: 0 | 1;
    }>>): void;
    setCategoryBrierData(data: Record<string, {
        brier: number;
        sampleCount: number;
        plattA: number;
    }>): void;
    updatePriceHistory(marketId: string, price: number): void;
    updateVolumeHistory(marketId: string, avgVolume7d: number): void;
    updateBaselineSpread(marketId: string, spread: number): void;
    setExposure(total: number, byCategory: Map<string, number>): void;
    getConfig(): PipelineConfig;
    updateConfig(updates: Partial<PipelineConfig>): void;
    /**
     * Evict market data not seen in the last 24 hours.
     * Prevents unbounded memory growth across long-running scans.
     */
    evictStaleMarkets(): number;
    execute(markets: PredictionMarket[]): Promise<PipelineResult>;
    stagePreScreen(markets: PredictionMarket[]): PreScreenedMarket[];
    stageEnrich(preScreened: PreScreenedMarket[]): EnrichedMarket[];
    stageForecast(enriched: EnrichedMarket[]): Promise<ForecastedMarket[]>;
    private classicForecast;
    stageCalibrateAndSize(forecasted: ForecastedMarket[]): SizedSignal[];
    stageExecutionCheck(sized: SizedSignal[]): ExecutionReadySignal[];
    stagePortfolio(execReady: ExecutionReadySignal[]): {
        signals: PredictionSignal[];
        portfolio: BarbellAllocation | null;
    };
}
/**
 * Compute a composite priority score for LLM routing.
 * Higher score = more likely to benefit from expensive LLM analysis.
 * Used to allocate the LLM budget to the most promising markets.
 */
declare function computePriorityScore(entropy: MarketEntropy, iv: number, newMarketPriority: number, herding: HerdingSignal, regime: RegimeSignals, washTrading: WashTradingSignal, ctfArb: {
    hasArbitrage: boolean;
}): number;

/** Raw market object from Polymarket Gamma API */
interface GammaMarket {
    /** Condition ID (unique market identifier) */
    condition_id?: string;
    conditionId?: string;
    /** The question being predicted */
    question: string;
    /** URL slug */
    slug: string;
    /** Market category (may be empty) */
    category?: string;
    /** Outcome prices as JSON string array, e.g. '["0.55","0.45"]' or already parsed */
    outcomePrices: string | string[];
    /** Outcomes as JSON string array, e.g. '["Yes","No"]' */
    outcomes: string | string[];
    /** Total volume (string or number) */
    volume?: string | number;
    /** 24-hour volume (may not always be present) */
    volume24hr?: string | number;
    /** Liquidity in USD */
    liquidity: string | number;
    /** When the market resolves/expires (ISO string) */
    end_date_iso?: string;
    endDate?: string;
    /** Whether the market is active */
    active: boolean;
    /** Whether the market is closed */
    closed: boolean;
    /** When market was created (ISO string) */
    created_at?: string;
    createdAt?: string;
    /** Last update (ISO string) */
    updated_at?: string;
    updatedAt?: string;
    /** CLOB token IDs for YES and NO outcomes */
    clob_token_ids?: string | string[];
    clobTokenIds?: string | string[];
    /** Description of the market */
    description?: string;
    /** Whether this is a new market */
    new?: boolean;
    /** Market image */
    image?: string;
}
/** Orderbook data from CLOB API */
interface CLOBOrderBook {
    bids: Array<{
        price: string;
        size: string;
    }>;
    asks: Array<{
        price: string;
        size: string;
    }>;
}
/**
 * Convert a single Gamma API market to our internal PredictionMarket format.
 *
 * @param gamma - Raw Gamma API market object
 * @param book - Optional CLOB orderbook for bid/ask data
 */
declare function toInternalMarket(gamma: GammaMarket, book?: CLOBOrderBook): PredictionMarket;
/**
 * Convert a batch of Gamma API markets to internal format.
 *
 * @param gammaMarkets - Array of raw Gamma API market objects
 * @param books - Optional map of condition ID -> CLOB orderbook
 */
declare function toInternalBatch(gammaMarkets: GammaMarket[], books?: Map<string, CLOBOrderBook>): PredictionMarket[];
/**
 * Extract CLOB token IDs from a Gamma market.
 * Token ID for the YES outcome is needed for orderbook/price queries.
 */
declare function extractTokenIds(gamma: GammaMarket): {
    yes: string | null;
    no: string | null;
};

/** Side of a prediction market order. */
type OrderSide = "BUY" | "SELL";
/** Type of order. GTC = Good Til Cancelled, FOK = Fill Or Kill, GTD = Good Til Date. */
type OrderType = "GTC" | "FOK" | "GTD";
/** Request body for placing an order on the CLOB API. */
interface PlaceOrderRequest {
    /** CLOB token ID for the outcome (YES or NO token). */
    tokenID: string;
    /** Limit price between 0 and 1 (e.g. 0.55 = $0.55). */
    price: number;
    /** Number of shares to buy/sell. */
    size: number;
    /** BUY or SELL. */
    side: OrderSide;
    /** Order time-in-force. Defaults to GTC. */
    type?: OrderType;
    /** Expiration timestamp in seconds (required for GTD orders). */
    expiration?: number;
    /** Client-assigned nonce for onchain cancellations. */
    nonce?: number | string;
    /** Optional fee rate in basis points. */
    feeRateBps?: number;
    /** Optional taker address override. */
    taker?: string;
    /** Optional tick size hint to avoid an extra lookup. */
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    /** Whether the market uses negative risk. If omitted, the SDK resolves it. */
    negRisk?: boolean;
    /** Whether to defer execution of the posted order. */
    deferExec?: boolean;
    /** Reject the order if it would cross the book immediately. */
    postOnly?: boolean;
}
/** Validated response from a successful order placement. */
interface PlaceOrderResult {
    /** Exchange-assigned order ID. */
    orderID: string;
    /** Token ID the order was placed on. */
    tokenID: string;
    /** Order side. */
    side: OrderSide;
    /** Limit price submitted. */
    price: number;
    /** Original requested size. */
    originalSize: number;
    /** Remaining unfilled size. */
    remainingSize: number;
    /** Status returned by the exchange (e.g. "live", "matched"). */
    status: string;
    /** Timestamp of order creation (ISO string or epoch). */
    createdAt: string;
}
/** Validated response from a cancel request. */
interface CancelOrderResult {
    /** The cancelled order ID. */
    orderID: string;
    /** Whether the cancel was acknowledged. */
    cancelled: boolean;
}
/** Validated response from a batch cancel request. */
interface CancelOrdersResult {
    /** List of cancelled order IDs. */
    cancelledOrders: string[];
    /** List of order IDs that failed to cancel, if any. */
    failedCancellations: string[];
}
type ClobWriteMethod = "POST" | "DELETE";
type PolymarketWriteErrorCode = "AUTH_REQUIRED" | "AUTH_UNSUPPORTED" | "INVALID_REQUEST" | "NETWORK" | "RATE_LIMIT" | "HTTP_ERROR" | "RESPONSE_VALIDATION";
interface ClobWriteRequestContext {
    method: ClobWriteMethod;
    path: string;
    body?: unknown;
    apiKey: string;
    apiSecret: string;
    apiPassphrase?: string;
    funder?: string;
    baseUrl: string;
}
type ClobAuthHeaderProvider = (request: ClobWriteRequestContext) => HeadersInit | Promise<HeadersInit>;
declare class PolymarketWriteError extends Error {
    code: PolymarketWriteErrorCode;
    details?: unknown;
    constructor(message: string, code: PolymarketWriteErrorCode, details?: unknown);
}
type PolymarketChainId = 137 | 80002;
type PolymarketSignatureType = 0 | 1 | 2;
interface PolymarketClientConfig {
    /** Gamma API base URL */
    gammaBaseUrl: string;
    /** CLOB API base URL */
    clobBaseUrl: string;
    /** Maximum markets to fetch per request (default: 100) */
    pageSize: number;
    /** Maximum total markets to fetch (default: 500) */
    maxMarkets: number;
    /** Whether to fetch orderbook data for each market (default: false for speed) */
    fetchOrderBooks: boolean;
    /** Maximum concurrent orderbook fetches (default: 10) */
    maxConcurrentBookFetches: number;
    /** Request timeout in ms (default: 15000) */
    timeoutMs: number;
    /** API key for authenticated CLOB write operations (order placement/cancel). */
    apiKey?: string;
    /** API secret for authenticated CLOB write operations. */
    apiSecret?: string;
    /** API passphrase paired with the API key + secret. */
    apiPassphrase?: string;
    /** Private key used for L1 auth and EIP-712 order signing. */
    privateKey?: string;
    /** Signature type for the trading wallet (0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE). */
    signatureType?: PolymarketSignatureType;
    /** Polygon mainnet or Amoy testnet. Defaults to Polygon mainnet (137). */
    chainId?: PolymarketChainId;
    /** Funder address override (defaults to signer address for EOA wallets). */
    funder?: string;
    /** Whether to sync timestamps against the Polymarket server for authenticated writes. */
    useServerTime?: boolean;
    /**
     * Low-level override for manually signed L2 headers.
     * Prefer `privateKey` + API creds for live trading.
     */
    clobAuthHeaders?: ClobAuthHeaderProvider;
    /** Custom fetch function (for testing) */
    fetchFn?: typeof fetch;
}
declare class PolymarketClient {
    private config;
    private gammaBucket;
    private clobBucket;
    private clobWriteBucket;
    private fetchImpl;
    private officialWriteClientPromise?;
    private disposed;
    /** Metrics for monitoring */
    private metrics;
    constructor(config?: Partial<PolymarketClientConfig>);
    /**
     * Fetch active markets from Polymarket and convert to PredictionMarket[].
     * This is the primary method for feeding the ScanPipeline.
     *
     * @param opts - Override fetch options for this call
     */
    fetchActiveMarkets(opts?: {
        maxMarkets?: number;
        fetchOrderBooks?: boolean;
        category?: string;
    }): Promise<PredictionMarket[]>;
    /**
     * Fetch a single market by condition ID.
     */
    fetchMarket(conditionId: string, includeBook?: boolean): Promise<PredictionMarket | null>;
    /**
     * Fetch orderbook for a specific token ID.
     */
    fetchOrderBook(tokenId: string): Promise<CLOBOrderBook | null>;
    /**
     * Get the best bid/ask spread for a token.
     */
    fetchSpread(tokenId: string): Promise<{
        bid: number;
        ask: number;
        spread: number;
    } | null>;
    /**
     * Place a limit order on the Polymarket CLOB.
     * Requires a private key for EIP-712 signing and either cached L2 creds or the ability to derive them.
     *
     * @param req - Order parameters (tokenID, price, size, side, optional type/expiration/nonce).
     * @returns Typed order result with exchange-assigned orderID and fill status.
     * @throws If auth is not configured, request validation fails, or the exchange rejects the order.
     */
    placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
    /**
     * Cancel a single open order by its exchange-assigned order ID.
     *
     * DELETE /order/{orderID} — requests cancellation of the specified order.
     *
     * @param orderID - The exchange-assigned order ID to cancel.
     * @returns Confirmation with the cancelled order ID.
     * @throws If auth is not configured or the exchange rejects the cancel.
     */
    cancelOrder(orderID: string): Promise<CancelOrderResult>;
    /**
     * Cancel multiple open orders in a single request.
     *
     * DELETE /orders — batch cancel. The exchange may partially succeed.
     *
     * @param orderIDs - Array of order IDs to cancel. Must contain at least one.
     * @returns Lists of successfully cancelled and failed order IDs.
     * @throws If auth is not configured or the request fails entirely.
     */
    cancelOrders(orderIDs: string[]): Promise<CancelOrdersResult>;
    /**
     * Whether this client is configured for authenticated write operations.
     */
    get canWrite(): boolean;
    /**
     * Return client metrics for monitoring.
     */
    getMetrics(): typeof this.metrics & {
        gammaUtilization: number;
        clobUtilization: number;
        clobWriteUtilization: number;
    };
    /**
     * Dispose of rate limiter timers. Call on shutdown.
     */
    dispose(): void;
    private fetchGammaMarkets;
    private gammaRequest;
    private fetchOrderBooks;
    private fetchSingleBook;
    private canUseOfficialWriteClient;
    private getOfficialWriteClient;
    private createOfficialWriteClient;
    private requireOfficialWriteConfig;
    private requireAuth;
    private validateOrderRequest;
    private assertSuccessfulOfficialOrderResponse;
    private toPlaceOrderResult;
    private toCancelOrderResult;
    private toCancelOrdersResult;
    private toWriteError;
    private clobWriteRequest;
}
/**
 * Create a MarketFetcher function compatible with MarketScanner.
 * This bridges PolymarketClient to the existing scanner architecture.
 */
declare function createPolymarketFetcher(client: PolymarketClient): (_exchange: "polymarket" | "kalshi") => Promise<PredictionMarket[]>;

/**
 * RateLimitedFetcher — Token-bucket rate limiter for external API calls.
 *
 * Cycle 009: Prevents hitting Polymarket API rate limits.
 *
 * Uses a token-bucket algorithm: tokens refill at a fixed rate, each request
 * costs one token. When the bucket is empty, requests queue and wait for
 * tokens to refill. This naturally smooths burst traffic.
 *
 * Polymarket limits:
 * - Gamma API: 4,000 req/10s (we target 300/s = safe headroom)
 * - CLOB reads: 15,000 req/10s (we target 1,000/s)
 * - CLOB writes: 3,500 req/10s (we target 250/s)
 */
interface TokenBucketConfig {
    /** Tokens added per second */
    refillRate: number;
    /** Maximum bucket capacity */
    maxTokens: number;
    /** Label for logging */
    label?: string;
}
declare const POLYMARKET_RATE_LIMITS: {
    readonly gamma: {
        refillRate: number;
        maxTokens: number;
        label: string;
    };
    readonly clobRead: {
        refillRate: number;
        maxTokens: number;
        label: string;
    };
    readonly clobWrite: {
        refillRate: number;
        maxTokens: number;
        label: string;
    };
};
declare class TokenBucket {
    private tokens;
    private lastRefill;
    private config;
    private waitQueue;
    private drainTimer;
    constructor(config: TokenBucketConfig);
    /**
     * Attempt to consume a token. Returns true if a token was available,
     * false if the bucket is empty.
     */
    tryConsume(): boolean;
    /**
     * Wait until a token is available, then consume it.
     * This is the primary method for rate-limited operations.
     */
    acquire(): Promise<void>;
    /**
     * Return current utilization (0-1). Higher = closer to rate limit.
     */
    get utilization(): number;
    /**
     * Remaining tokens in the bucket.
     */
    get remaining(): number;
    /**
     * Reset the bucket to full capacity. Used when rate limit headers
     * indicate we have more headroom than expected.
     */
    reset(): void;
    /**
     * Clean up timers. Call when shutting down.
     */
    dispose(): void;
    private refill;
    private scheduleDrain;
}
/**
 * Wrap a fetch function with rate limiting and retry logic.
 *
 * @param fn - The async function to execute
 * @param bucket - Token bucket for rate limiting
 * @param opts - Retry options
 */
declare function rateLimitedFetch<T>(fn: () => Promise<T>, bucket: TokenBucket, opts?: {
    maxRetries?: number;
    backoffMs?: number;
}): Promise<T>;

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

interface PaperTrade {
    id: string;
    marketId: string;
    exchange: "polymarket" | "kalshi";
    question: string;
    category: string;
    side: "yes" | "no";
    entryPrice: number;
    size: number;
    shares: number;
    timestamp: number;
    status: "open" | "closed" | "resolved";
    exitPrice?: number;
    exitTimestamp?: number;
    outcome?: 0 | 1;
    pnl?: number;
    reason: string;
}
interface PaperPortfolio {
    trades: PaperTrade[];
    totalInvested: number;
    totalPnl: number;
    winCount: number;
    lossCount: number;
    openPositionCount: number;
    resolvedCount: number;
}
interface PaperExecutorConfig {
    /** Maximum dollars at risk across all positions (default: 1000) */
    maxTotalExposure: number;
    /** Maximum dollars at risk per market (default: 50) */
    maxPerMarketExposure: number;
    /** Maximum dollars at risk per category (default: 150) */
    maxPerCategoryExposure: number;
    /** Maximum number of open positions (default: 20) */
    maxOpenPositions: number;
}
interface KillSwitchState {
    active: boolean;
    level: "none" | "signal" | "execution" | "halt";
    reason?: string;
    activatedAt?: string;
}
declare class PaperExecutor {
    private config;
    private trades;
    private tradeCounter;
    private killSwitch;
    /** Consecutive loss counter for kill switch auto-trigger */
    private consecutiveLosses;
    /** Daily P&L tracking */
    private dailyPnl;
    /** Peak equity for max drawdown calculation */
    private peakEquity;
    /** Maximum drawdown (peak-to-trough) */
    private maxDrawdown;
    constructor(config?: Partial<PaperExecutorConfig>);
    /**
     * Execute a batch of prediction signals in paper mode.
     * Returns which signals were accepted and which were rejected.
     */
    executeBatch(signals: PredictionSignal[]): Array<{
        signal: PredictionSignal;
        accepted: boolean;
        reason: string;
        tradeId?: string;
    }>;
    /**
     * Execute a single prediction signal in paper mode.
     * @param category - Market category for per-category exposure enforcement
     */
    executeSingle(signal: PredictionSignal, category?: string): {
        signal: PredictionSignal;
        accepted: boolean;
        reason: string;
        tradeId?: string;
    };
    /**
     * Resolve a market with its outcome. Updates all open positions for this market.
     */
    resolveMarket(marketId: string, outcome: 0 | 1): PaperTrade[];
    /**
     * Close a position early (before resolution) at a given price.
     */
    closePosition(tradeId: string, exitPrice: number): PaperTrade | null;
    activateKillSwitch(level: "signal" | "execution" | "halt", reason: string): void;
    deactivateKillSwitch(): void;
    getKillSwitchStatus(): KillSwitchState;
    getOpenPositions(): PaperTrade[];
    getResolvedTrades(): PaperTrade[];
    getAllTrades(): PaperTrade[];
    /**
     * Convert open trades to PredictionPosition format.
     */
    getPositions(currentPrices: Map<string, number>): PredictionPosition[];
    /**
     * Get portfolio summary.
     */
    getPortfolio(): PaperPortfolio;
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
    };
    /**
     * Compute a Signal Quality Score (SQS) for each resolved signal.
     * Composite metric: accuracy + calibration + profitability + edge quality.
     *
     * Returns per-signal scores AND an aggregate portfolio score.
     * This enables automated self-evaluation: which signals actually work?
     */
    getSignalQualityScores(): SignalQualityReport;
    /**
     * Get the best and worst performing signal categories.
     * Use this to decide which categories to keep scanning and which to avoid.
     */
    getCategoryRankings(): Array<{
        category: string;
        compositeScore: number;
        sampleSize: number;
        totalPnl: number;
    }>;
    getConfig(): PaperExecutorConfig;
    updateConfig(updates: Partial<PaperExecutorConfig>): void;
}
interface SignalQualityEntry {
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
interface AggregateQuality {
    compositeScore: number;
    accuracyScore: number;
    calibrationScore: number;
    profitabilityScore: number;
    edgeQualityScore: number;
    sampleSize: number;
}
interface SignalQualityReport {
    scores: SignalQualityEntry[];
    aggregate: AggregateQuality;
    byCategory: Record<string, AggregateQuality>;
}

interface KalshiMarket {
    ticker: string;
    event_ticker?: string;
    title: string;
    subtitle?: string | null;
    yes_sub_title?: string | null;
    no_sub_title?: string | null;
    status?: string;
    market_type?: string;
    floor_strike?: string | number | null;
    custom_strike?: Record<string, unknown> | null;
    yes_bid_dollars?: string | number | null;
    yes_bid_size_fp?: string | number | null;
    yes_ask_dollars?: string | number | null;
    yes_ask_size_fp?: string | number | null;
    no_bid_size_fp?: string | number | null;
    no_bid_dollars?: string | number | null;
    no_ask_dollars?: string | number | null;
    no_ask_size_fp?: string | number | null;
    last_price_dollars?: string | number | null;
    volume_fp?: string | number | null;
    volume_24h_fp?: string | number | null;
    liquidity_dollars?: string | number | null;
    close_time?: string | null;
    expiration_time?: string | null;
    expected_expiration_time?: string | null;
    created_time?: string | null;
    updated_time?: string | null;
    rules_primary?: string | null;
}
interface KalshiSeries {
    ticker: string;
    title: string;
    category?: string;
    tags?: string[] | null;
    volume_fp?: string | number | null;
    last_updated_ts?: string | null;
}
interface KalshiMarketMapOptions {
    fetchedAt?: string;
}
interface KalshiClientConfig {
    baseUrl: string;
    pageSize: number;
    maxMarkets: number;
    discoveryMultiplier: number;
    maxDiscoveryMarkets: number;
    timeoutMs: number;
    fetchFn?: typeof fetch;
}
declare function toInternalKalshiMarket(raw: KalshiMarket, options?: KalshiMarketMapOptions): PredictionMarket;
declare class KalshiClient {
    private readonly config;
    private readonly fetchImpl;
    private metrics;
    constructor(config?: Partial<KalshiClientConfig>);
    fetchActiveMarkets(opts?: {
        maxMarkets?: number;
    }): Promise<PredictionMarket[]>;
    fetchRawActiveMarkets(opts?: {
        maxMarkets?: number;
    }): Promise<KalshiMarket[]>;
    fetchSeriesList(opts?: {
        category?: string;
        includeProductMetadata?: boolean;
        includeVolume?: boolean;
    }): Promise<KalshiSeries[]>;
    fetchRawActiveMarketsBySeries(opts: {
        seriesTickers: string[];
        maxMarkets?: number;
        maxMarketsPerSeries?: number;
    }): Promise<KalshiMarket[]>;
    fetchRawActiveMarketsByCategories(opts: {
        categories: string[];
        maxMarkets?: number;
        maxMarketsPerSeries?: number;
        maxSeriesPerCategory?: number;
    }): Promise<KalshiMarket[]>;
    getMetrics(): typeof this.metrics;
    private request;
}
declare function createKalshiFetcher(client: KalshiClient): (_exchange: "polymarket" | "kalshi") => Promise<PredictionMarket[]>;

/**
 * TradeJournal — Append-only audit log for prediction market signals and paper trades.
 *
 * Cycle 011: Every signal generated and every paper trade executed is logged
 * with full context for compliance, debugging, and performance analysis.
 *
 * Design:
 * - Append-only SQLite table (no updates, no deletes)
 * - Each entry has a type: "signal" | "trade" | "resolve" | "killswitch" | "scan"
 * - Full JSON context stored alongside structured fields
 * - Queryable by time range, type, market, and outcome
 */
type JournalEntryType = "signal" | "trade" | "resolve" | "killswitch" | "scan" | "error";
interface JournalEntry {
    id?: number;
    type: JournalEntryType;
    timestamp: number;
    /** ISO date string for easy querying */
    dateKey: string;
    /** Market ID (null for scan-level or killswitch entries) */
    marketId: string | null;
    /** Market question (human readable) */
    question: string | null;
    /** Signal side: "yes" | "no" | null */
    side: string | null;
    /** Key numeric value (EV for signals, size for trades, P&L for resolves) */
    value: number | null;
    /** Full context as JSON */
    context: string;
    /** Pipeline metrics summary (for scan entries) */
    summary: string | null;
}
interface JournalQuery {
    type?: JournalEntryType;
    marketId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
}
interface JournalStats {
    totalEntries: number;
    byType: Record<string, number>;
    signalsGenerated: number;
    tradesExecuted: number;
    tradesAccepted: number;
    tradesRejected: number;
    scansCompleted: number;
    errorsLogged: number;
}
type Database = {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: unknown[]): {
            lastInsertRowid: number | bigint;
        };
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Record<string, unknown>[];
    };
};
declare class TradeJournal {
    private db;
    constructor(db: Database);
    private initialize;
    /** Append a journal entry. Returns the entry ID. */
    append(entry: Omit<JournalEntry, "id">): number;
    /** Log a scan cycle result */
    logScan(metrics: {
        marketsReceived: number;
        finalSignals: number;
        totalTimeMs: number;
        passedPreScreen: number;
        passedEnrichment: number;
    }): number;
    /** Log a signal generated by the pipeline */
    logSignal(signal: {
        marketId: string;
        question: string;
        side: string;
        expectedValue: number;
        modelProbability: number;
        marketPrice: number;
        kellySize: number;
        reason: string;
    }): number;
    /** Log a paper trade execution attempt */
    logTrade(trade: {
        tradeId?: string;
        marketId: string;
        question: string;
        side: string;
        size: number;
        entryPrice: number;
        accepted: boolean;
        reason: string;
    }): number;
    /** Log a market resolution */
    logResolve(resolve: {
        marketId: string;
        question: string;
        outcome: 0 | 1;
        tradesResolved: number;
        totalPnl: number;
    }): number;
    /** Log a kill switch event */
    logKillSwitch(event: {
        action: "activate" | "deactivate";
        level: string;
        reason: string;
    }): number;
    /** Log an error */
    logError(error: {
        stage: string;
        message: string;
        marketId?: string;
        stack?: string;
    }): number;
    /** Query journal entries */
    query(opts?: JournalQuery): JournalEntry[];
    /** Get recent entries (shorthand) */
    recent(limit?: number): JournalEntry[];
    /** Get journal stats */
    stats(): JournalStats;
    /** Get entries count */
    count(): number;
    /**
     * Delete journal entries older than the specified number of days.
     * Returns the number of entries pruned.
     * @param retentionDays - Keep entries newer than this (default: 90)
     */
    prune(retentionDays?: number): number;
}

interface ScanSchedulerConfig {
    /** Scan interval in milliseconds (default: 300_000 = 5 minutes) */
    intervalMs: number;
    /** Maximum markets to fetch per scan (default: 200) */
    maxMarkets: number;
    /** Whether to fetch order books (slower but more accurate) */
    fetchOrderBooks: boolean;
    /** Minimum EV threshold for paper trade execution (default: 0.02) */
    minEVForTrade: number;
    /** Whether scheduler is enabled (default: true) */
    enabled: boolean;
    /** Log function (defaults to console.log) */
    log: (msg: string, ...args: unknown[]) => void;
}
interface ScanSchedulerState {
    running: boolean;
    scanning: boolean;
    scanCount: number;
    lastScanAt: number | null;
    lastScanDurationMs: number | null;
    lastSignalCount: number;
    lastTradeCount: number;
    totalSignals: number;
    totalTrades: number;
    totalErrors: number;
    nextScanAt: number | null;
    /** Consecutive successful scans */
    successStreak: number;
    /** Consecutive failed scans */
    errorStreak: number;
    /** Current backoff multiplier (1 = no backoff) */
    backoffMultiplier: number;
    /** Overall health: "healthy" | "degraded" | "unhealthy" */
    health: "healthy" | "degraded" | "unhealthy";
}
interface ScanSchedulerDeps {
    client: PolymarketClient;
    pipeline: ScanPipeline;
    executor: PaperExecutor;
    journal: TradeJournal;
}
declare class ScanScheduler {
    private config;
    private deps;
    private timer;
    private state;
    /** Most recent pipeline result (for API queries) */
    private lastResult;
    /** Most recent pipeline metrics */
    private lastMetrics;
    constructor(deps: ScanSchedulerDeps, config?: Partial<ScanSchedulerConfig>);
    /** Start the scan loop */
    start(): void;
    /** Schedule next scan with backoff-adjusted interval */
    private scheduleNext;
    /** Stop the scan loop */
    stop(): void;
    /** Trigger a manual scan (outside the scheduled loop) */
    triggerScan(): Promise<PipelineResult | null>;
    /** Get current scheduler state */
    getState(): ScanSchedulerState;
    /** Get the most recent pipeline result */
    getLastResult(): PipelineResult | null;
    /** Get the most recent pipeline metrics */
    getLastMetrics(): PipelineMetrics | null;
    /** Update config at runtime */
    updateConfig(updates: Partial<ScanSchedulerConfig>): void;
    /** Dispose all resources */
    dispose(): void;
    private runScan;
}

/**
 * Smart-money consensus watcher (READ-ONLY, no orders).
 *
 * Fills the gap left by the EV/cross-venue engines: instead of pricing markets,
 * it observes the public Polymarket global trades firehose
 * (`data-api.polymarket.com/trades`) and surfaces OUTCOMES that many independent
 * wallets are buying at once — the honest form of "copy trading". Blindly mirroring
 * one high-win-rate account is a trap (favorite-skew / info-asymmetry); convergence
 * across many independent wallets is a stronger, mechanism-based signal.
 *
 * It records each consensus as a shadow "signal" journal entry (no execution) so the
 * operator can watch it accrue and measure forward EV before any capital is risked.
 */
interface SmartMoneyConsensusConfig {
    /** Master switch. Default false — inert until the operator opts in + restarts. */
    enabled?: boolean;
    /** Min distinct wallets buying the same outcome to flag a consensus. Default 4. */
    minWallets?: number;
    /** Only count fills >= this USD notional (server-side `filterAmount`). Default 250. */
    minFillUsd?: number;
    /** Firehose pages to scan (500 trades each). Default 4. */
    pages?: number;
    /** Poll interval in ms when started. Default 900000 (15 min). */
    pollIntervalMs?: number;
    /** Drop live sports props (high adverse selection / noise). Default true. */
    excludeSports?: boolean;
    /** Max % of an outcome's USD allowed from one wallet before it's flagged non-independent. Default 60. */
    maxTopWalletPct?: number;
    /** data-api base URL. */
    dataApiBaseUrl?: string;
}
interface SmartMoneyOpportunity {
    conditionId: string;
    title: string;
    outcome: string;
    category: string;
    /** Number of distinct wallets that bought this outcome in the window. */
    walletCount: number;
    /** Total USD notional bought across those wallets. */
    usd: number;
    /** Most recent trade price for the outcome. */
    lastPrice: number;
    /** Seconds between the first and last buy — tiny span hints at one coordinated actor. */
    spanSec: number;
    /** % of the USD that came from the single biggest wallet (high = concentrated, not broad). */
    topWalletPct: number;
    /** True when participation is broad (not dominated by one wallet) — guards against wash/Sybil. */
    independent: boolean;
}
/** Structural subset of the prediction TradeJournal we depend on (keeps the module decoupled). */
interface SmartMoneyJournalLike {
    append(entry: {
        type: "signal";
        timestamp: number;
        dateKey: string;
        marketId: string | null;
        question: string | null;
        side: string | null;
        value: number | null;
        context: string;
        summary: string | null;
    }): number;
}
type FetchFn$1 = (input: string, init?: unknown) => Promise<{
    json(): Promise<unknown>;
}>;
/** Pure helper: classify a market title into a coarse category (exported for tests). */
declare function categorizeMarket(title: string | undefined | null): string;
declare class SmartMoneyConsensusWatcher {
    private readonly cfg;
    private readonly journal;
    private readonly fetchFn;
    private timer;
    constructor(deps: {
        journal: SmartMoneyJournalLike;
        config?: SmartMoneyConsensusConfig;
        fetchFn?: FetchFn$1;
    });
    get enabled(): boolean;
    /** Pull the firehose and compute consensus opportunities. Read-only. */
    scan(): Promise<SmartMoneyOpportunity[]>;
    /** Scan and record each consensus as a shadow "signal" journal entry. No execution. */
    scanAndRecord(): Promise<{
        recorded: number;
        opportunities: SmartMoneyOpportunity[];
    }>;
    /** Begin periodic scanning (no-op unless enabled). Self-contained scheduling. */
    start(): void;
    stop(): void;
}

/**
 * Signal outcome evaluator (READ-ONLY).
 *
 * Closes the learning loop: takes the shadow "signal" entries recorded in the
 * prediction journal (smart-money consensus, EV pipeline, etc.), looks up how each
 * market actually RESOLVED on gamma, and reports which signal *types* actually paid.
 *
 * The key metric is realized ROI vs 0: the entry price IS the market's implied
 * probability, so a no-edge signal averages ~0 ROI. Persistently positive average
 * ROI for a signal type = a real, measured edge (not a hypothesis). This is what
 * turns the scanners from guesses into something self-correcting.
 *
 * Resolution lookup: gamma `markets?condition_ids=<cid>&closed=true`. A closed market
 * carries `outcomePrices` where the winning outcome = "1". An open market is not
 * returned (→ pending, skipped).
 */
interface SignalOutcomeEvaluatorConfig {
    gammaBaseUrl?: string;
    /** Max concurrent resolution lookups. Default 5. */
    concurrency?: number;
}
interface JournalEntryLite {
    type: string;
    timestamp: number;
    marketId: string | null;
    question: string | null;
    side: string | null;
    value: number | null;
    context: string;
}
interface SignalJournalQueryLike {
    query(opts: {
        type?: string;
        limit?: number;
        since?: number;
    }): JournalEntryLite[];
}
interface MarketResolution {
    resolved: boolean;
    winningOutcome: string | null;
}
type ResolveFn = (conditionId: string) => Promise<MarketResolution>;
type FetchFn = (input: string, init?: unknown) => Promise<{
    json(): Promise<unknown>;
}>;
interface ScoredSignal {
    conditionId: string;
    question: string;
    side: string;
    source: string;
    category: string;
    entryPrice: number;
    resolved: boolean;
    /** null while pending */
    won: boolean | null;
    /** ROI per $1 staked on the backed side: won → (1-p)/p, lost → -1, pending → null. */
    roi: number | null;
}
interface OutcomeBucketStat {
    n: number;
    resolved: number;
    wins: number;
    winRate: number | null;
    avgRoi: number | null;
}
interface OutcomeReport {
    total: number;
    resolved: number;
    pending: number;
    overall: OutcomeBucketStat;
    bySource: Record<string, OutcomeBucketStat>;
    byCategory: Record<string, OutcomeBucketStat>;
    byEntryBucket: Record<string, OutcomeBucketStat>;
    scored: ScoredSignal[];
}
declare class SignalOutcomeEvaluator {
    private readonly journal;
    private readonly fetchFn;
    private readonly resolveFn;
    private readonly gammaBaseUrl;
    private readonly concurrency;
    constructor(deps: {
        journal: SignalJournalQueryLike;
        fetchFn?: FetchFn;
        /** Inject to bypass network (tests). */
        resolveFn?: ResolveFn;
        config?: SignalOutcomeEvaluatorConfig;
    });
    /** Look up whether a market has resolved and which outcome won. */
    resolveMarket(conditionId: string): Promise<MarketResolution>;
    /** Score recorded shadow signals against actual resolutions and aggregate. */
    evaluate(opts?: {
        limit?: number;
        since?: number;
    }): Promise<OutcomeReport>;
}
/** Render an OutcomeReport as a compact text table. */
declare function formatOutcomeReport(r: OutcomeReport): string;

/**
 * Opportunity Pack Scanner — single-pass, EV-led opportunity discovery for
 * Polymarket and Kalshi.
 */

type Outcome = "YES" | "NO";
type Grade = "A" | "B" | "C";
type EvBasis = "scanner" | "model" | "manual";
type ExchangeStatus = "ok" | "unsupported";
interface ExchangeProbe {
    exchange: PredictionExchange;
    reachable: boolean;
    endpoint_ok: boolean;
    reason_if_blocked: string | null;
    exchange_status: ExchangeStatus;
    markets_seen: number;
}
interface ExchangeSource {
    exchange: PredictionExchange;
    fetchMarkets: (opts?: {
        maxMarkets?: number;
    }) => Promise<PredictionMarket[]>;
    sourceUrl: (market: PredictionMarket) => string;
}
interface OpportunityRejection {
    exchange: PredictionExchange;
    market_id: string;
    market_title: string;
    outcome: Outcome;
    reason: string;
    value: number;
    criteria: string;
}
interface OpportunityPackRow {
    exchange: PredictionExchange;
    market_id: string;
    market_title: string;
    outcome: Outcome;
    token_id?: string | null;
    entry_price: number;
    implied_prob: number;
    predicted_prob: number;
    expected_value: number;
    ev_basis: EvBasis;
    liquidity: number;
    volume_24h: number;
    spread: number;
    time_to_resolve: string;
    grade: Grade;
    source_url: string;
    notes: string;
}
interface OpportunityPackSummary {
    status: "complete" | "partial" | "blocked";
    total_requested: number;
    total_returned: number;
    exchange_breakdown: Record<PredictionExchange, {
        reachable: boolean;
        endpoint_ok: boolean;
        reason_if_blocked: string | null;
        exchange_status: ExchangeStatus;
        markets_scanned: number;
        candidates_considered: number;
        opportunities_returned: number;
    }>;
}
interface OpportunityPackResult {
    run_summary: OpportunityPackSummary;
    opportunities: OpportunityPackRow[];
    rejections: OpportunityRejection[];
    raw_results_json: {
        opportunities: OpportunityPackRow[];
        rejections: OpportunityRejection[];
    };
    top50_markdown_table: string;
    exchange_probes: ExchangeProbe[];
}
interface OpportunityPackOptions {
    requested_count?: number;
    exchanges?: PredictionExchange[];
    max_markets_per_exchange?: number;
    includeManualModel?: boolean;
}
interface OpportunityPackConfig {
    sources: ExchangeSource[];
    predictionProvider: (market: PredictionMarket) => number;
    manualPredictionProvider?: (market: PredictionMarket) => number;
    now?: () => number;
}
/**
 * Build a ranked list of up to `requested_count` opportunities.
 * Discovery is single-pass with four in-flow fallback tiers.
 */
declare class OpportunityPackScanner {
    private readonly sources;
    private readonly predictFn;
    private readonly manualPredictFn?;
    private readonly now;
    constructor(config: OpportunityPackConfig);
    generateOpportunityPack(options?: OpportunityPackOptions): Promise<OpportunityPackResult>;
}

/**
 * Cross-venue mispricing matcher for Kalshi and Polymarket.
 *
 * This module is intentionally pure and paper-only. It identifies matched YES
 * markets with enough quoted edge after a conservative fee/slippage buffer, but
 * never places orders or suggests live execution.
 */

type SupportedExchange = Extract<PredictionExchange, "polymarket" | "kalshi">;
type CrossVenuePairingMethod = "exact_question" | "fuzzy_tokens";
type CrossVenueFilterReason = "status_not_open" | "non_actionable_price" | "crossed_book" | "low_liquidity" | "stale_or_invalid_update_time" | "short_normalized_question";
interface CrossVenueMispricingOptions {
    minNetEdge?: number;
    feeAndSlippageBuffer?: number;
    minLiquidity?: number;
    maxExpiryDeltaMs?: number;
    maxStalenessMs?: number;
    minPairSimilarity?: number;
    nowMs?: number;
    maxResults?: number;
}
interface CrossVenueEdgeSensitivityOptions extends CrossVenueMispricingOptions {
    edgeThresholds?: number[];
    paperCapUsd?: number;
}
interface CrossVenueEdgeSensitivityRow {
    minNetEdge: number;
    candidateCount: number;
    paperFillCount: number;
    cumulativePnlUsd: number;
    bestNetEdge: number | null;
    bestCandidate: CrossVenueEdgeSensitivityBestCandidate | null;
}
interface CrossVenueEdgeSensitivityBestCandidate {
    pairKey: string;
    question: string;
    netEdge: number;
    grossEdge: number;
    buyExchange: SupportedExchange;
    buyMarketId: string;
    buyPrice: number;
    sellExchange: SupportedExchange;
    sellMarketId: string;
    sellPrice: number;
    pairingMethod: CrossVenuePairingMethod;
    pairSimilarity: number;
}
interface CrossVenueLeg {
    exchange: SupportedExchange;
    marketId: string;
    question: string;
    yesBid: number;
    yesAsk: number;
    liquidity: number;
    expiresAt: string;
    updatedAt: string;
}
interface CrossVenueMispricingCandidate {
    pairKey: string;
    normalizedQuestion: string;
    question: string;
    buy: CrossVenueLeg;
    sell: CrossVenueLeg;
    grossEdge: number;
    feeAndSlippageBuffer: number;
    netEdge: number;
    liquidityFloor: number;
    expiryDeltaMs: number;
    pairingMethod: CrossVenuePairingMethod;
    pairSimilarity: number;
    paperOnly: true;
    warning: string;
    reason: string;
}
interface CrossVenueNearMissCandidate extends CrossVenueMispricingCandidate {
    rejectionReasons: string[];
    thresholdDeltas: Record<string, number>;
}
interface CrossVenuePairDiagnostics {
    marketsSeen: Record<SupportedExchange, number>;
    actionableMarkets: Record<SupportedExchange, number>;
    filteredMarkets: Record<SupportedExchange, number>;
    filterReasonCounts: Record<SupportedExchange, Partial<Record<CrossVenueFilterReason, number>>>;
    seenCategoryCounts: Record<SupportedExchange, Record<string, number>>;
    actionableCategoryCounts: Record<SupportedExchange, Record<string, number>>;
    pairKeys: {
        polymarket: number;
        kalshi: number;
        matched: number;
        softMatched: number;
    };
    matchedPairKeys: string[];
    softMatchedPairKeys: string[];
    unmatchedPolymarketPairKeys: string[];
    unmatchedKalshiPairKeys: string[];
    rejectedFuzzyPairs: CrossVenueRejectedPairDiagnostics[];
    sampleQuestions: {
        unmatchedPolymarket: string[];
        unmatchedKalshi: string[];
    };
}
interface CrossVenueRejectedPairDiagnostics {
    polymarketKey: string;
    kalshiKey: string;
    similarity: number;
    minPairSimilarity: number;
    numericAnchorsCompatible: boolean;
    rejectionReasons: string[];
    thresholdDeltas: Record<string, number>;
    sharedTokens: string[];
    polymarketOnlyTokens: string[];
    kalshiOnlyTokens: string[];
}
interface CrossVenueComparableSelectionOptions {
    maxResults?: number;
}
declare function normalizeMarketQuestion(question: string): string;
declare function findCrossVenueMispricings(markets: PredictionMarket[], options?: CrossVenueMispricingOptions): CrossVenueMispricingCandidate[];
declare function findCrossVenueNearMisses(markets: PredictionMarket[], options?: CrossVenueMispricingOptions): CrossVenueNearMissCandidate[];
declare function summarizeCrossVenueEdgeSensitivity(markets: PredictionMarket[], options?: CrossVenueEdgeSensitivityOptions): CrossVenueEdgeSensitivityRow[];
declare function diagnoseCrossVenuePairing(markets: PredictionMarket[], options?: CrossVenueMispricingOptions): CrossVenuePairDiagnostics;
declare function selectComparableCrossVenueMarkets(referenceMarkets: PredictionMarket[], candidateMarkets: PredictionMarket[], options?: CrossVenueComparableSelectionOptions): PredictionMarket[];

interface KalshiFeeInput {
    contracts: number;
    price: number;
    coefficient?: number;
}
interface KalshiLadderArbitrageOptions {
    contracts?: number;
    feeMode?: "maker" | "taker";
    minNetProfitUsd?: number;
    maxResults?: number;
}
interface KalshiLadderArbitrageOpportunity {
    exchange: "kalshi";
    strategyName: "kalshi_monotone_ladder";
    executionMode: "maker" | "taker";
    eventTicker: string;
    groupKey: string;
    buyYesTicker: string;
    buyYesPrice: number;
    buyNoTicker: string;
    buyNoPrice: number;
    lowerStrike: number;
    higherStrike: number;
    contracts: number;
    grossCostUsd: number;
    guaranteedPayoutUsd: number;
    grossProfitUsd: number;
    yesFeeUsd: number;
    noFeeUsd: number;
    totalFeesUsd: number;
    netProfitUsd: number;
    netReturnOnCost: number;
    maxContractsByAskSize: number | null;
    lowerQuestion: string;
    higherQuestion: string;
    ruleSnapshot: {
        lower: string | null;
        higher: string | null;
    };
    paperOnly: true;
    warning: string;
    proofNotes: string;
}
declare function calculateKalshiFee(input: KalshiFeeInput): number;
declare function findKalshiLadderArbitrage(markets: KalshiMarket[], options?: KalshiLadderArbitrageOptions): KalshiLadderArbitrageOpportunity[];

interface CrossVenuePaperFill {
    fillId: string;
    ts: string;
    pairKey: string;
    question: string;
    buyExchange: string;
    buyMarketId: string;
    buyPrice: number;
    sellExchange: string;
    sellMarketId: string;
    sellPrice: number;
    netEdge: number;
    capUsd: number;
    notionalUsd: number;
    simulatedPnlUsd: number;
    strategyName: "cross_venue_arb";
}
interface SimulatePaperFillsOptions {
    paperCapUsd?: number;
    nowMs?: number;
}
/**
 * Pure paper-fill simulator. Given a list of detected mispricing candidates,
 * size each one at min(paperCap, smaller-leg liquidity) and credit paper PnL
 * = notional * netEdge. No live orders, no DB writes — pure transform.
 *
 * `nowMs` lets callers seed deterministic timestamps in tests.
 */
declare function simulateCrossVenuePaperFills(candidates: CrossVenueMispricingCandidate[], options?: SimulatePaperFillsOptions): CrossVenuePaperFill[];
declare function summarizePaperFills(fills: CrossVenuePaperFill[]): {
    count: number;
    cumulativePnlUsd: number;
    avgEdgeBps: number;
};

export { type AggregateQuality, type BarbellAllocation, type BarbellOpportunity, type BookEntry, CATEGORY_CALIBRATION, type CLOBOrderBook, type CalibrationBucket, type CalibrationReport, CalibrationStore, type CancelOrderResult, type CancelOrdersResult, type ClobAuthHeaderProvider, type ClobWriteMethod, type ClobWriteRequestContext, type ConformalInterval, type CostSummary, type CrossVenueComparableSelectionOptions, type CrossVenueEdgeSensitivityBestCandidate, type CrossVenueEdgeSensitivityOptions, type CrossVenueEdgeSensitivityRow, type CrossVenueFilterReason, type CrossVenueLeg, type CrossVenueMispricingCandidate, type CrossVenueMispricingOptions, type CrossVenueNearMissCandidate, type CrossVenuePairDiagnostics, type CrossVenuePairingMethod, type CrossVenuePaperFill, type CrossVenueRejectedPairDiagnostics, DEFAULT_POSITION_LIMITS, type EVResult, type EnrichedMarket, type EnsembleForecast, type ExchangeProbe, type ExchangeSource, type ExecutionReadySignal, type ForecastCostRecord, ForecastCostTracker, type ForecastRecord, type ForecastResult, type ForecastedMarket, type GammaMarket, type HerdingSignal, type JournalEntry, type JournalEntryLite, type JournalEntryType, type JournalQuery, type JournalStats, type KalmanState, KalshiClient, type KalshiClientConfig, type KalshiFeeInput, type KalshiLadderArbitrageOpportunity, type KalshiLadderArbitrageOptions, type KalshiMarket, type KalshiMarketMapOptions, type KalshiSeries, type KillSwitchState, LLMForecaster, type LLMForecasterConfig, MODEL_PRICING, type MarketEntropy, type MarketFetcher, type MarketImpactEstimate, type MarketResolution, MarketScanner, type MarketScannerConfig, type MarketStatus, type MetacognitiveState, type ModelCallCost, type ModelCaller, type ModelCallerAdapterDeps, type OpportunityPackOptions, type OpportunityPackResult, type OpportunityPackRow, OpportunityPackScanner, type OpportunityPackSummary, type OpportunityRejection, type OrderSide, type OrderType, type OutcomeBucketStat, type OutcomeReport, POLYMARKET_RATE_LIMITS, PaperExecutor, type PaperExecutorConfig, type PaperPortfolio, type PaperTrade, type PipelineConfig, type PipelineMetrics, type PipelineResult, type PlaceOrderRequest, type PlaceOrderResult, type PlattParams, type PolymarketChainId, PolymarketClient, type PolymarketClientConfig, type PolymarketSignatureType, PolymarketWriteError, type PolymarketWriteErrorCode, type PortfolioCorrelationResult, type PositionLimits, type PreScreenedMarket, type PredictionExchange, type PredictionExchangeConfig, type PredictionMarket, type PredictionOrderBook, type PredictionPosition, type PredictionSignal, type PredictionTrade, type RegimeSignals, type ResolveFn, ScanPipeline, type ScanResult, ScanScheduler, type ScanSchedulerConfig, type ScanSchedulerDeps, type ScanSchedulerState, type ScoredSignal, type SignalJournalQueryLike, SignalOutcomeEvaluator, type SignalOutcomeEvaluatorConfig, type SignalQualityEntry, type SignalQualityReport, type SimulatePaperFillsOptions, type SizedSignal, type SmartMoneyConsensusConfig, SmartMoneyConsensusWatcher, type SmartMoneyJournalLike, type SmartMoneyOpportunity, TokenBucket, type TokenBucketConfig, TradeJournal, type TransferCalibration, type WashTradingSignal, aggregateCLV, analyzePortfolioCorrelation, applyPositionLimits, barbellAllocate, bayesianUpdate, calculateEV, calculateKalshiFee, categorizeMarket, classifyCategory, classifyOpportunity, computeBinaryIV, computeCLV, computeConformalInterval, computeInformationGain, computeMarketEntropy, computeMetacognitiveState, computePriorityScore, computeTransferCalibration, confidenceAdjustedKelly, createKalshiFetcher, createModelCaller, createPolymarketFetcher, detectCTFArbitrage, detectHerding, detectInefficiency, detectNewMarket, detectRegimeShift, detectWashTrading, diagnoseCrossVenuePairing, estimateCost, estimateMarketImpact, extractConfidence, extractProbability, extractTokenIds, findCrossVenueMispricings, findCrossVenueNearMisses, findKalshiLadderArbitrage, formatOutcomeReport, generateSignal, getCategoryCorrelation, kalmanFilterSeries, kalmanUpdate, klDivergence, longshotBiasAdjustment, normalizeMarketQuestion, plattScale, rateLimitedFetch, riskParityWeights, selectComparableCrossVenueMarkets, simulateCrossVenuePaperFills, summarizeCrossVenueEdgeSensitivity, summarizePaperFills, timeDecayKellyAdjustment, toInternalBatch, toInternalKalshiMarket, toInternalMarket };
