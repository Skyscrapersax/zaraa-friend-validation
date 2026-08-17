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
import type { PredictionMarket, PredictionSignal } from "../types.js";
import {
	computeMarketEntropy,
	detectWashTrading,
	computeBinaryIV,
	detectNewMarket,
	detectRegimeShift,
	detectHerding,
	detectCTFArbitrage,
	confidenceAdjustedKelly,
	timeDecayKellyAdjustment,
	computeConformalInterval,
	computeMetacognitiveState,
	applyPositionLimits,
	estimateMarketImpact,
	barbellAllocate,
	generateSignal,
	analyzePortfolioCorrelation,
	type MarketEntropy,
	type WashTradingSignal,
	type RegimeSignals,
	type HerdingSignal,
	type ConformalInterval,
	type MetacognitiveState,
	type MarketImpactEstimate,
	type BarbellAllocation,
	type BarbellOpportunity,
	type PortfolioCorrelationResult,
} from "./ev-calculator.js";
import { classifyCategory } from "./market-scanner.js";
import { longshotBiasAdjustment } from "./llm-forecaster.js";
import type { LLMForecaster } from "./llm-forecaster.js";

// ── Pipeline Types ──

export interface PipelineConfig {
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

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
	minEntropy: 0.30,
	minIV: 0.05,
	llmEntropyThreshold: 0.50,
	maxConformalWidth: 0.50,
	maxExecutionCostRatio: 0.50,
	bankroll: 1000,
	minEV: 0.02,
	maxLLMMarkets: 10,
	speculativeAllocation: 0.10,
};

/** Stage 1 output: pre-screened market with entropy and wash data */
export interface PreScreenedMarket {
	market: PredictionMarket;
	entropy: MarketEntropy;
	washTrading: WashTradingSignal;
}

/** Stage 2 output: enriched market with all computed features */
export interface EnrichedMarket extends PreScreenedMarket {
	iv: number;
	hoursToExpiry: number;
	isNewMarket: boolean;
	newMarketPriority: number;
	regime: RegimeSignals;
	herding: HerdingSignal;
	ctfArbitrage: { hasArbitrage: boolean; profitPerPair: number };
	category: string;
	/** Composite priority score for LLM routing (0-1) */
	priorityScore: number;
}

/** Stage 3 output: market with probability forecast */
export interface ForecastedMarket extends EnrichedMarket {
	modelProbability: number;
	confidence: number;
	forecastMethod: "ensemble" | "classic";
	forecastReason: string;
}

/** Stage 4 output: sized signal with calibration data */
export interface SizedSignal {
	market: ForecastedMarket;
	signal: PredictionSignal;
	conformal: ConformalInterval;
	metacognitive: MetacognitiveState;
	adjustedSize: number;
	regimeSizingMultiplier: number;
}

/** Stage 5 output: execution-ready signal */
export interface ExecutionReadySignal extends SizedSignal {
	impact: MarketImpactEstimate;
	executionStrategy: string;
	passedExecutionCheck: boolean;
}

/** Full pipeline result */
export interface PipelineResult {
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

export interface PipelineMetrics {
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

// ── Pipeline Implementation ──

export class ScanPipeline {
	private config: PipelineConfig;
	private forecaster: LLMForecaster | null = null;
	/** Calibration scores for conformal intervals (from resolved forecasts) */
	private calibrationScores: number[] = [];
	/** Per-category recent forecast data for metacognition */
	private categoryForecasts: Map<string, Array<{ forecastProb: number; closingPrice: number; outcome: 0 | 1 }>> = new Map();
	/** Per-category Brier data for transfer calibration */
	private categoryBrierData: Record<string, { brier: number; sampleCount: number; plattA: number }> = {};
	/** Price history per market for Kalman/herding (market ID → prices) */
	private priceHistory: Map<string, number[]> = new Map();
	/** Volume history per market for regime detection (market ID → avg7d) */
	private volumeHistory: Map<string, number> = new Map();
	/** Baseline spread per market */
	private baselineSpreads: Map<string, number> = new Map();
	/** Last-seen timestamp per market for stale eviction */
	private lastSeen: Map<string, number> = new Map();
	/** Current portfolio exposure tracking */
	private currentExposure = 0;
	private categoryExposure: Map<string, number> = new Map();
	/** Maximum age before evicting market history (24 hours) */
	private static readonly STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

	constructor(config: Partial<PipelineConfig> = {}) {
		this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
	}

	setForecaster(forecaster: LLMForecaster): void {
		this.forecaster = forecaster;
	}

	setCalibrationScores(scores: number[]): void {
		this.calibrationScores = scores;
	}

	setCategoryForecasts(data: Map<string, Array<{ forecastProb: number; closingPrice: number; outcome: 0 | 1 }>>): void {
		this.categoryForecasts = data;
	}

	setCategoryBrierData(data: Record<string, { brier: number; sampleCount: number; plattA: number }>): void {
		this.categoryBrierData = data;
	}

	updatePriceHistory(marketId: string, price: number): void {
		const history = this.priceHistory.get(marketId) ?? [];
		history.unshift(price); // newest first
		if (history.length > 50) history.pop();
		this.priceHistory.set(marketId, history);
	}

	updateVolumeHistory(marketId: string, avgVolume7d: number): void {
		this.volumeHistory.set(marketId, avgVolume7d);
	}

	updateBaselineSpread(marketId: string, spread: number): void {
		this.baselineSpreads.set(marketId, spread);
	}

	setExposure(total: number, byCategory: Map<string, number>): void {
		this.currentExposure = total;
		this.categoryExposure = byCategory;
	}

	getConfig(): PipelineConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<PipelineConfig>): void {
		Object.assign(this.config, updates);
	}

	/**
	 * Evict market data not seen in the last 24 hours.
	 * Prevents unbounded memory growth across long-running scans.
	 */
	evictStaleMarkets(): number {
		const cutoff = Date.now() - ScanPipeline.STALE_THRESHOLD_MS;
		let evicted = 0;
		for (const [id, ts] of this.lastSeen) {
			if (ts < cutoff) {
				this.priceHistory.delete(id);
				this.volumeHistory.delete(id);
				this.baselineSpreads.delete(id);
				this.lastSeen.delete(id);
				evicted++;
			}
		}
		return evicted;
	}

	// ── Main Pipeline Execution ──

	async execute(markets: PredictionMarket[]): Promise<PipelineResult> {
		const t0 = Date.now();

		// Evict stale market data periodically
		this.evictStaleMarkets();
		const metrics: PipelineMetrics = {
			marketsReceived: markets.length,
			passedPreScreen: 0,
			passedEnrichment: 0,
			forecastedByLLM: 0,
			forecastedByClassic: 0,
			passedSizing: 0,
			passedExecutionCheck: 0,
			finalSignals: 0,
			totalTimeMs: 0,
		};

		// Stage 1: Pre-screen
		const preScreened = this.stagePreScreen(markets);
		metrics.passedPreScreen = preScreened.length;

		// Stage 2: Enrich
		const enriched = this.stageEnrich(preScreened);
		metrics.passedEnrichment = enriched.length;

		// Stage 3: Forecast
		const forecasted = await this.stageForecast(enriched);
		metrics.forecastedByLLM = forecasted.filter(f => f.forecastMethod === "ensemble").length;
		metrics.forecastedByClassic = forecasted.filter(f => f.forecastMethod === "classic").length;

		// Stage 4: Calibrate & Size
		const sized = this.stageCalibrateAndSize(forecasted);
		metrics.passedSizing = sized.length;

		// Stage 5: Execution Check
		const execReady = this.stageExecutionCheck(sized);
		metrics.passedExecutionCheck = execReady.length;

		// Stage 6: Portfolio Construction
		const { signals, portfolio } = this.stagePortfolio(execReady);
		metrics.finalSignals = signals.length;
		metrics.totalTimeMs = Date.now() - t0;

		// Stage 6b: Correlation Analysis (Cycle 012)
		const correlation = signals.length > 0
			? analyzePortfolioCorrelation(
				execReady.map((er) => ({
					category: er.market.category,
					weight: er.adjustedSize,
					probability: er.market.modelProbability,
				})),
			)
			: null;

		return {
			signals,
			enrichedSignals: execReady,
			portfolio,
			correlation,
			metrics,
		};
	}

	// ── Stage 1: Pre-Screen ──

	stagePreScreen(markets: PredictionMarket[]): PreScreenedMarket[] {
		const results: PreScreenedMarket[] = [];

		for (const market of markets) {
			// Skip non-open or extreme-price markets
			if (market.status !== "open") continue;
			if (market.yesPrice < 0.05 || market.yesPrice > 0.95) continue;

			// Compute entropy — FREE signal quality filter
			const entropy = computeMarketEntropy(market.yesPrice);

			// Skip low-entropy markets (already nearly resolved)
			if (entropy.entropy < this.config.minEntropy) continue;

			// Compute wash trading risk
			const priceChange24h = Math.abs(market.yesPrice - 0.5); // approximation without historical data
			// Estimate trade count from volume and liquidity (avoid circular computation)
			// Heuristic: avg trade ≈ 1% of liquidity for liquid markets, higher for thin
			const estimatedAvgTrade = market.liquidity > 0
				? Math.max(5, market.liquidity * 0.01)
				: 50;
			const tradeCount24h = market.volume24h > 0
				? Math.max(1, Math.round(market.volume24h / estimatedAvgTrade))
				: 0;

			const washTrading = detectWashTrading(
				market.volume24h,
				priceChange24h,
				tradeCount24h,
				estimatedAvgTrade,
				market.liquidity,
			);

			// Apply volume discount — don't hard-filter, but discount volume
			// Store for downstream stages to use
			results.push({ market, entropy, washTrading });

			// Update price history and last-seen for this market
			this.updatePriceHistory(market.id, market.yesPrice);
			this.lastSeen.set(market.id, Date.now());
		}

		return results;
	}

	// ── Stage 2: Enrich ──

	stageEnrich(preScreened: PreScreenedMarket[]): EnrichedMarket[] {
		const results: EnrichedMarket[] = [];

		for (const ps of preScreened) {
			const { market, entropy, washTrading } = ps;

			// Hours to expiry
			const expiresAt = new Date(market.expiresAt).getTime();
			const hoursToExpiry = Math.max(0, (expiresAt - Date.now()) / (1000 * 60 * 60));

			// Binary IV
			const iv = computeBinaryIV(market.yesPrice, hoursToExpiry);
			if (iv < this.config.minIV) continue; // Skip nearly resolved markets

			// New market detection
			const newMarketResult = market.createdAt
				? detectNewMarket(market.createdAt, market.totalVolume, market.liquidity)
				: { isNew: false, priorityScore: 0, ageHours: Infinity };

			// Regime detection
			const avgVol7d = this.volumeHistory.get(market.id) ?? market.volume24h;
			const currentSpread = market.yesAsk - market.yesBid;
			const baselineSpread = this.baselineSpreads.get(market.id) ?? currentSpread;
			const regime = detectRegimeShift(market.volume24h, avgVol7d, currentSpread, baselineSpread);

			// Herding detection
			const priceHist = this.priceHistory.get(market.id) ?? [market.yesPrice];
			const herding = detectHerding(market.yesPrice, priceHist, market.volume24h, avgVol7d);

			// CTF arbitrage
			const ctfResult = detectCTFArbitrage(market.yesPrice, market.noPrice);

			// Category classification
			if (!market.category || market.category === "default" || market.category === "") {
				market.category = classifyCategory(market.question);
			}

			// Composite priority score for LLM routing
			const priorityScore = computePriorityScore(
				entropy, iv, newMarketResult.priorityScore, herding, regime, washTrading, ctfResult,
			);

			results.push({
				market,
				entropy,
				washTrading,
				iv,
				hoursToExpiry,
				isNewMarket: newMarketResult.isNew,
				newMarketPriority: newMarketResult.priorityScore,
				regime,
				herding,
				ctfArbitrage: { hasArbitrage: ctfResult.hasArbitrage, profitPerPair: ctfResult.profitPerPair },
				category: market.category,
				priorityScore,
			});
		}

		// Sort by priority (highest first) for LLM budget allocation
		results.sort((a, b) => b.priorityScore - a.priorityScore);

		return results;
	}

	// ── Stage 3: Forecast ──

	async stageForecast(enriched: EnrichedMarket[]): Promise<ForecastedMarket[]> {
		const results: ForecastedMarket[] = [];

		for (let i = 0; i < enriched.length; i++) {
			const em = enriched[i];
			const useEnsemble = this.forecaster
				&& em.entropy.entropy >= this.config.llmEntropyThreshold
				&& i < this.config.maxLLMMarkets;

			if (useEnsemble) {
				try {
					const forecast = await this.forecaster!.forecast(em.market);
					results.push({
						...em,
						modelProbability: forecast.finalProbability,
						confidence: forecast.confidence,
						forecastMethod: "ensemble",
						forecastReason: `Ensemble(${forecast.votes.length} models, conf=${forecast.confidence.toFixed(2)}, spread_penalty=${forecast.spreadPenaltyApplied})`,
					});
					continue;
				} catch (err) {
					console.warn("[predictions] ensemble forecast failed, falling through to classic:", err instanceof Error ? err.message : err);
				}
			}

			// Classic model: spread/volume-based
			const classicResult = this.classicForecast(em);
			if (classicResult) {
				results.push(classicResult);
			}
		}

		return results;
	}

	private classicForecast(em: EnrichedMarket): ForecastedMarket | null {
		const { market } = em;
		const spread = market.yesAsk - market.yesBid;
		const midpoint = (market.yesAsk + market.yesBid) / 2;

		// Apply wash trading volume discount to volume-based signals
		const effectiveVolume = market.volume24h * em.washTrading.volumeDiscountFactor;

		let modelProb: number;
		let reason: string;

		if (effectiveVolume > 10000) {
			modelProb = market.yesPrice;
			reason = `High volume (effective=$${effectiveVolume.toFixed(0)}, discount=${em.washTrading.volumeDiscountFactor.toFixed(2)}), efficient pricing`;
		} else if (effectiveVolume < 1000) {
			modelProb = market.yesPrice * 0.9 + 0.5 * 0.1;
			reason = `Low effective volume=$${effectiveVolume.toFixed(0)}, mean-reversion bias`;
		} else {
			modelProb = midpoint;
			reason = `Spread=${(spread * 100).toFixed(1)}%, vol_discount=${em.washTrading.volumeDiscountFactor.toFixed(2)}`;
		}

		// Longshot bias adjustment (Cycle 012): correct for systematic over/under-pricing
		// at extreme probabilities. Traders overpay for longshots and underpay favorites.
		const longshotAdjusted = longshotBiasAdjustment(market.yesPrice);
		if (longshotAdjusted !== market.yesPrice) {
			const biasShift = longshotAdjusted - market.yesPrice;
			modelProb += biasShift * 0.5; // blend: 50% bias correction
			reason += `, longshot_adj=${(biasShift * 100).toFixed(1)}%`;
		}

		// Herding adjustment: if strong contrarian signal, shift toward 0.5
		if (em.herding.isContrarian && em.herding.herdingScore > 0.6) {
			const contrarianShift = (0.5 - modelProb) * 0.15;
			modelProb += contrarianShift;
			reason += `, contrarian_shift=${(contrarianShift * 100).toFixed(1)}%`;
		}

		// Compute real confidence from available signals
		// Higher volume + tighter spread + lower wash risk + higher entropy = more confident
		const volumeConf = Math.min(1, effectiveVolume / 50000); // $50K = full confidence
		const spreadConf = Math.max(0, 1 - spread * 10); // 0.10 spread = 0 confidence
		const washConf = em.washTrading.volumeDiscountFactor; // 1.0 = clean, 0.25 = suspicious
		const entropyConf = Math.min(1, em.entropy.entropy / 0.8); // high entropy = more room for edge
		const classicConfidence = Math.max(0.15, Math.min(0.85,
			volumeConf * 0.30 + spreadConf * 0.30 + washConf * 0.20 + entropyConf * 0.20,
		));

		return {
			...em,
			modelProbability: Math.max(0.05, Math.min(0.95, modelProb)),
			confidence: Math.round(classicConfidence * 1000) / 1000,
			forecastMethod: "classic",
			forecastReason: reason + `, conf=${classicConfidence.toFixed(3)}`,
		};
	}

	// ── Stage 4: Calibrate & Size ──

	stageCalibrateAndSize(forecasted: ForecastedMarket[]): SizedSignal[] {
		const results: SizedSignal[] = [];

		for (const fm of forecasted) {
			// Metacognitive health check
			const recentForecasts = this.categoryForecasts.get(fm.category) ?? [];
			const metacognitive = computeMetacognitiveState(fm.category, recentForecasts);
			if (metacognitive.health === "poor") continue; // Skip poorly performing categories

			// Conformal interval
			const conformal = computeConformalInterval(this.calibrationScores, fm.modelProbability);
			if (conformal.width > this.config.maxConformalWidth) continue; // Too uncertain

			// Generate signal (calculates EV and Kelly)
			const signal = generateSignal(
				fm.market,
				fm.modelProbability,
				this.config.bankroll,
				fm.forecastReason,
			);

			if (!signal || signal.expectedValue < this.config.minEV) continue;

			// Confidence-adjusted Kelly
			let adjustedSize = confidenceAdjustedKelly(signal.quarterKellySize, fm.confidence);

			// Time-decay adjustment
			adjustedSize = timeDecayKellyAdjustment(adjustedSize, fm.hoursToExpiry);

			// Regime sizing multiplier
			const regimeMul = fm.regime.sizingMultiplier;
			adjustedSize = Math.round(adjustedSize * regimeMul * 10000) / 10000;

			// Position limits — adjustedSize is already a DOLLAR amount.
			// signal.quarterKellySize = bankroll * quarterKelly, then scaled by
			// confidence/time-decay/regime multipliers (all unit-preserving ≤1
			// scalars). Re-multiplying by bankroll inflated it ~1000×, so
			// applyPositionLimits ALWAYS clamped to the per-market cap — discarding
			// all of the Kelly/confidence/decay sizing. Do NOT multiply by bankroll.
			const catExposure = this.categoryExposure.get(fm.category) ?? 0;
			adjustedSize = applyPositionLimits(
				adjustedSize,
				this.config.bankroll,
				this.currentExposure,
				catExposure,
			);

			if (adjustedSize <= 0) continue;

			results.push({
				market: fm,
				signal: { ...signal, quarterKellySize: adjustedSize },
				conformal,
				metacognitive,
				adjustedSize,
				regimeSizingMultiplier: regimeMul,
			});
		}

		return results;
	}

	// ── Stage 5: Execution Check ──

	stageExecutionCheck(sized: SizedSignal[]): ExecutionReadySignal[] {
		const results: ExecutionReadySignal[] = [];

		for (const ss of sized) {
			const { market: fm, signal, adjustedSize } = ss;

			// Apply wash trading volume discount to daily volume for impact estimation
			const effectiveVolume = fm.market.volume24h * fm.washTrading.volumeDiscountFactor;
			const currentSpread = fm.market.yesAsk - fm.market.yesBid;

			const impact = estimateMarketImpact(
				adjustedSize,
				effectiveVolume,
				fm.market.liquidity,
				currentSpread,
			);

			// Gate: skip if execution cost exceeds edge threshold
			const edge = Math.abs(signal.expectedValue);
			const passedExecutionCheck =
				impact.strategy !== "do_not_trade"
				&& (edge <= 0 || impact.totalExecutionCost < this.config.maxExecutionCostRatio * edge);

			results.push({
				...ss,
				impact,
				executionStrategy: impact.strategy,
				passedExecutionCheck,
			});
		}

		// Only return signals that passed execution check
		return results.filter(r => r.passedExecutionCheck);
	}

	// ── Stage 6: Portfolio Construction ──

	stagePortfolio(execReady: ExecutionReadySignal[]): { signals: PredictionSignal[]; portfolio: BarbellAllocation | null } {
		if (execReady.length === 0) {
			return { signals: [], portfolio: null };
		}

		// Build barbell opportunities
		const opportunities: BarbellOpportunity[] = execReady.map(er => ({
			marketId: er.market.market.id,
			edge: Math.abs(er.signal.expectedValue),
			confidence: er.market.confidence,
			iv: er.market.iv,
			isContrarian: er.market.herding.isContrarian,
			isNewMarket: er.market.isNewMarket,
			proposedSize: er.adjustedSize,
		}));

		const portfolio = barbellAllocate(
			opportunities,
			this.config.bankroll,
			this.config.speculativeAllocation,
		);

		// Build final signal list, applying barbell allocation
		const allocatedIds = new Set([
			...portfolio.safePositions.map(p => p.marketId),
			...portfolio.speculativePositions.map(p => p.marketId),
		]);

		// Signals for allocated markets, sorted by EV
		const signals = execReady
			.filter(er => allocatedIds.has(er.market.market.id))
			.map(er => {
				// Find allocated size
				const safePos = portfolio.safePositions.find(p => p.marketId === er.market.market.id);
				const specPos = portfolio.speculativePositions.find(p => p.marketId === er.market.market.id);
				const allocatedSize = safePos?.allocatedSize ?? specPos?.allocatedSize ?? er.adjustedSize;

				return {
					...er.signal,
					quarterKellySize: allocatedSize,
					reason: er.signal.reason + ` | pipeline: entropy=${er.market.entropy.entropy.toFixed(2)}, iv=${er.market.iv.toFixed(3)}, wash_discount=${er.market.washTrading.volumeDiscountFactor.toFixed(2)}, regime_mul=${er.regimeSizingMultiplier}, impact=${er.impact.estimatedImpact.toFixed(4)}, strategy=${er.executionStrategy}`,
				};
			})
			.sort((a, b) => b.expectedValue - a.expectedValue);

		return { signals, portfolio };
	}
}

// ── Helper: Composite Priority Score ──

/**
 * Compute a composite priority score for LLM routing.
 * Higher score = more likely to benefit from expensive LLM analysis.
 * Used to allocate the LLM budget to the most promising markets.
 */
export function computePriorityScore(
	entropy: MarketEntropy,
	iv: number,
	newMarketPriority: number,
	herding: HerdingSignal,
	regime: RegimeSignals,
	washTrading: WashTradingSignal,
	ctfArb: { hasArbitrage: boolean },
): number {
	const score =
		entropy.entropy * 0.25
		+ Math.min(1, iv * 4) * 0.20 // normalize IV (max ~0.25) to 0-1 range
		+ newMarketPriority * 0.15
		+ (herding.isContrarian ? 0.15 : 0)
		+ regime.sizingMultiplier * 0.10 // higher = more stable = better
		+ (1 - washTrading.riskScore) * 0.10 // lower risk = more trustworthy
		+ (ctfArb.hasArbitrage ? 0.05 : 0);

	return Math.round(Math.min(1, Math.max(0, score)) * 10000) / 10000;
}
