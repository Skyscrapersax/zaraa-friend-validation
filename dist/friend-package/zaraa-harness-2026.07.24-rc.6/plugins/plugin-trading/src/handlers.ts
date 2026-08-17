import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import type { Zone } from "@zaraa/shared";
import { runMacroPredictionReport } from "./analytics/macro-prediction-report.js";
import { PortfolioAnalyzer } from "./analytics/portfolio-analyzer.js";
import { generateBacktestReport } from "./backtest/backtest-report.js";
import { Backtester } from "./backtest/backtester.js";
import type { FeeSchedule } from "./cost/fee-schedule.js";
import type { CryptoClient } from "./crypto-client.js";
import type { CandleFetcher } from "./data/candle-fetcher.js";
import type { CandleStore } from "./data/candle-store.js";
import {
	isDexSolanaExecutionSymbol,
	parseSolanaDexTokenSymbol,
} from "./dex/dex-execution-symbol.js";
import { JupiterSwapExecutor } from "./dex/jupiter-swap-executor.js";
import type { ApiRateLimiter } from "./engine/api-rate-limiter.js";
import { AsyncMutex, type ExecutionManager } from "./engine/execution-manager.js";
import {
	type AdaptiveOrderTypeDecision,
	computeAdverseImpactBps,
	computeAdverseSlippageBps,
	deriveBookSnapshot,
	type ExecutionBookSnapshot,
	type ExecutionQualityController,
} from "./engine/execution-quality-controller.js";
import type { ExecutionRouter } from "./engine/execution-router.js";
import { JournalReporter } from "./engine/journal-reporter.js";
import type { ShadowModeExecutor } from "./engine/shadow-mode.js";
import type { SignalEngine } from "./engine/signal-engine.js";
import { listStrategyLifecycles, refreshStrategyGrades } from "./engine/strategy-grader.js";
import { StrategyOptimizer } from "./engine/strategy-optimizer.js";
import { StrategyRanker } from "./engine/strategy-ranker.js";
import type { StrategyRotator } from "./engine/strategy-rotator.js";
import type { TradeJournal } from "./engine/trade-journal.js";
import type { TradingHealthAggregator } from "./engine/trading-health.js";
import type { ExchangeManager } from "./exchanges/exchange-manager.js";
import * as indicators from "./indicators/index.js";
import type { LeaderboardPeriod, LeaderboardStore } from "./leaderboard/leaderboard-store.js";
import {
	buildAutomatedRiskLockSnapshot,
	checkAndMaybeAutoRevertToPaper,
	recordGoLiveBaselineEquity,
} from "./risk/automated-risk-lock.js";
import { DynamicRiskAdjuster } from "./risk/dynamic-risk.js";
import { emergencyFlattenAllPositions } from "./risk/emergency-flatten.js";
import type { FlashCrashDetector } from "./risk/flash-crash-detector.js";
import { refreshLiveAccountEquity, requireFreshLiveEquity } from "./risk/live-equity.js";
import {
	expectedLiveModeLock as computeExpectedLiveModeLock,
	validateLiveModeLock as runLiveModeLockCheck,
} from "./risk/live-mode-lock.js";
import type { MaxPositionsGuard } from "./risk/max-positions-guard.js";
import { OrderReconciler } from "./risk/order-reconciler.js";
import { computePaperEquityUsd } from "./risk/paper-equity.js";
import {
	checkPaperStopLoss,
	checkPaperInvalidation,
	getPaperStopLossTreeStatus,
	type TradeStyle,
} from "./risk/paper-stop-loss-tree.js";
import type { PositionGraduation } from "./risk/position-graduation.js";
import {
	evaluatePreLiveChecklist,
	recordPreLiveExchangeVerified,
} from "./risk/pre-live-checklist.js";
import { PreTradeValidator } from "./risk/pre-trade-validator.js";
import type { RiskManager } from "./risk/risk-manager.js";
import type { StopMonitor } from "./risk/stop-monitor.js";
import { validateTradeRiskStatusSemantics } from "./risk/trade-risk-status-semantics.js";
import type { TradingCircuitBreaker } from "./risk/trading-circuit-breaker.js";
import { buildKillGateSnapshot, evaluateTradingKillGate } from "./risk/trading-kill-gate.js";
import { resolvePaperMode, resolveTradingModeSnapshot } from "./risk/trading-mode.js";
import { TrialsLedger } from "./risk/trials-ledger.js";
import {
	getRsiDivergenceCounters,
	resetRsiDivergenceCounters,
} from "./strategies/builtin/rsi-divergence.js";
import { getCurrentSession } from "./strategies/session-filter.js";
import type { StrategyRegistry } from "./strategies/strategy-registry.js";
import type { TradingStore } from "./trading-store.js";
import { type QuietHoursWindow, resolveOpusGrindCycle } from "./util/opus-grind-cycle.js";
import {
	type OpusGrindCanonicalSummaryV1,
	opusGrindSummaryNestedSchema,
} from "./util/opus-grind-summary.js";
import { parsePositiveSetting } from "./util/parse-setting.js";
import {
	collectRiskViolations,
	computeExposureByAsset,
	DEFAULT_QUIET_HOURS_BENCHMARK_SYMBOLS,
	escalationRecommendedForViolations,
} from "./util/quiet-hours-risk-audit.js";
import { tryAcquireLock, withLock } from "./util/resource-lock.js";
import {
	spotQuoteFromTicker,
	tradeGetPriceResponseSchema,
	tradeGetPricesResponseSchema,
} from "./util/trade-price-payload.js";
import {
	generateTradingOrderCorrelationId,
	type TradingOrderAuditPayload,
	type TradingOrderAuditSource,
} from "./util/trading-order-audit.js";
import type { PriceFeed } from "./ws/price-feed.js";

export interface TradingHandlerDeps {
	client: CryptoClient;
	store: TradingStore;
	candleStore?: CandleStore;
	candleFetcher?: CandleFetcher;
	riskManager?: RiskManager;
	stopMonitor?: StopMonitor;
	strategyRegistry?: StrategyRegistry;
	signalEngine?: SignalEngine;
	tradeJournal?: TradeJournal;
	executionManager?: ExecutionManager;
	executionQualityController?: ExecutionQualityController;
	exchangeManager?: ExchangeManager;
	priceFeed?: PriceFeed;
	/** Leaderboard store — provides ranked strategy performance metrics. */
	leaderboardStore?: LeaderboardStore;
	/** Trading circuit breaker — checked before every trade entry. */
	circuitBreaker?: TradingCircuitBreaker;
	/**
	 * When true, core `zaraa.config.json` has `trading.paperMode: true`.
	 * Pre-live checklist fails until the operator sets it false and restarts.
	 */
	zaraaTradingPaperMode?: boolean;
	/** When set (e.g. from Zaraa PolicyEngine), each filled trade_buy/trade_sell logs audit.jsonl with correlationId (TRD-05). */
	onTradingOrderAudit?: (payload: TradingOrderAuditPayload) => void;
	/**
	 * Generic trading lifecycle bus: alerts created/deleted/triggered, snapshot updates, etc.
	 * Core forwards to its EventBus so the web/iOS SSE consumers can react.
	 * Wiring of individual emission sites is incremental — see handlers.test.ts for expected eventType keys.
	 */
	onTradingEvent?: (eventType: string, payload: Record<string, unknown>) => void | Promise<void>;
	/** Solana RPC for Jupiter live swaps (default: mainnet-beta). */
	solanaRpcUrl?: string;
	/** Base58 secret key for live Solana DEX; prefer env SOLANA_DEX_SECRET_KEY in production. */
	solanaDexSecretKeyBase58?: string;
	onAlert?: (alert: {
		id: string;
		symbol: string;
		condition: string;
		targetPrice: number;
		currentPrice: number;
		triggered: boolean;
		message: string;
	}) => void;
	onStopTriggered?: (event: {
		positionId: string;
		symbol: string;
		type: string;
		triggerPrice: number;
		currentPrice: number;
		pnl: number;
	}) => void;
	/** From Zaraa config `notifications.quietHours`; when unset, 23:00–07:00 local is used for grind gating. */
	opusGrindQuietHours?: QuietHoursWindow;
	/** Injectable clock (tests). Defaults to `new Date()`. */
	opusGrindNow?: () => Date;
	/**
	 * When `trade_log_opus_grind` receives a repeat failure pattern (`occurrenceCount` ≥ 2),
	 * core can persist a procedural memory (dedup handled upstream if needed).
	 */
	onOpusGrindRepeatFailure?: (payload: {
		patternKey: string;
		description: string;
		occurrenceCount: number;
		recommendedFix?: string;
	}) => void | Promise<void>;
	/** Fired when `trade_daily_crypto_discipline` detects stop proximity, drawdown, halt, etc. */
	onDailyDisciplineAlert?: (payload: {
		reasons: string[];
		message: string;
	}) => void | Promise<void>;
	/** Optional fee schedule overrides passed through to ExecutionManager (defaults to getDefaultFeeSchedules()). */
	feeSchedule?: FeeSchedule[];
	/** Optional paper-mode slippage in basis points passed through to ExecutionManager (defaults to 5 bps). */
	paperSlippageBps?: number;
	/** Strategy rotator — evaluates and ranks strategies for capital allocation. */
	strategyRotator?: StrategyRotator;
	/** Execution router — selects optimal exchange for order routing. */
	executionRouter?: ExecutionRouter;
	/** API rate limiter — tracks and enforces per-exchange rate limits. */
	apiRateLimiter?: ApiRateLimiter;
	/** Flash crash detector — blocks trades when a flash crash is detected. */
	flashCrashDetector?: FlashCrashDetector;
	/** Position graduation — limits position size based on trade history. */
	positionGraduation?: PositionGraduation;
	/** Max positions guard — limits total open positions. */
	maxPositionsGuard?: MaxPositionsGuard;
	/** Trading health aggregator — single pane of glass for system health. */
	tradingHealth?: TradingHealthAggregator;
	/**
	 * Live mode confirmation lock from zaraa.config.json `trading.liveModeLock`.
	 * When paper_mode is OFF, every trade execution checks this against the expected
	 * "I-CONFIRM-LIVE-TRADING-YYYY-MM-DD" format (today's UTC date).
	 * Missing or stale lock rejects the trade before any exchange interaction.
	 */
	liveModeLock?: string;
	/** Shadow mode executor — runs signals through full pipeline without real trades. */
	shadowModeExecutor?: ShadowModeExecutor;
	/**
	 * Minimum interval between equity snapshots (ms). Prevents StopScheduler-driven
	 * tick bursts (every 10s live / 60s paper) from clustering snapshots in ~44s
	 * windows followed by long silent gaps. Trade events bypass this via `force:true`.
	 * Default: 5 * 60_000 (5 minutes).
	 */
	equitySnapshotMinIntervalMs?: number;
	/** Current daemon zone; sandbox portfolio reads stay local-only. */
	getZone?: () => Zone;
}

export function createTradingHandlers(deps: TradingHandlerDeps) {
	const {
		client,
		store,
		candleStore,
		candleFetcher,
		riskManager,
		stopMonitor,
		strategyRegistry,
		signalEngine,
		tradeJournal,
		executionQualityController,
		leaderboardStore,
		onAlert,
		circuitBreaker,
		zaraaTradingPaperMode,
		onTradingOrderAudit,
		onTradingEvent,
		solanaRpcUrl,
		solanaDexSecretKeyBase58,
		opusGrindQuietHours,
		opusGrindNow,
		onOpusGrindRepeatFailure,
		onDailyDisciplineAlert,
		strategyRotator,
		executionRouter,
		apiRateLimiter,
		flashCrashDetector,
		positionGraduation,
		maxPositionsGuard,
		liveModeLock,
		tradingHealth,
		shadowModeExecutor,
		equitySnapshotMinIntervalMs,
		getZone,
	} = deps;
	const equitySnapshotMinInterval =
		typeof equitySnapshotMinIntervalMs === "number" && equitySnapshotMinIntervalMs >= 0
			? equitySnapshotMinIntervalMs
			: 5 * 60_000;
	let lastEquitySnapshotMs = 0;

	// ── Per-symbol mutex for handler-level paper trades ───────────────────────
	// Paper trades in trade_buy/trade_sell previously bypassed the AsyncMutex
	// used by ExecutionManager, allowing concurrent signals to read stale open-
	// position snapshots and corrupt statistics that feed live position sizing.
	// This mutex serializes handler-level paper trades the same way
	// ExecutionManager serializes signal-engine trades.
	// Closure-scoped flag for stop-loss exit CB bypass. Only internal code (stop monitor
	// wiring) may set this — never sourced from caller-supplied args.
	// Re-entrant counter (not a boolean) so two concurrent stop-monitor exits
	// don't have the inner finally{} clear the flag while the outer call is
	// still running and depending on the CB bypass. With a boolean, the inner
	// reset would route the outer's in-flight stop-sell through the standard
	// CB-halted check and silently reject a real stop-loss exit.
	let _stopExitBypassDepth = 0;

	const handlerMutexes = new Map<string, AsyncMutex>();
	function getHandlerMutex(symbol: string): AsyncMutex {
		let mx = handlerMutexes.get(symbol);
		if (!mx) {
			mx = new AsyncMutex();
			handlerMutexes.set(symbol, mx);
		}
		return mx;
	}

	function emitTradingEvent(eventType: string, payload: Record<string, unknown>): void {
		if (!onTradingEvent) return;
		try {
			const result = onTradingEvent(eventType, payload);
			if (result && typeof (result as Promise<unknown>).catch === "function") {
				(result as Promise<unknown>).catch((err) => {
					console.debug(
						`[trading] onTradingEvent(${eventType}) rejected:`,
						err instanceof Error ? err.message : err,
					);
				});
			}
		} catch (err) {
			console.debug(
				`[trading] onTradingEvent(${eventType}) threw:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	async function buildSnapshotUpdated(reason: string): Promise<Record<string, unknown>> {
		const snapshot: Record<string, unknown> = { reason };
		const logSnapshotFailure = (field: string, err: unknown) => {
			console.debug(
				`[trading] buildSnapshotUpdated(${reason}) ${field} failed:`,
				err instanceof Error ? err.message : err,
			);
		};
		try {
			const portfolioJson = forwardRef.trade_portfolio ? await forwardRef.trade_portfolio() : null;
			if (portfolioJson) snapshot.portfolio = JSON.parse(portfolioJson);
		} catch (err) {
			logSnapshotFailure("portfolio", err);
		}
		try {
			const riskJson = forwardRef.trade_risk_status ? await forwardRef.trade_risk_status() : null;
			if (riskJson) snapshot.risk = JSON.parse(riskJson);
		} catch (err) {
			logSnapshotFailure("risk", err);
		}
		try {
			const analyticsJson = forwardRef.trade_analytics ? await forwardRef.trade_analytics() : null;
			if (analyticsJson) snapshot.analytics = JSON.parse(analyticsJson);
		} catch (err) {
			logSnapshotFailure("analytics", err);
		}
		try {
			snapshot.alerts = { alerts: store.getActiveAlerts() };
		} catch (err) {
			logSnapshotFailure("alerts", err);
		}
		return snapshot;
	}

	const forwardRef: Partial<{
		trade_get_prices: (a: Record<string, unknown>) => Promise<string>;
		trade_get_orderbook: (a: Record<string, unknown>) => Promise<string>;
		trade_portfolio: () => Promise<string>;
		trade_risk_status: () => Promise<string>;
		trade_analytics: () => Promise<string>;
	}> = {};

	function emitTradingOrderAudit(
		source: TradingOrderAuditSource,
		fields: Omit<TradingOrderAuditPayload, "correlationId" | "source">,
	): string {
		const correlationId = generateTradingOrderCorrelationId();
		onTradingOrderAudit?.({ correlationId, source, ...fields });
		return correlationId;
	}

	/**
	 * Record accurate equity snapshot for circuit breaker drawdown tracking.
	 * Uses current market prices (not entry prices) for open position valuation.
	 *
	 * Throttled to `equitySnapshotMinInterval` (default 5min) so StopScheduler
	 * ticks don't cluster snapshots — trade-event callers pass `force:true` to
	 * bypass the throttle and always emit on entry/exit.
	 */
	async function recordEquitySnapshot(opts: { force?: boolean } = {}): Promise<void> {
		if (!circuitBreaker) return;
		const now = Date.now();
		if (!opts.force && now - lastEquitySnapshotMs < equitySnapshotMinInterval) {
			return;
		}
		lastEquitySnapshotMs = now;
		const positions = store.getOpenPositions();
		let currentEquity: number;
		if (isPaperMode()) {
			currentEquity = await computePaperEquityUsd({
				balances: store.getAllPaperBalances(),
				openPositions: positions,
				getTicker: (s) => client.getTicker(s),
				onNoTicker: (currency, balance) => {
					console.debug(
						`[trading] paper equity: no ${currency}_USDT ticker, excluding ${balance} ${currency} from equity`,
					);
				},
			});
		} else {
			// LIVE NAV has its own authenticated table and automated risk rail.
			// Never feed it into the paper/global circuit-breaker series: a $1000
			// paper peak followed by a $10 micro-live account would look like a 99%
			// drawdown and could poison both modes.
			await refreshLiveAccountEquity({ client, store });
			return;
		}
		// Phantom-equity guard. Paper-equity sums every non-USDT balance × <CCY>_USDT
		// ticker; when the ticker fetch fails AND the 15-min recallPrice cache has
		// also expired, the balance is silently excluded. With several alt tickers
		// failing in one tick, equity can drop hundreds of dollars purely from
		// missing valuations — not real PnL. Recording that drop poisons the
		// velocity CB (adjacent-sample delta) and trips the live drawdown gate
		// (`(peak − latest) / peak`). On scheduled ticks (force=false) refuse to
		// record snapshots that fall >15% from the last good snapshot; trade-event
		// callers pass force=true and bypass the guard so a real catastrophic
		// loss on entry/exit still records. Firing 49 root-caused this after
		// firing 48 deferred the fix and the bug recurred.
		const lastEquity = store.getLatestEquity();
		if (!opts.force && lastEquity > 0 && currentEquity > 0 && currentEquity < lastEquity * 0.85) {
			const dropPct = ((lastEquity - currentEquity) / lastEquity) * 100;
			console.warn(
				`[trading] phantom-equity guard: skipping recordEquity ${currentEquity.toFixed(2)} ` +
					`(${dropPct.toFixed(1)}% drop from last snapshot ${lastEquity.toFixed(2)}; ` +
					`likely ticker-feed glitch — trade events with force=true bypass this guard)`,
			);
			return;
		}
		// Reconcile breaker peak with store MAX(equity) before the drawdown check,
		// so a $0.48-class drift can't measure drawdown from a stale watermark.
		circuitBreaker.syncPeakFromStore(store.getPeakEquity());
		circuitBreaker.recordEquity(currentEquity);
	}

	async function enforceAutomatedRiskSnapshot(
		snapshot: ReturnType<typeof buildAutomatedRiskLockSnapshot>,
		wasPaperMode: boolean,
	): Promise<Awaited<ReturnType<typeof emergencyFlattenAllPositions>> | null> {
		if (!snapshot.triggered) return null;
		const previousState = store.getTradingState();
		if (previousState !== "HALTED") {
			store.setTradingState("HALTED");
			store.logRiskMonitorEvent({
				fromState: previousState,
				toState: "HALTED",
				reason: snapshot.reason ?? "Automated risk lock triggered.",
				detailJson: JSON.stringify(snapshot),
			});
		}
		const result = await emergencyFlattenAllPositions({
			client,
			store,
			circuitBreaker,
			isPaperMode: wasPaperMode,
		});
		const liveExposureRemains = store
			.getOpenPositions()
			.some((position) => position.isPaper === false || position.isPaper === 0);
		if (
			!wasPaperMode &&
			snapshot.reason?.startsWith("[auto-revert]") &&
			result.failures.length === 0 &&
			!liveExposureRemains
		) {
			checkAndMaybeAutoRevertToPaper(store);
		}
		return result;
	}

	async function getExecutionBookSnapshot(
		symbol: string,
	): Promise<ExecutionBookSnapshot | undefined> {
		try {
			return deriveBookSnapshot(await client.getOrderBook(symbol, 5));
		} catch (err) {
			console.debug(
				"[trading] order book snapshot unavailable for",
				symbol,
				err instanceof Error ? err.message : err,
			);
			return undefined;
		}
	}

	function resolveAdaptiveOrderType(
		symbol: string,
		requestedType: "MARKET" | "LIMIT" | undefined,
		fallback: "MARKET" | "LIMIT",
	): { type: "MARKET" | "LIMIT"; routeDecision: AdaptiveOrderTypeDecision | null } {
		if (requestedType) {
			return { type: requestedType, routeDecision: null };
		}
		const routeDecision =
			executionQualityController?.getAdaptiveOrderType(symbol, fallback) ?? null;
		return { type: routeDecision?.orderType ?? fallback, routeDecision };
	}

	function buildExecutionRouteJson(input: {
		expectedPrice: number;
		fillPrice: number;
		latencyMs: number;
		requestedType?: "MARKET" | "LIMIT";
		actualType: "MARKET" | "LIMIT";
		routeDecision: AdaptiveOrderTypeDecision | null;
		bookSnapshot?: ExecutionBookSnapshot;
		side: "BUY" | "SELL";
	}): { slippageBps: number; routeJson: string } {
		const slippageBps = computeAdverseSlippageBps({
			side: input.side,
			expectedPrice: input.expectedPrice,
			fillPrice: input.fillPrice,
		});
		const impactBps = computeAdverseImpactBps({
			side: input.side,
			fillPrice: input.fillPrice,
			book: input.bookSnapshot,
		});
		return {
			slippageBps,
			routeJson: JSON.stringify({
				expectedPrice: input.expectedPrice,
				fillPrice: input.fillPrice,
				latencyMs: input.latencyMs,
				slippageBps,
				impactBps,
				requestedOrderType: input.requestedType ?? null,
				actualOrderType: input.actualType,
				adaptiveRoutingReason: input.routeDecision?.reason ?? null,
				adaptiveRoutingConfidence: input.routeDecision?.confidence ?? null,
				bestBid: input.bookSnapshot?.bestBid ?? null,
				bestAsk: input.bookSnapshot?.bestAsk ?? null,
				midPrice: input.bookSnapshot?.midPrice ?? null,
				topBidQty: input.bookSnapshot?.topBidQty ?? null,
				topAskQty: input.bookSnapshot?.topAskQty ?? null,
			}),
		};
	}

	/**
	 * Check whether paper trading mode is active.
	 *
	 * Priority order:
	 *   1. PAPER_TRADING=true env var → always paper mode (safety override)
	 *   2. PAPER_TRADING=false env var → use DB setting (but never auto-switch to live)
	 *   3. DB setting "paper_mode" → normal runtime control
	 *
	 * The env var is useful for:
	 *   - Running tests safely (PAPER_TRADING=true pnpm test)
	 *   - CI/CD pipelines where you never want live trades
	 *   - Quickly sandboxing a new strategy without touching the DB
	 */
	function isPaperMode(): boolean {
		return resolvePaperMode(store);
	}

	/**
	 * Snapshot paper_mode + shadow_mode atomically so a single handler
	 * invocation sees a consistent pair.  Without this, a concurrent
	 * `trade_set_limit` call between the two reads can flip one flag
	 * while the other still holds its old value — e.g. shadow_mode=true
	 * running against paperMode=false when the operator intended the
	 * opposite combination.
	 */
	function snapshotTradingModes(): { paperMode: boolean; shadowMode: boolean } {
		return resolveTradingModeSnapshot(store);
	}

	/**
	 * Returns today's expected live-mode lock string in UTC.
	 * Format: "I-CONFIRM-LIVE-TRADING-YYYY-MM-DD"
	 *
	 * Thin wrapper around the shared utility so callers in this file keep
	 * their existing call sites; the shared module is also imported directly
	 * by execution-manager so the signal-engine auto-execute path enforces
	 * the same lock.
	 */
	function expectedLiveModeLock(): string {
		return computeExpectedLiveModeLock();
	}

	/**
	 * Validates the liveModeLock when running in live mode.
	 * Returns null if the lock passes, or an error JSON string if it fails.
	 * Skipped entirely in paper mode.
	 */
	function validateLiveModeLock(paperMode: boolean): string | null {
		const result = runLiveModeLockCheck(liveModeLock, paperMode);
		if (result.ok) return null;
		return JSON.stringify({
			error: `LIVE TRADE BLOCKED — ${result.reason}`,
			expectedLock: result.expectedLock,
		});
	}

	function resolveDisciplineLogPath(raw?: string): string {
		const fromArg = raw?.trim();
		const fromEnv = process.env.ZARAA_DAILY_CRYPTO_LOG?.trim();
		const p =
			fromArg && fromArg.length > 0
				? fromArg
				: fromEnv && fromEnv.length > 0
					? fromEnv
					: pathResolve(homedir(), ".zaraa", "logs", "daily_crypto_check.log");
		if (p.startsWith("~/")) return pathResolve(homedir(), p.slice(2));
		if (p === "~") return homedir();
		return p;
	}

	/** Cross-process mutex so two daemons or manual + cron cannot overlap `trade_daily_crypto_discipline`. */
	function dailyDisciplineRunLockPath(tradingStore: TradingStore, logPath?: string): string {
		try {
			const dbName = tradingStore.getDb().name;
			if (dbName && dbName !== ":memory:") {
				return pathJoin(dirname(dbName), "daily_crypto_discipline.run.lock");
			}
		} catch {
			// fall through
		}
		if (logPath) return `${logPath}.run.lock`;
		const fallbackDir = pathResolve(homedir(), ".zaraa", "locks");
		mkdirSync(fallbackDir, { recursive: true });
		return pathJoin(fallbackDir, "daily_crypto_discipline.run.lock");
	}

	const handlers = {
		// ── Read-only: prices ──

		trade_get_price: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			const ticker = await client.getTicker(symbol);
			const payload = { result: spotQuoteFromTicker(ticker) };
			tradeGetPriceResponseSchema.parse(payload);
			return JSON.stringify(payload);
		},

		/** Spot BTC/ETH ratio from two live tickers — for scheduled checks without an LLM. */
		trade_btc_eth_ratio: async (): Promise<string> => {
			const btcSym = normalizeSymbol("BTC_USDT");
			const ethSym = normalizeSymbol("ETH_USDT");
			const [btc, eth] = await Promise.all([client.getTicker(btcSym), client.getTicker(ethSym)]);
			const btcPx = btc.last;
			const ethPx = eth.last;
			if (ethPx === 0 || ethPx == null) {
				throw new Error("ETH_USDT price unavailable — cannot compute ratio");
			}
			const ratio = btcPx / ethPx;
			return JSON.stringify({
				btcUsd: btcPx,
				ethUsd: ethPx,
				btcPerEth: Number(ratio.toFixed(4)),
				symbols: { btc: btc.symbol, eth: eth.symbol },
			});
		},

		/**
		 * Single-shot snapshot for scheduled runs: batch spot quotes, top-of-book per symbol,
		 * open-position summary with stop proximity and simple P&L / halt checks. No LLM.
		 */
		trade_daily_crypto_discipline: async (args: Record<string, unknown> = {}): Promise<string> => {
			const requestedLogPath =
				typeof args.log_path === "string" ? resolveDisciplineLogPath(args.log_path) : undefined;
			const runLock = dailyDisciplineRunLockPath(store, requestedLogPath);
			const nonBlocking =
				args.non_blocking === true ||
				args.non_blocking === "true" ||
				args.non_blocking === 1 ||
				args.non_blocking === "1";

			const runOnce = async (): Promise<string> => {
				const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT"] as const;
				const STOP_PROXIMITY_PCT = 2;
				const DRAWDOWN_ALERT_PCT = 5;
				const logPath = resolveDisciplineLogPath(
					typeof args.log_path === "string" ? args.log_path : undefined,
				);
				const homeFallbackLog = pathResolve(homedir(), ".zaraa", "logs", "daily_crypto_check.log");

				const appendExecutionFailure = async (err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					const line = `${JSON.stringify({
						ts: new Date().toISOString(),
						executionStatus: "failure",
						error: message,
						logPathRequested: logPath,
						symbols: [...symbols],
					})}\n`;
					const write = async (target: string) => {
						await withLock(target, async () => {
							mkdirSync(dirname(target), { recursive: true });
							appendFileSync(target, line, { encoding: "utf8" });
						});
					};
					try {
						await write(logPath);
					} catch (e2) {
						const code =
							e2 && typeof e2 === "object" && "code" in e2
								? (e2 as NodeJS.ErrnoException).code
								: undefined;
						if ((code === "EACCES" || code === "EPERM") && logPath !== homeFallbackLog) {
							await write(homeFallbackLog);
						} else {
							console.error(
								"[trading] daily discipline failure log:",
								e2 instanceof Error ? e2.message : e2,
							);
						}
					}
				};

				try {
					const gp = forwardRef.trade_get_prices;
					const gob = forwardRef.trade_get_orderbook;
					if (!gp || !gob) {
						throw new Error("trade_daily_crypto_discipline: handlers not wired");
					}

					const pf = forwardRef.trade_portfolio;
					const rs = forwardRef.trade_risk_status;
					if (!pf || !rs) {
						throw new Error("trade_daily_crypto_discipline: portfolio/risk handlers not wired");
					}

					const prices = JSON.parse(await gp({ symbols: [...symbols] })) as {
						results: Array<
							| ReturnType<typeof spotQuoteFromTicker>
							| { symbol: string; price: null; error: string }
						>;
					};

					const orderbooks: Record<
						string,
						{
							bestBid?: number;
							bestAsk?: number;
							spreadPct?: string | null;
							bids?: Array<{ price: number; qty: number }>;
							asks?: Array<{ price: number; qty: number }>;
							error?: string;
						}
					> = {};
					for (const s of symbols) {
						try {
							const ob = JSON.parse(await gob({ symbol: s, depth: 10 })) as {
								bestBid?: number;
								bestAsk?: number;
								spread?: string | null;
								bids?: Array<{ price: number; qty: number }>;
								asks?: Array<{ price: number; qty: number }>;
							};
							orderbooks[s] = {
								bestBid: ob.bestBid,
								bestAsk: ob.bestAsk,
								spreadPct: ob.spread ?? null,
								bids: ob.bids,
								asks: ob.asks,
							};
						} catch (err) {
							orderbooks[s] = { error: err instanceof Error ? err.message : String(err) };
						}
					}

					const portfolio = JSON.parse(await pf()) as Record<string, unknown>;
					const riskStatus = JSON.parse(await rs()) as Record<string, unknown>;

					const positions = store.getOpenPositions();
					const enriched = await Promise.all(
						positions.map(async (p) => {
							try {
								const ticker = await client.getTicker(p.symbol);
								const currentPrice = ticker.last;
								const pnl =
									p.side === "long"
										? (currentPrice - p.entryPrice) * p.qty
										: (p.entryPrice - currentPrice) * p.qty;
								return { ...p, currentPrice, pnl };
							} catch {
								return {
									...p,
									currentPrice: undefined as number | undefined,
									pnl: undefined as number | undefined,
								};
							}
						}),
					);
					const byId = new Map(enriched.map((p) => [p.id, p]));

					const alertReasons: string[] = [];

					const missingStop = store.getOpenPositionsMissingStopLoss();
					if (missingStop.length > 0) {
						alertReasons.push(`${missingStop.length} open position(s) missing stop-loss`);
					}

					type RiskStopRow = {
						id: string;
						symbol: string;
						side: string;
						entryPrice: number;
						stopLoss?: number | null;
					};
					const riskStops = Array.isArray(riskStatus.stops)
						? (riskStatus.stops as RiskStopRow[])
						: [];
					const stopById = new Map(riskStops.map((s) => [s.id, s.stopLoss ?? null]));
					// Stop proximity from trade_risk_status.stops + same-run mark prices (enriched).
					for (const s of riskStops) {
						if (s.stopLoss == null) continue;
						const row = byId.get(s.id);
						const cur = row?.currentPrice;
						if (cur == null || cur <= 0 || !row) continue;
						const sl = s.stopLoss;
						if (row.side === "long") {
							const distPct = ((cur - sl) / cur) * 100;
							if (distPct >= 0 && distPct <= STOP_PROXIMITY_PCT) {
								alertReasons.push(
									`${row.symbol} long within ${STOP_PROXIMITY_PCT}% of stop (${distPct.toFixed(2)}% to SL $${sl}) — trade_risk_status`,
								);
							}
						} else {
							const distPct = ((sl - cur) / cur) * 100;
							if (distPct >= 0 && distPct <= STOP_PROXIMITY_PCT) {
								alertReasons.push(
									`${row.symbol} short within ${STOP_PROXIMITY_PCT}% of stop (${distPct.toFixed(2)}% to SL $${sl}) — trade_risk_status`,
								);
							}
						}
					}

					const pe = portfolio.pnlExpectation as
						| {
								bandPct: number;
								referenceUsd: number;
								unrealizedPnlUsd: number;
								unrealizedPctVsReference: number;
								paperReturnPctVsStart: number | null;
								outsideUnrealizedBand: boolean;
								outsidePaperReturnBand: boolean;
						  }
						| undefined;

					if (pe) {
						if (isPaperMode() && pe.outsidePaperReturnBand && pe.paperReturnPctVsStart != null) {
							alertReasons.push(
								`Paper USDT return ${pe.paperReturnPctVsStart >= 0 ? "+" : ""}${pe.paperReturnPctVsStart.toFixed(1)}% vs reference $${pe.referenceUsd} — outside ±${pe.bandPct}% band (trade_portfolio.pnlExpectation)`,
							);
						}
						if (pe.outsideUnrealizedBand) {
							alertReasons.push(
								`Open unrealized P&L $${pe.unrealizedPnlUsd.toFixed(2)} (${pe.unrealizedPctVsReference >= 0 ? "+" : ""}${pe.unrealizedPctVsReference.toFixed(1)}% of reference) — outside ±${pe.bandPct}% band (trade_portfolio.pnlExpectation)`,
							);
						}
					}

					if (!isPaperMode() && riskManager && store.getPeakEquity() > 0) {
						const latestEquity = store.getLatestEquity();
						const peak = store.getPeakEquity();
						const curEq = latestEquity > 0 ? latestEquity : peak;
						const dd = riskManager.getDrawdownPct(curEq, peak);
						if (dd >= DRAWDOWN_ALERT_PCT) {
							alertReasons.push(`Drawdown ${dd.toFixed(1)}% ≥ ${DRAWDOWN_ALERT_PCT}% threshold`);
						}
					}

					const tradingState = store.getTradingState();
					if (tradingState === "HALTED") {
						alertReasons.push("Trading state HALTED");
					}

					const payloadBase = {
						ts: new Date().toISOString(),
						symbols: [...symbols],
						prices,
						orderbooks,
						openPositionCount: positions.length,
						positionSummary: enriched.map((p) => ({
							id: p.id,
							symbol: p.symbol,
							side: p.side,
							currentPrice: p.currentPrice ?? null,
							pnl: p.pnl != null ? round(p.pnl, 4) : null,
							stopLoss: stopById.get(p.id) ?? null,
						})),
						portfolio,
						riskStatus,
						drawdownAlertThresholdPct: DRAWDOWN_ALERT_PCT,
						stopProximityThresholdPct: STOP_PROXIMITY_PCT,
						tradingState,
						alert: alertReasons.length > 0,
						alertReasons,
					};

					const writeLogLine = async (target: string, fallback: boolean) => {
						const lineObj = {
							...payloadBase,
							executionStatus: "success",
							logPath: target,
							logPathRequested: logPath,
							logPathFallback: fallback,
						};
						const line = JSON.stringify(lineObj);
						await withLock(target, async () => {
							mkdirSync(dirname(target), { recursive: true });
							appendFileSync(target, `${line}\n`, { encoding: "utf8" });
						});
						return line;
					};

					let jsonLine: string;
					try {
						jsonLine = await writeLogLine(logPath, false);
					} catch (err) {
						const code =
							err && typeof err === "object" && "code" in err
								? (err as NodeJS.ErrnoException).code
								: undefined;
						if ((code === "EACCES" || code === "EPERM") && logPath !== homeFallbackLog) {
							jsonLine = await writeLogLine(homeFallbackLog, true);
						} else {
							throw err;
						}
					}

					if (alertReasons.length > 0 && onDailyDisciplineAlert) {
						const message = `Daily crypto check: ${alertReasons.slice(0, 5).join("; ")}${alertReasons.length > 5 ? "…" : ""}`;
						await onDailyDisciplineAlert({ reasons: alertReasons, message });
					}

					return jsonLine;
				} catch (runErr) {
					await appendExecutionFailure(runErr);
					throw runErr;
				}
			};

			if (nonBlocking) {
				const handle = tryAcquireLock(runLock, { staleThresholdMs: 600_000 });
				if (!handle) {
					return JSON.stringify({
						ts: new Date().toISOString(),
						skipped: true,
						reason: "daily_crypto_discipline_lock_active",
					});
				}
				try {
					return await runOnce();
				} finally {
					handle.release();
				}
			}

			return withLock(runLock, runOnce, {
				timeoutMs: 300_000,
				retryIntervalMs: 250,
				staleThresholdMs: 600_000,
			});
		},

		trade_get_prices: async (args: Record<string, unknown>): Promise<string> => {
			const symbols = args.symbols as string[];
			if (!symbols?.length) throw new Error("symbols array is required");

			// Limit to 20 symbols and fetch in batches of 5 to respect exchange rate limits
			const capped = symbols.slice(0, 20);
			const BATCH_SIZE = 5;
			const results: Array<
				ReturnType<typeof spotQuoteFromTicker> | { symbol: string; price: null; error: string }
			> = [];
			for (let i = 0; i < capped.length; i += BATCH_SIZE) {
				const batch = capped.slice(i, i + BATCH_SIZE);
				const batchResults = await Promise.all(
					batch.map(async (s) => {
						try {
							const ticker = await client.getTicker(normalizeSymbol(s));
							return spotQuoteFromTicker(ticker);
						} catch (err) {
							console.debug(
								"[trading] getTicker failed for",
								s,
								err instanceof Error ? err.message : err,
							);
							return { symbol: normalizeSymbol(s), price: null, error: "Not found" };
						}
					}),
				);
				results.push(...batchResults);
			}
			const payload = { results };
			tradeGetPricesResponseSchema.parse(payload);
			return JSON.stringify(payload);
		},

		trade_get_orderbook: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			const rawDepth = (args.depth as number) || 10;
			const depth = Math.min(50, Math.max(1, rawDepth));
			const book = await client.getOrderBook(symbol, depth);
			return JSON.stringify({
				symbol: book.symbol,
				bestBid: book.bids[0]?.price,
				bestAsk: book.asks[0]?.price,
				spread:
					book.asks[0] && book.bids[0]
						? (((book.asks[0].price - book.bids[0].price) / book.bids[0].price) * 100).toFixed(4) +
							"%"
						: null,
				bids: book.bids.slice(0, depth),
				asks: book.asks.slice(0, depth),
			});
		},

		// ── Read-only: account ──

		trade_get_balances: async (): Promise<string> => {
			if (!client.hasCredentials) {
				return JSON.stringify({
					error:
						"No API credentials configured. Set trading.apiKey and trading.apiSecret in zaraa.config.json",
				});
			}
			const balances = await client.getBalances();
			const nonZero = balances.filter((b) => b.total > 0);
			return JSON.stringify(nonZero);
		},

		trade_get_positions: async (): Promise<string> => {
			const positions = store.getOpenPositions();
			if (positions.length === 0) {
				return JSON.stringify({ message: "No open positions tracked." });
			}
			return JSON.stringify(positions);
		},

		/**
		 * Verify exchange API connectivity before allowing live trading.
		 *
		 * Tests both public endpoints (ticker data) and private endpoints
		 * (account balances) to ensure credentials are valid and the exchange
		 * is reachable. Should be called on startup before enabling live mode.
		 */
		trade_verify_exchange: async (): Promise<string> => {
			if (!deps.executionManager) {
				// Fallback: test manually without ExecutionManager
				let publicOk = false;
				let privateOk = false;
				let error: string | undefined;

				try {
					await client.getTicker("BTC_USDT");
					publicOk = true;
				} catch (err) {
					error = `Public API: ${err instanceof Error ? err.message : String(err)}`;
				}

				if (client.hasCredentials) {
					try {
						await client.getBalances();
						privateOk = true;
					} catch (err) {
						error = `Private API: ${err instanceof Error ? err.message : String(err)}`;
					}
				} else {
					error = (error ? `${error}; ` : "") + "No API credentials configured";
				}

				const connected = publicOk && privateOk;
				recordPreLiveExchangeVerified(store, connected);
				return JSON.stringify({
					connected,
					publicApi: publicOk,
					privateApi: privateOk,
					hasCredentials: client.hasCredentials,
					paperMode: isPaperMode(),
					error,
					message: connected
						? "Exchange connectivity verified — public and private APIs are reachable."
						: publicOk
							? "Public API reachable but private API unavailable. Live trading requires valid credentials."
							: "Exchange unreachable. Check network connectivity.",
				});
			}

			const result = await deps.executionManager.verifyExchangeConnectivity();
			recordPreLiveExchangeVerified(store, result.connected);
			return JSON.stringify({
				...result,
				hasCredentials: client.hasCredentials,
				paperMode: isPaperMode(),
				message: result.connected
					? "Exchange connectivity verified — public and private APIs are reachable."
					: result.publicApi
						? "Public API reachable but private API unavailable. Live trading requires valid credentials."
						: "Exchange unreachable. Check network connectivity.",
			});
		},

		// ── Alerts ──

		trade_set_alert: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			const condition = args.condition as "above" | "below";
			const targetPrice = args.target_price as number;

			if (!condition || !["above", "below"].includes(condition)) {
				throw new Error('condition must be "above" or "below"');
			}
			if (!targetPrice || targetPrice <= 0) {
				throw new Error("target_price must be a positive number");
			}

			const alert = store.createAlert({ symbol, condition, targetPrice });
			emitTradingEvent("trading.alert.created", {
				id: alert.id,
				symbol,
				condition,
				targetPrice,
				reason: "trade_set_alert",
			});
			if (onTradingEvent) {
				const snapshot = await buildSnapshotUpdated("trade_set_alert");
				emitTradingEvent("trading.snapshot.updated", snapshot);
			}
			return JSON.stringify({
				id: alert.id,
				message: `Alert set: ${symbol} ${condition} $${targetPrice}`,
			});
		},

		trade_list_alerts: async (args: Record<string, unknown> = {}): Promise<string> => {
			const overnightBriefing = args.overnight_briefing === true;
			if (overnightBriefing) {
				const sinceMs = Date.now() - 18 * 60 * 60 * 1000;
				const sinceIso = new Date(sinceMs).toISOString();
				const active = store.getActiveAlerts();
				const triggeredOvernight = store.getTriggeredAlertsSince(sinceIso);
				return JSON.stringify({
					active,
					triggeredOvernight,
					sinceIso,
					note: "triggeredOvernight = price alerts that fired in the last ~18h (overnight proxy).",
				});
			}

			const alerts = store.getActiveAlerts();
			if (alerts.length === 0) {
				return JSON.stringify({ message: "No active price alerts." });
			}
			// Untriggered alerts had no staleness signal at all (alert-triage-ladder.md,
			// ngt-1347 addendum: a real 74-day-old alert sat with no mechanism to ever
			// surface "still relevant?"). Purely additive read-side annotation — does
			// not touch alert creation/triggering/execution.
			// ponytail: fixed 30-day threshold, not configurable — promote to a
			// zaraa.config.json field if a real need for a different window shows up.
			const STALE_ALERT_DAYS = 30;
			const annotated = alerts.map((alert) => {
				if (alert.triggered) return alert;
				const daysOpen = Math.floor(
					(Date.now() - new Date(alert.createdAt).getTime()) / (24 * 60 * 60 * 1000),
				);
				return { ...alert, daysOpen, isStale: daysOpen > STALE_ALERT_DAYS };
			});
			return JSON.stringify(annotated);
		},

		trade_delete_alert: async (args: Record<string, unknown>): Promise<string> => {
			const id = args.id as string;
			const deleted = store.deleteAlert(id);
			if (deleted) {
				emitTradingEvent("trading.alert.deleted", {
					id,
					reason: "trade_delete_alert",
				});
				if (onTradingEvent) {
					const snapshot = await buildSnapshotUpdated("trade_delete_alert");
					emitTradingEvent("trading.snapshot.updated", snapshot);
				}
			}
			return JSON.stringify({
				deleted,
				message: deleted ? "Alert deleted." : "Alert not found.",
			});
		},

		// ── Trading (requires approval) ──

		trade_buy: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			let qty = Number(args.qty);
			const requestedType = args.type as "MARKET" | "LIMIT" | undefined;
			const { type, routeDecision } = resolveAdaptiveOrderType(symbol, requestedType, "MARKET");
			const price = args.price != null ? Number(args.price) : undefined;
			const userStopLoss = args.stop_loss != null ? Number(args.stop_loss) : undefined;
			const userTakeProfit = args.take_profit != null ? Number(args.take_profit) : undefined;
			const userTrailingStopPct =
				args.trailing_stop_pct != null ? Number(args.trailing_stop_pct) : undefined;
			// Direction: "long" (default for manual buys) or "short" (from signal engine)
			const direction = (args.direction as "long" | "short") || "long";
			const isShort = direction === "short";
			// Optional signal-engine linkage — when present we also write a
			// strategy_trades row so the learning loop can grade the outcome on close.
			const signalId =
				typeof args.signal_id === "string" && args.signal_id.length > 0
					? args.signal_id
					: undefined;
			const strategyName =
				typeof args.strategy_name === "string" && args.strategy_name.length > 0
					? args.strategy_name
					: undefined;
			const confidence = args.confidence != null ? Number(args.confidence) : undefined;
			// Determine paper mode early so we use it consistently throughout this handler
			const { paperMode, shadowMode: isShadowMode } = snapshotTradingModes();
			if (!paperMode && !isShadowMode && zaraaTradingPaperMode !== false) {
				return JSON.stringify({
					error:
						"Live entry blocked: zaraa.config.json trading.paperMode was not explicitly verified false.",
				});
			}

			// Live-mode lock guard — must match today's date-stamped confirmation
			const lockError = validateLiveModeLock(paperMode);
			if (lockError) return lockError;
			if (!paperMode && !isShadowMode) {
				if (isShort) {
					return JSON.stringify({
						error:
							"Live short entries are disabled until venue borrow, margin, and liability NAV are enforced.",
					});
				}
				if (!riskManager || !circuitBreaker) {
					return JSON.stringify({
						error: "Live entry blocked: RiskManager and circuit breaker are required.",
					});
				}
				try {
					await refreshLiveAccountEquity({ client, store });
				} catch (err) {
					return JSON.stringify({
						error: `Live entry blocked: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}

			const riskIsPaper = paperMode || isShadowMode;
			const riskSnapshot = buildAutomatedRiskLockSnapshot({
				store,
				isPaperMode: riskIsPaper,
			});
			if (!paperMode && !isShadowMode && riskSnapshot.triggered) {
				await enforceAutomatedRiskSnapshot(riskSnapshot, false);
			}
			const killGate = evaluateTradingKillGate({
				store,
				circuitBreaker,
				isPaperMode: riskIsPaper,
				precomputedRiskLock: riskSnapshot,
			});
			if (!killGate.allowed) {
				return JSON.stringify({
					error: killGate.reason ?? "New entries blocked by trading kill gate",
				});
			}

			// Validate numeric inputs
			if (!Number.isFinite(qty) || qty <= 0) {
				return JSON.stringify({ error: "qty must be a positive finite number" });
			}
			if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
				return JSON.stringify({ error: "price must be a positive finite number" });
			}
			if (userStopLoss !== undefined && (!Number.isFinite(userStopLoss) || userStopLoss <= 0)) {
				return JSON.stringify({ error: "stop_loss must be a positive finite number" });
			}
			if (
				userTakeProfit !== undefined &&
				(!Number.isFinite(userTakeProfit) || userTakeProfit <= 0)
			) {
				return JSON.stringify({ error: "take_profit must be a positive finite number" });
			}

			// Stop-loss direction validation (direction-aware)
			if (userStopLoss !== undefined && price !== undefined) {
				if (!isShort && userStopLoss >= price) {
					return JSON.stringify({
						error: "stop_loss must be BELOW entry price for a long position",
					});
				}
				if (isShort && userStopLoss <= price) {
					return JSON.stringify({
						error: "stop_loss must be ABOVE entry price for a short position",
					});
				}
			}
			// Take-profit direction validation
			if (userTakeProfit !== undefined && price !== undefined) {
				if (!isShort && userTakeProfit <= price) {
					return JSON.stringify({
						error: "take_profit must be ABOVE entry price for a long position",
					});
				}
				if (isShort && userTakeProfit >= price) {
					return JSON.stringify({
						error: "take_profit must be BELOW entry price for a short position",
					});
				}
			}

			// Safety checks — warn when using hardcoded defaults
			const maxTradeRaw = store.getSetting("max_trade_usd");
			if (!maxTradeRaw) console.warn("[trading] max_trade_usd not configured — using default $50");
			const maxTrade = parsePositiveSetting(maxTradeRaw, 50);
			const dailyLimitRaw = store.getSetting("daily_limit_usd");
			if (!dailyLimitRaw)
				console.warn("[trading] daily_limit_usd not configured — using default $200");
			const dailyLimit = parsePositiveSetting(dailyLimitRaw, 200);

			// Estimate cost — fetch live ask price
			let estimatedPrice: number = price ?? 0;
			if (!estimatedPrice) {
				const ticker = await client.getTicker(symbol);
				estimatedPrice = ticker.ask;
			}
			if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0) {
				return JSON.stringify({ error: "Could not determine a valid price for this symbol" });
			}
			const bookSnapshot = await getExecutionBookSnapshot(symbol);

			// Validate stop-loss direction against estimated price too (for market orders without explicit price)
			if (userStopLoss !== undefined) {
				if (!isShort && userStopLoss >= estimatedPrice) {
					return JSON.stringify({
						error: `stop_loss ($${userStopLoss}) must be BELOW current price ($${estimatedPrice.toFixed(2)}) for a long`,
					});
				}
				if (isShort && userStopLoss <= estimatedPrice) {
					return JSON.stringify({
						error: `stop_loss ($${userStopLoss}) must be ABOVE current price ($${estimatedPrice.toFixed(2)}) for a short`,
					});
				}
			}

			// Add slippage buffer to cost estimate for market orders (1% for safety).
			// This buffer is applied consistently to ALL pre-trade checks — handler
			// dollar limits, PreTradeValidator, paper balance checks, and shadow mode —
			// so a single trade cannot slip past max_trade_usd due to formula mismatch.
			const SLIPPAGE_BUFFER = type === "MARKET" ? 1.01 : 1.0;
			const slippageAdjustedPrice = estimatedPrice * SLIPPAGE_BUFFER;
			let estimatedTotal = qty * slippageAdjustedPrice;

			// ── Position graduation cap ─────────────────────────────────────
			if (positionGraduation) {
				const stats = {
					totalTrades: store.getTradeCount?.() ?? 0,
					winRate: store.getWinRate?.() ?? 0,
				};
				const gradMaxUsd = positionGraduation.getCurrentMaxUsd(stats);
				if (estimatedTotal > gradMaxUsd) {
					const cappedQty = gradMaxUsd / slippageAdjustedPrice;
					console.warn(
						`[trade_buy] Position graduation cap: $${estimatedTotal.toFixed(2)} → $${gradMaxUsd.toFixed(2)} (qty ${qty} → ${cappedQty.toFixed(6)})`,
					);
					qty = cappedQty;
					estimatedTotal = gradMaxUsd;
				}
			}

			// ── Flash crash guard ────────────────────────────────────────────
			if (flashCrashDetector) {
				const crashResult = flashCrashDetector.checkFlashCrash(symbol);
				if (crashResult.detected) {
					return JSON.stringify({
						error: `Trade blocked: flash crash detected on ${symbol} (${crashResult.dropPct.toFixed(1)}% drop). Recommendation: ${crashResult.recommendation}`,
					});
				}
			}

			// ── Max positions guard ─────────────────────────────────────────
			if (maxPositionsGuard) {
				const openPositions = store.getOpenPositions();
				const posCheck = maxPositionsGuard.canOpenPosition(
					{ symbol, exchange: client.exchangeId ?? "unknown" },
					openPositions.map((p) => ({ symbol: p.symbol, exchange: p.exchange ?? "unknown" })),
				);
				if (!posCheck.allowed) {
					return JSON.stringify({ error: posCheck.reason });
				}
			}

			if (estimatedTotal > maxTrade) {
				return JSON.stringify({
					error: `Trade exceeds max per-trade limit ($${maxTrade}). Estimated total (incl. 1% slippage buffer): $${estimatedTotal.toFixed(2)}. Adjust with trade_set_limit.`,
				});
			}

			// Daily spend is tracked separately for paper vs live to avoid cross-contamination
			const dailySpend = store.getDailySpend(paperMode);
			if (dailySpend + estimatedTotal > dailyLimit) {
				return JSON.stringify({
					error: `Trade would exceed daily limit ($${dailyLimit})${paperMode ? " [paper]" : ""}. Already spent today: $${dailySpend.toFixed(2)}. Estimated total: $${estimatedTotal.toFixed(2)}.`,
				});
			}

			// Risk manager is required — without it trades bypass position sizing and drawdown limits.
			if (!riskManager) {
				return JSON.stringify({
					error:
						"RiskManager is required for trade execution — trading is not configured correctly",
				});
			}

			let autoStopLoss = userStopLoss;
			let autoTakeProfit = userTakeProfit;
			if (riskManager) {
				const openPositions = store.getOpenPositions();
				const peakEquity = store.getPeakEquity();
				const latestEquity = store.getLatestEquity();
				// Use latest equity (current capital) for sizing and risk checks.
				// Peak equity is only used for drawdown calculations.
				const accountEquity =
					latestEquity > 0
						? latestEquity
						: peakEquity > 0
							? peakEquity
							: parsePositiveSetting(store.getSetting("daily_limit_usd"), 100) * 2;

				// Try to get ATR for smart stop-loss
				let atrValue: number | undefined;
				if (candleStore) {
					const sorted = candleStore.getAscending(symbol, "1h", 50);
					if (sorted.length >= 15) {
						const highs = sorted.map((c) => c.high);
						const lows = sorted.map((c) => c.low);
						const closes = sorted.map((c) => c.close);
						const atrVals = indicators.atr(highs, lows, closes, 14);
						if (atrVals.length > 0) {
							atrValue = atrVals[atrVals.length - 1];
						}
					}
				}

				const validation = riskManager.validateTrade({
					entryPrice: estimatedPrice,
					qty,
					side: direction,
					symbol,
					accountEquity,
					peakEquity: peakEquity > 0 ? peakEquity : accountEquity,
					openPositions,
					atrValue,
					consecutiveLosses: store.getConsecutiveLosses(),
				});

				if (!validation.allowed) {
					return JSON.stringify({
						error: "Trade blocked by risk manager",
						reasons: validation.reasons,
						suggested: validation.suggested,
					});
				}

				// Auto-calculate stops if not provided by user (direction-aware)
				if (!autoStopLoss && atrValue) {
					autoStopLoss = riskManager.calculateStopLoss(estimatedPrice, atrValue, direction);
				}
				if (!autoTakeProfit && autoStopLoss) {
					autoTakeProfit = riskManager.calculateTakeProfit(estimatedPrice, autoStopLoss);
				}
			}

			// Fallback stop-loss: if neither the user nor the risk manager produced one,
			// use a conservative 2% from the current price (direction-aware).
			if (!autoStopLoss) {
				autoStopLoss = isShort
					? Math.round(estimatedPrice * 1.02 * 100) / 100 // 2% above for shorts
					: Math.round(estimatedPrice * 0.98 * 100) / 100; // 2% below for longs
			}

			// Validate that the stop-loss is not absurdly tight or loose.
			const stopDistancePct = (Math.abs(estimatedPrice - autoStopLoss) / estimatedPrice) * 100;
			if (stopDistancePct < 0.1) {
				return JSON.stringify({
					error: `stop_loss ($${autoStopLoss}) is too tight — only ${stopDistancePct.toFixed(3)}% from entry ($${estimatedPrice.toFixed(2)}). Market noise will immediately trigger it. Minimum distance: 0.1%.`,
				});
			}
			if (stopDistancePct > 20) {
				return JSON.stringify({
					error: `stop_loss ($${autoStopLoss}) is too far away — ${stopDistancePct.toFixed(1)}% from entry ($${estimatedPrice.toFixed(2)}). This allows a ${stopDistancePct.toFixed(0)}% loss before exiting. Maximum distance: 20%.`,
				});
			}

			// ── Shadow execution mode ─────────────────────────────────────
			// Shadow mode has its own distinct flag, independent of paperMode.
			// If shadow_mode is enabled, we NEVER place real orders — regardless
			// of paperMode's value.  Check order: shadow → paper → live.
			if (isShadowMode) {
				// Verify credentials are present (same as live path)
				if (!client.hasCredentials) {
					return JSON.stringify({
						error: "Cannot run shadow execution without API credentials.",
						mode: "SHADOW",
					});
				}

				// Re-fetch price for drift check (same as live path)
				if (type === "MARKET") {
					const freshTicker = await client.getTicker(symbol);
					const freshPrice = freshTicker.ask;
					const priceDrift = Math.abs(freshPrice - estimatedPrice) / estimatedPrice;
					if (priceDrift > 0.02) {
						return JSON.stringify({
							error: `[SHADOW] Price moved ${(priceDrift * 100).toFixed(1)}% since estimate ($${estimatedPrice.toFixed(2)} → $${freshPrice.toFixed(2)}). Re-evaluate before trading.`,
							mode: "SHADOW",
						});
					}
					estimatedPrice = freshPrice;
				}

				// Verify balance (same as live path)
				try {
					const balances = await client.getBalances();
					const quoteCurrency = symbol.split("_")[1] || "USDT";
					const balance = balances.find(
						(b: { currency: string; available: number }) => b.currency === quoteCurrency,
					);
					const available = balance?.available ?? 0;
					const needed = qty * estimatedPrice;
					if (available < needed) {
						return JSON.stringify({
							error: `[SHADOW] Insufficient ${quoteCurrency} balance. Available: $${available.toFixed(2)}, needed: $${needed.toFixed(2)}`,
							mode: "SHADOW",
						});
					}
				} catch (err) {
					console.warn("[trading] shadow balance verification failed:", client.scrubError(err));
					return JSON.stringify({
						error: "[SHADOW] Could not verify account balance. Check credentials and connectivity.",
						mode: "SHADOW",
					});
				}

				console.log(
					`[shadow] Simulating trade, no exchange interaction: ${symbol} ${isShort ? "SELL" : "BUY"} qty=${qty} ` +
						`price=$${estimatedPrice.toFixed(2)} type=${type} ` +
						`stopLoss=${autoStopLoss} takeProfit=${autoTakeProfit ?? "none"}`,
				);

				// ── Record shadow trade in journal (isShadow = true) ─────────
				// Without this, shadow entries from trade_buy are invisible to
				// the learning loop and strategy grader, and can't be filtered
				// out of paper/live aggregates.
				if (tradeJournal && signalId && strategyName) {
					const ctx = tradeJournal.getSignalContext(signalId);
					try {
						tradeJournal.recordTrade({
							signalId,
							strategyName,
							symbol,
							direction,
							entryPrice: estimatedPrice,
							qty,
							regime: ctx?.regime ?? undefined,
							session: ctx?.session ?? undefined,
							isShadow: true,
						});
					} catch (err) {
						console.warn(
							"[trade_buy] journal.recordTrade (shadow) failed:",
							err instanceof Error ? err.message : err,
						);
					}
				}

				// ── Register with ShadowModeExecutor for SL/TP exit tracking ─
				// Without this, shadow trades from the handler path have no exit
				// simulation — unlike execution-manager shadow trades which do.
				if (shadowModeExecutor) {
					const shadowResult = shadowModeExecutor.executeShadow({
						symbol,
						side: isShort ? "SELL" : "BUY",
						qty,
						price: estimatedPrice,
						strategy: strategyName ?? "manual",
						confidence,
					});
					if (shadowResult.preTradeChecksPassed && autoStopLoss && autoTakeProfit) {
						shadowModeExecutor.setStopAndTarget(shadowResult.id, autoStopLoss, autoTakeProfit);
					}
				}

				return JSON.stringify({
					mode: "SHADOW",
					shadow: true,
					symbol,
					side: isShort ? "SELL" : "BUY",
					type,
					qty,
					price: estimatedPrice,
					stopLoss: autoStopLoss ?? null,
					takeProfit: autoTakeProfit ?? null,
					estimatedTotal,
					message: `[SHADOW] Order validated but NOT submitted: ${isShort ? "SELL" : "BUY"} ${qty} ${symbol} @ $${estimatedPrice.toFixed(2)} = $${estimatedTotal.toFixed(2)} (incl. slippage buffer). All pre-trade checks passed.`,
				});
			}

			if (paperMode) {
				// ── PAPER TRADE — simulate locally, no exchange call ──
				// Wrapped in per-symbol AsyncMutex so concurrent paper signals
				// cannot both read stale open-position snapshots and bypass
				// exposure limits. PreTradeValidator runs INSIDE the lock — the
				// same pipeline used by ExecutionManager for signal-engine trades.
				return getHandlerMutex(symbol).run(async () => {
					// ── PreTradeValidator (inside mutex) ──────────────────────────────
					if (riskManager) {
						const openPositions = store.getOpenPositions();
						const peakEquity = store.getPeakEquity();
						const latestEquity = store.getLatestEquity();
						const fallbackEquity = Math.max(
							100,
							parsePositiveSetting(store.getSetting("daily_limit_usd"), 200) * 2,
						);
						const accountEquity =
							latestEquity > 0 ? latestEquity : peakEquity > 0 ? peakEquity : fallbackEquity;
						const peakEq = peakEquity > 0 ? peakEquity : accountEquity;

						const validator = new PreTradeValidator(store, riskManager);
						const validation = validator.validate({
							qty,
							estimatedPrice: slippageAdjustedPrice,
							isPaper: true,
							accountEquity,
							peakEquity: peakEq,
							openPositions,
							side: direction,
							symbol,
							consecutiveLosses: store.getConsecutiveLosses(),
						});

						if (!validation.allowed) {
							console.warn(
								`[trade_buy] Paper trade BLOCKED by PreTradeValidator: ${validation.reason} ` +
									`(symbol=${symbol} qty=${qty} price=$${estimatedPrice.toFixed(2)})`,
							);
							return JSON.stringify({
								error: `Trade blocked by pre-trade validation: ${validation.reason}`,
								mode: "PAPER",
							});
						}
					}

					// Extract currencies from symbol (e.g. "BTC_USDT" → base=BTC, quote=USDT)
					const [baseCurrency, quoteCurrency] = symbol.split("_");
					// Use slippage-buffered cost so the balance check is conservative —
					// prevents paper trades from executing when real execution would fail
					// due to market-order slippage eating into the remaining balance.
					const cost = qty * slippageAdjustedPrice;

					// Check virtual portfolio has enough quote currency (e.g. USDT)
					const virtualBalance = store.getPaperBalance(quoteCurrency ?? "USDT");
					if (virtualBalance < cost) {
						return JSON.stringify({
							error: `Insufficient virtual ${quoteCurrency ?? "USDT"} balance. Available: $${virtualBalance.toFixed(2)}, needed: $${cost.toFixed(2)} (incl. slippage buffer). Use trade_paper_reset to refill.`,
							mode: "PAPER",
						});
					}

					// Quote-currency debit and base-currency credit are reconciled
					// inside store.openPosition (which keeps paper_balances and the
					// positions table in lock-step). The pre-trade balance check
					// above remains the only place we read paper_balances on entry.

					const { slippageBps, routeJson } = buildExecutionRouteJson({
						expectedPrice: estimatedPrice,
						fillPrice: estimatedPrice,
						latencyMs: 0,
						requestedType,
						actualType: type,
						routeDecision,
						bookSnapshot,
						side: isShort ? "SELL" : "BUY",
					});
					const trade = store.logTrade({
						symbol,
						side: isShort ? "SELL" : "BUY",
						type,
						qty,
						price: estimatedPrice,
						isPaper: true,
						slippageBps,
						routeJson,
					});
					const position = store.openPosition({
						symbol,
						side: direction,
						entryPrice: estimatedPrice,
						qty,
						stopLoss: autoStopLoss,
						takeProfit: autoTakeProfit,
						trailingStopPct:
							userTrailingStopPct ?? riskManager?.getConfig().defaultTrailingStopPct ?? undefined,
						isPaper: true,
						slippageBps,
						routeJson,
					});
					if (tradeJournal && signalId && strategyName) {
						const ctx = tradeJournal.getSignalContext(signalId);
						try {
							tradeJournal.recordTrade({
								signalId,
								strategyName,
								symbol,
								direction,
								entryPrice: estimatedPrice,
								qty,
								regime: ctx?.regime ?? undefined,
								session: ctx?.session ?? undefined,
							});
						} catch (err) {
							console.warn(
								"[trade_buy] journal.recordTrade (paper) failed:",
								err instanceof Error ? err.message : err,
							);
						}
					}
					executionQualityController?.recordExecution({
						symbol,
						side: isShort ? "SELL" : "BUY",
						requestedOrderType: requestedType ?? type,
						actualOrderType: type,
						expectedPrice: estimatedPrice,
						fillPrice: estimatedPrice,
						latencyMs: 0,
						book: bookSnapshot,
					});

					const orderAuditCorrelationId = emitTradingOrderAudit("trade_buy", {
						symbol,
						side: isShort ? "SELL" : "BUY",
						mode: "PAPER",
						orderId: undefined,
						positionId: position.id,
						qty,
						resultSummary: `paper ${direction} entry qty=${qty} @ ${estimatedPrice.toFixed(4)}`,
					});

					// Record equity snapshot using current market prices (not entry prices)
					await recordEquitySnapshot({ force: true });

					if (onTradingEvent) {
						const snapshot = await buildSnapshotUpdated("trade_buy");
						emitTradingEvent("trading.snapshot.updated", snapshot);
						emitTradingEvent("trade.executed", {
							symbol,
							side: isShort ? "SELL" : "BUY",
							qty,
							price: estimatedPrice,
							costUsd: cost,
							isPaper: true,
						});
					}

					const effectiveTrailingPct =
						userTrailingStopPct ?? riskManager?.getConfig().defaultTrailingStopPct ?? undefined;
					return JSON.stringify({
						mode: "PAPER",
						orderAuditCorrelationId,
						trade,
						stopLoss: autoStopLoss ?? null,
						takeProfit: autoTakeProfit ?? null,
						trailingStopPct: effectiveTrailingPct ?? null,
						virtualBalance: {
							[quoteCurrency ?? "USDT"]: round(store.getPaperBalance(quoteCurrency ?? "USDT"), 2),
							[baseCurrency ?? symbol]: round(store.getPaperBalance(baseCurrency ?? symbol), 6),
						},
						message: `[PAPER] Buy: ${qty} ${symbol} @ $${estimatedPrice.toFixed(2)} = $${cost.toFixed(2)}${autoStopLoss ? ` | SL: $${autoStopLoss.toFixed(2)}` : ""}${autoTakeProfit ? ` | TP: $${autoTakeProfit.toFixed(2)}` : ""}${effectiveTrailingPct ? ` | Trail: ${effectiveTrailingPct}%` : ""} | Virtual ${quoteCurrency ?? "USDT"} remaining: $${store.getPaperBalance(quoteCurrency ?? "USDT").toFixed(2)}`,
					});
				}); // end mutex.run
			}

			// ═══ LIVE TRADE — extra safety checks ═══
			// Wrapped in per-symbol AsyncMutex to prevent TOCTOU race conditions:
			// without the mutex, two concurrent live trades could both pass dollar
			// limit and risk validation, then both execute — exceeding limits.
			// The PreTradeValidator and dollar checks now run INSIDE the lock so
			// they read the latest committed state.
			if (!client.hasCredentials) {
				return JSON.stringify({
					error: "Cannot execute live trade without API credentials.",
				});
			}

			return getHandlerMutex(symbol).run(async () => {
				try {
					await refreshLiveAccountEquity({ client, store });
				} catch (err) {
					return JSON.stringify({
						error: `Live entry blocked: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
				const insideRiskSnapshot = buildAutomatedRiskLockSnapshot({
					store,
					isPaperMode: false,
				});
				if (insideRiskSnapshot.triggered) {
					await enforceAutomatedRiskSnapshot(insideRiskSnapshot, false);
				}
				const insideKillGate = evaluateTradingKillGate({
					store,
					circuitBreaker,
					isPaperMode: false,
					precomputedRiskLock: insideRiskSnapshot,
				});
				if (!insideKillGate.allowed) {
					return JSON.stringify({
						error: insideKillGate.reason ?? "New entries blocked by trading kill gate",
					});
				}

				// ── Re-validate dollar limits INSIDE mutex (TOCTOU fix) ──────────
				// These checks were previously outside the mutex, allowing two
				// concurrent trades to both pass validation then both execute.
				// Uses the same SLIPPAGE_BUFFER from the outer scope for consistency.
				const liveEstimatedTotal = qty * estimatedPrice * SLIPPAGE_BUFFER;
				if (liveEstimatedTotal > maxTrade) {
					return JSON.stringify({
						error: `Trade exceeds max per-trade limit ($${maxTrade}). Estimated total (incl. 1% slippage buffer): $${liveEstimatedTotal.toFixed(2)}. Adjust with trade_set_limit.`,
					});
				}
				const liveDailySpend = store.getDailySpend(false);
				if (liveDailySpend + liveEstimatedTotal > dailyLimit) {
					return JSON.stringify({
						error: `Trade would exceed daily limit ($${dailyLimit}). Already spent today: $${liveDailySpend.toFixed(2)}. Estimated total: $${liveEstimatedTotal.toFixed(2)}.`,
					});
				}

				// ── Re-validate risk manager INSIDE mutex (TOCTOU fix) ───────────
				if (riskManager) {
					const liveOpenPositions = store.getOpenPositions();
					const liveAccountEquity = requireFreshLiveEquity(store).equity;
					const livePeakEquity = store.getPeakLiveEquity();

					const liveValidation = riskManager.validateTrade({
						entryPrice: estimatedPrice,
						qty,
						side: direction,
						symbol,
						accountEquity: liveAccountEquity,
						peakEquity: livePeakEquity > 0 ? livePeakEquity : liveAccountEquity,
						openPositions: liveOpenPositions,
						consecutiveLosses: store.getConsecutiveLosses(),
					});

					if (!liveValidation.allowed) {
						return JSON.stringify({
							error: "Trade blocked by risk manager",
							reasons: liveValidation.reasons,
							suggested: liveValidation.suggested,
						});
					}
				}

				// Re-fetch price right before execution to check for drift
				if (type === "MARKET") {
					const freshTicker = await client.getTicker(symbol);
					const freshPrice = freshTicker.ask;
					const priceDrift = Math.abs(freshPrice - estimatedPrice) / estimatedPrice;
					if (priceDrift > 0.02) {
						return JSON.stringify({
							error: `Price moved ${(priceDrift * 100).toFixed(1)}% since estimate ($${estimatedPrice.toFixed(2)} → $${freshPrice.toFixed(2)}). Re-evaluate before trading.`,
						});
					}
					// Use the fresher price for tracking
					estimatedPrice = freshPrice;
					// Re-check the per-trade cap against the drift-updated price: the
					// in-mutex check above used the pre-drift estimate, so an upward drift
					// (within the 2% tolerance) could otherwise push notional past max_trade_usd.
					const driftedTotal = qty * estimatedPrice * SLIPPAGE_BUFFER;
					if (driftedTotal > maxTrade) {
						return JSON.stringify({
							error: `Trade exceeds max per-trade limit ($${maxTrade}) after price drift. Estimated total (incl. slippage buffer): $${driftedTotal.toFixed(2)}.`,
						});
					}
				}

				// Verify account has sufficient balance before sending order
				try {
					const balances = await client.getBalances();
					const quoteCurrency = symbol.split("_")[1] || "USDT";
					const balance = balances.find((b) => b.currency === quoteCurrency);
					const available = balance?.available ?? 0;
					const needed = qty * estimatedPrice;
					if (available < needed) {
						return JSON.stringify({
							error: `Insufficient ${quoteCurrency} balance. Available: $${available.toFixed(2)}, needed: $${needed.toFixed(2)}`,
						});
					}
				} catch (err) {
					console.warn("[trading] balance verification failed:", client.scrubError(err));
					return JSON.stringify({
						error: "Could not verify account balance before trade. Aborting for safety.",
					});
				}

				let result: Awaited<ReturnType<typeof client.createOrder>>;
				const executionStartedAt = Date.now();
				try {
					result = await client.createOrder({
						symbol,
						side: isShort ? "SELL" : "BUY",
						type,
						qty,
						price,
					});
				} catch (orderErr) {
					const safeMsg = client.scrubError(orderErr).slice(0, 200);
					return JSON.stringify({
						error: `Order submission failed: ${safeMsg}`,
					});
				}
				const latencyMs = Date.now() - executionStartedAt;
				let fillPrice: number;
				let fullyFilled = false;
				try {
					if (!result.orderId || typeof client.getOrderDetail !== "function") {
						throw new Error("exchange order detail is unavailable");
					}
					const detail = await client.getOrderDetail(symbol, result.orderId);
					if (
						!Number.isFinite(detail.filledQty) ||
						detail.filledQty <= 0 ||
						!Number.isFinite(detail.avgPrice) ||
						detail.avgPrice <= 0
					) {
						throw new Error(
							`exchange fill not confirmed (${detail.status}, qty=${detail.filledQty})`,
						);
					}
					const fillTolerance = Math.max(1e-12, qty * 1e-8);
					fullyFilled =
						detail.status.toUpperCase() === "FILLED" && detail.filledQty + fillTolerance >= qty;
					qty = Math.min(qty, detail.filledQty);
					fillPrice = detail.avgPrice;
					if (!fullyFilled) {
						await client.cancelOrder(symbol, result.orderId).catch(() => undefined);
					}
				} catch (err) {
					return JSON.stringify({
						error: `Buy order submitted but no local position was opened: ${err instanceof Error ? err.message : String(err)}`,
						orderId: result.orderId,
						status: result.status,
						reconcileRequired: true,
					});
				}
				const { slippageBps, routeJson } = buildExecutionRouteJson({
					expectedPrice: estimatedPrice,
					fillPrice,
					latencyMs,
					requestedType,
					actualType: type,
					routeDecision,
					bookSnapshot,
					side: isShort ? "SELL" : "BUY",
				});

				store.logTrade({
					symbol,
					side: isShort ? "SELL" : "BUY",
					type,
					qty,
					price: fillPrice,
					orderId: result.orderId,
					isPaper: false, // live trade — marks it clearly in the log
					slippageBps,
					routeJson,
				});
				// Live entry must record the exchange fee so realized P&L on close
				// is not silently overstated by the round-trip fees. Without this,
				// the consecutive_loss circuit breaker can fail to trip on real
				// losing streaks because fee-funded "wins" are mistakenly counted.
				// Mirrors ExecutionManager._execute() which already passes feeRate.
				const liveEntryFeeRate = Number(store.getSetting("fee_rate") || "0.00075");
				const position = store.openPosition({
					symbol,
					side: direction,
					entryPrice: fillPrice,
					qty,
					stopLoss: autoStopLoss,
					takeProfit: autoTakeProfit,
					trailingStopPct:
						userTrailingStopPct ?? riskManager?.getConfig().defaultTrailingStopPct ?? undefined,
					isPaper: false,
					feeRate: liveEntryFeeRate,
					slippageBps,
					routeJson,
				});
				if (tradeJournal && signalId && strategyName) {
					const ctx = tradeJournal.getSignalContext(signalId);
					try {
						tradeJournal.recordTrade({
							signalId,
							strategyName,
							symbol,
							direction,
							entryPrice: fillPrice,
							qty,
							regime: ctx?.regime ?? undefined,
							session: ctx?.session ?? undefined,
						});
					} catch (err) {
						console.warn(
							"[trade_buy] journal.recordTrade (live) failed:",
							err instanceof Error ? err.message : err,
						);
					}
				}
				executionQualityController?.recordExecution({
					symbol,
					side: isShort ? "SELL" : "BUY",
					requestedOrderType: requestedType ?? type,
					actualOrderType: type,
					expectedPrice: estimatedPrice,
					fillPrice,
					latencyMs,
					book: bookSnapshot,
				});

				const orderAuditCorrelationId = emitTradingOrderAudit("trade_buy", {
					symbol,
					side: isShort ? "SELL" : "BUY",
					mode: "LIVE",
					orderId: result.orderId,
					positionId: position.id,
					qty,
					resultSummary: `live ${direction} orderId=${result.orderId} qty=${qty}`,
				});

				return JSON.stringify({
					mode: "LIVE",
					orderAuditCorrelationId,
					orderId: result.orderId,
					status: result.status,
					partial: !fullyFilled,
					reconcileRequired: !fullyFilled,
					stopLoss: autoStopLoss ?? null,
					takeProfit: autoTakeProfit ?? null,
					message: `Buy order submitted: ${qty} ${symbol} @ ${type === "LIMIT" ? `$${price}` : "market"}${autoStopLoss ? ` | SL: $${autoStopLoss.toFixed(2)}` : ""}${autoTakeProfit ? ` | TP: $${autoTakeProfit.toFixed(2)}` : ""}`,
				});
			}); // end live mutex.run
		},

		/**
		 * Solana on-chain swap via Jupiter v6 (USDC ↔ listed tokens in SOLANA_TOKENS).
		 * Symbol must be `solana:SOL`, `solana:JUP`, etc. Paper by default; live requires
		 * `paper_mode=false`, `confirm_live=true`, and `SOLANA_DEX_SECRET_KEY` (base58).
		 */
		trade_dex_swap: async (args: Record<string, unknown>): Promise<string> => {
			const symbolRaw = String(args.symbol ?? "").trim();
			if (!isDexSolanaExecutionSymbol(symbolRaw)) {
				return JSON.stringify({
					error:
						"Invalid symbol. Use solana:TOKEN (e.g. solana:SOL). Token must be listed in SOLANA_TOKENS (SOL, USDC, JUP, RAY, BONK, WIF).",
				});
			}
			const token = parseSolanaDexTokenSymbol(symbolRaw)!;
			const qty = Number(args.qty);
			const direction = (args.direction as "long" | "short") || "long";
			const userStopLoss = args.stop_loss != null ? Number(args.stop_loss) : undefined;
			const userTakeProfit = args.take_profit != null ? Number(args.take_profit) : undefined;
			const userTrailingStopPct =
				args.trailing_stop_pct != null ? Number(args.trailing_stop_pct) : undefined;
			const slippageBpsArg = args.slippage_bps != null ? Number(args.slippage_bps) : undefined;
			const confirmLive = args.confirm_live === true;
			const paperMode = isPaperMode();
			if (!paperMode) {
				return JSON.stringify({
					error:
						"Live Solana DEX execution is disabled until wallet NAV and confirmed transaction receipts are enforced.",
				});
			}

			// Live-mode lock guard — must match today's date-stamped confirmation
			const lockErrorDex = validateLiveModeLock(paperMode);
			if (lockErrorDex) return lockErrorDex;

			const killGate = evaluateTradingKillGate({
				store,
				circuitBreaker,
				isPaperMode: paperMode,
			});
			if (!killGate.allowed) {
				return JSON.stringify({
					error: killGate.reason ?? "New entries blocked by trading kill gate",
				});
			}

			if (!Number.isFinite(qty) || qty <= 0) {
				return JSON.stringify({ error: "qty must be a positive finite number" });
			}

			const secretFromEnv =
				typeof process.env.SOLANA_DEX_SECRET_KEY === "string"
					? process.env.SOLANA_DEX_SECRET_KEY.trim()
					: "";
			const secret = secretFromEnv || (solanaDexSecretKeyBase58?.trim() ?? "");

			const executor = new JupiterSwapExecutor({
				store,
				rpcUrl: solanaRpcUrl,
				secretKeyBase58: secret || undefined,
			});

			let preview: Awaited<ReturnType<JupiterSwapExecutor["quoteAndSwapPaper"]>>;
			try {
				preview = await executor.quoteAndSwapPaper({
					tokenSymbol: token,
					direction,
					qty,
					slippageBps: Number.isFinite(slippageBpsArg) ? slippageBpsArg : undefined,
				});
			} catch (e) {
				return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
			}

			const maxTrade = parsePositiveSetting(store.getSetting("max_trade_usd"), 50);
			const dailyLimit = parsePositiveSetting(store.getSetting("daily_limit_usd"), 200);
			const cexSpend = store.getDailySpend(paperMode);
			const dexSpend = store.getDexSolanaDailySpend(paperMode);
			if (preview.notionalUsd > maxTrade) {
				return JSON.stringify({
					error: `DEX swap notional $${preview.notionalUsd.toFixed(2)} exceeds max_trade_usd ($${maxTrade}).`,
				});
			}
			if (cexSpend + dexSpend + preview.notionalUsd > dailyLimit) {
				return JSON.stringify({
					error:
						`DEX swap would exceed daily_limit_usd ($${dailyLimit}). ` +
						`CEX today: $${cexSpend.toFixed(2)}, DEX today: $${dexSpend.toFixed(2)}, this swap ~$${preview.notionalUsd.toFixed(2)}.`,
				});
			}

			// Risk manager is required — without it DEX trades bypass position sizing and drawdown limits.
			if (!riskManager) {
				return JSON.stringify({
					error:
						"RiskManager is required for DEX trade execution — trading is not configured correctly",
				});
			}

			const estimatedPrice = preview.entryPriceUsd;
			let autoStopLoss = userStopLoss;
			let autoTakeProfit = userTakeProfit;
			if (userStopLoss !== undefined && (!Number.isFinite(userStopLoss) || userStopLoss <= 0)) {
				return JSON.stringify({ error: "stop_loss must be a positive finite number" });
			}
			if (
				userTakeProfit !== undefined &&
				(!Number.isFinite(userTakeProfit) || userTakeProfit <= 0)
			) {
				return JSON.stringify({ error: "take_profit must be a positive finite number" });
			}
			if (autoStopLoss !== undefined) {
				if (direction === "long" && autoStopLoss >= estimatedPrice) {
					return JSON.stringify({
						error: `stop_loss ($${autoStopLoss}) must be BELOW entry (~$${estimatedPrice.toFixed(4)}) for a long`,
					});
				}
				if (direction === "short" && autoStopLoss <= estimatedPrice) {
					return JSON.stringify({
						error: `stop_loss ($${autoStopLoss}) must be ABOVE entry (~$${estimatedPrice.toFixed(4)}) for a short`,
					});
				}
			}

			// Try to fetch ATR from candle store for dynamic stop-loss sizing
			let dexAtrValue: number | undefined;
			if (candleStore) {
				const atrSymbol = `${token}_USDT`;
				const sorted = candleStore.getAscending(atrSymbol, "1h", 50);
				if (sorted.length >= 15) {
					const highs = sorted.map((c) => c.high);
					const lows = sorted.map((c) => c.low);
					const closes = sorted.map((c) => c.close);
					const atrVals = indicators.atr(highs, lows, closes, 14);
					if (atrVals.length > 0) {
						dexAtrValue = atrVals[atrVals.length - 1];
					}
				}
			}

			if (riskManager) {
				const openPositions = store.getOpenPositions();
				const peakEquity = store.getPeakEquity();
				const latestEquity = store.getLatestEquity();
				const accountEquity =
					latestEquity > 0
						? latestEquity
						: peakEquity > 0
							? peakEquity
							: Math.max(100, parsePositiveSetting(store.getSetting("daily_limit_usd"), 200) * 2);
				const validation = riskManager.validateTrade({
					entryPrice: estimatedPrice,
					qty,
					side: direction,
					symbol: symbolRaw,
					accountEquity,
					peakEquity: peakEquity > 0 ? peakEquity : accountEquity,
					openPositions,
					atrValue: dexAtrValue,
					consecutiveLosses: store.getConsecutiveLosses(),
				});
				if (!validation.allowed) {
					return JSON.stringify({
						error: "Trade blocked by risk manager",
						reasons: validation.reasons,
						suggested: validation.suggested,
					});
				}
				if (!autoStopLoss) {
					if (dexAtrValue) {
						const dexMult = riskManager.getConfig().dexStopAtrMultiplier ?? 2.0;
						let rawStop = riskManager.calculateStopLoss(
							estimatedPrice,
							dexAtrValue,
							direction,
							dexMult,
						);
						// Clamp ATR-derived stop to [1%, 5%] of entry — floor avoids noise triggers,
						// cap keeps risk bounded for volatile on-chain assets.
						const stopPct = (Math.abs(estimatedPrice - rawStop) / estimatedPrice) * 100;
						if (stopPct < 1) {
							rawStop =
								direction === "short"
									? Math.round(estimatedPrice * 1.01 * 100) / 100
									: Math.round(estimatedPrice * 0.99 * 100) / 100;
						} else if (stopPct > 5) {
							rawStop =
								direction === "short"
									? Math.round(estimatedPrice * 1.05 * 100) / 100
									: Math.round(estimatedPrice * 0.95 * 100) / 100;
						}
						autoStopLoss = rawStop;
					} else {
						autoStopLoss =
							direction === "short"
								? Math.round(estimatedPrice * 1.02 * 100) / 100
								: Math.round(estimatedPrice * 0.98 * 100) / 100;
					}
				}
				if (!autoTakeProfit && autoStopLoss) {
					autoTakeProfit = riskManager.calculateTakeProfit(estimatedPrice, autoStopLoss);
				}
			}

			if (!autoStopLoss) {
				if (dexAtrValue) {
					const dexMult = riskManager?.getConfig().dexStopAtrMultiplier ?? 2.0;
					let rawStop =
						direction === "short"
							? estimatedPrice + dexAtrValue * dexMult
							: estimatedPrice - dexAtrValue * dexMult;
					const stopPct = (Math.abs(estimatedPrice - rawStop) / estimatedPrice) * 100;
					if (stopPct < 1) {
						rawStop =
							direction === "short"
								? Math.round(estimatedPrice * 1.01 * 100) / 100
								: Math.round(estimatedPrice * 0.99 * 100) / 100;
					} else if (stopPct > 5) {
						rawStop =
							direction === "short"
								? Math.round(estimatedPrice * 1.05 * 100) / 100
								: Math.round(estimatedPrice * 0.95 * 100) / 100;
					}
					autoStopLoss = Math.round(rawStop * 100) / 100;
				} else {
					autoStopLoss =
						direction === "short"
							? Math.round(estimatedPrice * 1.02 * 100) / 100
							: Math.round(estimatedPrice * 0.98 * 100) / 100;
				}
			}
			if (!autoTakeProfit && autoStopLoss) {
				autoTakeProfit = riskManager
					? riskManager.calculateTakeProfit(estimatedPrice, autoStopLoss)
					: direction === "short"
						? Math.round(estimatedPrice * 0.96 * 100) / 100
						: Math.round(estimatedPrice * 1.04 * 100) / 100;
			}

			const stopDistancePct = (Math.abs(estimatedPrice - autoStopLoss!) / estimatedPrice) * 100;
			if (stopDistancePct < 0.1) {
				return JSON.stringify({
					error: `stop_loss too tight (${stopDistancePct.toFixed(3)}% from entry). Minimum 0.1%.`,
				});
			}
			if (stopDistancePct > 20) {
				return JSON.stringify({
					error: `stop_loss too wide (${stopDistancePct.toFixed(1)}% from entry). Maximum 20%.`,
				});
			}

			if (paperMode) {
				if (direction === "long") {
					const usdt = store.getPaperBalance("USDT");
					if (usdt < preview.notionalUsd) {
						return JSON.stringify({
							error: `Insufficient virtual USDT. Need ~$${preview.notionalUsd.toFixed(2)}, have $${usdt.toFixed(2)}.`,
							mode: "PAPER",
						});
					}
					store.updatePaperBalance("USDT", -preview.notionalUsd);
					store.updatePaperBalance(token, qty);
				} else {
					const balTok = store.getPaperBalance(token);
					if (balTok < qty) {
						return JSON.stringify({
							error: `Insufficient virtual ${token}. Need ${qty}, have ${balTok.toFixed(6)}.`,
							mode: "PAPER",
						});
					}
					store.updatePaperBalance(token, -qty);
					store.updatePaperBalance("USDT", preview.notionalUsd);
				}

				const { positionId } = executor.recordOpen({
					result: preview,
					direction,
					stopLoss: autoStopLoss!,
					takeProfit: autoTakeProfit!,
					trailingStopPct:
						userTrailingStopPct ?? riskManager?.getConfig().defaultTrailingStopPct ?? undefined,
					isPaper: true,
					feeRate: 0,
				});

				const orderAuditCorrelationId = emitTradingOrderAudit("trade_dex_swap", {
					symbol: symbolRaw,
					side: direction === "short" ? "SELL" : "BUY",
					mode: "PAPER",
					orderId: undefined,
					positionId,
					qty,
					resultSummary: `paper jupiter ${direction} ${token} qty=${qty} ~$${preview.notionalUsd.toFixed(2)}`,
				});

				// Record equity snapshot using current market prices (not entry prices)
				await recordEquitySnapshot({ force: true });

				emitTradingEvent("trading.heartbeat.checkin", {
					componentId: "trading:chain-solana",
					mode: "PAPER",
				});

				return JSON.stringify({
					mode: "PAPER",
					venue: "dex_solana",
					orderAuditCorrelationId,
					positionId,
					notionalUsd: round(preview.notionalUsd, 2),
					entryPriceUsd: round(preview.entryPriceUsd, 6),
					stopLoss: autoStopLoss,
					takeProfit: autoTakeProfit,
					message: `[PAPER] Jupiter ${direction} ${qty} ${token} (~$${preview.notionalUsd.toFixed(2)})`,
				});
			}

			if (!confirmLive) {
				return JSON.stringify({
					error:
						"LIVE Solana DEX requires confirm_live=true. You are in live DB mode — this submits a real on-chain swap.",
				});
			}
			if (!secret) {
				return JSON.stringify({
					error:
						"Set SOLANA_DEX_SECRET_KEY (base58) or solanaDexSecretKeyBase58 in deps for live DEX swaps.",
				});
			}

			// Wrap live DEX execution in per-symbol mutex so concurrent
			// trade_dex_swap calls cannot both pass the daily-spend check
			// and both submit on-chain (same pattern as CEX trade_buy).
			return getHandlerMutex(token).run(async () => {
				// ── Re-validate daily limits INSIDE mutex (TOCTOU fix) ──────────
				const liveDexSpend = store.getDexSolanaDailySpend(paperMode);
				const liveCexSpend = store.getDailySpend(paperMode);
				if (
					liveCexSpend + liveDexSpend + preview.notionalUsd >
					parsePositiveSetting(store.getSetting("daily_limit_usd"), 200)
				) {
					return JSON.stringify({
						error:
							`DEX swap would exceed daily_limit_usd (re-checked inside mutex). ` +
							`CEX today: $${liveCexSpend.toFixed(2)}, DEX today: $${liveDexSpend.toFixed(2)}, this swap ~$${preview.notionalUsd.toFixed(2)}.`,
					});
				}

				// ── Re-validate RiskManager % limits INSIDE mutex (TOCTOU fix) ──
				// The outer riskManager.validateTrade ran with a stale openPositions
				// snapshot; if a concurrent trade already committed since then, the
				// new position could push exposure beyond maxExposurePct or breach
				// per-asset position counts before we'd notice. Mirrors the CEX
				// trade_buy live path which already does this.
				if (riskManager) {
					const liveOpenPositionsInside = store.getOpenPositions();
					const livePeakInside = store.getPeakEquity();
					const liveLatestInside = store.getLatestEquity();
					const liveAccountEquityInside =
						liveLatestInside > 0
							? liveLatestInside
							: livePeakInside > 0
								? livePeakInside
								: Math.max(100, parsePositiveSetting(store.getSetting("daily_limit_usd"), 200) * 2);
					const insideRiskValidation = riskManager.validateTrade({
						entryPrice: estimatedPrice,
						qty,
						side: direction,
						symbol: symbolRaw,
						accountEquity: liveAccountEquityInside,
						peakEquity: livePeakInside > 0 ? livePeakInside : liveAccountEquityInside,
						openPositions: liveOpenPositionsInside,
						atrValue: dexAtrValue,
						consecutiveLosses: store.getConsecutiveLosses(),
					});
					if (!insideRiskValidation.allowed) {
						return JSON.stringify({
							error: "Trade blocked by risk manager (re-checked inside mutex)",
							reasons: insideRiskValidation.reasons,
							suggested: insideRiskValidation.suggested,
						});
					}
				}

				let liveResult: Awaited<ReturnType<JupiterSwapExecutor["quoteAndSwapLive"]>>;
				try {
					liveResult = await executor.quoteAndSwapLive({
						tokenSymbol: token,
						direction,
						qty,
						slippageBps: Number.isFinite(slippageBpsArg) ? slippageBpsArg : undefined,
					});
				} catch (e) {
					return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
				}

				const { positionId } = executor.recordOpen({
					result: liveResult,
					direction,
					stopLoss: autoStopLoss!,
					takeProfit: autoTakeProfit!,
					trailingStopPct:
						userTrailingStopPct ?? riskManager?.getConfig().defaultTrailingStopPct ?? undefined,
					isPaper: false,
					feeRate: 0,
				});

				const orderAuditCorrelationId = emitTradingOrderAudit("trade_dex_swap", {
					symbol: symbolRaw,
					side: direction === "short" ? "SELL" : "BUY",
					mode: "LIVE",
					orderId: liveResult.txSignature,
					positionId,
					qty,
					resultSummary: `live jupiter tx=${liveResult.txSignature} ${token} qty=${qty}`,
				});

				emitTradingEvent("trading.heartbeat.checkin", {
					componentId: "trading:chain-solana",
					mode: "LIVE",
					txSignature: liveResult.txSignature,
				});

				return JSON.stringify({
					mode: "LIVE",
					venue: "dex_solana",
					orderAuditCorrelationId,
					txSignature: liveResult.txSignature,
					positionId,
					notionalUsd: round(liveResult.notionalUsd, 2),
					entryPriceUsd: round(liveResult.entryPriceUsd, 6),
					stopLoss: autoStopLoss,
					takeProfit: autoTakeProfit,
					message: `Jupiter swap confirmed: ${liveResult.txSignature}`,
				});
			}); // end DEX live mutex.run
		},

		trade_sell: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			let qty = Number(args.qty);
			const requestedType = args.type as "MARKET" | "LIMIT" | undefined;
			const { type, routeDecision } = resolveAdaptiveOrderType(symbol, requestedType, "MARKET");
			const price = args.price != null ? Number(args.price) : undefined;
			const positionId = args.position_id as string | undefined;
			// Uses closure-scoped counter set by internal stop-monitor wiring — never args.
			const isStopExit = _stopExitBypassDepth > 0;
			if (!isStopExit) {
				const lockError = validateLiveModeLock(isPaperMode());
				if (lockError) return lockError;
			}
			if (isStopExit && circuitBreaker?.getStatus().halted) {
				console.info("[trade_sell] stop-exit CB bypass active — symbol:", symbol, "qty:", args.qty);
			}

			// Validate numeric inputs
			if (!Number.isFinite(qty) || qty <= 0) {
				return JSON.stringify({ error: "qty must be a positive finite number" });
			}
			if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
				return JSON.stringify({ error: "price must be a positive finite number" });
			}

			const openPositions = store.getOpenPositions();
			let targetPosition: (typeof openPositions)[number] | undefined;
			// Bind execution mode to the selected row, never the global paper_mode.
			if (positionId) {
				targetPosition = openPositions.find((position) => position.id === positionId);
				if (!targetPosition) {
					return JSON.stringify({ error: `Position ${positionId} not found or already closed` });
				}
				if (targetPosition.symbol !== symbol) {
					return JSON.stringify({
						error: `Position ${positionId} is for ${targetPosition.symbol}, not ${symbol}`,
					});
				}
			} else {
				const matches = openPositions.filter(
					(p) => p.symbol === symbol && (p.side === "long" || p.side === "short"),
				);
				if (matches.length === 0) {
					return JSON.stringify({
						warning:
							"No tracked open position for this symbol. If this is intentional, provide position_id explicitly.",
						error: "Sell rejected — no tracked position to close. Provide position_id to confirm.",
					});
				}
				if (matches.length !== 1) {
					return JSON.stringify({
						error: "Sell rejected — multiple tracked positions match; provide position_id.",
					});
				}
				targetPosition = matches[0];
			}

			if (!targetPosition || ![true, false, 0, 1].includes(targetPosition.isPaper as never)) {
				return JSON.stringify({
					error: "Sell rejected — selected position has no trustworthy paper/live mode.",
				});
			}
			if (qty > targetPosition.qty) qty = targetPosition.qty;
			const resolvedClosePositionId = targetPosition.id;
			const paperMode = targetPosition.isPaper === true || targetPosition.isPaper === 1;
			const exitSide = targetPosition.side === "short" ? "BUY" : "SELL";

			// Every call is constrained to a tracked position and capped to its qty,
			// so exits remain available while entry locks/breakers are active.

			let estimatedPrice: number = price ?? 0;
			if (!estimatedPrice) {
				const ticker = await client.getTicker(symbol);
				estimatedPrice = ticker.bid;
			}
			if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0) {
				return JSON.stringify({ error: "Could not determine a valid price for this symbol" });
			}
			const bookSnapshot = await getExecutionBookSnapshot(symbol);

			// ── Shadow execution mode (sell) ─────────────────────────────
			// Slippage buffer for sells: market sells may fill below bid, so
			// we discount the expected proceeds to be conservative.
			const SELL_SLIPPAGE_BUFFER = type === "MARKET" ? 0.99 : 1.0;
			let sellSlippageAdjustedPrice = estimatedPrice * SELL_SLIPPAGE_BUFFER;
			const isShadowModeSell = store.getSetting("shadow_mode") === "true";
			if (isShadowModeSell) {
				if (!client.hasCredentials) {
					return JSON.stringify({
						error: "Cannot run shadow execution without API credentials.",
						mode: "SHADOW",
					});
				}

				// Re-fetch price for drift check (parity with shadow trade_buy + live sell)
				if (type === "MARKET") {
					const freshTicker = await client.getTicker(symbol);
					const freshBid = freshTicker.bid;
					const priceDrift = Math.abs(freshBid - estimatedPrice) / estimatedPrice;
					if (priceDrift > 0.02) {
						return JSON.stringify({
							error: `[SHADOW] Price moved ${(priceDrift * 100).toFixed(1)}% since estimate ($${estimatedPrice.toFixed(2)} → $${freshBid.toFixed(2)}). Re-evaluate before trading.`,
							mode: "SHADOW",
						});
					}
					estimatedPrice = freshBid;
					sellSlippageAdjustedPrice = estimatedPrice * SELL_SLIPPAGE_BUFFER;
				}

				// Verify spot base balance (parity with shadow buy quote check).
				// A tracked paper/shadow position does not imply the exchange holds the asset.
				const [baseCurrency] = symbol.split("_");
				if (!baseCurrency) {
					return JSON.stringify({
						error: "[SHADOW] Invalid symbol — expected BASE_QUOTE (e.g. BTC_USDT).",
						mode: "SHADOW",
					});
				}
				try {
					const balances = await client.getBalances();
					const balance = balances.find(
						(b: { currency: string; available: number }) => b.currency === baseCurrency,
					);
					const available = balance?.available ?? 0;
					if (available < qty) {
						return JSON.stringify({
							error: `[SHADOW] Insufficient ${baseCurrency} balance. Available: ${available}, needed: ${qty}`,
							mode: "SHADOW",
						});
					}
				} catch (err) {
					console.warn(
						"[trading] shadow sell balance verification failed:",
						client.scrubError(err),
					);
					return JSON.stringify({
						error: "[SHADOW] Could not verify account balance. Check credentials and connectivity.",
						mode: "SHADOW",
					});
				}

				console.log(
					`[shadow] Simulating trade, no exchange interaction: ${symbol} SELL qty=${qty} ` +
						`price=$${estimatedPrice.toFixed(2)} type=${type}`,
				);

				// ── Close shadow position in ShadowModeExecutor ──────────
				// Without this, shadow positions opened via trade_buy are
				// never closed, so shadow P&L is permanently unrealized and
				// the shadow performance report is wrong.
				if (shadowModeExecutor) {
					const openShadowPositions = shadowModeExecutor.getOpenPositions();
					const matchingShadow = openShadowPositions.find(
						(p) => p.symbol === symbol && p.side === "BUY",
					);
					if (matchingShadow) {
						shadowModeExecutor.closeShadowPosition(matchingShadow.id, estimatedPrice);
					}
				}

				// ── Record shadow sell in trade journal ───────────────────
				// Close the matching shadow row so exit P&L is captured and
				// the learning loop can grade shadow outcomes separately.
				if (tradeJournal) {
					try {
						tradeJournal.closeTradeBySymbol(symbol, "long", estimatedPrice, "shadow_manual_close", {
							isShadow: true,
						});
					} catch (err) {
						console.warn(
							"[trade_sell] journal shadow close failed:",
							err instanceof Error ? err.message : err,
						);
					}
				}

				return JSON.stringify({
					mode: "SHADOW",
					shadow: true,
					symbol,
					side: "SELL",
					type,
					qty,
					price: estimatedPrice,
					estimatedTotal: qty * sellSlippageAdjustedPrice,
					message: `[SHADOW] Sell order validated but NOT submitted: SELL ${qty} ${symbol} @ $${estimatedPrice.toFixed(2)} = $${(qty * sellSlippageAdjustedPrice).toFixed(2)} (incl. slippage buffer). All pre-trade checks passed.`,
				});
			}

			if (paperMode) {
				// ── PAPER SELL — simulate locally, no exchange call ──
				// Wrapped in per-symbol AsyncMutex for consistency with paper buy
				// path — prevents concurrent close/open from seeing stale state.
				return getHandlerMutex(symbol).run(async () => {
					const [baseCurrency, quoteCurrency] = symbol.split("_");
					// Use slippage-adjusted price for proceeds — conservative estimate
					// of what a market sell would actually net after slippage.
					const proceeds = qty * sellSlippageAdjustedPrice;

					// Log the trade and close the position
					const { slippageBps, routeJson } = buildExecutionRouteJson({
						expectedPrice: estimatedPrice,
						fillPrice: estimatedPrice,
						latencyMs: 0,
						requestedType,
						actualType: type,
						routeDecision,
						bookSnapshot,
						side: "SELL",
					});
					const trade = store.logTrade({
						symbol,
						side: exitSide,
						type,
						qty,
						price: estimatedPrice,
						isPaper: true,
						slippageBps,
						routeJson,
					});

					// Close matching position and get P&L (supports partial closes)
					let closedPnl: number | null = null;
					let isPartial = false;
					if (positionId) {
						const pos = store.getOpenPositions().find((p) => p.id === positionId);
						if (pos && qty < pos.qty) {
							const closed = store.closePartial(positionId, qty, estimatedPrice);
							closedPnl = closed?.pnl ?? null;
							isPartial = true;
						} else {
							const closed = store.closePosition(positionId, estimatedPrice);
							closedPnl = closed?.pnl ?? null;
							if (closed) {
								tradeJournal?.closeTradeBySymbol(
									closed.symbol,
									closed.side,
									estimatedPrice,
									"manual_paper",
								);
							}
						}
					} else {
						const openPositions = store.getOpenPositions();
						const matching = openPositions.find(
							(p) => p.symbol === symbol && (p.side === "long" || p.side === "short"),
						);
						if (matching) {
							if (qty < matching.qty) {
								const closed = store.closePartial(matching.id, qty, estimatedPrice);
								closedPnl = closed?.pnl ?? null;
								isPartial = true;
							} else {
								const closed = store.closePosition(matching.id, estimatedPrice);
								closedPnl = closed?.pnl ?? null;
								if (closed) {
									tradeJournal?.closeTradeBySymbol(
										closed.symbol,
										closed.side,
										estimatedPrice,
										"manual_paper",
									);
								}
							}
						}
					}

					// Quote-currency credit and base-currency debit are reconciled
					// inside store.closePosition / closePartial (paper_balances ↔ positions
					// stay in lock-step). `proceeds` is still used for the virtualBalance
					// summary returned to the caller below.
					executionQualityController?.recordExecution({
						symbol,
						side: exitSide,
						requestedOrderType: requestedType ?? type,
						actualOrderType: type,
						expectedPrice: estimatedPrice,
						fillPrice: estimatedPrice,
						latencyMs: 0,
						book: bookSnapshot,
					});

					// Record equity snapshot after closing position (prevents false drawdown triggers)
					await recordEquitySnapshot({ force: true });

					if (onTradingEvent) {
						const snapshot = await buildSnapshotUpdated("trade_sell");
						emitTradingEvent("trading.snapshot.updated", snapshot);
						emitTradingEvent("trade.closed", {
							symbol,
							qty,
							price: estimatedPrice,
							pnl: closedPnl != null ? round(closedPnl, 2) : 0,
							isPaper: true,
						});
					}

					const newUsdBalance = store.getPaperBalance(quoteCurrency ?? "USDT");
					const orderAuditCorrelationId = emitTradingOrderAudit("trade_sell", {
						symbol,
						side: exitSide,
						mode: "PAPER",
						positionId: resolvedClosePositionId,
						qty,
						resultSummary: `paper close qty=${qty} @ ${estimatedPrice.toFixed(4)} pnl=${closedPnl != null ? round(closedPnl, 2) : "n/a"}`,
					});
					return JSON.stringify({
						mode: "PAPER",
						orderAuditCorrelationId,
						trade,
						pnl: closedPnl != null ? round(closedPnl, 2) : null,
						partial: isPartial,
						virtualBalance: {
							[quoteCurrency ?? "USDT"]: round(newUsdBalance, 2),
						},
						message: `[PAPER] ${isPartial ? "Partial sell" : "Sell"}: ${qty} ${symbol} @ $${estimatedPrice.toFixed(2)} = $${proceeds.toFixed(2)}${closedPnl != null ? ` | P&L: ${closedPnl >= 0 ? "+" : ""}$${closedPnl.toFixed(2)}` : ""} | Virtual ${quoteCurrency ?? "USDT"} balance: $${newUsdBalance.toFixed(2)}`,
					});
				}); // end mutex.run
			}

			if (!client.hasCredentials) {
				return JSON.stringify({
					error: "Cannot execute live trade without API credentials.",
				});
			}

			// ── Price drift check (matches trade_buy safety) ──
			// Re-fetch price right before execution to detect fast-moving markets.
			if (type === "MARKET" && estimatedPrice) {
				try {
					const freshTicker = await client.getTicker(symbol);
					const freshBid = freshTicker.bid;
					const drift = Math.abs(freshBid - estimatedPrice) / estimatedPrice;
					if (drift > 0.02) {
						return JSON.stringify({
							error: `Price moved ${(drift * 100).toFixed(1)}% since quote (was $${estimatedPrice.toFixed(2)}, now $${freshBid.toFixed(2)}). Re-submit to confirm.`,
						});
					}
					estimatedPrice = freshBid; // Use freshest price for records
				} catch (err) {
					console.warn(
						"[trade_sell] Price drift check failed, proceeding with original price:",
						client.scrubError(err),
					);
				}
			}

			const requestedCloseQty = qty;
			const executionStartedAt = Date.now();
			const result = await client.createOrder({
				symbol,
				side: exitSide,
				type,
				qty,
				price,
			});
			const latencyMs = Date.now() - executionStartedAt;
			let fillPrice: number;
			let filledQty: number;
			let fullyFilled = false;
			try {
				if (!result.orderId || typeof client.getOrderDetail !== "function") {
					throw new Error("exchange order detail is unavailable");
				}
				const detail = await client.getOrderDetail(symbol, result.orderId);
				const fillTolerance = Math.max(1e-12, requestedCloseQty * 1e-8);
				if (
					!Number.isFinite(detail.filledQty) ||
					detail.filledQty <= 0 ||
					!Number.isFinite(detail.avgPrice) ||
					detail.avgPrice <= 0
				) {
					throw new Error(
						`exchange fill not confirmed (${detail.status}, qty=${detail.filledQty})`,
					);
				}
				fullyFilled =
					detail.status.toUpperCase() === "FILLED" &&
					detail.filledQty + fillTolerance >= requestedCloseQty;
				filledQty = Math.min(requestedCloseQty, detail.filledQty);
				fillPrice = detail.avgPrice;
				if (!fullyFilled) {
					await client.cancelOrder(symbol, result.orderId).catch(() => undefined);
				}
			} catch (err) {
				return JSON.stringify({
					error: `Sell order submitted but local position remains open: ${err instanceof Error ? err.message : String(err)}`,
					orderId: result.orderId,
					status: result.status,
					reconcileRequired: true,
				});
			}
			qty = filledQty;
			const { slippageBps, routeJson } = buildExecutionRouteJson({
				expectedPrice: estimatedPrice,
				fillPrice,
				latencyMs,
				requestedType,
				actualType: type,
				routeDecision,
				bookSnapshot,
				side: "SELL",
			});

			store.logTrade({
				symbol,
				side: exitSide,
				type,
				qty,
				price: fillPrice,
				orderId: result.orderId,
				isPaper: false,
				slippageBps,
				routeJson,
			});
			// Apply exchange fee_rate on live close — same reason as live entry
			// (see liveEntryFeeRate above): otherwise round-trip fees vanish from
			// realized P&L and the consecutive_loss CB / daily_loss_cap can fail
			// to trip on genuinely losing live activity.
			const liveCloseFeeRate = Number(store.getSetting("fee_rate") || "0.00075");
			if (positionId) {
				const pos = store.getOpenPositions().find((p) => p.id === positionId);
				if (pos && qty < pos.qty) {
					store.closePartial(positionId, qty, fillPrice);
				} else {
					const closed = store.closePosition(positionId, fillPrice, liveCloseFeeRate);
					if (closed) {
						tradeJournal?.closeTradeBySymbol(closed.symbol, closed.side, fillPrice, "manual_live");
					}
				}
			} else {
				const openPositions = store.getOpenPositions();
				const matching = openPositions.find(
					(p) => p.symbol === symbol && (p.side === "long" || p.side === "short"),
				);
				if (matching) {
					if (qty < matching.qty) {
						store.closePartial(matching.id, qty, fillPrice);
					} else {
						const closed = store.closePosition(matching.id, fillPrice, liveCloseFeeRate);
						if (closed) {
							tradeJournal?.closeTradeBySymbol(
								closed.symbol,
								closed.side,
								fillPrice,
								"manual_live",
							);
						}
					}
				}
			}
			executionQualityController?.recordExecution({
				symbol,
				side: exitSide,
				requestedOrderType: requestedType ?? type,
				actualOrderType: type,
				expectedPrice: estimatedPrice,
				fillPrice,
				latencyMs,
				book: bookSnapshot,
			});

			const orderAuditCorrelationId = emitTradingOrderAudit("trade_sell", {
				symbol,
				side: exitSide,
				mode: "LIVE",
				orderId: result.orderId,
				positionId: resolvedClosePositionId,
				qty,
				resultSummary: `live close orderId=${result.orderId} qty=${qty}`,
			});

			return JSON.stringify({
				mode: "LIVE",
				orderAuditCorrelationId,
				orderId: result.orderId,
				status: result.status,
				partial: !fullyFilled,
				reconcileRequired: !fullyFilled,
				filledQty: qty,
				remainingQty:
					store.getOpenPositions().find((position) => position.id === resolvedClosePositionId)
						?.qty ?? 0,
				message: `Sell order submitted: ${qty} ${symbol} @ ${type === "LIMIT" ? `$${price}` : "market"}`,
			});
		},

		// ── Portfolio & history ──

		trade_history: async (args: Record<string, unknown>): Promise<string> => {
			const limit = (args.limit as number) || 20;
			const trades = store.getRecentTrades(limit);
			if (trades.length === 0) {
				return JSON.stringify({ message: "No trade history." });
			}
			return JSON.stringify(trades);
		},

		trade_portfolio: async (): Promise<string> => {
			// Verifier contract (tool-result-verifier case "trade_portfolio"):
			// `positions` and `balance` must be present on EVERY return path.
			// Previously a store/exchange failure threw out of the handler and
			// produced no JSON at all ("positions field missing from portfolio
			// result"), so the whole body is wrapped and the catch returns an
			// explicit degraded shape instead.
			try {
				const paperMode = isPaperMode();
				const positions = store.getOpenPositions();
				const allPositions = store.getAllPositions();
				const dailySpend = store.getDailySpend(paperMode);
				const maxTrade = store.getSetting("max_trade_usd");
				const dailyLimit = store.getSetting("daily_limit_usd");

				// Sandbox dashboard reads stay local. Guarded/trusted may enrich with public market data.
				const canReadNetwork = getZone?.() !== "sandbox";
				const enriched = canReadNetwork
					? await Promise.all(
							positions.map(async (p) => {
								try {
									const ticker = await client.getTicker(p.symbol);
									const currentPrice = ticker.last;
									const pnl =
										p.side === "long"
											? (currentPrice - p.entryPrice) * p.qty
											: (p.entryPrice - currentPrice) * p.qty;
									return { ...p, currentPrice, pnl };
								} catch (err) {
									console.debug(
										"[trading] price enrich failed for",
										p.symbol,
										err instanceof Error ? err.message : err,
									);
									return p;
								}
							}),
						)
					: positions;

				const totalPnl = enriched.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
				const closedPnl = allPositions
					.filter((p) => p.status === "closed")
					.reduce((sum, p) => sum + (p.pnl ?? 0), 0);

				const response: Record<string, unknown> = {
					mode: paperMode ? "PAPER" : "LIVE",
					settings: {
						maxTradeUsd: maxTrade,
						dailyLimitUsd: dailyLimit,
						dailySpentUsd: dailySpend.toFixed(2),
					},
					openPositions: enriched,
					unrealizedPnl: totalPnl.toFixed(2),
					closedPnl: closedPnl.toFixed(2),
				};

				const PNL_ALERT_BAND_PCT = 5;
				const virtualStart = Number(store.getSetting("virtual_balance_usd") || "1000");
				const latestEq = store.getLatestEquity();
				const referenceUsd = paperMode ? virtualStart : latestEq > 0 ? latestEq : virtualStart;
				const unrealizedNum = totalPnl;
				const unrealizedPctVsRef = referenceUsd > 0 ? (unrealizedNum / referenceUsd) * 100 : 0;
				// Live 2026-07-27: paperReturnPctVsStart / virtualPortfolio.returnVsStart used
				// USDT cash only ($896 vs $1100 start → false -18% band alert) while bags
				// (BTC/SOL/XRP/CRO) held the rest; risk_status marked equity was ~$1063.
				// Mark-to-market via the shared paper-equity helper (same as equity snapshots).
				let paperEquityUsd: number | null = null;
				let paperReturnPctVsStart: number | null = null;
				if (paperMode && canReadNetwork) {
					paperEquityUsd = await computePaperEquityUsd({
						balances: store.getAllPaperBalances(),
						openPositions: positions,
						getTicker: (s) => client.getTicker(s),
						onNoTicker: (currency, balance) => {
							console.debug(
								`[trading] trade_portfolio equity: no ${currency}_USDT ticker, excluding ${balance} ${currency}`,
							);
						},
					});
					paperReturnPctVsStart =
						virtualStart > 0 ? ((paperEquityUsd - virtualStart) / virtualStart) * 100 : 0;
				}
				response.pnlExpectation = {
					note:
						"Daily discipline compares unrealized and (paper) marked equity return against ±bandPct of referenceUsd. " +
						"unrealizedPnlUsd is from open margined positions only — with no open positions it is 0 even when paper bags + USDT NAV moved (see virtualPortfolio.equityUsd / paperReturnPctVsStart). " +
						"paperReturnPctVsStart is mark-to-market equity vs start, not USDT cash alone.",
					bandPct: PNL_ALERT_BAND_PCT,
					referenceUsd,
					unrealizedPnlUsd: round(unrealizedNum, 4),
					unrealizedPctVsReference: round(unrealizedPctVsRef, 4),
					paperReturnPctVsStart:
						paperReturnPctVsStart != null ? round(paperReturnPctVsStart, 4) : null,
					outsideUnrealizedBand: Math.abs(unrealizedPctVsRef) >= PNL_ALERT_BAND_PCT,
					outsidePaperReturnBand:
						paperReturnPctVsStart != null && Math.abs(paperReturnPctVsStart) >= PNL_ALERT_BAND_PCT,
				};

				// In paper mode, show the virtual portfolio balances so the user can see
				// exactly how much virtual capital they have left to trade with
				if (paperMode) {
					const startingUsd = virtualStart;
					const balances = store.getAllPaperBalances();
					const cashUsd = store.getPaperBalance("USDT");
					const equityUsd = paperEquityUsd ?? cashUsd;
					response.virtualPortfolio = {
						note: "Simulated balances — no real money involved. returnVsStart is mark-to-market equity (cash + bags), not USDT cash alone.",
						startingUsd,
						balances,
						cashUsd: round(cashUsd, 4),
						equityUsd: round(equityUsd, 4),
						returnVsStart: `${equityUsd >= startingUsd ? "+" : ""}$${(equityUsd - startingUsd).toFixed(2)}`,
					};
				}

				// Contract fields: `positions` mirrors openPositions; `balance`
				// is paper USDT cash in paper mode (spendable quote), latest recorded
				// equity in live mode, or null + degraded when no live equity is known.
				// Marked paper equity is on virtualPortfolio.equityUsd / latestEq snapshots.
				response.positions = enriched;
				const balanceUsd = paperMode
					? store.getPaperBalance("USDT")
					: latestEq > 0
						? latestEq
						: null;
				response.balance = balanceUsd;
				if (balanceUsd === null) response.degraded = true;

				return JSON.stringify(response);
			} catch (err) {
				return JSON.stringify({
					error: `portfolio unavailable: ${err instanceof Error ? err.message : String(err)}`,
					degraded: true,
					positions: [],
					balance: null,
				});
			}
		},

		// ── Settings ──

		trade_pre_live_checklist: async (): Promise<string> => {
			const shadowPerf = shadowModeExecutor?.getShadowPerformance();
			const checklist = evaluatePreLiveChecklist({
				store,
				hasCredentials: client.hasCredentials,
				paperTradingEnv: process.env.PAPER_TRADING,
				zaraaTradingPaperMode,
				circuitBreaker,
				shadowEvidence: shadowPerf
					? { closedTrades: shadowPerf.trades, totalPnl: shadowPerf.totalPnl }
					: null,
			});
			return JSON.stringify({
				allPassed: checklist.allPassed,
				items: checklist.items,
				reminders: checklist.reminders,
				hint: checklist.allPassed
					? "Checklist OK. Enable live with trade_set_limit({ paper_mode: false, confirm_live: true })."
					: "Fix failed items (often: run trade_verify_exchange), then re-run this tool.",
			});
		},

		trade_set_limit: async (args: Record<string, unknown>): Promise<string> => {
			const maxTrade = args.max_trade_usd as number | undefined;
			const dailyLimit = args.daily_limit_usd as number | undefined;
			const paperMode = args.paper_mode as boolean | undefined;
			const shadowMode = args.shadow_mode as boolean | undefined;
			const confirmLive = args.confirm_live === true;

			const changes: string[] = [];

			// Validate limit amounts
			if (maxTrade != null) {
				if (maxTrade <= 0) {
					return JSON.stringify({ error: "max_trade_usd must be positive" });
				}
				if (maxTrade > 500) {
					return JSON.stringify({
						error: "max_trade_usd cannot exceed $500 as a safety cap. Contact admin to increase.",
					});
				}
				store.setSetting("max_trade_usd", String(maxTrade));
				changes.push(`max per-trade: $${maxTrade}`);
			}
			if (dailyLimit != null) {
				if (dailyLimit <= 0) {
					return JSON.stringify({ error: "daily_limit_usd must be positive" });
				}
				if (dailyLimit > 2000) {
					return JSON.stringify({
						error:
							"daily_limit_usd cannot exceed $2000 as a safety cap. Contact admin to increase.",
					});
				}
				store.setSetting("daily_limit_usd", String(dailyLimit));
				changes.push(`daily limit: $${dailyLimit}`);
			}
			if (paperMode != null) {
				// Switching to LIVE mode requires explicit confirmation
				if (paperMode === false) {
					if (!confirmLive) {
						return JSON.stringify({
							error:
								"SWITCHING TO LIVE TRADING MODE — this will use REAL MONEY. Set confirm_live=true to confirm.",
							warning:
								"All trades will be executed on the exchange with real funds. Ensure API credentials are valid and risk limits are appropriate.",
							currentLimits: {
								maxTradeUsd: store.getSetting("max_trade_usd"),
								dailyLimitUsd: store.getSetting("daily_limit_usd"),
							},
							hint: "Run trade_pre_live_checklist first, then trade_verify_exchange if anything fails.",
						});
					}
					const liveShadowPerf = shadowModeExecutor?.getShadowPerformance();
					const preLive = evaluatePreLiveChecklist({
						store,
						hasCredentials: client.hasCredentials,
						paperTradingEnv: process.env.PAPER_TRADING,
						zaraaTradingPaperMode,
						circuitBreaker,
						shadowEvidence: liveShadowPerf
							? { closedTrades: liveShadowPerf.trades, totalPnl: liveShadowPerf.totalPnl }
							: null,
					});
					if (!preLive.allPassed) {
						return JSON.stringify({
							error:
								"Pre-live checklist failed — cannot enable live mode until all required items pass.",
							checklist: preLive.items,
							reminders: preLive.reminders,
							hint: "Run trade_pre_live_checklist for the full view, fix failures, run trade_verify_exchange if exchange_verified_recent failed.",
						});
					}
					// Verify credentials exist before allowing live mode
					if (!client.hasCredentials) {
						return JSON.stringify({
							error:
								"Cannot switch to live mode — no API credentials configured. Set trading.apiKey and trading.apiSecret first.",
						});
					}
					// Record go-live equity baseline for the >5% auto-revert rail
					// (stage-5 safety). Must happen before the paper_mode flip so
					// the equity source still reads live=false correctly. Fail closed:
					// if equity is unavailable, refuse the flip.
					try {
						await refreshLiveAccountEquity({ client, store });
						recordGoLiveBaselineEquity(store);
					} catch (baselineErr) {
						return JSON.stringify({
							error:
								"Cannot switch to live mode — " +
								(baselineErr instanceof Error ? baselineErr.message : String(baselineErr)),
							hint: "Verify authenticated exchange balances and complete price coverage, then retry.",
						});
					}
				}
				store.setSetting("paper_mode", String(paperMode));
				changes.push(`paper mode: ${paperMode}`);
			}
			if (shadowMode != null) {
				// Shadow mode only makes sense when paper_mode is OFF (live path).
				// It runs the full live pipeline but stops before createOrder.
				store.setSetting("shadow_mode", String(shadowMode));
				changes.push(`shadow mode: ${shadowMode}`);
			}

			if (changes.length === 0) {
				return JSON.stringify({
					message: "No changes specified.",
					current: {
						maxTradeUsd: store.getSetting("max_trade_usd"),
						dailyLimitUsd: store.getSetting("daily_limit_usd"),
						paperMode: store.getSetting("paper_mode"),
						shadowMode: store.getSetting("shadow_mode"),
					},
				});
			}

			return JSON.stringify({
				updated: changes,
				message: `Trading limits updated: ${changes.join(", ")}`,
			});
		},

		// ── Risk management ──

		trade_set_stop: async (args: Record<string, unknown>): Promise<string> => {
			const positionId = args.position_id as string;
			if (!positionId) throw new Error("position_id is required");

			const stopLoss = args.stop_loss as number | undefined;
			const takeProfit = args.take_profit as number | undefined;
			const trailingStopPct = args.trailing_stop_pct as number | undefined;

			if (stopLoss == null && takeProfit == null && trailingStopPct == null) {
				return JSON.stringify({
					error: "Provide at least one of: stop_loss, take_profit, trailing_stop_pct",
				});
			}

			// Validate stop direction relative to position
			const openPositions = store.getOpenPositions();
			const position = openPositions.find((p) => p.id === positionId);
			if (position) {
				if (position.side === "long") {
					if (stopLoss != null && stopLoss >= position.entryPrice) {
						return JSON.stringify({
							error: `stop_loss ($${stopLoss}) must be BELOW entry price ($${position.entryPrice}) for a long position`,
						});
					}
					if (takeProfit != null && takeProfit <= position.entryPrice) {
						return JSON.stringify({
							error: `take_profit ($${takeProfit}) must be ABOVE entry price ($${position.entryPrice}) for a long position`,
						});
					}
				} else {
					if (stopLoss != null && stopLoss <= position.entryPrice) {
						return JSON.stringify({
							error: `stop_loss ($${stopLoss}) must be ABOVE entry price ($${position.entryPrice}) for a short position`,
						});
					}
					if (takeProfit != null && takeProfit >= position.entryPrice) {
						return JSON.stringify({
							error: `take_profit ($${takeProfit}) must be BELOW entry price ($${position.entryPrice}) for a short position`,
						});
					}
				}
				if (stopLoss != null && takeProfit != null && stopLoss >= takeProfit) {
					return JSON.stringify({ error: "stop_loss must be below take_profit" });
				}
			}

			if (trailingStopPct != null && (trailingStopPct <= 0 || trailingStopPct > 50)) {
				return JSON.stringify({ error: "trailing_stop_pct must be between 0 and 50" });
			}

			const updated = store.updateStops(positionId, {
				stopLoss: stopLoss ?? undefined,
				takeProfit: takeProfit ?? undefined,
				trailingStopPct: trailingStopPct ?? undefined,
			});

			if (!updated) {
				return JSON.stringify({ error: "Position not found or already closed" });
			}

			const changes: string[] = [];
			if (stopLoss != null) changes.push(`SL: $${stopLoss}`);
			if (takeProfit != null) changes.push(`TP: $${takeProfit}`);
			if (trailingStopPct != null) changes.push(`trailing: ${trailingStopPct}%`);

			return JSON.stringify({
				positionId,
				updated: changes,
				message: `Stops updated for ${positionId}: ${changes.join(", ")}`,
			});
		},

		trade_check_stops: async (): Promise<string> => {
			if (!stopMonitor) {
				return JSON.stringify({ error: "Stop monitor not initialized" });
			}

			const wasPaperMode = isPaperMode();
			const events = await stopMonitor.checkStops();

			// Snapshot failure must not skip the fail-closed automated lock below.
			try {
				await recordEquitySnapshot();
			} catch (err) {
				console.warn(
					"[trading] equity refresh failed before automated lock:",
					err instanceof Error ? err.message : err,
				);
			}

			const automatedRisk = buildAutomatedRiskLockSnapshot({
				store,
				isPaperMode: wasPaperMode,
			});
			let flattenResult: Awaited<ReturnType<typeof emergencyFlattenAllPositions>> | undefined;
			if (automatedRisk.triggered) {
				flattenResult =
					(await enforceAutomatedRiskSnapshot(automatedRisk, wasPaperMode)) ?? undefined;
			} else {
				// Auto-clear stale HALTED: if state is HALTED but every circuit
				// breaker reports clear and automated risk isn't currently
				// triggered, the halt is stale (e.g. operator cleared breakers
				// out-of-band but trading_state never followed). Never bypasses
				// breaker enforcement — we only clear when ALL breakers genuinely
				// report no trip.
				const previousState = store.getTradingState();
				if (previousState === "HALTED" && circuitBreaker) {
					const breakerStatus = circuitBreaker.getStatus();
					const breakerStates = circuitBreaker.getPersistedStates();
					const anyTripped = breakerStates.some((b) => b.is_tripped === 1);
					if (!breakerStatus.halted && !anyTripped) {
						store.setTradingState("ACTIVE");
						store.logRiskMonitorEvent({
							fromState: "HALTED",
							toState: "ACTIVE",
							reason: "Auto-cleared stale HALTED: all circuit breakers report clear.",
							detailJson: JSON.stringify({ breakerStatus, breakerStates }),
						});
					}
				}
			}

			// Periodically clean expired idempotency records (24h TTL).
			// Runs on ~every 60th stop check cycle (every ~30 minutes).
			if (Math.random() < 1 / 60) {
				store.cleanupExpiredOrders();
			}

			// Proactive push for the highest-stakes computed-but-previously-pull-only
			// risk signal (alert-triage-ladder.md, ngt-1347/1336): trade_risk_status
			// already computes this on demand; this reuses the same read on the
			// already-proven per-minute trade_check_stops cadence and emits a real
			// trading event. alertManager.send()'s own 60min per-type dedup already
			// prevents a repeat page every cycle — no new rate-limiting needed here.
			const stillMissingStopLoss = store.getOpenPositionsMissingStopLoss();
			if (stillMissingStopLoss.length > 0) {
				emitTradingEvent("trade.stop_loss_missing", {
					count: stillMissingStopLoss.length,
					positions: stillMissingStopLoss.map((p) => ({
						id: p.id,
						symbol: p.symbol,
						side: p.side,
						entryPrice: p.entryPrice,
						qty: p.qty,
					})),
				});
			}

			if (events.length === 0 && !flattenResult) {
				const watched = store.getPositionsWithStops();
				return JSON.stringify({
					message: "No stops triggered",
					watchedPositions: watched.length,
				});
			}

			if (onTradingEvent) {
				const snapshot = await buildSnapshotUpdated("trade_check_stops");
				emitTradingEvent("trading.snapshot.updated", snapshot);
				for (const e of events) {
					emitTradingEvent("trade.stop_loss_hit", {
						symbol: e.symbol,
						triggerPrice: e.triggerPrice,
						pnl: round(e.pnl, 2),
						type: e.type,
					});
				}
				if (automatedRisk.triggered) {
					emitTradingEvent("trade.halted", {
						reason: automatedRisk.reason ?? "Automated risk lock triggered",
					});
				}
			}

			return JSON.stringify({
				triggered: events.length,
				flattened: flattenResult?.flattened.length ?? 0,
				flattenFailures: flattenResult?.failures.length ?? 0,
				tradingStatus: store.getTradingState(),
				flattenResult,
				events: events.map((e) => ({
					positionId: e.positionId,
					symbol: e.symbol,
					type: e.type,
					triggerPrice: e.triggerPrice,
					currentPrice: e.currentPrice,
					pnl: round(e.pnl, 2),
				})),
			});
		},

		/**
		 * Compare exchange open orders against local submitted_orders (live mode only).
		 * Lookback window defaults to 24h (see reconcile_lookback_hours). Paper mode returns skipped=true.
		 */
		trade_reconcile_orders: async (): Promise<string> => {
			const reconciler = new OrderReconciler({ store, client });
			const result = await reconciler.reconcile();
			return JSON.stringify(result);
		},

		/**
		 * Close all open paper positions at current market prices.
		 * Used to get a clean start after safety system upgrades.
		 * Only works in paper mode as a safety measure.
		 */
		trade_reset_paper: async (): Promise<string> => {
			if (!isPaperMode()) {
				return JSON.stringify({
					error: "trade_reset_paper only works in paper mode. Switch to paper mode first.",
				});
			}
			const openPositions = store.getOpenPositions();
			if (openPositions.length === 0) {
				return JSON.stringify({ message: "No open positions to reset." });
			}

			const results: { id: string; symbol: string; pnl: number }[] = [];
			let totalPnl = 0;

			for (const pos of openPositions) {
				try {
					const ticker = await client.getTicker(pos.symbol);
					const closePrice = ticker.bid;
					const closed = store.closePosition(pos.id, closePrice);
					if (closed?.pnl != null) {
						results.push({ id: pos.id, symbol: pos.symbol, pnl: round(closed.pnl, 2) });
						totalPnl += closed.pnl;
						// Record with circuit breaker if available
						circuitBreaker?.recordTrade(closed.pnl);
						tradeJournal?.closeTradeBySymbol(closed.symbol, closed.side, closePrice, "reset_paper");
					}
				} catch (err) {
					// If price fetch fails, close at entry price (0 P&L)
					console.warn(
						"[trading] price fetch failed during reset for",
						pos.symbol,
						client.scrubError(err),
					);
					const closed = store.closePosition(pos.id, pos.entryPrice);
					results.push({ id: pos.id, symbol: pos.symbol, pnl: 0 });
					if (closed) {
						tradeJournal?.closeTradeBySymbol(
							closed.symbol,
							closed.side,
							pos.entryPrice,
							"reset_paper_fallback",
						);
					}
				}
			}

			return JSON.stringify({
				message: `Reset complete: closed ${results.length} paper positions`,
				totalPnl: round(totalPnl, 2),
				positions: results,
			});
		},

		/**
		 * Reset peak equity to current level, accepting the drawdown and resuming trading.
		 * Only works in paper mode. Clears the drawdown halt so signals can execute again.
		 */
		trade_reset_drawdown: async (): Promise<string> => {
			if (!isPaperMode()) {
				return JSON.stringify({ error: "trade_reset_drawdown only works in paper mode." });
			}
			const openPositions = store.getOpenPositions();
			if (openPositions.length > 0) {
				return JSON.stringify({
					error: `Cannot reset drawdown with ${openPositions.length} open positions. Close positions first.`,
				});
			}
			const { oldPeak, newBaseline } = store.resetPeakEquity();
			// Re-baseline the drawdown breaker too; otherwise its persisted peak can
			// remain above the accepted equity and immediately retrip on the next sample.
			circuitBreaker?.resetDrawdownBaseline(newBaseline);
			store.setTradingState("ACTIVE");
			const drawdownAccepted =
				oldPeak > 0 ? (((oldPeak - newBaseline) / oldPeak) * 100).toFixed(1) : "0";
			return JSON.stringify({
				message: `Drawdown reset: accepted ${drawdownAccepted}% loss. New baseline: $${newBaseline.toFixed(2)} (was $${oldPeak.toFixed(2)}). Trading resumed.`,
				oldPeak: round(oldPeak, 2),
				newBaseline: round(newBaseline, 2),
				drawdownAccepted: Number(drawdownAccepted),
			});
		},

		/**
		 * Reset all four circuit breakers (consecutive_loss, drawdown, velocity)
		 * in one call and clear trading_state to ACTIVE. Sole admin path for
		 * unsticking the velocity breaker, which has no individual reset tool
		 * and otherwise waits 4h for auto-reset. Paper-mode only.
		 */
		trade_reset_breakers: async (): Promise<string> => {
			if (!isPaperMode()) {
				return JSON.stringify({ error: "trade_reset_breakers only works in paper mode." });
			}
			if (!circuitBreaker) {
				return JSON.stringify({ error: "Circuit breaker not initialized." });
			}
			const cleared = circuitBreaker.resetAllBreakers();
			store.setTradingState("ACTIVE");
			return JSON.stringify({
				message:
					cleared.length > 0
						? `Reset ${cleared.length} tripped breaker(s): ${cleared.join(", ")}. Trading resumed.`
						: "No breakers were tripped; trading_state set to ACTIVE.",
				cleared,
				breakerStates: circuitBreaker.getPersistedStates(),
			});
		},

		trade_risk_status: async (): Promise<string> => {
			const openPositions = store.getOpenPositions();
			const positionsWithStops = store.getPositionsWithStops();
			// Safety sweep: find positions that have no stop-loss at all.
			// A position may have a take-profit but still be missing a stop-loss,
			// which leaves it unprotected on the downside.
			const positionsMissingStopLoss = store.getOpenPositionsMissingStopLoss();
			const peakEquity = store.getPeakEquity();
			const equityHistory = store.getEquityHistory(10);
			// Lift breaker peak monotonically so the rendered reconciliation reflects
			// the post-sync reality and the next drawdown check uses the correct peak.
			circuitBreaker?.syncPeakFromStore(peakEquity);
			const breakerDrawdownPeak = circuitBreaker?.getDrawdownPeakEquity() ?? null;

			const paperMode = isPaperMode();
			const result: Record<string, unknown> = {
				emergencyGates: buildKillGateSnapshot({
					store,
					circuitBreaker,
					isPaperMode: paperMode,
				}),
				openPositions: openPositions.length,
				positionsWithStops: positionsWithStops.length,
				positionsWithoutStops: openPositions.length - positionsWithStops.length,
				// Positions missing a stop-loss specifically (the most dangerous gap)
				positionsMissingStopLoss: positionsMissingStopLoss.length,
				// List each unprotected position so the user can act on them
				stopLossWarnings: positionsMissingStopLoss.map((p) => ({
					id: p.id,
					symbol: p.symbol,
					side: p.side,
					entryPrice: p.entryPrice,
					qty: p.qty,
					openedAt: p.openedAt,
					warning: "NO STOP-LOSS SET — position is unprotected. Use trade_update_stops to add one.",
				})),
				peakEquity,
				peakEquityReconciliation: {
					tradingStorePeakEquity: peakEquity,
					circuitBreakerDrawdownPeakEquity: breakerDrawdownPeak,
					note: "peakEquity is the trading-store watermark used with RiskManager drawdown fields below. circuitBreakerDrawdownPeakEquity is the drawdown breaker's persisted peak — compare when debugging halts.",
				},
				recentEquity: equityHistory,
			};

			if (riskManager) {
				const config = riskManager.getConfig();
				result.riskConfig = config;

				if (peakEquity > 0) {
					// Prefer resolveReportEquity so we never emit0 as "current" when snapshots
					// are missing — getLatestEquity() alone is a sentinel, not literal NAV.
					const currentEquity = store.resolveReportEquity(paperMode);
					const totalExposure = openPositions.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
					result.currentEquity = currentEquity;
					result.currentExposurePct = round((totalExposure / currentEquity) * 100, 2);
					result.drawdownPct = riskManager.getDrawdownPct(currentEquity, peakEquity);
					result.tradingHalted = riskManager.isDrawdownExceeded(currentEquity, peakEquity);
				}
			}

			// List stops for open positions
			result.stops = positionsWithStops.map((p) => ({
				id: p.id,
				symbol: p.symbol,
				side: p.side,
				entryPrice: p.entryPrice,
				stopLoss: p.stopLoss,
				takeProfit: p.takeProfit,
				trailingStopPct: p.trailingStopPct,
				trailingStopHigh: p.trailingStopHigh,
			}));

			// Paper stop-loss tree suggestions (harvest sl_tree/v1) — never executes.
			result.paperStopLossTree = getPaperStopLossTreeStatus();
			const paperOpen = openPositions.filter((p) => {
				if (p.isPaper === false || p.isPaper === 0) return false;
				if (p.isPaper === true || p.isPaper === 1) return true;
				return paperMode;
			});
			result.paperStopLossSuggestions = paperOpen
				.filter((p) => p.currentPrice != null && p.currentPrice > 0 && p.entryPrice > 0)
				.map((p) => {
					const style: TradeStyle = "swing";
					const side = p.side === "short" ? "short" : "long";
					const check = checkPaperStopLoss({
						paperMode: true,
						style,
						side,
						entryPrice: p.entryPrice,
						currentPrice: p.currentPrice as number,
					});
					return {
					...check,
					id: p.id,
					symbol: p.symbol,
					side,
					entryPrice: p.entryPrice,
					currentPrice: p.currentPrice,
				};
				})
				.filter((x) => x.action === "reduce" || x.action === "exit");

			// Invalidation levels: use stopLoss as thesis-break proxy when set (paper only).
			result.paperInvalidationSuggestions = paperOpen
				.filter((p) => p.currentPrice != null && p.currentPrice > 0)
				.map((p) => {
					const side = p.side === "short" ? "short" : "long";
					const inv = (p as { stopLoss?: number | null }).stopLoss;
					const check = checkPaperInvalidation({
						paperMode: true,
						side,
						currentPrice: p.currentPrice as number,
						invalidationLevel: inv ?? null,
					});
					return {
						id: p.id,
						symbol: p.symbol,
						side,
						invalidationLevel: inv ?? null,
						currentPrice: p.currentPrice,
						...check,
					};
				})
				.filter((x) => x.action === "exit" || x.action === "missing_level");

			// Surface why recent signals were dropped before execution. Closes the
			// "why didn't trade X enter" loop — operator no longer has to grep logs.
			// Empty array when signalEngine is not wired (tests, smoke runs).
			if (signalEngine) {
				result.recentRejections = signalEngine.getRecentRejections(20);
			}

			const semantics = validateTradeRiskStatusSemantics(result);
			if (!semantics.ok) {
				result.riskStatusSemanticsInvalid = true;
				result.riskStatusSemanticsConflicts = semantics.conflicts;
			}

			// Freshness annotation for the drawdown breaker only. It's the one
			// breaker confirmed continuously polled (~5min cadence, observed live
			// across repeated pulls). The other three (consecutive_loss/velocity/
			// policy_volume) are event-driven — an old last_updated there means
			// "hasn't tripped," not "stopped being checked," so tagging them with
			// the same expected interval would fabricate a false-stale signal
			// rather than disclose a real one. See data-freshness-policy.md.
			// ponytail: single-breaker-type scope by design; extend once a real
			// expected interval is confirmed for the event-driven breakers too.
			const emergencyGates = result.emergencyGates as
				| { breakerStates?: Array<{ breaker_type: string; last_updated?: string | null }> }
				| undefined;
			const drawdownBreaker = emergencyGates?.breakerStates?.find((b) => b.breaker_type === "drawdown");
			if (drawdownBreaker?.last_updated) {
				const ageMs = Date.now() - new Date(drawdownBreaker.last_updated).getTime();
				result.breakerFreshness = {
					drawdown: classifyBreakerFreshness(ageMs, 5 * 60 * 1000),
					note: "Only the drawdown breaker is continuously polled; consecutive_loss/velocity/policy_volume are event-driven and intentionally not annotated here.",
				};
			}

			return JSON.stringify(result);
		},

		trade_explain_state: async (): Promise<string> => {
			// Operator-friendly explanation of "why is trading in this state right now."
			// Reads circuit-breaker, trading-state, and equity snapshots; returns a
			// plain-English summary with a concrete recovery path. Read-only.
			const tradingState = store.getTradingState();
			const paperMode = isPaperMode();
			const breakerStatus = circuitBreaker?.getStatus() ?? { halted: false, reasons: [] };
			const breakerStates = circuitBreaker?.getPersistedStates() ?? [];
			const peakEquity = store.getPeakEquity();
			const currentEquity = store.resolveReportEquity(paperMode);
			const drawdownPct = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
			// riskManager stores maxDrawdownPct as a percentage value (e.g., 10 = 10%),
			// not as a fraction. Don't multiply by 100 again.
			const maxDrawdownPct = riskManager ? riskManager.getConfig().maxDrawdownPct : 7;
			const recoveryEquity = peakEquity * (1 - maxDrawdownPct / 100);

			let state: "ACTIVE" | "HALTED" | "LOCKED" | "COOLDOWN" | "DEGRADED" = "ACTIVE";
			let headline = "Trading is ACTIVE.";
			let summary = "All gates clear; new entries allowed.";
			const operatorActionRequired = tradingState === "HALTED" || tradingState === "LOCKED";
			const degradedByBreaker = !operatorActionRequired && breakerStatus.halted;

			const trippedBreaker = breakerStates.find((b) => b.is_tripped === 1);
			if (operatorActionRequired) {
				state = tradingState as typeof state;
				headline = `Trading is ${tradingState}.`;
				if (trippedBreaker) {
					summary = `Triggered: ${trippedBreaker.trip_reason ?? "unknown"} on ${trippedBreaker.tripped_at}.`;
				} else if (breakerStatus.halted) {
					summary = `Triggered: ${breakerStatus.reasons.join("; ")}.`;
				} else {
					summary = `Trading state set to ${tradingState} but no circuit-breaker is currently tripped — likely an operator-acknowledged halt or a stale state flag.`;
				}
			} else if (breakerStatus.halted) {
				state = "DEGRADED";
				headline = "Trading is degraded.";
				summary = `Circuit breaker tripped but trading_state is still ${tradingState}, so new entries remain blocked: ${breakerStatus.reasons.join("; ")}.`;
			}

			const drawdownRecoveryMessage = paperMode
				? `Close positions first, then run trade_reset_drawdown if this drawdown is accepted; otherwise wait for equity > $${recoveryEquity.toFixed(2)}.`
				: `Wait for equity > $${recoveryEquity.toFixed(2)}. If the breaker still looks stale after recovery, operator intervention is required outside the paper-only reset tools.`;

			const breakerRecoveryMessage =
				operatorActionRequired || degradedByBreaker
					? trippedBreaker?.breaker_type === "drawdown"
						? `${paperMode ? "Paper" : "Live"} mode: breaker is still tripped. ${drawdownRecoveryMessage}`
						: paperMode
							? "Paper mode: breaker is still tripped. Review it, then run trade_reset_breakers or wait for cooldown recovery if applicable."
							: "Live mode: breaker is still tripped. Wait for cooldown recovery if applicable; if the state stays stale after review, operator intervention is required outside the paper-only reset tools."
					: null;

			const recovery =
				operatorActionRequired || degradedByBreaker
					? {
							mode: "operator_reset" as const,
							plain_english: breakerRecoveryMessage,
							equity_threshold:
								trippedBreaker?.breaker_type === "drawdown" ? round(recoveryEquity, 2) : undefined,
							operator_action_required: true,
						}
					: {
							mode: "auto" as const,
							plain_english: "No reset needed; trading is operational.",
							operator_action_required: false,
						};

			return JSON.stringify({
				state,
				headline,
				summary,
				trigger: trippedBreaker
					? {
							source: `circuit_breaker.${trippedBreaker.breaker_type}`,
							reason: trippedBreaker.trip_reason,
							triggered_at: trippedBreaker.tripped_at,
						}
					: null,
				recovery,
				equity_context: {
					current_equity: round(currentEquity, 2),
					peak_equity: round(peakEquity, 2),
					drawdown_pct: round(drawdownPct, 2),
					max_drawdown_pct: maxDrawdownPct,
				},
				paperMode,
			});
		},

		trade_set_kill_switch: async (args: Record<string, unknown>): Promise<string> => {
			const enabled = args.enabled === true || args.enabled === "true";
			store.setSetting("trading_kill_switch", enabled ? "true" : "false");
			return JSON.stringify({
				ok: true,
				trading_kill_switch: enabled,
				message: enabled
					? "Kill switch ON — new entries blocked (signal engine, execution manager, trade_buy)."
					: "Kill switch OFF — new entries allowed if other gates pass.",
			});
		},

		trade_set_daily_loss_cap: async (args: Record<string, unknown>): Promise<string> => {
			const raw = args.cap_usd;
			if (raw === null || raw === undefined || raw === "") {
				store.setSetting("daily_loss_cap_usd", "");
				return JSON.stringify({
					ok: true,
					daily_loss_cap_usd: null,
					message: "Daily loss cap cleared.",
				});
			}
			const n = Number(raw);
			if (!Number.isFinite(n) || n <= 0) {
				return JSON.stringify({ error: "cap_usd must be a positive number or omitted to clear" });
			}
			store.setSetting("daily_loss_cap_usd", String(n));
			return JSON.stringify({
				ok: true,
				daily_loss_cap_usd: n,
				message: `Daily loss cap set to $${n} realized P&L per UTC day (paper or live matches paper_mode).`,
			});
		},

		// ── Strategy & backtesting ──

		trade_rsi_divergence_counters: async (args: Record<string, unknown> = {}): Promise<string> => {
			const reset = args.reset === true || args.reset === 1 || args.reset === "true";
			const before = reset ? getRsiDivergenceCounters() : null;
			if (reset) resetRsiDivergenceCounters();
			const snapshot = reset ? before! : getRsiDivergenceCounters();
			return JSON.stringify({
				snapshot,
				reset,
				takenAt: new Date().toISOString(),
			});
		},

		trade_list_strategies: async (): Promise<string> => {
			if (!strategyRegistry) {
				return JSON.stringify({ error: "Strategy registry not initialized" });
			}
			const strategies = strategyRegistry.list();
			const active = strategyRegistry.getActive();
			return JSON.stringify({
				available: strategies.map((s) => ({
					name: s.name,
					description: s.description,
					timeframe: s.timeframe,
					minCandles: s.minCandles,
					riskParams: s.riskParams,
					active: strategyRegistry.isActive(s.name),
				})),
				activeCount: active.length,
				active: active.map((a) => ({
					name: a.strategy.name,
					symbols: a.symbols,
					activatedAt: a.activatedAt,
				})),
			});
		},

		trade_backtest: async (args: Record<string, unknown>): Promise<string> => {
			if (!strategyRegistry) {
				return JSON.stringify({ error: "Strategy registry not initialized" });
			}

			const strategyName = args.strategy as string;
			if (!strategyName) throw new Error("strategy name is required");

			const strategy = strategyRegistry.get(strategyName);
			if (!strategy) {
				return JSON.stringify({
					error: `Strategy not found: ${strategyName}`,
					available: strategyRegistry.list().map((s) => s.name),
				});
			}

			const symbol = normalizeSymbol((args.symbol as string) || "BTC");
			const timeframe = (args.timeframe as string) || strategy.timeframe;
			const startingEquity = (args.starting_equity as number) || 10_000;
			// e.g. "7d", "30d", "90d", "1y" — limits how far back we look
			const period = (args.period as string) || undefined;

			// Parse period string like "30d", "90d", "1y" into milliseconds.
			// Returns undefined if not set, which means "use all available data".
			const periodMs = period ? parsePeriodMs(period) : undefined;

			// Load candles from the local database
			type CandleRow = {
				symbol: string;
				timeframe: string;
				openTime: number;
				open: number;
				high: number;
				low: number;
				close: number;
				volume: number;
			};
			let candles: CandleRow[] = [];

			if (candleStore) {
				if (periodMs !== undefined) {
					// Filter by time window when a period is specified
					const fromMs = Date.now() - periodMs;
					candles = candleStore.getRange(symbol, timeframe, fromMs, Date.now());
				} else {
					// No period specified — grab up to 1000 candles (most available)
					candles = candleStore.get(symbol, timeframe, 1000).reverse(); // DESC→ASC
				}
			}

			// If we don't have enough candles locally, try fetching from the exchange API
			if (candles.length < strategy.minCandles) {
				try {
					const raw = await client.getCandles(symbol, timeframe);
					if (raw.length > 0) {
						raw.sort((a, b) => a.openTime - b.openTime);
						candles = raw.map((c) => ({
							symbol,
							timeframe,
							openTime: c.openTime,
							open: c.open,
							high: c.high,
							low: c.low,
							close: c.close,
							volume: c.volume,
						}));
					}
				} catch (err) {
					console.debug(
						"[trading] supplemental candle fetch failed:",
						err instanceof Error ? err.message : err,
					);
				}
			}

			if (candles.length < strategy.minCandles) {
				return JSON.stringify({
					error: `Insufficient data: ${candles.length} candles available, ${strategy.minCandles} required for ${strategyName}. Run trade_fetch_candles first to build history.`,
				});
			}

			// Validate OHLCV data — corrupted candles propagate NaN through indicators
			candles = candles.filter((c) => {
				if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return false;
				if (c.high < c.low) return false;
				if (c.volume < 0) return false;
				if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return false;
				return true;
			});

			if (candles.length < strategy.minCandles) {
				return JSON.stringify({
					error: `After filtering invalid candles, only ${candles.length} valid candles remain (${strategy.minCandles} required).`,
				});
			}

			// Run the backtest
			const backtester = new Backtester({ startingEquity });
			const result = backtester.run(strategy, candles);

			const finalEquity = result.equityCurve[result.equityCurve.length - 1] ?? startingEquity;
			const returnPct = round(((finalEquity - startingEquity) / startingEquity) * 100, 2);

			// Persist result to the database so it can be compared later
			const savedId = store.saveBacktestResult({
				strategy: result.strategy,
				symbol: result.symbol,
				timeframe: result.timeframe,
				startDate: result.startDate,
				endDate: result.endDate,
				startingEquity,
				finalEquity: round(finalEquity, 2),
				totalPnl: result.performance.totalPnl,
				totalReturnPct: returnPct,
				winRate: result.performance.winRate,
				sharpeRatio: result.performance.sharpeRatio,
				maxDrawdownPct: result.performance.maxDrawdownPct,
				totalTrades: result.performance.totalTrades,
				resultJson: JSON.stringify(result),
			});

			// Generate human-readable markdown report
			const report = generateBacktestReport(result);

			return JSON.stringify({
				id: savedId,
				strategy: result.strategy,
				symbol: result.symbol,
				timeframe: result.timeframe,
				period: { start: result.startDate, end: result.endDate, candles: result.candlesUsed },
				signals: result.signals,
				performance: result.performance,
				tradeCount: result.trades.length,
				finalEquity: round(finalEquity, 2),
				returnPct,
				report, // full markdown report — ask Zaraa to show this
				sampleTrades: result.trades.slice(-5).map((t) => ({
					direction: t.direction,
					entry: round(t.entryPrice, 2),
					exit: round(t.exitPrice, 2),
					pnl: round(t.pnl, 2),
					rMultiple: round(t.rMultiple, 2),
					exitReason: t.exitReason,
				})),
			});
		},

		trade_backtest_list: async (args: Record<string, unknown>): Promise<string> => {
			// Lists previously saved backtest results for comparison.
			// Optionally filter by strategy name or symbol.
			const strategy = args.strategy as string | undefined;
			const symbol = args.symbol ? normalizeSymbol(args.symbol as string) : undefined;
			const limit = (args.limit as number) || 10;

			const results = store.listBacktestResults({ strategy, symbol, limit });

			if (results.length === 0) {
				return JSON.stringify({
					message: "No backtest results found. Run trade_backtest first.",
					results: [],
				});
			}

			return JSON.stringify({
				count: results.length,
				results: results.map((r) => ({
					id: r.id,
					strategy: r.strategy,
					symbol: r.symbol,
					timeframe: r.timeframe,
					period: { start: r.startDate, end: r.endDate },
					startingEquity: r.startingEquity,
					finalEquity: r.finalEquity,
					returnPct: r.totalReturnPct,
					winRate: r.winRate,
					sharpeRatio: r.sharpeRatio,
					maxDrawdownPct: r.maxDrawdownPct,
					totalTrades: r.totalTrades,
					createdAt: r.createdAt,
				})),
			});
		},

		trade_optimize: async (args: Record<string, unknown>): Promise<string> => {
			if (!strategyRegistry) {
				return JSON.stringify({ error: "Strategy registry not initialized" });
			}

			const strategyName = args.strategy as string;
			if (!strategyName) throw new Error("strategy name is required");

			const strategy = strategyRegistry.get(strategyName);
			if (!strategy) {
				return JSON.stringify({
					error: `Strategy not found: ${strategyName}`,
					available: strategyRegistry.list().map((s) => s.name),
				});
			}

			const period = (args.period as string) || "90d";
			const periodMs = parsePeriodMs(period) ?? 90 * 24 * 60 * 60 * 1000;
			const symbol = normalizeSymbol((args.symbol as string) || "BTC");
			const timeframe = strategy.timeframe;

			type CandleRow = {
				symbol?: string;
				timeframe?: string;
				openTime: number;
				open: number;
				high: number;
				low: number;
				close: number;
				volume: number;
			};
			let candles: CandleRow[] = [];

			if (candleStore) {
				const fromMs = Date.now() - periodMs;
				candles = candleStore.getRange(symbol, timeframe, fromMs, Date.now());
			}

			if (candles.length < strategy.minCandles) {
				try {
					const raw = await client.getCandles(symbol, timeframe);
					if (raw.length > 0) {
						const cutoff = Date.now() - periodMs;
						candles = raw.filter((c) => c.openTime >= cutoff);
					}
				} catch {
					// Proceed with whatever candles we have
				}
			}

			if (candles.length < strategy.minCandles) {
				return JSON.stringify({
					error: `Insufficient candle data: ${candles.length} candles (need ${strategy.minCandles})`,
					periodRequested: period,
					symbol,
				});
			}

			// D14/D1: record every variant to the shared, append-only trials ledger
			// and gate the top pick — deflated-Sharpe (multiple-testing penalty using
			// cumulative N across peer agents + crash-resumes) and a tax-adjusted
			// net-edge cost screen. FAIL CLOSED: if the ledger can't be constructed we
			// refuse the run rather than degrade to a weaker in-run N.
			let trialsLedger: TrialsLedger;
			try {
				trialsLedger = new TrialsLedger(store.getDb());
			} catch (err) {
				return JSON.stringify({
					error: "trials ledger unavailable — multiple-testing gate fails closed",
					detail: err instanceof Error ? err.message : String(err),
					promotionBlocked: true,
					strategy: strategyName,
				});
			}
			const takerFeeBps = (Number(store.getSetting("fee_rate")) || 0.00075) * 10_000;
			const maxTradeUsd = Number(store.getSetting("max_trade_usd")) || 25;
			const shortTermTaxRate = Number(store.getSetting("short_term_tax_rate")) || 0.24;
			const optimizer = new StrategyOptimizer(
				{},
				{
					trialsLedger,
					agentId: "trade_optimize",
					netEdgeInputs: {
						takerFeeBps,
						spreadBps: 5,
						avgTradeNotionalUsd: maxTradeUsd,
						shortTermTaxRate,
					},
				},
			);
			const result = optimizer.run(strategy, candles as import("./data/candle-store").Candle[]);

			// Persist run to DB
			try {
				const db = (store as unknown as { getDb?: () => unknown }).getDb?.();
				if (db) {
					(db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } })
						.prepare(
							`INSERT OR IGNORE INTO optimizer_results
								(id, strategyName, runAt, periodDays, candleCount, paramsTestedCount, resultsJson)
							 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							crypto.randomUUID(),
							strategyName,
							new Date().toISOString(),
							Math.round(periodMs / 86400000),
							candles.length,
							result.paramsTestedCount,
							JSON.stringify(result.top3),
						);
				}
			} catch {
				// Non-fatal
			}

			// D14/D1 enforcement: surface the promotion verdict unmissably. A failed
			// gate means these params must NOT be promoted (multiple-testing or net-edge).
			return JSON.stringify({
				...result,
				promotionBlocked: !result.gate.pass,
				blockReasons: result.gate.pass ? [] : result.gate.reasons,
			});
		},

		trade_strategy_rankings: async (): Promise<string> => {
			// Read `strategy_trades` from the journal DB (trade-journal.db) where
			// rows actually land via TradeJournal/LeaderboardStore. Falling back
			// to `store.getDb()` (trading.db) leaves the table empty in prod.
			const ranker = new StrategyRanker(store, {
				readDb: leaderboardStore?.getDb(),
				includeShadow: zaraaTradingPaperMode === true,
			});
			const rankings = ranker.updateRankings();
			return JSON.stringify({ rankings, updatedCount: rankings.length });
		},

		trade_snapshot_strategies: async (): Promise<string> => {
			if (!leaderboardStore) {
				return JSON.stringify({
					error: "Leaderboard not available — leaderboardStore not configured.",
				});
			}
			// Same shadow rationale as the ranker: paper trades are tagged
			// isShadow=1 so the strict filter would skip the whole paper book.
			leaderboardStore.setIncludeShadow(zaraaTradingPaperMode === true);
			leaderboardStore.snapshotToday();
			return JSON.stringify({ ok: true, snapshottedAt: new Date().toISOString() });
		},

		trade_dynamic_risk_status: async (): Promise<string> => {
			const adjuster = new DynamicRiskAdjuster(store);
			const adjustment = adjuster.refresh();
			return JSON.stringify({ adjustment });
		},

		trade_deploy_strategy: async (args: Record<string, unknown>): Promise<string> => {
			if (!strategyRegistry) {
				return JSON.stringify({ error: "Strategy registry not initialized" });
			}

			const strategyName = args.strategy as string;
			if (!strategyName) throw new Error("strategy name is required");

			const symbols = (args.symbols as string[]) ?? ["BTC_USDT"];
			const normalized = symbols.map(normalizeSymbol);

			if (args.deactivate === true) {
				const removed = strategyRegistry.deactivate(strategyName);
				return JSON.stringify({
					message: removed
						? `Strategy ${strategyName} deactivated`
						: `Strategy ${strategyName} was not active`,
				});
			}

			try {
				const active = strategyRegistry.activate(strategyName, normalized);
				return JSON.stringify({
					message: `Strategy ${strategyName} deployed on ${normalized.join(", ")}`,
					strategy: active.strategy.name,
					symbols: active.symbols,
					timeframe: active.strategy.timeframe,
					activatedAt: active.activatedAt,
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		// ── Technical indicators ──

		trade_get_indicators: async (args: Record<string, unknown>): Promise<string> => {
			const symbol = normalizeSymbol(args.symbol as string);
			const timeframe = (args.timeframe as string) || "1h";
			const requested = (args.indicators as string[]) ?? [
				"rsi",
				"macd",
				"bollinger",
				"ema_20",
				"ema_50",
				"atr",
			];

			// Try to get candles from local store first, fall back to API
			let closes: number[] = [];
			let highs: number[] = [];
			let lows: number[] = [];
			let volumes: number[] = [];

			if (candleStore) {
				const candles = candleStore.get(symbol, timeframe, 200);
				if (candles.length > 0) {
					// candle-store returns DESC, reverse to ASC for indicators
					const sorted = candles.reverse();
					closes = sorted.map((c) => c.close);
					highs = sorted.map((c) => c.high);
					lows = sorted.map((c) => c.low);
					volumes = sorted.map((c) => c.volume);
				}
			}

			// Fall back to live API if no local data
			if (closes.length === 0) {
				const raw = await client.getCandles(symbol, timeframe);
				if (raw.length === 0) {
					return JSON.stringify({ error: `No candle data available for ${symbol}/${timeframe}` });
				}
				// API may return newest-first; sort by time ascending
				raw.sort((a, b) => a.openTime - b.openTime);
				closes = raw.map((c) => c.close);
				highs = raw.map((c) => c.high);
				lows = raw.map((c) => c.low);
				volumes = raw.map((c) => c.volume);
			}

			const result: Record<string, unknown> = {
				symbol,
				timeframe,
				dataPoints: closes.length,
				price: closes[closes.length - 1],
			};

			for (const ind of requested) {
				const key = ind.toLowerCase();
				if (key === "rsi" || key.startsWith("rsi_")) {
					const rawPeriod = key.includes("_") ? Number(key.split("_")[1]) : 14;
					const period = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 14;
					const vals = indicators.rsi(closes, period);
					result.rsi = { period, value: vals.length > 0 ? round(vals[vals.length - 1]) : null };
				} else if (key === "macd") {
					const m = indicators.macd(closes);
					result.macd =
						m.macd.length > 0
							? {
									macd: round(m.macd[m.macd.length - 1]),
									signal: round(m.signal[m.signal.length - 1]),
									histogram: round(m.histogram[m.histogram.length - 1]),
								}
							: null;
				} else if (key === "bollinger" || key === "bb") {
					const bb = indicators.bollingerBands(closes);
					result.bollinger =
						bb.middle.length > 0
							? {
									upper: round(bb.upper[bb.upper.length - 1]),
									middle: round(bb.middle[bb.middle.length - 1]),
									lower: round(bb.lower[bb.lower.length - 1]),
									bandwidth: round(
										((bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) /
											bb.middle[bb.middle.length - 1]) *
											100,
									),
								}
							: null;
				} else if (key.startsWith("sma_")) {
					const rawPeriod = Number(key.split("_")[1]);
					const period = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 20;
					const vals = indicators.sma(closes, period);
					result[key] = vals.length > 0 ? round(vals[vals.length - 1]) : null;
				} else if (key.startsWith("ema_")) {
					const rawPeriod = Number(key.split("_")[1]);
					const period = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 20;
					const vals = indicators.ema(closes, period);
					result[key] = vals.length > 0 ? round(vals[vals.length - 1]) : null;
				} else if (key === "atr" || key.startsWith("atr_")) {
					const rawPeriod = key.includes("_") ? Number(key.split("_")[1]) : 14;
					const period = Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 14;
					const vals = indicators.atr(highs, lows, closes, period);
					result.atr = { period, value: vals.length > 0 ? round(vals[vals.length - 1]) : null };
				} else if (key === "vwap") {
					const vals = indicators.vwap(highs, lows, closes, volumes);
					result.vwap = vals.length > 0 ? round(vals[vals.length - 1]) : null;
				} else if (key === "stoch_rsi") {
					const vals = indicators.stochRsi(closes);
					result.stochRsi = vals.length > 0 ? round(vals[vals.length - 1]) : null;
				} else if (key === "obv") {
					const vals = indicators.obv(closes, volumes);
					result.obv = vals.length > 0 ? round(vals[vals.length - 1]) : null;
				} else if (key === "ema_cross" || key.startsWith("ema_cross_")) {
					let fastPeriod = 12;
					let slowPeriod = 26;
					if (key.startsWith("ema_cross_")) {
						const rest = key.slice("ema_cross_".length);
						const parts = rest.split("_").filter(Boolean);
						if (parts.length >= 2) {
							const f = Number(parts[0]);
							const s = Number(parts[1]);
							if (Number.isFinite(f) && Number.isFinite(s) && f > 0 && s > 0 && f < s) {
								fastPeriod = f;
								slowPeriod = s;
							}
						}
					}
					const crosses = indicators.detectEmaCrossovers(closes, fastPeriod, slowPeriod);
					const last = crosses.length > 0 ? crosses[crosses.length - 1]! : null;
					result.emaCross = {
						fastPeriod,
						slowPeriod,
						lastCross: last
							? {
									type: last.type,
									index: last.index,
									price: round(last.price),
								}
							: null,
						recentCrosses: crosses.slice(-5).map((c) => ({
							type: c.type,
							index: c.index,
							price: round(c.price),
						})),
						countInWindow: crosses.length,
					};
				}
			}

			// Trend summary
			const ema20 = indicators.ema(closes, 20);
			const ema50 = indicators.ema(closes, 50);
			if (ema20.length > 0 && ema50.length > 0) {
				const shortEma = ema20[ema20.length - 1];
				const longEma = ema50[ema50.length - 1];
				const price = closes[closes.length - 1];
				result.trend = {
					direction: shortEma > longEma ? "bullish" : "bearish",
					priceVsEma20: price > shortEma ? "above" : "below",
					priceVsEma50: price > longEma ? "above" : "below",
					ema20AboveEma50: shortEma > longEma,
				};
			}

			return JSON.stringify(result);
		},

		trade_fetch_candles: async (args: Record<string, unknown>): Promise<string> => {
			if (!candleFetcher) {
				return JSON.stringify({ error: "Candle fetcher not initialized" });
			}

			// Allow overriding symbols for a one-off fetch
			const symbols = args.symbols as string[] | undefined;
			if (symbols?.length) {
				let fetched = 0;
				const errors: string[] = [];
				for (const s of symbols) {
					const sym = normalizeSymbol(s);
					for (const tf of candleFetcher.getTimeframes()) {
						try {
							fetched += await candleFetcher.fetchCandles(sym, tf);
						} catch (err) {
							errors.push(`${sym}/${tf}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				}
				return JSON.stringify({ fetched, errors: errors.length > 0 ? errors : undefined });
			}

			const result = await candleFetcher.fetchAll();
			return JSON.stringify({
				fetched: result.fetched,
				errors: result.errors.length > 0 ? result.errors : undefined,
				symbols: candleFetcher.getSymbols(),
				timeframes: candleFetcher.getTimeframes(),
			});
		},

		/**
		 * Backfill historical candle data for specified symbols and timeframes.
		 *
		 * Paginates through the Crypto.com API to fetch 30-90 days of history,
		 * upserting into the local CandleStore. Essential for backtesting and
		 * strategy development — the regular fetch only grabs the latest batch.
		 */
		trade_backfill_candles: async (args: Record<string, unknown>): Promise<string> => {
			if (!candleFetcher) {
				return JSON.stringify({ error: "Candle fetcher not initialized" });
			}

			const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
			const defaultSymbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT"];
			const defaultTimeframes = ["1h", "4h"] as import("./data/candle-fetcher.js").Timeframe[];

			const symbols =
				(args.symbols as string[] | undefined)?.map(normalizeSymbol) ?? defaultSymbols;
			const timeframes =
				(args.timeframes as string[] | undefined)?.filter(
					(tf): tf is import("./data/candle-fetcher.js").Timeframe =>
						["1m", "5m", "15m", "30m", "1h", "4h", "1d"].includes(tf),
				) ?? defaultTimeframes;

			const { results, errors } = await candleFetcher.backfillAll(symbols, timeframes, days);

			const totalCandles = results.reduce((sum, r) => sum + r.candlesFetched, 0);
			const totalRequests = results.reduce((sum, r) => sum + r.requestsMade, 0);

			return JSON.stringify({
				message: `Backfilled ${totalCandles} candles across ${results.length} symbol/timeframe pairs (${totalRequests} API requests)`,
				days,
				results: results.map((r) => ({
					symbol: r.symbol,
					timeframe: r.timeframe,
					candles: r.candlesFetched,
					requests: r.requestsMade,
					range:
						r.oldestCandle && r.newestCandle
							? `${new Date(r.oldestCandle).toISOString().slice(0, 10)} to ${new Date(r.newestCandle).toISOString().slice(0, 10)}`
							: "none",
				})),
				errors: errors.length > 0 ? errors : undefined,
			});
		},

		// ── Signal engine ──

		trade_scan_signals: async (): Promise<string> => {
			if (!isPaperMode()) {
				return JSON.stringify({
					error:
						"trade_scan_signals is blocked while paper mode is off. Use paper_mode=true for smoke/scheduler scans; live scans require an explicit operator live workflow outside this read/write smoke path.",
					mode: "LIVE",
					paperMode: false,
				});
			}

			if (!signalEngine) {
				return JSON.stringify({ error: "Signal engine not initialized" });
			}

			const records = await signalEngine.scan();
			if (records.length === 0) {
				return JSON.stringify({
					message: "No signals generated this scan",
					diagnostics: signalEngine.getScanDiagnostics(),
					config: signalEngine.getConfig(),
				});
			}

			return JSON.stringify({
				signals: records.map((r) => ({
					id: r.id,
					strategy: r.strategyName,
					symbol: r.symbol,
					direction: r.direction,
					confidence: round(r.confidence, 3),
					entryPrice: round(r.entryPrice, 2),
					stopLoss: round(r.stopLoss, 2),
					takeProfit: round(r.takeProfit, 2),
					qty: r.qty,
					status: r.status,
					rejectionReasons: r.rejectionReasons,
				})),
				count: records.length,
			});
		},

		trade_get_signals: async (args: Record<string, unknown>): Promise<string> => {
			if (!tradeJournal) {
				return JSON.stringify({ error: "Trade journal not initialized" });
			}

			const strategyName = args.strategy as string | undefined;
			const limit = (args.limit as number) || 20;

			const signals = strategyName
				? tradeJournal.getSignalsByStrategy(strategyName, limit)
				: tradeJournal.getRecentSignals(limit);

			const stats = tradeJournal.getStrategyStats();

			return JSON.stringify({
				signals: signals.map((s) => ({
					id: s.id,
					strategy: s.strategyName,
					symbol: s.symbol,
					direction: s.direction,
					confidence: round(s.confidence, 3),
					entryPrice: round(s.entryPrice, 2),
					status: s.status,
					rejectionReasons: s.rejectionReasons,
					createdAt: s.createdAt,
				})),
				strategyStats: stats,
			});
		},

		// ── Analytics ──

		trade_analytics: async (): Promise<string> => {
			const analyzer = new PortfolioAnalyzer();
			const allPositions = store.getAllPositions();
			const equityHistory = store.getEquityHistory(500);

			const result = analyzer.analyze(allPositions, equityHistory);

			return JSON.stringify(result);
		},

		trade_macro_prediction: async (args: Record<string, unknown>): Promise<string> => {
			const years =
				typeof args.years === "number" && args.years > 0 && args.years <= 30 ? args.years : 10;
			const horizonDays =
				typeof args.horizon_days === "number" && args.horizon_days > 0 && args.horizon_days <= 120
					? args.horizon_days
					: 20;
			let symbols: string[] | undefined;
			if (Array.isArray(args.symbols)) {
				symbols = args.symbols.filter((s): s is string => typeof s === "string" && s.length > 0);
			} else if (typeof args.symbols_csv === "string" && args.symbols_csv.trim()) {
				symbols = args.symbols_csv
					.split(/[\s,]+/)
					.map((s) => s.trim())
					.filter(Boolean);
			}
			const report = await runMacroPredictionReport({
				symbols: symbols?.length ? symbols : undefined,
				years,
				horizonDays,
			});
			return JSON.stringify(report);
		},

		trade_strategy_report: async (args: Record<string, unknown>): Promise<string> => {
			if (!tradeJournal) {
				return JSON.stringify({ error: "Trade journal not initialized" });
			}

			const analyzer = new PortfolioAnalyzer();

			// Get all strategy trades
			const stats = tradeJournal.getStrategyStats();
			const allTrades: import("./engine/trade-journal.js").StrategyTradeRecord[] = [];
			for (const stat of stats) {
				const trades = tradeJournal.getStrategyTrades(stat.strategy, 200);
				allTrades.push(...trades);
			}

			const comparison = analyzer.compareStrategies(allTrades);

			// Optionally filter to a single strategy for detailed view
			const strategyName = args.strategy as string | undefined;
			if (strategyName) {
				const focused = comparison.find((c) => c.name === strategyName);
				const signals = tradeJournal.getSignalsByStrategy(strategyName, 50);
				const trades = tradeJournal.getStrategyTrades(strategyName, 50);

				return JSON.stringify({
					strategy: focused ?? { error: `No closed trades for ${strategyName}` },
					recentSignals: signals.slice(0, 10).map((s) => ({
						id: s.id,
						direction: s.direction,
						confidence: round(s.confidence, 3),
						status: s.status,
						createdAt: s.createdAt,
					})),
					recentTrades: trades.slice(0, 10).map((t) => ({
						symbol: t.symbol,
						direction: t.direction,
						entryPrice: round(t.entryPrice, 2),
						exitPrice: t.exitPrice != null ? round(t.exitPrice, 2) : null,
						pnl: t.pnl != null ? round(t.pnl, 2) : null,
						rMultiple: t.rMultiple != null ? round(t.rMultiple, 2) : null,
						exitReason: t.exitReason,
					})),
				});
			}

			return JSON.stringify({
				strategies: comparison,
				signalStats: stats,
			});
		},

		// ── Trade Journal ──

		trade_journal: async (args: Record<string, unknown>): Promise<string> => {
			// days: how far back to look (default 7 = weekly report)
			const days =
				typeof args.days === "number" && args.days > 0
					? Math.min(args.days, 365) // cap at 1 year for safety
					: 7;

			// Get the underlying SQLite database from the TradingStore
			const db = store.getDb();
			const reporter = new JournalReporter(db);

			try {
				const result = reporter.generate({ days });
				return JSON.stringify({
					saved: result.path,
					stats: result.stats,
					preview:
						result.markdown.slice(0, 800) +
						(result.markdown.length > 800 ? "\n…(truncated, see file)" : ""),
				});
			} catch (err) {
				return JSON.stringify({
					error: `Journal generation failed: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		},

		// ── Multi-exchange ──

		trade_list_exchanges: async (): Promise<string> => {
			if (!deps.exchangeManager) {
				return JSON.stringify({ error: "Exchange manager not initialized" });
			}
			return JSON.stringify({
				exchanges: deps.exchangeManager.list(),
				count: deps.exchangeManager.size,
			});
		},

		trade_compare_prices: async (args: Record<string, unknown>): Promise<string> => {
			if (!deps.exchangeManager) {
				return JSON.stringify({ error: "Exchange manager not initialized" });
			}
			const symbol = normalizeSymbol(args.symbol as string);
			const result = await deps.exchangeManager.comparePrices(symbol);
			return JSON.stringify(result);
		},

		trade_aggregate_balances: async (): Promise<string> => {
			if (!deps.exchangeManager) {
				return JSON.stringify({ error: "Exchange manager not initialized" });
			}
			const result = await deps.exchangeManager.aggregateBalances();
			return JSON.stringify(result);
		},

		// ── WebSocket price feed ──

		trade_ws_status: async (): Promise<string> => {
			if (!deps.priceFeed) {
				return JSON.stringify({ error: "Price feed not initialized" });
			}
			const s = deps.priceFeed.status();
			const prices: Record<string, { last: number; bid: number; ask: number }> = {};
			for (const [symbol, update] of deps.priceFeed.getAllPrices()) {
				prices[symbol] = { last: update.last, bid: update.bid, ask: update.ask };
			}
			return JSON.stringify({ ...s, latestPrices: prices });
		},

		trade_ws_subscribe: async (args: Record<string, unknown>): Promise<string> => {
			if (!deps.priceFeed) {
				return JSON.stringify({ error: "Price feed not initialized" });
			}

			const symbols = args.symbols as string[] | undefined;
			if (!symbols?.length) {
				return JSON.stringify({ error: "symbols array is required" });
			}

			const normalized = symbols.map(normalizeSymbol);

			if (!deps.priceFeed.connected) {
				try {
					await deps.priceFeed.connect();
				} catch (err) {
					return JSON.stringify({
						error: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}

			deps.priceFeed.subscribe(normalized);

			return JSON.stringify({
				subscribed: normalized,
				totalSubscriptions: deps.priceFeed.subscribedSymbols.length,
				connected: deps.priceFeed.connected,
			});
		},

		trade_ws_unsubscribe: async (args: Record<string, unknown>): Promise<string> => {
			if (!deps.priceFeed) {
				return JSON.stringify({ error: "Price feed not initialized" });
			}

			const symbols = args.symbols as string[] | undefined;
			if (!symbols?.length) {
				return JSON.stringify({ error: "symbols array is required" });
			}

			const normalized = symbols.map(normalizeSymbol);
			deps.priceFeed.unsubscribe(normalized);

			return JSON.stringify({
				unsubscribed: normalized,
				remainingSubscriptions: deps.priceFeed.subscribedSymbols,
			});
		},

		// ── Alert checker (called by scheduler, not directly by LLM) ──

		trade_check_alerts: async (): Promise<string> => {
			const alerts = store.getActiveAlerts();
			if (alerts.length === 0) {
				return JSON.stringify({ message: "No active alerts to check." });
			}

			const triggered: string[] = [];
			const expired: string[] = [];
			const STALE_DAYS = 7;
			const STALE_PRICE_DRIFT = 0.5; // 50% away from current price

			// Group alerts by symbol to minimize API calls
			const bySymbol = new Map<string, typeof alerts>();
			for (const alert of alerts) {
				const list = bySymbol.get(alert.symbol) || [];
				list.push(alert);
				bySymbol.set(alert.symbol, list);
			}

			for (const [symbol, symbolAlerts] of bySymbol) {
				try {
					const ticker = await client.getTicker(symbol);
					for (const alert of symbolAlerts) {
						// Auto-expire: alerts active >7 days AND >50% away from current price
						const ageMs = Date.now() - new Date(alert.createdAt).getTime();
						const ageDays = ageMs / (1000 * 60 * 60 * 24);
						const priceDrift = Math.abs(ticker.last - alert.targetPrice) / ticker.last;
						if (ageDays > STALE_DAYS && priceDrift > STALE_PRICE_DRIFT) {
							store.triggerAlert(alert.id); // Mark as triggered to deactivate
							expired.push(
								`${symbol} ${alert.condition} $${alert.targetPrice} (stale: ${Math.round(ageDays)}d old, ${Math.round(priceDrift * 100)}% away)`,
							);
							continue;
						}

						const hit =
							(alert.condition === "above" && ticker.last >= alert.targetPrice) ||
							(alert.condition === "below" && ticker.last <= alert.targetPrice);

						if (hit) {
							store.triggerAlert(alert.id);
							const message = `${symbol} is ${alert.condition} $${alert.targetPrice} (current: $${ticker.last})`;
							triggered.push(message);
							onAlert?.({
								id: alert.id,
								symbol,
								condition: alert.condition,
								targetPrice: alert.targetPrice,
								currentPrice: ticker.last,
								triggered: true,
								message,
							});
							emitTradingEvent("trading.alert.triggered", {
								id: alert.id,
								symbol,
								condition: alert.condition,
								targetPrice: alert.targetPrice,
								currentPrice: ticker.last,
								triggered: true,
								reason: "trade_check_alerts",
							});
						}
					}
				} catch (err) {
					console.debug(
						"[trading] alert check skipped for symbol group:",
						err instanceof Error ? err.message : err,
					);
				}
			}

			if (onTradingEvent && (triggered.length > 0 || expired.length > 0)) {
				const snapshot = await buildSnapshotUpdated("trade_check_alerts");
				emitTradingEvent("trading.snapshot.updated", snapshot);
			}

			return JSON.stringify({
				checked: alerts.length,
				triggered: triggered.length,
				expired: expired.length,
				details: triggered,
				expiredDetails: expired,
			});
		},

		// ── Daily report ──

		/**
		 * Comprehensive daily trading report.
		 *
		 * Summarizes the full trading day:
		 *   - Trades opened and closed today
		 *   - Realized P&L (from closed positions) and unrealized P&L (open positions)
		 *   - Win rate for the day
		 *   - Active market regime and trading session
		 *   - Equity vs yesterday
		 *   - Current open positions with live P&L
		 *
		 * Designed to run as a cron task at 23:55 UTC for end-of-day review,
		 * but can also be called manually at any time.
		 */
		trade_daily_report: async (args: Record<string, unknown>): Promise<string> => {
			const now = new Date();
			const todayUTC = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
			const date = (args.date as string) || todayUTC;

			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return JSON.stringify({ error: "date must be in YYYY-MM-DD format" });
			}

			const paperMode = isPaperMode();
			const modeLabel = paperMode ? "PAPER" : "LIVE";

			// ── Realized P&L from closed positions ──
			const pnlSummary = store.getDailyPnLSummary(date, paperMode);

			// ── Positions opened today ──
			const db = store.getDb();
			const paperFilter = paperMode ? 1 : 0;
			const openedToday = db
				.prepare(
					"SELECT * FROM positions WHERE openedAt LIKE ? AND isPaper = ? ORDER BY openedAt ASC",
				)
				.all(`${date}%`, paperFilter) as Array<Record<string, unknown>>;

			// ── Current open positions with unrealized P&L ──
			const openPositions = store.getOpenPositions();
			const positionsWithPnl: Array<{
				id: string;
				symbol: string;
				side: string;
				entryPrice: number;
				qty: number;
				currentPrice: number | null;
				unrealizedPnl: number | null;
				unrealizedPnlPct: number | null;
			}> = [];

			let totalUnrealizedPnl = 0;
			for (const pos of openPositions) {
				let currentPrice: number | null = null;
				let unrealizedPnl: number | null = null;
				let unrealizedPnlPct: number | null = null;

				try {
					const ticker = await client.getTicker(pos.symbol);
					currentPrice = ticker.last;
					unrealizedPnl =
						pos.side === "long"
							? (currentPrice - pos.entryPrice) * pos.qty
							: (pos.entryPrice - currentPrice) * pos.qty;
					const cost = pos.entryPrice * pos.qty;
					unrealizedPnlPct = cost > 0 ? (unrealizedPnl / cost) * 100 : 0;
					totalUnrealizedPnl += unrealizedPnl;
				} catch (err) {
					console.debug(
						"[trading] portfolio price fetch failed for",
						pos.symbol,
						err instanceof Error ? err.message : err,
					);
				}

				positionsWithPnl.push({
					id: pos.id,
					symbol: pos.symbol,
					side: pos.side,
					entryPrice: round(pos.entryPrice, 2),
					qty: pos.qty,
					currentPrice: currentPrice != null ? round(currentPrice, 2) : null,
					unrealizedPnl: unrealizedPnl != null ? round(unrealizedPnl, 2) : null,
					unrealizedPnlPct: unrealizedPnlPct != null ? round(unrealizedPnlPct, 2) : null,
				});
			}

			// ── Equity comparison vs yesterday ──
			const equityHistory = store.getEquityHistory(48); // last 48 snapshots (~2 days hourly)
			const latestEquity = store.getLatestEquity();
			// getLatestEquity() returns 0 when no positive snapshot exists (sentinel), not "account is zero".
			// Coalesce for operator-facing report only — same basis as risk-audit path elsewhere.
			let displayEquity = latestEquity;
			if (displayEquity <= 0) {
				const peakEquity = store.getPeakEquity();
				displayEquity = peakEquity > 0 ? peakEquity : store.getInitialEquity(paperMode);
			}
			const yesterdayDate = new Date(now);
			yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
			const yesterdayStr = `${yesterdayDate.getUTCFullYear()}-${String(yesterdayDate.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getUTCDate()).padStart(2, "0")}`;

			// Find the equity snapshot closest to yesterday's end
			const yesterdayEquity = equityHistory.find((s) => s.timestamp.startsWith(yesterdayStr));
			const equityChange = yesterdayEquity
				? round(displayEquity - yesterdayEquity.equity, 2)
				: null;
			const equityChangePct =
				yesterdayEquity && yesterdayEquity.equity !== 0
					? round(
							((displayEquity - yesterdayEquity.equity) / Math.abs(yesterdayEquity.equity)) * 100,
							2,
						)
					: null;

			// ── Session and regime context ──
			const sessionInfo = getCurrentSession(now);

			// ── Compose report ──
			const totalPnl = pnlSummary.totalPnl + round(totalUnrealizedPnl, 2);
			const pnlSign = totalPnl >= 0 ? "+" : "";
			const realizedSign = pnlSummary.totalPnl >= 0 ? "+" : "";
			const unrealizedSign = totalUnrealizedPnl >= 0 ? "+" : "";

			const header =
				`[${modeLabel}] Daily Report -- ${date} | ` +
				`Total P&L: ${pnlSign}$${round(totalPnl, 2).toFixed(2)} | ` +
				`Realized: ${realizedSign}$${pnlSummary.totalPnl.toFixed(2)} | ` +
				`Unrealized: ${unrealizedSign}$${round(totalUnrealizedPnl, 2).toFixed(2)}`;

			return JSON.stringify({
				header,
				date,
				mode: modeLabel,
				// Realized (closed positions)
				realized: {
					totalPnl: pnlSummary.totalPnl,
					closedTrades: pnlSummary.totalTrades,
					winningTrades: pnlSummary.winningTrades,
					losingTrades: pnlSummary.losingTrades,
					winRate: pnlSummary.winRate,
					positions: pnlSummary.positions,
				},
				// Unrealized (open positions)
				unrealized: {
					totalPnl: round(totalUnrealizedPnl, 2),
					openPositions: positionsWithPnl.length,
					positions: positionsWithPnl,
				},
				// Day activity
				tradesOpenedToday: openedToday.length,
				tradesClosedToday: pnlSummary.totalTrades,
				// Equity
				equity: {
					current: round(displayEquity, 2),
					yesterday: yesterdayEquity ? round(yesterdayEquity.equity, 2) : null,
					change: equityChange,
					changePct: equityChangePct,
				},
				// Market context
				session: {
					name: sessionInfo.session,
					isOverlap: sessionInfo.isOverlap,
					overlappingSessions: sessionInfo.overlappingSessions,
					minutesToNextSession: sessionInfo.minutesToNextSession,
					expectedVolumeMultiplier: sessionInfo.expectedVolumeMultiplier,
					description: sessionInfo.description,
				},
				// Paper portfolio (if applicable)
				paperPortfolio: pnlSummary.paperPortfolio ?? undefined,
			});
		},

		// ── Paper trading tools ──

		/**
		 * Daily P&L summary report.
		 *
		 * Shows all positions closed today (or on a specific date) with total P&L,
		 * win/loss ratio, per-position breakdown, and virtual portfolio state.
		 * Results are clearly labelled PAPER or LIVE so there's no confusion.
		 */
		trade_paper_summary: async (args: Record<string, unknown>): Promise<string> => {
			// Default to today (UTC) if no date is provided
			const now = new Date();
			const todayUTC = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
			const date = (args.date as string) || todayUTC;

			// Validate date format
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return JSON.stringify({ error: "date must be in YYYY-MM-DD format" });
			}

			const paperMode = isPaperMode();
			const summary = store.getDailyPnLSummary(date, paperMode);

			// Build a human-readable header line
			const modeLabel = summary.mode === "PAPER" ? "[PAPER TRADING]" : "[LIVE TRADING]";
			const pnlSign = summary.totalPnl >= 0 ? "+" : "";
			const header = `${modeLabel} Daily Report — ${date} | P&L: ${pnlSign}$${summary.totalPnl.toFixed(2)} | Trades: ${summary.totalTrades} | Win rate: ${summary.winRate.toFixed(1)}%`;

			return JSON.stringify({ header, ...summary });
		},

		/**
		 * Reset the paper trading portfolio back to the starting virtual balance.
		 *
		 * This wipes all paper positions, trade history, and coin balances, then
		 * restores the USDT virtual balance to the virtual_balance_usd setting
		 * (default $1000). Requires confirm=true to prevent accidental resets.
		 */
		trade_paper_reset: async (args: Record<string, unknown>): Promise<string> => {
			if (!isPaperMode()) {
				return JSON.stringify({
					error:
						"trade_paper_reset is only available in paper trading mode. Switch to paper mode first with trade_set_limit.",
				});
			}

			if (args.confirm !== true) {
				const startingUsd = Number(store.getSetting("virtual_balance_usd") || "1000");
				return JSON.stringify({
					warning: `This will WIPE all paper trades, positions, and balances — resetting to $${startingUsd} virtual USDT. Set confirm=true to proceed.`,
					currentBalances: store.getAllPaperBalances(),
				});
			}

			// If a mirror trading.db is configured (validation daemon shares
			// schema but writes to its own file), reset both so stale peaks
			// in the mirror can't re-poison drawdown CBs after the live
			// reset clears. Live reset runs first inside resetPaperPortfolio
			// so a thrown exception here means the mirror step failed after
			// the live step already committed; surface it without retrying.
			const mirrorDbPath = process.env.ZARAA_TRADING_MIRROR_DB?.trim() || undefined;
			let mirrorReset = false;
			let mirrorError: string | null = null;
			try {
				store.resetPaperPortfolio({ mirrorDbPath });
				mirrorReset = Boolean(mirrorDbPath);
			} catch (err) {
				mirrorError = err instanceof Error ? err.message : String(err);
				console.warn("[trading] paper reset mirror step failed:", mirrorError);
			}
			const startingUsd = Number(store.getSetting("virtual_balance_usd") || "1000");

			return JSON.stringify({
				mode: "PAPER",
				message: `Paper portfolio reset. Virtual balance restored to $${startingUsd} USDT. All paper trades, positions, equity history, and circuit-breaker peaks cleared${mirrorReset ? " on live + mirror DBs" : ""}.`,
				newBalance: { USDT: startingUsd },
				mirrorDbConfigured: Boolean(mirrorDbPath),
				mirrorReset,
				...(mirrorError ? { mirrorError } : {}),
			});
		},

		// ── Strategy grading / lifecycle ──

		trade_strategy_grade_refresh: async (args: Record<string, unknown>): Promise<string> => {
			const maxTradesLookback = (args.max_trades_lookback as number) ?? undefined;
			const minTradesToGrade = (args.min_trades_to_grade as number) ?? undefined;
			// Same fix pattern as trade_strategy_rankings: read strategy_trades
			// from the journal DB (trade-journal.db) where TradeJournal actually
			// writes them. Without this the grader sees 0 rows and emits no
			// lifecycle updates. Include shadow trades when paperMode is on so
			// the paper book counts (ShadowModeExecutor tags them isShadow=1).
			const out = refreshStrategyGrades(store, {
				...(maxTradesLookback != null ? { maxTradesLookback } : {}),
				...(minTradesToGrade != null ? { minTradesToGrade } : {}),
				...(leaderboardStore ? { readDb: leaderboardStore.getDb() } : {}),
				includeShadow: zaraaTradingPaperMode === true,
			});
			return JSON.stringify({
				ok: true,
				...out,
				note: "Recomputed rollups from closed strategy_trades; sizing uses strategy_lifecycle rows (symbol '*').",
			});
		},

		trade_strategy_lifecycle: async (): Promise<string> => {
			const rows = listStrategyLifecycles(store);
			return JSON.stringify({
				count: rows.length,
				lifecycle: rows,
			});
		},

		// ── Leaderboard ──

		/**
		 * trade_leaderboard — ranked strategy performance table.
		 *
		 * Returns each known strategy with: total P&L, win rate, avg return,
		 * max drawdown, Sharpe ratio, trade count, and a 30-day sparkline.
		 *
		 * Parameters:
		 *   period: "7d" | "30d" | "90d" | "all"  (default: "30d")
		 *
		 * If no leaderboard store is configured, returns an error.
		 * If no strategy trades exist yet, returns an empty ranked array.
		 */
		trade_leaderboard: async (args: Record<string, unknown>): Promise<string> => {
			if (!leaderboardStore) {
				return JSON.stringify({
					error: "Leaderboard not available — leaderboardStore not configured.",
				});
			}

			// Validate period, defaulting to 30d.
			const rawPeriod = (args.period as string) || "30d";
			const validPeriods = ["7d", "30d", "90d", "all"];
			const period: LeaderboardPeriod = validPeriods.includes(rawPeriod)
				? (rawPeriod as LeaderboardPeriod)
				: "30d";

			const leaderboard = leaderboardStore.getLeaderboard(period);

			return JSON.stringify({
				period,
				count: leaderboard.length,
				leaderboard,
				// Human-friendly note for the AI response (no-op for API consumers).
				note:
					leaderboard.length === 0
						? "No closed strategy trades found for this period. Strategies need closed trades to appear here."
						: undefined,
			});
		},

		/**
		 * Quiet-hours-first portfolio risk audit: resolves local quiet window, optionally
		 * skips benchmark tickers off-hours, enriches open positions, scans gates/stops/concentration,
		 * and (by default) appends an opus grind log row with structured summary.
		 */
		trade_quiet_hours_risk_audit: async (args: Record<string, unknown>): Promise<string> => {
			const t0 = opusGrindNow?.() ?? new Date();
			const { quietHoursActive, cycleMode, window } = resolveOpusGrindCycle(
				opusGrindQuietHours,
				t0,
			);
			const persistLog = args.persist_log !== false;
			const forceFull = args.force_full_cycle === true;
			const skipBenchmarks = quietHoursActive && !forceFull;

			const stepsCompletedLabels: string[] = ["quiet_hours_resolve"];
			const stepsSkippedLabels: string[] = [];
			if (!skipBenchmarks) {
				stepsCompletedLabels.push("benchmark_prices");
			} else {
				stepsSkippedLabels.push("benchmark_prices");
			}
			stepsCompletedLabels.push("portfolio_enrich", "breach_scan");

			let benchmarkPrices: Array<{ symbol: string; price: number | null; error?: string }> | null =
				null;
			if (!skipBenchmarks) {
				const rawSyms =
					Array.isArray(args.symbols) &&
					(args.symbols as unknown[]).every((x) => typeof x === "string")
						? (args.symbols as string[])
						: [...DEFAULT_QUIET_HOURS_BENCHMARK_SYMBOLS];
				const capped = rawSyms.slice(0, 20).map((s) => normalizeSymbol(s));
				const BATCH_SIZE = 5;
				const results: Array<{ symbol: string; price: number | null; error?: string }> = [];
				for (let i = 0; i < capped.length; i += BATCH_SIZE) {
					const batch = capped.slice(i, i + BATCH_SIZE);
					const batchResults = await Promise.all(
						batch.map(async (s) => {
							try {
								const ticker = await client.getTicker(s);
								return { symbol: ticker.symbol, price: ticker.last };
							} catch (err) {
								console.debug(
									"[trading] risk audit ticker failed for",
									s,
									err instanceof Error ? err.message : err,
								);
								return { symbol: s, price: null, error: "fetch_failed" };
							}
						}),
					);
					results.push(...batchResults);
				}
				benchmarkPrices = results;
			}

			const paperMode = isPaperMode();
			const positions = store.getOpenPositions();
			const enriched = await Promise.all(
				positions.map(async (p) => {
					try {
						const ticker = await client.getTicker(p.symbol);
						const currentPrice = ticker.last;
						const pnl =
							p.side === "long"
								? (currentPrice - p.entryPrice) * p.qty
								: (p.entryPrice - currentPrice) * p.qty;
						return { ...p, currentPrice, pnl };
					} catch (err) {
						console.debug(
							"[trading] risk audit enrich failed for",
							p.symbol,
							err instanceof Error ? err.message : err,
						);
						return { ...p, currentPrice: p.currentPrice, pnl: p.pnl };
					}
				}),
			);

			const unrealizedPnl = enriched.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
			const peakEquity = store.getPeakEquity();
			let currentEquity = store.getLatestEquity();
			if (currentEquity <= 0 && peakEquity > 0) {
				currentEquity = peakEquity;
			}
			// No equity_snapshots yet (or all zero): avoid logging $0 as portfolio equity — use
			// configured paper start / live initial equity (same basis as sizing elsewhere).
			if (currentEquity <= 0) {
				currentEquity = store.getInitialEquity(paperMode);
			}

			const perPositionRows = enriched.map((p) => {
				const px = p.currentPrice ?? p.entryPrice;
				const notionalUsd = Math.abs(px * p.qty);
				return {
					positionId: p.id,
					symbol: p.symbol,
					side: p.side,
					notionalUsd,
				};
			});
			const totalExposureNotional = perPositionRows.reduce((s, r) => s + r.notionalUsd, 0);

			const exposureByAsset = computeExposureByAsset(
				perPositionRows.map((r) => ({ symbol: r.symbol, notionalUsd: r.notionalUsd })),
			);

			const positionsWithStops = store.getPositionsWithStops();
			const markByPositionId = new Map<string, number>();
			for (const p of enriched) {
				if (p.currentPrice != null && Number.isFinite(p.currentPrice)) {
					markByPositionId.set(p.id, p.currentPrice);
				}
			}
			const stopsByPositionId = new Map<
				string,
				{ symbol: string; side: "long" | "short"; stopLoss: number }
			>();
			for (const p of positionsWithStops) {
				if (p.stopLoss != null && Number.isFinite(p.stopLoss)) {
					stopsByPositionId.set(p.id, {
						symbol: p.symbol,
						side: p.side,
						stopLoss: p.stopLoss,
					});
				}
			}

			const positionsMissingStopLoss = store.getOpenPositionsMissingStopLoss();
			const killSnap = buildKillGateSnapshot({
				store,
				circuitBreaker,
				isPaperMode: paperMode,
			});

			const violations = collectRiskViolations({
				killSnap,
				positionsMissingStopLoss,
				riskManager,
				currentEquity,
				peakEquity,
				totalExposureNotional,
				perPositionRows,
				markByPositionId,
				stopsByPositionId,
			});

			const drawdownPct =
				riskManager && peakEquity > 0
					? riskManager.getDrawdownPct(currentEquity, peakEquity)
					: peakEquity > 0 && currentEquity > 0
						? round(((peakEquity - currentEquity) / peakEquity) * 100, 2)
						: 0;

			const escalationRecommended = escalationRecommendedForViolations(violations);
			const tradingHalted = riskManager
				? riskManager.isDrawdownExceeded(currentEquity, peakEquity)
				: false;

			const auditBody: Record<string, unknown> = {
				ok: true,
				localTimeIso: t0.toISOString(),
				quietHoursActive,
				cycleMode,
				quietHoursWindow: window,
				stepsCompletedLabels,
				stepsSkippedLabels,
				benchmarkPrices,
				mode: paperMode ? "PAPER" : "LIVE",
				equity: round(currentEquity, 2),
				unrealizedPnl: round(unrealizedPnl, 4),
				drawdownVsPeakPct: drawdownPct,
				exposureByAsset,
				violations,
				violationCount: violations.length,
				escalationRecommended,
				tradingHaltedByDrawdown: tradingHalted,
				killGate: {
					newEntriesAllowed: killSnap.newEntriesAllowed,
					blockReason: killSnap.blockReason ?? null,
					tradingKillSwitch: killSnap.tradingKillSwitch,
					circuitBreakerHalted: killSnap.circuitBreakerHalted,
					dailyCapBreached: killSnap.dailyCapBreached,
				},
			};

			if (persistLog) {
				const summaryNested = {
					quietHoursRiskAudit: {
						exposureByAsset,
						violations,
						escalationRecommended,
						stepsCompletedLabels,
						stepsSkippedLabels,
						benchmarkPricesSkipped: skipBenchmarks,
					},
					benchmarkPrices: benchmarkPrices ?? undefined,
					notes: skipBenchmarks
						? "Lightweight path: benchmark prices skipped during quiet hours."
						: "Full risk-audit path including benchmark prices.",
				};
				const parsedNested = opusGrindSummaryNestedSchema.safeParse(summaryNested);
				if (!parsedNested.success) {
					auditBody.opusGrindLogError = "Invalid nested summary shape";
				} else {
					const canonicalSummary: OpusGrindCanonicalSummaryV1 = {
						schemaVersion: 1,
						cycleMode,
						quietHoursActive,
						quietHoursWindow: window,
						...parsedNested.data,
					};
					const id = crypto.randomUUID();
					const loggedAt = (opusGrindNow?.() ?? new Date()).toISOString();
					store.logOpusGrind({
						id,
						startedAt: loggedAt,
						completedAt: loggedAt,
						status: "completed",
						marketRegime: skipBenchmarks ? "quiet_hours" : "risk_audit",
						portfolioEquity: currentEquity,
						portfolioPnl: unrealizedPnl,
						drawdownPct,
						riskViolations: violations.length,
						tradeExecuted: 0,
						alertsSet: 0,
						stepsCompleted: stepsCompletedLabels.length,
						stepsSkipped: stepsSkippedLabels.length,
						actionsTaken: 1,
						summaryJson: JSON.stringify(canonicalSummary),
					});
					auditBody.opusGrindLogId = id;
					auditBody.opusGrindLoggedAt = loggedAt;
				}
			}

			return JSON.stringify(auditBody);
		},

		// ── DCA (Dollar-Cost Averaging) ──

		dca_configure: async (args: Record<string, unknown>): Promise<string> => {
			const {
				DCAConfigureInputSchema,
				loadConfigs,
				saveConfigs,
				emptyState,
				saveState,
				loadState,
			} = await import("./engine/dca-strategy.js");
			try {
				const input = DCAConfigureInputSchema.parse(args);
				const maxTrade = parsePositiveSetting(store.getSetting("max_trade_usd"), 50);
				for (const pair of input.pairs) {
					const effectiveMax = pair.dipBonusPct
						? pair.amountUsd * (pair.dipBonusMultiplier ?? 2)
						: pair.amountUsd;
					if (effectiveMax > maxTrade) {
						return JSON.stringify({
							error: `DCA amount for ${pair.symbol} ($${effectiveMax} with dip bonus) exceeds max_trade_usd ($${maxTrade}). Lower amountUsd or raise max_trade_usd.`,
						});
					}
				}
				const existing = loadConfigs(store);
				const merged = [...existing];
				for (const pair of input.pairs) {
					const norm = normalizeSymbol(pair.symbol);
					const idx = merged.findIndex((c) => normalizeSymbol(c.symbol) === norm);
					const entry = { ...pair, symbol: norm };
					if (idx >= 0) merged[idx] = entry;
					else merged.push(entry);
					const st = loadState(store, norm);
					if (!st.lastBuyAt) saveState(store, emptyState(norm));
				}
				saveConfigs(store, merged);
				return JSON.stringify({
					ok: true,
					configured: merged.length,
					pairs: merged.map((c) => ({
						symbol: c.symbol,
						amountUsd: c.amountUsd,
						interval: c.interval,
						dipBonusPct: c.dipBonusPct ?? null,
						enabled: c.enabled,
					})),
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		dca_status: async (): Promise<string> => {
			const { loadConfigs, loadState } = await import("./engine/dca-strategy.js");
			const configs = loadConfigs(store);
			if (configs.length === 0)
				return JSON.stringify({ message: "No DCA pairs configured. Use dca_configure to set up." });
			const positions = await Promise.all(
				configs.map(async (cfg) => {
					const state = loadState(store, cfg.symbol);
					let currentPrice: number | null = null;
					let unrealizedPnl: number | null = null;
					let unrealizedPnlPct: number | null = null;
					try {
						const ticker = await client.getTicker(cfg.symbol);
						currentPrice = ticker.last;
						if (state.totalQtyBought > 0 && currentPrice != null) {
							const marketValue = state.totalQtyBought * currentPrice;
							unrealizedPnl = round(marketValue - state.totalInvestedUsd, 2);
							unrealizedPnlPct = round((unrealizedPnl / state.totalInvestedUsd) * 100, 2);
						}
					} catch {
						/* price fetch may fail */
					}
					return {
						symbol: cfg.symbol,
						enabled: cfg.enabled,
						interval: cfg.interval,
						amountUsd: cfg.amountUsd,
						dipBonusPct: cfg.dipBonusPct ?? null,
						totalInvestedUsd: round(state.totalInvestedUsd, 2),
						totalQtyBought: state.totalQtyBought,
						avgCostBasis: round(state.avgCostBasis, 4),
						buyCount: state.buyCount,
						lastBuyAt: state.lastBuyAt,
						currentPrice,
						unrealizedPnl,
						unrealizedPnlPct,
					};
				}),
			);
			return JSON.stringify({ count: positions.length, positions });
		},

		dca_pause: async (args: Record<string, unknown>): Promise<string> => {
			const { loadConfigs, saveConfigs } = await import("./engine/dca-strategy.js");
			const symbol = args.symbol ? normalizeSymbol(args.symbol as string) : null;
			const configs = loadConfigs(store);
			let changed = 0;
			for (const cfg of configs) {
				if (!symbol || normalizeSymbol(cfg.symbol) === symbol) {
					if (cfg.enabled) {
						cfg.enabled = false;
						changed++;
					}
				}
			}
			saveConfigs(store, configs);
			return JSON.stringify({
				ok: true,
				paused: changed,
				message: symbol ? `DCA for ${symbol} paused.` : `All ${changed} DCA pair(s) paused.`,
			});
		},

		dca_resume: async (args: Record<string, unknown>): Promise<string> => {
			const { loadConfigs, saveConfigs } = await import("./engine/dca-strategy.js");
			const symbol = args.symbol ? normalizeSymbol(args.symbol as string) : null;
			const configs = loadConfigs(store);
			let changed = 0;
			for (const cfg of configs) {
				if (!symbol || normalizeSymbol(cfg.symbol) === symbol) {
					if (!cfg.enabled) {
						cfg.enabled = true;
						changed++;
					}
				}
			}
			saveConfigs(store, configs);
			return JSON.stringify({
				ok: true,
				resumed: changed,
				message: symbol ? `DCA for ${symbol} resumed.` : `All ${changed} DCA pair(s) resumed.`,
			});
		},

		dca_run_cycle: async (): Promise<string> => {
			const {
				loadConfigs,
				loadState,
				saveState,
				updateState,
				isDue,
				calculateBuyAmount,
				computeSmaPrice,
			} = await import("./engine/dca-strategy.js");
			const configs = loadConfigs(store);
			const paperMode = isPaperMode();
			const maxTrade = parsePositiveSetting(store.getSetting("max_trade_usd"), 50);
			const dailyLimit = parsePositiveSetting(store.getSetting("daily_limit_usd"), 200);
			const results: Array<Record<string, unknown>> = [];
			for (const cfg of configs) {
				const state = loadState(store, cfg.symbol);
				if (!isDue(cfg, state)) {
					results.push({ symbol: cfg.symbol, action: "skipped", reason: "not_due" });
					continue;
				}
				try {
					const ticker = await client.getTicker(cfg.symbol);
					const currentPrice = ticker.last;
					if (!currentPrice || currentPrice <= 0) {
						results.push({ symbol: cfg.symbol, action: "skipped", reason: "no_price" });
						continue;
					}
					let smaPrice: number | undefined;
					if (cfg.dipBonusPct && candleStore) {
						try {
							const candles = candleStore.get(cfg.symbol, "1h", 30);
							if (candles.length >= 20)
								smaPrice = computeSmaPrice(
									candles.map((c: { close: number }) => c.close),
									20,
								);
						} catch {
							/* candle data may not be available */
						}
					}
					const { amountUsd, isDipBuy } = calculateBuyAmount(cfg, currentPrice, smaPrice, maxTrade);
					if (amountUsd > maxTrade) {
						results.push({
							symbol: cfg.symbol,
							action: "blocked",
							reason: `amount $${amountUsd.toFixed(2)} exceeds max_trade_usd ($${maxTrade})`,
						});
						continue;
					}
					const dailySpend = store.getDailySpend(paperMode);
					if (dailySpend + amountUsd > dailyLimit) {
						results.push({
							symbol: cfg.symbol,
							action: "blocked",
							reason: `daily limit would be exceeded ($${(dailySpend + amountUsd).toFixed(2)} > $${dailyLimit})`,
						});
						continue;
					}
					const qty = amountUsd / currentPrice;
					const buyResult = await handlers.trade_buy({ symbol: cfg.symbol, qty, type: "MARKET" });
					const parsed = JSON.parse(buyResult);
					if (parsed.error) {
						results.push({ symbol: cfg.symbol, action: "failed", error: parsed.error });
						continue;
					}
					const fillPrice = parsed.result?.price ?? parsed.paper?.price ?? currentPrice;
					const fillQty = parsed.result?.qty ?? parsed.paper?.qty ?? qty;
					const spent = fillPrice * fillQty;
					const newState = updateState(state, fillQty, spent);
					saveState(store, newState);
					emitTradingEvent("trade.dca_buy", {
						symbol: cfg.symbol,
						qty: fillQty,
						price: fillPrice,
						avgCostBasis: round(newState.avgCostBasis, 4),
						isPaper: paperMode,
					});
					results.push({
						symbol: cfg.symbol,
						action: "bought",
						qty: fillQty,
						price: fillPrice,
						spentUsd: round(spent, 2),
						isDipBuy,
						avgCostBasis: round(newState.avgCostBasis, 4),
						totalInvestedUsd: round(newState.totalInvestedUsd, 2),
						buyCount: newState.buyCount,
					});
				} catch (err) {
					results.push({
						symbol: cfg.symbol,
						action: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return JSON.stringify({
				cycle: "complete",
				mode: paperMode ? "PAPER" : "LIVE",
				processed: results.length,
				results,
			});
		},

		trade_opus_grind_cycle_state: async (_args: Record<string, unknown>): Promise<string> => {
			const now = opusGrindNow?.() ?? new Date();
			const { quietHoursActive, cycleMode, window } = resolveOpusGrindCycle(
				opusGrindQuietHours,
				now,
			);
			return JSON.stringify({
				ok: true,
				localTimeIso: now.toISOString(),
				quietHoursActive,
				cycleMode,
				quietHoursWindow: window,
				configQuietHours: opusGrindQuietHours ?? null,
				hint: quietHoursActive
					? "Lightweight cycle only: cap depth, skip heavy steps and trades."
					: "Full cycle permitted: run market/portfolio/strategy/execute steps as needed.",
			});
		},

		trade_log_opus_grind: async (args: Record<string, unknown>): Promise<string> => {
			const nowDate = opusGrindNow?.() ?? new Date();
			const { quietHoursActive, cycleMode, window } = resolveOpusGrindCycle(
				opusGrindQuietHours,
				nowDate,
			);

			const rawSummary =
				args.summary !== undefined && args.summary !== null && typeof args.summary === "object"
					? (args.summary as Record<string, unknown>)
					: {};
			const parsedNested = opusGrindSummaryNestedSchema.safeParse(rawSummary);
			if (!parsedNested.success) {
				return JSON.stringify({
					ok: false,
					error: "Invalid summary shape",
					details: parsedNested.error.flatten(),
				});
			}

			const canonicalSummary: OpusGrindCanonicalSummaryV1 = {
				schemaVersion: 1,
				cycleMode,
				quietHoursActive,
				quietHoursWindow: window,
				...parsedNested.data,
			};

			const repeat = parsedNested.data.repeatFailurePattern;
			if (repeat && repeat.occurrenceCount >= 2 && repeat.description.trim().length > 0) {
				try {
					void onOpusGrindRepeatFailure?.({
						patternKey: repeat.patternKey,
						description: repeat.description,
						occurrenceCount: repeat.occurrenceCount,
						recommendedFix: repeat.recommendedFix,
					});
				} catch {
					/* callback errors should not block logging */
				}
			}

			const id = crypto.randomUUID();
			const loggedAt = nowDate.toISOString();
			store.logOpusGrind({
				id,
				startedAt: (args.startedAt as string) ?? loggedAt,
				completedAt: loggedAt,
				durationMs: args.durationMs as number | undefined,
				status: "completed",
				marketRegime: args.marketRegime as string | undefined,
				bestOpportunity: args.bestOpportunity as string | undefined,
				portfolioEquity: args.portfolioEquity as number | undefined,
				portfolioPnl: args.portfolioPnl as number | undefined,
				drawdownPct: args.drawdownPct as number | undefined,
				riskViolations: args.riskViolations as number | undefined,
				tradeExecuted: args.tradeExecuted as number | undefined,
				alertsSet: args.alertsSet as number | undefined,
				memoriesStored: args.memoriesStored as number | undefined,
				parameterTweaks: args.parameterTweaks as number | undefined,
				stepsCompleted: args.stepsCompleted as number | undefined,
				stepsSkipped: args.stepsSkipped as number | undefined,
				actionsTaken: args.actionsTaken as number | undefined,
				summaryJson: JSON.stringify(canonicalSummary),
			});
			return JSON.stringify({ ok: true, id, logged: loggedAt, cycleMode, quietHoursActive });
		},

		trade_get_opus_grinds: async (args: Record<string, unknown>): Promise<string> => {
			const limit = (args.limit as number) ?? 24;
			const rows = store.getRecentOpusGrinds(limit);
			return JSON.stringify({
				count: rows.length,
				grinds: rows,
			});
		},

		// ── Portfolio Rebalancing ──────────────────────────────────────────────

		rebalance_configure: async (args: Record<string, unknown>): Promise<string> => {
			const { RebalanceConfigureInputSchema, saveRebalanceConfig } = await import(
				"./engine/portfolio-rebalancer.js"
			);
			try {
				const input = RebalanceConfigureInputSchema.parse(args);
				// Validate target allocations sum to ~1
				const totalWeight = Object.values(input.target_allocations).reduce((s, v) => s + v, 0);
				if (Math.abs(totalWeight - 1) > 0.01) {
					return JSON.stringify({
						error: `Target allocations must sum to ~1.0, got ${totalWeight.toFixed(4)}. Adjust weights.`,
					});
				}
				// Normalize symbols
				const normalizedAllocations: Record<string, number> = {};
				for (const [sym, weight] of Object.entries(input.target_allocations)) {
					normalizedAllocations[normalizeSymbol(sym)] = weight;
				}
				const config = {
					targetAllocations: normalizedAllocations,
					driftThresholdPct: input.drift_threshold_pct,
					maxTradePerRebalancePct: input.max_trade_per_rebalance_pct,
					enabled: input.enabled,
				};
				saveRebalanceConfig((k, v) => store.setSetting(k, v), config);
				return JSON.stringify({
					ok: true,
					config: {
						targetAllocations: config.targetAllocations,
						driftThresholdPct: config.driftThresholdPct,
						maxTradePerRebalancePct: config.maxTradePerRebalancePct,
						enabled: config.enabled,
					},
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		rebalance_status: async (): Promise<string> => {
			const { loadRebalanceConfig, computeRebalancePlan } = await import(
				"./engine/portfolio-rebalancer.js"
			);
			const config = loadRebalanceConfig((k) => store.getSetting(k));
			if (!config) {
				return JSON.stringify({
					message: "No rebalance config. Use rebalance_configure to set target allocations.",
				});
			}
			try {
				const { positions, cashUsd } = await buildPositionSnapshots(config);
				const plan = computeRebalancePlan(config, positions, cashUsd);
				return JSON.stringify({
					enabled: config.enabled,
					needsRebalance: plan.needsRebalance,
					totalDriftPct: plan.totalDriftPct,
					driftThresholdPct: config.driftThresholdPct,
					totalPortfolioValueUsd: plan.totalPortfolioValueUsd,
					currentAllocations: plan.currentAllocations,
					targetAllocations: plan.targetAllocations,
					pendingTrades: plan.trades.length,
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		rebalance_preview: async (): Promise<string> => {
			const { loadRebalanceConfig, computeRebalancePlan } = await import(
				"./engine/portfolio-rebalancer.js"
			);
			const config = loadRebalanceConfig((k) => store.getSetting(k));
			if (!config) {
				return JSON.stringify({ message: "No rebalance config. Use rebalance_configure first." });
			}
			try {
				const { positions, cashUsd } = await buildPositionSnapshots(config);
				const plan = computeRebalancePlan(config, positions, cashUsd);
				return JSON.stringify({
					needsRebalance: plan.needsRebalance,
					totalDriftPct: plan.totalDriftPct,
					totalPortfolioValueUsd: plan.totalPortfolioValueUsd,
					currentAllocations: plan.currentAllocations,
					targetAllocations: plan.targetAllocations,
					trades: plan.trades,
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		rebalance_execute: async (): Promise<string> => {
			const { loadRebalanceConfig, computeRebalancePlan, executeRebalancePlan } = await import(
				"./engine/portfolio-rebalancer.js"
			);
			const config = loadRebalanceConfig((k) => store.getSetting(k));
			if (!config) {
				return JSON.stringify({ error: "No rebalance config. Use rebalance_configure first." });
			}
			if (!config.enabled) {
				return JSON.stringify({
					error: "Rebalancing is disabled. Enable it via rebalance_configure.",
				});
			}
			try {
				const { positions, cashUsd, prices } = await buildPositionSnapshots(config);
				const plan = computeRebalancePlan(config, positions, cashUsd);
				if (!plan.needsRebalance) {
					return JSON.stringify({
						message: "Portfolio is within drift threshold — no rebalancing needed.",
						totalDriftPct: plan.totalDriftPct,
						driftThresholdPct: config.driftThresholdPct,
					});
				}
				const result = await executeRebalancePlan(plan, handlers, prices);
				emitTradingEvent("trade.rebalance_executed", {
					totalDriftPct: plan.totalDriftPct,
					tradesAttempted: result.summary.totalTradesAttempted,
					tradesSucceeded: result.summary.totalTradesSucceeded,
				});
				return JSON.stringify(result);
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		rebalance_run_cycle: async (): Promise<string> => {
			const { loadRebalanceConfig, computeRebalancePlan, executeRebalancePlan } = await import(
				"./engine/portfolio-rebalancer.js"
			);
			const config = loadRebalanceConfig((k) => store.getSetting(k));
			if (!config || !config.enabled) {
				return JSON.stringify({ skipped: true, reason: "rebalancing not configured or disabled" });
			}
			try {
				const { positions, cashUsd, prices } = await buildPositionSnapshots(config);
				const plan = computeRebalancePlan(config, positions, cashUsd);
				if (!plan.needsRebalance) {
					return JSON.stringify({
						skipped: true,
						reason: "drift_below_threshold",
						totalDriftPct: plan.totalDriftPct,
						driftThresholdPct: config.driftThresholdPct,
					});
				}
				const result = await executeRebalancePlan(plan, handlers, prices);
				emitTradingEvent("trade.rebalance_cycle", {
					totalDriftPct: plan.totalDriftPct,
					tradesAttempted: result.summary.totalTradesAttempted,
					tradesSucceeded: result.summary.totalTradesSucceeded,
				});
				return JSON.stringify(result);
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		/**
		 * Evaluate strategy rotation — ranks strategies by performance metric
		 * and returns the top-N active strategies with capital allocations.
		 */
		trade_strategy_rotation: async (_params?: Record<string, unknown>): Promise<string> => {
			if (!strategyRotator) {
				return JSON.stringify({ error: "Strategy rotator not initialized." });
			}
			try {
				const strategies = (_params?.strategies ?? []) as Array<{
					name: string;
					trades: number;
					pnl: number;
					winRate: number;
					sharpe: number;
					profitFactor: number;
				}>;
				const result = strategyRotator.evaluate(strategies);
				return JSON.stringify({
					active: result.active,
					deactivated: result.deactivated,
					reason: result.reason,
					timestamp: result.timestamp,
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		/**
		 * Get current strategy rotation status — active strategies and their allocations.
		 */
		trade_strategy_rotation_status: async (): Promise<string> => {
			if (!strategyRotator) {
				return JSON.stringify({ error: "Strategy rotator not initialized." });
			}
			try {
				const active = strategyRotator.getActiveStrategies();
				const lastRotation = strategyRotator.getLastRotation();
				return JSON.stringify({
					activeStrategies: active,
					allocations: active.map((s) => ({
						strategyName: s.strategyName,
						allocationPct: s.allocationPct,
						rank: s.rank,
					})),
					lastRotation: lastRotation?.timestamp ?? null,
					reason: lastRotation?.reason ?? null,
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		/**
		 * Route an order to the optimal exchange based on health, slippage,
		 * funding rate, and fee scoring.
		 */
		trade_route_exchange: async (params?: Record<string, unknown>): Promise<string> => {
			if (!executionRouter) {
				return JSON.stringify({ error: "Execution router not initialized." });
			}
			try {
				const symbol = String(params?.symbol ?? "");
				const side = String(params?.side ?? "BUY").toUpperCase() as "BUY" | "SELL";
				const qty = Number(params?.qty ?? 0);
				if (!symbol) return JSON.stringify({ error: "symbol is required" });
				if (side !== "BUY" && side !== "SELL")
					return JSON.stringify({ error: "side must be BUY or SELL" });
				if (qty <= 0) return JSON.stringify({ error: "qty must be positive" });
				const decision = executionRouter.route(symbol, side, qty);
				return JSON.stringify(decision);
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},

		/**
		 * Get API rate limit status across all tracked exchanges.
		 */
		trade_rate_limit_status: async (params?: Record<string, unknown>): Promise<string> => {
			if (!apiRateLimiter) {
				return JSON.stringify({ error: "API rate limiter not initialized." });
			}
			try {
				const exchange = params?.exchange ? String(params.exchange) : undefined;
				if (exchange) {
					return JSON.stringify(apiRateLimiter.getStatus(exchange));
				}
				return JSON.stringify({ error: "exchange parameter is required" });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	};

	/**
	 * Build position snapshots for rebalancing by fetching prices for all
	 * symbols in the target allocation and matching against open positions.
	 */
	async function buildPositionSnapshots(config: { targetAllocations: Record<string, number> }) {
		const openPositions = store.getOpenPositions();
		const allSymbols = new Set([
			...Object.keys(config.targetAllocations),
			...openPositions.map((p) => p.symbol),
		]);

		const prices: Record<string, number> = {};
		for (const symbol of allSymbols) {
			try {
				const ticker = await client.getTicker(symbol);
				if (ticker.last && ticker.last > 0) prices[symbol] = ticker.last;
			} catch {
				/* skip symbols we cannot price */
			}
		}

		const positions: Array<{
			symbol: string;
			valueUsd: number;
			qty: number;
			currentPrice: number;
		}> = [];
		for (const pos of openPositions) {
			const price = prices[pos.symbol];
			if (price && price > 0) {
				positions.push({
					symbol: pos.symbol,
					valueUsd: round(pos.qty * price, 2),
					qty: pos.qty,
					currentPrice: price,
				});
			}
		}

		// Cash = paper USDT balance in paper mode, 0 otherwise (exchange balances are already in positions)
		let cashUsd = 0;
		if (isPaperMode()) {
			cashUsd = store.getPaperBalance("USDT");
		}

		return { positions, cashUsd, prices };
	}

	forwardRef.trade_get_prices = handlers.trade_get_prices;
	forwardRef.trade_get_orderbook = handlers.trade_get_orderbook;
	forwardRef.trade_portfolio = handlers.trade_portfolio;
	forwardRef.trade_risk_status = handlers.trade_risk_status;
	forwardRef.trade_analytics = handlers.trade_analytics;

	// ── Safety dashboard handlers (trade_safety_* tools) ──────────────────

	(handlers as Record<string, unknown>).trade_safety_health = async (): Promise<string> => {
		if (!tradingHealth) {
			return JSON.stringify({ available: false, error: "TradingHealthAggregator not configured" });
		}
		return JSON.stringify({ available: true, ...tradingHealth.getHealth() });
	};

	(handlers as Record<string, unknown>).trade_flash_crash = async (
		args: Record<string, unknown>,
	): Promise<string> => {
		if (!flashCrashDetector) {
			return JSON.stringify({ available: false, error: "FlashCrashDetector not configured" });
		}
		const rawSymbol = typeof args.symbol === "string" ? args.symbol : "BTC_USDT";
		const symbol = rawSymbol.toUpperCase().replace(/[/-]/g, "_").includes("_")
			? rawSymbol.toUpperCase().replace(/[/-]/g, "_")
			: `${rawSymbol.toUpperCase()}_USDT`;
		const config = flashCrashDetector.getConfig();
		const result = flashCrashDetector.checkFlashCrash(symbol);
		return JSON.stringify({ available: true, symbol, config, ...result });
	};

	(handlers as Record<string, unknown>).trade_graduation = async (): Promise<string> => {
		if (!positionGraduation) {
			return JSON.stringify({ available: false, error: "PositionGraduation not configured" });
		}
		const allPositions = store.getAllPositions();
		const closed = allPositions.filter((p) => p.status === "closed" && p.pnl != null);
		const wins = closed.filter((p) => (p.pnl ?? 0) > 0);
		const stats = {
			totalTrades: closed.length,
			winRate: closed.length > 0 ? wins.length / closed.length : 0,
		};
		const status = positionGraduation.getGraduationStatus(stats);
		return JSON.stringify({ available: true, ...status, stats });
	};

	(handlers as Record<string, unknown>).trade_exchange_health = async (): Promise<string> => {
		if (tradingHealth) {
			const health = tradingHealth.getHealth();
			const exchanges = Object.entries(health.systems.exchangeHealth).map(([name, data]) => ({
				exchange: name,
				...data,
			}));
			return JSON.stringify({ available: true, exchanges });
		}
		return JSON.stringify({ available: false, exchanges: [] });
	};

	(handlers as Record<string, unknown>).trade_rate_limits = async (
		args: Record<string, unknown>,
	): Promise<string> => {
		if (!apiRateLimiter) {
			return JSON.stringify({ available: false, statuses: [] });
		}
		const requested = typeof args.exchange === "string" ? args.exchange : undefined;
		const exchanges = requested ? [requested] : ["crypto_com", "binance", "coinbase"];
		const statuses = exchanges.map((ex) => apiRateLimiter.getStatus(ex));
		return JSON.stringify({ available: true, statuses });
	};

	(handlers as Record<string, unknown>).trade_rotation_status = async (): Promise<string> => {
		if (!strategyRotator) {
			return JSON.stringify({ available: false, active: [], lastRotation: null });
		}
		return JSON.stringify({
			available: true,
			active: strategyRotator.getActiveStrategies(),
			lastRotation: strategyRotator.getLastRotation(),
		});
	};

	(handlers as Record<string, unknown>).trade_slippage_status = async (
		args: Record<string, unknown>,
	): Promise<string> => {
		if (!executionQualityController) {
			return JSON.stringify({ available: false });
		}
		const symbol = typeof args.symbol === "string" ? args.symbol : "BTC_USDT";
		const status = executionQualityController.getSlippageBreachStatus(symbol);
		return JSON.stringify({ available: true, symbol, ...status });
	};

	(handlers as Record<string, unknown>).trade_shadow_positions = async (): Promise<string> => {
		if (!shadowModeExecutor) {
			return JSON.stringify({ available: false, error: "ShadowModeExecutor not configured" });
		}
		const perf = shadowModeExecutor.getShadowPerformance();
		const openPositions = shadowModeExecutor.getOpenPositions();
		const closedPositions = shadowModeExecutor.getClosedPositions();

		const symbolAgg: Record<
			string,
			{ count: number; totalQty: number; totalNotional: number; unrealizedPnl: number }
		> = {};
		let longNotional = 0;
		let shortNotional = 0;
		for (const pos of openPositions) {
			const notional = pos.qty * pos.entryPrice;
			if (pos.side === "BUY") {
				longNotional += notional;
			} else {
				shortNotional += notional;
			}
			const last = shadowModeExecutor.getLastPrice(pos.symbol);
			const direction = pos.side === "BUY" ? 1 : -1;
			const unrealized = last != null ? direction * (last - pos.entryPrice) * pos.qty : 0;
			const bucket = symbolAgg[pos.symbol] ?? {
				count: 0,
				totalQty: 0,
				totalNotional: 0,
				unrealizedPnl: 0,
			};
			bucket.count += 1;
			bucket.totalQty += pos.qty;
			bucket.totalNotional += notional;
			bucket.unrealizedPnl += unrealized;
			symbolAgg[pos.symbol] = bucket;
		}
		const bySymbol: Record<
			string,
			{ count: number; totalNotional: number; avgEntry: number; unrealizedPnl: number }
		> = {};
		for (const [symbol, agg] of Object.entries(symbolAgg)) {
			bySymbol[symbol] = {
				count: agg.count,
				totalNotional: agg.totalNotional,
				avgEntry: agg.totalQty > 0 ? agg.totalNotional / agg.totalQty : 0,
				unrealizedPnl: agg.unrealizedPnl,
			};
		}

		const recentClosed = [...closedPositions]
			.sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
			.slice(0, 20)
			.map((p) => ({
				id: p.id,
				symbol: p.symbol,
				side: p.side,
				qty: p.qty,
				entryPrice: p.entryPrice,
				exitPrice: p.exitPrice,
				pnl: p.pnl,
				exitReason: p.exitReason,
				enteredAt: p.enteredAt,
				exitedAt: p.exitedAt,
				strategy: p.strategy,
			}));

		return JSON.stringify({
			available: true,
			count: openPositions.length,
			openPositions,
			totalPnl: perf.totalPnl,
			closedTrades: perf.trades,
			winRate: perf.winRate,
			bySymbol,
			portfolio: {
				totalUnrealizedPnl: perf.unrealizedPnl,
				totalRealizedPnl: perf.totalPnl,
				openPositionCount: perf.openPositionCount,
				closedTradeCount: perf.trades,
				winRate: perf.winRate,
			},
			exposure: {
				longNotional,
				shortNotional,
				netNotional: longNotional - shortNotional,
				grossNotional: longNotional + shortNotional,
			},
			recentClosed,
		});
	};

	(handlers as Record<string, unknown>).trade_shadow_status = async (): Promise<string> => {
		if (!shadowModeExecutor) {
			return JSON.stringify({ available: false, error: "ShadowModeExecutor not configured" });
		}
		const perf = shadowModeExecutor.getShadowPerformance();
		const openPositions = shadowModeExecutor.getOpenPositions();
		const closedPositions = shadowModeExecutor.getClosedPositions();
		const gateActivations = closedPositions.reduce<Record<string, number>>((acc, pos) => {
			const strategy = pos.strategy ?? "unknown";
			acc[strategy] = (acc[strategy] ?? 0) + 1;
			return acc;
		}, {});

		// Count loaded candles per symbol for each common timeframe
		const candlesLoaded: Record<string, Record<string, number>> = {};
		if (candleStore) {
			const trackedSymbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT"];
			const trackedTimeframes = ["1h", "4h", "15m"];
			for (const symbol of trackedSymbols) {
				candlesLoaded[symbol] = {};
				for (const tf of trackedTimeframes) {
					candlesLoaded[symbol][tf] = candleStore.count(symbol, tf);
				}
			}
		}

		return JSON.stringify({
			available: true,
			enabled: true,
			totalShadowTrades: perf.trades + openPositions.length,
			openPositionCount: openPositions.length,
			closedTrades: perf.trades,
			totalPnl: perf.totalPnl,
			winRate: perf.winRate,
			avgSlippageBps: perf.avgSlippage,
			gateActivations,
			attribution: shadowModeExecutor.getShadowAttribution(),
			candlesLoaded,
			pnlSnapshots: shadowModeExecutor.getPnlSnapshots(),
		});
	};

	// Expose the stop-exit bypass activation to authorized internal callers (stop monitor wiring).
	// Wraps a sell callback so the CB bypass counter is incremented for the duration of the call.
	// Re-entrant counter so concurrent stop-monitor exits compose safely.
	(handlers as Record<string, unknown>).withStopExitBypass = async (
		fn: () => Promise<void>,
	): Promise<void> => {
		_stopExitBypassDepth++;
		try {
			await fn();
		} finally {
			_stopExitBypassDepth = Math.max(0, _stopExitBypassDepth - 1);
		}
	};

	return handlers;
}

function round(n: number, decimals = 4): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

/**
 * ageMs / expectedIntervalMs ratio -> tier. Same thresholds/shape as
 * classifyFreshnessTier in packages/core/src/research/recency-gate.ts —
 * kept local since plugin-trading has no @zaraa/core dependency and this is
 * 6 lines (see ~/.zaraa/knowledge/data-freshness-policy.md for the shared
 * design this mirrors).
 */
function classifyBreakerFreshness(
	ageMs: number,
	expectedIntervalMs: number,
): "live" | "recent" | "stale" | "unverified" {
	const ratio = ageMs / expectedIntervalMs;
	if (ratio <= 1.5) return "live";
	if (ratio <= 5) return "recent";
	if (ratio <= 50) return "stale";
	return "unverified";
}

/**
 * Parse a human-readable period string into milliseconds.
 * Supports: "7d", "30d", "90d", "180d", "1y", "2y"
 * Returns undefined for unrecognized strings.
 */
function parsePeriodMs(period: string): number | undefined {
	const match = /^(\d+)(d|w|m|y)$/.exec(period.toLowerCase().trim());
	if (!match) return undefined;
	const value = parseInt(match[1], 10);
	const unit = match[2];
	const msPerDay = 24 * 60 * 60 * 1000;
	switch (unit) {
		case "d":
			return value * msPerDay;
		case "w":
			return value * 7 * msPerDay;
		case "m":
			return value * 30 * msPerDay; // approximate
		case "y":
			return value * 365 * msPerDay; // approximate
		default:
			return undefined;
	}
}

/** Normalize common crypto symbols to Crypto.com format (e.g., "BTC" → "BTC_USDT") */
function normalizeSymbol(input: string): string {
	if (!input) throw new Error("symbol is required");
	if (input.length > 20) throw new Error("symbol too long");
	const s = input.toUpperCase().replace(/[/-]/g, "_");
	// Validate: only allow alphanumeric and underscores
	if (!/^[A-Z0-9_]+$/.test(s)) throw new Error("symbol contains invalid characters");
	// If already has pair format, return as-is
	if (s.includes("_")) return s;
	// Default to USDT pair
	return `${s}_USDT`;
}
