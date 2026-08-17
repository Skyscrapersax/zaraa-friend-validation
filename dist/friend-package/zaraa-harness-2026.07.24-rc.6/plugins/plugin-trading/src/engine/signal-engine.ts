import type { CryptoClient } from "../crypto-client.js";
import { scrubErrorMessage } from "../util/scrub-secrets.js";
import type { CandleStore, Candle } from "../data/candle-store.js";
import type { TradingStore } from "../trading-store.js";
import type { RiskManager } from "../risk/risk-manager.js";
import type { StrategyRegistry } from "../strategies/strategy-registry.js";
import type { Signal } from "../strategies/strategy.js";
import { computeIndicators } from "../strategies/compute-indicators.js";
import { ScanCache } from "../strategies/scan-cache.js";
import type { TradeJournal, SignalRecord } from "./trade-journal.js";
import type { ReturnAttributionBucket } from "./trade-journal.js";
import { SignalEnsemble, type EnsembleConfig, type EnsembleVote, type EnsembleResult } from "./signal-ensemble.js";
import { validateEdge, type EdgeValidation } from "../backtest/edge-validator.js";
import {
	RegimeValidationPipeline,
	type RetrainingTarget,
	type RollingValidationResult,
} from "../backtest/regime-validation-pipeline.js";
import { computeDynamicQty } from "./dynamic-sizer.js";
import { getStrategyGradeMultiplier } from "./strategy-grader.js";
import { detectRegime, type RegimeAnalysis } from "../strategies/market-regime.js";
import { getCurrentSession, getSessionFitness, isHighQualityWindow, type SessionInfo, type TradingSession } from "../strategies/session-filter.js";
import { SymbolPerformanceTracker, DEFAULT_SYMBOL_TRACKER_CONFIG } from "./symbol-performance-tracker.js";
import type { StrategyAdaptor } from "./strategy-adaptor.js";
import type { TradingCircuitBreaker } from "../risk/trading-circuit-breaker.js";
import { evaluateTradingKillGate } from "../risk/trading-kill-gate.js";
import { resolvePaperMode } from "../risk/trading-mode.js";
import { isDexSolanaExecutionSymbol } from "../dex/dex-execution-symbol.js";
import type { ExecutionQualityController } from "./execution-quality-controller.js";
import type { StrategyRanker } from "./strategy-ranker.js";
import type { DynamicRiskAdjuster } from "../risk/dynamic-risk.js";
import { confirmSignalTimeframe, type TimeframeConfirmerConfig, DEFAULT_MTF_CONFIG } from "./timeframe-confirmer.js";
import type { SentimentSignalResult } from "../signals/sentiment-signal.js";
import type { FundingRateEntry } from "../signals/funding-rate-monitor.js";
import type { ShadowModeExecutor } from "./shadow-mode.js";
import { MarketContextProvider, type MarketContext } from "../strategies/market-context.js";
import { evaluatePreTradeEdge } from "../cost/pre-trade-edge.js";
import { getDefaultFeeSchedules } from "../cost/fee-schedule.js";

const MANDATORY_BACKTEST_LOOKBACK_DAYS = 180;
const MANDATORY_BACKTEST_WALK_FORWARD_DAYS = 30;
const MANDATORY_BACKTEST_MIN_SHARPE = 1.2;
const MANDATORY_BACKTEST_MAX_DRAWDOWN_FRACTION = 0.05;
const MANDATORY_BACKTEST_EXCLUDE_RECENT_CANDLES = 5;
const REJECT_INVALID_ALPHA = "REJECT_INVALID_ALPHA";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Shadow mode multiplies the configured cooldown by this factor. With a 2-minute
 * scan interval and a 5-minute base cooldown, shadow mode would otherwise stack
 * roughly 12 positions/hour per symbol — too fast to gather meaningful per-signal
 * outcome data. 3x slows accumulation to ~4/hour while still exercising signal flow.
 */
export const SHADOW_MODE_COOLDOWN_MULTIPLIER = 3;

export interface SignalEngineConfig {
	/** Minimum confidence threshold to act on a signal (default: 0.5) */
	minConfidence: number;
	/**
	 * Cooldown in ms between signals for the same symbol (default: 5min).
	 * Multiplied by SHADOW_MODE_COOLDOWN_MULTIPLIER when isShadowMode is true so
	 * shadow accumulation does not stack ~12 positions/hour at the 2-min scan interval.
	 */
	cooldownMs: number;
	/** Auto-execute in paper mode (default: true) */
	autoExecutePaper: boolean;
	/** Auto-execute in live mode (default: false — requires approval) */
	autoExecuteLive: boolean;
	/** Enable ensemble voting — aggregate signals from all strategies per symbol (default: false) */
	ensembleEnabled: boolean;
	/** Ensemble configuration (only used when ensembleEnabled is true) */
	ensemble: Partial<EnsembleConfig>;
	/** Enable pre-execution backtest gate — reject signals that fail historical validation (default: true) */
	backtestGateEnabled: boolean;
	/** Minimum win rate from backtest to allow execution (default: 0.4 = 40%) */
	backtestMinWinRate: number;
	/** Minimum number of backtest trades to consider the result valid (default: 5) */
	backtestMinTrades: number;
	/** Enable market regime detection for adaptive strategy weighting (default: true) */
	regimeDetectionEnabled: boolean;
	/** Enable session filter — suppress signals during low-quality windows (default: true) */
	sessionFilterEnabled: boolean;
	/**
	 * Minimum session fitness for a strategy to generate signals (default: 0.35).
	 * Below this threshold, the strategy is considered poorly suited to the current
	 * session and its signals are suppressed. Set to 0 to disable fitness gating
	 * while still recording session context.
	 */
	sessionMinFitness: number;
	/**
	 * Half-life for signal confidence decay in ms (default: 300000 = 5 minutes).
	 * Signals lose confidence over time: effectiveConfidence = confidence * exp(-delay/halfLife).
	 * Prevents stale signals from executing at full confidence after delays.
	 * Set to 0 to disable decay.
	 */
	confidenceDecayHalfLifeMs: number;
	/**
	 * Maximum signal age in ms before it's killed entirely (default: 600000 = 10 minutes).
	 * Signals older than this are rejected regardless of confidence.
	 * Set to 0 to disable max age.
	 */
	maxSignalAgeMs: number;
	/**
	 * Multi-timeframe confirmation settings.
	 * When enabled, signals are checked against a higher timeframe trend
	 * before execution. Disabled by default.
	 */
	mtfConfirmation: TimeframeConfirmerConfig;
	/**
	 * Enable sentiment gate — block long entries during extreme greed (default: true).
	 * Requires deps.sentimentSignal to be wired.
	 */
	sentimentGateEnabled: boolean;
	/**
	 * Enable funding rate confidence adjustment — reduce confidence when funding
	 * is very negative for longs or very positive for shorts (default: true).
	 * Requires deps.fundingRateMonitor to be wired.
	 */
	fundingRateAdjustmentEnabled: boolean;
	/**
	 * Shadow mode — bypass kill gate and circuit breaker checks so signals
	 * always reach the executeTrade callback (which routes to ShadowModeExecutor
	 * instead of real/paper execution). Default: false.
	 */
	isShadowMode: boolean;
	/**
	 * Correlation guard — maximum directional imbalance (|BUYs − SELLs|) across
	 * ALL open positions (real + shadow) before new signals in the majority
	 * direction are rejected. Catches portfolios that stack one-sided exposure
	 * across correlated assets (e.g. 22 SELLs vs 6 BUYs across SOL/ETH/XRP).
	 * Default: 5. Set to 0 to disable.
	 */
	maxDirectionalImbalance: number;
	/**
	 * Correlation guard — maximum same-direction positions per symbol. Distinct
	 * from per-asset cap (which counts total regardless of direction): this
	 * prevents stacking e.g. 5 SELLs on SOL even when the per-asset cap allows
	 * mixed-direction positions. Default: 2. Set to 0 to disable.
	 */
	maxSameDirectionPerSymbol: number;
	/**
	 * Per-session entry gates. Each session can override `minConfidence` so
	 * unfavorable sessions require a higher bar. The audit found the European
	 * session ran 40% win rate / -$0.27 P&L; default is to require 0.7+
	 * confidence to enter during European hours. Other sessions default to
	 * the engine-wide minConfidence.
	 *
	 * `enabled: false` for a session disables all entries during that window.
	 */
	sessionGates: Record<TradingSession, { minConfidence?: number; enabled?: boolean }>;
	/**
	 * Per-symbol rolling-performance gate. When a symbol's last `rollingWindow`
	 * trades have a win rate below `minWinRate`, that symbol requires a
	 * unanimous ensemble vote AND a confirmed edge tier to enter. Symbols
	 * with fewer than `minTrades` closed positions are not gated.
	 */
	symbolGate: {
		enabled: boolean;
		rollingWindow: number;
		minWinRate: number;
		minTrades: number;
	};
	/**
	 * Pre-trade net-edge gate (D1 micro): reject entries whose TP geometry cannot
	 * clear 2× round-trip fees+spread+slip. Default true — primary profitability filter.
	 */
	preTradeNetEdgeEnabled: boolean;
	/** Minimum reward:risk (TP dist / SL dist). Default 2.0. */
	preTradeMinRiskReward: number;
	/** One-way paper/live slip assumption for pre-trade cost stack, bps. Default 10. */
	preTradeSlippageBps: number;
	/** Round-trip spread assumption for pre-trade cost stack, bps. Default 10. */
	preTradeSpreadBps: number;
}

const DEFAULT_CONFIG: SignalEngineConfig = {
	// Raised from 0.5 → 0.62: low-confidence scalps were fee-negative in journal.
	minConfidence: 0.62,
	cooldownMs: 5 * 60 * 1000,
	autoExecutePaper: true,
	autoExecuteLive: false,
	ensembleEnabled: true,
	ensemble: {},
	backtestGateEnabled: true,
	// Raised from 0.4 → 0.52: 40% WR cannot clear crypto.com RT fees.
	backtestMinWinRate: 0.52,
	backtestMinTrades: 8,
	regimeDetectionEnabled: true,
	sessionFilterEnabled: true,
	sessionMinFitness: 0.35,
	confidenceDecayHalfLifeMs: 5 * 60 * 1000, // 5 minutes
	maxSignalAgeMs: 10 * 60 * 1000, // 10 minutes
	mtfConfirmation: { ...DEFAULT_MTF_CONFIG },
	sentimentGateEnabled: true,
	fundingRateAdjustmentEnabled: true,
	isShadowMode: false,
	maxDirectionalImbalance: 5,
	maxSameDirectionPerSymbol: 2,
	// Audit: European session ran 40% WR / -$0.27 P&L → raise the bar to 0.7.
	// Asian/US/off_hours fall back to the engine-wide minConfidence.
	preTradeNetEdgeEnabled: true,
	preTradeMinRiskReward: 2.0,
	preTradeSlippageBps: 10,
	preTradeSpreadBps: 10,
	sessionGates: {
		asian: {},
		european: { minConfidence: 0.75 },
		us: {},
		off_hours: {},
	},
	symbolGate: {
		enabled: true,
		rollingWindow: DEFAULT_SYMBOL_TRACKER_CONFIG.rollingWindow,
		minWinRate: DEFAULT_SYMBOL_TRACKER_CONFIG.minWinRate,
		minTrades: DEFAULT_SYMBOL_TRACKER_CONFIG.minTrades,
	},
};

export interface SignalEngineDeps {
	client: CryptoClient;
	candleStore: CandleStore;
	store: TradingStore;
	riskManager: RiskManager;
	strategyRegistry: StrategyRegistry;
	journal: TradeJournal;
	/** Called when a signal is generated. The optional `reason` is populated for "rejected" action so consumers can surface gate diagnostics. */
	onSignal?: (signal: Signal, strategyName: string, action: "execute" | "pending" | "rejected", reason?: string) => void;
	/** Called to execute a trade — bridges to the trade_buy/trade_sell handler */
	executeTrade?: (params: {
		symbol: string;
		direction: "long" | "short";
		qty: number;
		stopLoss: number;
		takeProfit: number;
		trailingStopPct?: number;
		strategyName: string;
		signalId: string;
		/** Signal entry price — used by shadow mode executor to log the simulated fill price. */
		entryPrice?: number;
		/** Signal confidence at time of execution — used by shadow mode for logging. */
		confidence?: number;
	}) => Promise<void>;
	/** Market learner for pattern-based confidence modulation (structural type to avoid circular deps) */
	learner?: {
		getPatterns: (pair?: string, minConfidence?: number) => Array<{
			pair: string; type: string; confidence: number;
			hourOfDay: number | null; details: Record<string, unknown>;
			description: string; occurrences: number;
		}>;
	};
	/** When set, combined with store settings for pre-scan kill / loss-cap / venue halt gates. */
	circuitBreaker?: TradingCircuitBreaker | null;
	/** Rolling execution feedback loop used to scale Kelly sizing and routing defaults. */
	executionQualityController?: ExecutionQualityController;
	/** Strategy ranker — applies promotion/demotion weights to signal sizing. */
	strategyRanker?: StrategyRanker | null;
	/** Dynamic risk adjuster — modifies position size and stop-loss based on recent performance. */
	dynamicRiskAdjuster?: DynamicRiskAdjuster | null;
	/** Sentiment signal — gates long entries during extreme greed. */
	sentimentSignal?: { checkLongEntry: () => Promise<SentimentSignalResult> };
	/** Funding rate monitor — adjusts confidence based on funding rate conditions. */
	fundingRateMonitor?: { analyzeFundingRate: (symbol: string, exchange: string, rate: number, timestampMs?: number) => FundingRateEntry; getStats: (symbol: string, exchange: string) => { annualizedPct: number } | null };
	/** Shadow executor — when provided, receives price ticks each scan so open shadow positions are evaluated for SL/TP exits. */
	shadowModeExecutor?: ShadowModeExecutor;
	/**
	 * Market context provider — when set, supplies learned-pattern context
	 * to `strategy.evaluate()` so strategies can react to regime/volatility
	 * (e.g. mean-reversion skipping signals in trending markets).
	 * Wired through `learner` automatically when not provided directly.
	 */
	marketContextProvider?: MarketContextProvider;
}

/**
 * Structured reason a signal was dropped before execution. Surfaced via
 * `getRecentRejections()` and `trade_risk_status.recentRejections[]` so the
 * operator can answer "why didn't trade X enter" without grepping logs.
 */
export interface SignalRejection {
	/** When the rejection happened */
	ts: number;
	/** Symbol the rejection applied to (or "(all)" for scan-level gates) */
	symbol: string;
	/** Strategy or "ensemble:<symbol>" / "(scan)" / "(ensemble)" for aggregate gates */
	strategyName: string;
	/** Coarse gate name — useful for grouping ("cooldown", "session", "candles", "minConfidence", "sizer", "risk", "backtest", "lifecycle", "duplicate", "perAsset", "perSymbolDirection", "correlation", "decay", "age", "qty", "killGate", "ensembleConsensus") */
	gate: string;
	/** Human-readable reason with parameters (e.g. "fitness=0.21 < 0.35") */
	reason: string;
	/** Optional signal direction if a Signal was already generated */
	direction?: "long" | "short";
	/** Optional confidence at rejection time */
	confidence?: number;
}

interface MandatoryBacktestOutcome {
	verdict: "VALIDATED" | typeof REJECT_INVALID_ALPHA;
	reason: string;
	metrics?: {
		trades?: number;
		sharpeRatio?: number;
		maxDrawdownPct?: number;
		rollingSharpeRatio?: number;
		fourteenDayDrawdownPct?: number;
		lookbackCandles: number;
		walkForwardCandles: number;
	};
}

export class SignalEngine {
	private config: SignalEngineConfig;
	private deps: SignalEngineDeps;
	private lastSignalTime = new Map<string, number>(); // symbol → timestamp
	/** Symbols currently being evaluated — prevents race conditions */
	private evaluating = new Set<string>();
	private ensemble: SignalEnsemble;
	/** Last ensemble results — for dashboard/debugging */
	private lastEnsembleResults = new Map<string, EnsembleResult>();
	/** Last regime analysis per symbol — for dashboard/debugging */
	private lastRegimeAnalysis = new Map<string, RegimeAnalysis>();
	/** Last session info — for dashboard/debugging */
	private lastSessionInfo: SessionInfo | null = null;
	/** Optional adaptive strategy weighting from Phase 2 swarm feedback loop */
	private strategyAdaptor: StrategyAdaptor | null = null;
	/** Diagnostics from the last scan — why each strategy/symbol produced nothing */
	private lastScanDiagnostics: Array<{ strategy: string; symbol: string; reason: string }> = [];
	/**
	 * Rolling buffer of recent rejections across all scans. Capped at
	 * MAX_RECENT_REJECTIONS so it never grows unbounded. Surfaced via
	 * `getRecentRejections()` and `trade_risk_status.recentRejections[]`.
	 * Persisted across scans (unlike lastScanDiagnostics, which resets per scan).
	 */
	private recentRejections: SignalRejection[] = [];
	private static readonly MAX_RECENT_REJECTIONS = 50;
	/** Edge validation cache: strategyName → { result, timestamp }. Revalidated every hour. */
	private edgeCache = new Map<string, { result: EdgeValidation; timestamp: number }>();
	/** Rolling walk-forward validation cache keyed by strategy+symbol. */
	private validationCache = new Map<string, { result: RollingValidationResult; timestamp: number }>();
	/** Targeted retraining hints from walk-forward validation. */
	private retrainingTargets = new Map<string, RetrainingTarget[]>();
	/** Realized 30d return attribution from closed trades. */
	private attributionCache = new Map<string, { result: ReturnAttributionBucket[]; timestamp: number }>();
	private static readonly EDGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
	private static readonly VALIDATION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
	private static readonly ATTRIBUTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	private marketContextProvider: MarketContextProvider | null = null;
	/** Rolling per-symbol performance tracker — drives the symbol gate. */
	private symbolPerf: SymbolPerformanceTracker;
	/**
	 * Request-scoped memoizer: caches candleStore.getAscending + computeIndicators
	 * results keyed by (symbol|timeframe|limit) within a single scan cycle.
	 * Cleared at the start of each scanEnsemble so stale candles never persist
	 * across scan cycles. Eliminates N+1 identical reads/computes when multiple
	 * strategies share the same (symbol, timeframe) in ensemble mode.
	 */
	private scanCache: ScanCache;
	/**
	 * Per-scan memo of getStrategyGradeMultiplier(...) keyed by strategyName ONLY.
	 * The underlying grader query ignores the symbol arg (it reads the AGG_SYMBOL
	 * lifecycle rollup) and strategy_lifecycle is never written during a scan, so
	 * the result is invariant per strategy within a single scan cycle. Cleared at
	 * the top of scan() so both the ensemble and single-strategy paths start fresh.
	 * Dedupes the repeated indexed SELECT for the winning strategy (vote callback
	 * + sizing) and across symbols that share strategies in the same scan.
	 */
	private gradeMemo = new Map<string, number>();

	constructor(deps: SignalEngineDeps, config: Partial<SignalEngineConfig> = {}) {
		this.deps = deps;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.ensemble = new SignalEnsemble(this.config.ensemble);
		// Prefer an explicitly-supplied provider; otherwise auto-construct
		// one from the learner so existing wiring keeps working.
		if (deps.marketContextProvider) {
			this.marketContextProvider = deps.marketContextProvider;
		} else if (deps.learner) {
			this.marketContextProvider = new MarketContextProvider(deps.learner);
		}
		this.symbolPerf = new SymbolPerformanceTracker(this.deps.store, {
			rollingWindow: this.config.symbolGate.rollingWindow,
			minWinRate: this.config.symbolGate.minWinRate,
			minTrades: this.config.symbolGate.minTrades,
		});
		this.scanCache = new ScanCache(
			(symbol, timeframe, limit) => this.deps.candleStore.getAscending(symbol, timeframe, limit),
			(candles) => computeIndicators(candles),
		);
	}

	/**
	 * Resolve market context for a symbol. Returns null when no provider is
	 * wired or the source has no patterns for this pair — strategies must
	 * treat absence of context as "no opinion" and run their full default logic.
	 */
	private getMarketContext(symbol: string): MarketContext | null {
		if (!this.marketContextProvider) return null;
		try {
			return this.marketContextProvider.getContext(symbol);
		} catch {
			return null;
		}
	}

	/** Exposed for diagnostics and tests. */
	getSymbolPerformanceTracker(): SymbolPerformanceTracker {
		return this.symbolPerf;
	}

	/**
	 * Effective cooldown in ms — base cooldown, multiplied for shadow mode so
	 * shadow accumulation doesn't outpace the 2-min scan interval.
	 */
	private effectiveCooldownMs(): number {
		return this.config.isShadowMode
			? this.config.cooldownMs * SHADOW_MODE_COOLDOWN_MULTIPLIER
			: this.config.cooldownMs;
	}

	/** Attach a StrategyAdaptor for Phase 2 adaptive weighting. Call after construction. */
	setStrategyAdaptor(adaptor: StrategyAdaptor): void {
		this.strategyAdaptor = adaptor;
	}

	/**
	 * Wire the real-time feedback loop: when a trade closes, update the
	 * strategy's global weight and per-regime weight immediately.
	 */
	wireTradeCloseFeedback(journal: TradeJournal, adaptor: StrategyAdaptor): void {
		journal.onTradeClose = (record) => {
			const isWin = (record.pnl ?? 0) > 0;
			// Global weight nudge (existing method)
			adaptor.updateFromTrade(record.strategyName, record.pnl ?? 0, isWin);
			// Per-regime weight nudge
			if (record.regime) {
				const current = adaptor.getRegimeWeight(record.strategyName, record.regime);
				const nudge = isWin ? 0.05 : -0.05;
				adaptor.updateRegimeWeight(record.strategyName, record.regime, {
					weight: current + nudge,
					tradeCount: adaptor.getTradeCount(record.strategyName),
					winRate: isWin ? 1 : 0,
					avgPnl: record.pnl ?? 0,
				});
			}
		};
	}

	/**
	 * Per-scan memoized strategy grade multiplier. getStrategyGradeMultiplier
	 * ignores the symbol arg (reads the AGG_SYMBOL rollup), so we key on
	 * strategyName only. Returns identical values to the direct call within a
	 * scan; the memo is reset at the top of scan().
	 */
	private gradeMultiplierMemo(strategyName: string): number {
		const cached = this.gradeMemo.get(strategyName);
		if (cached !== undefined) return cached;
		const value = getStrategyGradeMultiplier(this.deps.store, strategyName, "");
		this.gradeMemo.set(strategyName, value);
		return value;
	}

	private strategyGradeScale(strategyName: string, symbol: string, regime?: string): number {
		const gradeMultiplier = this.gradeMultiplierMemo(strategyName);
		const regimeWeight = regime && this.strategyAdaptor
			? this.strategyAdaptor.getRegimeWeight(strategyName, regime)
			: 1.0;
		const rankerWeight = this.deps.strategyRanker
			? (this.deps.strategyRanker.getRecommendedWeights()[strategyName] ?? 1.0)
			: 1.0;
		return gradeMultiplier * regimeWeight * rankerWeight;
	}

	/** Get the strategy adaptor (for dashboard/debugging). */
	getStrategyAdaptor(): StrategyAdaptor | null {
		return this.strategyAdaptor;
	}

	/**
	 * Tally open positions (real + shadow) by direction, both globally and
	 * per-symbol. Used by the correlation guard to catch one-sided portfolios.
	 * Real positions use side: "long"|"short"; shadow positions use "BUY"|"SELL".
	 * Both are normalized to BUY/SELL here so callers don't have to.
	 */
	private tallyPositionsByDirection(): {
		buys: number;
		sells: number;
		bySymbol: Map<string, { buys: number; sells: number }>;
	} {
		const bySymbol = new Map<string, { buys: number; sells: number }>();
		let buys = 0;
		let sells = 0;
		const bump = (symbol: string, dir: "BUY" | "SELL") => {
			if (dir === "BUY") buys++;
			else sells++;
			const entry = bySymbol.get(symbol) ?? { buys: 0, sells: 0 };
			if (dir === "BUY") entry.buys++;
			else entry.sells++;
			bySymbol.set(symbol, entry);
		};
		for (const p of this.deps.store.getOpenPositions()) {
			bump(p.symbol, p.side === "long" ? "BUY" : "SELL");
		}
		const shadowPositions = this.deps.shadowModeExecutor?.getOpenPositions() ?? [];
		for (const p of shadowPositions) {
			bump(p.symbol, p.side);
		}
		return { buys, sells, bySymbol };
	}

	/**
	 * Correlation guard: reject new entries that would deepen one-sided
	 * exposure across the portfolio, or stack the same direction on a single
	 * symbol. Returns { allowed: true } when the signal may proceed.
	 *
	 * Two checks:
	 *   1. Per-symbol direction cap (maxSameDirectionPerSymbol) — counts open
	 *      positions on `symbol` already in the same direction as the signal.
	 *   2. Cross-symbol directional imbalance (maxDirectionalImbalance) —
	 *      compares total BUYs vs SELLs across ALL symbols; rejects only when
	 *      the new signal would push the majority direction further out.
	 */
	private checkCorrelationGuard(
		symbol: string,
		signalDirection: "long" | "short",
	): { allowed: true } | { allowed: false; gate: string; reason: string } {
		const signalDir: "BUY" | "SELL" = signalDirection === "long" ? "BUY" : "SELL";
		const tally = this.tallyPositionsByDirection();

		const perSymbolCap = this.config.maxSameDirectionPerSymbol;
		if (perSymbolCap > 0) {
			const symbolCounts = tally.bySymbol.get(symbol) ?? { buys: 0, sells: 0 };
			const sameDirOnSymbol = signalDir === "BUY" ? symbolCounts.buys : symbolCounts.sells;
			if (sameDirOnSymbol >= perSymbolCap) {
				return {
					allowed: false,
					gate: "perSymbolDirection",
					reason: `${sameDirOnSymbol} ${signalDir} positions on ${symbol} >= max ${perSymbolCap}`,
				};
			}
		}

		const imbalanceCap = this.config.maxDirectionalImbalance;
		if (imbalanceCap > 0) {
			const imbalance = Math.abs(tally.buys - tally.sells);
			const majority: "BUY" | "SELL" | null =
				tally.buys === tally.sells ? null : tally.buys > tally.sells ? "BUY" : "SELL";
			if (imbalance >= imbalanceCap && signalDir === majority) {
				return {
					allowed: false,
					gate: "correlation",
					reason: `${tally.sells} SELL vs ${tally.buys} BUY — rejecting new ${signalDir} signal`,
				};
			}
		}

		return { allowed: true };
	}

	/**
	 * Scan all active strategies against current market data.
	 * Called on each scheduler tick.
	 *
	 * When ensemble mode is enabled, all strategies evaluate each symbol
	 * independently, then signals are aggregated via consensus voting.
	 * Only consensus signals proceed to risk validation and execution.
	 */
	async scan(): Promise<SignalRecord[]> {
		this.lastScanDiagnostics = [];
		// Reset the per-scan grade-multiplier memo so both the ensemble and
		// single-strategy paths read fresh lifecycle values each scan cycle.
		this.gradeMemo.clear();
		const isPaper = resolvePaperMode(this.deps.store);
		const killGate = evaluateTradingKillGate({
			store: this.deps.store,
			circuitBreaker: this.deps.circuitBreaker,
			isPaperMode: isPaper,
		});
		if (!this.config.isShadowMode && !killGate.allowed) {
			this.recordRejection({
				signal: null,
				strategyName: "(gates)",
				symbol: "(all)",
				gate: "killGate",
				reason: killGate.reason ?? "New entries blocked by trading kill gate",
			});
			return this.logScanSummary([]);
		}

		const activeStrategies = this.deps.strategyRegistry.getActive();
		if (activeStrategies.length === 0) {
			this.lastScanDiagnostics.push({ strategy: "(none)", symbol: "(none)", reason: "No active strategies registered" });
			return this.logScanSummary([]);
		}

		if (this.config.ensembleEnabled && activeStrategies.length > 1) {
			const ensembleResults = await this.scanEnsemble(activeStrategies);
			return this.logScanSummary(ensembleResults);
		}

		// Original single-strategy mode
		const results: SignalRecord[] = [];
		for (const active of activeStrategies) {
			const { strategy, symbols } = active;
			for (const symbol of symbols) {
				try {
					const record = await this.evaluateSymbol(strategy.name, symbol, strategy.timeframe);
					if (record) {
						results.push(record);
					}
					// Specific rejection reasons are now logged inside evaluateSymbol/doEvaluateSymbol
				} catch (err) {
					this.lastScanDiagnostics.push({ strategy: strategy.name, symbol, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
		}
		return this.logScanSummary(results);
	}

	/**
	 * Print a one-line summary of the scan outcome to the daemon log so
	 * operators can see why no signals were generated without having to hit
	 * the API for diagnostics. The previous flow stored rejection reasons in
	 * `lastScanDiagnostics` but never logged them — silent zero-signal scans
	 * looked indistinguishable from "all good" in `~/.zaraa/logs/daemon.log`,
	 * which masked a 44-hour signal halt observed on 2026-05-15→17.
	 */
	private logScanSummary(results: SignalRecord[]): SignalRecord[] {
		if (results.length > 0) {
			console.info(`[signal-engine] scan produced ${results.length} signal(s)`);
			return results;
		}
		const diags = this.lastScanDiagnostics;
		if (diags.length === 0) {
			console.info("[signal-engine] scan produced 0 signals (no diagnostics recorded)");
			return results;
		}
		const reasonCounts = new Map<string, number>();
		for (const d of diags) {
			const key = d.reason.split(/[:(]/)[0].trim() || d.reason;
			reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
		}
		const top = [...reasonCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([reason, count]) => `${reason}×${count}`)
			.join(", ");
		console.info(`[signal-engine] scan produced 0 signals; rejections=${diags.length} top=[${top}]`);
		return results;
	}

	/**
	 * Ensemble scan: collect signals from all strategies per symbol,
	 * then vote and only execute consensus signals.
	 */
	private async scanEnsemble(
		activeStrategies: ReturnType<StrategyRegistry["getActive"]>,
	): Promise<SignalRecord[]> {
		// Clear scan-scoped cache so each cycle reads fresh candles and recomputes
		// indicators. Must be the first operation so the stale-candle guard is
		// unconditional regardless of early-return paths below.
		this.scanCache.clear();

		// Build a map of symbol → strategies that watch it
		const symbolStrategies = new Map<string, Array<{ name: string; timeframe: string }>>();
		for (const active of activeStrategies) {
			for (const symbol of active.symbols) {
				if (!symbolStrategies.has(symbol)) symbolStrategies.set(symbol, []);
				symbolStrategies.get(symbol)!.push({
					name: active.strategy.name,
					timeframe: active.strategy.timeframe,
				});
			}
		}

		const results: SignalRecord[] = [];

		// Session filter applies to entire ensemble scan, not per-strategy.
		// If the overall window quality is poor, suppress all entries.
		const sessionInfo = getCurrentSession();
		this.lastSessionInfo = sessionInfo;

		if (this.config.sessionFilterEnabled && !isHighQualityWindow(sessionInfo)) {
			// Allow individual strategies through only if they have high session fitness
			// (handled per-strategy below). But skip the entire scan in deep off-hours.
			const anyFit = Array.from(symbolStrategies.values())
				.flat()
				.some((s) => getSessionFitness(s.name, sessionInfo) >= 0.5);
			if (!anyFit) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol: "(all)", reason: `Session filter: low-quality window (${sessionInfo.session}), no strategies have fitness >= 0.5` });
				return results;
			}
		}

		for (const [symbol, strategies] of symbolStrategies) {
			// Tick shadow executor with the latest known price so open shadow positions
			// are evaluated against their SL/TP on every scan cycle.
			if (this.deps.shadowModeExecutor) {
				const latestCandles = this.deps.candleStore.getAscending(symbol, strategies[0].timeframe, 1);
				if (latestCandles.length > 0) {
					this.deps.shadowModeExecutor.updatePrice(symbol, latestCandles[0].close);
				}
			}

			// Re-evaluate the kill gate mid-scan: the circuit breaker may have tripped
			// after an earlier symbol's trade was executed in the same scan cycle.
			// Without this check, remaining symbols continue evaluating and generate
			// signals that are immediately rejected, producing retry-loop noise.
			if (!this.config.isShadowMode && this.deps.circuitBreaker?.getStatus().halted) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol, reason: "Circuit breaker halted mid-scan — remaining symbols skipped" });
				break;
			}

			// Skip if already in a position. Shadow positions count: in shadow
			// mode the real positions table stays empty, so without this the
			// same symbol would generate unlimited duplicate signals per scan.
			const openPositions = this.deps.store.getOpenPositions();
			const realCount = openPositions.filter((p) => p.symbol === symbol).length;
			const shadowCount = this.deps.shadowModeExecutor
				? this.deps.shadowModeExecutor.getOpenPositions().filter((p) => p.symbol === symbol).length
				: 0;
			if (realCount + shadowCount > 0) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol, reason: `Already in a position for this symbol (real:${realCount} shadow:${shadowCount})` });
				continue;
			}

			// Check cooldown for ensemble (keyed by symbol, not strategy:symbol)
			const ensembleCooldownKey = `ensemble:${symbol}`;
			const lastTime = this.lastSignalTime.get(ensembleCooldownKey);
			const cooldownMs = this.effectiveCooldownMs();
			if (lastTime && Date.now() - lastTime < cooldownMs) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol, reason: `Cooldown active (${Math.round((Date.now() - lastTime) / 1000)}s of ${Math.round(cooldownMs / 1000)}s)` });
				continue;
			}

			// Session filter: remove strategies that are poorly suited to the current session
			const filteredStrategies = this.config.sessionFilterEnabled
				? strategies.filter((s) => getSessionFitness(s.name, sessionInfo) >= this.config.sessionMinFitness)
				: strategies;
			if (filteredStrategies.length === 0) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol, reason: `All strategies filtered by session fitness < ${this.config.sessionMinFitness}` });
				continue;
			}

			// Collect signals from filtered strategies in parallel — each strategy
			// evaluates independently against its own candle slice.  Sequential
			// awaiting was the single largest source of avoidable per-scan latency
			// (N × candle-fetch + compute time before the first vote was cast).
			const voteSettled = await Promise.allSettled(
				filteredStrategies.map(({ name, timeframe }) =>
					this.evaluateSignalOnly(name, symbol, timeframe).then(
						(signal) => ({ name, signal }),
					),
				),
			);
			const votes: EnsembleVote[] = [];
			for (let i = 0; i < voteSettled.length; i++) {
				const outcome = voteSettled[i];
				if (outcome.status === "rejected") {
					const { name } = filteredStrategies[i];
					this.lastScanDiagnostics.push({ strategy: name, symbol, reason: `Error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}` });
					continue;
				}
				const { name, signal } = outcome.value;
				if (signal) {
					votes.push({ strategyName: name, signal });
				} else {
					this.lastScanDiagnostics.push({ strategy: name, symbol, reason: "No signal (insufficient candles, below minConfidence, or strategy returned null)" });
				}
			}

			if (votes.length === 0) {
				this.lastScanDiagnostics.push({ strategy: "(ensemble)", symbol, reason: "No votes collected from any strategy" });
				continue;
			}

			// Detect market regime for this symbol (if enabled).
			// Reuses candles + indicators already in scanCache (same key as evaluateSignalOnly
			// uses for strategies[0].timeframe) — no extra store read or indicator compute.
			let regimeAnalysis: RegimeAnalysis | undefined;
			if (this.config.regimeDetectionEnabled) {
			try {
				// Use the first strategy's timeframe for regime detection candles
				const regimeTimeframe = strategies[0].timeframe;
				const regimeCandles = this.scanCache.getCandles(symbol, regimeTimeframe, 200);
				if (regimeCandles.length >= 30) {
					const indicators = this.scanCache.getIndicators(symbol, regimeTimeframe, 200, regimeCandles);
					regimeAnalysis = detectRegime(indicators);
						this.lastRegimeAnalysis.set(symbol, regimeAnalysis);
					}
				} catch (err) {
					console.debug("[signal-engine] regime detection failed:", err instanceof Error ? err.message : err);
				}
			}

			for (const vote of votes) {
				this.applyRetrainingFeedback(
					vote.strategyName,
					symbol,
					regimeAnalysis?.regime,
					sessionInfo.session,
					vote.signal,
				);
			}

			// Vote — regime weights modulate strategy confidence, and each strategy's
			// allocation multiplier (the grader's quartile grade) additionally downweights
			// measured-weak strategies so they lose influence over consensus direction and
			// confidence. Pass ONLY the allocation multiplier here: regime suitability is
			// already applied inside vote() via applyRegimeWeight, and the learned-regime /
			// ranker weights stay in strategyGradeScale at sizing time (no double-count).
			const result = this.ensemble.vote(votes, regimeAnalysis, (name) =>
				this.gradeMultiplierMemo(name),
			);
			this.lastEnsembleResults.set(symbol, result);

			if (!result.signal) {
				this.recordRejection({
					signal: votes[0]?.signal ?? null,
					strategyName: `ensemble:${symbol}`,
					symbol,
					gate: "ensembleConsensus",
					reason: `no consensus (${votes.length} votes from ${votes.map(v => v.strategyName).join(", ")})`,
				});
				continue;
			}

			// Consensus reached — proceed with risk validation and execution
			this.lastSignalTime.set(ensembleCooldownKey, Date.now());
			const record = await this.executeConsensusSignal(result.signal, symbol, result, sessionInfo);
			if (record) results.push(record);
		}

		return results;
	}

	/**
	 * Evaluate a strategy on a symbol and return just the raw Signal (no execution, no journaling).
	 * Used by ensemble mode to collect votes before consensus.
	 */
	private async evaluateSignalOnly(
		strategyName: string,
		symbol: string,
		timeframe: string,
	): Promise<Signal | null> {
		const strategy = this.deps.strategyRegistry.get(strategyName);
		if (!strategy) return null;

		// Get candles via scan cache — avoids redundant SQLite reads when multiple
		// strategies share the same (symbol, timeframe) in ensemble mode.
		let sorted = this.scanCache.getCandles(symbol, timeframe, 200);
		if (sorted.length < strategy.minCandles) {
			const raw = await this.deps.client.getCandles(symbol, timeframe);
			if (raw.length > 0) {
				const mapped: Candle[] = raw.map((c) => ({
					symbol, timeframe,
					openTime: c.openTime, open: c.open, high: c.high,
					low: c.low, close: c.close, volume: c.volume,
				}));
				this.deps.candleStore.upsert(mapped);
				// Invalidate cache entry and re-fetch after upsert so fresh candles
				// are stored and subsequent strategies see them too.
				this.scanCache.clear();
				sorted = this.scanCache.getCandles(symbol, timeframe, 200);
			}
		}

		if (sorted.length < strategy.minCandles) return null;

		// Indicators computed once per (symbol, timeframe, limit) per scan cycle.
		const indicators = this.scanCache.getIndicators(symbol, timeframe, 200, sorted);
		const evalStartMs = Date.now();
		const marketContext = this.getMarketContext(symbol);
		const signal = strategy.evaluate(sorted, indicators, marketContext);

		const effectiveMinConf = this.config.isShadowMode
			? this.config.minConfidence * 0.7
			: this.config.minConfidence;
		if (!signal || signal.confidence < effectiveMinConf) return null;

		// Stamp birth time at the earliest point after evaluation.
		// The signal's own timestamp (set by the strategy) may be the last candle
		// close time — overwrite it with wall-clock now so confidence decay
		// measures actual queuing delay rather than candle age.
		signal.timestamp = evalStartMs;

		// Apply adaptive weight in ensemble mode too (before passing to ensemble voter)
		if (this.strategyAdaptor) {
			const adaptiveWeight = this.strategyAdaptor.getStrategyWeight(strategyName);
			if (adaptiveWeight !== 1.0) {
				signal.confidence = Math.min(signal.confidence * adaptiveWeight, 0.95);
			}
		}

		return signal;
	}

	/**
	 * Execute a consensus signal through risk validation and trade execution.
	 */
	private async executeConsensusSignal(
		signal: Signal,
		symbol: string,
		ensembleResult: EnsembleResult,
		sessionInfo?: SessionInfo,
	): Promise<SignalRecord | null> {
		// Hoisted to the top of the method so rejection-bookkeeping (recordRejection)
		// can attribute every silent-return path to the ensemble descriptor uniformly.
		const ensembleStrategyName = `ensemble(${ensembleResult.agreeing.join("+")})`;
		// Single position read covers both the duplicate-position guard and the
		// downstream risk validation — eliminates two redundant store reads that
		// previously happened with no async gap between them.
		const currentPositions = this.deps.store.getOpenPositions();
		if (currentPositions.some((p) => p.symbol === symbol)) {
			this.recordRejection({
				signal,
				strategyName: ensembleStrategyName,
				symbol,
				gate: "duplicate",
				reason: "Already in position for this symbol",
			});
			return null;
		}

		// Signal confidence decay: stale signals lose confidence over time.
		// Prevents delayed execution at full confidence after queue/retry delays.
		if (signal.timestamp) {
			const signalAge = Date.now() - signal.timestamp;
			if (this.config.maxSignalAgeMs > 0 && signalAge > this.config.maxSignalAgeMs) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "age",
					reason: `signal age ${signalAge}ms > maxSignalAgeMs ${this.config.maxSignalAgeMs}`,
				});
				return null;
			}
			if (this.config.confidenceDecayHalfLifeMs > 0 && signalAge > 0) {
				const decayFactor = Math.exp(-signalAge * Math.LN2 / this.config.confidenceDecayHalfLifeMs);
				signal.confidence *= decayFactor;
				if (signal.confidence < this.config.minConfidence) {
					this.recordRejection({
						signal,
						strategyName: ensembleStrategyName,
						symbol,
						gate: "decay",
						reason: `decayed confidence ${signal.confidence.toFixed(3)} < ${this.config.minConfidence} after ${signalAge}ms`,
					});
					return null;
				}
			}
		}

		// Session gate — audit-driven per-session minimum confidence.
		// European session ran 40% WR / -$0.27 P&L; default raises the bar
		// to 0.7. Disabled sessions block entry entirely.
		if (sessionInfo) {
			const gate = this.config.sessionGates[sessionInfo.session];
			if (gate?.enabled === false) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "sessionGate",
					reason: `session ${sessionInfo.session} disabled by sessionGates`,
				});
				return null;
			}
			const sessionMin = gate?.minConfidence;
			if (sessionMin != null && signal.confidence < sessionMin) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "sessionGate",
					reason: `confidence ${signal.confidence.toFixed(3)} < session ${sessionInfo.session} threshold ${sessionMin}`,
				});
				return null;
			}
		}

		// Symbol gate — persistent losers require unanimous + confirmed edge.
		// The audit found ETH at 35% WR / -$0.26 vs SOL at +$1.12; this gate
		// naturally restricts entries on persistent losers without blocking
		// winners. Symbols with too few closed trades are not gated.
		if (this.config.symbolGate.enabled) {
			const stats = this.symbolPerf.getStats(symbol);
			const requiresStrict = this.symbolPerf.requiresStrictGating(symbol);
			if (requiresStrict) {
				const isUnanimous =
					ensembleResult.votes.length > 0 &&
					ensembleResult.agreeing.length === ensembleResult.votes.length;
				const edgeCacheEntry = this.edgeCache.get(ensembleResult.agreeing[0]);
				const isConfirmedEdge = edgeCacheEntry?.result?.verdict === "confirmed";
				if (!isUnanimous || !isConfirmedEdge) {
					this.recordRejection({
						signal,
						strategyName: ensembleStrategyName,
						symbol,
						gate: "symbolGate",
						reason: `symbol ${symbol} winRate ${(stats.winRate * 100).toFixed(0)}% over ${stats.trades} trades — requires unanimous (got ${ensembleResult.agreeing.length}/${ensembleResult.votes.length}) + confirmed edge (got ${edgeCacheEntry?.result?.verdict ?? "none"})`,
					});
					return null;
				}
			}
		}

		// Multi-timeframe confirmation gate (ensemble path).
		// When enabled, reject signals whose direction disagrees with the higher TF trend.
		if (this.config.mtfConfirmation.enabled) {
			const bestStratObj = this.deps.strategyRegistry.get(ensembleResult.agreeing[0]);
			const signalTf = bestStratObj?.timeframe ?? "15m";
			const mtfResult = confirmSignalTimeframe(
				signal.direction,
				symbol,
				signalTf,
				this.deps.candleStore,
				this.config.mtfConfirmation,
			);
			if (!mtfResult.confirmed) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "mtfConfirmation",
					reason: `higher timeframe disagreement: ${mtfResult.reason}`,
				});
				return null;
			}
			if (mtfResult.higherTfTrend !== "neutral") {
				signal.reason += ` [MTF: ${mtfResult.higherTfTimeframe} ${mtfResult.higherTfTrend} conf=${mtfResult.confidence.toFixed(2)}]`;
			}
		}

		// Sentiment gate: block long entries during extreme greed.
		if (
			this.config.sentimentGateEnabled &&
			this.deps.sentimentSignal &&
			signal.direction === "long"
		) {
			const sentimentResult = await this.deps.sentimentSignal.checkLongEntry();
			if (!sentimentResult.allowed) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "sentiment",
					reason: sentimentResult.reason,
				});
				return null;
			}
		}

		// Funding rate adjustment: reduce confidence when funding rate is adverse.
		if (this.config.fundingRateAdjustmentEnabled && this.deps.fundingRateMonitor) {
			const exchange = this.deps.store.getSetting("default_exchange") || "binance";
			const stats = this.deps.fundingRateMonitor.getStats(symbol, exchange);
			if (stats) {
				// For longs: very negative annualized funding (< -20%) means shorts are
				// paying a premium — the crowd is bearish, reduce long confidence.
				// For shorts: very positive annualized funding (> +20%) means longs are
				// paying a premium — the crowd is bullish, reduce short confidence.
				const adverseFunding =
					(signal.direction === "long" && stats.annualizedPct < -20) ||
					(signal.direction === "short" && stats.annualizedPct > 20);
				if (adverseFunding) {
					signal.confidence *= 0.8;
					signal.reason += ` [funding-adj: annualized=${stats.annualizedPct.toFixed(1)}%, conf*=0.8]`;
					if (signal.confidence < this.config.minConfidence) {
						this.recordRejection({
							signal,
							strategyName: ensembleStrategyName,
							symbol,
							gate: "fundingRate",
							reason: `confidence ${signal.confidence.toFixed(3)} < ${this.config.minConfidence} after funding rate adjustment (annualized=${stats.annualizedPct.toFixed(1)}%)`,
						});
						return null;
					}
				}
			}
		}

		// Use latest equity (current capital) for sizing — same rationale as single-strategy path.
		const peakEquity = this.deps.store.getPeakEquity();
		const latestEquity = this.deps.store.getLatestEquity();
		const accountEquity = latestEquity > 0
			? latestEquity
			: Math.max(100, Number(this.deps.store.getSetting("daily_limit_usd") || "100") * 2);

		const bestStrategy = ensembleResult.agreeing[0];

		const stopLoss = signal.stopLoss ?? (signal.direction === "long"
			? signal.entryPrice * 0.98
			: signal.entryPrice * 1.02);

		const takeProfit = signal.takeProfit
			?? this.deps.riskManager.calculateTakeProfit(signal.entryPrice, stopLoss);

		// Pre-trade net-edge (D1 micro): only take trades whose TP can pay for
		// round-trip fees+spread+slip at 2× margin. Primary paper profitability filter.
		if (this.config.preTradeNetEdgeEnabled) {
			const configuredMaxTradeUsd = Number(this.deps.store.getSetting("max_trade_usd") || "50");
			const notionalUsd = this.config.isShadowMode
				? Math.min(configuredMaxTradeUsd, 25)
				: configuredMaxTradeUsd;
			const edge = evaluatePreTradeEdge({
				symbol,
				direction: signal.direction,
				entryPrice: signal.entryPrice,
				stopLoss,
				takeProfit,
				notionalUsd,
				spreadBps: this.config.preTradeSpreadBps,
				slippageBps: this.config.preTradeSlippageBps,
				minRiskReward: this.config.preTradeMinRiskReward,
				multiple: 2,
				shortTermTaxRate: 0,
				feeSchedule: getDefaultFeeSchedules(),
			});
			if (!edge.pass) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "netEdge",
					reason: edge.reason,
				});
				const rejected = this.deps.journal.recordSignal({
					strategyName: ensembleStrategyName,
					signal,
					qty: 0,
					stopLoss,
					takeProfit,
					riskValidation: { allowed: false, reasons: [`net-edge: ${edge.reason}`] },
					regime: ensembleResult.regime?.regime,
					regimeConfidence: ensembleResult.regime?.confidence,
					session: sessionInfo?.session,
					sessionFitness: sessionInfo
						? getSessionFitness(ensembleResult.agreeing[0], sessionInfo)
						: undefined,
				});
				this.deps.journal.updateSignalStatus(rejected.id, "rejected");
				return rejected;
			}
			signal.reason += ` [net-edge: RR=${edge.riskReward.toFixed(2)} TP=${edge.tpBps.toFixed(0)}bps ${edge.netEdge.pass ? "ok" : "fail"}]`;
		}

		// Dynamic confidence-based sizing replaces static risk-percentage calculation.
		// Tier depends on ensemble agreement and edge validation:
		//   high   = unanimous + confirmed edge → 3% risk
		//   medium = majority (2+ agreeing)     → 1.5% risk
		//   low    = weak consensus + edge      → 0.5% risk
		//   skip   = weak consensus + no edge   → don't trade
		const configuredMaxTradeUsd = Number(this.deps.store.getSetting("max_trade_usd") || "50");
		// Shadow mode uses graduation level-1 cap ($25) so P&L is realistic but contained
		const maxTradeUsd = this.config.isShadowMode
			? Math.min(configuredMaxTradeUsd, 25)
			: configuredMaxTradeUsd;
		const edgeCache = this.edgeCache.get(bestStrategy);
		const edgeVerdict = edgeCache?.result?.verdict ?? "weak";
		const executionQualityScale =
			this.deps.executionQualityController?.getSizingAdjustment(symbol).multiplier ?? 1;

		const gradeScale = this.strategyGradeScale(bestStrategy, symbol, ensembleResult.regime?.regime);
		if (gradeScale <= 0) {
			const gateRecord = this.deps.journal.recordSignal({
				strategyName: ensembleStrategyName,
				signal,
				qty: 0,
				stopLoss,
				takeProfit,
				riskValidation: { allowed: false, reasons: ["Strategy lifecycle: allocation multiplier 0"] },
				regime: ensembleResult.regime?.regime,
				regimeConfidence: ensembleResult.regime?.confidence,
				session: sessionInfo?.session,
				sessionFitness: sessionInfo ? getSessionFitness(ensembleResult.agreeing[0], sessionInfo) : undefined,
			});
			this.deps.journal.updateSignalStatus(gateRecord.id, "rejected");
			this.recordRejection({
				signal,
				strategyName: ensembleStrategyName,
				symbol,
				gate: "lifecycle",
				reason: `${bestStrategy} allocation paused/archived (multiplier 0)`,
			});
			return gateRecord;
		}

		const sizerResult = computeDynamicQty({
			entryPrice: signal.entryPrice,
			stopLoss,
			equity: accountEquity,
			maxTradeUsd,
			ensembleVoterCount: ensembleResult.votes.length,
			ensembleAgreeingCount: ensembleResult.agreeing.length,
			edgeVerdict,
			sizingModel: this.deps.store.getSetting("sizing_model") || "fixed_risk",
			executionQualityScale,
			strategyGradeScale: gradeScale,
			// Shadow mode runs at the graduation level-1 cap ($25) — below the
			// fee-aware floor — but no real fees are paid, so disable the floor
			// for shadow-mode evaluation only.
			enforceFeeFloor: !this.config.isShadowMode,
		});

		if (sizerResult.tier === "skip" || sizerResult.tier === "fee-floor") {
			// Record the signal as rejected so the journal captures it
			const isFeeFloor = sizerResult.tier === "fee-floor";
			const reasonLabel = isFeeFloor
				? "Dynamic sizer: fee-floor tier"
				: "Dynamic sizer: skip tier";
			const rejectionReason = isFeeFloor
				? `fee-floor tier (notional below round-trip fee floor)`
				: `skip tier (low confidence, edge=${edgeVerdict})`;
			const skipRecord = this.deps.journal.recordSignal({
				strategyName: ensembleStrategyName,
				signal,
				qty: 0,
				stopLoss,
				takeProfit,
				riskValidation: { allowed: false, reasons: [reasonLabel] },
				regime: ensembleResult.regime?.regime,
				regimeConfidence: ensembleResult.regime?.confidence,
				session: sessionInfo?.session,
				sessionFitness: sessionInfo ? getSessionFitness(ensembleResult.agreeing[0], sessionInfo) : undefined,
			});
			this.deps.journal.updateSignalStatus(skipRecord.id, "rejected");
			this.recordRejection({
				signal,
				strategyName: ensembleStrategyName,
				symbol,
				gate: "sizer",
				reason: rejectionReason,
			});
			return skipRecord;
		}

		let qty = sizerResult.qty;
		qty = Math.round(qty * 1e8) / 1e8;

		if (qty <= 0) {
			this.recordRejection({
				signal,
				strategyName: ensembleStrategyName,
				symbol,
				gate: "qty",
				reason: `computed qty=${qty} after rounding`,
			});
			return null;
		}

		// Apply dynamic risk adjustment (portfolio-wide)
		// Shadow mode skips the "paused" gate — dynamic-risk pause is driven by
		// loss streaks on real/paper capital; blocking shadow signals defeats the
		// purpose of shadow testing (accumulating signal history without real risk).
		if (this.deps.dynamicRiskAdjuster) {
			const dynAdj = this.deps.dynamicRiskAdjuster.getAdjustment();
			if (dynAdj.paused && !this.config.isShadowMode) {
				console.log(`[signal-engine/ensemble] dynamic-risk PAUSED: ${dynAdj.reason}`);
				return null;
			}
			if (dynAdj.riskMultiplier !== 1.0) {
				qty = qty * dynAdj.riskMultiplier;
				qty = Math.round(qty * 1e8) / 1e8;
				console.log(`[signal-engine/ensemble] dynamic-risk qty scale ${dynAdj.riskMultiplier.toFixed(2)}x: ${dynAdj.reason}`);
			}
			if (dynAdj.stopLossMultiplier !== 1.0 && signal.stopLoss !== undefined) {
				const riskDist = Math.abs(signal.entryPrice - signal.stopLoss);
				signal.stopLoss = signal.direction === "long"
					? signal.entryPrice - riskDist * dynAdj.stopLossMultiplier
					: signal.entryPrice + riskDist * dynAdj.stopLossMultiplier;
				console.log(`[signal-engine/ensemble] dynamic-risk stop-loss widened ${dynAdj.stopLossMultiplier.toFixed(2)}x: ${dynAdj.reason}`);
			}
		}

		// Reuse currentPositions read at the top of this method — no async work has
		// happened since the duplicate-position guard so the snapshot is still valid.
		// Shadow mode uses accountEquity as peakEquity so a stale peak cannot trigger
		// the risk manager's drawdown rejection on shadow signals.
		const validation = this.deps.riskManager.validateTrade({
			entryPrice: signal.entryPrice,
			qty,
			side: signal.direction,
			symbol,
			accountEquity,
			peakEquity: this.config.isShadowMode ? accountEquity : (peakEquity > 0 ? peakEquity : accountEquity),
			openPositions: currentPositions,
		});

		const bestStrategyForFitness = ensembleResult.agreeing[0];
		const record = this.deps.journal.recordSignal({
			strategyName: ensembleStrategyName,
			signal,
			qty,
			stopLoss,
			takeProfit,
			riskValidation: validation,
			regime: ensembleResult.regime?.regime,
			regimeConfidence: ensembleResult.regime?.confidence,
			session: sessionInfo?.session,
			sessionFitness: sessionInfo ? getSessionFitness(bestStrategyForFitness, sessionInfo) : undefined,
		});

		// When risk validation fails but a reduced size would pass, use the suggested qty
		// instead of rejecting entirely. Only applies to size-related rejections.
		if (!validation.allowed && validation.suggestedQty && validation.suggestedQty > 0) {
			console.warn(
				`[signal-engine/ensemble] Trade size reduced from ${qty} to ${validation.suggestedQty} ` +
				`due to risk limits (${symbol})`,
			);
			qty = Math.round(validation.suggestedQty * 1e8) / 1e8;
			// Re-validate with the reduced qty to ensure it passes all checks
		const revalidation = this.deps.riskManager.validateTrade({
			entryPrice: signal.entryPrice,
			qty,
			side: signal.direction,
			symbol,
			accountEquity,
			peakEquity: peakEquity > 0 ? peakEquity : accountEquity,
			openPositions: currentPositions,
		});
			if (!revalidation.allowed) {
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "risk",
					reason: `revalidation failed after size reduction: ${revalidation.reasons.join("; ")}`,
				});
				return record;
			}
		} else if (!validation.allowed) {
			this.recordRejection({
				signal,
				strategyName: ensembleStrategyName,
				symbol,
				gate: "risk",
				reason: validation.reasons.join("; ") || "risk validation rejected",
			});
			return record;
		}

		const isPaper = resolvePaperMode(this.deps.store);

		const shouldExecute = isPaper
			? this.config.autoExecutePaper
			: this.config.autoExecuteLive;

		if (shouldExecute && this.deps.executeTrade) {
			// Reuse currentPositions — no await has occurred since the top-of-method
			// read, so no new positions can have been committed for this symbol.
			// Shadow positions count toward the cap: in shadow mode the real
			// positions table stays empty, so without this stack would grow without bound.
			const realSameSymbolCount = currentPositions.filter((p) => p.symbol === symbol).length;
			const shadowSameSymbolCount = this.deps.shadowModeExecutor
				? this.deps.shadowModeExecutor.getOpenPositions().filter((p) => p.symbol === symbol).length
				: 0;
			const sameSymbolCount = realSameSymbolCount + shadowSameSymbolCount;
			const maxPerAsset = this.deps.riskManager?.getConfig().maxPositionsPerAsset ?? 3;
			if (sameSymbolCount >= maxPerAsset) {
				this.deps.journal.updateSignalStatus(record.id, "rejected");
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: "perAsset",
					reason: `${sameSymbolCount} open positions (real:${realSameSymbolCount} shadow:${shadowSameSymbolCount}) >= max ${maxPerAsset}`,
				});
				return record;
			}

			const correlationCheck = this.checkCorrelationGuard(symbol, signal.direction);
			if (!correlationCheck.allowed) {
				this.deps.journal.updateSignalStatus(record.id, "rejected");
				this.recordRejection({
					signal,
					strategyName: ensembleStrategyName,
					symbol,
					gate: correlationCheck.gate,
					reason: correlationCheck.reason,
				});
				return record;
			}

			// Pre-execution backtest gate for ensemble signals.
			// Use the best strategy (highest-confidence voter) for backtesting,
			// since the ensemble signal is derived from it.
			// On-chain symbols (solana:*) skip CEX candle backtests — no shared candle series.
			if (this.config.backtestGateEnabled && !isDexSolanaExecutionSymbol(symbol)) {
				const bestStratObj = this.deps.strategyRegistry.get(ensembleResult.agreeing[0]);
				if (bestStratObj) {
					// Fetch candles for backtest (re-use the same timeframe as best strategy)
					const backtestHistoryCount = requiredBacktestCandleCount(bestStratObj.timeframe, bestStratObj.minCandles);
					const sorted = this.deps.candleStore.getAscending(symbol, bestStratObj.timeframe, backtestHistoryCount);
					const gateResult = this.mandatoryBacktest(bestStratObj, sorted, {
						symbol,
						strategyId: record.id,
					});
					if (gateResult.verdict !== "VALIDATED") {
						this.deps.journal.updateSignalStatus(record.id, "rejected");
						this.recordRejection({
							signal,
							strategyName: ensembleStrategyName,
							symbol,
							gate: "backtest",
							reason: gateResult.reason,
						});
						return record;
					}
				}
			}

			try {
				await this.deps.executeTrade({
					symbol: signal.symbol,
					direction: signal.direction,
					qty,
					stopLoss,
					takeProfit,
					trailingStopPct: signal.trailingStopPct,
					strategyName: ensembleStrategyName,
					signalId: record.id,
					entryPrice: signal.entryPrice,
					confidence: signal.confidence,
				});
				this.deps.journal.updateSignalStatus(record.id, "executed");
				this.deps.onSignal?.(signal, ensembleStrategyName, "execute");
			} catch (err) {
				const errMsg =
					typeof this.deps.client.scrubError === "function"
						? this.deps.client.scrubError(err)
						: scrubErrorMessage(err);
				console.error(
					`[signal-engine/ensemble] executeTrade FAILED for ${signal.symbol} ${signal.direction}: ${errMsg}`,
				);
				this.deps.journal.updateSignalStatus(record.id, "failed");
			}
		} else {
			this.deps.journal.updateSignalStatus(record.id, "pending");
			this.deps.onSignal?.(signal, ensembleStrategyName, "pending");
		}

		return record;
	}

	/**
	 * Mandatory 180d / 30d walk-forward validation before a signal can route
	 * into execution. Any failure emits REJECT_INVALID_ALPHA and increments
	 * the strategy suppression counter.
	 */
	private mandatoryBacktest(
		strategy: NonNullable<ReturnType<StrategyRegistry["get"]>>,
		candles: import("../data/candle-store.js").Candle[],
		context: { symbol: string; strategyId: string },
	): MandatoryBacktestOutcome {
		const timeframeMs = timeframeToMs(strategy.timeframe);
		if (!timeframeMs) {
			return this.rejectInvalidAlpha(
				strategy,
				context,
				`unsupported timeframe ${strategy.timeframe}`,
				{ lookbackCandles: 0, walkForwardCandles: 0 },
			);
		}

		const lookbackCandles = Math.ceil((MANDATORY_BACKTEST_LOOKBACK_DAYS * DAY_MS) / timeframeMs);
		const walkForwardCandles = Math.ceil((MANDATORY_BACKTEST_WALK_FORWARD_DAYS * DAY_MS) / timeframeMs);
		const unbiasedCandles = candles.slice(0, -MANDATORY_BACKTEST_EXCLUDE_RECENT_CANDLES);
		if (unbiasedCandles.length < lookbackCandles) {
			return this.rejectInvalidAlpha(
				strategy,
				context,
				`insufficient lookback history ${unbiasedCandles.length}/${lookbackCandles} candles`,
				{ lookbackCandles, walkForwardCandles },
			);
		}

		const lookbackWindow = unbiasedCandles.slice(-lookbackCandles);
		const validationWindow = lookbackWindow.slice(-walkForwardCandles);
		const trainingWindow = lookbackWindow.slice(0, -walkForwardCandles);
		if (
			trainingWindow.length < strategy.minCandles
			|| validationWindow.length < Math.max(strategy.minCandles, this.config.backtestMinTrades)
		) {
			return this.rejectInvalidAlpha(
				strategy,
				context,
				`insufficient walk-forward split train=${trainingWindow.length} test=${validationWindow.length}`,
				{ lookbackCandles, walkForwardCandles },
			);
		}

		try {
			const cacheKey = `${strategy.name}:${context.symbol}`;
			const cachedValidation = this.validationCache.get(cacheKey);
			const rollingValidation = cachedValidation && Date.now() - cachedValidation.timestamp < SignalEngine.VALIDATION_CACHE_TTL_MS
				? cachedValidation.result
				: new RegimeValidationPipeline().run(strategy, candles);
			if (!cachedValidation || rollingValidation !== cachedValidation.result) {
				this.validationCache.set(cacheKey, { result: rollingValidation, timestamp: Date.now() });
			}
			this.retrainingTargets.set(strategy.name, rollingValidation.retrainingTargets);

			const latestWindow = rollingValidation.windows.at(-1);
			const trades = latestWindow?.trades ?? 0;
			const sharpeRatio = latestWindow?.sharpeRatio ?? 0;
			const maxDrawdownPct = latestWindow?.maxDrawdownPct ?? 0;

			if (trades < this.config.backtestMinTrades) {
				return this.rejectInvalidAlpha(
					strategy,
					context,
					`walk-forward trades ${trades} below minimum ${this.config.backtestMinTrades}`,
					{
						trades,
						sharpeRatio,
						maxDrawdownPct,
						rollingSharpeRatio: rollingValidation.rollingSharpeRatio,
						fourteenDayDrawdownPct: rollingValidation.fourteenDayDrawdownPct,
						lookbackCandles,
						walkForwardCandles,
					},
				);
			}

			if (sharpeRatio < MANDATORY_BACKTEST_MIN_SHARPE) {
				return this.rejectInvalidAlpha(
					strategy,
					context,
					`walk-forward sharpe ${sharpeRatio.toFixed(2)} below ${MANDATORY_BACKTEST_MIN_SHARPE.toFixed(2)}`,
					{
						trades,
						sharpeRatio,
						maxDrawdownPct,
						rollingSharpeRatio: rollingValidation.rollingSharpeRatio,
						fourteenDayDrawdownPct: rollingValidation.fourteenDayDrawdownPct,
						lookbackCandles,
						walkForwardCandles,
					},
				);
			}

			if ((maxDrawdownPct / 100) > MANDATORY_BACKTEST_MAX_DRAWDOWN_FRACTION) {
				return this.rejectInvalidAlpha(
					strategy,
					context,
					`walk-forward drawdown ${(maxDrawdownPct / 100).toFixed(4)} above ${MANDATORY_BACKTEST_MAX_DRAWDOWN_FRACTION.toFixed(4)}`,
					{
						trades,
						sharpeRatio,
						maxDrawdownPct,
						rollingSharpeRatio: rollingValidation.rollingSharpeRatio,
						fourteenDayDrawdownPct: rollingValidation.fourteenDayDrawdownPct,
						lookbackCandles,
						walkForwardCandles,
					},
				);
			}

			if (rollingValidation.verdict !== "VALIDATED") {
				this.suspendDeployment(strategy.name, context.symbol, rollingValidation);
				return this.rejectInvalidAlpha(
					strategy,
					context,
					rollingValidation.reason,
					{
						trades,
						sharpeRatio,
						maxDrawdownPct,
						rollingSharpeRatio: rollingValidation.rollingSharpeRatio,
						fourteenDayDrawdownPct: rollingValidation.fourteenDayDrawdownPct,
						lookbackCandles,
						walkForwardCandles,
					},
				);
			}

			// Keep the softer statistical edge cache warm for dynamic sizing without
			// making it the hard execution gate.
			const cached = this.edgeCache.get(strategy.name);
			if (!cached || Date.now() - cached.timestamp > SignalEngine.EDGE_CACHE_TTL_MS) {
				try {
					const edge = validateEdge(strategy, lookbackWindow, { startingEquity: 10_000 });
					this.edgeCache.set(strategy.name, { result: edge, timestamp: Date.now() });
					console.log(`[signal-engine] Edge validation: ${strategy.name} → ${edge.verdict} | ${edge.summary}`);
				} catch (err) {
					console.debug("[signal-engine] edge validation failed (continuing):", err instanceof Error ? err.message : err);
				}
			}

			console.log(
				`[signal-engine] VALIDATED_ALPHA strategyId=${context.strategyId} strategy=${strategy.name} ` +
				`symbol=${context.symbol} lookback=180d walk_forward=30d sharpe=${sharpeRatio.toFixed(2)} ` +
				`rollingSharpe=${rollingValidation.rollingSharpeRatio.toFixed(2)} ` +
				`fourteenDayDrawdownPct=${rollingValidation.fourteenDayDrawdownPct.toFixed(2)} ` +
				`maxDrawdownPct=${maxDrawdownPct.toFixed(2)} trades=${trades}`,
			);

			return {
				verdict: "VALIDATED",
				reason: "mandatory_backtest passed",
				metrics: {
					trades,
					sharpeRatio,
					maxDrawdownPct,
					rollingSharpeRatio: rollingValidation.rollingSharpeRatio,
					fourteenDayDrawdownPct: rollingValidation.fourteenDayDrawdownPct,
					lookbackCandles,
					walkForwardCandles,
				},
			};
		} catch (err) {
			return this.rejectInvalidAlpha(
				strategy,
				context,
				`mandatory backtest failed: ${err instanceof Error ? err.message : String(err)}`,
				{ lookbackCandles, walkForwardCandles },
			);
		}
	}

	private rejectInvalidAlpha(
		strategy: NonNullable<ReturnType<StrategyRegistry["get"]>>,
		context: { symbol: string; strategyId: string },
		reason: string,
		metrics: MandatoryBacktestOutcome["metrics"],
	): MandatoryBacktestOutcome {
		const suppressionCount = this.incrementStrategySuppressionCounter(strategy.name);
		this.lastScanDiagnostics.push({
			strategy: strategy.name,
			symbol: context.symbol,
			reason: `${REJECT_INVALID_ALPHA}: ${reason}`,
		});

		const metricText =
			` trades=${metrics?.trades ?? "n/a"} sharpe=${metrics?.sharpeRatio?.toFixed(2) ?? "n/a"} ` +
			`maxDrawdownPct=${metrics?.maxDrawdownPct?.toFixed(2) ?? "n/a"} ` +
			`lookbackCandles=${metrics?.lookbackCandles ?? "n/a"} walkForwardCandles=${metrics?.walkForwardCandles ?? "n/a"}`;
		console.warn(
			`[signal-engine] ${REJECT_INVALID_ALPHA} strategyId=${context.strategyId} strategy=${strategy.name} ` +
			`symbol=${context.symbol} suppressionCount=${suppressionCount} reason=${reason}${metricText}`,
		);

		return { verdict: REJECT_INVALID_ALPHA, reason, metrics };
	}

	private incrementStrategySuppressionCounter(strategyName: string): number {
		const key = `strategy_suppression_count:${strategyName}`;
		const next = Number(this.deps.store.getSetting(key) || "0") + 1;
		this.deps.store.setSetting(key, String(next));
		return next;
	}

	private suspendDeployment(
		strategyName: string,
		symbol: string,
		validation: RollingValidationResult,
	): void {
		if (this.deps.store.getTradingState() === "LOCKED") return;
		this.deps.store.setTradingState("LOCKED");
		if (typeof this.deps.store.logRiskMonitorEvent === "function") {
			this.deps.store.logRiskMonitorEvent({
				fromState: "ACTIVE",
				toState: "LOCKED",
				reason:
					`Rolling validation suspended deployment for ${strategyName} ${symbol}: ` +
					`${validation.reason}`,
				detailJson: JSON.stringify({
					strategyName,
					symbol,
					rollingSharpeRatio: validation.rollingSharpeRatio,
					fourteenDayDrawdownPct: validation.fourteenDayDrawdownPct,
					retrainingTargets: validation.retrainingTargets,
				}),
			});
		}
	}

	private getCachedReturnAttribution(strategyName: string): ReturnAttributionBucket[] {
		const cached = this.attributionCache.get(strategyName);
		if (cached && Date.now() - cached.timestamp < SignalEngine.ATTRIBUTION_CACHE_TTL_MS) {
			return cached.result;
		}
		const provider = this.deps.journal as TradeJournal & {
			getReturnAttribution?: (strategyName?: string, lookbackDays?: number) => ReturnAttributionBucket[];
		};
		const result = typeof provider.getReturnAttribution === "function"
			? provider.getReturnAttribution(strategyName, 30)
			: [];
		this.attributionCache.set(strategyName, { result, timestamp: Date.now() });
		return result;
	}

	private applyRetrainingFeedback(
		strategyName: string,
		symbol: string,
		regime: RegimeAnalysis["regime"] | undefined,
		session: string | undefined,
		signal: Signal,
	): void {
		const matchedTarget = (this.retrainingTargets.get(strategyName) ?? [])
			.find((target) => target.symbol === symbol && (!regime || target.regime === regime));
		if (matchedTarget) {
			signal.confidence = Math.max(0.05, Math.min(0.99, signal.confidence * matchedTarget.weight));
			signal.reason += ` [retrain:${matchedTarget.reason}]`;
		}

		const buckets = this.getCachedReturnAttribution(strategyName);
		const matchedBucket = buckets
			.filter((bucket) => bucket.symbol === symbol)
			.sort((a, b) => {
				const aScore = (a.regime === regime ? 2 : 0) + (a.session === session ? 1 : 0);
				const bScore = (b.regime === regime ? 2 : 0) + (b.session === session ? 1 : 0);
				if (aScore !== bScore) return bScore - aScore;
				return b.tradeCount - a.tradeCount;
			})
			.at(0);
		if (!matchedBucket || matchedBucket.tradeCount < 3) return;

		const needsRetraining = matchedBucket.totalPnl < 0 || matchedBucket.sharpeRatio < 0.5;
		if (!needsRetraining) return;

		const attributionWeight = matchedBucket.sharpeRatio < 0 || matchedBucket.totalPnl < 0 ? 0.55 : 0.75;
		signal.confidence = Math.max(0.05, Math.min(0.99, signal.confidence * attributionWeight));
		signal.reason +=
			` [realized:${matchedBucket.regime ?? "all"}/${matchedBucket.session ?? "all"} ` +
			`Sharpe=${matchedBucket.sharpeRatio.toFixed(2)} PnL=$${matchedBucket.totalPnl.toFixed(2)}]`;
	}

	/** Get cached edge validation results for all strategies (for dashboard) */
	getEdgeValidations(): Map<string, EdgeValidation> {
		const map = new Map<string, EdgeValidation>();
		for (const [name, cached] of this.edgeCache) {
			map.set(name, cached.result);
		}
		return map;
	}

	/** Get last ensemble voting results (for dashboard/debugging) */
	getEnsembleResults(): Map<string, EnsembleResult> {
		return new Map(this.lastEnsembleResults);
	}

	/** Get last regime analysis per symbol (for dashboard/debugging) */
	getRegimeAnalysis(): Map<string, RegimeAnalysis> {
		return new Map(this.lastRegimeAnalysis);
	}

	/** Get last session info (for dashboard/debugging) */
	getSessionInfo(): SessionInfo | null {
		return this.lastSessionInfo;
	}

	/** Get diagnostics from the last scan (why each strategy/symbol produced nothing) */
	getScanDiagnostics(): Array<{ strategy: string; symbol: string; reason: string }> {
		return [...this.lastScanDiagnostics];
	}

	/**
	 * Get rejection events across recent scans (newest last). Used by
	 * `trade_risk_status.recentRejections[]` so the operator can see
	 * structured "why" data (gate + reason + symbol + ts) without log diving.
	 */
	getRecentRejections(limit = SignalEngine.MAX_RECENT_REJECTIONS): SignalRejection[] {
		const start = Math.max(0, this.recentRejections.length - limit);
		return this.recentRejections.slice(start);
	}

	/** Clear the recent-rejections buffer. Test-only convenience. */
	clearRecentRejections(): void {
		this.recentRejections = [];
	}

	/**
	 * Internal helper: record a rejection event to both the per-scan diagnostic
	 * stream AND the persistent ring buffer, then notify the `onSignal` callback
	 * if a Signal has already been generated.
	 *
	 * Use this anywhere the engine drops a signal before execution. Centralising
	 * the bookkeeping is what closes the "why didn't trade X enter" loop.
	 */
	private recordRejection(
		params: {
			signal: Signal | null;
			strategyName: string;
			symbol: string;
			gate: string;
			reason: string;
		},
	): void {
		const { signal, strategyName, symbol, gate, reason } = params;
		this.lastScanDiagnostics.push({ strategy: strategyName, symbol, reason: `${gate}: ${reason}` });
		this.recentRejections.push({
			ts: Date.now(),
			symbol,
			strategyName,
			gate,
			reason,
			direction: signal?.direction,
			confidence: signal?.confidence,
		});
		if (this.recentRejections.length > SignalEngine.MAX_RECENT_REJECTIONS) {
			this.recentRejections.shift();
		}
		if (signal) {
			this.deps.onSignal?.(signal, strategyName, "rejected", reason);
		}
	}

	private async evaluateSymbol(
		strategyName: string,
		symbol: string,
		timeframe: string,
	): Promise<SignalRecord | null> {
		const strategy = this.deps.strategyRegistry.get(strategyName);
		if (!strategy) return null;

		// Prevent concurrent evaluation of the same symbol (race condition guard)
		const lockKey = `${strategyName}:${symbol}`;
		if (this.evaluating.has(lockKey)) return null;
		this.evaluating.add(lockKey);
		try {
			return await this._doEvaluateSymbol(strategyName, symbol, timeframe, strategy);
		} finally {
			this.evaluating.delete(lockKey);
		}
	}

	private async _doEvaluateSymbol(
		strategyName: string,
		symbol: string,
		timeframe: string,
		strategy: NonNullable<ReturnType<StrategyRegistry["get"]>>,
	): Promise<SignalRecord | null> {
		// Check cooldown
		const cooldownKey = `${strategyName}:${symbol}`;
		const lastTime = this.lastSignalTime.get(cooldownKey);
		const cooldownMs = this.effectiveCooldownMs();
		if (lastTime && Date.now() - lastTime < cooldownMs) {
			this.recordRejection({
				signal: null,
				strategyName,
				symbol,
				gate: "cooldown",
				reason: `${Math.round((Date.now() - lastTime) / 1000)}s of ${Math.round(cooldownMs / 1000)}s`,
			});
			return null;
		}

		// Get candles in ascending order — avoids the [...candles].reverse() spread copy
		const candleHistoryCount = requiredBacktestCandleCount(timeframe, strategy.minCandles);
		let sorted = this.deps.candleStore.getAscending(symbol, timeframe, candleHistoryCount);
		if (sorted.length < strategy.minCandles) {
			// Try fetching fresh from API
			const raw = await this.deps.client.getCandles(symbol, timeframe);
			if (raw.length > 0) {
				const mapped: Candle[] = raw.map((c) => ({
					symbol, timeframe,
					openTime: c.openTime, open: c.open, high: c.high,
					low: c.low, close: c.close, volume: c.volume,
				}));
				this.deps.candleStore.upsert(mapped);
				sorted = this.deps.candleStore.getAscending(symbol, timeframe, candleHistoryCount);
			}
		}
		if (sorted.length < strategy.minCandles) {
			this.recordRejection({
				signal: null,
				strategyName,
				symbol,
				gate: "candles",
				reason: `have ${sorted.length}, need ${strategy.minCandles}`,
			});
			return null;
		}

		// Don't signal if already in a position for this symbol. Shadow
		// positions count: in shadow mode the real positions table stays
		// empty, so without this the same symbol would generate unlimited
		// duplicate signals every scan cycle.
		const openPositions = this.deps.store.getOpenPositions();
		const realCount = openPositions.filter((p) => p.symbol === symbol).length;
		const shadowCount = this.deps.shadowModeExecutor
			? this.deps.shadowModeExecutor.getOpenPositions().filter((p) => p.symbol === symbol).length
			: 0;
		if (realCount + shadowCount > 0) {
			this.recordRejection({
				signal: null,
				strategyName,
				symbol,
				gate: "duplicate",
				reason: `Already in position for this symbol (real:${realCount} shadow:${shadowCount})`,
			});
			return null;
		}

		// Session filter: check if current session is suitable for this strategy
		const sessionInfo = getCurrentSession();
		this.lastSessionInfo = sessionInfo;
		const sessionFitness = getSessionFitness(strategyName, sessionInfo);

		if (this.config.sessionFilterEnabled) {
			// Block signals during off-hours entirely (unless fitness is somehow high)
			if (!isHighQualityWindow(sessionInfo) && sessionFitness < 0.5) {
				this.recordRejection({
					signal: null,
					strategyName,
					symbol,
					gate: "session",
					reason: `off-hours (${sessionInfo.session}), fitness=${sessionFitness.toFixed(2)} < 0.5`,
				});
				return null;
			}
			// Block strategies that are poorly suited to this session
			if (sessionFitness < this.config.sessionMinFitness) {
				this.recordRejection({
					signal: null,
					strategyName,
					symbol,
					gate: "session",
					reason: `fitness ${sessionFitness.toFixed(2)} < ${this.config.sessionMinFitness}`,
				});
				return null;
			}
		}

		// Compute indicators and evaluate
		const indicators = computeIndicators(sorted);
		const marketContext = this.getMarketContext(symbol);
		const signal = strategy.evaluate(sorted, indicators, marketContext);

		if (!signal) {
			this.recordRejection({
				signal: null,
				strategyName,
				symbol,
				gate: "noSignal",
				reason: "Strategy returned no signal (no entry conditions met)",
			});
			return null;
		}

		// Apply regime-based confidence adjustment (single-strategy mode)
		const rawConfidence = signal.confidence;
		let regimeAnalysis: RegimeAnalysis | undefined;
		let regimeWeight = 1.0;
		if (this.config.regimeDetectionEnabled && sorted.length >= 30) {
			try {
				regimeAnalysis = detectRegime(indicators);
				this.lastRegimeAnalysis.set(symbol, regimeAnalysis);
				regimeWeight = regimeAnalysis.strategyWeights[strategyName] ?? 1.0;
				signal.confidence = Math.min(signal.confidence * regimeWeight, 0.95);
			} catch (err) {
				console.debug("[signal-engine] regime weight adjustment failed:", err instanceof Error ? err.message : err);
			}
		}

		// Apply session fitness as a secondary confidence modulator.
		// This is softer than the hard gate above — it slightly reduces confidence
		// for strategies that are marginal in the current session, making them
		// less likely to pass the minConfidence threshold.
		const preSessionConfidence = signal.confidence;
		if (this.config.sessionFilterEnabled && sessionFitness < 0.7) {
			signal.confidence = signal.confidence * (0.7 + sessionFitness * 0.3);
		}

		// Phase 2 swarm: apply adaptive weight from trade outcome feedback loop.
		// StrategyAdaptor computes per-strategy multipliers based on recent P&L,
		// win rate, Sharpe ratio, and drawdown. Poorly performing strategies get
		// their confidence reduced, making them less likely to pass minConfidence.
		if (this.strategyAdaptor) {
			const adaptiveWeight = this.strategyAdaptor.getStrategyWeight(strategyName);
			if (adaptiveWeight !== 1.0) {
				signal.confidence = Math.min(signal.confidence * adaptiveWeight, 0.95);
			}
		}

		this.applyRetrainingFeedback(
			strategyName,
			symbol,
			regimeAnalysis?.regime,
			sessionInfo.session,
			signal,
		);

		// ── Multi-timeframe confirmation gate (single-strategy path) ──
		// When MTF confirmation is enabled, use the full EMA-based confirmer
		// which picks the correct higher TF from the ladder. When disabled,
		// fall back to the legacy lightweight 4h SMA check.
		if (this.config.mtfConfirmation.enabled) {
			const mtfResult = confirmSignalTimeframe(
				signal.direction,
				symbol,
				strategy.timeframe,
				this.deps.candleStore,
				this.config.mtfConfirmation,
			);
			if (!mtfResult.confirmed) {
				this.recordRejection({
					signal,
					strategyName,
					symbol,
					gate: "mtfConfirmation",
					reason: `higher timeframe disagreement: ${mtfResult.reason}`,
				});
				return null;
			}
			if (mtfResult.higherTfTrend !== "neutral") {
				signal.reason += ` [MTF: ${mtfResult.higherTfTimeframe} ${mtfResult.higherTfTrend} conf=${mtfResult.confidence.toFixed(2)}]`;
			}
		} else if (strategy.timeframe !== "4h") {
			// Legacy 4h SMA trend check (original behavior when MTF is disabled)
			const htfCandles = this.deps.candleStore?.get(symbol, "4h", 20);
			if (htfCandles && htfCandles.length >= 10) {
				const htfCloses = htfCandles.map(c => c.close);
				const htfSma10 = htfCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
				const htfPrice = htfCloses[htfCloses.length - 1];
				const htfTrend = htfPrice > htfSma10 ? "up" : "down";
				if ((signal.direction === "long" && htfTrend === "down") ||
					(signal.direction === "short" && htfTrend === "up")) {
					signal.confidence *= 0.7;
					signal.reason += ` [4h trend: ${htfTrend}, -30% conf]`;
				}
			}
		}

		// ── Pattern-based confidence modulation from MarketLearner ──
		if (this.deps.learner) {
			const currentHour = new Date().getUTCHours();
			const learnerPair = symbol.replace("_", "/"); // BTC_USDT → BTC/USDT
			const patterns = this.deps.learner.getPatterns(learnerPair, 0.3);

			let patternBoost = 0;
			let patternCount = 0;

			for (const p of patterns) {
				if (p.hourOfDay !== currentHour) continue; // Only use patterns for current hour

				const details = p.details; // Already parsed Record<string, unknown>

				if (p.type === "momentum_hour") {
					const patternDirection = details.direction as string; // "up" or "down"
					const signalDirection = signal.direction; // "long" or "short"
					const aligned = (patternDirection === "up" && signalDirection === "long") ||
					               (patternDirection === "down" && signalDirection === "short");
					// Boost if pattern agrees, suppress if it disagrees
					patternBoost += aligned ? p.confidence * 0.15 : -p.confidence * 0.1;
					patternCount++;
				}

				if (p.type === "imbalance_shift") {
					const ratio = (details.avgImbalance ?? details.avgRatio) as number;
					const buyPressure = ratio > 1.5;
					const aligned = (buyPressure && signal.direction === "long") ||
					               (!buyPressure && signal.direction === "short");
					patternBoost += aligned ? p.confidence * 0.1 : -p.confidence * 0.05;
					patternCount++;
				}
			}

			if (patternCount > 0) {
				signal.confidence = Math.max(0.05, Math.min(0.99, signal.confidence + patternBoost));
				signal.reason += ` [learner: ${patternCount} pattern(s), ${patternBoost > 0 ? "+" : ""}${(patternBoost * 100).toFixed(1)}% conf → ${(signal.confidence * 100).toFixed(1)}%]`;
			}
		}

		const singleEffectiveMinConf = this.config.isShadowMode
			? this.config.minConfidence * 0.7
			: this.config.minConfidence;
		if (signal.confidence < singleEffectiveMinConf) {
			const detail = `${signal.direction} raw=${rawConfidence.toFixed(3)} regime=${regimeWeight.toFixed(2)}x(${regimeAnalysis?.regime ?? "none"}) session=${sessionFitness.toFixed(2)} final=${signal.confidence.toFixed(3)} < ${singleEffectiveMinConf}`;
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "minConfidence",
				reason: `Below minConfidence (${singleEffectiveMinConf}): ${detail}`,
			});
			console.log(`[signal-engine] ${strategyName}:${symbol} signal FILTERED: ${detail}`);
			return null;
		}

		// NOTE: cooldown is NOT set here — it's set after successful execution.
		// Previously, cooldown was set before risk validation, which meant a
		// rejected signal would block the next legitimate signal for 5 minutes.

		// Risk validation
		// Use latest equity (current capital) for sizing, NOT peak equity (all-time high).
		// Using peak equity after a drawdown would oversize positions relative to
		// actual available capital. Peak equity is only used for drawdown checks.
		const peakEquity = this.deps.store.getPeakEquity();
		const latestEquity = this.deps.store.getLatestEquity();
		const accountEquity = latestEquity > 0
			? latestEquity
			: Math.max(100, Number(this.deps.store.getSetting("daily_limit_usd") || "100") * 2);

		const atrValues = indicators.atr;
		const currentAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : undefined;

		const stopLoss = signal.stopLoss ?? (currentAtr
			? this.deps.riskManager.calculateStopLoss(signal.entryPrice, currentAtr, signal.direction)
			: signal.direction === "long"
				? signal.entryPrice * 0.98
				: signal.entryPrice * 1.02);

		const takeProfit = signal.takeProfit
			?? this.deps.riskManager.calculateTakeProfit(signal.entryPrice, stopLoss);

		if (this.config.preTradeNetEdgeEnabled) {
			const configuredSingleMax = Number(this.deps.store.getSetting("max_trade_usd") || "50");
			const notionalUsd = this.config.isShadowMode
				? Math.min(configuredSingleMax, 25)
				: configuredSingleMax;
			const edge = evaluatePreTradeEdge({
				symbol,
				direction: signal.direction,
				entryPrice: signal.entryPrice,
				stopLoss,
				takeProfit,
				notionalUsd,
				spreadBps: this.config.preTradeSpreadBps,
				slippageBps: this.config.preTradeSlippageBps,
				minRiskReward: this.config.preTradeMinRiskReward,
				multiple: 2,
				shortTermTaxRate: 0,
				feeSchedule: getDefaultFeeSchedules(),
			});
			if (!edge.pass) {
				this.recordRejection({
					signal,
					strategyName,
					symbol,
					gate: "netEdge",
					reason: edge.reason,
				});
				return null;
			}
			signal.reason += ` [net-edge: RR=${edge.riskReward.toFixed(2)} TP=${edge.tpBps.toFixed(0)}bps]`;
		}

		// Dynamic confidence-based sizing for single-strategy path.
		// Single strategy = 1 voter, 1 agreeing → requires confirmed edge for "low" tier (0.5% risk).
		// Without edge → "skip" tier (don't trade). This is intentional — single-strategy
		// signals should be sized conservatively and require edge validation to proceed.
		const configuredSingleMaxTradeUsd = Number(this.deps.store.getSetting("max_trade_usd") || "50");
		// Shadow mode uses graduation level-1 cap ($25) so P&L is realistic but contained
		const maxTradeUsd = this.config.isShadowMode
			? Math.min(configuredSingleMaxTradeUsd, 25)
			: configuredSingleMaxTradeUsd;
		const singleEdgeCache = this.edgeCache.get(strategyName);
		const singleEdgeVerdict = singleEdgeCache?.result?.verdict ?? "weak";
		const executionQualityScale =
			this.deps.executionQualityController?.getSizingAdjustment(symbol).multiplier ?? 1;

		const gradeScale = this.strategyGradeScale(strategyName, symbol, regimeAnalysis?.regime);
		if (gradeScale <= 0) {
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "lifecycle",
				reason: "allocation paused/archived",
			});
			return null;
		}

		const sizerResult = computeDynamicQty({
			entryPrice: signal.entryPrice,
			stopLoss,
			equity: accountEquity,
			maxTradeUsd,
			ensembleVoterCount: 1,
			ensembleAgreeingCount: 1,
			edgeVerdict: singleEdgeVerdict,
			sizingModel: this.deps.store.getSetting("sizing_model") || "fixed_risk",
			executionQualityScale,
			strategyGradeScale: gradeScale,
			enforceFeeFloor: !this.config.isShadowMode,
		});

		if (sizerResult.tier === "skip" || sizerResult.tier === "fee-floor") {
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "sizer",
				reason: sizerResult.tier === "fee-floor"
					? "fee-floor tier (notional below round-trip fee floor)"
					: `skip tier (single strategy, edge=${singleEdgeVerdict})`,
			});
			return null;
		}

		let qty = sizerResult.qty;
		qty = Math.round(qty * 1e8) / 1e8;

		if (qty <= 0) {
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "qty",
				reason: `computed qty=${qty} after rounding`,
			});
			return null;
		}

		// Apply dynamic risk adjustment (portfolio-wide)
		// Shadow mode skips the "paused" gate — see ensemble path comment above.
		if (this.deps.dynamicRiskAdjuster) {
			const dynAdj = this.deps.dynamicRiskAdjuster.getAdjustment();
			if (dynAdj.paused && !this.config.isShadowMode) {
				console.log(`[signal-engine] dynamic-risk PAUSED: ${dynAdj.reason}`);
				return null;
			}
			if (dynAdj.riskMultiplier !== 1.0) {
				qty = qty * dynAdj.riskMultiplier;
				qty = Math.round(qty * 1e8) / 1e8;
				console.log(`[signal-engine] dynamic-risk qty scale ${dynAdj.riskMultiplier.toFixed(2)}x: ${dynAdj.reason}`);
			}
			if (dynAdj.stopLossMultiplier !== 1.0 && signal.stopLoss !== undefined) {
				const riskDist = Math.abs(signal.entryPrice - signal.stopLoss);
				signal.stopLoss = signal.direction === "long"
					? signal.entryPrice - riskDist * dynAdj.stopLossMultiplier
					: signal.entryPrice + riskDist * dynAdj.stopLossMultiplier;
				console.log(`[signal-engine] dynamic-risk stop-loss widened ${dynAdj.stopLossMultiplier.toFixed(2)}x: ${dynAdj.reason}`);
			}
		}

		// Re-fetch positions immediately before risk validation.
		// The snapshot from line ~607 is stale — it was taken before indicator
		// computation, strategy evaluation, and confidence adjustments, which
		// can take seconds. A concurrent signal may have opened a position
		// in the meantime, making the exposure check pass with stale data.
		const freshPositions = this.deps.store.getOpenPositions();
		// Also re-check for duplicate position (may have opened since first check)
		if (freshPositions.some((p) => p.symbol === symbol)) {
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "duplicate",
				reason: "Position opened concurrently for this symbol",
			});
			return null;
		}

		const validation = this.deps.riskManager.validateTrade({
			entryPrice: signal.entryPrice,
			qty,
			side: signal.direction,
			symbol,
			accountEquity,
			// Shadow mode: use accountEquity as peak so a stale CB peak cannot
			// trigger the risk manager's drawdown rejection on shadow signals.
			peakEquity: this.config.isShadowMode ? accountEquity : (peakEquity > 0 ? peakEquity : accountEquity),
			openPositions: freshPositions,
			atrValue: currentAtr,
		});

		// Record the signal with regime and session context
		const record = this.deps.journal.recordSignal({
			strategyName,
			signal,
			qty,
			stopLoss,
			takeProfit,
			riskValidation: validation,
			regime: regimeAnalysis?.regime,
			regimeConfidence: regimeAnalysis?.confidence,
			session: sessionInfo.session,
			sessionFitness,
		});

		// When risk validation fails but a reduced size would pass, use the suggested qty
		// instead of rejecting entirely. Only applies to size-related rejections.
		if (!validation.allowed && validation.suggestedQty && validation.suggestedQty > 0) {
			console.warn(
				`[signal-engine] Trade size reduced from ${qty} to ${validation.suggestedQty} ` +
				`due to risk limits (${symbol})`,
			);
			qty = Math.round(validation.suggestedQty * 1e8) / 1e8;
			// Re-validate with the reduced qty to ensure it passes all checks
			const revalidation = this.deps.riskManager.validateTrade({
				entryPrice: signal.entryPrice,
				qty,
				side: signal.direction,
				symbol,
				accountEquity,
				peakEquity: peakEquity > 0 ? peakEquity : accountEquity,
				openPositions: freshPositions,
				atrValue: currentAtr,
			});
			if (!revalidation.allowed) {
				this.recordRejection({
					signal,
					strategyName,
					symbol,
					gate: "risk",
					reason: `revalidation failed after size reduction: ${revalidation.reasons.join("; ")}`,
				});
				return record;
			}
		} else if (!validation.allowed) {
			this.recordRejection({
				signal,
				strategyName,
				symbol,
				gate: "risk",
				reason: validation.reasons.join("; ") || "risk validation rejected",
			});
			return record;
		}

		// Determine whether to auto-execute
		const isPaper = resolvePaperMode(this.deps.store);

		const shouldExecute = isPaper
			? this.config.autoExecutePaper
			: this.config.autoExecuteLive;

		if (shouldExecute && this.deps.executeTrade) {
			// Re-verify position count for this symbol is under the per-asset limit.
			// The RiskManager's maxPositionsPerAsset (default 3) controls this —
			// don't hard-reject on the first position like the old code did.
			// Shadow positions count toward the cap: in shadow mode the real
			// positions table stays empty, so without this stack would grow without bound.
			const latestPositions = this.deps.store.getOpenPositions();
			const realSameSymbolCount = latestPositions.filter((p) => p.symbol === symbol).length;
			const shadowSameSymbolCount = this.deps.shadowModeExecutor
				? this.deps.shadowModeExecutor.getOpenPositions().filter((p) => p.symbol === symbol).length
				: 0;
			const sameSymbolCount = realSameSymbolCount + shadowSameSymbolCount;
			const maxPerAsset = this.deps.riskManager?.getConfig().maxPositionsPerAsset ?? 3;
			if (sameSymbolCount >= maxPerAsset) {
				this.deps.journal.updateSignalStatus(record.id, "rejected");
				this.recordRejection({
					signal,
					strategyName,
					symbol,
					gate: "perAsset",
					reason: `${sameSymbolCount} open positions (real:${realSameSymbolCount} shadow:${shadowSameSymbolCount}) >= max ${maxPerAsset}`,
				});
				return record;
			}

			const correlationCheck = this.checkCorrelationGuard(symbol, signal.direction);
			if (!correlationCheck.allowed) {
				this.deps.journal.updateSignalStatus(record.id, "rejected");
				this.recordRejection({
					signal,
					strategyName,
					symbol,
					gate: correlationCheck.gate,
					reason: correlationCheck.reason,
				});
				return record;
			}

			// Pre-execution backtest gate: validate signal against recent history (CEX symbols only).
			if (this.config.backtestGateEnabled && !isDexSolanaExecutionSymbol(symbol)) {
				const gateResult = this.mandatoryBacktest(strategy, sorted, {
					symbol,
					strategyId: record.id,
				});
				if (gateResult.verdict !== "VALIDATED") {
					this.deps.journal.updateSignalStatus(record.id, "rejected");
					this.recordRejection({
						signal,
						strategyName,
						symbol,
						gate: "backtest",
						reason: gateResult.reason,
					});
					return record;
				}
			}

			try {
				await this.deps.executeTrade({
					symbol: signal.symbol,
					direction: signal.direction,
					qty,
					stopLoss,
					takeProfit,
					trailingStopPct: signal.trailingStopPct,
					strategyName,
					signalId: record.id,
					entryPrice: signal.entryPrice,
					confidence: signal.confidence,
				});
				// Set cooldown AFTER successful execution — not before.
				// This ensures rejected/failed signals don't block future signals.
				this.lastSignalTime.set(cooldownKey, Date.now());
				this.deps.journal.updateSignalStatus(record.id, "executed");
				this.deps.onSignal?.(signal, strategyName, "execute");
			} catch (err) {
				const errMsg =
					typeof this.deps.client.scrubError === "function"
						? this.deps.client.scrubError(err)
						: scrubErrorMessage(err);
				console.error(
					`[signal-engine] executeTrade FAILED for ${signal.symbol} ${signal.direction}: ${errMsg}`,
				);
				this.deps.journal.updateSignalStatus(record.id, "failed");
			}
		} else {
			this.lastSignalTime.set(cooldownKey, Date.now());
			this.deps.journal.updateSignalStatus(record.id, "pending");
			this.deps.onSignal?.(signal, strategyName, "pending");
		}

		return record;
	}

	getConfig(): SignalEngineConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<SignalEngineConfig>): void {
		Object.assign(this.config, updates);
	}

	clearCooldowns(): void {
		this.lastSignalTime.clear();
	}
}

function timeframeToMs(timeframe: string): number | null {
	const match = timeframe.trim().toLowerCase().match(/^(\d+)(m|h|d|w)$/);
	if (!match) return null;

	const value = Number(match[1]);
	const unit = match[2];
	if (!Number.isFinite(value) || value <= 0) return null;

	switch (unit) {
		case "m": return value * 60 * 1000;
		case "h": return value * 60 * 60 * 1000;
		case "d": return value * DAY_MS;
		case "w": return value * 7 * DAY_MS;
		default: return null;
	}
}

function requiredBacktestCandleCount(timeframe: string, minCandles: number): number {
	const timeframeMs = timeframeToMs(timeframe);
	if (!timeframeMs) return Math.max(200, minCandles * 2);

	const lookbackCandles = Math.ceil((MANDATORY_BACKTEST_LOOKBACK_DAYS * DAY_MS) / timeframeMs);
	return Math.max(
		200,
		minCandles * 2,
		lookbackCandles + MANDATORY_BACKTEST_EXCLUDE_RECENT_CANDLES,
	);
}
