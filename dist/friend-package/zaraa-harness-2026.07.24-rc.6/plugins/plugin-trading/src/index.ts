import type { PluginManifest } from "@zaraa/shared";

export { CryptoClient } from "./crypto-client.js";
export type { CryptoClientConfig, Ticker, OrderBook, Balance, TradeResult } from "./crypto-client.js";
export { TradingStore } from "./trading-store.js";
export type { TradingStoreConfig, Position, PriceAlert, TradeLog, PaperBalance, DailyPnLSummary, DailyPnLPosition } from "./trading-store.js";
export { createTradingHandlers } from "./handlers.js";
export type { TradingHandlerDeps } from "./handlers.js";
export { CandleStore } from "./data/candle-store.js";
export type { Candle } from "./data/candle-store.js";
export { CandleFetcher } from "./data/candle-fetcher.js";
export type { CandleFetcherConfig, Timeframe, BackfillResult } from "./data/candle-fetcher.js";
export { RiskManager, DEFAULT_RISK_CONFIG } from "./risk/risk-manager.js";
export type { RiskConfig, PositionSizeResult, TradeValidation } from "./risk/risk-manager.js";
export {
	checkPaperStopLoss,
	checkPaperStopLossBatch,
	checkPaperInvalidation,
	getPaperStopLossTreeStatus,
	runPaperStopLossScenarios,
	DEFAULT_PAPER_SL_TREE,
	PAPER_SL_TREE_VERSION,
} from "./risk/paper-stop-loss-tree.js";
export type {
	TradeStyle,
	StopLossAction,
	PaperStopLossTreeConfig,
	PaperStopLossCheckInput,
	PaperStopLossCheckResult,
	PaperSlScenarioResult,
} from "./risk/paper-stop-loss-tree.js";
export {
	resolveDualDeskCtaMode,
	DUAL_DESK_SOFT_DRAWDOWN_PCT,
	DUAL_DESK_EDUCATION_DRAWDOWN_PCT,
} from "./risk/dual-desk-cta.js";
export type {
	MediaCtaMode,
	DualDeskCtaInput,
	DualDeskCtaResult,
} from "./risk/dual-desk-cta.js";
export {
	validatePaperTradeJournal,
	paperJournalSessionChecklist,
} from "./risk/paper-trade-journal.js";
export type {
	PaperTradeJournalEntry,
	PaperJournalValidation,
	JournalSide,
	JournalStyle,
	JournalExitReason,
} from "./risk/paper-trade-journal.js";
export { StopMonitor } from "./risk/stop-monitor.js";
export type { StopEvent, StopMonitorDeps } from "./risk/stop-monitor.js";
export { StopScheduler } from "./risk/stop-scheduler.js";
export type { StopSchedulerDeps } from "./risk/stop-scheduler.js";
export { CrashRecoveryManager } from "./risk/crash-recovery.js";
export type { CrashRecoveryDeps, RecoveryReport, RecoveryPosition } from "./risk/crash-recovery.js";
export { TradingCircuitBreaker } from "./risk/trading-circuit-breaker.js";
export type { TradingCircuitBreakerConfig, BreakerStatus, BreakerType } from "./risk/trading-circuit-breaker.js";
export { computePaperEquityUsd } from "./risk/paper-equity.js";
export type { PaperEquityBalance, PaperEquityPosition, PaperEquityDeps } from "./risk/paper-equity.js";
export { evaluateTradingKillGate, buildKillGateSnapshot } from "./risk/trading-kill-gate.js";
export type { KillGateInput, KillGateResult, KillGateSnapshot } from "./risk/trading-kill-gate.js";
export { validateTradeRiskStatusSemantics } from "./risk/trade-risk-status-semantics.js";
export type { TradeRiskStatusSemanticsResult } from "./risk/trade-risk-status-semantics.js";
export { evaluateInventorySkew } from "./risk/inventory-skew.js";
export type {
	InventoryHedgeRecommendation,
	InventorySkewInput,
	InventorySkewResult,
} from "./risk/inventory-skew.js";
export {
	evaluatePreLiveChecklist,
	recordPreLiveExchangeVerified,
	PRELIVE_EXCHANGE_VERIFIED_AT_KEY,
	PRELIVE_VERIFY_TTL_MS,
} from "./risk/pre-live-checklist.js";
export type { PreLiveChecklistInput, PreLiveChecklistItem, PreLiveChecklistResult } from "./risk/pre-live-checklist.js";
export {
	evaluateGraduation,
	formatGraduationReport,
	DEFAULT_PAPER_READINESS,
	DEFAULT_STAGE_THRESHOLDS,
} from "./risk/graduation-monitor.js";
export type {
	GraduationStage,
	GraduationVerdict,
	MonitorInput,
	StageThresholds,
	PaperReadinessThresholds,
	ClosedTradeRow,
} from "./risk/graduation-monitor.js";
export { generateTradingOrderCorrelationId } from "./util/trading-order-audit.js";
export type { TradingOrderAuditPayload, TradingOrderAuditSource } from "./util/trading-order-audit.js";
export {
	OrderReconciler,
	DEFAULT_RECONCILE_LOOKBACK_HOURS,
	MIN_RECONCILE_LOOKBACK_HOURS,
	MAX_RECONCILE_LOOKBACK_HOURS,
	isPartialFillOrderStatus,
	resolveReconcileLookbackHours,
} from "./risk/order-reconciler.js";
export type { ReconciliationResult, Discrepancy } from "./risk/order-reconciler.js";
export type { PositionWithStops, EquitySnapshot } from "./trading-store.js";
export { StrategyRegistry } from "./strategies/strategy-registry.js";
export type { ActiveStrategy } from "./strategies/strategy-registry.js";
export type { Strategy, Signal, IndicatorValues, StrategyRiskParams } from "./strategies/strategy.js";
export { computeIndicators } from "./strategies/compute-indicators.js";
export { meanReversionStrategy } from "./strategies/builtin/mean-reversion.js";
export {
	trendFollowingStrategy,
	setTrendFollowingMode,
	getTrendFollowingMode,
	evaluateTrendFollowingGate,
	TF_GATE_DEFAULT_BASELINE_ISO,
	TF_GATE_DEFAULT_EVAL_AFTER_ISO,
} from "./strategies/builtin/trend-following.js";
export type {
	TrendFollowingMode,
	EvaluateTrendFollowingGateInput,
	EvaluateTrendFollowingGateResult,
} from "./strategies/builtin/trend-following.js";
export { breakoutStrategy } from "./strategies/builtin/breakout.js";
export {
	rsiDivergenceStrategy,
	getRsiDivergenceCounters,
	resetRsiDivergenceCounters,
} from "./strategies/builtin/rsi-divergence.js";
export type {
	RsiDivergenceCounters,
	RsiDivergenceBranchCounters,
} from "./strategies/builtin/rsi-divergence.js";
export { createLearnerMomentumStrategy } from "./strategies/builtin/learner-momentum.js";
export type { LearnerPattern, GetPatternsFn } from "./strategies/builtin/learner-momentum.js";
export { createFundingSqueezeFadeStrategy } from "./strategies/builtin/funding-squeeze-fade.js";
export type { GetFundingStatsFn } from "./strategies/builtin/funding-squeeze-fade.js";
// Edge-experiment strategies — exported ONLY for the honest edge-search harness.
// NOT registered in StrategyRegistry; never activated in the live/paper engine.
export {
	donchianTrendStrategy,
	squeezeBreakoutStrategy,
	sessionOrbStrategy,
	connorsRsi2Strategy,
	EDGE_EXPERIMENT_STRATEGIES,
} from "./strategies/builtin/edge-experiments.js";
export { FundingRateMonitor } from "./signals/funding-rate-monitor.js";
export type {
	FundingRateConfig,
	FundingRateEntry,
	FundingRateStats,
	FundingArbitrage,
} from "./signals/funding-rate-monitor.js";
export { detectRegime, computeADX, applyRegimeWeight } from "./strategies/market-regime.js";
export type { MarketRegime, RegimeAnalysis } from "./strategies/market-regime.js";
export { getCurrentSession, getSessionFitness, isHighQualityWindow } from "./strategies/session-filter.js";
export type { SessionInfo } from "./strategies/session-filter.js";
export { Backtester } from "./backtest/backtester.js";
export type { BacktestConfig, BacktestResult } from "./backtest/backtester.js";
export { calculatePerformance } from "./backtest/performance.js";
export type { BacktestTrade, PerformanceMetrics } from "./backtest/performance.js";
export { RegimeValidationPipeline } from "./backtest/regime-validation-pipeline.js";
export type {
	RegimeValidationPipelineConfig,
	RollingValidationResult,
	RollingValidationWindow,
	RetrainingTarget,
} from "./backtest/regime-validation-pipeline.js";
export { WalkForwardValidator } from "./backtest/walk-forward-validator.js";
export type {
	WalkForwardValidatorConfig,
	WalkForwardValidationResult,
	WalkForwardWindow,
	WalkForwardWindowMetrics,
	WalkForwardRegimeLabel,
} from "./backtest/walk-forward-validator.js";
export {
	binomialTest,
	monteCarloShuffle,
	walkForwardTest,
	walkForwardDegradation,
	validateEdge,
} from "./backtest/edge-validator.js";
export type {
	BinomialResult,
	MonteCarloResult,
	EdgeValidation,
} from "./backtest/edge-validator.js";
export {
	resolveFeeRate,
	resolveVenue,
	getDefaultFeeSchedules,
} from "./cost/fee-schedule.js";
export type { FeeSchedule } from "./cost/fee-schedule.js";
export { applySlippage, computeTradeCost } from "./cost/trade-cost-model.js";
export type { TradeCostResult } from "./cost/trade-cost-model.js";
export { computeNetEdgeGate } from "./cost/net-edge-gate.js";
export type { NetEdgeGateInput, NetEdgeGateResult } from "./cost/net-edge-gate.js";
export {
	evaluatePreTradeEdge,
	estimateGrossEdgeBpsFromLevels,
	priceDistanceBps,
} from "./cost/pre-trade-edge.js";
export type { PreTradeEdgeInput, PreTradeEdgeResult } from "./cost/pre-trade-edge.js";
export {
	PROFIT_HARD_DISABLED_STRATEGIES,
	mergeDisabledStrategies,
} from "./strategies/strategy-registry.js";
export * as indicators from "./indicators/index.js";
export { TradeNotifier } from "./engine/trade-notifier.js";
export type { TradeEvent } from "./engine/trade-notifier.js";
export { WebhookAlerter } from "./engine/webhook-alerter.js";
export type { WebhookAlertPayload } from "./engine/webhook-alerter.js";
export { AlertEscalation } from "./risk/alert-escalation.js";
export type { Alert, AlertEscalationConfig, AlertSeverity } from "./risk/alert-escalation.js";
export { SignalEngine } from "./engine/signal-engine.js";
export type { SignalEngineConfig, SignalEngineDeps } from "./engine/signal-engine.js";
export { SignalEnsemble } from "./engine/signal-ensemble.js";
export type { EnsembleConfig, EnsembleVote, EnsembleResult } from "./engine/signal-ensemble.js";
export { StrategyAdaptor } from "./engine/strategy-adaptor.js";
export type { StrategyAdaptorConfig, StrategyWeight } from "./engine/strategy-adaptor.js";
export { TradeJournal } from "./engine/trade-journal.js";
export type { SignalRecord, StrategyTradeRecord, ReturnAttributionBucket } from "./engine/trade-journal.js";
export {
	ExecutionQualityController,
	computeAdverseImpactBps,
	computeAdverseSlippageBps,
	deriveBookSnapshot,
} from "./engine/execution-quality-controller.js";
export type {
	AdaptiveOrderType,
	AdaptiveOrderTypeDecision,
	ExecutionBookSnapshot,
	ExecutionQualityControllerConfig,
	ExecutionQualitySample,
	ExecutionQualityStats,
	ExecutionSizingAdjustment,
} from "./engine/execution-quality-controller.js";
export { ExecutionManager, classifyExchangeError, withExchangeRetry } from "./engine/execution-manager.js";
export type { ExecutionManagerDeps, ExecuteResult, ExchangeErrorType } from "./engine/execution-manager.js";
export { PortfolioAnalyzer } from "./analytics/portfolio-analyzer.js";
export { MultiAssetFetcher, DEFAULT_UNIVERSE, computeProxyScale, spliceExtendedHistory } from "./analytics/multi-asset-fetcher.js";
export type { OHLCVBar, AssetSeries, FetchResult } from "./analytics/multi-asset-fetcher.js";
export type { Exchange, ExchangeConfig, CandleData } from "./exchanges/exchange.js";
export { CryptoComAdapter } from "./exchanges/crypto-com-adapter.js";
export { ExchangeManager } from "./exchanges/exchange-manager.js";
export type { PriceComparison, AggregatedBalances } from "./exchanges/exchange-manager.js";
export { PriceFeed } from "./ws/price-feed.js";
export type { PriceUpdate, PriceFeedConfig, PriceFeedEvents } from "./ws/price-feed.js";
export type {
	PortfolioSummary, SymbolBreakdown, DayBreakdown,
	StrategyComparison, FullAnalytics,
} from "./analytics/portfolio-analyzer.js";
export { runMacroPredictionReport } from "./analytics/macro-prediction-report.js";
export type {
	MacroPredictionReport,
	MacroPredictionTargetResult,
	RunMacroPredictionOptions,
} from "./analytics/macro-prediction-report.js";
export { mineMacroPatternEdges } from "./analytics/macro-pattern-miner.js";
export type { MacroPatternEdge, MineMacroPatternOptions } from "./analytics/macro-pattern-miner.js";
export { MACRO_FEATURE_NAMES, alignAssetSeries, monthsSinceLastHalving } from "./analytics/pattern-feature-engine.js";
export { runWalkForward, trainLogisticRegression, predictProba } from "./analytics/walk-forward-predictor.js";
export type { WalkForwardReport, WalkForwardConfig } from "./analytics/walk-forward-predictor.js";

// ── Leaderboard ──
export { LeaderboardStore } from "./leaderboard/leaderboard-store.js";
export type { StrategyMetrics, DailySnapshot, LeaderboardPeriod } from "./leaderboard/leaderboard-store.js";

// ── XRPL DEX ──
export { XRPLClient, DEX_PAIRS, KNOWN_ISSUERS } from "./xrpl/xrpl-client.js";
export type { XRPLCurrency, XRPLOrderBook, XRPLClientConfig, XRPLBookEntry } from "./xrpl/xrpl-client.js";
export { XRPLDEXWatcher } from "./xrpl/xrpl-dex-watcher.js";
export type { WatchedPair, Opportunity, DEXSnapshot, DEXWatcherConfig } from "./xrpl/xrpl-dex-watcher.js";
export { MarketLearner } from "./xrpl/market-learner.js";
export type { MarketObservation, HourlyPattern, DailyDigest, LearnedPattern } from "./xrpl/market-learner.js";
export { createXRPLHandlers } from "./xrpl/xrpl-handlers.js";
export type { XRPLHandlerDeps } from "./xrpl/xrpl-handlers.js";
export { CexMarketWatcher } from "./xrpl/cex-market-watcher.js";
export type { CexWatchedSymbol, CexSnapshot, CexOpportunity, CexWatcherConfig } from "./xrpl/cex-market-watcher.js";
export { createCexHandlers } from "./xrpl/cex-handlers.js";
export type { CexHandlerDeps } from "./xrpl/cex-handlers.js";

// ── Multi-chain DEX (Stellar, Solana, Flare) ──
export { StellarClient, STELLAR_ASSETS, STELLAR_PAIRS } from "./dex/stellar-client.js";
export type { StellarAsset, StellarOrderBook } from "./dex/stellar-client.js";
export { SolanaClient, SOLANA_TOKENS, SOLANA_WATCH_PAIRS } from "./dex/solana-client.js";
export type { SolanaPair, SolanaOrderBook } from "./dex/solana-client.js";
export { FlareClient, FLARE_TOKENS, FLARE_WATCH_TOKENS } from "./dex/flare-client.js";
export type { FlarePair, FlarePoolReserves } from "./dex/flare-client.js";
export { MultiDEXWatcher } from "./dex/multi-dex-watcher.js";
export type { ChainSnapshot, ChainOpportunity, MultiDEXConfig } from "./dex/multi-dex-watcher.js";
export { createDEXHandlers } from "./dex/dex-handlers.js";
export type { DEXHandlerDeps } from "./dex/dex-handlers.js";
export { JupiterSwapExecutor } from "./dex/jupiter-swap-executor.js";
export type { JupiterQuoteSummary, JupiterSwapPaperResult, JupiterSwapLiveResult } from "./dex/jupiter-swap-executor.js";
export { isDexSolanaExecutionSymbol, parseSolanaDexTokenSymbol, DEX_EXECUTION_VENUE_SOLANA } from "./dex/dex-execution-symbol.js";
export { fetchDexSolanaUsdPrice } from "./dex/dex-usd-price.js";

// ── DCA Strategy ──
export {
	isDue as dcaIsDue,
	calculateBuyAmount as dcaCalculateBuyAmount,
	updateState as dcaUpdateState,
	emptyState as dcaEmptyState,
	loadConfigs as dcaLoadConfigs,
	saveConfigs as dcaSaveConfigs,
	loadState as dcaLoadState,
	saveState as dcaSaveState,
	computeSmaPrice as dcaComputeSmaPrice,
} from "./engine/dca-strategy.js";
export type { DCAConfig, DCAState, DCAInterval, DCAStore } from "./engine/dca-strategy.js";

// ── Portfolio Rebalancing ──
export {
	computeRebalancePlan,
	executeRebalancePlan,
	loadRebalanceConfig,
	saveRebalanceConfig,
	REBALANCE_CONFIG_KEY,
} from "./engine/portfolio-rebalancer.js";
export type {
	RebalanceConfig,
	RebalancePlan,
	RebalanceTrade,
	RebalanceExecutionResult,
	PositionSnapshot,
	RebalanceHandlers,
} from "./engine/portfolio-rebalancer.js";

// ── Practice Trading ──
export { OpportunityTrader } from "./engine/opportunity-trader.js";
export type {
	OpportunitySignal,
	PaperPosition,
	OpportunityTraderConfig,
	OpportunityTraderDeps,
	OpportunityTraderInit,
} from "./engine/opportunity-trader.js";
export { createPracticeHandlers } from "./engine/practice-handlers.js";
export type { PracticeHandlerDeps } from "./engine/practice-handlers.js";

// ── Trading Health & Position Graduation ──
export { TradingHealthAggregator } from "./engine/trading-health.js";
export type { TradingHealthDeps, TradingHealthReport, OverallHealth } from "./engine/trading-health.js";
export { PositionGraduation } from "./risk/position-graduation.js";
export type { PositionGraduationConfig, GraduationStatus, TradeStats, GraduationStep } from "./risk/position-graduation.js";

// ── Shadow Mode ──
export { ShadowModeExecutor, SHADOW_PNL_SNAPSHOT_CAP } from "./engine/shadow-mode.js";
export type {
	ShadowTradeParams,
	ShadowTradeResult,
	ShadowPerformance,
	ShadowPosition,
	ShadowModeExecutorOpts,
	PreTradeCheckFn,
} from "./engine/shadow-mode.js";
export { generateShadowReport } from "./engine/shadow-report.js";
export type {
	PnlCurvePoint,
	GateActivationSummary,
	ShadowAnomaly,
	ShadowReport,
} from "./engine/shadow-report.js";

// ── Bellman-Ford Arbitrage ──
export { findArbitrageCycles, createEdge } from "./arbitrage/bellman-ford.js";
export type { Edge, ArbitrageCycle, BellmanFordResult } from "./arbitrage/bellman-ford.js";
export {
	findBestExecutableRouteSize,
	simulateExecutableRoute,
	simulateExecutableRouteBatch,
} from "./arbitrage/executable-route.js";
export type {
	BestExecutableRouteOptions,
	ExecutableHopFill,
	ExecutableLevelFill,
	ExecutableLiquidityLevel,
	ExecutableRoute,
	ExecutableRouteCostModel,
	ExecutableRouteEdge,
	ExecutableRouteSimulation,
} from "./arbitrage/executable-route.js";
export {
	loadNativeRouteKernel,
	scoreRouteBatchWithKernel,
} from "./arbitrage/native-route-kernel.js";
export type {
	RouteKernelBatchResult,
	RouteKernelModule,
} from "./arbitrage/native-route-kernel.js";
export { cycleToExecutableRoute, rescoreArbitrageCycle } from "./arbitrage/executable-cycle.js";
export type {
	ExecutableCycleScore,
	RescoreArbitrageCycleOptions,
} from "./arbitrage/executable-cycle.js";
export { GraphBuilder } from "./arbitrage/graph-builder.js";
export type { GraphBuilderConfig, GraphSnapshot } from "./arbitrage/graph-builder.js";
export { ArbitrageScanner } from "./arbitrage/arbitrage-scanner.js";
export type { ArbitrageScannerConfig, ScanResult } from "./arbitrage/arbitrage-scanner.js";
export { createArbitrageHandlers } from "./arbitrage/arbitrage-handlers.js";
export type { ArbitrageHandlerDeps } from "./arbitrage/arbitrage-handlers.js";

export const manifest: PluginManifest = {
	name: "trading",
	version: "0.1.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["network.request", "finance.trading"],
	trust: "core",
	tools: [
		// ── Read-only: prices ──
		{
			name: "trade_get_price",
			description:
				"Get the current price, 24h high/low, bid/ask, volume, and formatted 24h change for a cryptocurrency. Returns JSON `{ \"result\": { \"symbol\", \"price\", \"bid\", \"ask\", \"high24h\", \"low24h\", \"volume24h\", \"change24h\" } }`. Symbols like 'BTC', 'ETH', 'XRP' are auto-converted to USDT pairs.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description:
							'Trading pair (e.g., "BTC", "ETH_USDT", "SOL")',
					},
				},
				required: ["symbol"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_btc_eth_ratio",
			description:
				"Return spot BTC/USD and ETH/USD from the exchange and the ratio BTC/ETH (btcUsd/ethUsd) to 4 decimal places. For cron/scheduler tool runs — no LLM required.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_daily_crypto_discipline",
			description:
				"Scheduled discipline snapshot: uses trade_get_prices, trade_get_orderbook, trade_portfolio, and trade_risk_status for BTC/ETH/SOL/XRP; stop-loss proximity (2%) from trade_risk_status.stops vs same-run marks; P&L band (±5%) from trade_portfolio.pnlExpectation; live peak drawdown (5%) when not in paper mode; HALTED state. Appends one NDJSON line per run (executionStatus: success|failure) to logPath (default config: /var/log/daily_crypto_check.log; env ZARAA_DAILY_CRYPTO_LOG; handler fallback ~/.zaraa/logs/daily_crypto_check.log if /var/log is not writable). On alert: rc_notify (macOS) plus NotificationManager iMessage channel (imsg_send path). Gateway: GET /api/trading/daily-discipline?log_path=&non_blocking=&record_task= (record_task defaults on; set record_task=0 to skip task-store audit). With non_blocking=1, returns {skipped:true} if the cross-process discipline lock is already held (no wait). External cron: scripts/daily-crypto-discipline-cron.sh. Safe for CronScheduler `tool` field with `{ \"log_path\": \"/var/log/daily_crypto_check.log\" }`.",
			parameters: {
				type: "object",
				properties: {
					log_path: {
						type: "string",
						description:
							"Optional log file path (default: zaraa.config scheduler task toolArgs, else ZARAA_DAILY_CRYPTO_LOG, else ~/.zaraa/logs/daily_crypto_check.log)",
					},
					non_blocking: {
						type: "boolean",
						description:
							"If true, skip immediately when the discipline run lock is held instead of waiting (overlap-safe for cron + daemon).",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_get_prices",
			description:
				"Batch spot quotes for up to 20 symbols (rate-limited internally). Returns `{ results: [...] }` where each successful row matches `result` from `trade_get_price`; failures use `{ symbol, price: null, error }`. Prefer this when you need several tickers in one tool round-trip.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description: 'USDT pairs, e.g. ["BTC_USDT","ETH_USDT"]',
					},
				},
				required: ["symbols"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_get_orderbook",
			description:
				"Get the order book (bids/asks) for a trading pair. Shows market depth and spread.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: "Trading pair",
					},
					depth: {
						type: "number",
						description:
							"Number of price levels (default: 10, max: 50)",
					},
				},
				required: ["symbol"],
			},
			requiresApproval: false,
		},

		// ── Read-only: account ──
		{
			name: "trade_get_balances",
			description:
				"Get exchange account balances. Shows available, locked, and total for each currency.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_get_positions",
			description:
				"Get all tracked open positions with entry price, quantity, and unrealized P&L.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		{
			name: "trade_verify_exchange",
			description:
				"Verify exchange API connectivity. Tests both public (ticker) and private (balances) endpoints to confirm credentials are valid and the exchange is reachable. On success, records a 24h timestamp used by the pre-live checklist. Call before enabling live mode.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_pre_live_checklist",
			description:
				"Read-only gate before live trading: credentials, recent trade_verify_exchange (24h), limits, kill switch, circuit breaker, PAPER_TRADING env, and zaraa.config trading.paperMode. trade_set_limit(paper_mode:false) requires all items to pass.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Alerts ──
		{
			name: "trade_set_alert",
			description:
				'Set a price alert. Zaraa will notify you when the price crosses the target. Use condition "above" or "below".',
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: 'Trading pair (e.g., "BTC")',
					},
					condition: {
						type: "string",
						enum: ["above", "below"],
						description: "Trigger when price goes above or below target",
					},
					target_price: {
						type: "number",
						description: "Target price in USD",
					},
				},
				required: ["symbol", "condition", "target_price"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_list_alerts",
			description:
				"List active price alerts. Set overnight_briefing=true for morning briefings: includes active alerts plus alerts triggered in the last ~18 hours.",
			parameters: {
				type: "object",
				properties: {
					overnight_briefing: {
						type: "boolean",
						description:
							"When true, returns { active, triggeredOvernight, sinceIso } for overnight/morning summaries.",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_delete_alert",
			description: "Delete a price alert by ID.",
			parameters: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "Alert ID to delete",
					},
				},
				required: ["id"],
			},
			requiresApproval: false,
		},

		// ── Trading (require approval) ──
		{
			name: "trade_buy",
			minZone: "trusted",
			description:
				"Buy cryptocurrency. Subject to per-trade and daily spending limits. Risk manager validates position size, exposure, and drawdown. Auto-calculates stop-loss and take-profit using ATR if not specified. In paper mode, simulates the trade without hitting the exchange.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: 'Trading pair (e.g., "BTC", "ETH_USDT")',
					},
					qty: {
						type: "number",
						description: "Quantity to buy (in base currency units)",
					},
					type: {
						type: "string",
						enum: ["MARKET", "LIMIT"],
						description: "Order type (default: MARKET)",
					},
					price: {
						type: "number",
						description: "Limit price (required for LIMIT orders)",
					},
					stop_loss: {
						type: "number",
						description: "Stop-loss price (auto-calculated from ATR if omitted)",
					},
					take_profit: {
						type: "number",
						description: "Take-profit price (auto-calculated from risk:reward ratio if omitted)",
					},
					trailing_stop_pct: {
						type: "number",
						description: "Trailing stop as % below high-water mark (e.g., 3 = 3%)",
					},
					direction: {
						type: "string",
						enum: ["long", "short"],
						description: "Position direction (default: long). Set by the signal engine; manual callers can omit.",
					},
					signal_id: {
						type: "string",
						description: "Optional signal_log id. When present, the entry is also written to strategy_trades so the learning loop can grade the outcome on close.",
					},
					strategy_name: {
						type: "string",
						description: "Optional strategy name accompanying signal_id (required together) so strategy_trades is tagged for grading.",
					},
				},
				required: ["symbol", "qty"],
			},
			requiresApproval: true,
		},
		{
			name: "trade_sell",
			minZone: "trusted",
			description:
				"Sell cryptocurrency. Optionally close a tracked position by providing position_id.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: "Trading pair",
					},
					qty: {
						type: "number",
						description: "Quantity to sell",
					},
					type: {
						type: "string",
						enum: ["MARKET", "LIMIT"],
						description: "Order type (default: MARKET)",
					},
					price: {
						type: "number",
						description: "Limit price (required for LIMIT orders)",
					},
					position_id: {
						type: "string",
						description:
							"Position ID to close (from trade_get_positions)",
					},
				},
				required: ["symbol", "qty"],
			},
			requiresApproval: true,
		},
		{
			name: "trade_dex_swap",
			minZone: "trusted",
			description:
				"Execute a Solana on-chain swap via Jupiter v6 (USDC ↔ tokens in SOLANA_TOKENS). Symbol must be solana:TOKEN (e.g. solana:SOL, solana:JUP). Paper mode simulates from quote only; live mode requires confirm_live=true and SOLANA_DEX_SECRET_KEY (base58). Respects max_trade_usd, daily_limit_usd (combined with CEX), kill gate, and risk manager.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: 'Execution symbol, e.g. "solana:SOL" or "solana:JUP" (listed in SOLANA_TOKENS only)',
					},
					qty: {
						type: "number",
						description: "Token quantity: long = tokens to receive; short = tokens to sell for USDC",
					},
					direction: {
						type: "string",
						enum: ["long", "short"],
						description: "long = buy token with USDC; short = sell token for USDC (default: long)",
					},
					stop_loss: { type: "number", description: "Stop price in USD per token (optional; auto from risk if omitted)" },
					take_profit: { type: "number", description: "Take-profit in USD per token (optional)" },
					trailing_stop_pct: { type: "number", description: "Trailing stop % from high-water mark" },
					slippage_bps: { type: "number", description: "Jupiter slippage in basis points (default: 50)" },
					confirm_live: {
						type: "boolean",
						description: "Must be true to submit a real on-chain swap when not in paper DB mode",
					},
				},
				required: ["symbol", "qty"],
			},
			requiresApproval: true,
		},

		// ── Portfolio & history ──
		{
			name: "trade_history",
			description: "Get recent trade history (both paper and live trades).",
			parameters: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Number of trades to return (default: 20)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_portfolio",
			description:
				"Get full portfolio overview: open positions with live P&L, closed P&L, daily spend, and trading limits.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Settings ──
		{
			name: "trade_set_limit",
			minZone: "trusted",
			description:
				"Adjust trading safety limits: max per-trade amount ($500 cap), daily spending cap ($2000 cap), or toggle paper trading mode. Switching to live requires confirm_live=true AND a passing trade_pre_live_checklist (run trade_verify_exchange within 24h, limits set, kill switch off, etc.).",
			parameters: {
				type: "object",
				properties: {
					max_trade_usd: {
						type: "number",
						description: "Maximum USD value per trade (capped at $500)",
					},
					daily_limit_usd: {
						type: "number",
						description: "Maximum USD value of buys per day (capped at $2000)",
					},
					paper_mode: {
						type: "boolean",
						description:
							"Paper trading mode (true = simulate, false = real trades). Setting to false requires confirm_live=true.",
					},
					confirm_live: {
						type: "boolean",
						description:
							"Required safety confirmation when switching paper_mode to false (live trading with real money).",
					},
				},
				required: [],
			},
			requiresApproval: true,
		},

		// ── Risk management ──
		{
			name: "trade_set_stop",
			minZone: "trusted",
			description:
				"Set or update stop-loss, take-profit, or trailing stop for an open position.",
			parameters: {
				type: "object",
				properties: {
					position_id: {
						type: "string",
						description: "Position ID (from trade_get_positions)",
					},
					stop_loss: {
						type: "number",
						description: "Stop-loss price — position auto-closes if price hits this level",
					},
					take_profit: {
						type: "number",
						description: "Take-profit price — position auto-closes at this profit target",
					},
					trailing_stop_pct: {
						type: "number",
						description:
							"Trailing stop as % below high-water mark (e.g., 3 = 3%). Ratchets up as price rises.",
					},
				},
				required: ["position_id"],
			},
			requiresApproval: true,
		},
		{
			name: "trade_check_stops",
			minZone: "trusted",
			description:
				"Check all open positions against their stop-loss, take-profit, and trailing stop levels. Automatically closes positions when stops are hit. Called by the scheduler.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_reconcile_orders",
			description:
				"Live only: fetch open orders from the exchange and compare to local submitted_orders (default lookback 24h, overridable via reconcile_lookback_hours). Reports partial-fill mismatches and orphaned exchange orders. No-op (skipped) in paper mode.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_reset_paper",
			minZone: "trusted",
			description:
				"Close all open paper positions at current market prices. Used for clean restart after safety system upgrades. Only works in paper mode.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: true,
		},
		{
			name: "trade_reset_drawdown",
			minZone: "trusted",
			description:
				"Reset peak equity to current level, accepting the drawdown loss and clearing the trading halt. Allows signals to execute again after a drawdown recovery decision. Only works in paper mode with no open positions.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_reset_breakers",
			minZone: "trusted",
			description:
				"Reset all circuit breakers (consecutive_loss, drawdown, velocity) in one call and clear trading_state to ACTIVE. Sole admin path for the velocity breaker, which has no individual reset and otherwise waits 4h for auto-reset. Use when trade_risk_status.emergencyGates shows newEntriesAllowed=false due to a stale breaker. Paper-mode only.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_risk_status",
			description:
				"Get current risk status: emergency gates (kill switch, daily loss cap, venue halt, circuit breaker), open positions, stop levels, drawdown, exposure, and risk config.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_explain_state",
			description:
				"Explain the current trading state in plain English: state (ACTIVE/HALTED/LOCKED/DEGRADED), what triggered any halt, what's needed to recover (equity threshold or operator reset), and current drawdown context. Read-only; safe to call any time.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_set_kill_switch",
			minZone: "trusted",
			description:
				"Turn the global trading kill switch ON or OFF. When ON, new entries are blocked (signal scans, execution manager, trade_buy, trade_dex_swap). Stop-monitor exits are unaffected. Use in emergencies.",
			parameters: {
				type: "object",
				properties: {
					enabled: {
						type: "boolean",
						description: "true = halt new entries; false = resume if other gates allow",
					},
				},
				required: ["enabled"],
			},
			requiresApproval: true,
		},
		{
			name: "trade_set_daily_loss_cap",
			minZone: "trusted",
			description:
				"Set or clear a UTC-day realized P&L loss cap (matches paper vs live via paper_mode). When today's closed-position P&L is below −cap, new entries are blocked. Omit cap_usd to clear.",
			parameters: {
				type: "object",
				properties: {
					cap_usd: {
						type: "number",
						description: "Max allowed loss in USD for the UTC day; omit or null to disable",
					},
				},
				required: [],
			},
			requiresApproval: true,
		},

		// ── Strategy & backtesting ──
		{
			name: "trade_list_strategies",
			description:
				"List all available trading strategies with their descriptions, timeframes, and active status.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_rsi_divergence_counters",
			description:
				"Snapshot of the per-conjunct gate-failure counters tallied inside rsi-divergence strategy's evaluate(). Use to diagnose which gate (pivots / distance / divergence / RSI band / price confirm / MACD) is the bottleneck during a soak window. Returns `{ snapshot: {evaluations, preconditionFailed, signals:{long,short}, bullish:{...}, bearish:{...}}, reset, takenAt }`. Pass `reset: true` to zero the counters AFTER reading (returns the pre-reset snapshot). Counters live per-process, so live and validation/mirror daemons each keep their own.",
			parameters: {
				type: "object",
				properties: {
					reset: {
						type: "boolean",
						description:
							"If true, reset the counters to zero after reading the snapshot. Default false (read-only).",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_backtest",
			description:
				"Backtest a strategy against historical candle data. Returns performance metrics (win rate, Sharpe ratio, profit factor, max drawdown) plus a markdown report. Results are saved to the database for comparison. Use trade_backtest_list to see past runs.",
			parameters: {
				type: "object",
				properties: {
					strategy: {
						type: "string",
						description: 'Strategy name (e.g., "mean-reversion", "trend-following", "breakout")',
					},
					symbol: {
						type: "string",
						description: 'Trading pair to backtest on (default: "BTC")',
					},
					timeframe: {
						type: "string",
						description: "Candle timeframe (defaults to strategy preference)",
					},
					starting_equity: {
						type: "number",
						description: "Starting equity in USD (default: 10000)",
					},
					period: {
						type: "string",
						description: 'How far back to look, e.g. "7d", "30d", "90d", "1y". Omit to use all available candles.',
					},
				},
				required: ["strategy"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_backtest_list",
			description:
				"List previously saved backtest results for comparison. Optionally filter by strategy name or symbol to compare runs over time.",
			parameters: {
				type: "object",
				properties: {
					strategy: {
						type: "string",
						description: "Filter by strategy name",
					},
					symbol: {
						type: "string",
						description: "Filter by trading pair symbol",
					},
					limit: {
						type: "number",
						description: "Max results to return (default: 10)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_deploy_strategy",
			minZone: "trusted",
			description:
				"Activate or deactivate a strategy for live/paper signal generation. Once deployed, the strategy will evaluate candles on each scheduler tick and emit trade signals.",
			parameters: {
				type: "object",
				properties: {
					strategy: {
						type: "string",
						description: "Strategy name to deploy",
					},
					symbols: {
						type: "array",
						items: { type: "string" },
						description: 'Trading pairs to run on (default: ["BTC_USDT"])',
					},
					deactivate: {
						type: "boolean",
						description: "Set to true to deactivate the strategy",
					},
				},
				required: ["strategy"],
			},
			requiresApproval: true,
		},

		// ── Technical indicators ──
		{
			name: "trade_get_indicators",
			description:
				"Get technical indicators (RSI, MACD, Bollinger Bands, EMA, ATR, VWAP, etc.) for a cryptocurrency. Returns current values plus trend direction.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: 'Trading pair (e.g., "BTC", "ETH_USDT")',
					},
					timeframe: {
						type: "string",
						enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
						description: "Candle timeframe (default: 1h)",
					},
					indicators: {
						type: "array",
						items: { type: "string" },
						description:
							'Indicators to compute (e.g., ["rsi", "macd", "bollinger", "ema_20", "ema_50", "ema_cross", "ema_cross_20_50", "atr", "vwap", "stoch_rsi", "obv", "sma_200"]). ema_cross defaults to 12/26; ema_cross_{fast}_{slow} requires fast < slow. Defaults to rsi, macd, bollinger, ema_20, ema_50, atr.',
					},
				},
				required: ["symbol"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_fetch_candles",
			description:
				"Fetch and store OHLCV candlestick data for watched symbols. Called automatically by the scheduler to build local price history. Can also fetch specific symbols on demand.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description:
							"Optional: specific symbols to fetch (overrides watch list)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_backfill_candles",
			minZone: "trusted",
			description:
				"Backfill historical candle data by paginating through the exchange API. Fetches 30-90 days of OHLCV history for backtesting and strategy development. Defaults to BTC, ETH, SOL, XRP on 1h and 4h timeframes.",
			parameters: {
				type: "object",
				properties: {
					days: {
						type: "number",
						description:
							"Number of days to backfill (1-365, default: 30)",
					},
					symbols: {
						type: "array",
						items: { type: "string" },
						description:
							'Symbols to backfill (default: ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT"])',
					},
					timeframes: {
						type: "array",
						items: { type: "string" },
						description:
							'Timeframes to backfill (default: ["1h", "4h"])',
					},
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Signal engine ──
		{
			name: "trade_scan_signals",
			minZone: "trusted",
			description:
				"Scan all active strategies against current market data in paper mode only. Generates trade signals, validates them through the risk manager, and may auto-execute paper trades. Returns an error when paper_mode is false so smoke/scheduler scans cannot trigger live orders.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_get_signals",
			description:
				"View recent trade signals and strategy performance stats. Shows signal history with status (executed, pending, rejected, failed), confidence scores, and per-strategy P&L.",
			parameters: {
				type: "object",
				properties: {
					strategy: {
						type: "string",
						description: "Filter by strategy name (optional — shows all if omitted)",
					},
					limit: {
						type: "number",
						description: "Number of signals to return (default: 20)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Analytics ──
		{
			name: "trade_analytics",
			description:
				"Get comprehensive portfolio analytics: win rate, P&L, profit factor, drawdown, win/loss streaks, per-symbol breakdown, and day-of-week performance patterns.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_macro_prediction",
			description:
				"Cross-asset macro prediction report: fetches daily history from Yahoo and splices longer proxy history where needed (e.g. ^GSPC, gold/silver futures, CryptoCompare crypto), aligns series, tags SPY regimes, runs walk-forward L2 logistic regression on engineered features (momentum, vol, SPY trend, gold/silver and BTC/gold ratios, Bitcoin halving phase, regime dummies), and returns out-of-sample accuracy vs baseline plus current P(up) over the horizon per symbol. Not investment advice; for research and signal prototyping.",
			parameters: {
				type: "object",
				properties: {
					years: {
						type: "number",
						description: "Years of daily history to pull (1–30, default 10)",
					},
					horizon_days: {
						type: "number",
						description: "Forward return horizon in trading days for the label (1–120, default 20)",
					},
					symbols: {
						type: "array",
						items: { type: "string" },
						description:
							"Yahoo symbols e.g. SPY, GLD, SLV, BTC-USD, ETH-USD (default: built-in cross-asset universe)",
					},
					symbols_csv: {
						type: "string",
						description: "Comma-separated Yahoo symbols (alternative to symbols array)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_strategy_report",
			description:
				"Get strategy performance comparison report. Shows side-by-side metrics (win rate, P&L, R-multiple, profit factor) for all strategies, or drill into a specific strategy's signal and trade history.",
			parameters: {
				type: "object",
				properties: {
					strategy: {
						type: "string",
						description: "Optional: drill into a specific strategy for detailed signal/trade history",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Trade Journal ──
		{
			name: "trade_journal",
			description:
				"Generate a markdown trade journal for a configurable time period (default: 7 days / weekly). " +
				"Includes a full trade list with entry/exit prices and P&L, per-strategy and per-symbol breakdowns, " +
				"win/loss ratio, total P&L, best and worst trades, and an auto-generated 'Lessons Learned' section " +
				"that identifies patterns like which strategies lost most, direction bias, and time-of-day issues. " +
				"Saves the report to ~/.zaraa/data/journals/ with a date-stamped filename. " +
				"Call this on demand or schedule it weekly with the Zaraa scheduler.",
			parameters: {
				type: "object",
				properties: {
					days: {
						type: "number",
						description:
							"How many days back to include (default: 7 for weekly, use 30 for monthly, 1 for daily). Max 365.",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Leaderboard ──
		{
			name: "trade_leaderboard",
			description:
				"Show a ranked leaderboard of all trading strategies by performance. " +
				"Returns total P&L, win rate, average return, max drawdown, Sharpe ratio, " +
				"trade count, and a 30-day daily P&L sparkline for each strategy. " +
				"Strategies are ranked best-to-worst by total P&L. " +
				"Use period to filter: '7d', '30d', '90d', or 'all' (default: '30d').",
			parameters: {
				type: "object",
				properties: {
					period: {
						type: "string",
						enum: ["7d", "30d", "90d", "all"],
						description: "Time window for performance metrics. Default: '30d'.",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_strategy_grade_refresh",
			minZone: "trusted",
			description:
				"Recompute automated strategy grades from closed strategy_trades: rolling profit factor, expectancy, " +
				"cumulative drawdown proxy, regime mix, cross-strategy quartiles, and allocation multipliers. " +
				"Updates strategy_lifecycle (rollup symbol '*') used by the signal engine to scale or block sizing. " +
				"Run after meaningful paper sample or on a schedule.",
			parameters: {
				type: "object",
				properties: {
					max_trades_lookback: {
						type: "number",
						description: "Max recent closes per strategy (default 80)",
					},
					min_trades_to_grade: {
						type: "number",
						description: "Min closes before quartiles apply (default 12)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_strategy_lifecycle",
			description:
				"List current strategy lifecycle rows: lifecycleState, allocationMultiplier, last run id, and detail JSON. " +
				"Shows how paper/live journal performance is gating per-strategy capital allocation.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_strategy_rankings",
			minZone: "trusted",
			description:
				"Recompute and persist per-strategy rankings (Sharpe, win rate, max drawdown, total PnL) from closed live trades over the last 30 days. " +
				"Writes rows into strategy_rankings; signalWeightMultiplier feeds the bandit/ensemble allocation. " +
				"Schedule periodically so promote/demote weights stay current.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_snapshot_strategies",
			minZone: "trusted",
			description:
				"Take a daily performance snapshot for every strategy with closed real/paper trades. " +
				"Writes one row per strategy per UTC day into strategy_performance_snapshots (UPSERT). " +
				"Powers the leaderboard history and longitudinal performance tracking.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},

		// ── Exchange verification ──
		{
			name: "trade_verify_exchange",
			description:
				"Smoke test the exchange API connection. Verifies credentials exist, " +
				"public API responds (fetches BTC price), and private API authenticates " +
				"(fetches account balances). Returns pass/fail for each check.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Multi-exchange ──
		{
			name: "trade_list_exchanges",
			description:
				"List all registered exchanges with their connection status and which is the default.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_compare_prices",
			description:
				"Compare prices for a symbol across all registered exchanges. Shows best bid/ask and any arbitrage spread opportunity.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: 'Trading pair (e.g., "BTC", "ETH_USDT")',
					},
				},
				required: ["symbol"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_aggregate_balances",
			description:
				"Get aggregated balances across all exchanges. Shows per-exchange breakdown and combined totals by currency.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── WebSocket price feed ──
		{
			name: "trade_ws_status",
			description:
				"Get WebSocket price feed status: connection state, active subscriptions, and latest cached prices from the real-time stream.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_ws_subscribe",
			description:
				"Subscribe to real-time price updates via WebSocket. Prices stream continuously and are used for instant stop-loss monitoring. Auto-connects if not already connected.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description: 'Symbols to subscribe to (e.g., ["BTC", "ETH", "SOL"])',
					},
				},
				required: ["symbols"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_ws_unsubscribe",
			description:
				"Unsubscribe from real-time price updates for specific symbols.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description: "Symbols to unsubscribe from",
					},
				},
				required: ["symbols"],
			},
			requiresApproval: false,
		},

		// ── Daily report ──
		{
			name: "trade_daily_report",
			description:
				"Comprehensive daily trading report: trades opened/closed, realized + unrealized P&L, win rate, active regime/session, equity vs yesterday, and current open positions. Runs automatically at 23:55 UTC as an end-of-day summary.",
			parameters: {
				type: "object",
				properties: {
					date: {
						type: "string",
						description: "Date to report on in YYYY-MM-DD format (default: today UTC)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Paper trading tools ──
		{
			name: "trade_paper_summary",
			description:
				"Daily P&L summary report for paper (or live) trading. Shows total P&L, per-position performance, win/loss ratio, and virtual portfolio state for a given date (defaults to today). Results are clearly labelled PAPER or LIVE.",
			parameters: {
				type: "object",
				properties: {
					date: {
						type: "string",
						description: "Date to report on in YYYY-MM-DD format (default: today UTC)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_paper_reset",
			minZone: "trusted",
			description:
				"Reset the paper trading virtual portfolio to its starting balance. Wipes all paper trades, positions, and coin holdings, then restores the virtual USDT balance (default $1000). Requires confirm=true. Only available in paper mode.",
			parameters: {
				type: "object",
				properties: {
					confirm: {
						type: "boolean",
						description: "Must be true to confirm the reset — this wipes all paper history",
					},
				},
				required: [],
			},
			requiresApproval: true,
		},

		// ── Alert checker (for scheduler) ──
		{
			name: "trade_check_alerts",
			description:
				"Check all active price alerts against current market prices. Triggers notifications for any alerts that have been hit. Called automatically by the scheduler.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── XRPL DEX ──
		{
			name: "xrpl_scan_dex",
			description:
				"Scan the XRPL DEX for all watched pairs. Returns order book snapshots (mid price, spread, depth, imbalance) and detected opportunities (spread capture, momentum, imbalance, depth gaps). Called automatically by the scheduler to build market knowledge.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_get_orderbook",
			description:
				"Get the full order book (bids/asks) for an XRPL DEX trading pair. Shows prices, quantities, spread, and depth.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'DEX pair label (e.g., "SOLO/XRP", "XRP/USD", "CSC/XRP", "CORE/XRP")',
					},
					depth: {
						type: "number",
						description: "Number of price levels per side (default: 15, max: 50)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_dex_summary",
			description:
				"Get a summary of all watched XRPL DEX pairs: prices, spreads, imbalances, best spread capture opportunity, and strongest directional pressure.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_account_info",
			description:
				"Get XRPL account info: XRP balance, reserve requirements, available balance, and trust lines with balances.",
			parameters: {
				type: "object",
				properties: {
					address: {
						type: "string",
						description: "XRPL account address (r...)",
					},
				},
				required: ["address"],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_learned_patterns",
			description:
				"Get patterns Zaraa has learned from watching the XRPL DEX: spread windows, momentum hours, imbalance shifts, day-of-week patterns. Runs pattern analysis before returning results.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: "Filter by pair (optional — shows all if omitted)",
					},
					min_confidence: {
						type: "number",
						description: "Minimum confidence threshold 0-1 (default: 0.2)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_hourly_patterns",
			description:
				"Get hour-by-hour patterns for a pair: when do spreads widen (market making windows), when does momentum hit, when does buying/selling pressure appear?",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'DEX pair (e.g., "SOLO/XRP")',
					},
					days: {
						type: "number",
						description: "Lookback period in days (default: 7)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_daily_digest",
			description:
				"Get a daily market digest. If no pair given, generates digests for ALL watched pairs. Returns OHLC prices, change %, spread, imbalance, and patterns.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'DEX pair (e.g., "SOLO/XRP"). Omit to generate for all pairs.',
					},
					date: {
						type: "string",
						description: 'Date in YYYY-MM-DD format (default: today)',
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_digest_history",
			description:
				"Get recent daily digests for a pair — shows day-over-day trends, patterns, and market shifts.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'DEX pair (e.g., "SOLO/XRP")',
					},
					limit: {
						type: "number",
						description: "Number of days to show (default: 14)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_price_history",
			description:
				"Get recent snapshot history for a pair — shows how price, spread, and depth have changed over recent observations.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'DEX pair (e.g., "SOLO/XRP")',
					},
					limit: {
						type: "number",
						description: "Number of snapshots to return (default: 30)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "xrpl_server_info",
			description:
				"Get XRPL network status: current ledger index, base transaction fee, and server state.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},

		// ── CEX Market Watching (FLR, SOL, XLM, etc.) ──
		{
			name: "cex_scan_markets",
			description:
				"Scan all watched CEX symbols (FLR, SOL, XLM, etc.) on Crypto.com. Returns price, 24h change, volume, spread, depth, imbalance, and detected opportunities (spread capture, momentum, imbalance, volatility).",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "cex_market_summary",
			description:
				"Get a summary of all watched CEX symbols: prices, 24h change, spreads, imbalances, most volatile token, best spread, and strongest directional pressure.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "cex_learned_patterns",
			description:
				"Get patterns Zaraa has learned from watching CEX markets (FLR, SOL, XLM): spread windows, momentum hours, imbalance shifts, day-of-week patterns.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'Filter by pair (e.g., "FLR/USDT", "SOL/USDT") — shows all if omitted',
					},
					min_confidence: {
						type: "number",
						description: "Minimum confidence 0-1 (default: 0.2)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "cex_hourly_patterns",
			description:
				"Get hour-by-hour patterns for a CEX symbol: when do spreads widen, when does momentum hit, when does buying/selling pressure appear?",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'Symbol pair (e.g., "FLR/USDT", "SOL/USDT", "XLM/USDT")',
					},
					days: {
						type: "number",
						description: "Lookback period in days (default: 7)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "cex_daily_digest",
			description:
				"Get a daily market digest for CEX symbols. If no pair given, generates digests for ALL watched symbols. Returns OHLC, change %, spread, imbalance, and patterns.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'Symbol pair (e.g., "FLR/USDT"). Omit to generate for all.',
					},
					date: {
						type: "string",
						description: "Date in YYYY-MM-DD format (default: today)",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "cex_price_history",
			description:
				"Get recent snapshot history for a CEX symbol — shows how price, spread, volume, and depth have changed over recent observations.",
			parameters: {
				type: "object",
				properties: {
					pair: {
						type: "string",
						description: 'Symbol pair (e.g., "SOL/USDT")',
					},
					limit: {
						type: "number",
						description: "Number of snapshots (default: 30)",
					},
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},

		// ── Multi-chain on-chain DEX (Stellar, Solana, Flare) ──
		{
			name: "dex_scan_all",
			description:
				"Scan all on-chain DEXes: Stellar native DEX, Solana (Jupiter/Raydium/Orca), Flare (SparkDEX/BlazeSwap). Returns prices, volumes, liquidity, spreads, buy/sell ratios, and detected opportunities across all chains.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dex_scan_stellar",
			description:
				"Scan the Stellar native DEX — order books for XLM/USDC, yXLM/XLM, AQUA/XLM, SHX/XLM. Returns real bid/ask depth and spread.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dex_scan_solana",
			description:
				"Scan Solana DEXes (Raydium, Orca, Jupiter) for SOL, JUP, RAY, BONK. Returns prices, volume, liquidity, and buy/sell ratios.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dex_scan_flare",
			description:
				"Scan Flare DEXes (SparkDEX, BlazeSwap) for WFLR, sFLR. Returns prices, volume, liquidity depth, and trading activity.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dex_stellar_orderbook",
			description:
				"Get the full order book for a Stellar DEX pair — real bids and asks with prices and amounts.",
			parameters: {
				type: "object",
				properties: {
					pair: { type: "string", description: 'Stellar pair (e.g., "XLM/USDC", "AQUA/XLM")' },
					depth: { type: "number", description: "Number of levels (default: 20)" },
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},
		{
			name: "dex_solana_depth",
			description:
				"Get Solana DEX pool depth for a token — shows liquidity, estimated spread, and synthetic order book from AMM reserves.",
			parameters: {
				type: "object",
				properties: {
					token: { type: "string", description: 'Token symbol (e.g., "SOL", "JUP", "RAY", "BONK")' },
				},
				required: ["token"],
			},
			requiresApproval: false,
		},
		{
			name: "dex_flare_depth",
			description:
				"Get Flare DEX pool depth for a token — shows liquidity on SparkDEX/BlazeSwap, estimated spread, and synthetic depth.",
			parameters: {
				type: "object",
				properties: {
					token: { type: "string", description: 'Token symbol (e.g., "WFLR", "sFLR")' },
				},
				required: ["token"],
			},
			requiresApproval: false,
		},
		{
			name: "dex_summary",
			description:
				"Get a summary of all on-chain DEX markets across Stellar, Solana, and Flare: prices, volumes, liquidity, and 24h changes.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dex_learned_patterns",
			description:
				"Get patterns Zaraa has learned from on-chain DEX watching across Stellar, Solana, and Flare. Filter by chain or pair.",
			parameters: {
				type: "object",
				properties: {
					pair: { type: "string", description: 'Filter by pair (e.g., "stellar:XLM/USDC", "solana:SOL/USDC")' },
					chain: { type: "string", enum: ["stellar", "solana", "flare"], description: "Filter by chain" },
					min_confidence: { type: "number", description: "Min confidence 0-1 (default: 0.2)" },
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "dex_stellar_trades",
			description:
				"Get recent trades on the Stellar DEX for a pair — shows price, amount, and side (buy/sell).",
			parameters: {
				type: "object",
				properties: {
					pair: { type: "string", description: 'Stellar pair (e.g., "XLM/USDC")' },
					limit: { type: "number", description: "Number of trades (default: 25)" },
				},
				required: ["pair"],
			},
			requiresApproval: false,
		},

		// ── Practice Paper Trading ──
		{
			name: "practice_tick",
			description:
				"Run one practice trading cycle: scan all markets (XRPL, Stellar, Solana, Flare, CEX), evaluate opportunities, open/close paper trades based on signals, update P&L. Called automatically by the scheduler every 5 minutes.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "practice_stats",
			description:
				"Get full practice trading performance: equity, return, win rate, profit factor, drawdown, breakdown by chain/strategy, and recent trade history.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "practice_positions",
			description:
				"Get all open practice paper positions with entry price, current price, P&L, stop-loss, take-profit, and age.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "practice_resume_trading",
			description:
				"Clear a HALTED state on the opportunity trader after operator review. Resets the persisted consecutive-loss counter and halt flag. Use only after you've reviewed the closed-trade history.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: true,
		},

		// ── Bellman-Ford Arbitrage ──
		{
			name: "arb_scan",
			description:
				"Run a Bellman-Ford negative-cycle scan across all chains (XRPL, Stellar, Solana, Flare, CEX). Builds a currency graph, detects profitable arbitrage loops, and emits trade signals. Shows cycle paths, profit %, estimated volume, and execution routes.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "arb_stats",
			description:
				"Get Bellman-Ford arbitrage scanning statistics: total scans, cycles found, signals emitted, best profit ever detected, and recent scan history.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},

		// ── DCA (Dollar-Cost Averaging) ──
		{
			name: "dca_configure",
			minZone: "trusted",
			description:
				"Configure Dollar-Cost Averaging: set up automatic recurring buys of crypto assets. " +
				"Specify symbol, USD amount per buy, interval (hourly/daily/weekly), and optional dip bonus " +
				"(buy extra when price drops below SMA). All amounts validated against max_trade_usd.",
			parameters: {
				type: "object",
				properties: {
					pairs: {
						type: "array",
						items: {
							type: "object",
							properties: {
								symbol: { type: "string", description: 'Trading pair (e.g., "BTC", "ETH_USDT")' },
								amountUsd: { type: "number", description: "USD amount per scheduled buy" },
								interval: { type: "string", enum: ["hourly", "daily", "weekly"], description: "Buy frequency" },
								dipBonusPct: { type: "number", description: "Optional: buy extra when price is this % below 20-period SMA (e.g., 5 = 5%)" },
								dipBonusMultiplier: { type: "number", description: "Multiplier for dip bonus amount (default: 2x)" },
								enabled: { type: "boolean", description: "Whether this pair is active (default: true)" },
							},
							required: ["symbol", "amountUsd", "interval"],
						},
						description: "Array of DCA pair configurations",
					},
				},
				required: ["pairs"],
			},
			requiresApproval: true,
		},
		{
			name: "dca_status",
			description:
				"Get DCA status for all configured pairs: average cost basis, total invested, unrealized P&L, " +
				"buy count, last buy time, and current market price.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "dca_pause",
			description:
				"Pause DCA buying for a specific symbol or all pairs. State is preserved — use dca_resume to restart.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Symbol to pause (omit to pause all)" },
				},
				required: [],
			},
			requiresApproval: true,
		},
		{
			name: "dca_resume",
			description:
				"Resume DCA buying for a specific symbol or all pairs after a pause.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Symbol to resume (omit to resume all)" },
				},
				required: [],
			},
			requiresApproval: true,
		},
		{
			name: "dca_run_cycle",
			minZone: "trusted",
			description:
				"Execute one DCA cycle: check all configured pairs and buy any that are due. " +
				"Respects max_trade_usd and daily_limit_usd. Called automatically by the scheduler.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},

		// ── Opus Grind Log ──
		{
			name: "trade_quiet_hours_risk_audit",
			description:
				"Run the quiet-hours-first risk audit: resolve local quiet window (default overnight 23:00–07:00 or notifications.quietHours). " +
				"Off-hours: portfolio enrichment + kill gate / stop breach / concentration scan only (skips BTC/ETH/SOL/XRP/DOGE benchmark tickers unless force_full_cycle). " +
				"Active hours: benchmark prices → same portfolio + breach scan. " +
				"By default (persist_log=true) writes one opus grind row via the same summary schema as trade_log_opus_grind (quietHoursRiskAudit, violations, exposureByAsset, escalationRecommended). " +
				"No trades; escalation is indicated only when violations warrant it.",
			parameters: {
				type: "object",
				properties: {
					persist_log: {
						type: "boolean",
						description:
							"If true (default), append opus_grind_log with structured JSON. Set false for a dry-run report only.",
					},
					force_full_cycle: {
						type: "boolean",
						description:
							"If true, fetch benchmark prices even during quiet hours (use sparingly).",
					},
					symbols: {
						type: "array",
						items: { type: "string" },
						description:
							"Optional override for benchmark symbols (normalized to *_USDT). Default: BTC, ETH, SOL, XRP, DOGE.",
					},
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_opus_grind_cycle_state",
			description:
				"Return quiet-hours gating for the current Opus grind cycle (local clock). " +
				"When cycleMode is lightweight (overnight/default 23:00–07:00 or configured notifications.quietHours), skip heavy steps and trades. " +
				"Call this before market scans when the prompt requires a quiet-hours check.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_log_opus_grind",
			description:
				"Log the results of an Opus grind cycle. Called at the end of each hourly Opus session to record what was found and done. " +
				"Always persists summaryJson as schemaVersion 1 with cycleMode/quietHoursActive/quietHoursWindow (server-derived) plus optional " +
				"parameterTweak, creativeAlpha, repeatFailurePattern (occurrenceCount≥2 may write procedural memory when wired). " +
				"Top-level fields: marketRegime, portfolioEquity, portfolioPnl, drawdownPct, riskViolations, tradeExecuted, alertsSet, memoriesStored, " +
				"stepsCompleted, stepsSkipped, actionsTaken, bestOpportunity, summary.",
			parameters: {
				type: "object",
				properties: {
					startedAt: { type: "string", description: "ISO timestamp when the grind started" },
					durationMs: { type: "number", description: "How long the grind took in ms" },
					marketRegime: { type: "string", description: "Detected regime: trending, ranging, volatile" },
					bestOpportunity: { type: "string", description: "Best opportunity identified this cycle" },
					portfolioEquity: { type: "number", description: "Current portfolio equity in USD" },
					portfolioPnl: { type: "number", description: "Unrealized P&L in USD" },
					drawdownPct: { type: "number", description: "Current drawdown from peak as %" },
					riskViolations: { type: "number", description: "Number of risk violations found" },
					tradeExecuted: { type: "number", description: "1 if a trade was executed, 0 otherwise" },
					alertsSet: { type: "number", description: "Number of price alerts set" },
					memoriesStored: { type: "number", description: "Number of procedural memories stored" },
					parameterTweaks: { type: "number", description: "Number of strategy parameter changes proposed" },
					stepsCompleted: { type: "number", description: "Number of grind steps completed (out of 6)" },
					stepsSkipped: { type: "number", description: "Number of steps skipped" },
					actionsTaken: { type: "number", description: "Total actions taken this cycle" },
					summary: { type: "object", description: "Free-form summary object with additional details" },
				},
				required: ["stepsCompleted"],
			},
			requiresApproval: false,
		},
		{
			name: "trade_get_opus_grinds",
			description:
				"Get recent Opus grind session logs. Shows what each hourly Opus cycle found, did, and whether it was effective. " +
				"Use to audit grind quality and identify patterns. Default: last 24 sessions (1 day).",
			parameters: {
				type: "object",
				properties: {
					limit: { type: "number", description: "Number of recent sessions to return. Default: 24." },
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Safety dashboard tools ──
		{
			name: "trade_safety_health",
			description: "Get aggregated trading system health from all safety subsystems: kill switch, circuit breakers, drawdown, daily limits, exchange health, stop scheduler. Returns overall HEALTHY/DEGRADED/CRITICAL/HALTED status plus alerts.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_flash_crash",
			description: "Check flash crash detection status for a trading symbol. Returns detected flag, drop percentage, and recommended action (flatten/widen_stops/none).",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Trading pair to check (e.g. BTC_USDT). Defaults to BTC_USDT." },
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_graduation",
			description: "Get position graduation status: current size tier, max USD allowed, and requirements to reach next tier based on trade history and win rate.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_exchange_health",
			description: "Get health status for all monitored exchanges: latency, error rate, rate limit remaining, and trading adjustments applied.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_rate_limits",
			description: "Get API rate limit status for exchanges. Shows calls per minute/10s/1s vs limits and whether throttling is active.",
			parameters: {
				type: "object",
				properties: {
					exchange: { type: "string", description: "Exchange name to check (e.g. crypto_com). If omitted, returns all known exchanges." },
				},
				required: [],
			},
			requiresApproval: false,
		},
		{
			name: "trade_rotation_status",
			description: "Get strategy rotation status: currently active strategies with allocation percentages, last rotation result, and deactivated strategies.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_shadow_status",
			description: "Get shadow mode executor status: whether shadow mode is active, total shadow trades, shadow P&L, win rate, open positions, and gate activation counts by strategy. Shadow mode runs real signals through full pre-trade validation without executing real orders.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_shadow_positions",
			description: "Get current shadow position state: count, full open-positions array, and aggregate P&L. Slimmer than trade_shadow_status — intended for out-of-process monitors polling the gateway.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "trade_slippage_status",
			description: "Get slippage breach status for a trading symbol. Returns whether slippage is breaching thresholds and what action is being applied (allow/limit_only/halt).",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Trading pair to check (e.g. BTC_USDT). Defaults to BTC_USDT." },
				},
				required: [],
			},
			requiresApproval: false,
		},

		// ── Portfolio Rebalancing ──
		{
			name: "rebalance_configure",
			minZone: "trusted",
			description:
				"Configure portfolio rebalancing: set target allocations (weights summing to 1.0), " +
				"drift threshold (only rebalance when drift exceeds this %), and max trade size per rebalance " +
				"(as % of portfolio). All rebalance trades go through normal risk validation.",
			parameters: {
				type: "object",
				properties: {
					target_allocations: {
						type: "object",
						description: 'Target weights by symbol, must sum to ~1.0. e.g. {"BTC_USDT": 0.5, "ETH_USDT": 0.3, "SOL_USDT": 0.2}',
					},
					drift_threshold_pct: {
						type: "number",
						description: "Only rebalance when total portfolio drift exceeds this % (default: 5)",
					},
					max_trade_per_rebalance_pct: {
						type: "number",
						description: "Cap each rebalance trade at this % of total portfolio (default: 10)",
					},
					enabled: {
						type: "boolean",
						description: "Enable/disable automatic rebalancing (default: true)",
					},
				},
				required: ["target_allocations"],
			},
			requiresApproval: true,
		},
		{
			name: "rebalance_status",
			description:
				"Show current vs target allocations, total drift %, and whether rebalancing is needed. " +
				"Read-only — does not execute any trades.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "rebalance_preview",
			description:
				"Compute a rebalance plan without executing: shows which trades would be needed, " +
				"amounts, and reasons. Use to review before calling rebalance_execute.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
		{
			name: "rebalance_execute",
			minZone: "trusted",
			description:
				"Compute and execute a rebalance plan: sells overweight positions first (to free capital), " +
				"then buys underweight positions. Each trade goes through normal risk validation. " +
				"Only executes if drift exceeds the configured threshold.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: true,
		},
		{
			name: "rebalance_run_cycle",
			minZone: "trusted",
			description:
				"Scheduler-friendly rebalance: checks if drift exceeds threshold and executes if needed. " +
				"Returns {skipped: true} if not configured, disabled, or drift is below threshold. " +
				"Safe for CronScheduler tool field.",
			parameters: { type: "object", properties: {}, required: [] },
			requiresApproval: false,
		},
	],
};
