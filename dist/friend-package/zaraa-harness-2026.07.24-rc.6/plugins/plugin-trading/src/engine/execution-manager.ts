import { createHash } from "node:crypto";
import type { CryptoClient, TradeResult } from "../crypto-client.js";
import { scrubErrorMessage } from "../util/scrub-secrets.js";

/** Minimal interface for error classification — avoids a hard dep on @zaraa/core */
interface ErrorClassifierLike {
	classify(err: unknown, ctx?: Record<string, unknown>): unknown;
}

import type { PortfolioAllocator } from "../analytics/portfolio-allocator.js";
import { type FeeSchedule, getDefaultFeeSchedules, resolveVenue } from "../cost/fee-schedule.js";
import { computeTradeCost } from "../cost/trade-cost-model.js";
import {
	type AutomatedRiskLockSnapshot,
	buildAutomatedRiskLockSnapshot,
	checkAndMaybeAutoRevertToPaper,
} from "../risk/automated-risk-lock.js";
import { emergencyFlattenAllPositions } from "../risk/emergency-flatten.js";
import { refreshLiveAccountEquity, requireFreshLiveEquity } from "../risk/live-equity.js";
import { validateLiveModeLock } from "../risk/live-mode-lock.js";
import { PreTradeValidator } from "../risk/pre-trade-validator.js";
import type { RiskManager } from "../risk/risk-manager.js";
import type { TradingCircuitBreaker } from "../risk/trading-circuit-breaker.js";
import { evaluateTradingKillGate } from "../risk/trading-kill-gate.js";
import { resolvePaperMode } from "../risk/trading-mode.js";
import type { TradingStore } from "../trading-store.js";
import type { TradingOrderAuditPayload } from "../util/trading-order-audit.js";
import { generateTradingOrderCorrelationId } from "../util/trading-order-audit.js";
import {
	computeAdverseImpactBps,
	computeAdverseSlippageBps,
	deriveBookSnapshot,
	type ExecutionQualityController,
} from "./execution-quality-controller.js";
import type { ShadowModeExecutor } from "./shadow-mode.js";
import type { TradeJournal } from "./trade-journal.js";

export interface ExecutionManagerDeps {
	client: CryptoClient;
	store: TradingStore;
	journal: TradeJournal;
	/**
	 * Optional: when provided, every trade is run through the unified
	 * PreTradeValidator (dollar limits + risk % limits) inside a mutex
	 * before execution.  Without this, only the stop-loss safety gate runs.
	 */
	riskManager?: RiskManager;
	/**
	 * Optional: when provided, getStatus() is checked before every trade.
	 * If any breaker is tripped, the trade is rejected immediately.
	 */
	circuitBreaker?: TradingCircuitBreaker;
	/** Optional audit hook (Zaraa PolicyEngine) — TRD-05 */
	onTradingOrderAudit?: (payload: TradingOrderAuditPayload) => void;
	/** Optional rolling execution feedback loop for slippage/latency-aware sizing. */
	executionQualityController?: ExecutionQualityController;
	/** Optional portfolio allocator for position size scaling based on optimal allocation. */
	portfolioAllocator?: PortfolioAllocator;
	/** Optional fee schedule overrides (defaults to getDefaultFeeSchedules()). */
	feeSchedule?: FeeSchedule[];
	/** Optional paper-mode slippage in basis points (defaults to 5 bps). */
	paperSlippageBps?: number;
	/** Optional error classifier for audit trail on exchange errors */
	errorClassifier?: ErrorClassifierLike;
	/** Optional shadow executor — when provided, shadow entries are tracked with SL/TP for exit simulation. */
	shadowModeExecutor?: ShadowModeExecutor;
	/**
	 * Today's daily-rotating live-mode confirmation lock from
	 * `zaraa.config.json:trading.liveModeLock`.  Required for any live trade —
	 * the signal-engine auto-execute path validates this against today's
	 * UTC date BEFORE any exchange interaction in `_execute()`, mirroring the
	 * handler-level check in handlers.ts.  Missing or stale = trade blocked.
	 */
	liveModeLock?: string;
}

// ── Exchange error classification ──────────────────────────────────────────

export type ExchangeErrorType =
	| "rate_limit"
	| "auth"
	| "network"
	| "insufficient_funds"
	| "unknown";

/**
 * Classify an exchange API error to determine retry strategy.
 *
 * - rate_limit: HTTP 429 or known rate-limit error codes -> retry with backoff
 * - auth:       HTTP 401/403 or auth-related errors     -> halt, do not retry
 * - network:    timeout, DNS, connection errors, HTTP 502/503/504 -> retry up to 3x
 * - insufficient_funds: not enough balance               -> halt
 * - unknown:    unrecognized errors                      -> do not retry
 */
export function classifyExchangeError(error: unknown): ExchangeErrorType {
	if (!(error instanceof Error)) return "unknown";

	const msg = error.message.toLowerCase();
	const code =
		"code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
			? (error as NodeJS.ErrnoException).code!.toLowerCase()
			: "";

	// Rate limiting
	if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
		return "rate_limit";
	}

	// Authentication / authorization
	if (
		msg.includes("401") ||
		msg.includes("403") ||
		msg.includes("unauthorized") ||
		msg.includes("forbidden") ||
		msg.includes("invalid api key") ||
		msg.includes("api key") ||
		msg.includes("signature") ||
		msg.includes("authentication")
	) {
		return "auth";
	}

	// Insufficient funds
	if (msg.includes("insufficient") || msg.includes("not enough") || msg.includes("balance")) {
		return "insufficient_funds";
	}

	// Node errno-style network failures (often absent from message text alone)
	if (
		code === "etimedout" ||
		code === "econnreset" ||
		code === "econnrefused" ||
		code === "enotfound" ||
		code === "econnaborted" ||
		code === "eai_again"
	) {
		return "network";
	}

	// Network / outage patterns (502/503/504 as whole status tokens, not substrings of order ids)
	if (
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("etimedout") ||
		msg.includes("econnaborted") ||
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("enotfound") ||
		msg.includes("dns") ||
		msg.includes("network") ||
		msg.includes("fetch failed") ||
		msg.includes("abort") ||
		msg.includes("hang up") ||
		msg.includes("socket hang up") ||
		/\b50[234]\b/.test(msg) ||
		msg.includes("bad gateway") ||
		msg.includes("service unavailable") ||
		msg.includes("gateway timeout")
	) {
		return "network";
	}

	return "unknown";
}

/**
 * Sleep for the given number of milliseconds.
 * Exported for testing purposes.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic based on exchange error classification.
 *
 * Retry strategy:
 * - rate_limit: exponential backoff (1s, 2s, 4s)
 * - network:    retry up to maxRetries with linear backoff (500ms)
 * - auth / insufficient_funds / unknown: throw immediately, no retry
 */
export async function withExchangeRetry<T>(
	fn: () => Promise<T>,
	opts: {
		maxRetries?: number;
		sleepFn?: (ms: number) => Promise<void>;
		errorClassifier?: ErrorClassifierLike;
		context?: Record<string, unknown>;
		/**
		 * Called after a network error before retrying. If it returns a
		 * non-undefined value the order already landed on the exchange — return
		 * that result immediately instead of retrying (idempotency guard).
		 * If it throws, the error is swallowed and the retry proceeds normally.
		 * Not called for rate_limit errors (those are rejected before matching).
		 */
		checkExistingOrder?: () => Promise<T | undefined>;
	} = {},
): Promise<T> {
	const maxRetries = opts.maxRetries ?? 3;
	const sleepFn = opts.sleepFn ?? sleep;
	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const errorType = classifyExchangeError(err);

			// Classify for audit trail
			opts.errorClassifier?.classify(err, {
				layer: "exchange-execution",
				exchangeErrorType: errorType,
				attempt,
				...opts.context,
			});

			// Non-retryable errors — throw immediately
			if (errorType === "auth" || errorType === "insufficient_funds" || errorType === "unknown") {
				throw err;
			}

			// Last attempt — throw
			if (attempt === maxRetries) {
				throw err;
			}

			// Idempotency check for network errors: the order may have landed
			// even though we received a network error. Only skip for rate_limit
			// (those are rejected before the matching engine sees the order).
			if (errorType === "network" && opts.checkExistingOrder) {
				try {
					const existing = await opts.checkExistingOrder();
					if (existing !== undefined) return existing;
				} catch {
					// swallow — fall through to normal retry
				}
			}

			// Retryable errors — backoff
			if (errorType === "rate_limit") {
				// Exponential backoff: 1s, 2s, 4s
				await sleepFn(1000 * 2 ** attempt);
			} else if (errorType === "network") {
				// Linear backoff: 500ms between retries
				await sleepFn(500);
			}
		}
	}

	throw lastError;
}

/**
 * Simple async mutex.
 *
 * Serializes concurrent trade executions so the read-check-execute cycle
 * is atomic from a validation perspective.  Two simultaneous signals that
 * both pass the exposure check before either position is recorded can no
 * longer slip through — the second signal must wait until the first has
 * written its position, then re-checks against the updated state.
 */
export class AsyncMutex {
	private queue: Promise<void> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.queue;
		let release!: () => void;
		this.queue = new Promise((r) => {
			release = r;
		});
		return prev.then(async () => {
			try {
				return await fn();
			} finally {
				release();
			}
		});
	}
}

export type OrderType = "MARKET" | "LIMIT";

/** Default spread offset for limit orders (0.1% = 0.001) */
export const DEFAULT_LIMIT_SPREAD_OFFSET = 0.001;

/** Default timeout for limit order fills before falling back to market (ms) */
export const DEFAULT_LIMIT_ORDER_TIMEOUT_MS = 30_000;

/** Interval between limit order fill checks (ms) */
export const LIMIT_ORDER_POLL_INTERVAL_MS = 2_000;

const ORDER_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
const TERMINAL_ORDER_STATUSES = new Set([
	"FILLED",
	"CANCELED",
	"CANCELLED",
	"EXPIRED",
	"REJECTED",
]);

async function reconcileMarketFill(
	client: CryptoClient,
	symbol: string,
	result: TradeResult,
	requestedQty: number,
): Promise<TradeResult> {
	if (!result.orderId || typeof client.getOrderDetail !== "function") {
		throw new Error(`Market order ${result.orderId || "unknown"} fill ambiguous — reconcile manually`);
	}

	let detail: Awaited<ReturnType<CryptoClient["getOrderDetail"]>>;
	try {
		detail = await client.getOrderDetail(symbol, result.orderId);
	} catch {
		throw new Error(`Market order ${result.orderId} fill ambiguous — reconcile manually`);
	}

	if (
		detail.orderId !== result.orderId ||
		!TERMINAL_ORDER_STATUSES.has(detail.status.trim().toUpperCase()) ||
		!Number.isFinite(detail.filledQty) ||
		detail.filledQty <= 0 ||
		detail.filledQty > requestedQty + 1e-8
	) {
		throw new Error(`Market order ${result.orderId} fill ambiguous — reconcile manually`);
	}

	return {
		...result,
		qty: detail.filledQty,
		price:
			Number.isFinite(detail.avgPrice) && detail.avgPrice > 0
				? detail.avgPrice
				: result.price,
		status: detail.status,
	};
}

function createOrderIdempotencyKey(
	params: { symbol: string; direction: "long" | "short"; qty: number },
	timeWindow: number,
): string {
	return createHash("sha256")
		.update(`${params.symbol}|${params.direction}|${params.qty}|${timeWindow}`)
		.digest("hex");
}

export interface ExecuteResult {
	success: boolean;
	mode: "PAPER" | "LIVE" | "SHADOW";
	orderId?: string;
	reason?: string;
	/** When the exchange returns a partial fill, this reflects actual filled qty */
	filledQty?: number;
	/** True if the exchange returned a partial fill (filledQty < requested qty) */
	partialFill?: boolean;
	/** The order type that was actually used (may differ from requested if fallback occurred) */
	orderType?: OrderType;
	/** True if a LIMIT order timed out and fell back to a MARKET order */
	limitFallback?: boolean;
	/** Same id written to audit.jsonl when onTradingOrderAudit is wired */
	orderAuditCorrelationId?: string;
	/** True when the trade was intercepted by shadow mode (no order placed) */
	shadow?: boolean;
}

/**
 * Bridges between signal engine and order execution.
 * Handles paper/live order submission and position tracking.
 *
 * Safety properties:
 * - All executions are serialized through an AsyncMutex so concurrent signals
 *   cannot both pass validation before either writes a position.
 * - When a riskManager is provided, the PreTradeValidator runs inside the
 *   mutex and enforces BOTH dollar limits (max_trade_usd, daily_limit_usd)
 *   AND percentage limits (maxPositionPct, maxExposurePct, drawdown) before
 *   any order is placed.  This closes the gap where the signal engine path
 *   previously bypassed the handler-level dollar checks entirely.
 * - Live trades use classified retry logic: rate limits get exponential backoff,
 *   network errors get 3 retries, auth errors halt immediately.
 * - Partial fills are detected and the position is opened with the actual
 *   filled quantity, not the requested quantity.
 */
export class ExecutionManager {
	private deps: ExecutionManagerDeps;
	/**
	 * Per-symbol mutexes — serializes concurrent executions for the same symbol
	 * while allowing different symbols to execute in parallel.
	 * A single global mutex was the main throughput bottleneck: a slow BTC LIMIT
	 * order poll cycle (up to 30s) would block all ETH/SOL entries queued behind it.
	 */
	private mutexes = new Map<string, AsyncMutex>();
	private pendingCleanups = new Map<string, ReturnType<typeof setTimeout>>();

	private getMutex(symbol: string): AsyncMutex {
		let mx = this.mutexes.get(symbol);
		if (!mx) {
			mx = new AsyncMutex();
			this.mutexes.set(symbol, mx);
		}
		return mx;
	}

	private schedulePartialFillCleanup(orderId: string, symbol: string, delayMs: number): void {
		const timer = setTimeout(async () => {
			this.pendingCleanups.delete(orderId);
			try {
				const openOrders = await this.deps.client.getOpenOrders(symbol);
				const stillOpen = openOrders.find((o) => o.orderId === orderId);
				if (stillOpen) {
					await this.deps.client.cancelOrder(symbol, orderId);
					console.debug(
						`[execution-manager] Partial fill cleanup: cancelled remainder of ${orderId}`,
					);
				}
			} catch (err) {
				console.warn(
					`[execution-manager] Partial fill cleanup failed for ${orderId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}, delayMs);
		this.pendingCleanups.set(orderId, timer);
	}

	clearPendingCleanups(): void {
		for (const timer of this.pendingCleanups.values()) clearTimeout(timer);
		this.pendingCleanups.clear();
	}

	private emitExecutionAudit(
		fields: Omit<TradingOrderAuditPayload, "correlationId" | "source">,
	): string | undefined {
		const cb = this.deps.onTradingOrderAudit;
		if (!cb) return undefined;
		const correlationId = generateTradingOrderCorrelationId();
		cb({
			correlationId,
			source: "execution_manager",
			...fields,
		});
		return correlationId;
	}
	/** Sleep function — injectable for testing */
	sleepFn: (ms: number) => Promise<void> = sleep;

	constructor(deps: ExecutionManagerDeps) {
		this.deps = deps;
	}

	private async enforceAutomatedRiskLock(
		isPaper: boolean,
		precomputed?: AutomatedRiskLockSnapshot,
		readOnly = false,
	): Promise<string | null> {
		const { store } = this.deps;
		const snapshot =
			precomputed ??
			buildAutomatedRiskLockSnapshot({
				store,
				isPaperMode: isPaper,
			});
		if (!snapshot.triggered) return null;
		if (readOnly) return snapshot.reason ?? "Automated risk lock blocked shadow entry.";

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

		const pendingOrdersSafe = await this.cancelAllPendingOrders(isPaper);
		const flatten = await emergencyFlattenAllPositions({
			client: this.deps.client,
			store,
			circuitBreaker: this.deps.circuitBreaker,
			isPaperMode: isPaper,
		});
		const liveExposureRemains = store
			.getOpenPositions()
			.some((position) => position.isPaper === false || position.isPaper === 0);
		if (
			!isPaper &&
			snapshot.reason?.startsWith("[auto-revert]") &&
			pendingOrdersSafe &&
			flatten.failures.length === 0 &&
			!liveExposureRemains
		) {
			checkAndMaybeAutoRevertToPaper(store);
		}
		return snapshot.reason ?? "Automated risk lock blocked new entries.";
	}

	private async cancelAllPendingOrders(isPaper: boolean): Promise<boolean> {
		const { client, store } = this.deps;
		const pending = store.listSubmittedOrdersByStatus("pending");
		if (isPaper) {
			store.cancelPendingSubmittedOrders();
			return true;
		}
		if (pending.length === 0) return true;
		const pendingById = new Map(
			pending.filter((row) => row.orderId).map((row) => [row.orderId as string, row]),
		);
		if (!client.hasCredentials || pendingById.size !== pending.length) return false;

		try {
			const openOrders = await client.getOpenOrders();
			const openById = new Map(
				openOrders.filter((order) => order.orderId).map((order) => [order.orderId, order]),
			);
			for (const [orderId, row] of pendingById) {
				const order = openById.get(orderId);
				if (!order) return false;
				await client.cancelOrder(order.symbol ?? row.symbol, orderId);
				store.updateSubmittedOrder(row.key, "cancelled", orderId);
			}
			return true;
		} catch (err) {
			console.warn(
				`[execution-manager] Failed to cancel pending orders during risk lock: ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	/**
	 * Verify exchange API connectivity before allowing live mode.
	 *
	 * Tests both public (ticker) and private (balances) endpoints.
	 * Returns a structured result indicating what works and what doesn't.
	 */
	async verifyExchangeConnectivity(): Promise<{
		connected: boolean;
		publicApi: boolean;
		privateApi: boolean;
		error?: string;
	}> {
		const { client } = this.deps;

		let publicApi = false;
		let privateApi = false;
		let error: string | undefined;

		// Test public API
		try {
			await client.getTicker("BTC_USDT");
			publicApi = true;
		} catch (err) {
			error = `Public API: ${err instanceof Error ? err.message : String(err)}`;
		}

		// Test private API (only if credentials exist)
		if (client.hasCredentials) {
			try {
				await client.getBalances();
				privateApi = true;
			} catch (err) {
				const errType = classifyExchangeError(err);
				const errMsg = err instanceof Error ? err.message : String(err);
				if (errType === "auth") {
					error = `Private API authentication failed: ${errMsg}`;
				} else if (errType === "network" || errType === "rate_limit") {
					error = `Private API unavailable (likely exchange outage or rate limits): ${errMsg}`;
				} else {
					error = `Private API: ${errMsg}`;
				}
			}
		} else {
			error = error ? `${error}; No API credentials configured` : "No API credentials configured";
		}

		return {
			connected: publicApi && privateApi,
			publicApi,
			privateApi,
			error,
		};
	}

	/**
	 * Execute a trade from a signal.
	 * Handles paper vs live mode, logs to trade store and journal.
	 *
	 * All executions are serialized through the internal mutex.
	 * When deps.riskManager is set, dollar and percentage limits are validated
	 * inside the mutex before the order is placed.
	 */
	async execute(params: {
		symbol: string;
		direction: "long" | "short";
		qty: number;
		stopLoss: number;
		takeProfit: number;
		strategyName: string;
		signalId: string;
		/**
		 * Account equity for percentage limit checks.
		 * If omitted, falls back to store.getPeakEquity() or daily_limit_usd×5.
		 */
		accountEquity?: number;
		/** Peak equity for drawdown check. Defaults to accountEquity if omitted. */
		peakEquity?: number;
		/** Trailing stop percentage — if set, enables trailing stop on the new position */
		trailingStopPct?: number;
		/**
		 * Order type: "LIMIT" (default) or "MARKET".
		 * LIMIT orders use entryPrice with a small spread offset and fall back
		 * to MARKET if they don't fill within limitOrderTimeoutMs.
		 */
		orderType?: OrderType;
		/**
		 * Desired entry price for LIMIT orders. Required when orderType is "LIMIT".
		 * If omitted for LIMIT orders, the current market price (ask for buys,
		 * bid for sells) is used as the base price for the limit.
		 */
		entryPrice?: number;
		/**
		 * Timeout in ms before a LIMIT order is cancelled and falls back to MARKET.
		 * Defaults to DEFAULT_LIMIT_ORDER_TIMEOUT_MS (30000).
		 */
		limitOrderTimeoutMs?: number;
	}): Promise<ExecuteResult> {
		const startMs = Date.now();
		const result = await this.getMutex(params.symbol).run(() => this._execute(params));
		const durationMs = Date.now() - startMs;

		// Schedule partial fill cleanup for live orders
		if (result.partialFill && result.orderId) {
			const isPaperMode = resolvePaperMode(this.deps.store);
			if (!isPaperMode) {
				this.schedulePartialFillCleanup(result.orderId, params.symbol, 60_000);
			}
		}

		// Record execution timing for monitoring
		this.executionTimings.push({
			symbol: params.symbol,
			durationMs,
			success: result.success,
			timestamp: startMs,
		});
		// Keep only last 200 entries
		if (this.executionTimings.length > 200) {
			this.executionTimings = this.executionTimings.slice(-200);
		}

		return result;
	}

	/** Execution timing metrics for monitoring */
	private executionTimings: Array<{
		symbol: string;
		durationMs: number;
		success: boolean;
		timestamp: number;
	}> = [];

	/** Return recent execution timing stats */
	getExecutionTimings(limit = 50): {
		avg: number;
		p95: number;
		count: number;
		timings: Array<{ symbol: string; durationMs: number; success: boolean; timestamp: number }>;
	} {
		const recent = this.executionTimings.slice(-limit);
		if (recent.length === 0) return { avg: 0, p95: 0, count: 0, timings: [] };
		const durations = recent.map((t) => t.durationMs).sort((a, b) => a - b);
		const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
		const p95 = durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1];
		return { avg: Math.round(avg), p95, count: recent.length, timings: recent };
	}

	private async _execute(params: {
		symbol: string;
		direction: "long" | "short";
		qty: number;
		stopLoss: number;
		takeProfit: number;
		strategyName: string;
		signalId: string;
		accountEquity?: number;
		peakEquity?: number;
		trailingStopPct?: number;
		orderType?: OrderType;
		entryPrice?: number;
		limitOrderTimeoutMs?: number;
		confidence?: number;
	}): Promise<ExecuteResult> {
		const execStartMs = Date.now();
		const { client, store, journal } = this.deps;
		const isPaper = resolvePaperMode(store);
		const isShadow = store.getSetting("shadow_mode") === "true";
		const riskIsPaper = isPaper || isShadow;
		const side = params.direction === "long" ? "BUY" : "SELL";
		const routeDecision = params.orderType
			? null
			: this.deps.executionQualityController?.getAdaptiveOrderType(params.symbol, "LIMIT");
		let resolvedOrderType: OrderType = params.orderType ?? routeDecision?.orderType ?? "LIMIT";

		if (!isPaper && !isShadow) {
			if (!this.deps.riskManager) {
				return {
					success: false,
					mode: "LIVE",
					reason: "riskManager is required for live trade execution",
				};
			}
			if (!this.deps.circuitBreaker) {
				return {
					success: false,
					mode: "LIVE",
					reason: "circuitBreaker is required for live trade execution",
				};
			}
		}
		if (!isPaper && !isShadow) {
			try {
				requireFreshLiveEquity(store);
			} catch {
				try {
					await refreshLiveAccountEquity({ client, store });
				} catch (err) {
				return {
					success: false,
					mode: isShadow ? "SHADOW" : "LIVE",
					reason: `Fresh authenticated live equity unavailable: ${err instanceof Error ? err.message : String(err)}`,
				};
				}
			}
		}

		// Validate numeric inputs
		if (!Number.isFinite(params.qty) || params.qty <= 0) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: "Invalid quantity",
			};
		}

		// Fetch ticker and order book in parallel — two sequential awaits here was
		// the dominant pre-mutex latency contributor (~200–600ms combined on live
		// exchange connections).  Both calls are read-only and safe to parallelize.
		const [tickerResult, bookResult] = await Promise.allSettled([
			client.getTicker(params.symbol),
			client.getOrderBook(params.symbol, 5),
		]);

		let executionPrice: number;
		if (tickerResult.status === "fulfilled") {
			const ticker = tickerResult.value;
			executionPrice = side === "BUY" ? ticker.ask : ticker.bid;
		} else {
			console.debug(
				"[execution] ticker fallback for",
				params.symbol,
				tickerResult.reason instanceof Error ? tickerResult.reason.message : tickerResult.reason,
			);
			// Live execution must NEVER place a real order at a synthetic price
			// fabricated from the stop-loss — fail closed when the real market price
			// is unavailable. Synthetic fallback is only for paper/shadow simulation.
			if (!isPaper && !isShadow) {
				return {
					success: false,
					mode: "LIVE",
					reason: `Live execution blocked: could not fetch a real market price for ${params.symbol}`,
				};
			}
			executionPrice =
				params.stopLoss > 0
					? params.direction === "long"
						? params.stopLoss / 0.96
						: params.stopLoss / 1.04
					: 0;
			if (executionPrice === 0) {
				return {
					success: false,
					mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
					reason: "Could not determine execution price",
				};
			}
		}

		// Defense in depth: if a caller (or future feed) sneaks past the zod
		// guard with a non-finite price, every downstream comparison (stop-side,
		// stop-distance, position size) silently evaluates to false because
		// NaN comparisons never satisfy ≥/≤ — meaning a corrupt feed would
		// quietly bypass safety gates. Bail before any of those run.
		if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: `Invalid execution price for ${params.symbol}: ${executionPrice}`,
			};
		}

		const bookSnapshot = deriveBookSnapshot(
			bookResult.status === "fulfilled" ? bookResult.value : null,
		);
		if (bookResult.status === "rejected") {
			console.debug(
				"[execution] order book snapshot unavailable for",
				params.symbol,
				bookResult.reason instanceof Error ? bookResult.reason.message : bookResult.reason,
			);
		}

		// Build the automated-risk-lock snapshot ONCE and thread it through both the
		// enforcement (which may HALT + flatten when triggered) and the kill gate.
		// Each build does multiple synchronous DB reads + equity resolution; the old
		// path rebuilt it 2-3× per entry attempt on the 24/7 hot loop.
		const riskLockSnapshot = buildAutomatedRiskLockSnapshot({
			store: this.deps.store,
			isPaperMode: riskIsPaper,
			skipAutoRevert: isShadow,
		});
		const automatedRiskReason = await this.enforceAutomatedRiskLock(
			riskIsPaper,
			riskLockSnapshot,
			isShadow,
		);
		if (automatedRiskReason) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: automatedRiskReason,
			};
		}

		// ── Kill switch, daily loss cap, venue halt, circuit breaker ─────────────
		// Reuse riskLockSnapshot: we only reach here when it did NOT trigger, so no
		// HALT/flatten side effects ran and trading state is unchanged — safe to share.
		const killGate = evaluateTradingKillGate({
			store: this.deps.store,
			circuitBreaker: this.deps.circuitBreaker,
			isPaperMode: riskIsPaper,
			precomputedRiskLock: riskLockSnapshot,
		});
		if (!killGate.allowed) {
			console.warn(
				`[execution-manager] Trade BLOCKED by kill gate: ${killGate.reason} (symbol=${params.symbol})`,
			);
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: killGate.reason ?? "Trading kill gate blocked new entry",
			};
		}

		// ── Slippage circuit breaker ─────────────────────────────────────────────
		if (this.deps.executionQualityController) {
			const slippageStatus = this.deps.executionQualityController.getSlippageBreachStatus(
				params.symbol,
			);
			if (slippageStatus.action === "halt") {
				console.warn(
					`[execution-manager] Trade BLOCKED by slippage breaker: ${params.symbol} avg=${slippageStatus.avgSlippageBps}bps`,
				);
				return {
					success: false,
					mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
					reason: `Slippage breaker halted ${params.symbol}: avg ${slippageStatus.avgSlippageBps}bps exceeds critical threshold`,
				};
			}
			if (slippageStatus.action === "limit_only" && resolvedOrderType === "MARKET") {
				console.debug(`[execution-manager] Slippage breaker forcing LIMIT for ${params.symbol}`);
				resolvedOrderType = "LIMIT";
			}
		}

		// ── Order idempotency guard ──────────────────────────────────────────────
		// Generate a key from trade parameters + 5-minute time window.
		// If the same signal fires twice within 5 minutes (e.g., due to a retry
		// or scheduler overlap), the second attempt is rejected as a duplicate.
		// The time window is quantized to 5-minute intervals so that identical
		// signals within the same window hash to the same key.
		const timeWindow = Math.floor(Date.now() / ORDER_IDEMPOTENCY_WINDOW_MS);
		const idempotencyKeys = [
			createOrderIdempotencyKey(params, timeWindow),
			createOrderIdempotencyKey(params, timeWindow - 1),
		];
		for (const key of idempotencyKeys) {
			const existingOrder = store.getSubmittedOrder(key);
			if (existingOrder) {
				console.warn(
					`[execution-manager] Duplicate order BLOCKED: ${params.symbol} ${params.direction} ` +
						`qty=${params.qty} (existing status: ${existingOrder.status})`,
				);
				return {
					success: false,
					mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
					reason: `Duplicate order (already ${existingOrder.status})`,
				};
			}
		}
		const idempotencyKey = idempotencyKeys[0];

		// ── Stop-loss safety gate ─────────────────────────────────────────────────
		// Every position MUST have a valid stop-loss before we write it to the store.
		// This is a second line of defense — callers (handlers, signal engine) should
		// already have validated and set a stop-loss, but this catches any that slipped
		// through (e.g., a future caller that forgets to set one).
		if (!params.stopLoss || params.stopLoss <= 0) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: "Missing stop-loss",
			};
		}
		// Stop-loss must be on the correct side of entry price.
		// For longs: stop must be below entry (you exit if price falls to stop).
		// For shorts: stop must be above entry (you exit if price rises to stop).
		const stopOnWrongSide =
			params.direction === "long"
				? params.stopLoss >= executionPrice
				: params.stopLoss <= executionPrice;
		if (stopOnWrongSide) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: "Stop-loss on wrong side of entry",
			};
		}
		// Stop-loss must not be more than 20% away from entry.
		// Catches typos like a missing digit (e.g., 6700 instead of 67000).
		if (executionPrice <= 0) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: "Invalid execution price",
			};
		}
		const stopDistancePct = (Math.abs(executionPrice - params.stopLoss) / executionPrice) * 100;
		if (stopDistancePct > 20) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: `Stop-loss too far: ${stopDistancePct.toFixed(1)}%`,
			};
		}
		if (!isPaper && !isShadow && params.direction === "short") {
			return {
				success: false,
				mode: "LIVE",
				reason:
					"Live short entries are disabled until venue borrow, margin, and liability NAV are enforced",
			};
		}
		// ─────────────────────────────────────────────────────────────────────────

		// ── Unified pre-trade validation (inside mutex) ───────────────────────────
		// Runs dollar limits (max_trade_usd, daily_limit_usd) AND RiskManager %
		// limits (maxPositionPct, maxExposurePct, drawdown, consecutive losses).
		//
		// Executing inside the mutex means open positions are read AFTER any
		// concurrent trade has already written its position — this is the fix for
		// the race condition where two simultaneous signals both passed the exposure
		// check before either committed.
		if (!this.deps.riskManager && !isPaper) {
			console.warn(
				`[execution-manager] LIVE trade BLOCKED — riskManager is required for live execution ` +
					`(symbol=${params.symbol} qty=${params.qty})`,
			);
			return {
				success: false,
				mode: "LIVE",
				reason: "riskManager is required for live trade execution",
			};
		}
		if (this.deps.riskManager) {
			const storedPeakEquity = riskIsPaper ? store.getPeakEquity() : store.getPeakLiveEquity();
			const storedLatestEquity = riskIsPaper
				? store.getLatestEquity()
				: requireFreshLiveEquity(store).equity;
			// Use latest equity (current capital) for sizing, NOT peak equity.
			// Fallback: daily_limit * 2 (conservative). Old * 5 multiplier could
			// oversize positions 10x on a fresh instance with no equity history.
			const fallbackEquity = Math.max(
				100,
				Number(store.getSetting("daily_limit_usd") || "100") * 2,
			);
			const accountEquity =
				(riskIsPaper ? params.accountEquity : undefined) ??
				(storedLatestEquity > 0
					? storedLatestEquity
					: storedPeakEquity > 0
						? storedPeakEquity
						: fallbackEquity);
			const peakEquity =
				(riskIsPaper ? params.peakEquity : undefined) ??
				(storedPeakEquity > 0 ? storedPeakEquity : accountEquity);

			const validator = new PreTradeValidator(store, this.deps.riskManager);
			// Read open positions INSIDE the mutex — this is intentional
			const openPositions = store.getOpenPositions();

			const validation = validator.validate({
				qty: params.qty,
				estimatedPrice: executionPrice,
				isPaper: riskIsPaper,
				accountEquity,
				peakEquity,
				openPositions,
				side: params.direction,
				symbol: params.symbol,
				consecutiveLosses: store.getConsecutiveLosses(),
			});

			if (!validation.allowed) {
				console.warn(
					`[execution-manager] Trade BLOCKED by pre-trade validator: ${validation.reason} ` +
						`(symbol=${params.symbol} qty=${params.qty} price=$${executionPrice.toFixed(2)})`,
				);
				return {
					success: false,
					mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
					reason: validation.reason,
				};
			}
		}
		// ─────────────────────────────────────────────────────────────────────────

		// ── Portfolio allocation scaling ──────────────────────────────────────────
		let adjustedQty = params.qty;
		if (this.deps.portfolioAllocator) {
			const openPositions = store.getOpenPositions();
			const totalValue = openPositions.reduce((sum, p) => sum + Math.abs(p.entryPrice * p.qty), 0);
			const currentWeights: Record<string, number> = {};
			if (totalValue > 0) {
				for (const p of openPositions) {
					const val = Math.abs(p.entryPrice * p.qty);
					currentWeights[p.symbol] = (currentWeights[p.symbol] ?? 0) + val / totalValue;
				}
			}
			const scalar = this.deps.portfolioAllocator.getPositionScalar(params.symbol, currentWeights);
			adjustedQty = Math.max(0.0001, params.qty * scalar);
			if (scalar !== 1.0) {
				console.debug(
					`[execution-manager] Portfolio scalar: ${scalar.toFixed(3)} for ${params.symbol} (qty ${params.qty} -> ${adjustedQty.toFixed(6)})`,
				);
			}
		}

		// ── Safety cap: clamp to max_trade_usd ───────────────────────────────
		const maxTradeRaw = store.getSetting("max_trade_usd");
		const maxTradeUsd = maxTradeRaw ? Number(maxTradeRaw) : 50;
		const adjustedNotional = adjustedQty * (executionPrice || 0);
		if (
			Number.isFinite(maxTradeUsd) &&
			maxTradeUsd > 0 &&
			adjustedNotional > maxTradeUsd &&
			executionPrice > 0
		) {
			adjustedQty = maxTradeUsd / executionPrice;
		}

		// ── Mark order as submitted (idempotency) ──────────────────────────────
		// Claim the idempotency key BEFORE executing. If this fails (key already
		// exists), it means a concurrent path beat us — bail out.
		const claimed = store.markOrderSubmitted(idempotencyKey, params.symbol);
		if (!claimed) {
			return {
				success: false,
				mode: isShadow ? "SHADOW" : isPaper ? "PAPER" : "LIVE",
				reason: "Duplicate order (concurrent submission detected)",
			};
		}

		// ── Shadow execution mode ────────────────────────────────────────────────
		// Shadow mode has its OWN distinct flag, checked INDEPENDENTLY of paper_mode.
		// If shadow_mode is enabled, execution NEVER reaches createOrder — regardless
		// of paper_mode's value.  Check order: shadow → paper → live.
		// (isShadow was already read at the top of execute() alongside isPaper)

		// Record in trade journal — flag shadow rows so learning-loop consumers
		// can filter them out by default. Without this, shadow signals would
		// silently mix with real/paper outcomes once exits start landing.
		journal.recordTrade({
			signalId: params.signalId,
			strategyName: params.strategyName,
			symbol: params.symbol,
			direction: params.direction,
			entryPrice: executionPrice,
			qty: adjustedQty,
			isShadow,
		});
		if (isShadow) {
			console.log(
				`[shadow] Simulating trade, no exchange interaction: ${params.symbol} ${params.direction} qty=${adjustedQty} ` +
					`price=${executionPrice.toFixed(6)} type=${resolvedOrderType}`,
			);
			store.updateSubmittedOrder(idempotencyKey, "cancelled");
			const orderAuditCorrelationId = this.emitExecutionAudit({
				symbol: params.symbol,
				side,
				mode: "SHADOW",
				positionId: undefined,
				qty: adjustedQty,
				resultSummary: `[shadow] ${params.strategyName} ${side} qty=${adjustedQty} @ ${executionPrice.toFixed(4)} — simulated, no exchange interaction`,
			});
			// Register the position in the shadow executor so SL/TP exits are tracked.
			if (this.deps.shadowModeExecutor) {
				const shadowResult = this.deps.shadowModeExecutor.executeShadow({
					symbol: params.symbol,
					side,
					qty: adjustedQty,
					price: executionPrice,
					strategy: params.strategyName,
					confidence: params.confidence,
				});
				if (shadowResult.preTradeChecksPassed && params.stopLoss && params.takeProfit) {
					this.deps.shadowModeExecutor.setStopAndTarget(
						shadowResult.id,
						params.stopLoss,
						params.takeProfit,
					);
				}
			}
			return {
				success: true,
				mode: "SHADOW",
				orderType: resolvedOrderType,
				shadow: true,
				reason: `Shadow mode: order validated but not submitted (${params.symbol} ${params.direction} qty=${adjustedQty} @ $${executionPrice.toFixed(2)})`,
				orderAuditCorrelationId,
			};
		}

		if (isPaper) {
			// Paper trade — simulate the order type for journaling accuracy
			const paperOrderType = resolvedOrderType;
			console.debug(
				`[execution-manager] Paper trade: ${params.symbol} ${side} qty=${adjustedQty} ` +
					`type=${paperOrderType} price=$${executionPrice.toFixed(2)}`,
			);

			const latencyMs = Date.now() - execStartMs;
			const slippageBps = computeAdverseSlippageBps({
				side,
				expectedPrice: executionPrice,
				fillPrice: executionPrice,
			});
			const impactBps = computeAdverseImpactBps({
				side,
				fillPrice: executionPrice,
				book: bookSnapshot,
			});
			const paperVenue = resolveVenue(params.symbol);
			const schedules = this.deps.feeSchedule ?? getDefaultFeeSchedules();
			// Default 10 bps one-way (was 5): paper fills were under-costed vs crypto.com
			// retail book, producing false-positive expectancy. Keep honest.
			const paperSlippage = this.deps.paperSlippageBps ?? 10;
			const costResult = computeTradeCost({
				price: executionPrice,
				qty: adjustedQty,
				side,
				orderType: paperOrderType,
				venue: paperVenue,
				feeSchedule: schedules,
				slippageBps: paperSlippage,
			});

			const routeJson = JSON.stringify({
				expectedPrice: executionPrice,
				fillPrice: costResult.adjustedPrice,
				latencyMs,
				slippageBps,
				impactBps,
				requestedOrderType: params.orderType ?? null,
				actualOrderType: paperOrderType,
				adaptiveRoutingReason: routeDecision?.reason ?? null,
				bestBid: bookSnapshot?.bestBid ?? null,
				bestAsk: bookSnapshot?.bestAsk ?? null,
				midPrice: bookSnapshot?.midPrice ?? null,
			});

			store.logTrade({
				symbol: params.symbol,
				side,
				type: paperOrderType,
				qty: adjustedQty,
				price: costResult.adjustedPrice,
				isPaper: true,
				slippageBps,
				routeJson,
			});

			const position = store.openPosition({
				symbol: params.symbol,
				side: params.direction,
				entryPrice: costResult.adjustedPrice,
				qty: adjustedQty,
				stopLoss: params.stopLoss,
				takeProfit: params.takeProfit,
				trailingStopPct: params.trailingStopPct,
				isPaper: true,
				feeRate: costResult.feeRate,
				slippageBps,
				routeJson,
			});
			this.deps.executionQualityController?.recordExecution({
				symbol: params.symbol,
				side,
				requestedOrderType: paperOrderType,
				actualOrderType: paperOrderType,
				expectedPrice: executionPrice,
				fillPrice: costResult.adjustedPrice,
				latencyMs,
				partialFill: false,
				limitFallback: false,
				book: bookSnapshot,
			});

			store.updateSubmittedOrder(idempotencyKey, "confirmed");
			const orderAuditCorrelationId = this.emitExecutionAudit({
				symbol: params.symbol,
				side,
				mode: "PAPER",
				positionId: position.id,
				qty: adjustedQty,
				resultSummary: `signal paper ${params.strategyName} ${side} qty=${adjustedQty}`,
			});
			return { success: true, mode: "PAPER", orderType: paperOrderType, orderAuditCorrelationId };
		}

		// ── Live trade ───────────────────────────────────────────────────────────
		// DEFENSIVE GUARD: shadow_mode must NEVER reach live execution.
		// This assertion is a safety net — the early return above should have
		// already handled shadow mode. If we somehow reach here with shadow on,
		// abort immediately rather than risk real funds.
		if (isShadow) {
			console.error(
				"[shadow] CRITICAL: shadow mode reached live execution path — aborting to prevent real trade",
			);
			store.updateSubmittedOrder(idempotencyKey, "failed");
			return {
				success: false,
				mode: "SHADOW",
				reason: "Shadow mode safety assertion failed — trade blocked to prevent live execution",
			};
		}

		// ── Live-mode lock (daily-rotating confirmation) ───────────────────────
		// The handler-level path already validates this, but the signal-engine
		// auto-execute path also reaches here directly.  Without this check,
		// an attacker (or an accidental `paper_mode=false` flip) could trigger
		// real trades the moment the strategy fires, bypassing the daily
		// human-in-the-loop confirmation that the operator intends to trade
		// today.  Validating here closes that gap.
		const lockResult = validateLiveModeLock(this.deps.liveModeLock, isPaper);
		if (!lockResult.ok) {
			console.error(
				`[execution-manager] LIVE TRADE BLOCKED — ${lockResult.reason} (symbol=${params.symbol})`,
			);
			store.updateSubmittedOrder(idempotencyKey, "failed");
			return {
				success: false,
				mode: "LIVE",
				reason: lockResult.reason ?? "liveModeLock validation failed",
			};
		}

		if (!client.hasCredentials) {
			store.updateSubmittedOrder(idempotencyKey, "failed");
			return { success: false, mode: "LIVE", reason: "No API credentials configured" };
		}

		try {
			const exchangeRetryOpts = {
				sleepFn: this.sleepFn,
				errorClassifier: this.deps.errorClassifier,
				context: { symbol: params.symbol },
			};

			// ── Determine order type and limit price ─────────────────────────────
			let actualOrderType: OrderType = resolvedOrderType;
			let limitFallback = false;
			let result: import("../crypto-client.js").TradeResult;
			/** Tracks qty filled by the limit order before timeout/cancel (used in combined fill accounting) */
			let preCancelLimitFill = 0;
			/** Average fill price for the limit leg when a remainder falls back to market */
			let preCancelLimitPrice: number | null = null;
			/** Submitted limit price — used as a conservative fallback when the exchange omits avgPrice */
			let submittedLimitPrice: number | null = null;

			if (resolvedOrderType === "LIMIT") {
				// Calculate limit price with spread offset.
				// For BUY: set limit slightly above the entry/market price to increase fill probability.
				// For SELL: set limit slightly below the entry/market price.
				const spreadOffset = Number(
					store.getSetting("limit_spread_offset") || String(DEFAULT_LIMIT_SPREAD_OFFSET),
				);
				const basePrice = params.entryPrice ?? executionPrice;
				const limitPrice =
					side === "BUY" ? basePrice * (1 + spreadOffset) : basePrice * (1 - spreadOffset);
				submittedLimitPrice = limitPrice;

				console.debug(
					`[execution-manager] LIMIT order: ${params.symbol} ${side} qty=${adjustedQty} ` +
						`limitPrice=$${limitPrice.toFixed(6)} (base=$${basePrice.toFixed(2)}, offset=${(spreadOffset * 100).toFixed(2)}%)`,
				);

				// Submit the limit order with retry logic
				const limitResult = await withExchangeRetry(
					() =>
						client.createOrder({
							symbol: params.symbol,
							side,
							type: "LIMIT",
							qty: adjustedQty,
							price: limitPrice,
						}),
					exchangeRetryOpts,
				);

				// Wait for the limit order to fill, polling at intervals
				const timeoutMs =
					params.limitOrderTimeoutMs ??
					Number(
						store.getSetting("limit_order_timeout_ms") || String(DEFAULT_LIMIT_ORDER_TIMEOUT_MS),
					);
				const pollIntervalMs = LIMIT_ORDER_POLL_INTERVAL_MS;
				const sleepFn = this.sleepFn;
				const deadline = Date.now() + timeoutMs;
				let filled = false;

				// Check if the order was immediately filled (status indicates fill)
				if (limitResult.status === "FILLED" || limitResult.status === "filled") {
					filled = true;
					result = limitResult;
				} else {
					// Poll for fill
					while (Date.now() < deadline) {
						await sleepFn(pollIntervalMs);
						try {
							const openOrders = await client.getOpenOrders(params.symbol);
							const stillOpen = openOrders.some((o) => o.orderId === limitResult.orderId);
							if (!stillOpen) {
								// Order left the open-order book — reconcile actual fill via order detail
								try {
									const detail = await client.getOrderDetail(params.symbol, limitResult.orderId);
									const detailStatus = detail.status.trim().toUpperCase();
									if (
										detail.orderId !== limitResult.orderId ||
										!TERMINAL_ORDER_STATUSES.has(detailStatus) ||
										!Number.isFinite(detail.filledQty) ||
										detail.filledQty < 0 ||
										detail.filledQty > adjustedQty + 1e-8 ||
										(detailStatus === "FILLED" && detail.filledQty + 1e-8 < adjustedQty)
									) {
										throw new Error("order detail is not terminal or internally consistent");
									}
									if (detail.filledQty > 0) {
										filled = true;
										result = {
											...limitResult,
											qty: detail.filledQty,
											price: detail.avgPrice || limitResult.price || limitPrice,
											status: detail.status,
										};
									} else {
										// Order was cancelled/expired externally with no fill — fall back to market
										console.warn(
											`[execution-manager] Limit order ${limitResult.orderId} disappeared with 0 fill ` +
												`(status=${detail.status}), falling back to MARKET`,
										);
										actualOrderType = "MARKET";
										limitFallback = true;
										result = await reconcileMarketFill(
											client,
											params.symbol,
											await withExchangeRetry(
												() =>
													client.createOrder({
														symbol: params.symbol,
														side,
														type: "MARKET",
														qty: adjustedQty,
													}),
												exchangeRetryOpts,
											),
											adjustedQty,
										);
										filled = true;
									}
								} catch (detailErr) {
									// getOrderDetail not available or failed — treat as ambiguous, abort
									console.warn(
										`[execution-manager] Cannot reconcile order ${limitResult.orderId}: ` +
											`${detailErr instanceof Error ? detailErr.message : String(detailErr)}. ` +
											`Aborting — manual reconciliation required.`,
									);
									store.updateSubmittedOrder(idempotencyKey, "failed");
									return {
										success: false,
										mode: "LIVE",
										reason: `Limit order ${limitResult.orderId} status ambiguous — reconcile manually`,
										orderType: actualOrderType,
										limitFallback: false,
									};
								}
								break;
							}
						} catch (pollErr) {
							// If polling fails, continue waiting — don't abort the order
							console.debug(
								`[execution-manager] Limit order poll error (continuing): ` +
									`${pollErr instanceof Error ? pollErr.message : String(pollErr)}`,
							);
						}
					}

					if (!filled) {
						// Timeout — cancel the limit order and fall back to market
						console.warn(
							`[execution-manager] LIMIT order timeout after ${timeoutMs}ms, ` +
								`cancelling orderId=${limitResult.orderId} and falling back to MARKET ` +
								`(symbol=${params.symbol})`,
						);

						let cancelSucceeded = false;
						try {
							await client.cancelOrder(params.symbol, limitResult.orderId);
							cancelSucceeded = true;
						} catch (cancelErr) {
							console.warn(
								`[execution-manager] Cancel limit order failed: ` +
									`${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
							);
						}

						if (!cancelSucceeded) {
							// Cancel failed — the order may have already filled. Reconcile before acting.
							try {
								const detail = await client.getOrderDetail(params.symbol, limitResult.orderId);
								const detailStatus = detail.status.trim().toUpperCase();
								if (
									detail.orderId !== limitResult.orderId ||
									!TERMINAL_ORDER_STATUSES.has(detailStatus) ||
									!Number.isFinite(detail.filledQty) ||
									detail.filledQty < 0 ||
									detail.filledQty > adjustedQty + 1e-8 ||
									(detailStatus === "FILLED" && detail.filledQty + 1e-8 < adjustedQty)
								) {
									throw new Error("order detail is not terminal or internally consistent");
								}
								if (detail.filledQty + 1e-8 >= adjustedQty) {
									// Order already filled — use that as our result
									console.warn(
										`[execution-manager] Order ${limitResult.orderId} already filled ` +
											`(qty=${detail.filledQty}), skipping market fallback`,
									);
									filled = true;
									result = {
										...limitResult,
										qty: detail.filledQty,
										price: detail.avgPrice || limitResult.price || limitPrice,
										status: detail.status,
									};
								} else if (detail.filledQty > 0) {
									// Partial fill — record what we got, don't double-enter
									console.warn(
										`[execution-manager] Order ${limitResult.orderId} partially filled ` +
											`(${detail.filledQty}/${adjustedQty}), recording partial — no market fallback`,
									);
									filled = true;
									result = {
										...limitResult,
										qty: detail.filledQty,
										price: detail.avgPrice || limitResult.price || limitPrice,
										status: detail.status,
									};
								} else {
									// Confirmed 0 fill — safe to place market fallback
									cancelSucceeded = true;
								}
							} catch (detailErr) {
								// Cannot determine order state — abort to prevent double-fill
								console.warn(
									`[execution-manager] Cannot reconcile order ${limitResult.orderId} after cancel failure: ` +
										`${detailErr instanceof Error ? detailErr.message : String(detailErr)}. ` +
										`Aborting — manual reconciliation required.`,
								);
								store.updateSubmittedOrder(idempotencyKey, "failed");
								return {
									success: false,
									mode: "LIVE",
									reason: `Cancel failed and order ${limitResult.orderId} status ambiguous — reconcile manually`,
									orderType: actualOrderType,
									limitFallback: false,
								};
							}
						}

						if (!filled && cancelSucceeded) {
							// Cancel confirmed — but the limit order may have partially filled
							// before the cancel went through. Check order detail to get the
							// actual filled qty, then only market-fill the remainder.
							let limitFilledQty = 0;
							try {
								const detail = await client.getOrderDetail(params.symbol, limitResult.orderId);
								const detailStatus = detail.status.trim().toUpperCase();
								if (
									detail.orderId !== limitResult.orderId ||
									!TERMINAL_ORDER_STATUSES.has(detailStatus) ||
									!Number.isFinite(detail.filledQty) ||
									detail.filledQty < 0 ||
									detail.filledQty > adjustedQty + 1e-8 ||
									(detailStatus === "FILLED" && detail.filledQty + 1e-8 < adjustedQty)
								) {
									throw new Error("order detail is not terminal or internally consistent");
								}
								limitFilledQty = detail.filledQty ?? 0;
								if (limitFilledQty > 0) {
									preCancelLimitPrice = detail.avgPrice || limitResult.price || limitPrice;
								}
							} catch (detailErr) {
								console.warn(
									`[execution-manager] Cannot reconcile order ${limitResult.orderId} after cancel: ` +
										`${detailErr instanceof Error ? detailErr.message : String(detailErr)}. ` +
										"Aborting — manual reconciliation required.",
								);
								store.updateSubmittedOrder(idempotencyKey, "failed", limitResult.orderId);
								return {
									success: false,
									mode: "LIVE",
									orderId: limitResult.orderId,
									reason: `Cancelled limit order ${limitResult.orderId} fill ambiguous — reconcile manually`,
									orderType: "LIMIT",
									limitFallback: false,
								};
							}

							const remainderQty = adjustedQty - limitFilledQty;

							if (limitFilledQty >= adjustedQty) {
								// Fully filled before cancel took effect — use limit fill
								filled = true;
								result = {
									...limitResult,
									qty: limitFilledQty,
									price: limitResult.price,
									status: "FILLED",
								};
							} else if (remainderQty > 1e-8) {
								// Partial or zero fill — market-fill the remainder
								actualOrderType = "MARKET";
								limitFallback = true;
								const marketResult = await reconcileMarketFill(
									client,
									params.symbol,
									await withExchangeRetry(
										() =>
											client.createOrder({
												symbol: params.symbol,
												side,
												type: "MARKET",
												qty: remainderQty,
											}),
										exchangeRetryOpts,
									),
									remainderQty,
								);
								if (limitFilledQty > 0) {
									// Combine: limit partial + market remainder
									preCancelLimitFill = limitFilledQty;
									console.warn(
										`[execution-manager] LIMIT partial fill ${limitFilledQty} + MARKET remainder ${remainderQty} ` +
											`(symbol=${params.symbol})`,
									);
								}
								result = marketResult;
							} else {
								// Fully filled (within dust tolerance) — use limit fill
								filled = true;
								result = {
									...limitResult,
									qty: limitFilledQty,
									price: limitResult.price,
									status: "FILLED",
								};
							}
						}
					}
				}

				// TypeScript narrowing: result is guaranteed assigned at this point
				result = result!;
			} else {
				// ── Direct MARKET order ──────────────────────────────────────────
				// Execute with classified retry logic: rate limits get exponential
				// backoff, network errors get 3 retries, auth/unknown halt immediately.
				console.debug(
					`[execution-manager] MARKET order: ${params.symbol} ${side} qty=${adjustedQty}`,
				);
				result = await withExchangeRetry(
					() =>
						client.createOrder({
							symbol: params.symbol,
							side,
							type: "MARKET",
							qty: adjustedQty,
						}),
					exchangeRetryOpts,
				);

				try {
					result = await reconcileMarketFill(client, params.symbol, result, adjustedQty);
				} catch (detailErr) {
					store.updateSubmittedOrder(idempotencyKey, "failed", result.orderId);
					console.warn(
						`[execution-manager] Cannot reconcile MARKET order ${result.orderId}: ` +
							`${detailErr instanceof Error ? detailErr.message : String(detailErr)}. ` +
							"Aborting — manual reconciliation required.",
					);
					return {
						success: false,
						mode: "LIVE",
						orderId: result.orderId,
						orderType: "MARKET",
						reason: `Market order ${result.orderId || "unknown"} fill ambiguous — reconcile manually`,
					};
				}
			}

			// ── Partial fill handling ──────────────────────────────────────────────
			// If the exchange returns a filled quantity less than requested, record
			// the position with the actual filled amount. This prevents phantom
			// exposure where we think we hold more than we actually do.
			// When a LIMIT order partially filled before cancel + MARKET remainder,
			// combine both fills for the total position qty.
			const primaryFillQty = result.qty ?? adjustedQty;
			const primaryFillPrice =
				result.price ||
				(actualOrderType === "LIMIT" ? (submittedLimitPrice ?? executionPrice) : executionPrice);
			const filledQty = primaryFillQty + preCancelLimitFill;
			const fillNotional =
				primaryFillQty * primaryFillPrice +
				preCancelLimitFill * (preCancelLimitPrice ?? submittedLimitPrice ?? executionPrice);
			const isPartialFill = filledQty < adjustedQty;

			if (isPartialFill) {
				console.warn(
					`[execution-manager] Partial fill detected: requested ${adjustedQty}, ` +
						`filled ${filledQty} (symbol=${params.symbol}, orderId=${result.orderId})`,
				);
			}

			if (limitFallback) {
				console.warn(
					`[execution-manager] LIMIT->MARKET fallback completed: ${params.symbol} ` +
						`orderId=${result.orderId} filledQty=${filledQty}`,
				);
			}

			// Mixed LIMIT+MARKET fills must use a weighted average entry price or
			// downstream P&L, fee, and stop calculations will be wrong.
			const actualEntryPrice = filledQty > 0 ? fillNotional / filledQty : executionPrice;
			const liveVenue = resolveVenue(params.symbol);
			const schedules = this.deps.feeSchedule ?? getDefaultFeeSchedules();
			const liveCostResult = computeTradeCost({
				price: actualEntryPrice,
				qty: filledQty,
				side,
				orderType: actualOrderType,
				venue: liveVenue,
				feeSchedule: schedules,
				slippageBps: 0,
			});
			const liveFeeRate = liveCostResult.feeRate;
			const latencyMs = Date.now() - execStartMs;
			const slippageBps = computeAdverseSlippageBps({
				side,
				expectedPrice: executionPrice,
				fillPrice: actualEntryPrice,
			});
			const impactBps = computeAdverseImpactBps({
				side,
				fillPrice: actualEntryPrice,
				book: bookSnapshot,
			});
			const routeJson = JSON.stringify({
				expectedPrice: executionPrice,
				fillPrice: actualEntryPrice,
				latencyMs,
				slippageBps,
				impactBps,
				requestedOrderType: params.orderType ?? null,
				resolvedOrderType,
				actualOrderType,
				limitFallback,
				partialFill: isPartialFill,
				bestBid: bookSnapshot?.bestBid ?? null,
				bestAsk: bookSnapshot?.bestAsk ?? null,
				midPrice: bookSnapshot?.midPrice ?? null,
				adaptiveRoutingReason: routeDecision?.reason ?? null,
			});

			store.logTrade({
				symbol: params.symbol,
				side,
				type: actualOrderType,
				qty: filledQty,
				price: actualEntryPrice,
				orderId: result.orderId,
				isPaper: false,
				slippageBps,
				routeJson,
			});

			const position = store.openPosition({
				symbol: params.symbol,
				side: params.direction,
				entryPrice: actualEntryPrice,
				qty: filledQty,
				stopLoss: params.stopLoss,
				takeProfit: params.takeProfit,
				trailingStopPct: params.trailingStopPct,
				isPaper: false,
				feeRate: liveFeeRate,
				slippageBps,
				routeJson,
			});
			this.deps.executionQualityController?.recordExecution({
				symbol: params.symbol,
				side,
				requestedOrderType: resolvedOrderType,
				actualOrderType,
				expectedPrice: executionPrice,
				fillPrice: actualEntryPrice,
				latencyMs,
				partialFill: isPartialFill,
				limitFallback,
				book: bookSnapshot,
			});

			store.updateSubmittedOrder(idempotencyKey, "confirmed", result.orderId);
			const orderAuditCorrelationId = this.emitExecutionAudit({
				symbol: params.symbol,
				side,
				mode: "LIVE",
				orderId: result.orderId,
				positionId: position.id,
				qty: filledQty,
				resultSummary: `signal live orderId=${result.orderId} filled=${filledQty}${limitFallback ? " limitFallback" : ""}`,
			});
			return {
				success: true,
				mode: "LIVE",
				orderId: result.orderId,
				filledQty,
				partialFill: isPartialFill,
				orderType: actualOrderType,
				limitFallback,
				orderAuditCorrelationId,
			};
		} catch (err) {
			const errorType = classifyExchangeError(err);
			const errorMsg =
				typeof this.deps.client.scrubError === "function"
					? this.deps.client.scrubError(err)
					: scrubErrorMessage(err);
			store.updateSubmittedOrder(idempotencyKey, "failed");

			console.error(
				`[execution-manager] Live order FAILED (${errorType}): ${errorMsg} ` +
					`(symbol=${params.symbol} qty=${params.qty} type=${resolvedOrderType})`,
			);

			return {
				success: false,
				mode: "LIVE",
				reason: `Order failed (${errorType}): ${errorMsg}`,
			};
		}
	}
}
