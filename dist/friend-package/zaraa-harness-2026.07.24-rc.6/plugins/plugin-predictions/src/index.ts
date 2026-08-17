// biome-ignore-all assist/source/organizeImports: keep curated public barrel grouped by feature area.
// ── Types ──
export type {
	PredictionExchange,
	MarketStatus,
	PredictionMarket,
	PredictionOrderBook,
	BookEntry,
	PredictionTrade,
	PredictionPosition,
	PredictionSignal,
	PredictionExchangeConfig,
} from "./types.js";

// ── EV Calculator ──
export {
	calculateEV,
	klDivergence,
	detectInefficiency,
	bayesianUpdate,
	generateSignal,
	confidenceAdjustedKelly,
	applyPositionLimits,
	DEFAULT_POSITION_LIMITS,
	timeDecayKellyAdjustment,
	detectCTFArbitrage,
	detectRegimeShift,
	computeBinaryIV,
	classifyOpportunity,
	detectNewMarket,
	computeCLV,
	aggregateCLV,
	detectHerding,
	computeConformalInterval,
	computeMetacognitiveState,
	// Cycle 007
	computeMarketEntropy,
	computeInformationGain,
	kalmanUpdate,
	kalmanFilterSeries,
	detectWashTrading,
	estimateMarketImpact,
	barbellAllocate,
	computeTransferCalibration,
	// Cycle 012
	getCategoryCorrelation,
	analyzePortfolioCorrelation,
	riskParityWeights,
} from "./engine/ev-calculator.js";
export type {
	EVResult,
	PositionLimits,
	RegimeSignals,
	HerdingSignal,
	ConformalInterval,
	MetacognitiveState,
	// Cycle 007
	MarketEntropy,
	KalmanState,
	WashTradingSignal,
	MarketImpactEstimate,
	BarbellOpportunity,
	BarbellAllocation,
	TransferCalibration,
	// Cycle 012
	PortfolioCorrelationResult,
} from "./engine/ev-calculator.js";

// ── Market Scanner ──
export { MarketScanner, classifyCategory } from "./engine/market-scanner.js";
export type { MarketScannerConfig, ScanResult, MarketFetcher } from "./engine/market-scanner.js";

// ── LLM Ensemble Forecaster ──
export {
	LLMForecaster,
	plattScale,
	longshotBiasAdjustment,
	extractProbability,
	extractConfidence,
	CATEGORY_CALIBRATION,
} from "./engine/llm-forecaster.js";
export type {
	ForecastResult,
	EnsembleForecast,
	ModelCaller,
	PlattParams,
	LLMForecasterConfig,
} from "./engine/llm-forecaster.js";

// ── Calibration Store ──
export { CalibrationStore } from "./engine/calibration-store.js";
export type {
	ForecastRecord,
	CalibrationBucket,
	CalibrationReport,
} from "./engine/calibration-store.js";

// ── Forecast Cost Tracker (Cycle 005) ──
export { ForecastCostTracker, estimateCost, MODEL_PRICING } from "./engine/cost-tracker.js";
export type {
	ForecastCostRecord,
	CostSummary,
	ModelCallCost,
} from "./engine/cost-tracker.js";

// ── Model Caller Adapter ──
export { createModelCaller } from "./engine/model-caller-adapter.js";
export type { ModelCallerAdapterDeps } from "./engine/model-caller-adapter.js";

// ── Scan Pipeline (Cycle 008) ──
export { ScanPipeline, computePriorityScore } from "./engine/scan-pipeline.js";
export type {
	PipelineConfig,
	PreScreenedMarket,
	EnrichedMarket,
	ForecastedMarket,
	SizedSignal,
	ExecutionReadySignal,
	PipelineResult,
	PipelineMetrics,
} from "./engine/scan-pipeline.js";

// ── Polymarket Live Integration (Cycle 009) ──
export {
	PolymarketClient,
	PolymarketWriteError,
	createPolymarketFetcher,
} from "./polymarket/polymarket-client.js";
export type {
	PolymarketClientConfig,
	ClobWriteMethod,
	PolymarketWriteErrorCode,
	PolymarketChainId,
	PolymarketSignatureType,
	ClobWriteRequestContext,
	ClobAuthHeaderProvider,
	OrderSide,
	OrderType,
	PlaceOrderRequest,
	PlaceOrderResult,
	CancelOrderResult,
	CancelOrdersResult,
} from "./polymarket/polymarket-client.js";
export { toInternalMarket, toInternalBatch, extractTokenIds } from "./polymarket/data-mapper.js";
export type { GammaMarket, CLOBOrderBook } from "./polymarket/data-mapper.js";
export {
	TokenBucket,
	rateLimitedFetch,
	POLYMARKET_RATE_LIMITS,
} from "./polymarket/rate-limited-fetcher.js";
export type { TokenBucketConfig } from "./polymarket/rate-limited-fetcher.js";
export { PaperExecutor } from "./polymarket/paper-executor.js";
export type {
	PaperTrade,
	PaperPortfolio,
	PaperExecutorConfig,
	KillSwitchState,
	// Cycle 012
	SignalQualityEntry,
	AggregateQuality,
	SignalQualityReport,
} from "./polymarket/paper-executor.js";

// ── Kalshi Live Integration (Cycle 014) ──
export {
	KalshiClient,
	createKalshiFetcher,
	toInternalKalshiMarket,
} from "./kalshi/kalshi-client.js";
export type {
	KalshiClientConfig,
	KalshiMarket,
	KalshiMarketMapOptions,
	KalshiSeries,
} from "./kalshi/kalshi-client.js";

// ── Trade Journal (Cycle 011) ──
export { TradeJournal } from "./engine/trade-journal.js";
export type {
	JournalEntry,
	JournalEntryType,
	JournalQuery,
	JournalStats,
} from "./engine/trade-journal.js";

// ── Scan Scheduler (Cycle 011) ──
export { ScanScheduler } from "./engine/scan-scheduler.js";
export type {
	ScanSchedulerConfig,
	ScanSchedulerState,
	ScanSchedulerDeps,
} from "./engine/scan-scheduler.js";

// ── Smart-money consensus watcher (read-only firehose copy-signal) ──
export {
	SmartMoneyConsensusWatcher,
	categorizeMarket,
} from "./engine/smart-money-consensus.js";
export type {
	SmartMoneyConsensusConfig,
	SmartMoneyOpportunity,
	SmartMoneyJournalLike,
} from "./engine/smart-money-consensus.js";

// ── Signal outcome evaluator (closes the learning loop: score signals vs resolutions) ──
export {
	SignalOutcomeEvaluator,
	formatOutcomeReport,
} from "./engine/signal-outcome-evaluator.js";
export type {
	SignalOutcomeEvaluatorConfig,
	OutcomeReport,
	OutcomeBucketStat,
	ScoredSignal,
	MarketResolution,
	SignalJournalQueryLike,
	JournalEntryLite,
	ResolveFn,
} from "./engine/signal-outcome-evaluator.js";

// ── Opportunity Pack Scanner (Cycle 013) ──
export { OpportunityPackScanner } from "./engine/opportunity-pack-scanner.js";
export type {
	ExchangeProbe,
	ExchangeSource,
	OpportunityRejection,
	OpportunityPackRow,
	OpportunityPackSummary,
	OpportunityPackResult,
	OpportunityPackOptions,
} from "./engine/opportunity-pack-scanner.js";

// ── Cross-Venue Mispricing Matcher ──
export {
	diagnoseCrossVenuePairing,
	findCrossVenueMispricings,
	findCrossVenueNearMisses,
	normalizeMarketQuestion,
	selectComparableCrossVenueMarkets,
	summarizeCrossVenueEdgeSensitivity,
} from "./engine/cross-venue-mispricing.js";
export type {
	CrossVenueComparableSelectionOptions,
	CrossVenueEdgeSensitivityBestCandidate,
	CrossVenueEdgeSensitivityOptions,
	CrossVenueEdgeSensitivityRow,
	CrossVenueLeg,
	CrossVenueMispricingCandidate,
	CrossVenueFilterReason,
	CrossVenueNearMissCandidate,
	CrossVenuePairDiagnostics,
	CrossVenuePairingMethod,
	CrossVenueRejectedPairDiagnostics,
	CrossVenueMispricingOptions,
} from "./engine/cross-venue-mispricing.js";
export {
	calculateKalshiFee,
	findKalshiLadderArbitrage,
} from "./engine/kalshi-ladder-arbitrage.js";
export type {
	KalshiFeeInput,
	KalshiLadderArbitrageOptions,
	KalshiLadderArbitrageOpportunity,
} from "./engine/kalshi-ladder-arbitrage.js";
export {
	simulateCrossVenuePaperFills,
	summarizePaperFills,
} from "./engine/cross-venue-paper-fill.js";
export type {
	CrossVenuePaperFill,
	SimulatePaperFillsOptions,
} from "./engine/cross-venue-paper-fill.js";
