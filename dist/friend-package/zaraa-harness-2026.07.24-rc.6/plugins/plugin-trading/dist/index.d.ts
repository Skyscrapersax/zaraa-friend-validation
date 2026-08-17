import { Zone, PluginManifest } from '@zaraa/shared';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { EventEmitter } from 'node:events';

interface Ticker {
    symbol: string;
    bid: number;
    ask: number;
    last: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    change24h: number;
}
interface OrderBookEntry {
    price: number;
    qty: number;
}
interface OrderBook {
    symbol: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
}
interface TradeResult {
    orderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    /** Filled quantity (e.g. Binance's executedQty). May be less than requestedQty on a partial fill. */
    qty: number;
    /** Quantity originally requested. Optional for backward compatibility with adapters that don't echo it yet. */
    requestedQty?: number;
    price?: number;
    status: string;
}
interface Balance {
    currency: string;
    available: number;
    locked: number;
    total: number;
}
interface CryptoClientConfig {
    apiKey?: string;
    apiSecret?: string;
}
declare class CryptoClient {
    readonly exchangeId = "crypto_com";
    private apiKey;
    private apiSecret;
    private publicRateLimiter;
    private privateRateLimiter;
    constructor(config?: CryptoClientConfig);
    get hasCredentials(): boolean;
    /** Redact API key/secret and common patterns — safe for logs and tool output. */
    scrubError(err: unknown): string;
    private scrubMsg;
    getTicker(symbol: string): Promise<Ticker>;
    getTickers(): Promise<Ticker[]>;
    getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
    getCandles(symbol: string, timeframe: string): Promise<{
        openTime: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[]>;
    getBalances(): Promise<Balance[]>;
    createOrder(params: {
        symbol: string;
        side: "BUY" | "SELL";
        type: "MARKET" | "LIMIT";
        qty: number;
        price?: number;
    }): Promise<TradeResult>;
    cancelOrder(symbol: string, orderId: string): Promise<{
        orderId: string;
        status: string;
    }>;
    /**
     * Fetch final status of a specific order (filled qty, avg price, status).
     * Used for reconciliation after a limit order leaves the open-order book
     * or after a cancel attempt fails.
     */
    getOrderDetail(symbol: string, orderId: string): Promise<{
        orderId: string;
        status: string;
        filledQty: number;
        avgPrice: number;
    }>;
    getOpenOrders(symbol?: string): Promise<TradeResult[]>;
    private requireAuth;
    private publicGet;
    /** Monotonic counter to prevent nonce collisions */
    private nonceCounter;
    private privatePost;
}

interface BacktestSummary {
    id: string;
    strategy: string;
    symbol: string;
    timeframe: string;
    startDate: string;
    endDate: string;
    startingEquity: number;
    finalEquity: number;
    totalPnl: number;
    totalReturnPct: number;
    winRate: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    totalTrades: number;
    resultJson: string;
    createdAt: string;
}
interface Position {
    id: string;
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    qty: number;
    currentPrice: number | null;
    pnl: number | null;
    status: "open" | "closed";
    openedAt: string;
    closedAt: string | null;
    /** true = paper/simulated, false = live real-money. Returned by SQLite as 0|1. */
    isPaper?: boolean | number;
    /** e.g. dex_solana for Jupiter; null/undefined for CEX */
    executionVenue?: string | null;
    chain?: string | null;
    txSignature?: string | null;
    slippageBps?: number | null;
    routeJson?: string | null;
    /** Exchange identifier (e.g. "crypto_com"), if tracked. */
    exchange?: string | null;
}
interface PositionWithStops extends Position {
    stopLoss: number | null;
    takeProfit: number | null;
    trailingStopPct: number | null;
    trailingStopHigh: number | null;
}
interface EquitySnapshot {
    timestamp: string;
    equity: number;
}
interface LiveEquitySnapshot extends EquitySnapshot {
    source: string;
}
interface RiskMonitorEvent {
    id: string;
    createdAt: string;
    fromState: string;
    toState: string;
    reason: string;
    detailJson: string | null;
}
interface PriceAlert {
    id: string;
    symbol: string;
    condition: "above" | "below";
    targetPrice: number;
    triggered: boolean;
    createdAt: string;
    triggeredAt: string | null;
}
interface TradeLog {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    qty: number;
    price: number;
    total: number;
    orderId: string | null;
    createdAt: string;
    isPaper: boolean;
    executionVenue?: string | null;
    chain?: string | null;
    txSignature?: string | null;
    slippageBps?: number | null;
    routeJson?: string | null;
}
/** One currency slot in the virtual paper portfolio (e.g. USDT, BTC, ETH) */
interface PaperBalance {
    currency: string;
    balance: number;
}
/** Per-position line in the daily P&L report */
interface DailyPnLPosition {
    positionId: string;
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnl: number;
    pnlPct: number;
    openedAt: string;
    closedAt: string;
}
/** Daily P&L summary — shown by the trade_paper_summary handler */
interface DailyPnLSummary {
    date: string;
    mode: "PAPER" | "LIVE";
    totalPnl: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    positions: DailyPnLPosition[];
    paperPortfolio?: {
        balances: PaperBalance[];
        startingUsd: number;
        currentUsd: number;
        totalReturn: number;
        totalReturnPct: number;
    };
}
interface TradingStoreConfig {
    path: string;
    /**
     * Interval (ms) for periodic WAL checkpoints. Keeps trading.db readable by
     * out-of-process tooling (mirror DBs, monitors) even when the writer is
     * idle. Set to 0 to disable. Default: 60_000.
     */
    walCheckpointIntervalMs?: number;
}
declare class TradingStore {
    private db;
    private walCheckpointTimer;
    /** Cache of prepared statements keyed by SQL string. */
    private _stmtCache;
    /** Return a cached prepared statement, creating it on first use. */
    private _stmt;
    constructor(config: TradingStoreConfig);
    /**
     * Returns the underlying SQLite database instance.
     * Used by the JournalReporter to run complex cross-table queries.
     */
    getDb(): Database.Database;
    openPosition(input: {
        symbol: string;
        side: "long" | "short";
        entryPrice: number;
        qty: number;
        stopLoss?: number;
        takeProfit?: number;
        trailingStopPct?: number;
        isPaper?: boolean;
        feeRate?: number;
        executionVenue?: string | null;
        chain?: string | null;
        txSignature?: string | null;
        slippageBps?: number | null;
        routeJson?: string | null;
        /**
         * Opt out of automatic paper_balances reconciliation. Set to true when
         * the caller already debits/credits paper_balances itself (e.g. legacy
         * handlers.ts paper trade flow that manages balances separately).
         * Default: false — long paper opens debit quote and credit base.
         */
        skipPaperBalanceReconcile?: boolean;
    }): Position;
    closePosition(id: string, exitPrice: number, feeRate?: number, options?: {
        skipPaperBalanceReconcile?: boolean;
    }): Position | null;
    /**
     * Close a fraction of an open position.
     * Reduces qty on the existing position and creates a new closed record for the exited portion.
     * Returns the closed portion as a Position, or null if the position doesn't exist.
     */
    closePartial(id: string, exitQty: number, exitPrice: number, options?: {
        skipPaperBalanceReconcile?: boolean;
    }): Position | null;
    /**
     * Split a "BASE_QUOTE" symbol into its currency pair. Returns null for
     * non-spot symbols (e.g. solana:* DEX symbols which the DEX-aware caller
     * handles separately).
     */
    private _extractSpotCurrencies;
    /**
     * Debit quote and credit base when a paper long opens. Skips shorts
     * (paper spot balances don't model margin) and non-spot symbols.
     * Must be called inside a transaction.
     */
    private _reconcilePaperOpen;
    /**
     * Credit quote and debit base when a paper long closes. Mirror of
     * `_reconcilePaperOpen`. The base debit is clamped at zero by
     * `updatePaperBalance` so positions opened pre-fix can't drive
     * balances negative on close.
     */
    private _reconcilePaperClose;
    getOpenPositions(): Position[];
    getAllPositions(): Position[];
    getPositionsWithStops(): PositionWithStops[];
    /**
     * Returns open positions that have NO stop-loss set (or an invalid one ≤ 0).
     * Used by the safety sweep in trade_risk_status to flag unprotected positions.
     *
     * Note: a position can have a take-profit but still be missing a stop-loss —
     * this query catches that case, unlike getPositionsWithStops() which includes
     * positions that have only a take-profit.
     */
    getOpenPositionsMissingStopLoss(): Position[];
    updateStops(id: string, stops: {
        stopLoss?: number | null;
        takeProfit?: number | null;
        trailingStopPct?: number | null;
    }): boolean;
    /** Update the live currentPrice and unrealized P&L on an open position. */
    updatePositionPrice(id: string, currentPrice: number, pnl: number): void;
    updateTrailingStopHigh(id: string, price: number): void;
    /** Update stop-loss on an open position (e.g., move to breakeven after partial TP). */
    updateStopLoss(id: string, stopLoss: number): void;
    /** Enable or update trailing stop on an open position. */
    updateTrailingStop(id: string, trailingStopPct: number, currentPrice: number): void;
    /** Record that a profit milestone was hit for a position. */
    recordMilestoneHit(positionId: string, profitPct: number): void;
    /** Get all milestone profitPct values that have fired for a given position. */
    getMilestoneHits(positionId: string): number[];
    /**
     * Load all milestone hits for all open positions.
     * Returns a Map<positionId, Set<profitPct>> suitable for restoring
     * StopMonitor.scaledOutMilestones on startup.
     */
    getAllOpenMilestoneHits(): Map<string, Set<number>>;
    /** Clean up milestone records for closed positions. */
    cleanupClosedMilestones(): number;
    recordEquity(equity: number): void;
    getPeakEquity(): number;
    /**
     * Reset peak equity to current equity level, accepting the drawdown as a new baseline.
     * This clears old equity snapshots above the new baseline so getPeakEquity() returns
     * the reset level. Used after a drawdown recovery decision — the portfolio manager
     * acknowledges the loss and resumes trading from the new baseline.
     */
    resetPeakEquity(): {
        oldPeak: number;
        newBaseline: number;
    };
    /**
     * Get the most recent equity snapshot value.
     * Unlike getPeakEquity() (which returns the all-time high), this returns
     * the latest recorded equity — the best proxy for current account value.
     * Ignores non-positive rows so a stale zero snapshot cannot mask the last good point.
     * Returns 0 if no positive snapshots exist.
     */
    getLatestEquity(): number;
    /**
     * Operator-facing equity: latest snapshot, else peak, else configured initial.
     * Use this when `getLatestEquity()` is 0 — that value is often a "no snapshot yet"
     * sentinel, not literal account equity.
     */
    resolveReportEquity(isPaper: boolean): number;
    getEquityHistory(limit?: number): EquitySnapshot[];
    /** Persist authenticated exchange NAV separately from paper/model equity. */
    recordLiveEquity(equity: number, source: string, timestamp?: string): void;
    getLatestLiveEquitySnapshot(): LiveEquitySnapshot | null;
    getPeakLiveEquity(): number;
    getInitialLiveEquity(): number;
    getInitialEquity(isPaper?: boolean): number;
    getTradingState(): string;
    setTradingState(state: "ACTIVE" | "LOCKED" | "HALTED"): void;
    logRiskMonitorEvent(input: {
        fromState: string;
        toState: string;
        reason: string;
        detailJson?: string | null;
    }): RiskMonitorEvent;
    getRiskMonitorEvents(limit?: number): RiskMonitorEvent[];
    createAlert(input: {
        symbol: string;
        condition: "above" | "below";
        targetPrice: number;
    }): PriceAlert;
    getActiveAlerts(): PriceAlert[];
    /** Price alerts that fired on or after `sinceIso` (for morning / overnight briefing). */
    getTriggeredAlertsSince(sinceIso: string): PriceAlert[];
    triggerAlert(id: string): void;
    deleteAlert(id: string): boolean;
    logTrade(input: {
        symbol: string;
        side: "BUY" | "SELL";
        type: "MARKET" | "LIMIT";
        qty: number;
        price: number;
        orderId?: string;
        isPaper?: boolean;
        executionVenue?: string | null;
        chain?: string | null;
        txSignature?: string | null;
        slippageBps?: number | null;
        routeJson?: string | null;
    }): TradeLog;
    getRecentTrades(limit?: number): TradeLog[];
    /**
     * Total USD spent on all trades (BUY and SELL) today (UTC).
     * Pass isPaper=true to count only paper trades, false for only live trades.
     * This keeps paper trading limits separate from live trading limits.
     * Counts both entry costs (BUY/short-SELL) and exit proceeds/fees (SELL/short-BUY).
     */
    getDailySpend(isPaper?: boolean): number;
    /**
     * Solana DEX (`solana:*`) notional summed for today (UTC), same paper/live split as getDailySpend.
     * Used with getDailySpend to enforce daily_limit_usd across CEX + Jupiter paths.
     */
    getDexSolanaDailySpend(isPaper?: boolean): number;
    /**
     * Count consecutive losing closed positions (newest first).
     *
     * When `isPaper` is provided, only counts positions in that mode.
     * This prevents paper losses from tripping live circuit breakers and
     * vice versa. When omitted, counts all positions (legacy behavior)
     * and filters by the current paper_mode setting.
     */
    getConsecutiveLosses(isPaper?: boolean): number;
    getTradeCount(): number;
    getWinRate(): number;
    getSetting(key: string): string | undefined;
    setSetting(key: string, value: string): void;
    /**
     * Initialize the paper portfolio with starting USDT balance.
     * Only sets the balance if USDT has never been set before.
     * Called automatically on startup.
     */
    initPaperPortfolio(): void;
    /** Get the balance of a single currency in the paper portfolio. Returns 0 if not held. */
    getPaperBalance(currency: string): number;
    /** Get all non-zero currency balances in the paper portfolio. */
    getAllPaperBalances(): PaperBalance[];
    /**
     * Adjust a currency balance by delta (positive = credit, negative = debit).
     * Creates the row if it doesn't exist yet (e.g. first time holding a coin).
     *
     * Safety: clamps the resulting balance at zero. paper_balances rows must
     * never go negative — a debit larger than the held balance produces 0,
     * not a negative number. Closing a position whose open didn't credit
     * (legacy state, ghost balances) can't drive the asset below zero.
     */
    updatePaperBalance(currency: string, delta: number): void;
    /**
     * Reset the paper portfolio to its starting balance.
     *
     * Wipes paper balances, paper positions, paper trade log, equity history,
     * and circuit-breaker peak/trip state in one transaction. Equity history
     * and CB state must reset together: leaving stale `equity_snapshots` rows
     * lets `MAX(equity_snapshots)` re-poison the drawdown CB peak the next
     * time the daemon syncs from disk (the recurring phantom-equity bug).
     *
     * If `mirrorDbPath` is supplied, the same reset is applied to a second
     * trading.db file (the validation-daemon's mirror). Daemons writing to
     * the same file are coordinated by SQLite WAL; this is safe to call from
     * the live daemon while the validation daemon is also running.
     */
    resetPaperPortfolio(options?: {
        mirrorDbPath?: string | null | undefined;
    }): void;
    private static applyPaperReset;
    /**
     * Sanity-check paper-mode equity state to catch poison-cycle bugs early.
     * Returns human-readable warnings; emits nothing on a clean state.
     *
     * Triggers:
     *   - drawdown CB peak_equity > paper USDT * 2 and no open paper
     *     positions ⇒ peak almost certainly stale (the phantom-equity
     *     pattern documented in project_phantom_equity_drain).
     *   - dead `shadow_equity` setting key still present ⇒ leftover from
     *     pre-rewrite state; self-healed by DELETE (no readers in codebase).
     *     Live 2026-07-25: warn-only left the key in place and thrash-warned
     *     every daemon boot.
     */
    validatePaperEquityInvariants(): string[];
    /**
     * Build a daily P&L summary for a given UTC date (format: YYYY-MM-DD).
     * Looks at positions that were CLOSED on that date.
     */
    getDailyPnLSummary(date: string, isPaper: boolean): DailyPnLSummary;
    /**
     * Save a completed backtest result to the database.
     * The full result is stored in resultJson so we can reconstruct it later.
     * Returns the generated ID for the stored record.
     */
    saveBacktestResult(input: {
        strategy: string;
        symbol: string;
        timeframe: string;
        startDate: string;
        endDate: string;
        startingEquity: number;
        finalEquity: number;
        totalPnl: number;
        totalReturnPct: number;
        winRate: number;
        sharpeRatio: number;
        maxDrawdownPct: number;
        totalTrades: number;
        resultJson: string;
    }): string;
    /**
     * List recent backtest summaries (newest first).
     * Pass strategy/symbol to filter, or leave blank for all.
     */
    listBacktestResults(opts?: {
        strategy?: string;
        symbol?: string;
        limit?: number;
    }): BacktestSummary[];
    /**
     * Fetch a single stored backtest result by its ID.
     * Returns null if not found.
     */
    getBacktestResult(id: string): BacktestSummary | null;
    /**
     * Check whether an order with this idempotency key was already submitted.
     * Returns the existing record if found (and not expired), or null.
     *
     * The key is a SHA-256 hash of (symbol + side + qty + type + time-window).
     * Callers must generate this before attempting to submit an order.
     */
    getSubmittedOrder(key: string): {
        key: string;
        orderId: string | null;
        status: string;
        symbol: string;
        createdAt: string;
    } | null;
    /**
     * Record a new order submission attempt with status 'pending'.
     * Returns false if the key already exists (duplicate detected).
     */
    markOrderSubmitted(key: string, symbol: string): boolean;
    /**
     * Update a submitted order's status and optionally set the exchange orderId.
     * Called after order confirmation ('confirmed') or failure ('failed').
     */
    updateSubmittedOrder(key: string, status: "confirmed" | "failed" | "cancelled", orderId?: string): void;
    listSubmittedOrdersByStatus(status: "pending" | "confirmed" | "failed" | "cancelled"): Array<{
        key: string;
        orderId: string | null;
        status: string;
        symbol: string;
        createdAt: string;
    }>;
    cancelPendingSubmittedOrders(): number;
    /**
     * Clean up expired submitted orders (older than 24 hours).
     * Called periodically to prevent table bloat.
     */
    cleanupExpiredOrders(): number;
    logOpusGrind(entry: {
        id: string;
        startedAt: string;
        completedAt?: string;
        durationMs?: number;
        status: string;
        marketRegime?: string;
        bestOpportunity?: string;
        portfolioEquity?: number;
        portfolioPnl?: number;
        drawdownPct?: number;
        riskViolations?: number;
        tradeExecuted?: number;
        alertsSet?: number;
        memoriesStored?: number;
        parameterTweaks?: number;
        stepsCompleted?: number;
        stepsSkipped?: number;
        actionsTaken?: number;
        summaryJson?: string;
        errorMessage?: string;
    }): void;
    getRecentOpusGrinds(limit?: number): Array<Record<string, unknown>>;
    close(): void;
}

interface FeeSchedule {
    venue: string;
    makerRate: number;
    takerRate: number;
}
declare function resolveVenue(symbol: string): string;
declare function resolveFeeRate(venue: string, orderType: "MARKET" | "LIMIT", schedules: FeeSchedule[]): number;
declare function getDefaultFeeSchedules(): FeeSchedule[];

interface Candle {
    symbol: string;
    timeframe: string;
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
declare class CandleStore {
    private db;
    private readonly stmtInsert;
    private readonly stmtGet;
    private readonly stmtGetAscending;
    private readonly stmtGetRange;
    private readonly stmtGetLatestTime;
    private readonly stmtCount;
    private readonly stmtPrune;
    private readonly stmtSymbols;
    constructor(db: Database.Database);
    upsert(candles: Candle[]): number;
    get(symbol: string, timeframe: string, limit?: number): Candle[];
    /**
     * Same as get() but returns candles in ascending (oldest-first) order.
     * Use this when the result will be passed directly to computeIndicators()
     * or strategy.evaluate() — eliminates the [...candles].reverse() spread
     * copy that was the dominant per-scan allocation hotspot.
     */
    getAscending(symbol: string, timeframe: string, limit?: number): Candle[];
    getRange(symbol: string, timeframe: string, fromMs: number, toMs: number): Candle[];
    getLatestTime(symbol: string, timeframe: string): number | null;
    count(symbol: string, timeframe: string): number;
    prune(maxAgeMs: number): number;
    symbols(): string[];
}

/** Timeframes supported by Crypto.com candlestick API */
type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
interface BackfillResult {
    symbol: string;
    timeframe: Timeframe;
    candlesFetched: number;
    requestsMade: number;
    oldestCandle: number | null;
    newestCandle: number | null;
}
interface CandleFetcherConfig {
    client: CryptoClient;
    store: CandleStore;
    /** Symbols to watch (e.g., ["BTC_USDT", "ETH_USDT"]) */
    symbols: string[];
    /** Timeframes to fetch (default: ["5m", "1h", "4h"]) */
    timeframes?: Timeframe[];
}
declare class CandleFetcher {
    private client;
    private store;
    private symbols;
    private timeframes;
    constructor(config: CandleFetcherConfig);
    /**
     * Fetch latest candles for all configured symbols and timeframes.
     *
     * Runs all symbol/timeframe pairs concurrently (limited to batches of 6
     * to avoid overwhelming the exchange API rate limits). Previously these
     * were sequential — with 5 symbols x 3 timeframes = 15 serial HTTP calls
     * taking ~15 seconds. Now completes in ~3 seconds.
     */
    fetchAll(): Promise<{
        fetched: number;
        errors: string[];
    }>;
    /** Fetch candles for a single symbol/timeframe pair */
    fetchCandles(symbol: string, timeframe: Timeframe): Promise<number>;
    /**
     * Backfill historical candle data by paginating through the Crypto.com API.
     *
     * The API returns up to 300 candles per request. For 90 days of 1h data,
     * that's 2160 candles = ceil(2160/300) = 8 requests. Fetches in reverse
     * chronological order using the `end` timestamp for pagination, sleeping
     * briefly between batches to respect rate limits.
     *
     * Upserts into CandleStore, so duplicate candles (same symbol+timeframe+openTime)
     * are safely deduplicated.
     */
    backfill(symbol: string, timeframe: Timeframe, days: number): Promise<BackfillResult>;
    /**
     * Backfill multiple symbols and timeframes at once.
     * Processes each symbol/timeframe pair sequentially to avoid rate limiting.
     */
    backfillAll(symbols: string[], timeframes: Timeframe[], days: number): Promise<{
        results: BackfillResult[];
        errors: string[];
    }>;
    /**
     * Fetch a single page of candles ending at the given timestamp.
     * Returns parsed Candle objects sorted by openTime ascending.
     */
    private fetchCandlePage;
    /** Update the watched symbols list */
    setSymbols(symbols: string[]): void;
    /** Update the watched timeframes list */
    setTimeframes(timeframes: Timeframe[]): void;
    getSymbols(): string[];
    getTimeframes(): Timeframe[];
}

declare const ConfigSchema$5: z.ZodObject<{
    defaultLimitPerMinute: z.ZodDefault<z.ZodNumber>;
    defaultLimitPer10s: z.ZodDefault<z.ZodNumber>;
    burstLimit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    defaultLimitPerMinute: number;
    defaultLimitPer10s: number;
    burstLimit: number;
}, {
    defaultLimitPerMinute?: number | undefined;
    defaultLimitPer10s?: number | undefined;
    burstLimit?: number | undefined;
}>;
type RateLimiterConfig = z.infer<typeof ConfigSchema$5>;
interface RateLimitStatus {
    exchange: string;
    callsLastMinute: number;
    callsLast10s: number;
    callsLastSecond: number;
    limitPerMinute: number;
    limitPer10s: number;
    burstLimit: number;
    isThrottled: boolean;
    retryAfterMs: number;
}
declare class ApiRateLimiter {
    private timestamps;
    private config;
    private customLimits;
    constructor(config?: Partial<RateLimiterConfig>);
    checkAndConsume(exchange: string): {
        allowed: boolean;
        retryAfterMs: number;
    };
    getStatus(exchange: string): RateLimitStatus;
    setLimits(exchange: string, limits: {
        perMinute?: number;
        per10s?: number;
        burst?: number;
    }): void;
    private getLimits;
    private pruneOld;
}

/**
 * Multi-asset historical data fetcher.
 *
 * Primary source is Yahoo Finance daily bars. For assets whose live-friendly ticker is
 * younger than the underlying regime we want to study, older history is backfilled with
 * a normalized proxy:
 * - `SPY` <= `^GSPC`
 * - `GLD` / `IAU` <= `GC=F`
 * - `SLV` <= `SI=F`
 * - `BTC-USD` / `ETH-USD` <= CryptoCompare daily history
 */
interface OHLCVBar {
    date: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    adjClose: number;
    volume: number;
}
interface AssetSeries {
    symbol: string;
    name: string;
    assetClass: "equity" | "precious_metal" | "crypto";
    bars: OHLCVBar[];
    currency: string;
}
interface FetchResult {
    series: AssetSeries[];
    errors: {
        symbol: string;
        error: string;
    }[];
    fetchedAt: string;
    sourcesUsed: string[];
    seriesSources: Record<string, string[]>;
}
declare function computeProxyScale(primaryBars: OHLCVBar[], proxyBars: OHLCVBar[]): number;
declare function spliceExtendedHistory(primary: AssetSeries, proxy: AssetSeries, fromDate: Date, toDate: Date): AssetSeries;
declare class MultiAssetFetcher {
    /**
     * Fetch daily OHLCV bars for a Yahoo Finance symbol.
     * period1/period2 are Unix timestamps in seconds.
     */
    fetchSymbol(symbol: string, fromDate: Date, toDate?: Date): Promise<AssetSeries>;
    private fetchSymbolWithSources;
    private fetchYahooSymbol;
    private fetchCryptoCompareSymbol;
    /**
     * Fetch multiple symbols concurrently (up to 4 at a time to avoid rate-limiting).
     */
    fetchAll(symbols: string[], fromDate: Date, toDate?: Date): Promise<FetchResult>;
    private parseYahooResponse;
    private parseCryptoCompareResponse;
}
/** Default universe for the comparative study */
declare const DEFAULT_UNIVERSE: {
    symbols: string[];
    /** 10 years back balances coverage and runtime for the default report. */
    defaultLookback: () => Date;
};

/**
 * Portfolio allocation optimizer using Monte Carlo simulation of random portfolios
 * to approximate the efficient frontier — no linear algebra library dependency.
 *
 * Produces:
 * - Max-Sharpe allocation
 * - Min-Volatility allocation
 * - Max-Sortino allocation
 * - Equal-weight baseline
 * - Risk-parity allocation
 * - Per-regime optimal allocations (conditioned on RegimeConditionedPerf)
 *
 * Uses log returns for Gaussian approximation. For production, swap the
 * Monte Carlo sampler for a proper quadratic solver (cvxpy or similar).
 */

interface Allocation {
    label: string;
    weights: Record<string, number>;
    expectedReturn: number;
    expectedVol: number;
    sharpe: number;
    sortino: number;
    notes?: string;
}

declare class PortfolioAllocator {
    private allocation;
    private minScalar;
    private maxScalar;
    constructor(opts?: {
        minScalar?: number;
        maxScalar?: number;
    });
    setAllocation(allocation: Allocation): void;
    getAllocation(): Allocation | null;
    getPositionScalar(symbol: string, currentWeights: Record<string, number>): number;
}

interface RiskConfig {
    /** Max % of account equity to risk per trade (default: 1%) */
    riskPerTradePct: number;
    /** Max % of portfolio in a single position (default: 5%) */
    maxPositionPct: number;
    /** Max total % of portfolio in open positions (default: 30%) */
    maxExposurePct: number;
    /** Max drawdown % before halting all new trades (default: 10%) */
    maxDrawdownPct: number;
    /** Default stop-loss as ATR multiplier (default: 1.5) */
    defaultStopAtrMultiplier: number;
    /** Default risk:reward ratio for take-profit (default: 1.5) */
    defaultRiskRewardRatio: number;
    /** Max number of concurrent open positions (default: 5) */
    maxOpenPositions: number;
    /** Max consecutive losses before halting trading (default: 5) */
    maxConsecutiveLosses?: number;
    /** Max positions per individual asset (default: 3). Prevents piling into one symbol. */
    maxPositionsPerAsset?: number;
    /** Default trailing stop % applied to all new positions (default: 3). Set 0 to disable. */
    defaultTrailingStopPct?: number;
    /** Min price distance % from existing position to allow new entry for same symbol (default: 2). Prevents clustering. */
    minEntryDistancePct?: number;
    /** ATR multiplier for DEX stop-loss calculation (default: 2.0). Higher than CEX default to account for on-chain volatility. */
    dexStopAtrMultiplier?: number;
}
declare const DEFAULT_RISK_CONFIG: RiskConfig;
interface PositionSizeResult {
    qty: number;
    riskAmount: number;
    stopLoss: number;
    takeProfit: number;
    riskRewardRatio: number;
    positionValueUsd: number;
    portfolioPct: number;
}
interface TradeValidation {
    allowed: boolean;
    reasons: string[];
    suggested?: PositionSizeResult;
    /**
     * When a trade is rejected for size-related reasons (exposure or position size),
     * this field contains the maximum quantity that WOULD pass all size constraints.
     * Undefined when the trade is allowed or when rejection is for non-size reasons
     * (drawdown, circuit breaker, min distance, max positions).
     * Value is 0 when no size would pass (e.g., exposure already at max).
     */
    suggestedQty?: number;
}
declare class RiskManager {
    private config;
    constructor(config?: Partial<RiskConfig>);
    /**
     * Calculate position size based on risk per trade.
     * Uses the formula: qty = (equity * riskPct) / (entryPrice - stopLossPrice)
     */
    calculatePositionSize(accountEquity: number, entryPrice: number, stopLossPrice: number): PositionSizeResult;
    /**
     * Calculate ATR-based stop-loss price.
     */
    calculateStopLoss(entryPrice: number, atrValue: number, side: "long" | "short", multiplier?: number): number;
    /**
     * Calculate take-profit price based on risk:reward ratio.
     */
    calculateTakeProfit(entryPrice: number, stopLossPrice: number, riskRewardRatio?: number): number;
    /**
     * Check if current drawdown exceeds the max allowed.
     */
    isDrawdownExceeded(currentEquity: number, peakEquity: number): boolean;
    /**
     * Calculate current drawdown percentage.
     */
    getDrawdownPct(currentEquity: number, peakEquity: number): number;
    /**
     * Validate a proposed trade against all risk rules.
     */
    validateTrade(input: {
        entryPrice: number;
        qty: number;
        side: "long" | "short";
        accountEquity: number;
        peakEquity: number;
        openPositions: Position[];
        atrValue?: number;
        /** Symbol being traded — used for per-asset position limit */
        symbol?: string;
        /** Number of recent consecutive losses (for circuit breaker) */
        consecutiveLosses?: number;
    }): TradeValidation;
    getConfig(): RiskConfig;
    updateConfig(updates: Partial<RiskConfig>): void;
}

type VolRegime = "low" | "normal" | "high";
interface VolRegimeBands {
    /** Annualized vol below this threshold is "low". Default: 0.30 (30%). */
    lowMaxAnnualizedVol: number;
    /** Annualized vol at-or-above this threshold is "high". Default: 0.80 (80%). */
    highMinAnnualizedVol: number;
    /** Multiplier applied to drawdown thresholds when regime is "low". Default: 1.4 (looser). */
    lowScale: number;
    /** Multiplier applied to drawdown thresholds when regime is "high". Default: 0.6 (tighter). */
    highScale: number;
}

type BreakerType = "consecutive_loss" | "drawdown" | "velocity" | "policy_volume";
interface BreakerRow {
    id: number;
    breaker_type: BreakerType;
    trip_count: number;
    is_tripped: number;
    trip_reason: string | null;
    tripped_at: string | null;
    cooldown_until: string | null;
    peak_equity: number;
    consecutive_losses: number;
    last_updated: string;
}
interface BreakerStatus {
    halted: boolean;
    reasons: string[];
}
interface TradingCircuitBreakerConfig {
    /** Max consecutive losses before halting. Default: 5 */
    maxConsecutiveLosses?: number;
    /** Max drawdown % before halting. Default: 10 */
    maxDrawdownPct?: number;
    /** Velocity window for fast-drop detection in ms. Default: 10 minutes */
    velocityWindowMs?: number;
    /** Min equity drop % within the velocity window to trip. Default: 5 */
    velocityDropPct?: number;
    /** How often to flush velocity buffer to equity_snapshots (ms). Default: 5 minutes */
    persistIntervalMs?: number;
    /** Cooldown period in ms before auto-resetting tripped breakers. Default: 4 hours (14400000). Set to 0 to disable auto-reset. */
    cooldownMs?: number;
    /** Vol-adaptive CB: scale drawdown/velocity thresholds by current vol regime. Default: false (disabled). */
    useVolAdaptiveCB?: boolean;
    /** Bands defining low/normal/high regimes + their threshold multipliers. */
    volRegimeBands?: VolRegimeBands;
    /** Current annualized vol used to derive the regime. Caller is responsible for refreshing. */
    currentAnnualizedVol?: number;
    /** Rolling buffer size for median-smoothing the equity reading used in the
     *  drawdown comparison. A single outlier tick can't move the median when
     *  the buffer holds ≥3 entries. Default: 5. */
    equitySmoothingWindow?: number;
    /** A tick-to-tick drop ≥ this pct within `suspiciousTickWindowMs` is treated
     *  as a likely feed glitch (skips drawdown evaluation until confirmed by
     *  `suspiciousTickConfirmCount` consecutive ticks). Default: 15. */
    suspiciousTickDropPct?: number;
    /** Max ms between the previous and current tick for the rate-of-change guard
     *  to apply. Drops spread over longer than this window are treated as real.
     *  Default: 5 minutes. */
    suspiciousTickWindowMs?: number;
    /** Number of consecutive ticks that must remain in the drop zone (≥
     *  `suspiciousTickDropPct` below the pre-drop baseline) before the drawdown
     *  CB is allowed to evaluate. Default: 3. */
    suspiciousTickConfirmCount?: number;
    /** Configured starting capital (paper `virtual_balance_usd`, or the live
     *  initial equity). On startup the drawdown peak high-water mark is floored at
     *  this value so drawdown is always measured from at least the real starting
     *  balance — even when `equity_snapshots` never recorded a tick at the full
     *  starting balance (e.g. snapshots began after equity had already dipped a few
     *  dollars), which would otherwise pin the peak below the starting capital via
     *  the snapshot-cap and UNDER-report drawdown. The floor only ever RAISES the
     *  peak, so it tightens (never loosens) the breaker. Default: 0 (no floor —
     *  preserves legacy behavior for callers that don't supply it). */
    virtualBalance?: number;
}
/**
 * Persistent trading risk circuit breaker.
 *
 * Manages three breakers:
 *   - consecutive_loss: trips after N consecutive losing trades
 *   - drawdown: trips when equity falls N% below peak
 *   - velocity: trips when equity drops >N% within a rolling time window
 *
 * All state is persisted to the circuit_breaker_state SQLite table so that
 * trips survive process restarts. The drawdown peak_equity and consecutive loss
 * counter are restored from the DB on construction.
 */
declare class TradingCircuitBreaker {
    private db;
    private readonly baseMaxDrawdownPct;
    private readonly baseVelocityDropPct;
    private readonly maxConsecutiveLosses;
    private maxDrawdownPct;
    private readonly velocityWindowMs;
    private velocityDropPct;
    private readonly persistIntervalMs;
    private readonly cooldownMs;
    private readonly useVolAdaptiveCB;
    private readonly volRegimeBands;
    private currentVolRegime;
    private readonly equitySmoothingWindow;
    private readonly suspiciousTickDropPct;
    private readonly suspiciousTickWindowMs;
    private readonly suspiciousTickConfirmCount;
    /** Configured starting capital used as the drawdown peak floor on startup. 0 = no floor. */
    private readonly virtualBalance;
    private consecutiveLosses;
    private peakEquity;
    private lastEquity;
    private lastEquityTimestampMs;
    private consecutiveLossTripped;
    private drawdownTripped;
    private velocityTripped;
    /** Previous sample's drop pct; velocity only trips when two consecutive
     * samples both exceed velocityDropPct. Guards against single spurious
     * equity readings (see 2026-04-18 01:46:03 incident — $1087 was a
     * single spike between $1178 neighbors). */
    private pendingVelocityDropPct;
    /** Drawdown pct on the previous sample; drawdown only trips when two
     * consecutive samples both exceed maxDrawdownPct. Same guard as velocity —
     * a single bad equity tick should not halt trading. */
    private pendingDrawdownPct;
    private equityBuffer;
    private lastPersistTime;
    private equitySmoothingBuffer;
    private suspiciousBaseline;
    private consecutiveSuspiciousTicks;
    constructor(db: Database.Database, config?: TradingCircuitBreakerConfig);
    /**
     * Update the current vol regime estimate. No-op when useVolAdaptiveCB=false.
     * Caller is expected to pass a fresh annualized vol estimate (e.g., from
     * realizedVolEwma over recent candles). Drawdown / velocity thresholds
     * are scaled relative to the constructor-time base values.
     */
    updateVolRegime(annualizedVol: number): VolRegime;
    getCurrentVolRegime(): VolRegime;
    getActiveThresholds(): {
        maxDrawdownPct: number;
        velocityDropPct: number;
        regime: VolRegime;
    };
    private applyVolRegime;
    private ensurePrunedArchive;
    private loadFromDb;
    /**
     * Record a completed trade's P&L.
     * Positive pnl = win (resets consecutive-loss streak).
     * Zero or negative pnl = non-win (increments streak; trips breaker if threshold reached).
     *
     * Break-even (pnl = 0) counts as a loss for streak purposes: it consumed
     * capital, paid fees, and produced no edge proof. A "win" must clear costs.
     */
    recordTrade(pnl: number): void;
    /**
     * Record the current account equity.
     * - Updates peak equity and checks absolute drawdown.
     * - Adds to the velocity ring buffer and checks for fast equity drops.
     * - Flushes the ring buffer to equity_snapshots every persistIntervalMs.
     *
     * Should be called approximately every minute by the trading engine.
     */
    recordEquity(equity: number): void;
    /**
     * Returns whether any breaker is tripped and the reasons why.
     * Auto-resets breakers that have exceeded their cooldown period.
     */
    getStatus(): BreakerStatus;
    /** Current drawdown status derived from in-memory peak/last equity. */
    getDrawdownStatus(): {
        tripped: boolean;
        currentDrawdownPct: number;
    };
    /**
     * Peak equity persisted on the drawdown breaker row (may differ slightly from
     * `TradingStore.getPeakEquity()` around resets or missed ticks — see `trade_risk_status.peakEquityReconciliation`).
     */
    getDrawdownPeakEquity(): number;
    /**
     * Monotonically lift the drawdown peak to match `storePeak` when the store's
     * persisted MAX(equity) exceeds the breaker's in-memory peak. Prevents a
     * 2026-04-19 class of bug where the breaker's peak lagged the store's
     * snapshot MAX by ~$0.48, causing drawdown% to be measured against a stale
     * watermark and triggering a spurious halt (see project memory
     * `project_peak_equity_drift.md`).
     *
     * Returns the previous and new peak so callers can log the sync event.
     * `driftWarnUsd` controls the warn threshold; any drift larger than this
     * is logged at WARN so operators can investigate upstream desync causes.
     */
    syncPeakFromStore(storePeak: number, driftWarnUsd?: number): {
        synced: boolean;
        prev: number;
        next: number;
    };
    private reseedVelocityWindow;
    /**
     * Rate-of-change sanity check. Returns true when the current tick should
     * skip drawdown evaluation because it looks like a transient feed glitch
     * (a sudden ≥`suspiciousTickDropPct` drop within `suspiciousTickWindowMs`).
     *
     * Behavior:
     *   - First flagged tick freezes a `suspiciousBaseline` (the prior tick's
     *     equity + ts) and starts a counter.
     *   - While in suspicious mode, subsequent ticks compare against the FROZEN
     *     baseline, not the previous tick — so a drop that "persists" at the
     *     low level (rather than recovering or dropping further) still counts
     *     as suspicious until either (a) it recovers (≤ baseline*(1-tol)) →
     *     glitch confirmed, or (b) the counter hits `suspiciousTickConfirmCount`
     *     → real drawdown, hand off to the standard pendingDD evaluation.
     *   - On recovery or confirmation, suspicious state is cleared.
     *
     * Replays the 2026-05-08 incident: equity 1208 → 1003 in <3min from ticker
     * timeouts (not a real drop) tripped the drawdown CB at 9.33%. With this
     * guard, the bad ticks are skipped until either the feed recovers or the
     * drop is confirmed across multiple ticks.
     */
    private checkSuspiciousDrop;
    /**
     * Median of the last N entries in the smoothing buffer, used as the equity
     * value for drawdown comparison. Falls back to the raw current value when
     * the buffer has < 3 entries (insufficient samples for a meaningful median).
     */
    private computeSmoothedEquity;
    /**
     * Accept the current equity as the new drawdown baseline after operator review.
     * This clears any tripped drawdown breaker and re-seeds the in-memory and
     * persisted peak watermark so the next equity sample is measured from the
     * accepted baseline rather than the old historical high. It also clears any
     * stale velocity window state from the pre-reset drawdown so the next sample
     * is evaluated from the accepted baseline instead of the old high-water mark.
     */
    resetDrawdownBaseline(equity: number): void;
    /**
     * Manually reset a breaker after review.
     * Does not re-enable trading automatically — the engine must also clear its halt flag.
     */
    resetBreaker(type: BreakerType): void;
    /** Return the raw persisted state rows for display / audit. */
    getPersistedStates(): BreakerRow[];
    /**
     * Reset all four breakers in one call. Mirrors resetBreaker() per type so
     * the in-memory flags and DB rows stay in sync. Returns the breaker types
     * that were actually tripped (caller can log/report on the cleared set).
     */
    resetAllBreakers(): BreakerType[];
    /**
     * Auto-reset breakers whose tripped_at timestamp exceeds the cooldown period.
     * Logs a warning when auto-resetting so it's visible in audit logs.
     */
    private autoResetExpiredBreakers;
    private flushEquityBuffer;
    private writeBreaker;
}

/** Source of the order for audit / operator grep. */
type TradingOrderAuditSource = "trade_buy" | "trade_sell" | "trade_dex_swap" | "execution_manager";
/**
 * Grep-friendly id: `grep zord_ ~/.zaraa/data/audit/audit.jsonl`
 * (matches `orderAuditCorrelationId` in tool responses.)
 */
declare function generateTradingOrderCorrelationId(): string;
interface TradingOrderAuditPayload {
    correlationId: string;
    source: TradingOrderAuditSource;
    symbol: string;
    side: string;
    mode: "PAPER" | "LIVE" | "SHADOW";
    orderId?: string;
    positionId?: string;
    qty: number;
    /** Short human summary for audit `result` field */
    resultSummary: string;
}

type AdaptiveOrderType = "MARKET" | "LIMIT";
interface ExecutionBookSnapshot {
    bestBid?: number;
    bestAsk?: number;
    topBidQty?: number;
    topAskQty?: number;
    midPrice?: number;
}
interface ExecutionQualitySample {
    symbol: string;
    side: "BUY" | "SELL";
    requestedOrderType: AdaptiveOrderType;
    actualOrderType: AdaptiveOrderType;
    expectedPrice: number;
    fillPrice: number;
    latencyMs: number;
    partialFill?: boolean;
    limitFallback?: boolean;
    book?: ExecutionBookSnapshot;
    timestamp?: number;
}
interface ExecutionQualityStats {
    symbol: string;
    sampleCount: number;
    avgAdverseSlippageBps: number;
    avgAdverseImpactBps: number;
    avgLatencyMs: number;
    limitFallbackRate: number;
    partialFillRate: number;
    marketSampleCount: number;
    limitSampleCount: number;
    marketAvgAdverseSlippageBps: number;
    marketAvgAdverseImpactBps: number;
    limitAvgAdverseSlippageBps: number;
    sizingMultiplier: number;
}
interface ExecutionSizingAdjustment {
    multiplier: number;
    stats: ExecutionQualityStats;
}
interface AdaptiveOrderTypeDecision {
    orderType: AdaptiveOrderType;
    confidence: number;
    reason: string;
    stats: ExecutionQualityStats;
}
interface ExecutionQualityControllerConfig {
    maxSamplesPerSymbol?: number;
    minSamplesForPenalty?: number;
    minSamplesForRouting?: number;
    slippageElevatedThresholdBps?: number;
    slippageCriticalThresholdBps?: number;
    slippageCooldownMs?: number;
    slippageSampleWindow?: number;
}
declare function deriveBookSnapshot(book: {
    bids?: Array<{
        price: number;
        qty: number;
    }>;
    asks?: Array<{
        price: number;
        qty: number;
    }>;
} | null | undefined): ExecutionBookSnapshot | undefined;
declare function computeAdverseSlippageBps(input: {
    side: "BUY" | "SELL";
    expectedPrice: number;
    fillPrice: number;
}): number;
declare function computeAdverseImpactBps(input: {
    side: "BUY" | "SELL";
    fillPrice: number;
    book?: ExecutionBookSnapshot;
}): number;
interface SlippageBreachStatus {
    breached: boolean;
    severity: "none" | "elevated" | "critical";
    action: "allow" | "limit_only" | "halt";
    cooldownRemainingMs: number;
    avgSlippageBps: number;
}
declare class ExecutionQualityController {
    private readonly config;
    private readonly samplesBySymbol;
    private readonly breachTimestamps;
    constructor(config?: ExecutionQualityControllerConfig);
    recordExecution(sample: ExecutionQualitySample): ExecutionQualityStats;
    getSizingAdjustment(symbol: string): ExecutionSizingAdjustment;
    getAdaptiveOrderType(symbol: string, fallback: AdaptiveOrderType): AdaptiveOrderTypeDecision;
    getSlippageBreachStatus(symbol: string): SlippageBreachStatus;
    getStats(symbol: string): ExecutionQualityStats;
}

/**
 * ShadowModeExecutor — bridge between paper and live trading.
 *
 * Runs live signals through the full pre-trade validation pipeline but
 * intercepts before actual exchange calls. Logs what WOULD have happened,
 * tracks shadow P&L over time, and validates that all pre-trade checks
 * pass exactly as they would in live mode.
 *
 * Use case: prove the system works with real market data before risking
 * real money. Compare shadow P&L against paper results to measure
 * readiness for live deployment.
 */
/**
 * Per-strategy closed-trade stats embedded in a P&L snapshot, keyed by strategy
 * name. Structurally compatible with TradeJournal.PerStrategyStat — kept defined
 * here so this engine stays dependency-free of the journal/DB layer.
 */
/**
 * Canonical cap for the rolling P&L snapshot window — 48 entries ≈ 24h at the
 * 30-min snapshot cadence. Single source of truth shared by the in-memory ring
 * (recordPnlSnapshot) and the trading.db `shadow_pnl_snapshots` settings blob
 * persisted in core (zaraa.ts onPnlSnapshot), so the two never drift.
 */
declare const SHADOW_PNL_SNAPSHOT_CAP = 48;
interface ShadowStrategyStat {
    trades: number;
    pnl: number;
    winRate: number;
    /** Chronic loser flagged for potential disable (>=20 trades, winRate<0.35, pnl<-$1). */
    flagged: boolean;
}
interface ShadowPnlSnapshot {
    ts: number;
    trades: number;
    openPositions: number;
    totalPnl: number;
    unrealizedPnl: number;
    totalEquity: number;
    winRate: number;
    /**
     * Per-strategy breakdown of closed trades, keyed by strategy name. Lets us
     * see which strategies win/lose without querying the journal. Optional —
     * absent when no strategyStatsProvider is wired (and on snapshots recorded
     * before this field existed).
     */
    strategies?: Record<string, ShadowStrategyStat>;
}
interface ShadowTradeParams {
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    price: number;
    strategy: string;
    /**
     * Signal confidence in [0,1] — used to scale position size via
     * confidence tiers (see ShadowModeExecutorOpts.confidenceTiers) and logged
     * in the ENTRY line for diagnostics.
     */
    confidence?: number;
    /**
     * Per-trade trailing-stop distance in percent (e.g. 1.5 = 1.5%).
     * Overrides the executor's defaultTrailingStopPercent for this position.
     * Omit (or set 0) to disable trailing for this trade.
     */
    trailingStopPercent?: number;
}
/**
 * Confidence-based position-sizing tier. Each tier specifies a minimum
 * confidence (inclusive) and the fraction of the requested position size to
 * use when the signal's confidence falls into that tier.
 *
 * Tiers are evaluated highest minConfidence first; the first match wins.
 */
interface ConfidenceSizingTier {
    /** Inclusive lower bound for the tier (0..1) */
    minConfidence: number;
    /** Multiplier applied to position size — clamped to [0,1] */
    sizePct: number;
}
interface ShadowTradeResult {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    entryPrice: number;
    strategy: string;
    estimatedFees: number;
    timestamp: number;
    preTradeChecksPassed: boolean;
    preTradeRejection?: string;
}
interface ShadowPerformance {
    trades: number;
    winRate: number;
    totalPnl: number;
    unrealizedPnl: number;
    totalEquity: number;
    openPositionCount: number;
    avgSlippage: number;
}
/** Aggregated closed-trade stats for one attribution key (strategy or symbol). */
interface ShadowAttributionStat {
    trades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    avgPnl: number;
    winRate: number;
}
/**
 * P&L attribution across closed shadow positions — answers "which
 * strategies/symbols make or lose money" without the journal/DB layer.
 */
interface ShadowAttribution {
    byStrategy: Record<string, ShadowAttributionStat>;
    bySymbol: Record<string, ShadowAttributionStat>;
}
/** Reason a shadow position closed — lines up with strategy_trades.exitReason. */
type ShadowExitReason = "stop_loss" | "take_profit" | "manual" | "time_expiry";
interface ShadowPosition {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    entryPrice: number;
    strategy: string;
    enteredAt: number;
    exitPrice?: number;
    exitedAt?: number;
    pnl?: number;
    exitReason?: ShadowExitReason;
    stopLoss?: number;
    takeProfit?: number;
    /**
     * Trailing-stop distance in percent (e.g. 1.5 = 1.5%). When set and the price
     * moves favorably, `updatePrice` ratchets `stopLoss` tighter — never backward.
     * Undefined or 0 keeps the legacy fixed SL/TP behavior.
     */
    trailingStopPercent?: number;
    /** Signal confidence at entry (0..1) — persisted for later analysis */
    confidence?: number;
    /** Multiplier applied from the confidence tier (0..1) */
    sizingMultiplier?: number;
    /** USD notional after confidence scaling and maxTradeUsd cap */
    notionalUsd?: number;
}
/** Pre-trade check function — mirrors real validation pipeline */
type PreTradeCheckFn = (params: ShadowTradeParams) => {
    passed: boolean;
    reason?: string;
};
interface ShadowModeExecutorOpts {
    /** Fee rate in basis points for cost estimation. Default: 10 */
    feeBps?: number;
    /**
     * Confidence-based sizing tiers. Higher-confidence signals get a larger
     * fraction of the requested position size. Order does not matter — tiers
     * are sorted by minConfidence descending internally and the first match
     * wins. Defaults to DEFAULT_CONFIDENCE_TIERS.
     */
    confidenceTiers?: ConfidenceSizingTier[];
    /**
     * Hard cap on USD notional per shadow trade. The scaled (qty * price)
     * notional is clamped via Math.min so it can NEVER exceed this regardless
     * of confidence. When omitted, no notional cap is enforced (raw qty used).
     */
    maxTradeUsd?: number;
    /** Pre-trade validation function (mirrors live checks) */
    preTradeCheck?: PreTradeCheckFn;
    /** Optional logger for shadow executions */
    onShadowTrade?: (result: ShadowTradeResult) => void;
    /** Called each time a P&L snapshot is recorded (every 30 min) — use to persist to DB */
    onPnlSnapshot?: (snapshot: ShadowPnlSnapshot) => void;
    /**
     * Supplies the per-strategy closed-trade breakdown embedded into each P&L
     * snapshot. Called once per `recordPnlSnapshot()`. Wire to
     * `TradeJournal.getPerStrategyStats()`. Omit to leave snapshots without a
     * per-strategy breakdown. Throwing here is non-fatal — the snapshot is still
     * recorded, just without the `strategies` field.
     */
    strategyStatsProvider?: () => Record<string, ShadowStrategyStat>;
    /**
     * Predicate returning true when `strategy` has been disabled by the operator
     * via config (`trading.disabledStrategies`). When wired, executeShadow
     * REJECTS any entry for a disabled strategy before opening a position. Wire to
     * `StrategyRegistry.isDisabled`. This closes the gap where the shadow entry
     * paths (handler + execution-manager) call executeShadow directly and bypass
     * the SignalEngine's `getActive()` filter — the cause of mean-reversion
     * accumulating 93 shadow trades while listed in `disabledStrategies`. Omit to
     * leave shadow entries unfiltered (backward-compatible). Throwing here is
     * non-fatal — the entry is allowed (FAIL-OPEN), mirroring strategyStatsProvider.
     */
    disabledStrategyProvider?: (strategy: string) => boolean;
    /**
     * Called whenever the open-positions list mutates: open, SL/TP set, close.
     * Use to persist `getOpenPositions()` to durable storage so the list survives
     * daemon restarts and closed positions don't resurrect.
     */
    onOpenPositionsChange?: (openPositions: ShadowPosition[]) => void;
    /**
     * Called once per closed shadow position, with the fully populated
     * ShadowPosition (exitPrice, exitedAt, pnl, exitReason set). Use this to
     * persist exits into strategy_trades so the row's exitedAt + pnl + exitReason
     * fields get filled in — without this hook, shadow exits live only in the
     * in-memory closedPositions array.
     */
    onPositionClose?: (closed: ShadowPosition) => void;
    /** Restore open positions from a previous session (loaded from persistent storage on restart) */
    initialPositions?: ShadowPosition[];
    /**
     * Cumulative baseline (closed trades + realized P&L) from `strategy_trades`
     * captured at construction. Folded into `getShadowPerformance()` so the
     * lifetime totals survive daemon restarts instead of resetting to whatever
     * closes happened since boot. Source: `TradeJournal.getCumulativeStats()`.
     */
    initialCumulative?: {
        trades: number;
        wins?: number;
        totalPnl: number;
    };
    /**
     * Default trailing-stop distance (percent) applied to new shadow positions
     * when `ShadowTradeParams.trailingStopPercent` is not provided. Omit to keep
     * legacy fixed SL/TP behavior. Recommended: 1.5 (tighter than the 2% fixed SL).
     */
    defaultTrailingStopPercent?: number;
    /**
     * Hard cap on concurrent open shadow positions per symbol. When the cap is
     * reached, `executeShadow` rejects the trade with a `perSymbolCap` reason
     * instead of opening another position. Default: 2.
     *
     * Defense-in-depth: the SignalEngine already enforces the per-asset cap
     * upstream, but this executor-level guard prevents the lower-level path
     * (e.g. tests, future callers, missed code paths) from stacking unlimited
     * positions on a single symbol — which is what produced the 97-position
     * pile-up that caused the 48h shadow soak failure.
     */
    maxPositionsPerSymbol?: number;
}
declare class ShadowModeExecutor {
    private positions;
    private closedPositions;
    /** FIFO cap on retained closed positions. Shadow mode runs for months; without
     *  a bound this array grows unbounded (memory leak). Reports cover the most recent N. */
    private static readonly MAX_CLOSED_POSITIONS;
    private feeBps;
    private confidenceTiers;
    private maxTradeUsd?;
    private preTradeCheck?;
    private onShadowTrade?;
    private onPnlSnapshot?;
    private strategyStatsProvider?;
    private disabledStrategyProvider?;
    private onOpenPositionsChange?;
    private onPositionClose?;
    private defaultTrailingStopPercent?;
    private maxPositionsPerSymbol;
    private nextId;
    private slippageRecords;
    /** Rolling in-memory P&L snapshot history (last 48 entries = 24h at 30min intervals) */
    private pnlSnapshots;
    /** Latest known price per symbol — populated by updatePrice for unrealized-P&L marking */
    private lastPrices;
    /** Cumulative baseline captured at construct time (from strategy_trades) — see ShadowModeExecutorOpts.initialCumulative */
    private cumulativeBaseline;
    constructor(opts?: ShadowModeExecutorOpts);
    private notifyOpenPositionsChanged;
    /**
     * True when `strategy` is currently flagged as a chronic loser by the wired
     * `strategyStatsProvider` (the SAME source that feeds P&L snapshots, so the
     * block decision is always consistent with what an operator sees flagged).
     *
     * Returns false when:
     *  - no provider is wired (backward-compatible: nothing to block against), or
     *  - the strategy is absent from the stats map (no closed trades yet), or
     *  - the provider throws (FAIL-OPEN — a transient journal/stats error must
     *    not freeze all shadow entries; mirrors recordPnlSnapshot's handling).
     *
     * Purely reads the advisory `flagged` bit; never mutates flagging logic.
     */
    private isStrategyFlagged;
    /**
     * True when `strategy` has been disabled by the operator via config
     * (`trading.disabledStrategies`), as reported by the wired
     * `disabledStrategyProvider` (backed by `StrategyRegistry.isDisabled`).
     *
     * Ensemble-wrapped names (`ensemble(a+b)`, produced by the SignalEngine)
     * are expanded: the entry is blocked when the full name OR any member
     * strategy is disabled — the disable list holds bare names, and a killed
     * strategy must not re-enter via an ensemble vote on the bypass paths.
     *
     * Returns false when:
     *  - no provider is wired (backward-compatible: nothing to block against), or
     *  - the provider throws (FAIL-OPEN — a transient registry error must not
     *    freeze all shadow entries; mirrors isStrategyFlagged's handling).
     *
     * Purely reads the operator's disable config; never mutates it.
     */
    private isStrategyDisabled;
    /**
     * Resolve the sizing multiplier for a given confidence by walking the
     * (descending-sorted) tier table. Returns 1.0 when no confidence is given,
     * 0 when confidence falls below every tier (caller should skip), and a
     * value in [0,1] otherwise.
     */
    getConfidenceSizeMultiplier(confidence: number | undefined): number;
    /**
     * Record a P&L snapshot — call this every 30 minutes from an external timer.
     * Keeps the last SHADOW_PNL_SNAPSHOT_CAP (48 ≈ 24h) snapshots in memory and
     * calls onPnlSnapshot for DB persistence.
     */
    recordPnlSnapshot(): void;
    /** Get all recorded P&L snapshots */
    getPnlSnapshots(): ShadowPnlSnapshot[];
    /**
     * Execute a shadow trade — runs full validation but never calls the exchange.
     *
     * Returns what WOULD have happened: entry price, position size, estimated fees.
     */
    executeShadow(params: ShadowTradeParams): ShadowTradeResult;
    /**
     * Update shadow positions with current market price.
     * Closes positions when stop-loss or take-profit would have triggered.
     */
    updatePrice(symbol: string, currentPrice: number, slippageBps?: number): void;
    /**
     * Set stop-loss and take-profit for a shadow position.
     */
    setStopAndTarget(positionId: string, stopLoss: number, takeProfit: number): boolean;
    /**
     * Enable, retune, or disable the trailing stop on an open shadow position.
     * Pass 0 or a negative value to disable trailing while keeping any fixed SL/TP.
     */
    setTrailingStop(positionId: string, trailingStopPercent: number): boolean;
    /**
     * Tighten `pos.stopLoss` toward the current price when the trade is in profit
     * against entry. Never moves SL backward (ratchet semantics) — drawdown ticks
     * are no-ops. Idempotent when nothing needs to move.
     */
    private maybeAdjustTrailingStop;
    /**
     * Manually close a shadow position at a given price.
     */
    closeShadowPosition(positionId: string, exitPrice: number): boolean;
    /**
     * Close a shadow position because it exceeded the max-hold time. Distinct
     * from `closeShadowPosition` so the exit reason is recorded as `time_expiry`,
     * letting the strategy grader and journal distinguish stale-exit P&L from
     * stop-driven and manual closes.
     */
    closeShadowPositionByTimeExpiry(positionId: string, exitPrice: number): boolean;
    private closePosition;
    /**
     * Get shadow trading performance metrics.
     */
    getShadowPerformance(): ShadowPerformance;
    /**
     * Mark-to-market unrealized P&L across all open positions using the most
     * recent price observed via updatePrice(). Positions for symbols that have
     * never been priced contribute 0 to unrealized P&L.
     */
    private computeUnrealizedPnl;
    /** Get all open shadow positions */
    getOpenPositions(): ShadowPosition[];
    /** Get all closed shadow positions */
    getClosedPositions(): ShadowPosition[];
    /** Most recent price observed via updatePrice for a symbol, or undefined */
    getLastPrice(symbol: string): number | undefined;
    /**
     * Per-strategy and per-symbol P&L attribution over the closed positions
     * currently retained in memory (bounded by MAX_CLOSED_POSITIONS). Unlike
     * getShadowPerformance(), this does NOT fold in the journal baseline —
     * the baseline is aggregate-only and cannot be attributed per key.
     */
    getShadowAttribution(): ShadowAttribution;
}

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
interface PatternSource {
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
type MarketRegime$1 = "trending_up" | "trending_down" | "ranging" | "neutral";
type VolatilityLevel = "low" | "medium" | "high";
interface DominantPattern {
    type: string;
    confidence: number;
    description: string;
}
interface MarketContext {
    /** Current symbol in strategy form (e.g. "BTC_USDT"). */
    symbol: string;
    /** Inferred regime from patterns at the current UTC hour. */
    regime: MarketRegime$1;
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
interface MarketContextProviderOptions {
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
declare class MarketContextProvider {
    private readonly source;
    private cache;
    private readonly ttlMs;
    private readonly volatileTtlMs;
    private readonly minConfidence;
    private readonly now;
    constructor(source: PatternSource, opts?: MarketContextProviderOptions);
    /**
     * Get inferred market context for the given symbol. Returns null when
     * the source has no patterns for this pair so callers can degrade
     * gracefully (no context is not an error).
     */
    getContext(symbol: string): MarketContext | null;
    /** Drop all cached contexts. Useful for tests. */
    clearCache(): void;
}

/** Signal emitted by a strategy when it detects a trade opportunity */
interface Signal {
    symbol: string;
    direction: "long" | "short";
    confidence: number;
    reason: string;
    entryPrice: number;
    /** Strategy-suggested stop-loss (optional — risk manager may override) */
    stopLoss?: number;
    /** Strategy-suggested take-profit (optional) */
    takeProfit?: number;
    /** If set, enables trailing stop at this % distance from high-water mark */
    trailingStopPct?: number;
    timestamp: number;
}
/** Pre-computed indicator values passed to strategy.evaluate() */
interface IndicatorValues {
    closes: number[];
    highs: number[];
    lows: number[];
    volumes: number[];
    sma: Record<number, number[]>;
    ema: Record<number, number[]>;
    rsi: number[];
    macd: {
        macd: number[];
        signal: number[];
        histogram: number[];
    };
    bollingerBands: {
        upper: number[];
        middle: number[];
        lower: number[];
    };
    atr: number[];
    vwap: number[];
    stochRsi: number[];
    obv: number[];
}
/** Risk parameters for a strategy */
interface StrategyRiskParams {
    stopLossAtrMultiplier: number;
    takeProfitRatio: number;
    riskPerTradePct: number;
    /**
     * Hard ceiling on effective R/R: takeProfit distance ≤ maxRiskRewardRatio × stopLoss distance.
     * Tames high-ATR alts (SOL, XRP) that otherwise produce 8–10x R/R targets unreachable
     * in normal conditions. Default applied by `applyTpCap`: 3.0.
     */
    maxRiskRewardRatio?: number;
    /**
     * Hard ceiling on |takeProfit − entry| / entry, expressed as percent (4 = 4%).
     * Whichever of `maxRiskRewardRatio` or `maxTpPercent` produces the tighter
     * TP wins. Default applied by `applyTpCap`: 4.0.
     */
    maxTpPercent?: number;
}
/** Strategy interface — all strategies implement this */
interface Strategy {
    /** Unique strategy name */
    name: string;
    /** Human-readable description */
    description: string;
    /** Preferred candle timeframe */
    timeframe: string;
    /** Minimum candles needed before strategy can evaluate */
    minCandles: number;
    /** Risk parameters */
    riskParams: StrategyRiskParams;
    /**
     * Evaluate candles and indicators to produce a signal (or null if no opportunity).
     * Called once per candle close.
     *
     * `context` is supplied by the signal engine when a MarketContextProvider
     * is wired up — strategies should treat it as additive (graceful when
     * null/undefined). Use it to skip signals in unfavorable regimes or
     * to adjust confidence when patterns agree with the setup.
     */
    evaluate(candles: Candle[], indicators: IndicatorValues, context?: MarketContext | null): Signal | null;
}

interface SignalRecord {
    id: string;
    strategyName: string;
    symbol: string;
    direction: "long" | "short";
    confidence: number;
    reason: string;
    entryPrice: number;
    qty: number;
    stopLoss: number;
    takeProfit: number;
    status: "generated" | "pending" | "executed" | "rejected" | "failed";
    rejectionReasons: string[] | null;
    createdAt: string;
    /** Market regime at signal time (e.g. "trending_up", "ranging") */
    regime: string | null;
    /** Regime detection confidence (0-1) */
    regimeConfidence: number | null;
    /** Trading session at signal time (e.g. "us", "european") */
    session: string | null;
    /** Session fitness score for the strategy (0-1) */
    sessionFitness: number | null;
}
interface StrategyTradeRecord {
    id: string;
    signalId: string;
    strategyName: string;
    symbol: string;
    direction: "long" | "short";
    entryPrice: number;
    exitPrice: number | null;
    qty: number;
    pnl: number | null;
    rMultiple: number | null;
    exitReason: string | null;
    enteredAt: string;
    exitedAt: string | null;
    /** Market regime at trade entry (carried from signal) */
    regime: string | null;
    /** Trading session at trade entry (carried from signal) */
    session: string | null;
    /** True when this row was produced by the shadow execution path. Excluded
     * from learning-loop aggregates by default — set isShadow=true on lookups
     * if you specifically want shadow rows. */
    isShadow: boolean;
}
/**
 * Per-strategy closed-trade stats keyed by strategyName. Embedded into each
 * shadow P&L snapshot so consumers can see which strategies are winning/losing
 * without re-querying the journal. `flagged` marks a chronic loser that's a
 * candidate for disable (see STRATEGY_FLAG_THRESHOLDS).
 */
interface PerStrategyStat {
    trades: number;
    pnl: number;
    winRate: number;
    /** True when trades >= 20 AND winRate < 0.35 AND cumulative pnl < -$1.00. */
    flagged: boolean;
}
interface ReturnAttributionBucket {
    strategyName: string;
    symbol: string;
    regime: string | null;
    session: string | null;
    tradeCount: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    sharpeRatio: number;
    lastExitedAt: string | null;
}
declare class TradeJournal {
    private db;
    /** Optional callback fired after a trade is closed with the full record. */
    onTradeClose: ((record: StrategyTradeRecord) => void) | null;
    constructor(db: Database.Database);
    recordSignal(input: {
        strategyName: string;
        signal: Signal;
        qty: number;
        stopLoss: number;
        takeProfit: number;
        riskValidation: TradeValidation;
        /** Market regime context at signal time */
        regime?: string;
        regimeConfidence?: number;
        /** Trading session context at signal time */
        session?: string;
        sessionFitness?: number;
    }): SignalRecord;
    updateSignalStatus(id: string, status: SignalRecord["status"]): void;
    /**
     * Fetch the regime + session tags from a persisted signal. Used by the
     * execution path to carry context from signal_log into strategy_trades
     * without needing the caller to round-trip those fields through tool payloads.
     */
    getSignalContext(id: string): {
        regime: string | null;
        session: string | null;
    } | null;
    recordTrade(input: {
        signalId: string;
        strategyName: string;
        symbol: string;
        direction: "long" | "short";
        entryPrice: number;
        qty: number;
        /** Carried from signal — market regime at entry */
        regime?: string;
        /** Carried from signal — trading session at entry */
        session?: string;
        /** Mark row as a shadow trade. Default false — keeps real/paper behavior unchanged. */
        isShadow?: boolean;
    }): StrategyTradeRecord;
    closeTrade(id: string, exitPrice: number, exitReason: string): void;
    getRecentSignals(limit?: number): SignalRecord[];
    getSignalsByStrategy(strategyName: string, limit?: number): SignalRecord[];
    getStrategyTrades(strategyName: string, limit?: number): StrategyTradeRecord[];
    /** Shadow-only counterpart to getStrategyTrades — for diagnostics dashboards. */
    getShadowStrategyTrades(strategyName: string, limit?: number): StrategyTradeRecord[];
    /**
     * Cumulative count + total realized P&L across every closed row in
     * `strategy_trades`. Used as a baseline so consumers (shadow status,
     * snapshot logging) keep the lifetime totals across daemon restarts
     * instead of resetting to whatever closes happened since boot.
     */
    getCumulativeStats(): {
        trades: number;
        wins: number;
        totalPnl: number;
    };
    /**
     * Per-strategy breakdown of closed trades (count, realized P&L, win rate),
     * keyed by strategyName. Computed from `strategy_trades` in a single grouped
     * query so a shadow P&L snapshot can carry the breakdown without each
     * consumer re-querying the journal. Each entry also carries a `flagged` bit
     * (see STRATEGY_FLAG_THRESHOLDS) marking a chronic loser for potential
     * disable — nothing is auto-disabled here, the flag is purely advisory.
     *
     * Mirrors `getCumulativeStats` in NOT filtering on isShadow: the same
     * snapshot's aggregate totals come from that method, so the per-strategy
     * rows must sum to the same population to stay consistent.
     */
    getPerStrategyStats(): Record<string, PerStrategyStat>;
    /**
     * Persist a shadow-trade exit when no matching open `strategy_trades` row
     * exists. Synthesizes a placeholder `signal_log` row (status='executed',
     * reason='shadow_orphan') so the FK on `strategy_trades.signalId` is
     * satisfied, then INSERTs a fully-populated trade row (entry + exit
     * fields, isShadow=1) in a single transaction.
     *
     * Used by the shadow `onPositionClose` callback as a fallback when
     * `closeTradeBySymbol` returns false — without this, time-expiry closes
     * (and any close where the entry didn't land in strategy_trades) silently
     * disappear and the soak shows zero closed shadow trades despite N closes
     * in shadow_pnl_snapshots.
     */
    recordShadowExit(input: {
        symbol: string;
        direction: "long" | "short";
        entryPrice: number;
        exitPrice: number;
        qty: number;
        pnl: number;
        exitReason: string;
        enteredAt: string | number;
        exitedAt: string | number;
        strategyName?: string;
        stopLoss?: number;
        takeProfit?: number;
        confidence?: number;
    }): StrategyTradeRecord;
    /**
     * Close the most recent open strategy_trade for a symbol+direction at the
     * given exit price. Returns true when a row was found and closed; false when
     * there was no matching open trade (silently — many positions are opened
     * outside the strategy framework, e.g. manual `trade_buy` without a signalId).
     *
     * This is the bridge from position close (TP, SL, manual, time-stop,
     * emergency-flatten) into the strategy learning loop: without a populated
     * `strategy_trades.exitedAt + pnl`, StrategyGrader silently grades 0% of
     * outcomes and the regime-weight feedback loop (signal-engine wireTradeCloseFeedback)
     * never fires.
     */
    closeTradeBySymbol(symbol: string, direction: "long" | "short", exitPrice: number, exitReason: string, opts?: {
        isShadow?: boolean;
    }): boolean;
    /**
     * Every open (exitedAt IS NULL) shadow-tagged row in strategy_trades, oldest
     * first. Used by the startup reconciliation pass to compare against the
     * `shadow_open_positions` settings blob and detect phantom-opens (journal
     * has it open but settings doesn't, or vice versa).
     */
    getOpenShadowTrades(): StrategyTradeRecord[];
    /**
     * Every open (exitedAt IS NULL) row in strategy_trades — REGARDLESS of the
     * isShadow flag — that has been open longer than `olderThanMs`, oldest first.
     *
     * This is the isShadow-agnostic counterpart to `getOpenShadowTrades` (which
     * only ever returned isShadow=1 rows). Both the shadow close path
     * (`closeTradeBySymbol({ isShadow: true })`) and the startup reconcile
     * (`getOpenShadowTrades`) filter on isShadow=1, so an isShadow=0 entry whose
     * exit never landed — a shadow signal recorded before the entry-flagging fix,
     * or a real/paper trade whose close path never fired — is invisible to every
     * one of them and stays open forever. This surfaces those orphans for the
     * reconcile pass.
     *
     * The age gate is mandatory: only rows open *implausibly* long (well past any
     * legitimate hold time — shadow positions time-expire in minutes/hours, not
     * days) are returned, so a freshly-opened, still-live position is never
     * mistaken for an orphan. `now` is injectable for deterministic tests.
     */
    getOrphanedOpenTrades(olderThanMs: number, now?: number): StrategyTradeRecord[];
    /**
     * Detect and MARK orphaned open trades (see `getOrphanedOpenTrades`). Each
     * orphan is closed at its OWN entry price — a zero-realized-P&L close so it
     * never pollutes lifetime stats (the performance aggregates exclude the
     * `AUDIT_CLOSE_EXIT_REASONS`) — with exitReason `orphaned` (overridable). The
     * entry data (entryPrice, qty, signalId, enteredAt) is left untouched and the
     * isShadow flag is preserved: nothing is deleted, the row is simply moved out
     * of the "open" set and audit-tagged, mirroring the existing zero-P&L
     * `reconcile_orphan` convention.
     *
     * `protectedPositions` is an optional set of (symbol, direction) pairs known
     * to still be live (e.g. positions just restored at startup, or open exchange
     * positions in live mode). Any orphan matching one is SKIPPED — `closeTrade`
     * only mutates the journal, not the real/paper position, so closing a row that
     * is genuinely still open would desync the journal from reality and discard
     * the eventual realized P&L when that position truly closes.
     *
     * Returns the reconciled records (and a count) so callers can log exactly
     * what was marked. Idempotent: once a row is closed it no longer matches.
     */
    reconcileOrphanedTrades(opts: {
        olderThanMs: number;
        now?: number;
        exitReason?: string;
        protectedPositions?: Array<{
            symbol: string;
            direction: string;
        }>;
    }): {
        reconciled: StrategyTradeRecord[];
        count: number;
    };
    /**
     * Find the most recent open (unclosed) strategy trade for a given symbol and direction.
     * Used by the StopMonitor close path to record exits in the journal.
     * Returns null if no matching open trade is found.
     *
     * Filters by isShadow flag so the real-position close path cannot accidentally
     * grab a shadow row, and the shadow close path cannot grab a real row.
     */
    findOpenTrade(symbol: string, direction: "long" | "short", opts?: {
        isShadow?: boolean;
    }): StrategyTradeRecord | null;
    getStrategyStats(): {
        strategy: string;
        signals: number;
        executed: number;
        rejected: number;
        trades: number;
        totalPnl: number;
        avgRMultiple: number;
    }[];
    getReturnAttribution(strategyName?: string, lookbackDays?: number): ReturnAttributionBucket[];
}

/** Minimal interface for error classification — avoids a hard dep on @zaraa/core */
interface ErrorClassifierLike {
    classify(err: unknown, ctx?: Record<string, unknown>): unknown;
}

interface ExecutionManagerDeps {
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
type ExchangeErrorType = "rate_limit" | "auth" | "network" | "insufficient_funds" | "unknown";
/**
 * Classify an exchange API error to determine retry strategy.
 *
 * - rate_limit: HTTP 429 or known rate-limit error codes -> retry with backoff
 * - auth:       HTTP 401/403 or auth-related errors     -> halt, do not retry
 * - network:    timeout, DNS, connection errors, HTTP 502/503/504 -> retry up to 3x
 * - insufficient_funds: not enough balance               -> halt
 * - unknown:    unrecognized errors                      -> do not retry
 */
declare function classifyExchangeError(error: unknown): ExchangeErrorType;
/**
 * Execute a function with retry logic based on exchange error classification.
 *
 * Retry strategy:
 * - rate_limit: exponential backoff (1s, 2s, 4s)
 * - network:    retry up to maxRetries with linear backoff (500ms)
 * - auth / insufficient_funds / unknown: throw immediately, no retry
 */
declare function withExchangeRetry<T>(fn: () => Promise<T>, opts?: {
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
}): Promise<T>;
type OrderType = "MARKET" | "LIMIT";
interface ExecuteResult {
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
declare class ExecutionManager {
    private deps;
    /**
     * Per-symbol mutexes — serializes concurrent executions for the same symbol
     * while allowing different symbols to execute in parallel.
     * A single global mutex was the main throughput bottleneck: a slow BTC LIMIT
     * order poll cycle (up to 30s) would block all ETH/SOL entries queued behind it.
     */
    private mutexes;
    private pendingCleanups;
    private getMutex;
    private schedulePartialFillCleanup;
    clearPendingCleanups(): void;
    private emitExecutionAudit;
    /** Sleep function — injectable for testing */
    sleepFn: (ms: number) => Promise<void>;
    constructor(deps: ExecutionManagerDeps);
    private enforceAutomatedRiskLock;
    private cancelAllPendingOrders;
    /**
     * Verify exchange API connectivity before allowing live mode.
     *
     * Tests both public (ticker) and private (balances) endpoints.
     * Returns a structured result indicating what works and what doesn't.
     */
    verifyExchangeConnectivity(): Promise<{
        connected: boolean;
        publicApi: boolean;
        privateApi: boolean;
        error?: string;
    }>;
    /**
     * Execute a trade from a signal.
     * Handles paper vs live mode, logs to trade store and journal.
     *
     * All executions are serialized through the internal mutex.
     * When deps.riskManager is set, dollar and percentage limits are validated
     * inside the mutex before the order is placed.
     */
    execute(params: {
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
    }): Promise<ExecuteResult>;
    /** Execution timing metrics for monitoring */
    private executionTimings;
    /** Return recent execution timing stats */
    getExecutionTimings(limit?: number): {
        avg: number;
        p95: number;
        count: number;
        timings: Array<{
            symbol: string;
            durationMs: number;
            success: boolean;
            timestamp: number;
        }>;
    };
    private _execute;
}

declare const ConfigSchema$4: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    exchanges: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    weights: z.ZodDefault<z.ZodObject<{
        health: z.ZodDefault<z.ZodNumber>;
        slippage: z.ZodDefault<z.ZodNumber>;
        fundingRate: z.ZodDefault<z.ZodNumber>;
        fees: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        slippage: number;
        health: number;
        fundingRate: number;
        fees: number;
    }, {
        health?: number | undefined;
        slippage?: number | undefined;
        fundingRate?: number | undefined;
        fees?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    weights: {
        slippage: number;
        health: number;
        fundingRate: number;
        fees: number;
    };
    exchanges: string[];
}, {
    enabled?: boolean | undefined;
    exchanges?: string[] | undefined;
    weights?: {
        health?: number | undefined;
        slippage?: number | undefined;
        fundingRate?: number | undefined;
        fees?: number | undefined;
    } | undefined;
}>;
type ExecutionRouterConfig = z.infer<typeof ConfigSchema$4>;
interface ExchangeScores {
    exchange: string;
    healthScore: number;
    slippageScore: number;
    fundingScore: number;
    feeScore: number;
    totalScore: number;
}
interface RouteDecision {
    exchange: string;
    score: number;
    reasons: string[];
    alternatives: {
        exchange: string;
        score: number;
    }[];
}
interface ExecutionRouterDeps {
    getHealthScore?: (exchange: string) => number;
    getSlippageScore?: (exchange: string, symbol?: string) => number;
    getFundingScore?: (exchange: string, symbol?: string) => number;
    getFeeScore?: (exchange: string) => number;
}
declare class ExecutionRouter {
    private config;
    private deps;
    constructor(config?: Partial<ExecutionRouterConfig>, deps?: ExecutionRouterDeps);
    route(symbol: string, side: "BUY" | "SELL", _sizeUsd: number): RouteDecision;
    getScores(symbol: string): ExchangeScores[];
}

interface ActiveStrategy {
    strategy: Strategy;
    symbols: string[];
    enabled: boolean;
    activatedAt: string;
}
/**
 * Always-off strategies with repeated negative expectancy in paper/shadow
 * journals. Merged with operator `trading.disabledStrategies` so config cannot
 * accidentally re-enable a known fee-bleed sleeve without code change.
 */
declare const PROFIT_HARD_DISABLED_STRATEGIES: readonly string[];
declare function mergeDisabledStrategies(operatorDisabled?: readonly string[]): string[];
declare class StrategyRegistry {
    private strategies;
    private active;
    private disabled;
    /**
     * @param disabledStrategies Names that `activate()` will skip. Strategies
     * remain registered (visible via `list()` and `trade_list_strategies`) but
     * cannot be activated, so the signal engine never sees them. Always merged
     * with {@link PROFIT_HARD_DISABLED_STRATEGIES}.
     */
    constructor(disabledStrategies?: readonly string[]);
    register(strategy: Strategy): void;
    get(name: string): Strategy | undefined;
    list(): Strategy[];
    /** True when the operator has disabled this strategy via config. */
    isDisabled(name: string): boolean;
    /** Snapshot of currently-disabled strategy names. */
    getDisabled(): string[];
    /**
     * Activate a strategy for live/paper signal generation.
     * If the name is in the disabled list, returns a non-enabled
     * `ActiveStrategy` stub WITHOUT adding it to the active map — so
     * `getActive()` / `isActive()` will not surface it, and the signal engine
     * will never run it. The stub lets callers (the deploy tool, init wiring)
     * keep their return-shape contract without throwing.
     */
    activate(name: string, symbols: string[]): ActiveStrategy;
    deactivate(name: string): boolean;
    getActive(): ActiveStrategy[];
    isActive(name: string): boolean;
}

/**
 * Market Regime Detector
 *
 * Classifies current market conditions into one of four regimes:
 *   - trending_up:    Strong directional upward movement
 *   - trending_down:  Strong directional downward movement
 *   - ranging:        Sideways oscillation within bounds
 *   - volatile:       High volatility without clear direction (transition/chaos)
 *
 * The regime determines which strategies should be weighted higher:
 *   - trending_up/down  -> trend-following gets boosted, mean-reversion suppressed
 *   - ranging            -> mean-reversion boosted, trend-following/breakout suppressed
 *   - volatile           -> breakout boosted (compression->expansion), others cautious
 *
 * Detection uses three independent signals that vote:
 *   1. ADX (Average Directional Index) — trend strength
 *   2. Bollinger Band Width — volatility compression/expansion
 *   3. Price-SMA relationship — directional bias
 *
 * This is pure computation — no side effects, no dependencies beyond indicator data.
 */

type MarketRegime = "trending_up" | "trending_down" | "ranging" | "volatile";
interface RegimeAnalysis {
    /** Current detected regime */
    regime: MarketRegime;
    /** Confidence in the classification (0-1) */
    confidence: number;
    /** ADX value (trend strength, >25 = trending) */
    adx: number;
    /** Bollinger bandwidth percentile (0-1, low = squeeze) */
    bandwidthPercentile: number;
    /** Directional bias: positive = bullish, negative = bearish, near zero = neutral */
    directionalBias: number;
    /** ATR as % of price — normalized volatility */
    volatilityPct: number;
    /** Per-strategy weight multipliers based on detected regime */
    strategyWeights: Record<string, number>;
}
/**
 * Compute the Average Directional Index (ADX) from indicator data.
 *
 * ADX measures trend strength regardless of direction:
 *   < 20: weak/no trend (ranging)
 *   20-25: emerging trend
 *   25-50: strong trend
 *   > 50: very strong trend
 *
 * Uses +DI/-DI from highs/lows/closes and smoothed with Wilder's method.
 */
declare function computeADX(highs: number[], lows: number[], closes: number[], period?: number): number[];
/**
 * Detect the current market regime from indicator data.
 *
 * The algorithm works by voting across three independent signals:
 *   1. ADX for trend strength
 *   2. Bollinger bandwidth for volatility state
 *   3. Price position relative to SMA-50 for directional bias
 *
 * Each signal contributes evidence toward a regime classification.
 */
declare function detectRegime(indicators: IndicatorValues): RegimeAnalysis;
/**
 * Apply regime-based weights to an ensemble vote's confidence.
 * This modulates strategy confidence based on whether the current regime
 * favors or disfavors that strategy.
 *
 * Example: In a trending_up regime, a trend-following signal with confidence 0.7
 * gets boosted to 0.7 * 1.5 = 1.05, capped at 0.95.
 * A mean-reversion signal with confidence 0.7 gets reduced to 0.7 * 0.3 = 0.21.
 */
declare function applyRegimeWeight(confidence: number, strategyName: string, analysis: RegimeAnalysis): number;

/**
 * Signal Ensemble — multi-strategy consensus voting for quant swarm Phase 1.
 *
 * Collects signals from multiple strategies for the same symbol,
 * applies weighted voting, and produces a consensus signal only when
 * enough strategies agree on direction.
 *
 * Phase 2: Market regime-aware voting. When a RegimeAnalysis is provided,
 * each strategy's confidence is modulated by how well it suits the current
 * market conditions (e.g., trend-following gets boosted in trending markets).
 */

interface EnsembleConfig {
    /** Minimum number of strategies that must agree on direction (default: 2) */
    minConsensus: number;
    /** Confidence boost when consensus is reached: final = avg + boost * (agreeing/total) (default: 0.1) */
    consensusBoost: number;
    /** Cap on final confidence (default: 0.95) */
    maxConfidence: number;
}
interface EnsembleVote {
    strategyName: string;
    signal: Signal;
}
interface EnsembleResult {
    /** The consensus signal (null if no consensus) */
    signal: Signal | null;
    /** All individual votes that were cast */
    votes: EnsembleVote[];
    /** Strategies that agreed with the winning direction */
    agreeing: string[];
    /** Strategies that disagreed */
    dissenting: string[];
    /** Summary for journal/logging */
    summary: string;
    /** Market regime used for weighting (if provided) */
    regime?: RegimeAnalysis;
}
declare class SignalEnsemble {
    private config;
    constructor(config?: Partial<EnsembleConfig>);
    /**
     * Vote on a set of signals for the same symbol.
     * Returns a consensus signal if enough strategies agree on direction,
     * or null if no consensus is reached.
     *
     * When a RegimeAnalysis is provided, each strategy's vote weight is
     * modulated by how well-suited it is to the current market regime.
     * For example, in a trending market, trend-following votes carry more
     * weight and mean-reversion votes carry less.
     *
     * When a `gradeMultiplier` is provided, each strategy's vote weight is
     * additionally scaled by its allocation multiplier (the quartile grade
     * produced by the strategy-grader: 1.0/0.75/0.5/0.25, or 0 when archived).
     * This closes the outcome→weight loop at runtime — measured-weak strategies
     * lose influence over both consensus direction and the resulting confidence
     * (and therefore downstream sizing). Multipliers only ever scale weight
     * DOWN; a missing/invalid grade is treated as a neutral 1.
     */
    vote(votes: EnsembleVote[], regime?: RegimeAnalysis, gradeMultiplier?: (strategyName: string) => number): EnsembleResult;
    getConfig(): EnsembleConfig;
    updateConfig(updates: Partial<EnsembleConfig>): void;
}

interface BacktestTrade {
    entryTime: number;
    exitTime: number;
    direction: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnl: number;
    rMultiple: number;
    exitReason: "stop-loss" | "take-profit" | "signal-exit" | "end-of-data";
}
interface PerformanceMetrics {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgRMultiple: number;
    expectancy: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    sortinoRatio: number;
    avgHoldingBars: number;
    bestTrade: number;
    worstTrade: number;
}
declare function calculatePerformance(trades: BacktestTrade[], equityCurve: number[]): PerformanceMetrics;

/**
 * How the strategy assumes its orders are filled.
 *  - "maker": post-only / LIMIT entries → maker fee rate (the live path we are
 *    moving limit-entry strategies toward). Default.
 *  - "taker": MARKET orders that cross the book → taker fee rate.
 */
type BacktestFillType = "maker" | "taker";
interface BacktestConfig {
    /** Starting equity in USD */
    startingEquity: number;
    /** Risk per trade as % of equity (overrides strategy default if set) */
    riskPerTradePct?: number;
    /**
     * @deprecated Flat USD commission is no longer the cost model — fees are now
     * maker/taker-aware to match the live path. Retained for back-compat only and
     * ignored by the run path.
     */
    commission?: number;
    /** Slippage as % of price (floored to {@link MIN_SLIPPAGE_BPS} bps). Default: 0.05%. */
    slippagePct?: number;
    /**
     * Simulated bar delay between signal and entry. Floored to
     * {@link MIN_EXECUTION_DELAY_BARS} (1) so entries always fill at a later bar's
     * open — never the signal bar. Default: 1.
     */
    executionDelayBars?: number;
    /**
     * Fill type the strategy assumes — keys the fee rate (maker vs taker) to the
     * SAME schedule the live path uses. Default: "maker" (post-only/limit entry).
     */
    fillType?: BacktestFillType;
    /** Optional venue fee-schedule overrides (defaults to {@link getDefaultFeeSchedules}). */
    feeSchedule?: FeeSchedule[];
}
/**
 * The effective cost configuration actually applied during the run, echoed onto
 * the result so a downstream scorecard can audit backtest↔live parity.
 */
interface BacktestEffectiveConfig extends BacktestConfig {
    /** Maker/taker rate actually charged (fraction of notional, e.g. 0.0004). */
    feeRate: number;
    /** Effective slippage in bps (>= {@link MIN_SLIPPAGE_BPS}). */
    slippageBps: number;
    /** Effective execution delay in bars (>= {@link MIN_EXECUTION_DELAY_BARS}). */
    executionDelayBars: number;
    /** Fill type used to key the fee rate. */
    fillType: BacktestFillType;
}
interface BacktestResult {
    strategy: string;
    symbol: string;
    timeframe: string;
    candlesUsed: number;
    startDate: string;
    endDate: string;
    config: BacktestEffectiveConfig;
    performance: PerformanceMetrics;
    trades: BacktestTrade[];
    equityCurve: number[];
    signals: number;
}
declare class Backtester {
    private config;
    constructor(config?: Partial<BacktestConfig>);
    /**
     * Run a strategy against historical candles and return performance results.
     * Candles must be sorted ascending by openTime.
     */
    run(strategy: Strategy, candles: Candle[]): BacktestResult;
}

/**
 * Statistical edge validation for trading strategies.
 *
 * Three tests determine whether a strategy has genuine edge:
 * 1. Binomial test — is the win rate significantly above 50%?
 * 2. Monte Carlo — does the Sharpe ratio survive random trade-order shuffling?
 * 3. Walk-forward — does performance hold on out-of-sample data?
 */

interface BinomialResult {
    wins: number;
    total: number;
    winRate: number;
    pValue: number;
    zScore: number;
    isSignificant: boolean;
}
interface MonteCarloResult {
    actualSharpe: number;
    actualPnl: number;
    percentile: number;
    monteCarloSharpes: number[];
    isRobust: boolean;
    iterations: number;
}
interface WalkForwardWindow$1 {
    trainMetrics: PerformanceMetrics;
    testMetrics: PerformanceMetrics;
    trainCandles: number;
    testCandles: number;
}
interface WalkForwardResult {
    windows: WalkForwardWindow$1[];
    avgTrainSharpe: number;
    avgTestSharpe: number;
    degradation: number;
    isStable: boolean;
}
interface EdgeValidation {
    binomial: BinomialResult;
    monteCarlo: MonteCarloResult;
    walkForward: WalkForwardResult;
    verdict: "confirmed" | "weak" | "no-edge";
    summary: string;
}
/**
 * Exact binomial test for large n uses normal approximation.
 * H0: p = 0.5 (random coin flip). One-sided test: P(X >= wins).
 */
declare function binomialTest(wins: number, total: number): BinomialResult;
/**
 * Shuffle trade P&L sequence 1000x using Fisher-Yates,
 * recompute Sharpe for each shuffle, report percentile.
 */
declare function monteCarloShuffle(trades: BacktestTrade[], startingEquity: number, iterations?: number): MonteCarloResult;
/**
 * Split candles into N windows, run strategy on train (70%) then test (30%) each.
 */
/**
 * Out-of-sample degradation: how much worse the test (out-of-sample) Sharpe is
 * versus the train (in-sample) Sharpe, as a percentage. Only DOWNWARD deviation
 * counts — an out-of-sample improvement (test >= train) is not degradation and
 * returns 0, so robust strategies that hold up (or improve) on unseen data are
 * not wrongly flagged unstable. A non-positive train Sharpe has no edge baseline
 * to degrade from, so it is treated as maximum degradation.
 */
declare function walkForwardDegradation(avgTrainSharpe: number, avgTestSharpe: number): number;
declare function walkForwardTest(strategy: Strategy, candles: Candle[], config?: Partial<BacktestConfig>, windows?: number): WalkForwardResult;
/**
 * Run all three statistical tests and produce a verdict.
 */
declare function validateEdge(strategy: Strategy, candles: Candle[], config?: Partial<BacktestConfig>): EdgeValidation;

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
type TradingSession = "asian" | "european" | "us" | "off_hours";
interface SessionInfo {
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
/**
 * Get the current trading session information.
 * Accepts an optional Date for testing; defaults to now.
 */
declare function getCurrentSession(now?: Date): SessionInfo;
/**
 * Get the fitness multiplier for a strategy in the current session.
 * Can be used to scale confidence before ensemble voting.
 */
declare function getSessionFitness(strategyName: string, sessionInfo?: SessionInfo): number;
/**
 * Check if now is a good time to trade based on session characteristics.
 * Returns true if we're in a high-quality trading window.
 */
declare function isHighQualityWindow(sessionInfo?: SessionInfo): boolean;

/**
 * Rolling per-symbol performance tracker.
 *
 * Reads closed positions from trading-store and computes a rolling win rate
 * per symbol over the last N trades. Results are cached in the settings
 * table as JSON so external observers (dashboard, audit reports) can read
 * the same view the gate uses.
 *
 * The audit found persistent loser symbols (e.g. ETH at -$0.26 across the
 * window) and persistent winners (SOL at +$1.12). The gate this tracker
 * powers requires unanimous ensemble + confirmed edge to enter on persistent
 * losers, while keeping winners on the default entry path.
 */

interface SymbolStats {
    symbol: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    updatedAt: number;
}
interface SymbolPerformanceTrackerConfig {
    /** Trades counted per symbol in the rolling window. Default: 20. */
    rollingWindow: number;
    /** Win-rate threshold below which strict gating kicks in. Default: 0.4. */
    minWinRate: number;
    /** Minimum trades required before gating applies. Default: 10. */
    minTrades: number;
    /** Restrict to paper trades only (filters by isPaper column). Default: undefined = both. */
    isPaper?: boolean;
}
declare class SymbolPerformanceTracker {
    private readonly store;
    private readonly config;
    private cache;
    constructor(store: TradingStore, config?: SymbolPerformanceTrackerConfig);
    getConfig(): SymbolPerformanceTrackerConfig;
    /** Compute (or return cached) rolling stats for a symbol. */
    getStats(symbol: string, now?: number): SymbolStats;
    /**
     * Returns true when the symbol's rolling win rate is below the threshold
     * AND we have at least `minTrades` data points. Below `minTrades` the
     * gate yields (no data → don't penalize).
     */
    requiresStrictGating(symbol: string, now?: number): boolean;
    /** Force a re-read on next getStats() call. */
    invalidate(symbol?: string): void;
    /**
     * Render the current cache snapshot. Used by tests and dashboards.
     */
    snapshot(): Record<string, SymbolStats>;
    private computeStats;
    private queryRecent;
    private persistCache;
}

/**
 * LeaderboardStore — tracks per-strategy performance over time.
 *
 * Uses the same SQLite database as TradeJournal so all strategy_trades data
 * is available without a separate file. It adds one new table:
 *   strategy_performance_snapshots — one row per strategy per calendar day
 *
 * Key concepts for beginners:
 *   - "Sharpe ratio" measures return vs. risk. Higher = better risk-adjusted gains.
 *   - "Max drawdown" is the biggest loss from a peak in cumulative P&L.
 *   - "Win rate" is the % of closed trades that ended with a positive P&L.
 */

/** How far back to look when computing metrics. */
type LeaderboardPeriod = "7d" | "30d" | "90d" | "all";
/** Performance metrics for a single strategy in a given period. */
interface StrategyMetrics {
    /** 1-based position in the ranked table (best to worst by total P&L). */
    rank: number;
    /** Strategy name, e.g. "trend-following". */
    strategyName: string;
    /** Number of fully closed trades in the period. */
    numTrades: number;
    /** Fraction of trades that made money (0–1, e.g. 0.6 = 60%). */
    winRate: number;
    /** Sum of all trade P&Ls in the period (USD). */
    totalPnl: number;
    /** Average P&L per trade (USD). */
    avgReturn: number;
    /** Maximum peak-to-trough decline in cumulative P&L (USD, negative or 0). */
    maxDrawdown: number;
    /** Risk-adjusted return — annualised Sharpe ratio (higher is better). */
    sharpeRatio: number;
    /**
     * Daily P&L series for the sparkline chart.
     * Always covers the last 30 calendar days, using 0 for days with no trades.
     */
    pnlHistory: number[];
}
/** A single recent closing loss — feeds the autonomy loop's lesson generator. */
interface RecentClosedLoss {
    symbol: string;
    strategy: string;
    /** Realised P&L in USD (always < 0 for these rows). */
    pnl: number;
}
/** Per-symbol rolling performance — feeds the lesson generator. winRate is 0–1. */
interface SymbolPerformance {
    symbol: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
}
/** A daily snapshot saved to the database for historical trend analysis. */
interface DailySnapshot {
    id: string;
    strategyName: string;
    /** ISO date string YYYY-MM-DD. */
    date: string;
    numTrades: number;
    winRate: number;
    totalPnl: number;
    avgReturn: number;
    maxDrawdown: number;
    sharpeRatio: number;
    createdAt: string;
}
declare class LeaderboardStore {
    private db;
    /**
     * When true, shadow trades (isShadow=1) are included in leaderboard/snapshot
     * queries. Set via `setIncludeShadow()` when the runtime is in paperMode —
     * paper trades are tagged isShadow=1 by ShadowModeExecutor, and excluding
     * them leaves the leaderboard empty for the entire paper book. The behaviour
     * is opt-in so live mode (real capital) keeps the strict exclusion that
     * prevents shadow simulations from polluting real performance metrics.
     */
    private includeShadow;
    /**
     * @param db - The same better-sqlite3 Database instance used by TradeJournal.
     *             Sharing the instance avoids locking conflicts and keeps all
     *             trading data in one file (trade-journal.db).
     */
    constructor(db: Database.Database);
    /** Expose the underlying DB so adjacent stores (e.g. StrategyRanker) can
     * read from the same trade-journal file without re-opening it. */
    getDb(): Database.Database;
    /** When `on` is true, shadow trades are included in leaderboard/snapshot
     * queries — required when paperMode is true (paper trades are shadow). */
    setIncludeShadow(on: boolean): void;
    private shadowFilter;
    private initTables;
    /**
     * Compute and return the leaderboard for all strategies in the given period.
     * Strategies are ranked by total P&L (highest first).
     *
     * @param period - Time window to include. "all" uses all historical trades.
     */
    getLeaderboard(period?: LeaderboardPeriod): StrategyMetrics[];
    /**
     * Take a performance snapshot for ALL known strategies as of today.
     * Call this after any trade closes. Uses UPSERT so calling it multiple
     * times in the same day just overwrites the existing row.
     */
    snapshotToday(): void;
    /**
     * Retrieve stored daily snapshots for one strategy (for history charting).
     * Returns at most `days` rows, most-recent last.
     */
    getSnapshots(strategyName: string, days?: number): DailySnapshot[];
    /**
     * Recent closed losing trades (pnl < 0), most-recent-first, for the autonomy
     * loop's trading-loss lesson generator. Each row carries the (strategy, symbol)
     * pairing the lesson analyzer groups on to detect recurring mistakes.
     *
     * Shadow-aware via `shadowFilter()`: in paperMode every paper trade is tagged
     * isShadow=1, so excluding shadow would hide the entire paper book from the
     * learning loop. Live mode keeps the strict isShadow=0 exclusion.
     */
    getRecentClosedLosses(limit?: number): RecentClosedLoss[];
    /**
     * Per-symbol rolling performance over `period`, for the trading-loss lesson
     * generator's persistent-losing-symbol signal. winRate is 0–1.
     *
     * Shadow-aware (see getRecentClosedLosses) — sources the same strategy_trades
     * universe as getLeaderboard() so per-symbol and per-strategy views agree.
     */
    getSymbolPerformance(period?: LeaderboardPeriod): SymbolPerformance[];
    /** Fetch per-strategy aggregate stats for closed trades since `since`. */
    private getAggregates;
    /** Fetch individual closed trades for a strategy (for Sharpe & drawdown). */
    private getClosedTrades;
    /**
     * Build a daily P&L array for sparkline charts covering the last `days` days.
     * Missing days (no trades) are represented as 0.
     */
    private getDailyPnlHistory;
}

/**
 * StrategyAdaptor — Phase 2 Quant Swarm: Adaptive strategy weighting.
 *
 * Closes the feedback loop between trade outcomes and future signal confidence.
 * After each trade closes, the adaptor queries the leaderboard for recent
 * performance and computes per-strategy weight multipliers that modulate
 * signal confidence in the next evaluation cycle.
 *
 * Strategies that consistently profit get boosted. Strategies that consistently
 * lose get suppressed. The adaptation is gradual (EMA-smoothed) to avoid
 * whipsawing on a single bad trade.
 *
 * Design choices:
 * - Multipliers range [0.3, 1.5] — never fully disables a strategy (keeps
 *   exploration alive), never boosts more than 50% (prevents overconfidence).
 * - Uses EMA with alpha=0.3 — reacts to recent trades without forgetting history.
 * - Requires minimum 5 closed trades before adjusting (avoids noise from small samples).
 * - Integrates with existing SignalEngine via getStrategyWeight() lookup.
 */

interface StrategyAdaptorConfig {
    /** Minimum closed trades before adapting a strategy's weight (default: 5) */
    minTrades: number;
    /** EMA smoothing factor for weight updates (default: 0.3, higher = more reactive) */
    alpha: number;
    /** Minimum weight multiplier — never fully suppress (default: 0.3) */
    minWeight: number;
    /** Maximum weight multiplier — never over-boost (default: 1.5) */
    maxWeight: number;
    /** Lookback period for performance evaluation (default: "30d") */
    period: "7d" | "30d" | "90d" | "all";
    /** Sharpe ratio threshold below which a strategy is penalized (default: 0) */
    sharpePenaltyThreshold: number;
    /** Max drawdown (as negative number) beyond which strategy is penalized (default: -50) */
    drawdownPenaltyThreshold: number;
}
interface StrategyWeight {
    strategyName: string;
    weight: number;
    reason: string;
    metrics: {
        winRate: number;
        totalPnl: number;
        sharpeRatio: number;
        maxDrawdown: number;
        numTrades: number;
    };
}
declare class StrategyAdaptor {
    private config;
    private leaderboard;
    /** EMA-smoothed weights per strategy (persisted across update cycles) */
    private weights;
    /** Last computed weight details (for dashboard/debugging) */
    private lastWeights;
    /** Per-strategy trade counts for updateFromTrade's minTrades gate */
    private tradeCounts;
    private db;
    private regimeWeights;
    constructor(leaderboard: LeaderboardStore, config?: Partial<StrategyAdaptorConfig>, db?: Database.Database);
    /**
     * Recompute strategy weights from leaderboard data.
     * Call this after each trade closes (or periodically on a timer).
     */
    update(): StrategyWeight[];
    /**
     * Get the current adaptive weight for a strategy.
     * Returns 1.0 if the strategy hasn't been evaluated yet.
     */
    getStrategyWeight(strategyName: string): number;
    /**
     * Get all current weights (for dashboard display).
     */
    getAllWeights(): StrategyWeight[];
    /**
     * Directly set a strategy's weight (bypasses EMA smoothing).
     * Used by PerformanceReviewer to suppress F-grade strategies immediately.
     * The weight is clamped to [minWeight, maxWeight].
     */
    setStrategyWeight(strategyName: string, weight: number, reason?: string): void;
    /**
     * Compute raw weight from strategy metrics.
     *
     * The weight is a composite of:
     * - Win rate contribution (0-1): higher win rate → higher weight
     * - Sharpe ratio contribution: positive Sharpe → boost, negative → penalty
     * - Drawdown penalty: deep drawdowns reduce weight
     * - Profit factor: profitable strategies get a bonus
     */
    private computeRawWeight;
    private explainWeight;
    /**
     * Update weights incrementally after a single trade closes.
     * More responsive than full update() — uses the same EMA logic
     * but only processes the delta from one trade.
     *
     * Skips if the strategy has fewer than minTrades total (tracked internally).
     */
    updateFromTrade(strategyName: string, pnl: number, isWin: boolean): void;
    /** Get the internal trade count for a strategy (used by tests and diagnostics). */
    getTradeCount(strategyName: string): number;
    getConfig(): StrategyAdaptorConfig;
    updateConfig(updates: Partial<StrategyAdaptorConfig>): void;
    getRegimeWeight(strategyName: string, regime: string): number;
    updateRegimeWeight(strategyName: string, regime: string, data: {
        weight: number;
        tradeCount: number;
        winRate: number;
        avgPnl: number;
    }): void;
    getAllRegimeWeights(): Array<{
        strategyName: string;
        regime: string;
        weight: number;
        tradeCount: number;
        winRate: number;
        avgPnl: number;
    }>;
    private loadRegimeWeights;
}

interface StrategyRankingRow {
    id: string;
    strategyName: string;
    computedAt: string;
    windowStartMs: number;
    windowEndMs: number;
    tradeCount: number;
    winRate: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    totalPnl: number;
    rank: number;
    signalWeightMultiplier: number;
}
interface StrategyRankerOptions {
    /**
     * Database that holds the `strategy_trades` source rows. In production
     * this is trade-journal.db (TradeJournal/LeaderboardStore file). When
     * omitted the ranker falls back to `store.getDb()` so the in-memory unit
     * tests keep working — they insert trades into the same DB they read from.
     */
    readDb?: Database.Database;
    /**
     * When true, shadow trades (isShadow=1) are included. Set this when the
     * runtime is in paperMode — ShadowModeExecutor tags every paper trade as
     * shadow, so excluding them leaves the ranker blind to the entire paper
     * book. Live mode keeps the strict exclusion.
     */
    includeShadow?: boolean;
}
declare class StrategyRanker {
    private store;
    private readDb;
    private includeShadow;
    constructor(store: TradingStore, options?: StrategyRankerOptions);
    /** DB used for reading `strategy_trades` (the journal). Defaults to the
     *  store DB so unit tests that seed via `store.getDb()` keep working. */
    private getReadDb;
    /** DB used for writing `strategy_rankings` (lives in trading.db). */
    private getWriteDb;
    updateRankings(): StrategyRankingRow[];
    getRankings(): StrategyRankingRow[];
    getRecommendedWeights(): Record<string, number>;
}

interface DynamicRiskAdjustment {
    riskMultiplier: number;
    stopLossMultiplier: number;
    paused: boolean;
    reason: string;
}
declare class DynamicRiskAdjuster {
    private store;
    constructor(store: TradingStore);
    refresh(): DynamicRiskAdjustment;
    getAdjustment(): DynamicRiskAdjustment;
    /** Normal baseline when no trade history exists */
    private baseAdjustment;
    /** Fail-safe: when DB is unavailable, reduce risk rather than using full 1.0x exposure */
    private failSafeAdjustment;
    private persistState;
    private log;
}

/**
 * Multi-Timeframe Signal Confirmation Layer
 *
 * Checks a signal's direction against a higher timeframe trend before execution.
 * A 15m buy signal confirmed by a 4h uptrend is far more reliable than one
 * fighting the higher timeframe trend. This dramatically reduces false signals.
 *
 * Timeframe ladder: 5m→1h, 15m→4h, 1h→1d, 4h→1w
 * Uses EMA crossover (fast 12 / slow 26) on the higher timeframe to determine trend.
 */

interface TimeframeConfirmerConfig {
    /** Enable multi-timeframe confirmation (default: false) */
    enabled: boolean;
    /** Fast EMA period for higher TF trend (default: 12) */
    fastPeriod: number;
    /** Slow EMA period for higher TF trend (default: 26) */
    slowPeriod: number;
}

type SentimentZone = "EXTREME_FEAR" | "FEAR" | "NEUTRAL" | "GREED" | "EXTREME_GREED";
interface SentimentReading {
    value: number;
    zone: SentimentZone;
    classification: string;
    timestamp: string;
    fetchedAt: string;
}
interface SentimentSignalResult {
    allowed: boolean;
    reason: string;
    sentiment: SentimentReading | null;
}

declare const ConfigSchema$3: z.ZodObject<{
    alertThresholdPctPer8h: z.ZodDefault<z.ZodNumber>;
    arbitrageMinDiffPct: z.ZodDefault<z.ZodNumber>;
    maxHistory: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    alertThresholdPctPer8h: number;
    arbitrageMinDiffPct: number;
    maxHistory: number;
}, {
    alertThresholdPctPer8h?: number | undefined;
    arbitrageMinDiffPct?: number | undefined;
    maxHistory?: number | undefined;
}>;
type FundingRateConfig = z.infer<typeof ConfigSchema$3>;
interface FundingRateEntry {
    symbol: string;
    exchange: string;
    rate: number;
    timestampMs: number;
    annualizedPct: number;
}
interface FundingRateStats {
    symbol: string;
    exchange: string;
    currentRate: number;
    avg8h: number;
    avg24h: number;
    annualizedPct: number;
    entryCount: number;
    isHighFunding: boolean;
}
interface FundingArbitrage {
    symbol: string;
    longExchange: string;
    shortExchange: string;
    diffPct: number;
    annualizedDiffPct: number;
}
declare class FundingRateMonitor {
    private entries;
    private config;
    private onAlert?;
    constructor(config?: Partial<FundingRateConfig>, onAlert?: (stats: FundingRateStats) => void);
    /** Record a funding rate observation */
    analyzeFundingRate(symbol: string, exchange: string, rate: number, timestampMs?: number): FundingRateEntry;
    /** Get stats for a specific symbol/exchange pair */
    getStats(symbol: string, exchange: string): FundingRateStats | null;
    /** Find arbitrage opportunities across exchanges */
    getArbitrageOpportunities(): FundingArbitrage[];
    getEntryCount(): number;
}

interface SignalEngineConfig {
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
    sessionGates: Record<TradingSession, {
        minConfidence?: number;
        enabled?: boolean;
    }>;
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
interface SignalEngineDeps {
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
            pair: string;
            type: string;
            confidence: number;
            hourOfDay: number | null;
            details: Record<string, unknown>;
            description: string;
            occurrences: number;
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
    sentimentSignal?: {
        checkLongEntry: () => Promise<SentimentSignalResult>;
    };
    /** Funding rate monitor — adjusts confidence based on funding rate conditions. */
    fundingRateMonitor?: {
        analyzeFundingRate: (symbol: string, exchange: string, rate: number, timestampMs?: number) => FundingRateEntry;
        getStats: (symbol: string, exchange: string) => {
            annualizedPct: number;
        } | null;
    };
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
interface SignalRejection {
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
declare class SignalEngine {
    private config;
    private deps;
    private lastSignalTime;
    /** Symbols currently being evaluated — prevents race conditions */
    private evaluating;
    private ensemble;
    /** Last ensemble results — for dashboard/debugging */
    private lastEnsembleResults;
    /** Last regime analysis per symbol — for dashboard/debugging */
    private lastRegimeAnalysis;
    /** Last session info — for dashboard/debugging */
    private lastSessionInfo;
    /** Optional adaptive strategy weighting from Phase 2 swarm feedback loop */
    private strategyAdaptor;
    /** Diagnostics from the last scan — why each strategy/symbol produced nothing */
    private lastScanDiagnostics;
    /**
     * Rolling buffer of recent rejections across all scans. Capped at
     * MAX_RECENT_REJECTIONS so it never grows unbounded. Surfaced via
     * `getRecentRejections()` and `trade_risk_status.recentRejections[]`.
     * Persisted across scans (unlike lastScanDiagnostics, which resets per scan).
     */
    private recentRejections;
    private static readonly MAX_RECENT_REJECTIONS;
    /** Edge validation cache: strategyName → { result, timestamp }. Revalidated every hour. */
    private edgeCache;
    /** Rolling walk-forward validation cache keyed by strategy+symbol. */
    private validationCache;
    /** Targeted retraining hints from walk-forward validation. */
    private retrainingTargets;
    /** Realized 30d return attribution from closed trades. */
    private attributionCache;
    private static readonly EDGE_CACHE_TTL_MS;
    private static readonly VALIDATION_CACHE_TTL_MS;
    private static readonly ATTRIBUTION_CACHE_TTL_MS;
    private marketContextProvider;
    /** Rolling per-symbol performance tracker — drives the symbol gate. */
    private symbolPerf;
    /**
     * Request-scoped memoizer: caches candleStore.getAscending + computeIndicators
     * results keyed by (symbol|timeframe|limit) within a single scan cycle.
     * Cleared at the start of each scanEnsemble so stale candles never persist
     * across scan cycles. Eliminates N+1 identical reads/computes when multiple
     * strategies share the same (symbol, timeframe) in ensemble mode.
     */
    private scanCache;
    /**
     * Per-scan memo of getStrategyGradeMultiplier(...) keyed by strategyName ONLY.
     * The underlying grader query ignores the symbol arg (it reads the AGG_SYMBOL
     * lifecycle rollup) and strategy_lifecycle is never written during a scan, so
     * the result is invariant per strategy within a single scan cycle. Cleared at
     * the top of scan() so both the ensemble and single-strategy paths start fresh.
     * Dedupes the repeated indexed SELECT for the winning strategy (vote callback
     * + sizing) and across symbols that share strategies in the same scan.
     */
    private gradeMemo;
    constructor(deps: SignalEngineDeps, config?: Partial<SignalEngineConfig>);
    /**
     * Resolve market context for a symbol. Returns null when no provider is
     * wired or the source has no patterns for this pair — strategies must
     * treat absence of context as "no opinion" and run their full default logic.
     */
    private getMarketContext;
    /** Exposed for diagnostics and tests. */
    getSymbolPerformanceTracker(): SymbolPerformanceTracker;
    /**
     * Effective cooldown in ms — base cooldown, multiplied for shadow mode so
     * shadow accumulation doesn't outpace the 2-min scan interval.
     */
    private effectiveCooldownMs;
    /** Attach a StrategyAdaptor for Phase 2 adaptive weighting. Call after construction. */
    setStrategyAdaptor(adaptor: StrategyAdaptor): void;
    /**
     * Wire the real-time feedback loop: when a trade closes, update the
     * strategy's global weight and per-regime weight immediately.
     */
    wireTradeCloseFeedback(journal: TradeJournal, adaptor: StrategyAdaptor): void;
    /**
     * Per-scan memoized strategy grade multiplier. getStrategyGradeMultiplier
     * ignores the symbol arg (reads the AGG_SYMBOL rollup), so we key on
     * strategyName only. Returns identical values to the direct call within a
     * scan; the memo is reset at the top of scan().
     */
    private gradeMultiplierMemo;
    private strategyGradeScale;
    /** Get the strategy adaptor (for dashboard/debugging). */
    getStrategyAdaptor(): StrategyAdaptor | null;
    /**
     * Tally open positions (real + shadow) by direction, both globally and
     * per-symbol. Used by the correlation guard to catch one-sided portfolios.
     * Real positions use side: "long"|"short"; shadow positions use "BUY"|"SELL".
     * Both are normalized to BUY/SELL here so callers don't have to.
     */
    private tallyPositionsByDirection;
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
    private checkCorrelationGuard;
    /**
     * Scan all active strategies against current market data.
     * Called on each scheduler tick.
     *
     * When ensemble mode is enabled, all strategies evaluate each symbol
     * independently, then signals are aggregated via consensus voting.
     * Only consensus signals proceed to risk validation and execution.
     */
    scan(): Promise<SignalRecord[]>;
    /**
     * Print a one-line summary of the scan outcome to the daemon log so
     * operators can see why no signals were generated without having to hit
     * the API for diagnostics. The previous flow stored rejection reasons in
     * `lastScanDiagnostics` but never logged them — silent zero-signal scans
     * looked indistinguishable from "all good" in `~/.zaraa/logs/daemon.log`,
     * which masked a 44-hour signal halt observed on 2026-05-15→17.
     */
    private logScanSummary;
    /**
     * Ensemble scan: collect signals from all strategies per symbol,
     * then vote and only execute consensus signals.
     */
    private scanEnsemble;
    /**
     * Evaluate a strategy on a symbol and return just the raw Signal (no execution, no journaling).
     * Used by ensemble mode to collect votes before consensus.
     */
    private evaluateSignalOnly;
    /**
     * Execute a consensus signal through risk validation and trade execution.
     */
    private executeConsensusSignal;
    /**
     * Mandatory 180d / 30d walk-forward validation before a signal can route
     * into execution. Any failure emits REJECT_INVALID_ALPHA and increments
     * the strategy suppression counter.
     */
    private mandatoryBacktest;
    private rejectInvalidAlpha;
    private incrementStrategySuppressionCounter;
    private suspendDeployment;
    private getCachedReturnAttribution;
    private applyRetrainingFeedback;
    /** Get cached edge validation results for all strategies (for dashboard) */
    getEdgeValidations(): Map<string, EdgeValidation>;
    /** Get last ensemble voting results (for dashboard/debugging) */
    getEnsembleResults(): Map<string, EnsembleResult>;
    /** Get last regime analysis per symbol (for dashboard/debugging) */
    getRegimeAnalysis(): Map<string, RegimeAnalysis>;
    /** Get last session info (for dashboard/debugging) */
    getSessionInfo(): SessionInfo | null;
    /** Get diagnostics from the last scan (why each strategy/symbol produced nothing) */
    getScanDiagnostics(): Array<{
        strategy: string;
        symbol: string;
        reason: string;
    }>;
    /**
     * Get rejection events across recent scans (newest last). Used by
     * `trade_risk_status.recentRejections[]` so the operator can see
     * structured "why" data (gate + reason + symbol + ts) without log diving.
     */
    getRecentRejections(limit?: number): SignalRejection[];
    /** Clear the recent-rejections buffer. Test-only convenience. */
    clearRecentRejections(): void;
    /**
     * Internal helper: record a rejection event to both the per-scan diagnostic
     * stream AND the persistent ring buffer, then notify the `onSignal` callback
     * if a Signal has already been generated.
     *
     * Use this anywhere the engine drops a signal before execution. Centralising
     * the bookkeeping is what closes the "why didn't trade X enter" loop.
     */
    private recordRejection;
    private evaluateSymbol;
    private _doEvaluateSymbol;
    getConfig(): SignalEngineConfig;
    updateConfig(updates: Partial<SignalEngineConfig>): void;
    clearCooldowns(): void;
}

declare const ConfigSchema$2: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    minTrades: z.ZodDefault<z.ZodNumber>;
    topN: z.ZodDefault<z.ZodNumber>;
    performanceMetric: z.ZodDefault<z.ZodEnum<["sharpe", "winRate", "totalPnl", "profitFactor"]>>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    minTrades: number;
    topN: number;
    performanceMetric: "sharpe" | "winRate" | "totalPnl" | "profitFactor";
}, {
    enabled?: boolean | undefined;
    minTrades?: number | undefined;
    topN?: number | undefined;
    performanceMetric?: "sharpe" | "winRate" | "totalPnl" | "profitFactor" | undefined;
}>;
type StrategyRotatorConfig = z.infer<typeof ConfigSchema$2>;
interface StrategyStats {
    name: string;
    trades: number;
    pnl: number;
    winRate: number;
    sharpe: number;
    profitFactor: number;
}
interface StrategyAllocation {
    strategyName: string;
    allocationPct: number;
    rank: number;
    score: number;
    tradeCount: number;
}
interface RotationResult {
    timestamp: string;
    active: StrategyAllocation[];
    deactivated: string[];
    reason: string;
}
declare class StrategyRotator {
    private config;
    private lastRotation;
    private activeStrategies;
    constructor(config?: Partial<StrategyRotatorConfig>);
    evaluate(strategies: StrategyStats[]): RotationResult;
    getActiveStrategies(): StrategyAllocation[];
    getLastRotation(): RotationResult | null;
    isActive(strategyName: string): boolean;
    private getScore;
}

declare const ConfigSchema$1: z.ZodObject<{
    latencyDegradedMs: z.ZodDefault<z.ZodNumber>;
    latencyUnhealthyMs: z.ZodDefault<z.ZodNumber>;
    errorRateDegradedPct: z.ZodDefault<z.ZodNumber>;
    errorRateUnhealthyPct: z.ZodDefault<z.ZodNumber>;
    windowMs: z.ZodDefault<z.ZodNumber>;
    positionSizeReductionPct: z.ZodDefault<z.ZodNumber>;
    stopWidenMultiplier: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    latencyDegradedMs: number;
    latencyUnhealthyMs: number;
    errorRateDegradedPct: number;
    errorRateUnhealthyPct: number;
    windowMs: number;
    positionSizeReductionPct: number;
    stopWidenMultiplier: number;
}, {
    latencyDegradedMs?: number | undefined;
    latencyUnhealthyMs?: number | undefined;
    errorRateDegradedPct?: number | undefined;
    errorRateUnhealthyPct?: number | undefined;
    windowMs?: number | undefined;
    positionSizeReductionPct?: number | undefined;
    stopWidenMultiplier?: number | undefined;
}>;
type ExchangeHealthConfig = z.infer<typeof ConfigSchema$1>;
type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY";
interface ExchangeHealth {
    exchange: string;
    status: HealthStatus;
    avgLatencyMs: number;
    errorRatePct: number;
    rateLimitRemaining: number | null;
    callCount: number;
    lastChecked: string;
    adjustments: {
        positionSizeMultiplier: number;
        stopLossMultiplier: number;
        tradingPaused: boolean;
    };
}
declare class ExchangeHealthMonitor {
    private calls;
    private config;
    private onStatusChange?;
    constructor(config?: Partial<ExchangeHealthConfig>, onStatusChange?: (exchange: string, health: ExchangeHealth) => void);
    recordCall(exchange: string, latencyMs: number, success: boolean, rateLimitRemaining?: number): void;
    getHealth(exchange: string): ExchangeHealth;
    getAllHealth(): ExchangeHealth[];
    private getRecentRecords;
    private computeStatus;
    private getAdjustments;
}

/**
 * PriceFreshnessGuard — prevents stop-monitor decisions based on stale prices.
 *
 * Wraps a price-lookup function and enforces a configurable max-age.
 * In conservative mode (default) stale prices block the stop check.
 * In permissive mode the stale price is returned but flagged.
 */
interface PriceResult {
    price: number;
    timestamp: number;
}
interface FreshnessCheckResult {
    price: number;
    timestamp: number;
    stale: boolean;
    ageMs: number;
}
type FreshnessMode = "conservative" | "permissive";
interface StalenessStats {
    totalChecks: number;
    staleChecks: number;
    lastStaleAt: number | null;
}
interface PriceFreshnessGuardOpts {
    /** Maximum acceptable age in milliseconds (default: 60_000) */
    maxAgeMs?: number;
    /** conservative = block stale prices, permissive = allow with flag */
    mode?: FreshnessMode;
    /** Optional logger — receives warnings on stale prices */
    onStale?: (symbol: string, ageMs: number, mode: FreshnessMode) => void;
}
declare class PriceFreshnessGuard {
    private maxAgeMs;
    private mode;
    private onStale?;
    private stats;
    constructor(opts?: PriceFreshnessGuardOpts);
    /**
     * Check a price result for freshness.
     *
     * @param symbol  Trading pair, e.g. "BTC_USDT"
     * @param result  Price data with timestamp
     * @param now     Current time (injectable for tests)
     * @returns       FreshnessCheckResult in permissive mode
     * @throws        StalePriceError in conservative mode when stale
     */
    check(symbol: string, result: PriceResult, now?: number): FreshnessCheckResult;
    /** Get staleness statistics for a specific symbol */
    getStats(symbol: string): StalenessStats | undefined;
    /** Get staleness statistics for all tracked symbols */
    getAllStats(): Map<string, StalenessStats>;
}

/**
 * Minimal surface of ShadowModeExecutor that StopMonitor needs.
 * Defined as an interface to keep StopMonitor decoupled from the executor's concrete shape.
 *
 * `id` and `enteredAt` are optional so existing test mocks that only return
 * `{ symbol }` continue to compile; the time-expiry path skips entries that
 * lack either field.
 */
interface ShadowExitFeed {
    getOpenPositions(): Array<{
        symbol: string;
        id?: string;
        enteredAt?: number;
    }>;
    updatePrice(symbol: string, currentPrice: number, slippageBps?: number): void;
    /** Optional — when present, StopMonitor will close positions that exceed shadowMaxHoldMs. */
    closeShadowPositionByTimeExpiry?: (positionId: string, exitPrice: number) => boolean;
}
interface StopEvent {
    positionId: string;
    symbol: string;
    type: "stop-loss" | "take-profit" | "trailing-stop" | "time-expiry" | "stale-monitor";
    triggerPrice: number;
    currentPrice: number;
    side: "long" | "short";
    qty: number;
    pnl: number;
}
interface ScaleOutMilestone {
    /** Profit % threshold to trigger scale-out (e.g., 5 = 5% profit) */
    profitPct: number;
    /** Fraction of remaining position to close at this milestone (0-1) */
    closeFraction: number;
}
interface StopMonitorDeps {
    client: CryptoClient;
    store: TradingStore;
    onStopTriggered?: (event: StopEvent) => void;
    /** Called when a stop-loss sell fails after all retries — critical alert */
    onStopFailed?: (event: StopEvent, error: string) => void;
    /** If provided, executes sell orders on stop triggers */
    executeSell?: (symbol: string, qty: number, positionId: string) => Promise<void>;
    /**
     * Maximum time a position can be held before automatic close (in ms).
     * Default: 48 hours. Set to 0 to disable time-based exits.
     */
    maxHoldMs?: number;
    /**
     * Maximum time a SHADOW position can be held before forced close (in ms).
     * Default: 8 hours (28800000ms) — aggressive enough to recycle the oldest
     * shadow positions during the Phase 1 soak so the close-count clock can
     * advance, while still giving fast strategies room to hit TP. Set to 0 to
     * disable shadow time-based exits.
     */
    shadowMaxHoldMs?: number;
    /**
     * When take-profit is hit, close this fraction (0-1) and trail the rest.
     * Default: 1.0 (close 100% at TP — legacy behavior).
     * Set to 0.5 to close 50% at TP and move the remaining stop to breakeven.
     */
    takeProfitCloseFraction?: number;
    /** Trailing stop % to apply to the remainder after partial TP close. Default: 3% */
    remainderTrailingPct?: number;
    /**
     * Profit milestones at which to scale out a fraction of the position.
     * Applied during trailing stop updates. Default: [{profitPct: 5, closeFraction: 0.3}]
     * (close 30% of position when profit hits 5%).
     * Set to empty array to disable scale-out.
     */
    scaleOutMilestones?: ScaleOutMilestone[];
    /**
     * Called after a position is successfully closed (full close, not partial TP).
     * Provides PnL and position info so consumers (e.g., StrategyAdaptor) can
     * update weights incrementally based on individual trade outcomes.
     */
    onTradeClose?: (event: StopEvent & {
        isWin: boolean;
    }) => void;
    /**
     * Optional TradeJournal handle. When provided, every successful position
     * close fires `journal.closeTradeBySymbol(symbol, side, exitPrice, exitReason)`
     * so `strategy_trades.exitedAt + pnl` get populated for the learning loop.
     * Without this, StrategyGrader has no closed-trade rows to grade.
     */
    tradeJournal?: {
        closeTradeBySymbol: (symbol: string, direction: "long" | "short", exitPrice: number, exitReason: string) => boolean;
    };
    /** Mark price for `solana:*` (Jupiter path); CEX symbols still use `client.getTicker`. */
    getDexUsdPrice?: (symbol: string) => Promise<number | null>;
    /** Optional freshness guard — rejects stale fallback prices in conservative mode */
    priceFreshnessGuard?: PriceFreshnessGuard;
    /**
     * Optional ShadowModeExecutor handle. When provided, StopMonitor adds
     * shadow-position symbols to the price-fetch set and calls
     * `shadowModeExecutor.updatePrice(symbol, price)` on every cycle so
     * shadow positions auto-close on SL/TP — without this, shadow positions
     * accumulate forever because `updatePrice` would never be called.
     */
    shadowModeExecutor?: ShadowExitFeed;
}
declare class StopMonitor {
    private client;
    private store;
    private onStopTriggered?;
    private onStopFailed?;
    private executeSell?;
    /** Maximum hold time before forced close. Default: 48 hours. 0 = disabled. */
    private maxHoldMs;
    /** Maximum hold time for shadow positions before forced close. Default: 8 hours. 0 = disabled. */
    private shadowMaxHoldMs;
    /** Fraction of position to close at TP (0-1). Default: 1.0 */
    private takeProfitCloseFraction;
    /** Trailing stop % for remainder after partial TP. Default: 3% */
    private remainderTrailingPct;
    /** Track positions currently being closed to prevent double-execution */
    private closingPositions;
    /** Prevent concurrent checkStops() execution */
    private isChecking;
    /** Last known prices per symbol — fallback when live fetch fails */
    private lastKnownPrices;
    /** Track consecutive failures per position for exponential backoff */
    private failureCounts;
    /** Track consecutive price fetch failures per symbol for escalated logging */
    private priceFetchFailures;
    /** Profit milestones for scale-out during trailing stop updates */
    private scaleOutMilestones;
    /** Track which milestones have already been hit per position to avoid double-scaling */
    private scaledOutMilestones;
    /** Callback fired after a position is fully closed — for event-driven strategy adaptation */
    private onTradeClose?;
    /** Optional journal handle — closes the matching strategy_trades row on every successful close. */
    private tradeJournal?;
    private getDexUsdPrice?;
    /** Optional freshness guard for fallback prices */
    private priceFreshnessGuard?;
    /** Optional shadow-mode executor — drives shadow exits via the same price feed as real positions */
    private shadowModeExecutor?;
    /** Timestamp of last successful price fetch per symbol */
    private lastPriceFetchTime;
    /** Number of consecutive checkStops() calls skipped due to isChecking guard */
    private consecutiveSkips;
    /** Timestamp (ms) of last successful checkStops() completion */
    lastCheckAt: number;
    constructor(deps: StopMonitorDeps);
    /**
     * Late-bind the shadow-mode executor. ShadowModeExecutor is constructed
     * after StopMonitor in the boot sequence, so this setter lets the wiring
     * happen once both objects exist.
     */
    setShadowModeExecutor(executor: ShadowExitFeed | undefined): void;
    /**
     * Check all open positions against stops and time expiry.
     * Returns triggered stop events.
     * Skips execution if already running (prevents race conditions).
     */
    checkStops(): Promise<StopEvent[]>;
    private performCheckStops;
    private evaluatePosition;
    private updateTrailingStop;
    /**
     * Scale out at profit milestones during trailing stop updates.
     * When a position reaches a configured profit %, close a fraction to lock in gains.
     * Each milestone fires once per position (tracked in scaledOutMilestones).
     */
    private checkScaleOut;
}

interface StopSchedulerDeps {
    stopMonitor: StopMonitor;
    /** Interval in ms between stop checks. Default: 10_000 (live) or 60_000 (paper) */
    intervalMs?: number;
    /** If true, use the longer paper interval (60s). Default: false (10s live interval) */
    isPaper?: boolean;
    /** Called when stops trigger during a scheduled check */
    onStopTriggered?: (events: StopEvent[]) => void;
    /** Called when a check cycle errors (log + continue) */
    onError?: (error: Error) => void;
    /**
     * Fired after every successful tick (regardless of whether stops triggered). Defense-in-depth
     * heartbeat hook: lets the in-process loop check in `trading:stop-monitor` independently of
     * the cron-driven `trade_check_stops` path, so a hung scheduler entry can't silence us.
     */
    onTick?: () => void;
}
/**
 * StopScheduler — runs StopMonitor.checkStops() on a configurable timer.
 *
 * For live trading, stops MUST be checked automatically. This scheduler
 * ensures stop-loss/take-profit/trailing-stop monitoring runs continuously
 * without requiring manual `trade_check_stops` calls.
 *
 * Error handling: log + continue. A single failed check must not crash
 * the monitoring loop — the next cycle will retry.
 */
declare class StopScheduler {
    private stopMonitor;
    private intervalMs;
    private timer;
    private onStopTriggered?;
    private onError?;
    private onTick?;
    private _isRunning;
    private _checkCount;
    private _errorCount;
    private _lastTriggeredEvents;
    constructor(deps: StopSchedulerDeps);
    /** Start the scheduled stop check loop. No-op if already running. */
    start(): void;
    /** Stop the scheduled loop. Safe to call multiple times. */
    stop(): void;
    /** Whether the scheduler is currently running. */
    get isRunning(): boolean;
    /** Total number of completed check cycles. */
    get checkCount(): number;
    /** Total number of errored check cycles. */
    get errorCount(): number;
    /** Events from the most recent check that triggered stops. */
    get lastTriggeredEvents(): StopEvent[];
    /** The configured check interval in milliseconds. */
    get interval(): number;
    /**
     * Execute a single check cycle. Called by the timer, but also
     * available for manual invocation (e.g., in tests or one-off checks).
     */
    tick(): Promise<StopEvent[]>;
}

/**
 * TradingHealthAggregator — single pane of glass for trading system health.
 *
 * Aggregates all safety subsystem statuses into one queryable report.
 * This is the canonical endpoint an operator checks to know whether
 * trading is healthy, degraded, or halted.
 */

type OverallHealth = "HEALTHY" | "DEGRADED" | "CRITICAL" | "HALTED";
interface TradingHealthReport {
    overall: OverallHealth;
    timestamp: number;
    systems: {
        killSwitch: {
            active: boolean;
        };
        circuitBreaker: {
            status: string;
            tripped: boolean;
        };
        drawdownBreaker: {
            status: string;
            currentDrawdownPct: number;
        };
        dailyLossLimit: {
            remaining: number;
            used: number;
            limit: number;
        };
        exchangeHealth: Record<string, {
            status: string;
            latencyMs: number;
        }>;
        stopScheduler: {
            running: boolean;
            lastCheckAt: number;
        };
        openPositions: {
            count: number;
            totalExposureUsd: number;
        };
        stalePrices: string[];
    };
    alerts: string[];
}
interface TradingHealthDeps {
    store?: TradingStore;
    circuitBreaker?: TradingCircuitBreaker;
    exchangeHealthMonitor?: ExchangeHealthMonitor;
    stopScheduler?: StopScheduler;
    priceFreshnessGuard?: PriceFreshnessGuard;
}
declare class TradingHealthAggregator {
    private deps;
    constructor(deps?: TradingHealthDeps);
    getHealth(): TradingHealthReport;
    private isKillSwitchActive;
    private getCircuitBreakerInfo;
    private getDrawdownBreakerInfo;
    private getDailyLossInfo;
    private getExchangeHealthInfo;
    private getStopSchedulerInfo;
    private getOpenPositionInfo;
    private getStalePrices;
    private computeOverall;
}

interface CandleData {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
/**
 * Abstract exchange interface. Every exchange adapter implements this.
 * Allows the trading plugin to work with any exchange transparently.
 */
interface Exchange {
    /** Unique identifier for this exchange instance (e.g., "crypto-com", "binance") */
    readonly name: string;
    /** Human-readable label */
    readonly label: string;
    /** Whether private (authenticated) endpoints are available */
    readonly hasCredentials: boolean;
    getTicker(symbol: string): Promise<Ticker>;
    getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
    getCandles(symbol: string, timeframe: string): Promise<CandleData[]>;
    getBalances(): Promise<Balance[]>;
    createOrder(params: {
        symbol: string;
        side: "BUY" | "SELL";
        type: "MARKET" | "LIMIT";
        qty: number;
        price?: number;
    }): Promise<TradeResult>;
    cancelOrder(symbol: string, orderId: string): Promise<{
        orderId: string;
        status: string;
    }>;
    getOpenOrders(symbol?: string): Promise<TradeResult[]>;
}
/**
 * Configuration for registering an exchange.
 */
interface ExchangeConfig {
    name: string;
    label?: string;
    apiKey?: string;
    apiSecret?: string;
}

interface PriceComparison {
    symbol: string;
    prices: {
        exchange: string;
        bid: number;
        ask: number;
        last: number;
    }[];
    bestBid: {
        exchange: string;
        price: number;
    };
    bestAsk: {
        exchange: string;
        price: number;
    };
    spreadOpportunity: number | null;
}
interface AggregatedBalances {
    byExchange: {
        exchange: string;
        balances: {
            currency: string;
            available: number;
            locked: number;
            total: number;
        }[];
    }[];
    totals: {
        currency: string;
        total: number;
    }[];
}
/**
 * Manages multiple exchange connections.
 * Routes operations and compares prices across exchanges.
 */
declare class ExchangeManager {
    private exchanges;
    private defaultExchange;
    register(exchange: Exchange): void;
    remove(name: string): boolean;
    setDefault(name: string): void;
    get(name: string): Exchange | undefined;
    getDefault(): Exchange | undefined;
    getDefaultName(): string | null;
    list(): {
        name: string;
        label: string;
        hasCredentials: boolean;
        isDefault: boolean;
    }[];
    get size(): number;
    /**
     * Compare prices for a symbol across all registered exchanges.
     */
    comparePrices(symbol: string): Promise<PriceComparison>;
    /**
     * Aggregate balances across all exchanges with credentials.
     */
    aggregateBalances(): Promise<AggregatedBalances>;
}

declare const FlashCrashConfigSchema: z.ZodObject<{
    /** Price drop threshold in percent to trigger flash crash detection (default: 10%) */
    dropThresholdPct: z.ZodDefault<z.ZodNumber>;
    /** Rolling window in milliseconds (default: 300000 = 5 minutes) */
    windowMs: z.ZodDefault<z.ZodNumber>;
    /** Minimum data points required before detection is active (default: 5) */
    minDataPoints: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    minDataPoints: number;
    windowMs: number;
    dropThresholdPct: number;
}, {
    dropThresholdPct?: number | undefined;
    windowMs?: number | undefined;
    minDataPoints?: number | undefined;
}>;
type FlashCrashConfig = z.infer<typeof FlashCrashConfigSchema>;
interface FlashCrashResult {
    detected: boolean;
    dropPct: number;
    windowMs: number;
    recommendation: "flatten" | "widen_stops" | "none";
}
interface FlashCrashEvent {
    symbol: string;
    dropPct: number;
    windowMs: number;
    recommendation: "flatten" | "widen_stops";
    highPrice: number;
    lowPrice: number;
    timestamp: number;
}
declare class FlashCrashDetector {
    private config;
    private priceWindows;
    private listeners;
    constructor(config?: Partial<FlashCrashConfig>);
    /** Register a listener for flash crash events. */
    on(listener: (event: FlashCrashEvent) => void): void;
    /** Remove a previously registered listener. */
    off(listener: (event: FlashCrashEvent) => void): void;
    /**
     * Record a price observation for a symbol.
     * Prices outside the rolling window are pruned automatically.
     */
    recordPrice(symbol: string, price: number, timestamp?: number): void;
    /**
     * Check whether a flash crash is occurring for the given symbol.
     *
     * Compares the highest price in the rolling window to the most recent price.
     * - If drop > dropThresholdPct   -> detected=true, recommendation='flatten'
     * - If drop > dropThresholdPct/2 -> detected=false, recommendation='widen_stops'
     * - Otherwise                    -> detected=false, recommendation='none'
     *
     * Emits a FlashCrashEvent when a crash is detected.
     */
    checkFlashCrash(symbol: string): FlashCrashResult;
    /** Clear all recorded prices for a symbol (or all symbols if none specified). */
    reset(symbol?: string): void;
    /** Get current config (read-only copy). */
    getConfig(): FlashCrashConfig;
}

declare const MaxPositionsConfigSchema: z.ZodObject<{
    maxOpenPositions: z.ZodDefault<z.ZodNumber>;
    maxPerSymbol: z.ZodDefault<z.ZodNumber>;
    maxPerExchange: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    maxOpenPositions: number;
    maxPerSymbol: number;
    maxPerExchange: number;
}, {
    maxOpenPositions?: number | undefined;
    maxPerSymbol?: number | undefined;
    maxPerExchange?: number | undefined;
}>;
interface PositionInfo {
    symbol: string;
    exchange: string;
}
interface PositionCheckResult {
    allowed: boolean;
    reason?: string;
}
declare class MaxPositionsGuard {
    private readonly config;
    constructor(config?: Partial<z.input<typeof MaxPositionsConfigSchema>>);
    canOpenPosition(params: PositionInfo, currentPositions: PositionInfo[]): PositionCheckResult;
}

declare const GraduationStepSchema: z.ZodObject<{
    minTradesCompleted: z.ZodNumber;
    minWinRate: z.ZodNumber;
    maxUsd: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    minWinRate: number;
    minTradesCompleted: number;
    maxUsd: number;
}, {
    minWinRate: number;
    minTradesCompleted: number;
    maxUsd: number;
}>;
declare const PositionGraduationConfigSchema: z.ZodObject<{
    initialMaxUsd: z.ZodDefault<z.ZodNumber>;
    graduationSteps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        minTradesCompleted: z.ZodNumber;
        minWinRate: z.ZodNumber;
        maxUsd: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        minWinRate: number;
        minTradesCompleted: number;
        maxUsd: number;
    }, {
        minWinRate: number;
        minTradesCompleted: number;
        maxUsd: number;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    initialMaxUsd: number;
    graduationSteps: {
        minWinRate: number;
        minTradesCompleted: number;
        maxUsd: number;
    }[];
}, {
    initialMaxUsd?: number | undefined;
    graduationSteps?: {
        minWinRate: number;
        minTradesCompleted: number;
        maxUsd: number;
    }[] | undefined;
}>;
type GraduationStep = z.infer<typeof GraduationStepSchema>;
type PositionGraduationConfig = z.infer<typeof PositionGraduationConfigSchema>;
interface TradeStats {
    totalTrades: number;
    winRate: number;
}
interface GraduationStatus {
    currentLevel: number;
    maxLevels: number;
    currentMaxUsd: number;
    nextLevel: {
        tradesNeeded: number;
        winRateNeeded: number;
        maxUsd: number;
    } | null;
}
declare class PositionGraduation {
    private readonly config;
    private lastLevel;
    constructor(config?: Partial<z.input<typeof PositionGraduationConfigSchema>>);
    /**
     * Returns the maximum allowed position size in USD based on the trader's
     * track record. Levels cannot be skipped — each step must be satisfied
     * in order.
     */
    getCurrentMaxUsd(stats: TradeStats): number;
    /**
     * Returns detailed graduation status including the current level,
     * current max USD, and what is needed for the next level.
     */
    getGraduationStatus(stats: TradeStats): GraduationStatus;
}

/**
 * Opus grind cycle gating: aligns with NotificationManager-style quiet windows
 * (HH:MM local). When `quietHours` is undefined, uses 23:00–07:00 overnight window.
 */
type QuietHoursWindow = {
    start: string;
    end: string;
};

interface PriceUpdate {
    symbol: string;
    bid: number;
    ask: number;
    last: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    timestamp: number;
}
interface PriceFeedConfig {
    /** WebSocket URL (default: Crypto.com market stream) */
    url?: string;
    /** Auto-reconnect on disconnect (default: true) */
    autoReconnect?: boolean;
    /** Reconnect delay in ms (default: 3000, doubles each retry up to 30s) */
    reconnectDelayMs?: number;
    /** Max reconnect delay in ms (default: 30000) */
    maxReconnectDelayMs?: number;
    /** Heartbeat interval in ms (default: 30000) */
    heartbeatIntervalMs?: number;
}
interface PriceFeedEvents {
    price: (update: PriceUpdate) => void;
    connected: () => void;
    disconnected: (reason: string) => void;
    error: (error: Error) => void;
    subscribed: (symbols: string[]) => void;
}
type PriceFeedEventName = keyof PriceFeedEvents;
/**
 * Real-time WebSocket price feed.
 * Connects to exchange WebSocket, subscribes to ticker channels,
 * and emits price updates. Auto-reconnects on disconnect.
 *
 * Usage:
 *   const feed = new PriceFeed();
 *   feed.on("price", (update) => console.log(update));
 *   await feed.connect();
 *   feed.subscribe(["BTC_USDT", "ETH_USDT"]);
 */
declare class PriceFeed extends EventEmitter {
    private config;
    private ws;
    private subscriptions;
    private reconnectTimer;
    private heartbeatTimer;
    private currentDelay;
    private requestId;
    private _connected;
    private _closed;
    private latestPrices;
    private boundHandleMessage;
    private boundHandleClose;
    constructor(config?: PriceFeedConfig);
    on<E extends PriceFeedEventName>(event: E, listener: PriceFeedEvents[E]): this;
    emit<E extends PriceFeedEventName>(event: E, ...args: Parameters<PriceFeedEvents[E]>): boolean;
    get connected(): boolean;
    get subscribedSymbols(): string[];
    /** Maximum age (ms) for a cached price to be considered fresh. Default: 60s. */
    private static readonly MAX_STALENESS_MS;
    /**
     * Get the latest cached price for a symbol (if available from WebSocket stream).
     * Returns undefined if the cached price is stale (older than MAX_STALENESS_MS),
     * e.g., during a WebSocket reconnect gap.
     */
    getLatestPrice(symbol: string): PriceUpdate | undefined;
    /**
     * Get all cached prices.
     */
    getAllPrices(): Map<string, PriceUpdate>;
    /**
     * Connect to the WebSocket server.
     */
    connect(): Promise<void>;
    /**
     * Subscribe to real-time ticker updates for symbols.
     */
    subscribe(symbols: string[]): void;
    /**
     * Unsubscribe from symbols.
     */
    unsubscribe(symbols: string[]): void;
    /**
     * Disconnect and stop all activity.
     */
    close(): void;
    /**
     * Get connection status info.
     */
    status(): {
        connected: boolean;
        subscriptions: string[];
        cachedPrices: number;
        url: string;
    };
    /** Remove message/close listeners from the current WebSocket (idempotent). */
    private detachWsListeners;
    private sendSubscribe;
    private handleMessage;
    private startHeartbeat;
    private stopHeartbeat;
    private scheduleReconnect;
}

interface TradingHandlerDeps {
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
declare function createTradingHandlers(deps: TradingHandlerDeps): {
    trade_get_price: (args: Record<string, unknown>) => Promise<string>;
    /** Spot BTC/ETH ratio from two live tickers — for scheduled checks without an LLM. */
    trade_btc_eth_ratio: () => Promise<string>;
    /**
     * Single-shot snapshot for scheduled runs: batch spot quotes, top-of-book per symbol,
     * open-position summary with stop proximity and simple P&L / halt checks. No LLM.
     */
    trade_daily_crypto_discipline: (args?: Record<string, unknown>) => Promise<string>;
    trade_get_prices: (args: Record<string, unknown>) => Promise<string>;
    trade_get_orderbook: (args: Record<string, unknown>) => Promise<string>;
    trade_get_balances: () => Promise<string>;
    trade_get_positions: () => Promise<string>;
    /**
     * Verify exchange API connectivity before allowing live trading.
     *
     * Tests both public endpoints (ticker data) and private endpoints
     * (account balances) to ensure credentials are valid and the exchange
     * is reachable. Should be called on startup before enabling live mode.
     */
    trade_verify_exchange: () => Promise<string>;
    trade_set_alert: (args: Record<string, unknown>) => Promise<string>;
    trade_list_alerts: (args?: Record<string, unknown>) => Promise<string>;
    trade_delete_alert: (args: Record<string, unknown>) => Promise<string>;
    trade_buy: (args: Record<string, unknown>) => Promise<string>;
    /**
     * Solana on-chain swap via Jupiter v6 (USDC ↔ listed tokens in SOLANA_TOKENS).
     * Symbol must be `solana:SOL`, `solana:JUP`, etc. Paper by default; live requires
     * `paper_mode=false`, `confirm_live=true`, and `SOLANA_DEX_SECRET_KEY` (base58).
     */
    trade_dex_swap: (args: Record<string, unknown>) => Promise<string>;
    trade_sell: (args: Record<string, unknown>) => Promise<string>;
    trade_history: (args: Record<string, unknown>) => Promise<string>;
    trade_portfolio: () => Promise<string>;
    trade_pre_live_checklist: () => Promise<string>;
    trade_set_limit: (args: Record<string, unknown>) => Promise<string>;
    trade_set_stop: (args: Record<string, unknown>) => Promise<string>;
    trade_check_stops: () => Promise<string>;
    /**
     * Compare exchange open orders against local submitted_orders (live mode only).
     * Lookback window defaults to 24h (see reconcile_lookback_hours). Paper mode returns skipped=true.
     */
    trade_reconcile_orders: () => Promise<string>;
    /**
     * Close all open paper positions at current market prices.
     * Used to get a clean start after safety system upgrades.
     * Only works in paper mode as a safety measure.
     */
    trade_reset_paper: () => Promise<string>;
    /**
     * Reset peak equity to current level, accepting the drawdown and resuming trading.
     * Only works in paper mode. Clears the drawdown halt so signals can execute again.
     */
    trade_reset_drawdown: () => Promise<string>;
    /**
     * Reset all four circuit breakers (consecutive_loss, drawdown, velocity)
     * in one call and clear trading_state to ACTIVE. Sole admin path for
     * unsticking the velocity breaker, which has no individual reset tool
     * and otherwise waits 4h for auto-reset. Paper-mode only.
     */
    trade_reset_breakers: () => Promise<string>;
    trade_risk_status: () => Promise<string>;
    trade_explain_state: () => Promise<string>;
    trade_set_kill_switch: (args: Record<string, unknown>) => Promise<string>;
    trade_set_daily_loss_cap: (args: Record<string, unknown>) => Promise<string>;
    trade_rsi_divergence_counters: (args?: Record<string, unknown>) => Promise<string>;
    trade_list_strategies: () => Promise<string>;
    trade_backtest: (args: Record<string, unknown>) => Promise<string>;
    trade_backtest_list: (args: Record<string, unknown>) => Promise<string>;
    trade_optimize: (args: Record<string, unknown>) => Promise<string>;
    trade_strategy_rankings: () => Promise<string>;
    trade_snapshot_strategies: () => Promise<string>;
    trade_dynamic_risk_status: () => Promise<string>;
    trade_deploy_strategy: (args: Record<string, unknown>) => Promise<string>;
    trade_get_indicators: (args: Record<string, unknown>) => Promise<string>;
    trade_fetch_candles: (args: Record<string, unknown>) => Promise<string>;
    /**
     * Backfill historical candle data for specified symbols and timeframes.
     *
     * Paginates through the Crypto.com API to fetch 30-90 days of history,
     * upserting into the local CandleStore. Essential for backtesting and
     * strategy development — the regular fetch only grabs the latest batch.
     */
    trade_backfill_candles: (args: Record<string, unknown>) => Promise<string>;
    trade_scan_signals: () => Promise<string>;
    trade_get_signals: (args: Record<string, unknown>) => Promise<string>;
    trade_analytics: () => Promise<string>;
    trade_macro_prediction: (args: Record<string, unknown>) => Promise<string>;
    trade_strategy_report: (args: Record<string, unknown>) => Promise<string>;
    trade_journal: (args: Record<string, unknown>) => Promise<string>;
    trade_list_exchanges: () => Promise<string>;
    trade_compare_prices: (args: Record<string, unknown>) => Promise<string>;
    trade_aggregate_balances: () => Promise<string>;
    trade_ws_status: () => Promise<string>;
    trade_ws_subscribe: (args: Record<string, unknown>) => Promise<string>;
    trade_ws_unsubscribe: (args: Record<string, unknown>) => Promise<string>;
    trade_check_alerts: () => Promise<string>;
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
    trade_daily_report: (args: Record<string, unknown>) => Promise<string>;
    /**
     * Daily P&L summary report.
     *
     * Shows all positions closed today (or on a specific date) with total P&L,
     * win/loss ratio, per-position breakdown, and virtual portfolio state.
     * Results are clearly labelled PAPER or LIVE so there's no confusion.
     */
    trade_paper_summary: (args: Record<string, unknown>) => Promise<string>;
    /**
     * Reset the paper trading portfolio back to the starting virtual balance.
     *
     * This wipes all paper positions, trade history, and coin balances, then
     * restores the USDT virtual balance to the virtual_balance_usd setting
     * (default $1000). Requires confirm=true to prevent accidental resets.
     */
    trade_paper_reset: (args: Record<string, unknown>) => Promise<string>;
    trade_strategy_grade_refresh: (args: Record<string, unknown>) => Promise<string>;
    trade_strategy_lifecycle: () => Promise<string>;
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
    trade_leaderboard: (args: Record<string, unknown>) => Promise<string>;
    /**
     * Quiet-hours-first portfolio risk audit: resolves local quiet window, optionally
     * skips benchmark tickers off-hours, enriches open positions, scans gates/stops/concentration,
     * and (by default) appends an opus grind log row with structured summary.
     */
    trade_quiet_hours_risk_audit: (args: Record<string, unknown>) => Promise<string>;
    dca_configure: (args: Record<string, unknown>) => Promise<string>;
    dca_status: () => Promise<string>;
    dca_pause: (args: Record<string, unknown>) => Promise<string>;
    dca_resume: (args: Record<string, unknown>) => Promise<string>;
    dca_run_cycle: () => Promise<string>;
    trade_opus_grind_cycle_state: (_args: Record<string, unknown>) => Promise<string>;
    trade_log_opus_grind: (args: Record<string, unknown>) => Promise<string>;
    trade_get_opus_grinds: (args: Record<string, unknown>) => Promise<string>;
    rebalance_configure: (args: Record<string, unknown>) => Promise<string>;
    rebalance_status: () => Promise<string>;
    rebalance_preview: () => Promise<string>;
    rebalance_execute: () => Promise<string>;
    rebalance_run_cycle: () => Promise<string>;
    /**
     * Evaluate strategy rotation — ranks strategies by performance metric
     * and returns the top-N active strategies with capital allocations.
     */
    trade_strategy_rotation: (_params?: Record<string, unknown>) => Promise<string>;
    /**
     * Get current strategy rotation status — active strategies and their allocations.
     */
    trade_strategy_rotation_status: () => Promise<string>;
    /**
     * Route an order to the optimal exchange based on health, slippage,
     * funding rate, and fee scoring.
     */
    trade_route_exchange: (params?: Record<string, unknown>) => Promise<string>;
    /**
     * Get API rate limit status across all tracked exchanges.
     */
    trade_rate_limit_status: (params?: Record<string, unknown>) => Promise<string>;
};

/**
 * Paper stop-loss decision tree (harvest ZLW-T0319 / ZLW-T0343).
 *
 * Plain style thresholds for paperMode suggestions only.
 * Never mutates live orders; refuses to emit exit/reduce when paperMode is false.
 */
type TradeStyle = "scalp" | "swing" | "position";
type StopLossAction = "hold" | "reduce" | "exit" | "blocked";
/** Version string surfaced on status endpoints for operator audit. */
declare const PAPER_SL_TREE_VERSION = "sl_tree/v1";
interface PaperStopLossTreeConfig {
    /** % below entry (long) / above entry (short) that triggers exit. */
    hardStopPct: Record<TradeStyle, number>;
    /** Intermediate reduce threshold as fraction of hard stop (0–1). Default 0.6. */
    reduceFraction: number;
    version: string;
}
/** Harvest defaults: 2% scalp / 5% swing / 8% position. */
declare const DEFAULT_PAPER_SL_TREE: PaperStopLossTreeConfig;
interface PaperStopLossCheckInput {
    /** Must be true — live mode always returns blocked. */
    paperMode: boolean;
    style: TradeStyle;
    side: "long" | "short";
    entryPrice: number;
    currentPrice: number;
    /** Optional override tree (e.g. from config). */
    tree?: Partial<PaperStopLossTreeConfig>;
}
interface PaperStopLossCheckResult {
    action: StopLossAction;
    style: TradeStyle;
    /** Adverse move from entry as a percent (always ≥ 0 when adverse). */
    adversePct: number;
    hardStopPct: number;
    reduceAtPct: number;
    version: string;
    reason: string;
}
/**
 * Evaluate paper stop-loss tree for one position snapshot.
 * Returns hold / reduce / exit suggestion — never executes.
 */
declare function checkPaperStopLoss(input: PaperStopLossCheckInput): PaperStopLossCheckResult;
/**
 * Batch-check open paper positions. Live (paperMode=false) returns all blocked.
 */
declare function checkPaperStopLossBatch(paperMode: boolean, positions: Array<{
    id: string;
    style: TradeStyle;
    side: "long" | "short";
    entryPrice: number;
    currentPrice: number;
}>, tree?: Partial<PaperStopLossTreeConfig>): Array<{
    id: string;
} & PaperStopLossCheckResult>;
/** Compact status blob for runtime/operator dashboards. */
declare function getPaperStopLossTreeStatus(tree?: Partial<PaperStopLossTreeConfig>): {
    version: string;
    hardStopPct: Record<TradeStyle, number>;
    reduceFraction: number;
    paperOnly: true;
};
interface PaperSlScenarioResult {
    name: string;
    pass: boolean;
    expected: StopLossAction;
    actual: StopLossAction;
    reason: string;
}
/**
 * Harvest monthly-style paper SL scenario battery (never executes trades).
 * Returns per-scenario pass/fail for operator / CI self-check.
 */
declare function runPaperStopLossScenarios(tree?: Partial<PaperStopLossTreeConfig>): {
    version: string;
    passed: number;
    failed: number;
    results: PaperSlScenarioResult[];
    paperOnly: true;
};
/**
 * Always-on invalidation level rule (harvest ZLW-T0331).
 * PaperMode only — never implies live order placement.
 * Long: exit if price ≤ invalidation; short: exit if price ≥ invalidation.
 */
declare function checkPaperInvalidation(input: {
    paperMode: boolean;
    side: "long" | "short";
    currentPrice: number;
    /** Explicit thesis break level (required for a real check). */
    invalidationLevel: number | null | undefined;
}): {
    breached: boolean;
    action: "hold" | "exit" | "blocked" | "missing_level";
    reason: string;
    paperOnly: true;
};

/**
 * Dual-desk media CTA aggressiveness (harvest ZLW-T0350 + media-trade dual desk).
 *
 * When the paper risk desk is in drawdown, suppress aggressive money CTAs.
 * Pure helper — never posts, never trades. Content guidance only.
 */
type MediaCtaMode = "full" | "soft" | "education_only";
/** Drawdown % at/above which urgency/money CTAs soften. */
declare const DUAL_DESK_SOFT_DRAWDOWN_PCT = 3;
/** Drawdown % at/above which only education/entertainment CTAs allowed. */
declare const DUAL_DESK_EDUCATION_DRAWDOWN_PCT = 6;
interface DualDeskCtaInput {
    /** Must be true for any mode other than education_only (live desk never drives media money CTAs). */
    paperMode: boolean;
    /** Session/portfolio drawdown percent (0–100). Null/undefined → full when paper. */
    drawdownPct?: number | null;
    /** Hard halt (circuit / kill) — force education-only. */
    tradingHalted?: boolean;
}
interface DualDeskCtaResult {
    mode: MediaCtaMode;
    /** Allowed CTA types for caption packs. */
    allowedCtaTypes: Array<"direct" | "question" | "urgency" | "education">;
    suppressAggressiveMoney: boolean;
    reason: string;
    paperOnly: true;
    thresholds: {
        softDrawdownPct: number;
        educationDrawdownPct: number;
    };
}
/**
 * Map paper desk health → media CTA aggressiveness.
 * Live mode always education_only (no money CTAs driven by live risk signals).
 */
declare function resolveDualDeskCtaMode(input: DualDeskCtaInput): DualDeskCtaResult;

/**
 * Paper trade journal validation (harvest ZLW-T0319 family).
 * PaperMode only — never promotes to live execution.
 */
type JournalSide = "long" | "short";
type JournalStyle = "scalp" | "swing" | "position";
type JournalExitReason = "stop" | "target" | "thesis_break" | "time" | "other";
interface PaperTradeJournalEntry {
    /** ISO or free-text timestamp. */
    at?: string;
    symbol: string;
    side: JournalSide;
    style: JournalStyle;
    size: number;
    entryPrice: number;
    stopPrice?: number | null;
    stopPct?: number | null;
    takeProfit?: number | null;
    /** Required thesis break level. */
    invalidationLevel?: number | null;
    why?: string;
    thesisInvalidIf?: string;
    /** Must be true for a valid paper entry. */
    paperMode: boolean;
    exitPrice?: number | null;
    exitReason?: JournalExitReason | null;
    realizedPnl?: number | null;
    learned?: string;
}
interface PaperJournalValidation {
    ok: boolean;
    paperOnly: true;
    errors: string[];
    warnings: string[];
}
/**
 * Validate a paper journal entry for completeness + paperMode hard rule.
 * Never executes trades.
 */
declare function validatePaperTradeJournal(entry: PaperTradeJournalEntry): PaperJournalValidation;
/** Session checklist flags (operator UI / CLI). */
declare function paperJournalSessionChecklist(entries: PaperTradeJournalEntry[]): {
    paperOnly: true;
    entryCount: number;
    allPaperMode: boolean;
    missingStop: number;
    missingInvalidation: number;
    closed: number;
};

declare const EventTypeSchema: z.ZodEnum<["trade_executed", "trade_rejected", "signal_generated", "signal_confirmed", "signal_rejected", "risk_check_passed", "risk_check_failed", "kill_switch_activated", "drawdown_alert", "strategy_switch", "position_opened", "position_closed"]>;
type TradingEventType = z.infer<typeof EventTypeSchema>;
declare const ConfigSchema: z.ZodObject<{
    maxAgeDays: z.ZodDefault<z.ZodNumber>;
    maxEntries: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    maxAgeDays: number;
    maxEntries: number;
}, {
    maxAgeDays?: number | undefined;
    maxEntries?: number | undefined;
}>;
type EventLogConfig = z.infer<typeof ConfigSchema>;
interface TradingEvent {
    id: string;
    timestamp: string;
    eventType: TradingEventType;
    payload: Record<string, unknown>;
    sessionId?: string;
    symbol?: string;
}
declare class TradingEventLog {
    private events;
    private config;
    private counter;
    constructor(config?: Partial<EventLogConfig>);
    append(eventType: TradingEventType, payload: Record<string, unknown>, opts?: {
        sessionId?: string;
        symbol?: string;
    }): TradingEvent;
    query(filter: {
        eventType?: TradingEventType | TradingEventType[];
        symbol?: string;
        sessionId?: string;
        sinceMs?: number;
        untilMs?: number;
        limit?: number;
    }): TradingEvent[];
    exportJson(filter?: Parameters<TradingEventLog["query"]>[0]): string;
    getCount(): number;
    getEventTypes(): TradingEventType[];
    private enforceRetention;
}

interface RecoveryPosition {
    position: Position;
    status: "verified" | "orphaned" | "drifted";
    exchangePrice: number | null;
    driftPct: number | null;
    error?: string;
}
interface RecoveryReport {
    timestamp: string;
    totalOpen: number;
    verified: number;
    orphaned: number;
    drifted: number;
    reArmed: number;
    positions: RecoveryPosition[];
}
interface CrashRecoveryDeps {
    store: TradingStore;
    client: CryptoClient;
    stopMonitor: StopMonitor;
    eventLog?: TradingEventLog;
    /** Price drift % threshold to flag as "drifted". Default: 5 */
    driftThresholdPct?: number;
    /** Called when recovery finds orphaned or significantly drifted positions */
    onAlert?: (report: RecoveryReport) => void;
}
/**
 * CrashRecoveryManager — runs on startup to reconcile open positions
 * with the exchange and re-arm stop monitoring.
 *
 * Solves the gap where a process crash leaves positions unmonitored
 * until an operator manually triggers stop checks.
 */
declare class CrashRecoveryManager {
    private store;
    private client;
    private stopMonitor;
    private eventLog?;
    private driftThresholdPct;
    private onAlert?;
    private hasRun;
    constructor(deps: CrashRecoveryDeps);
    /** Returns true if recover() has already been called. */
    get recovered(): boolean;
    /**
     * Run crash recovery sweep. Safe to call multiple times — only
     * executes once (subsequent calls return the cached report).
     */
    recover(): Promise<RecoveryReport>;
    /**
     * Reconcile a single position against the exchange.
     * Fetches current price and checks for drift from last recorded price.
     */
    private reconcilePosition;
}

/**
 * Paper-mode equity computation.
 *
 * Sums every paper balance priced in USD plus the mark-to-market value of
 * open SHORT positions and DEX longs. Non-USDT currencies are priced via
 * their <CCY>_USDT ticker so BTC/SOL/XRP holdings count toward equity. A
 * balance whose ticker fetch fails falls back to the last-known-good price
 * (15-minute TTL) so a transient feed glitch doesn't drop the asset from
 * equity and trip the drawdown CB on a portfolio that hasn't actually drawn
 * down. If the cache is also empty/stale the balance is excluded rather
 * than face-valued: conflating "5 MOONTOKEN" with "$5" silently inflates
 * equity.
 *
 * Spot long positions do NOT add to `openPositionValue` because their mark
 * is already reflected in `balances` — `store.openPosition` debits quote
 * and credits base on entry, `closePosition` mirrors that on exit. Counting
 * a spot long again here would double-count its mark. DEX longs (solana:*)
 * aren't reconciled into paper_balances by the spot helper (different
 * symbol layout), so they still contribute through the position record.
 * Shorts can't be modeled via spot balances (no margin in paper). Their sale
 * notional stays in USDT cash (the reconcile helpers skip non-longs), so a
 * short contributes ONLY its unrealized PnL `(entryPrice - mark) * qty` here —
 * adding the notional again would double-count it and inflate equity.
 *
 * This logic was duplicated across three call sites (handlers.ts,
 * zaraa.ts hourly interval, zaraa.ts position-close). When one site was
 * fixed in isolation the others kept reporting USDT-only equity, which
 * tripped the drawdown breaker on a portfolio that hadn't actually drawn
 * down. One helper means one place to get it right.
 */
interface PaperEquityBalance {
    currency: string;
    balance: number;
}
interface PaperEquityPosition {
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    qty: number;
}
interface PaperEquityDeps {
    balances: PaperEquityBalance[];
    openPositions: PaperEquityPosition[];
    /** Fetch a ticker for a CEX symbol (e.g. "BTC_USDT"). May throw for unknown markets. */
    getTicker: (symbol: string) => Promise<{
        last: number;
    }>;
    /** Called when a <CCY>_USDT lookup fails AND no fresh cached price is available. */
    onNoTicker?: (currency: string, balance: number) => void;
    /** Called when the ticker fetch fails but a cached price is used as fallback. */
    onStalePriceFallback?: (currency: string, balance: number, cachedPrice: number, ageMs: number) => void;
    /** Optional: for Solana DEX symbols, fetch USD price (returns null if unavailable). */
    getDexPrice?: (symbol: string) => Promise<number | null>;
    /** Returns true if the symbol is a Solana DEX symbol and should use getDexPrice. */
    isDexSymbol?: (symbol: string) => boolean;
}
declare function computePaperEquityUsd(deps: PaperEquityDeps): Promise<number>;

interface AutomatedRiskLockSnapshot {
    triggered: boolean;
    reason?: string;
    tradingState: string;
    initialEquity: number;
    currentDailyPnl: number;
    dailyLossHardStopPct: number;
    dailyLossThresholdUsd: number;
    peakEquity: number;
    currentEquity: number;
    drawdownRatio: number;
    maxTotalDrawdownPct: number;
}

interface KillGateInput {
    store: TradingStore;
    circuitBreaker?: TradingCircuitBreaker | null;
    /** Match paper vs live P&L for daily loss cap (from `paper_mode` setting). */
    isPaperMode: boolean;
    /**
     * Optional precomputed automated-risk-lock snapshot. Each build does multiple
     * DB reads + equity resolution; the execution hot path computes it once and
     * threads it through both enforceAutomatedRiskLock and this gate to avoid
     * rebuilding the same snapshot 2-3× per entry attempt.
     */
    precomputedRiskLock?: AutomatedRiskLockSnapshot;
}
interface KillGateResult {
    allowed: boolean;
    reason?: string;
}
interface KillGateSnapshot {
    newEntriesAllowed: boolean;
    blockReason?: string;
    tradingState: string;
    tradingKillSwitch: boolean;
    dailyLossCapUsd: number | null;
    todayTotalPnl: number;
    dailyCapBreached: boolean;
    automatedRiskLockTriggered: boolean;
    automatedRiskReason?: string;
    dailyLossHardStopPct: number;
    dailyLossThresholdUsd: number;
    initialEquity: number;
    currentDrawdownPct: number;
    maxTotalDrawdownPct: number;
    primaryExchange: string;
    venueHalted: boolean;
    circuitBreakerHalted: boolean;
    circuitBreakerReasons: string[];
    /**
     * Per-breaker raw state. Lets dashboards/operators see exactly which of
     * the four breakers (consecutive_loss, drawdown, velocity, policy_volume)
     * is tripped without parsing the human-readable `circuitBreakerReasons`
     * strings. Empty when the breaker is not wired in.
     */
    breakerStates: BreakerRow[];
}
/**
 * Hard gates for **new entries** (signal engine, execution manager, trade_buy).
 * Does not apply to stop-monitor exits (handled in trade_sell).
 */
declare function evaluateTradingKillGate(input: KillGateInput): KillGateResult;
/**
 * Snapshot for dashboards and trade_risk_status (includes fields even when allowed).
 */
declare function buildKillGateSnapshot(input: KillGateInput): KillGateSnapshot;

/**
 * Validates `trade_risk_status`-shaped payloads for internally consistent halt / gate semantics.
 * Catches fabricated or merged JSON where `newEntriesAllowed` disagrees with halt flags or state.
 */
type TradeRiskStatusSemanticsResult = {
    ok: true;
} | {
    ok: false;
    conflicts: string[];
};
/**
 * @param payload — parsed `trade_risk_status` object (or partial for tests)
 */
declare function validateTradeRiskStatusSemantics(payload: unknown): TradeRiskStatusSemanticsResult;

interface InventorySkewInput {
    symbol: string;
    inventoryUnits: number;
    targetUnits: number;
    maxInventoryUnits: number;
    midPrice: number;
    baseQuoteSizeUsd: number;
    maxQuoteSkewBps?: number;
    hedgeThresholdPct?: number;
    deadbandPct?: number;
}
interface InventoryHedgeRecommendation {
    symbol: string;
    side: "buy" | "sell";
    units: number;
    notionalUsd: number;
    reason: string;
}
interface InventorySkewResult {
    symbol: string;
    inventoryPressure: number;
    reservationPriceShiftBps: number;
    bidPriceAdjustmentBps: number;
    askPriceAdjustmentBps: number;
    maxBidSizeUsd: number;
    maxAskSizeUsd: number;
    blockBid: boolean;
    blockAsk: boolean;
    hedge: InventoryHedgeRecommendation | null;
}
declare function evaluateInventorySkew(input: InventorySkewInput): InventorySkewResult | null;

/** Written when `trade_verify_exchange` succeeds (public + private API). */
declare const PRELIVE_EXCHANGE_VERIFIED_AT_KEY = "prelive_exchange_verified_at";
/** How long exchange verification remains valid for enabling live mode. */
declare const PRELIVE_VERIFY_TTL_MS: number;
interface PreLiveChecklistInput {
    store: TradingStore;
    hasCredentials: boolean;
    /** Raw `process.env.PAPER_TRADING` — `"true"` forces paper and blocks DB live mode. */
    paperTradingEnv?: string;
    /**
     * When true, `zaraa.config.json` still has `trading.paperMode: true`.
     * Signal engine thresholds stay on paper until restart after changing config.
     */
    zaraaTradingPaperMode?: boolean;
    circuitBreaker?: TradingCircuitBreaker | null;
    /**
     * Closed-shadow-trade evidence for the `shadow_performance` gate. Pass the
     * executor's lifetime numbers (`getShadowPerformance()`). Omit or pass null
     * when shadow mode is unavailable — the gate then fails closed.
     */
    shadowEvidence?: {
        closedTrades: number;
        totalPnl: number;
    } | null;
    /** For tests */
    nowMs?: number;
}
interface PreLiveChecklistItem {
    id: string;
    passed: boolean;
    message: string;
}
interface PreLiveChecklistResult {
    allPassed: boolean;
    items: PreLiveChecklistItem[];
    /** Operator reminders — not scored */
    reminders: string[];
}
declare function recordPreLiveExchangeVerified(store: TradingStore, verified: boolean): void;
/**
 * Gates enabling **live** trading (`paper_mode: false`). All items must pass.
 */
declare function evaluatePreLiveChecklist(input: PreLiveChecklistInput): PreLiveChecklistResult;

/**
 * Graduation Monitor — REPORT-ONLY evaluator for live trading graduation.
 *
 * This module is deliberately pure-function and side-effect-free.  It NEVER
 * modifies any flag (`paperMode`, `autoExecuteLive`, `liveModeLock`) and never
 * writes to the database.  Its single job: given current trade-journal state
 * + the current stage + stage thresholds, emit a verdict.
 *
 * The full graduation policy (entry / halt / advance criteria for Stages A/B/C)
 * is documented in `docs/plans/live-trading-graduation.md`.  This module
 * encodes the *paper-readiness* and *advance* criteria so operators have an
 * objective check before they consider any manual transition.
 *
 * Stage transitions remain manual — there is no API in this module that
 * would automate flipping a real-money switch.
 */
type GraduationStage = "PAPER" | "A" | "B" | "C" | "POST_C";
/** A single closed trade pulled from the trade journal. */
interface ClosedTradeRow {
    strategyName: string;
    symbol: string;
    pnl: number;
    rMultiple: number | null;
    enteredAt: string;
    exitedAt: string | null;
    regime?: string | null;
    isShadow?: number;
}
interface StageThresholds {
    /** Min consecutive trading days at the stage before advancing. */
    minDaysAtStage: number;
    /** Min closed trades at the stage. */
    minClosedTrades: number;
    /** Min realized cumulative PnL since stage start (USD). */
    minPnlUsd: number;
    /** Min average R-multiple over stage trades. */
    minAvgR: number;
    /** Min win rate, computed as W / (W + L) excluding break-even. */
    minWinRate: number;
    /** Max average slippage in basis points (live data). */
    maxAvgSlippageBps: number;
    /** Max consecutive losing trades allowed. */
    maxConsecutiveLosses: number;
}
interface PaperReadinessThresholds {
    minDaysOfPaperData: number;
    minClosedPaperTrades: number;
    minPaperPnlUsd: number;
    minAvgRPaper: number;
    minWinRatePaper: number;
    allowedStrategies: string[];
    allowedSymbols: string[];
    excludedSymbols: string[];
}
interface PromotionEvidence {
    /** Confirms the candidate sample came from paper/shadow-only execution. */
    paperOnly?: boolean;
    /** Confirms market data used for the candidate signal set was fresh. */
    marketDataFresh?: boolean;
    /** Current paper exposure before promotion. */
    currentExposureUsd?: number;
    /** Max allowed paper exposure for promotion. */
    maxExposureUsd?: number;
    /** Fraction of eligible paper trades with strategy/symbol/regime attribution. */
    attributionCoverage?: number;
    /** Minimum attribution coverage required. Defaults to 90%. */
    minAttributionCoverage?: number;
}
interface GraduationVerdict {
    stage: GraduationStage;
    canAdvance: boolean;
    advanceTo: GraduationStage | null;
    reasons: string[];
    blockers: string[];
    stats: {
        stageTrades: number;
        stageDays: number;
        stagePnlUsd: number;
        stageAvgR: number;
        stageWinRate: number;
        stageConsecutiveLosses: number;
    };
    paperStats: {
        totalTrades: number;
        paperPnl: number;
        avgR: number;
        winRate: number;
        daysOfData: number;
    };
}
interface MonitorInput {
    /** Current declared stage. */
    stage: GraduationStage;
    /** All closed trades from the journal (paper + live). */
    allTrades: ClosedTradeRow[];
    /** Subset of trades considered "live" (not paper) — empty array if still in PAPER. */
    liveTrades: ClosedTradeRow[];
    /** ISO date when the current stage started. Required for stages A/B/C. */
    stageStartedAt?: string;
    /** Live slippage average in basis points (caller computes). */
    liveAvgSlippageBps?: number;
    /** Whether any circuit breaker has tripped during the current stage window. */
    circuitBreakerTrippedDuringStage?: boolean;
    /** Whether the daily-rotating live-mode lock is valid for today. */
    liveModeLockValid?: boolean;
    /** Whether the pre-live checklist passes. */
    preLiveChecklistPassed?: boolean;
    /** Explicit safety evidence required before PAPER can graduate. */
    promotionEvidence?: PromotionEvidence;
    /** Override default thresholds for testing or policy tuning. */
    stageThresholds?: Partial<Record<Exclude<GraduationStage, "PAPER" | "POST_C">, StageThresholds>>;
    paperReadiness?: Partial<PaperReadinessThresholds>;
}
declare const DEFAULT_PAPER_READINESS: PaperReadinessThresholds;
declare const DEFAULT_STAGE_THRESHOLDS: Record<Exclude<GraduationStage, "PAPER" | "POST_C">, StageThresholds>;
/**
 * Pure evaluator.  Returns a verdict object describing whether the current
 * stage should be allowed to advance, and why / why not.
 *
 * The caller (CLI / dashboard / operator) is responsible for taking action
 * based on this verdict.  This function performs no I/O.
 */
declare function evaluateGraduation(input: MonitorInput): GraduationVerdict;
/** Render a verdict as a human-readable report (multi-line string). */
declare function formatGraduationReport(verdict: GraduationVerdict): string;

interface Discrepancy {
    type: "partial_fill_mismatch" | "orphaned_exchange_order";
    symbol: string;
    detail: string;
    orderId?: string;
    exchangeQty?: number;
}
interface ReconciliationResult {
    ok: boolean;
    skipped?: boolean;
    discrepancies: Discrepancy[];
    error?: string;
    checkedAt: string;
    /** Hours of submitted_orders history included in this run (from settings or default). */
    lookbackHours: number;
}
/** Aligns with submitted_orders TTL (24h) so open orders are not false “orphans” after one hour. */
declare const DEFAULT_RECONCILE_LOOKBACK_HOURS = 24;
declare const MIN_RECONCILE_LOOKBACK_HOURS = 1;
declare const MAX_RECONCILE_LOOKBACK_HOURS = 168;
/**
 * Whether an exchange-reported open order status should be treated as a partial fill
 * (needs operator attention vs fully working limit/market flow).
 * Normalizes casing, spaces, and hyphens; avoids matching NOT_FILLED / UNFILLED.
 */
declare function isPartialFillOrderStatus(status: string): boolean;
declare function resolveReconcileLookbackHours(store: TradingStore): number;
interface CancelledOrphan {
    orderId: string;
    symbol: string;
    dryRun: boolean;
}
interface CancelError {
    orderId: string;
    error: string;
}
interface ReconcileAndCleanResult {
    ok: boolean;
    skipped?: boolean;
    cancelled: CancelledOrphan[];
    cancelErrors: CancelError[];
    discrepancies: Discrepancy[];
    checkedAt: string;
    lookbackHours: number;
    error?: string;
}
declare class OrderReconciler {
    private deps;
    constructor(deps: {
        store: TradingStore;
        client: CryptoClient;
    });
    /**
     * @param options.referenceTimeMs — Optional clock anchor for tests (cutoff window and checkedAt).
     */
    reconcile(options?: {
        referenceTimeMs?: number;
    }): Promise<ReconciliationResult>;
    /**
     * Like `reconcile`, but also auto-cancels orphaned exchange orders after a grace period.
     * First-seen timestamps are persisted in store settings under `orphan_first_seen` (JSON map).
     */
    reconcileAndClean(options?: {
        referenceTimeMs?: number;
        gracePeriodMs?: number;
        dryRun?: boolean;
        eventLog?: TradingEventLog;
    }): Promise<ReconcileAndCleanResult>;
}

/**
 * Compute all standard indicators for a set of candles.
 * Candles must be sorted ascending by openTime.
 */
declare function computeIndicators(candles: Candle[], smaPeriods?: number[], emaPeriods?: number[]): IndicatorValues;

/**
 * Mean Reversion Strategy
 *
 * Logic: Buy when price touches the lower Bollinger Band and RSI is in oversold zone (<40).
 * Sell/short when price touches the upper Bollinger Band and RSI is in overbought zone (>60).
 *
 * Best in: Ranging/sideways markets.
 * Weak in: Strong trending markets (will fight the trend).
 */
declare const meanReversionStrategy: Strategy;

/**
 * Trend Following Strategy
 *
 * Logic:
 *   1. CROSSOVER: Enter long when fast EMA (20) crosses above slow EMA (50) with RSI > 50.
 *      Enter short on death cross with RSI < 50.
 *   2. CONTINUATION: Enter when an established trend shows a pullback-and-resume pattern.
 *      In a downtrend (EMA20 < EMA50, widening gap), enter short on pullback toward EMA20
 *      that resumes downward. In an uptrend, enter long on dip to EMA20 that bounces.
 *
 * The continuation signal catches established trends that the crossover missed
 * (e.g., if the cross happened before strategies were activated, or during
 * a low-confidence period).
 *
 * Best in: Trending markets with clear directional moves.
 * Weak in: Choppy/sideways markets (whipsaws).
 */
type TrendFollowingMode = "enabled" | "shadow" | "off";
declare function setTrendFollowingMode(mode: TrendFollowingMode): void;
declare function getTrendFollowingMode(): TrendFollowingMode;
declare const TF_GATE_DEFAULT_BASELINE_ISO = "2026-05-09T00:00:00.000Z";
declare const TF_GATE_DEFAULT_EVAL_AFTER_ISO = "2026-05-23T00:00:00.000Z";
interface TrendFollowingGateJournalDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
    };
}
interface EvaluateTrendFollowingGateInput {
    /** SQLite handle to trade-journal.db (the DB TradeJournal writes
     *  strategy_trades to). */
    journalDb: TrendFollowingGateJournalDb;
    /** Earliest exitedAt (inclusive) to include in the PnL sum.
     *  Defaults to TF_GATE_DEFAULT_BASELINE_ISO (Phase 2 ramp date). */
    baselineIso?: string;
    /** The function is a no-op until wall-clock reaches this date.
     *  Defaults to TF_GATE_DEFAULT_EVAL_AFTER_ISO. */
    evalAfterIso?: string;
    /** Override for testing. Defaults to new Date(). */
    now?: Date;
}
interface EvaluateTrendFollowingGateResult {
    /** False when the eval cutoff hasn't been reached yet — a no-op. */
    ran: boolean;
    /** Total trend-following PnL since baseline. null when ran=false. */
    pnl: number | null;
    /** Closed trade count contributing to the PnL sum. */
    closedTrades: number;
    /** True when this call set the mode to "off". */
    modeFlipped: boolean;
    /** Mode the gate observed before any flip. */
    previousMode: TrendFollowingMode | null;
    /** Human-readable summary suitable for logs / iMessage. */
    reason: string;
}
declare function evaluateTrendFollowingGate(input: EvaluateTrendFollowingGateInput): EvaluateTrendFollowingGateResult;
declare const trendFollowingStrategy: Strategy;

/**
 * Breakout Strategy
 *
 * Logic: Detect Bollinger Band squeeze (low bandwidth) followed by a breakout
 * with volume expansion. Enter in the direction of the breakout.
 *
 * Best in: Markets transitioning from consolidation to trend.
 * Weak in: Low-liquidity markets with false breakouts.
 */
declare const breakoutStrategy: Strategy;

interface RsiDivergenceBranchCounters {
    noPivots: number;
    distanceOutOfRange: number;
    noDivergence: number;
    rsiOutOfBand: number;
    priceNotConfirming: number;
    macdNotTurning: number;
}
interface RsiDivergenceCounters {
    evaluations: number;
    preconditionFailed: number;
    signals: {
        long: number;
        short: number;
    };
    bullish: RsiDivergenceBranchCounters;
    bearish: RsiDivergenceBranchCounters;
}
/** Snapshot of the per-conjunct counters since the last reset. */
declare function getRsiDivergenceCounters(): RsiDivergenceCounters;
/** Zero out the counters. Useful at the start of a 24h soak window. */
declare function resetRsiDivergenceCounters(): void;
declare const rsiDivergenceStrategy: Strategy;

/**
 * Learner Momentum Strategy
 *
 * Logic: Trades on patterns discovered by the MarketLearner rather than
 * traditional indicator crossovers. The learner has accumulated real
 * market observations (momentum_hour, imbalance_shift) with confidence
 * scores. This strategy checks if the current UTC hour matches a
 * high-confidence pattern for the symbol and generates signals accordingly.
 *
 * Best in: Markets where the learner has accumulated enough data to
 * surface statistically significant hourly momentum patterns.
 *
 * Filters: RSI must be in 20-80 range (avoid extreme conditions).
 * RSI alignment boosts or reduces confidence.
 */
interface LearnerPattern {
    type: string;
    confidence: number;
    hourOfDay: number | null;
    details: Record<string, unknown>;
}
type GetPatternsFn = (pair: string, minConf?: number) => LearnerPattern[];
declare function createLearnerMomentumStrategy(getPatterns: GetPatternsFn): Strategy;

type GetFundingStatsFn = (symbol: string, exchange: string) => FundingRateStats | null;
declare function createFundingSqueezeFadeStrategy(getFundingStats: GetFundingStatsFn): Strategy;

/**
 * Long when close breaks ABOVE the highest high of the prior N bars; short when it
 * breaks BELOW the lowest low of the prior N bars. Stop is an ATR-distance trailing
 * stop (trailingStopPct derived from ATR/price); take-profit set by takeProfitRatio.
 *
 * Distinct from the existing "trend-following" (which gates on MA stacks + ADX and
 * produces ~0 trades): a clean channel-breakout that fires whenever price makes a
 * new N-bar extreme, so it actually generates signals on real data.
 */
declare const donchianTrendStrategy: Strategy;
/**
 * Detect a volatility squeeze via Bollinger bandwidth percentile: bandwidth one bar
 * ago sits in the bottom SQUEEZE_PERCENTILE of the last SQUEEZE_LOOKBACK bars. Then
 * enter when bandwidth EXPANDS and price exits the band in the breakout direction.
 *
 * Distinct from "breakout" (which uses an 0.8×-average heuristic + a 2-candle
 * confirmation + VWAP): this anchors on a percentile-ranked squeeze over a longer
 * window and fires on the first expansion bar that closes outside the band.
 */
declare const squeezeBreakoutStrategy: Strategy;
/**
 * Opening-range breakout using the UTC session boundaries from session-filter.ts.
 * Within the current session, the first ORB_OPENING_BARS bars define the opening
 * range [rangeHigh, rangeLow]. After the opening window, enter on a close above
 * rangeHigh (long) or below rangeLow (short). One signal-eligible window per
 * session; flat by session end (the engine exits on stop/TP — we never hold across
 * the session via a wide TP cap and ATR stop).
 *
 * Structurally distinct from any existing built-in: it is anchored to clock-based
 * session opens, not to indicator crossovers.
 */
declare const sessionOrbStrategy: Strategy;
/**
 * Larry Connors' "RSI(2)" mean-reversion. Long when a short-period RSI is deeply
 * oversold (<5) while price is ABOVE the 200-SMA (i.e. buy dips in an uptrend);
 * the documented exit is "close back above the 5-SMA" — we encode that as the
 * take-profit reference. Symmetric short below the 200-SMA when RSI is overbought.
 *
 * Note: the precomputed `indicators.rsi` is RSI(14), not RSI(2). Connors uses a
 * 2-period RSI, so we compute RSI(2) locally from closes (the only way to honor
 * the actual mechanism — the shared IndicatorValues has no RSI(2) field).
 */
declare const connorsRsi2Strategy: Strategy;
/** All four experiment strategies — consumed by scripts/edge-search.mjs. */
declare const EDGE_EXPERIMENT_STRATEGIES: Strategy[];

type WalkForwardRegimeLabel = "TREND" | "MEAN_REVERT" | "CHOPPY";
interface WalkForwardValidatorConfig {
    trainDays: number;
    testDays: number;
    stepDays: number;
    excludeRecentCandles: number;
    outOfSampleSharpeFloor: number;
    maxTestDrawdownPct: number;
    /** Minimum test trades a window needs to count toward the OOS aggregate —
     * smaller windows yield degenerate per-window Sharpe ratios (±huge values). */
    minTradesPerWindow: number;
    /** Minimum total out-of-sample trades (across qualifying windows) before a
     * Sharpe-based verdict is trustworthy; below this → INSUFFICIENT_DATA. */
    minOosTrades: number;
    backtest: Partial<BacktestConfig>;
}
interface WalkForwardWindowMetrics {
    trades: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    profitFactor: number;
    totalPnl: number;
}
interface WalkForwardWindow {
    trainStartDate: string;
    trainEndDate: string;
    testStartDate: string;
    testEndDate: string;
    trainCandles: number;
    testCandles: number;
    train: WalkForwardWindowMetrics;
    test: WalkForwardWindowMetrics;
    marketRegime: MarketRegime;
    regimeLabel: WalkForwardRegimeLabel;
    adx: number;
    rollingVolatilityPct: number;
}
interface WalkForwardValidationResult {
    verdict: "VALIDATED" | "REJECTED" | "INSUFFICIENT_DATA";
    reason: string;
    trainCandles: number;
    testCandles: number;
    outOfSampleSharpe: number;
    outOfSampleTotalPnl: number;
    maxTestDrawdownPct: number;
    windows: WalkForwardWindow[];
}
declare class WalkForwardValidator {
    private config;
    constructor(config?: Partial<WalkForwardValidatorConfig>);
    run(strategy: Strategy, candles: Candle[]): WalkForwardValidationResult;
}

interface RegimeValidationPipelineConfig {
    lookbackDays: number;
    walkForwardDays: number;
    stepDays: number;
    excludeRecentCandles: number;
    rollingSharpeFloor: number;
    fourteenDayDrawdownLimitPct: number;
    backtest: Partial<BacktestConfig>;
}
interface RollingValidationWindow {
    startDate: string;
    endDate: string;
    trades: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    profitFactor: number;
    totalPnl: number;
    regime: MarketRegime;
    regimeLabel: WalkForwardRegimeLabel;
    volatilityPct: number;
    volatilityBucket: "low" | "normal" | "high";
}
interface RetrainingTarget {
    strategyName: string;
    symbol: string;
    regime: MarketRegime;
    volatilityBucket: "low" | "normal" | "high";
    trades: number;
    totalPnl: number;
    sharpeRatio: number;
    weight: number;
    reason: string;
}
interface RollingValidationResult {
    verdict: "VALIDATED" | "SUSPEND";
    reason: string;
    lookbackCandles: number;
    walkForwardCandles: number;
    rollingSharpeRatio: number;
    fourteenDayDrawdownPct: number;
    windows: RollingValidationWindow[];
    retrainingTargets: RetrainingTarget[];
}
declare class RegimeValidationPipeline {
    private config;
    constructor(config?: Partial<RegimeValidationPipelineConfig>);
    run(strategy: Strategy, candles: Candle[]): RollingValidationResult;
}

interface TradeCostResult {
    adjustedPrice: number;
    feeAmount: number;
    feeRate: number;
    slippageBps: number;
}
declare function applySlippage(price: number, side: "BUY" | "SELL", slippageBps: number): number;
declare function computeTradeCost(params: {
    price: number;
    qty: number;
    side: "BUY" | "SELL";
    orderType: "MARKET" | "LIMIT";
    venue: string;
    feeSchedule: FeeSchedule[];
    slippageBps: number;
}): TradeCostResult;

/**
 * D1 — Real net-edge gate. A strategy is only worth promoting if its expected
 * gross edge per round trip clears a multiple of the FULL cost stack, not the
 * 10-20 bps people assume. The stack is:
 *
 *   costBps = 2×takerFee + spread + sqrtImpact + (fixedCost / notional)
 *   hurdle  = multiple × costBps / (1 − shortTermTaxRate)
 *
 * Below a capital floor, fixed per-transaction costs (gas, withdrawal, minimum
 * order slices) dominate as a percentage of tiny notional, so the strategy class
 * is structurally uncertifiable regardless of bps.
 *
 * Callers MUST pass the WORST-tier taker fee (a tiny account gets no volume
 * discount) and a realistic per-symbol spread.
 *
 * See docs/research/2026-06-13-markets-understanding-build-spec.md (D1).
 */
interface NetEdgeGateInput {
    /** Expected gross edge per round trip, in bps. */
    grossEdgeBps: number;
    /** Worst-tier taker fee, bps (charged per side; a round trip pays it twice). */
    takerFeeBps: number;
    /** Effective spread cost per round trip, bps. */
    spreadBps: number;
    /** Market-impact cost, bps (≈0 at tiny size on majors). */
    sqrtImpactBps?: number;
    /** Fixed per-round-trip cost in USD (gas, withdrawal slice). */
    fixedCostUsd?: number;
    /** Average trade notional, USD — for fixed-cost-as-bps and the capital floor. */
    avgTradeNotionalUsd: number;
    /** Short-term capital-gains rate, 0..1. Raises the hurdle. */
    shortTermTaxRate?: number;
    /** Required ratio of gross edge to tax-adjusted cost. Default 2. */
    multiple?: number;
    /**
     * Notional below which the strategy class is structurally uncertifiable.
     * Default $5,000. Pass `0` to disable the floor (per-trade bps filter only —
     * used by the micro paper pre-trade gate at $25–$50 tickets).
     */
    capitalFloorUsd?: number;
}
interface NetEdgeGateResult {
    netEdgeBps: number;
    costBps: number;
    hurdleBps: number;
    pass: boolean;
    structurallyUncertifiable: boolean;
    reason: string;
}
declare function computeNetEdgeGate(input: NetEdgeGateInput): NetEdgeGateResult;

/**
 * Pre-trade profitability screen for paper/live signal execution.
 *
 * Estimates expected gross edge from the stop/take-profit geometry (risk-reward
 * × stop distance in bps), then runs the D1 net-edge gate with capital floor
 * disabled so $25–$50 paper tickets can still be filtered by bps economics.
 *
 * Goal: only enter when the planned TP can clear 2× round-trip fees+spread+slip
 * (and optional tax). Stops fee-bleed scalps that cannot pay for themselves.
 */

interface PreTradeEdgeInput {
    symbol: string;
    direction: "long" | "short";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    /** Planned notional in USD (qty * entry). Used only for cost stack. */
    notionalUsd: number;
    /** Round-trip spread assumption, bps. Default 10. */
    spreadBps?: number;
    /** One-way modeled paper slip, bps (doubled for RT). Default 10. */
    slippageBps?: number;
    /** Required multiple of tax-adjusted cost. Default 2. */
    multiple?: number;
    /** Minimum reward:risk (TP dist / SL dist). Default 2. */
    minRiskReward?: number;
    /** Tax rate 0..1 applied to winners. Default 0 for pure paper expectancy. */
    shortTermTaxRate?: number;
    feeSchedule?: FeeSchedule[];
    /** Override taker fee bps (one side). */
    takerFeeBps?: number;
}
interface PreTradeEdgeResult {
    pass: boolean;
    grossEdgeBps: number;
    riskReward: number;
    stopBps: number;
    tpBps: number;
    netEdge: NetEdgeGateResult;
    reason: string;
}
/** Absolute distance from entry to stop/TP as fraction of entry, in bps. */
declare function priceDistanceBps(entry: number, level: number): number;
/**
 * Gross edge proxy: full take-profit distance in bps (what we capture if TP hits).
 * Conservative: we do not blend win-rate here — the hurdle multiple covers that.
 */
declare function estimateGrossEdgeBpsFromLevels(entry: number, stop: number, takeProfit: number): {
    grossEdgeBps: number;
    stopBps: number;
    tpBps: number;
    riskReward: number;
};
declare function evaluatePreTradeEdge(input: PreTradeEdgeInput): PreTradeEdgeResult;

/**
 * Technical indicators — pure functions, no side effects.
 * All take number arrays and return number arrays.
 * Output arrays are aligned to the END of the input:
 *   input length N, period P → output length N - P + 1
 */
/** Simple Moving Average */
declare function sma(prices: number[], period: number): number[];
/** Exponential Moving Average */
declare function ema(prices: number[], period: number): number[];
type EmaCrossType = "golden_cross" | "death_cross";
/** One confirmed EMA crossover on bar close (index = last bar of the cross bar in `prices`). */
interface EmaCrossSignal {
    type: EmaCrossType;
    /** Index into `prices` where the crossover is detected (after both EMAs are defined). */
    index: number;
    price: number;
}
/**
 * Detect EMA crossovers (fast vs slow) on closing prices — **bar close** semantics.
 * Uses the same EMA alignment as {@link macd}: `offset = fastEma.length - slowEma.length`.
 * - **golden_cross:** prior bar fast ≤ slow **and** current fast > slow.
 * - **death_cross:** prior bar fast ≥ slow **and** current fast < slow.
 * (`index` / `price` refer to the **current** bar in `prices` where the cross is detected.)
 */
declare function detectEmaCrossovers(prices: number[], fastPeriod: number, slowPeriod: number): EmaCrossSignal[];
/** Relative Strength Index */
declare function rsi(prices: number[], period?: number): number[];
/** MACD (Moving Average Convergence Divergence) */
declare function macd(prices: number[], fastPeriod?: number, slowPeriod?: number, signalPeriod?: number): {
    macd: number[];
    signal: number[];
    histogram: number[];
};
/** Bollinger Bands — O(N) rolling sum and sum-of-squares (variance = E[x²] − E[x]²) */
declare function bollingerBands(prices: number[], period?: number, stdDevMultiplier?: number): {
    upper: number[];
    middle: number[];
    lower: number[];
};
/** Average True Range — measures volatility */
declare function atr(highs: number[], lows: number[], closes: number[], period?: number): number[];
/** Volume Weighted Average Price */
declare function vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number[];
/**
 * Stochastic RSI — RSI applied to RSI values.
 * O(N) implementation using monotonic deques for rolling min and max,
 * eliminating per-window slice/spread allocations.
 */
declare function stochRsi(prices: number[], rsiPeriod?: number, stochPeriod?: number): number[];
/** On-Balance Volume */
declare function obv(closes: number[], volumes: number[]): number[];

type index_EmaCrossSignal = EmaCrossSignal;
type index_EmaCrossType = EmaCrossType;
declare const index_atr: typeof atr;
declare const index_bollingerBands: typeof bollingerBands;
declare const index_detectEmaCrossovers: typeof detectEmaCrossovers;
declare const index_ema: typeof ema;
declare const index_macd: typeof macd;
declare const index_obv: typeof obv;
declare const index_rsi: typeof rsi;
declare const index_sma: typeof sma;
declare const index_stochRsi: typeof stochRsi;
declare const index_vwap: typeof vwap;
declare namespace index {
  export { type index_EmaCrossSignal as EmaCrossSignal, type index_EmaCrossType as EmaCrossType, index_atr as atr, index_bollingerBands as bollingerBands, index_detectEmaCrossovers as detectEmaCrossovers, index_ema as ema, index_macd as macd, index_obv as obv, index_rsi as rsi, index_sma as sma, index_stochRsi as stochRsi, index_vwap as vwap };
}

/**
 * TradeNotifier — formats trade alerts and determines escalation.
 *
 * Produces human-readable messages for trade lifecycle events and
 * identifies critical situations that warrant iMessage escalation.
 */
interface TradeEvent {
    type: "open" | "close" | "stop_triggered" | "flash_crash" | "circuit_break";
    symbol: string;
    details: Record<string, unknown>;
}
declare class TradeNotifier {
    /**
     * Format a trade event into a human-readable alert message.
     */
    formatTradeAlert(event: TradeEvent): string;
    /**
     * Determine whether a trade event should be escalated (iMessage, etc.).
     * Critical events: flash crash, circuit break, or large losses > $50.
     */
    shouldEscalate(event: TradeEvent): boolean;
    /**
     * Format an urgent escalation message suitable for iMessage delivery.
     */
    getEscalationMessage(event: TradeEvent): string;
    private fmtNum;
}

interface WebhookAlertPayload {
    eventType: string;
    message: string;
    severity: "info" | "warning" | "critical";
    timestamp: string;
}
declare class WebhookAlerter {
    private readonly webhookUrl;
    constructor(webhookUrl: string);
    send(payload: WebhookAlertPayload): Promise<void>;
}

/**
 * AlertEscalation — tracks raised alerts and identifies unacknowledged
 * critical alerts that need escalation.
 */
type AlertSeverity = "info" | "warning" | "critical";
interface Alert {
    id: string;
    message: string;
    severity: AlertSeverity;
    raisedAt: number;
    acknowledged: boolean;
    acknowledgedAt?: number;
}
interface AlertEscalationConfig {
    /** Timeout in ms before an unacknowledged critical alert needs escalation (default: 300000 / 5 min). */
    acknowledgementTimeoutMs: number;
    /** Maximum number of escalation attempts per alert (default: 3). */
    maxEscalations: number;
}
declare class AlertEscalation {
    private readonly config;
    private alerts;
    private escalationCounts;
    constructor(config?: Partial<AlertEscalationConfig>);
    /**
     * Raise a new alert. If an alert with the same id already exists
     * and is not acknowledged, it is updated in place.
     */
    raiseAlert(id: string, message: string, severity: AlertSeverity): void;
    /** Acknowledge an alert by id. */
    acknowledge(id: string): void;
    /** Return all pending (unacknowledged) alerts. */
    getPendingAlerts(): Alert[];
    /**
     * Return critical alerts that are older than the acknowledgement timeout
     * and have not been escalated more than maxEscalations times.
     * Each call increments the escalation counter for returned alerts.
     */
    getUnacknowledgedCritical(): Alert[];
}

interface PortfolioSummary {
    totalTrades: number;
    openPositions: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    unrealizedPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    bestTrade: number;
    worstTrade: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    currentStreak: {
        type: "win" | "loss" | "none";
        count: number;
    };
    longestWinStreak: number;
    longestLossStreak: number;
}
interface SymbolBreakdown {
    symbol: string;
    trades: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
}
interface DayBreakdown {
    day: string;
    trades: number;
    winRate: number;
    totalPnl: number;
}
interface StrategyComparison {
    name: string;
    trades: number;
    winRate: number;
    totalPnl: number;
    avgRMultiple: number;
    profitFactor: number;
    expectancy: number;
}
interface FullAnalytics {
    portfolio: PortfolioSummary;
    bySymbol: SymbolBreakdown[];
    byDay: DayBreakdown[];
    equityHigh: number;
    equityLow: number;
}
/**
 * Analyzes actual trading performance from closed positions and strategy trades.
 * Pure functions — no DB dependency, works on arrays.
 */
declare class PortfolioAnalyzer {
    /**
     * Compute full portfolio analytics from closed positions.
     */
    analyze(allPositions: Position[], equitySnapshots: {
        equity: number;
    }[]): FullAnalytics;
    private computeSummary;
    private breakdownBySymbol;
    private breakdownByDay;
    /**
     * Compare strategies side-by-side using strategy trade records.
     */
    compareStrategies(trades: StrategyTradeRecord[]): StrategyComparison[];
}

/**
 * Adapts the existing CryptoClient to the Exchange interface.
 */
declare class CryptoComAdapter implements Exchange {
    readonly name = "crypto-com";
    readonly label = "Crypto.com Exchange";
    private client;
    constructor(config?: {
        apiKey?: string;
        apiSecret?: string;
    });
    get hasCredentials(): boolean;
    /** Expose the underlying client for direct use when needed */
    getClient(): CryptoClient;
    getTicker(symbol: string): Promise<Ticker>;
    getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
    getCandles(symbol: string, timeframe: string): Promise<CandleData[]>;
    getBalances(): Promise<Balance[]>;
    createOrder(params: {
        symbol: string;
        side: "BUY" | "SELL";
        type: "MARKET" | "LIMIT";
        qty: number;
        price?: number;
    }): Promise<TradeResult>;
    cancelOrder(symbol: string, orderId: string): Promise<{
        orderId: string;
        status: string;
    }>;
    getOpenOrders(symbol?: string): Promise<TradeResult[]>;
}

interface MacroPatternEdge {
    label: string;
    sampleSize: number;
    hitRate: number;
    baselineHitRate: number;
    uplift: number;
    avgForwardReturn: number;
    currentMatch: boolean;
    direction: "bullish" | "bearish";
    strength: "weak" | "moderate" | "strong";
}
interface MineMacroPatternOptions {
    X: number[][];
    y: number[];
    forwardLogRet: number[];
    datesRow: string[];
    liveRow?: number[] | null;
    liveDate?: string | null;
    maxPatterns?: number;
    minSample?: number;
}
declare function mineMacroPatternEdges(options: MineMacroPatternOptions): MacroPatternEdge[];

/**
 * Walk-forward validation with L2-regularized logistic regression (batch gradient descent).
 * No external ML dependencies — suitable for macro feature panels.
 */
interface WalkForwardConfig {
    /** Trading days per test block */
    testDays: number;
    /** Minimum training rows before first test */
    minTrainRows: number;
    /** Gradient descent steps per fold */
    epochs: number;
    learningRate: number;
    l2Lambda: number;
}
declare function trainLogisticRegression(X: number[][], y: number[], config?: Partial<WalkForwardConfig>): {
    w: number[];
    b: number;
    loss: number;
};
declare function predictProba(w: number[], b: number, x: number[]): number;
interface WalkForwardFoldResult {
    trainStartIdx: number;
    trainEndIdx: number;
    testStartIdx: number;
    testEndIdx: number;
    accuracy: number;
    baselineAccuracy: number;
    nTest: number;
}
interface WalkForwardReport {
    folds: WalkForwardFoldResult[];
    meanAccuracy: number;
    meanBaseline: number;
    /** Mean |weight| across folds (last epoch) for interpretability */
    featureImportance: {
        name: string;
        meanAbsWeight: number;
    }[];
}
declare function runWalkForward(X: number[][], y: number[], featureNames: readonly string[], config?: Partial<WalkForwardConfig>): WalkForwardReport;

/**
 * Orchestrates Yahoo multi-asset fetch, SPY regime labels, feature construction,
 * walk-forward logistic evaluation, and a live directional probability for each target.
 */

interface MacroPredictionTargetResult {
    symbol: string;
    walkForwardMeanAccuracy: number;
    walkForwardMeanBaseline: number;
    accuracyLiftVsBaseline: number;
    foldCount: number;
    liveAsOfDate: string | null;
    probUpNextHorizon: number | null;
    predictedDirection: "up" | "down" | null;
    featureImportanceTop5: {
        name: string;
        meanAbsWeight: number;
    }[];
    topPatternEdges: MacroPatternEdge[];
}
interface MacroPredictionReport {
    generatedAt: string;
    dataSource: string;
    sourcesUsed: string[];
    seriesSources: Record<string, string[]>;
    fetchErrors: {
        symbol: string;
        error: string;
    }[];
    horizonDays: number;
    period: {
        start: string;
        end: string;
        days: number;
    };
    crossAssetSummary: {
        profiles: {
            symbol: string;
            cagr: number;
            maxDrawdown: number;
            sharpeRatio: number;
        }[];
    };
    targets: MacroPredictionTargetResult[];
    notes: string[];
}
interface RunMacroPredictionOptions {
    symbols?: string[];
    /** Calendar years of history to request from Yahoo (default 10) */
    years?: number;
    horizonDays?: number;
    walkForward?: Partial<WalkForwardConfig>;
}
declare function runMacroPredictionReport(options?: RunMacroPredictionOptions): Promise<MacroPredictionReport>;

/**
 * Builds supervised-learning feature rows from aligned multi-asset daily closes.
 * Encodes: momentum/vol for the target, SPY trend (50/200), cross-asset ratios
 * (gold/silver, BTC/gold), Bitcoin halving cycle phase (sin/cos), and SPY regime.
 */

declare const MACRO_FEATURE_NAMES: readonly ["target_ret_1d", "target_ret_5d", "target_ret_20d", "target_vol_20d", "spy_sma_spread", "log_gld_slv_ratio_5d", "log_btc_gld_ratio_5d", "halving_sin", "halving_cos", "regime_bull", "regime_bear", "regime_sideways", "regime_volatile"];
interface AlignedPanel {
    dates: string[];
    prices: Record<string, number[]>;
    symbols: string[];
}
/**
 * Align series to intersection of trading dates (same logic as CrossAssetAnalyzer).
 */
declare function alignAssetSeries(series: AssetSeries[]): AlignedPanel;
/** Whole months since last halving (calendar months, UTC). */
declare function monthsSinceLastHalving(dateIso: string): number;

/**
 * Lightweight XRPL JSON-RPC client.
 * Uses native fetch + Zod validation.
 * Connects to public XRPL nodes for DEX data.
 */
interface XRPLCurrency {
    /** "XRP" for native, or token code (e.g., "SOLO", "USD") */
    currency: string;
    /** Issuer address — omitted for XRP */
    issuer?: string;
}
interface XRPLBookEntry {
    price: number;
    quantity: number;
    account: string;
}
interface XRPLOrderBook {
    base: XRPLCurrency;
    quote: XRPLCurrency;
    bids: XRPLBookEntry[];
    asks: XRPLBookEntry[];
    midPrice: number | null;
    spread: number | null;
    spreadPct: number | null;
    timestamp: number;
}
interface XRPLTrustLine {
    account: string;
    currency: string;
    balance: string;
    limit: string;
}
interface XRPLClientConfig {
    rpcUrl?: string;
}
/** Well-known XRPL token issuers */
declare const KNOWN_ISSUERS: Record<string, {
    currency: string;
    issuer: string;
    name: string;
}>;
/** Common XRPL DEX trading pairs */
declare const DEX_PAIRS: {
    base: XRPLCurrency;
    quote: XRPLCurrency;
    label: string;
}[];
declare class XRPLClient {
    private rpcUrl;
    constructor(config?: XRPLClientConfig);
    /** Send a JSON-RPC request to the XRPL node */
    private rpc;
    /** Get order book for a currency pair */
    getOrderBook(base: XRPLCurrency, quote: XRPLCurrency, limit?: number): Promise<XRPLOrderBook>;
    /** Get account info (balance, sequence, etc.) */
    getAccountInfo(address: string): Promise<{
        balance: number;
        sequence: number;
        ownerCount: number;
        reserve: number;
    }>;
    /** Get trust lines for an account */
    getTrustLines(address: string): Promise<XRPLTrustLine[]>;
    /** Get server info (fee, ledger sequence, etc.) */
    getServerInfo(): Promise<{
        ledgerIndex: number;
        baseFeeXRP: number;
        serverState: string;
    }>;
    /** Parse a raw XRPL offer into a price/quantity entry */
    private parseOffer;
    /** Parse an XRPL amount (drops string for XRP, or {currency, value, issuer} for tokens) */
    private parseAmount;
}

/**
 * Market Learner — records daily market observations and discovers patterns.
 *
 * Tracks:
 * - Price movements by time of day (hourly buckets)
 * - Spread patterns (when are spreads widest/tightest?)
 * - Volume & liquidity shifts across sessions
 * - Recurring setups (e.g., "SOLO/XRP spread widens every day at 14:00 UTC")
 * - Order book imbalance trends
 *
 * All data is stored in SQLite alongside the existing trading store.
 * Over time, Zaraa builds intuition about when/where opportunities appear.
 */

interface MarketObservation {
    pair: string;
    midPrice: number | null;
    spreadPct: number | null;
    bidDepth: number;
    askDepth: number;
    imbalanceRatio: number;
    timestamp: number;
}
interface HourlyPattern {
    hour: number;
    avgSpreadPct: number;
    avgImbalance: number;
    avgPriceChangePct: number;
    sampleCount: number;
    bestOpportunityType: string | null;
}
interface DailyDigest {
    date: string;
    pair: string;
    openPrice: number | null;
    closePrice: number | null;
    highPrice: number | null;
    lowPrice: number | null;
    changePct: number | null;
    avgSpreadPct: number;
    avgImbalance: number;
    observations: number;
    patterns: string[];
}
interface LearnedPattern {
    id: string;
    pair: string;
    type: string;
    description: string;
    confidence: number;
    hourOfDay: number | null;
    dayOfWeek: number | null;
    details: Record<string, unknown>;
    firstSeen: string;
    lastSeen: string;
    occurrences: number;
}
declare class MarketLearner {
    private db;
    constructor(db: Database.Database);
    private initTables;
    /** Record a single market observation from the DEX watcher */
    recordObservation(obs: MarketObservation): void;
    /** Get hourly patterns for a pair (what does each hour of the day look like?) */
    getHourlyPatterns(pair: string, days?: number): HourlyPattern[];
    /** Generate a daily digest for a pair */
    generateDailyDigest(pair: string, date?: string): DailyDigest | null;
    /** Analyze observations and learn recurring patterns */
    learnPatterns(pair: string, days?: number): LearnedPattern[];
    /** Get all learned patterns for a pair, sorted by confidence */
    getPatterns(pair?: string, minConfidence?: number): LearnedPattern[];
    /** Get daily digests for a pair */
    getDigests(pair: string, limit?: number): DailyDigest[];
    /** Get observation count */
    getObservationCount(pair?: string): number;
    /** Get latest observations for a pair */
    getRecentObservations(pair: string, limit?: number): MarketObservation[];
    /** Backfill daily digests for all dates that have observations but no digest */
    backfillDigests(): number;
    /** Clean up old observations (keep last N days) */
    prune(keepDays?: number): number;
    /** Get a summary of what Zaraa has learned across all pairs */
    getLearningSummary(): {
        totalObservations: number;
        pairsTracked: string[];
        patternsLearned: number;
        topPatterns: LearnedPattern[];
        digestCount: number;
    };
    private upsertPattern;
}

/**
 * XRPL DEX Watcher — monitors order books and detects trading opportunities.
 *
 * Capabilities:
 * - Scans multiple trading pairs on XRPL DEX
 * - Detects spread capture opportunities (market making)
 * - Finds order book imbalances (momentum signals)
 * - Tracks volume and liquidity changes
 * - Compares order book vs AMM pricing (arb detection)
 * - All observations feed into the Market Learner
 */

interface WatchedPair {
    base: XRPLCurrency;
    quote: XRPLCurrency;
    label: string;
}
interface Opportunity {
    type: "spread_capture" | "momentum" | "imbalance" | "depth_gap";
    pair: string;
    confidence: number;
    description: string;
    details: Record<string, unknown>;
    detectedAt: number;
}
interface DEXSnapshot {
    pair: string;
    midPrice: number | null;
    spreadPct: number | null;
    bidDepth: number;
    askDepth: number;
    imbalanceRatio: number;
    topBidPrice: number | null;
    topAskPrice: number | null;
    bidLevels: number;
    askLevels: number;
    timestamp: number;
}
interface DEXWatcherConfig {
    /** Minimum spread % to flag as spread capture opportunity */
    minSpreadPctForCapture: number;
    /** Minimum imbalance ratio to flag momentum */
    minImbalanceRatio: number;
    /** Minimum confidence threshold for reporting opportunities */
    minConfidence: number;
}
declare class XRPLDEXWatcher {
    private client;
    private learner;
    private pairs;
    private config;
    private lastSnapshots;
    private snapshotHistory;
    private readonly MAX_HISTORY;
    constructor(client: XRPLClient, pairs: WatchedPair[], config?: Partial<DEXWatcherConfig>, learner?: MarketLearner | null);
    /** Scan all watched pairs and return opportunities */
    scan(): Promise<{
        snapshots: DEXSnapshot[];
        opportunities: Opportunity[];
        errors: string[];
    }>;
    /** Get the latest snapshot for a pair */
    getLatest(pair: string): DEXSnapshot | undefined;
    /** Get snapshot history for a pair */
    getHistory(pair: string, limit?: number): DEXSnapshot[];
    /** Get summary across all pairs */
    getSummary(): {
        pairs: {
            label: string;
            midPrice: number | null;
            spreadPct: number | null;
            imbalance: number;
        }[];
        bestSpread: {
            pair: string;
            spreadPct: number;
        } | null;
        strongestImbalance: {
            pair: string;
            ratio: number;
            direction: "buy" | "sell";
        } | null;
    };
    /** Update watched pairs */
    setPairs(pairs: WatchedPair[]): void;
    addPair(pair: WatchedPair): void;
    getPairs(): WatchedPair[];
    private buildSnapshot;
    private detectOpportunities;
}

/**
 * Tool handlers for XRPL DEX watching, market learning, and opportunity detection.
 * These integrate with the existing trading plugin architecture.
 */

interface XRPLHandlerDeps {
    client: XRPLClient;
    watcher: XRPLDEXWatcher;
    learner: MarketLearner;
}
declare function createXRPLHandlers(deps: XRPLHandlerDeps): {
    /** Scan the XRPL DEX for all watched pairs — returns order book snapshots and opportunities */
    xrpl_scan_dex: () => Promise<string>;
    /** Get the order book for a specific XRPL DEX trading pair */
    xrpl_get_orderbook: (args: Record<string, unknown>) => Promise<string>;
    /** Get the DEX summary across all watched pairs */
    xrpl_dex_summary: () => Promise<string>;
    /** Get XRPL account info (balance, reserves, trust lines) */
    xrpl_account_info: (args: Record<string, unknown>) => Promise<string>;
    /** Get what Zaraa has learned about market patterns */
    xrpl_learned_patterns: (args: Record<string, unknown>) => Promise<string>;
    /** Get hourly patterns for a pair — when do spreads widen, when does momentum hit? */
    xrpl_hourly_patterns: (args: Record<string, unknown>) => Promise<string>;
    /** Get daily digest for a pair — what happened today/on a specific date? */
    xrpl_daily_digest: (args: Record<string, unknown>) => Promise<string>;
    /** Get recent daily digests for a pair */
    xrpl_digest_history: (args: Record<string, unknown>) => Promise<string>;
    /** Get snapshot history for a pair — recent price/depth observations */
    xrpl_price_history: (args: Record<string, unknown>) => Promise<string>;
    /** Get XRPL server info (ledger status, fees) */
    xrpl_server_info: () => Promise<string>;
};

/**
 * CEX Market Watcher — monitors centralized exchange pairs (Crypto.com)
 * and feeds observations into the Market Learner.
 *
 * Mirrors the XRPL DEX Watcher pattern but uses Crypto.com ticker + order book data.
 * Tracks: FLR, SOL, XLM, and any other USDT pairs you add.
 */

interface CexWatchedSymbol {
    symbol: string;
    label: string;
}
interface CexSnapshot {
    symbol: string;
    label: string;
    last: number;
    bid: number;
    ask: number;
    spreadPct: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    change24h: number;
    bidDepth: number;
    askDepth: number;
    imbalanceRatio: number;
    timestamp: number;
}
interface CexOpportunity {
    type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "volume_spike";
    symbol: string;
    confidence: number;
    description: string;
    details: Record<string, unknown>;
    detectedAt: number;
}
interface CexWatcherConfig {
    minSpreadPctForCapture: number;
    minImbalanceRatio: number;
    minConfidence: number;
    /** % change in 24h to flag as high volatility */
    volatilityThreshold: number;
}
declare class CexMarketWatcher {
    private client;
    private learner;
    private symbols;
    private config;
    private lastSnapshots;
    private snapshotHistory;
    private readonly MAX_HISTORY;
    constructor(client: CryptoClient, symbols: CexWatchedSymbol[], config?: Partial<CexWatcherConfig>, learner?: MarketLearner | null);
    /** Scan all watched symbols — fetches ticker + order book, detects opportunities */
    scan(): Promise<{
        snapshots: CexSnapshot[];
        opportunities: CexOpportunity[];
        errors: string[];
    }>;
    getLatest(label: string): CexSnapshot | undefined;
    getHistory(label: string, limit?: number): CexSnapshot[];
    getSummary(): {
        symbols: {
            label: string;
            last: number;
            change24h: string;
            spreadPct: number;
            imbalance: number;
        }[];
        mostVolatile: {
            label: string;
            change24h: number;
        } | null;
        bestSpread: {
            label: string;
            spreadPct: number;
        } | null;
        strongestImbalance: {
            label: string;
            ratio: number;
            direction: "buy" | "sell";
        } | null;
    };
    setSymbols(symbols: CexWatchedSymbol[]): void;
    addSymbol(sym: CexWatchedSymbol): void;
    getSymbols(): CexWatchedSymbol[];
    private buildSnapshot;
    private detectOpportunities;
}

/**
 * Tool handlers for CEX (centralized exchange) market watching and learning.
 * Covers tokens like FLR, SOL, XLM on Crypto.com.
 */

interface CexHandlerDeps {
    watcher: CexMarketWatcher;
    learner: MarketLearner;
}
declare function createCexHandlers(deps: CexHandlerDeps): {
    /** Scan all watched CEX symbols — returns snapshots and opportunities */
    cex_scan_markets: () => Promise<string>;
    /** Get CEX market summary across all watched symbols */
    cex_market_summary: () => Promise<string>;
    /** Get learned patterns for CEX-traded tokens */
    cex_learned_patterns: (args: Record<string, unknown>) => Promise<string>;
    /** Get hourly patterns for a CEX symbol */
    cex_hourly_patterns: (args: Record<string, unknown>) => Promise<string>;
    /** Get daily digest for a CEX symbol */
    cex_daily_digest: (args: Record<string, unknown>) => Promise<string>;
    /** Get snapshot history for a CEX symbol */
    cex_price_history: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Stellar DEX client — talks to Horizon API.
 * Stellar has a native order-book DEX built into the protocol (like XRPL).
 */
interface StellarAsset {
    type: "native" | "credit_alphanum4" | "credit_alphanum12";
    code?: string;
    issuer?: string;
}
interface StellarOrderBookEntry {
    price: number;
    amount: number;
}
interface StellarOrderBook {
    base: StellarAsset;
    counter: StellarAsset;
    bids: StellarOrderBookEntry[];
    asks: StellarOrderBookEntry[];
    midPrice: number | null;
    spread: number | null;
    spreadPct: number | null;
    timestamp: number;
}
interface StellarTrade {
    id: string;
    baseAmount: number;
    counterAmount: number;
    price: number;
    timestamp: string;
    baseIsSeller: boolean;
}
/** Well-known Stellar tokens */
declare const STELLAR_ASSETS: Record<string, StellarAsset & {
    name: string;
}>;
/** Common Stellar DEX trading pairs */
declare const STELLAR_PAIRS: {
    base: StellarAsset;
    counter: StellarAsset;
    label: string;
}[];
declare class StellarClient {
    private horizon;
    constructor(horizon?: string);
    /** Get order book for a trading pair */
    getOrderBook(base: StellarAsset, counter: StellarAsset, limit?: number): Promise<StellarOrderBook>;
    /** Get recent trades for a pair */
    getTrades(base: StellarAsset, counter: StellarAsset, limit?: number): Promise<StellarTrade[]>;
    /** Get account balances */
    getAccountBalances(address: string): Promise<{
        xlm: number;
        tokens: {
            code: string;
            issuer: string;
            balance: number;
        }[];
    }>;
    /** Get trade aggregations (candle-like data) */
    getTradeAggregations(base: StellarAsset, counter: StellarAsset, resolution?: number, // 1 hour in ms
    limit?: number): Promise<{
        timestamp: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }[]>;
    private setAssetParams;
}

/**
 * Solana DEX client — uses DexScreener API + Solana RPC.
 * Covers Jupiter, Raydium, Orca, and all major Solana DEXes.
 */
interface SolanaPair {
    pairAddress: string;
    dex: string;
    baseToken: {
        address: string;
        symbol: string;
        name: string;
    };
    quoteToken: {
        address: string;
        symbol: string;
        name: string;
    };
    label: string;
    priceUsd: number;
    priceNative: number;
    volume24h: number;
    liquidity: number;
    priceChange24h: number;
    priceChange1h: number;
    priceChange5m: number;
    txns24h: {
        buys: number;
        sells: number;
    };
    timestamp: number;
}
interface SolanaOrderBook {
    pair: string;
    dex: string;
    priceUsd: number;
    liquidity: number;
    /** Synthetic depth — estimated from liquidity pool (constant product AMM) */
    syntheticBids: {
        price: number;
        depth: number;
    }[];
    syntheticAsks: {
        price: number;
        depth: number;
    }[];
    midPrice: number;
    estimatedSpreadPct: number;
    timestamp: number;
}
/** Well-known Solana token addresses */
declare const SOLANA_TOKENS: Record<string, {
    address: string;
    name: string;
    decimals: number;
}>;
/** Default Solana DEX pairs to watch */
declare const SOLANA_WATCH_PAIRS: string[];
declare class SolanaClient {
    private rpcUrl;
    constructor(rpcUrl?: string);
    /** Get all DEX pairs for a token via DexScreener */
    getTokenPairs(tokenSymbol: string): Promise<SolanaPair[]>;
    /** Get the best (highest liquidity) pair for a token */
    getBestPair(tokenSymbol: string): Promise<SolanaPair | null>;
    /** Get synthetic order book from AMM pool liquidity */
    getSyntheticOrderBook(tokenSymbol: string): Promise<SolanaOrderBook | null>;
    /** Get multiple token prices in one call */
    getMultipleTokens(symbols: string[]): Promise<SolanaPair[]>;
    /** Get Solana slot (block) number */
    getSlot(): Promise<number>;
    private normalizePair;
}

/**
 * Flare DEX client — uses Flare EVM RPC + DexScreener.
 * Covers SparkDEX, BlazeSwap, and Enosys on Flare Network.
 */
interface FlarePair {
    pairAddress: string;
    dex: string;
    baseToken: {
        address: string;
        symbol: string;
        name: string;
    };
    quoteToken: {
        address: string;
        symbol: string;
        name: string;
    };
    label: string;
    priceUsd: number;
    priceNative: number;
    volume24h: number;
    liquidity: number;
    priceChange24h: number;
    priceChange1h: number;
    priceChange5m: number;
    txns24h: {
        buys: number;
        sells: number;
    };
    timestamp: number;
}
interface FlarePoolReserves {
    pairAddress: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    price: number;
    liquidity: number;
    timestamp: number;
}
/** Well-known Flare tokens */
declare const FLARE_TOKENS: Record<string, {
    address: string;
    name: string;
    decimals: number;
}>;
/** Default Flare pairs to watch */
declare const FLARE_WATCH_TOKENS: string[];
declare class FlareClient {
    private rpcUrl;
    constructor(rpcUrl?: string);
    /** Get DEX pairs for a token via DexScreener */
    getTokenPairs(tokenSymbol: string): Promise<FlarePair[]>;
    /** Get the best (highest liquidity) pair for a token */
    getBestPair(tokenSymbol: string): Promise<FlarePair | null>;
    /** Read Uniswap V2 pool reserves directly from chain */
    getPoolReserves(pairAddress: string): Promise<FlarePoolReserves | null>;
    /** Get synthetic order book from pool data */
    getSyntheticOrderBook(tokenSymbol: string): Promise<{
        pair: string;
        dex: string;
        priceUsd: number;
        liquidity: number;
        syntheticBids: {
            price: number;
            depth: number;
        }[];
        syntheticAsks: {
            price: number;
            depth: number;
        }[];
        estimatedSpreadPct: number;
        timestamp: number;
    } | null>;
    /** Get current block number */
    getBlockNumber(): Promise<number>;
    private ethCall;
    private normalizePair;
}

/**
 * Multi-chain DEX Watcher — monitors Stellar, Solana, and Flare DEXes.
 * Feeds all observations into the shared MarketLearner.
 */

interface ChainSnapshot {
    chain: "stellar" | "solana" | "flare";
    pair: string;
    dex: string;
    midPrice: number | null;
    spreadPct: number | null;
    bidDepth: number;
    askDepth: number;
    imbalanceRatio: number;
    volume24h: number;
    change24h: number;
    liquidity: number;
    txns24h: {
        buys: number;
        sells: number;
    } | null;
    timestamp: number;
}
interface ChainOpportunity {
    chain: "stellar" | "solana" | "flare";
    type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "liquidity_shift" | "buy_sell_ratio";
    pair: string;
    confidence: number;
    description: string;
    details: Record<string, unknown>;
    detectedAt: number;
}
interface MultiDEXConfig {
    stellarPairs: typeof STELLAR_PAIRS;
    solanaTokens: string[];
    flareTokens: string[];
    minConfidence: number;
}
declare class MultiDEXWatcher {
    private stellar;
    private solana;
    private flare;
    private learner;
    private config;
    private lastSnapshots;
    private snapshotHistory;
    private readonly MAX_HISTORY;
    constructor(stellar: StellarClient, solana: SolanaClient, flare: FlareClient, learner?: MarketLearner | null, config?: Partial<MultiDEXConfig>);
    /** Scan all chains */
    scanAll(): Promise<{
        snapshots: ChainSnapshot[];
        opportunities: ChainOpportunity[];
        errors: string[];
    }>;
    /** Scan Stellar DEX */
    scanStellar(): Promise<{
        snapshots: ChainSnapshot[];
        opportunities: ChainOpportunity[];
        errors: string[];
    }>;
    /** Scan Solana DEXes */
    scanSolana(): Promise<{
        snapshots: ChainSnapshot[];
        opportunities: ChainOpportunity[];
        errors: string[];
    }>;
    /** Scan Flare DEXes */
    scanFlare(): Promise<{
        snapshots: ChainSnapshot[];
        opportunities: ChainOpportunity[];
        errors: string[];
    }>;
    getLatest(key: string): ChainSnapshot | undefined;
    getHistory(key: string, limit?: number): ChainSnapshot[];
    getSummary(): {
        chains: {
            chain: string;
            pairs: {
                pair: string;
                price: number | null;
                change24h: number;
                volume24h: number;
                liquidity: number;
            }[];
        }[];
        totalPairsTracked: number;
    };
    getConfig(): MultiDEXConfig;
    updateConfig(updates: Partial<MultiDEXConfig>): void;
    private stellarToSnapshot;
    private dexscreenerToSnapshot;
    private storeSnapshot;
    private feedLearner;
    private detectOpportunities;
}

/**
 * Tool handlers for multi-chain DEX watching (Stellar, Solana, Flare).
 */

interface DEXHandlerDeps {
    stellar: StellarClient;
    solana: SolanaClient;
    flare: FlareClient;
    watcher: MultiDEXWatcher;
    learner: MarketLearner;
}
declare function createDEXHandlers(deps: DEXHandlerDeps): {
    /** Scan all on-chain DEXes: Stellar, Solana, Flare */
    dex_scan_all: () => Promise<string>;
    /** Scan only Stellar DEX */
    dex_scan_stellar: () => Promise<string>;
    /** Scan only Solana DEXes */
    dex_scan_solana: () => Promise<string>;
    /** Scan only Flare DEXes */
    dex_scan_flare: () => Promise<string>;
    /** Get Stellar DEX order book for a specific pair */
    dex_stellar_orderbook: (args: Record<string, unknown>) => Promise<string>;
    /** Get Solana DEX pool info and synthetic depth for a token */
    dex_solana_depth: (args: Record<string, unknown>) => Promise<string>;
    /** Get Flare DEX pool info and synthetic depth for a token */
    dex_flare_depth: (args: Record<string, unknown>) => Promise<string>;
    /** Get multi-chain DEX summary */
    dex_summary: () => Promise<string>;
    /** Get learned patterns across all on-chain DEXes */
    dex_learned_patterns: (args: Record<string, unknown>) => Promise<string>;
    /** Get Stellar recent trades for a pair */
    dex_stellar_trades: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Solana DEX execution via Jupiter quote + swap API (v6).
 * Paper mode uses quote-only implied price; live mode signs and sends (optional key).
 */

interface JupiterQuoteSummary {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct?: string;
    raw: Record<string, unknown>;
}
interface JupiterSwapPaperResult {
    symbol: string;
    side: "BUY" | "SELL";
    entryPriceUsd: number;
    qtyToken: number;
    notionalUsd: number;
    slippageBps: number;
    routeJson: string;
}
interface JupiterSwapLiveResult extends JupiterSwapPaperResult {
    txSignature: string;
}
interface JupiterSwapExecutorConfig {
    store: TradingStore;
    rpcUrl?: string;
    /** Base58-encoded Solana secret key (64 bytes). Live swaps only. */
    secretKeyBase58?: string;
    fetchFn?: typeof fetch;
    /**
     * Daily-rotating live-mode lock string.  Required for live swaps.
     * Format: "I-CONFIRM-LIVE-TRADING-YYYY-MM-DD" (UTC date).
     */
    liveModeLock?: string;
}
declare class JupiterSwapExecutor {
    private store;
    private rpcUrl;
    private secretKeyBase58?;
    private fetchFn;
    private liveModeLock?;
    constructor(cfg: JupiterSwapExecutorConfig);
    quoteAndSwapPaper(params: {
        tokenSymbol: string;
        direction: "long" | "short";
        qty: number;
        slippageBps?: number;
        /** Reject quotes whose priceImpactPct exceeds this value. Default 0.10 (10%). */
        maxPriceImpactPct?: number;
    }): Promise<JupiterSwapPaperResult>;
    quoteAndSwapLive(params: {
        tokenSymbol: string;
        direction: "long" | "short";
        qty: number;
        slippageBps?: number;
        /**
         * Re-validate the live-quote notionalUsd against this cap before
         * building/signing the swap.  Pass max_trade_usd from settings.
         */
        maxNotionalUsd?: number;
        /** Reject quotes whose priceImpactPct exceeds this value. Default 0.10 (10%). */
        maxPriceImpactPct?: number;
    }): Promise<JupiterSwapLiveResult>;
    /** Record paper or live open in store (trade_log + positions). */
    recordOpen(params: {
        result: JupiterSwapPaperResult | JupiterSwapLiveResult;
        direction: "long" | "short";
        stopLoss: number;
        takeProfit: number;
        trailingStopPct?: number;
        isPaper: boolean;
        feeRate?: number;
    }): {
        tradeId: string;
        positionId: string;
    };
}

/**
 * Conventions for routing signal-engine / executeTrade to on-chain execution (vs CEX).
 *
 * Symbols like `solana:SOL` mean "spot exposure to SOL on Solana" via Jupiter swaps.
 */
/** Stored on positions / trade_log when execution is Solana + Jupiter. */
declare const DEX_EXECUTION_VENUE_SOLANA = "dex_solana";
/** True if the symbol should use Jupiter / Solana swap execution instead of CryptoClient. */
declare function isDexSolanaExecutionSymbol(symbol: string): boolean;
/**
 * Parse `solana:TOKEN` or `solana:BASE/QUOTE` → base token symbol
 * (e.g. `solana:SOL` → `SOL`, `solana:SOL/USDC` → `SOL`).
 * Returns null if not a Solana dex symbol.
 *
 * BUG FIX (2026-04-26): Previously returned `SOL/USDC` for pair-format symbols,
 * causing DexScreener to match the quote currency (USDC ≈ $1) instead of the base
 * currency (SOL ≈ $86). This produced phantom ~$99 losses on every SOL/USDC close,
 * tripped the drawdown circuit breaker, and halted all trading.
 */
declare function parseSolanaDexTokenSymbol(symbol: string): string | null;

/** Spot USD price for `solana:TOKEN` via DexScreener-backed client; null if unknown. */
declare function fetchDexSolanaUsdPrice(symbol: string): Promise<number | null>;

/**
 * Dollar-Cost Averaging (DCA) Strategy
 *
 * Automatically buys a fixed USD amount of specified crypto assets on a schedule
 * (hourly/daily/weekly), regardless of price. Optionally buys extra when price
 * dips below a moving average. Tracks average cost basis and performance.
 */

declare const DCAIntervalSchema: z.ZodEnum<["hourly", "daily", "weekly"]>;
type DCAInterval = z.infer<typeof DCAIntervalSchema>;
declare const DCAConfigSchema: z.ZodObject<{
    symbol: z.ZodString;
    amountUsd: z.ZodNumber;
    interval: z.ZodEnum<["hourly", "daily", "weekly"]>;
    dipBonusPct: z.ZodOptional<z.ZodNumber>;
    dipBonusMultiplier: z.ZodDefault<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    enabled: boolean;
    amountUsd: number;
    interval: "hourly" | "daily" | "weekly";
    dipBonusMultiplier: number;
    dipBonusPct?: number | undefined;
}, {
    symbol: string;
    amountUsd: number;
    interval: "hourly" | "daily" | "weekly";
    dipBonusPct?: number | undefined;
    dipBonusMultiplier?: number | undefined;
    enabled?: boolean | undefined;
}>;
type DCAConfig = z.infer<typeof DCAConfigSchema>;
interface DCAState {
    symbol: string;
    totalInvestedUsd: number;
    totalQtyBought: number;
    avgCostBasis: number;
    lastBuyAt: string | null;
    buyCount: number;
}
/**
 * Check whether a DCA buy is due based on interval and last buy time.
 * Returns true if enough time has elapsed since the last buy (or if no buy
 * has happened yet).
 */
declare function isDue(config: DCAConfig, state: DCAState, now?: Date): boolean;
/**
 * Calculate the buy quantity for a DCA order.
 * If smaPrice is provided and the current price is dipBonusPct% below it,
 * the buy amount is multiplied by dipBonusMultiplier.
 */
declare function calculateBuyAmount(config: DCAConfig, currentPrice: number, smaPrice?: number, maxTradeUsd?: number): {
    amountUsd: number;
    isDipBuy: boolean;
};
/**
 * Update DCA state after a successful buy.
 * Returns a new state object (immutable).
 */
declare function updateState(state: DCAState, boughtQty: number, spentUsd: number, buyTime?: Date): DCAState;
/** Create a fresh DCA state for a symbol. */
declare function emptyState(symbol: string): DCAState;
interface DCAStore {
    getSetting(key: string): string | undefined;
    setSetting(key: string, value: string): void;
}
/** Load all DCA configs from the store. */
declare function loadConfigs(store: DCAStore): DCAConfig[];
/** Save all DCA configs to the store. */
declare function saveConfigs(store: DCAStore, configs: DCAConfig[]): void;
/** Load DCA state for a symbol. */
declare function loadState(store: DCAStore, symbol: string): DCAState;
/** Save DCA state for a symbol. */
declare function saveState(store: DCAStore, state: DCAState): void;
/**
 * Compute the SMA price from recent closing prices.
 * Uses a 20-period SMA by default — returns the latest value or undefined
 * when insufficient data is available.
 */
declare function computeSmaPrice(closingPrices: number[], period?: number): number | undefined;

/**
 * Portfolio rebalancing engine.
 *
 * Connects the read-only portfolio analyzers (portfolio-allocator, allocation-optimizer)
 * to actionable trade execution via trade_buy / trade_sell handlers.
 *
 * Flow:
 *   1. computeRebalancePlan() — pure calculation, no side-effects
 *   2. executeRebalancePlan() — runs sells first (to free capital), then buys
 *
 * All trades go through the normal handler pipeline which enforces:
 *   - max_trade_usd per-trade cap
 *   - daily_limit_usd daily cap
 *   - risk manager validation
 *   - circuit breaker checks
 *   - paper/live mode
 */

interface RebalanceConfig {
    /** Target allocation weights, symbol → fraction (must sum to ~1). e.g. {"BTC_USDT": 0.5, "ETH_USDT": 0.3, "SOL_USDT": 0.2} */
    targetAllocations: Record<string, number>;
    /** Only rebalance when total portfolio drift exceeds this % (default 5) */
    driftThresholdPct: number;
    /** Cap each rebalance trade at this % of total portfolio value (default 10) */
    maxTradePerRebalancePct: number;
    /** Whether automatic rebalancing is enabled */
    enabled: boolean;
}
interface RebalanceTrade {
    symbol: string;
    direction: "buy" | "sell";
    amountUsd: number;
    reason: string;
}
interface RebalancePlan {
    trades: RebalanceTrade[];
    currentAllocations: Record<string, number>;
    targetAllocations: Record<string, number>;
    totalDriftPct: number;
    totalPortfolioValueUsd: number;
    needsRebalance: boolean;
}
interface RebalanceExecutionResult {
    plan: RebalancePlan;
    executed: Array<{
        symbol: string;
        direction: "buy" | "sell";
        requestedAmountUsd: number;
        success: boolean;
        resultJson?: string;
        error?: string;
    }>;
    summary: {
        totalTradesAttempted: number;
        totalTradesSucceeded: number;
        totalTradesFailed: number;
        totalSellsUsd: number;
        totalBuysUsd: number;
    };
}
interface PositionSnapshot {
    symbol: string;
    /** Current market value in USD */
    valueUsd: number;
    /** Quantity held */
    qty: number;
    /** Current price per unit */
    currentPrice: number;
}
/** Handler functions used to execute trades */
interface RebalanceHandlers {
    trade_buy: (args: Record<string, unknown>) => Promise<string>;
    trade_sell: (args: Record<string, unknown>) => Promise<string>;
}
declare const REBALANCE_CONFIG_KEY = "rebalance_config";
/**
 * Compute a rebalance plan given config, current positions, and prices.
 * Pure function with no side-effects.
 */
declare function computeRebalancePlan(config: RebalanceConfig, positions: PositionSnapshot[], cashUsd: number): RebalancePlan;
/**
 * Execute a rebalance plan by calling trade_buy / trade_sell handlers.
 * Sells are executed first to free up capital for buys.
 */
declare function executeRebalancePlan(plan: RebalancePlan, handlers: RebalanceHandlers, prices: Record<string, number>): Promise<RebalanceExecutionResult>;
/**
 * Load saved RebalanceConfig from the trading store.
 * Returns null if not configured.
 */
declare function loadRebalanceConfig(getSetting: (key: string) => string | undefined): RebalanceConfig | null;
/**
 * Save RebalanceConfig to the trading store.
 */
declare function saveRebalanceConfig(setSetting: (key: string, value: string) => void, config: RebalanceConfig): void;

/**
 * Opportunity Trader — converts DEX/CEX watcher opportunities into paper trades.
 *
 * Works with ANY price source (XRPL DEX, Stellar DEX, Solana DEX, Flare DEX, CEX).
 * The watchers detect opportunities; this engine sizes positions, manages risk,
 * opens paper trades, and monitors for exits.
 *
 * Paper equity starts at $1,000 by default and compounds from there.
 */

/** Optional deps — `riskManager` enables `validateTrade` before paper opens. */
interface OpportunityTraderDeps {
    riskManager?: RiskManager;
}
type OpportunityTraderInit = Partial<OpportunityTraderConfig> & OpportunityTraderDeps;
interface OpportunitySignal {
    source: string;
    pair: string;
    type: "spread_capture" | "momentum" | "imbalance" | "volatility" | "buy_sell_ratio" | "depth_gap" | "liquidity_shift";
    direction: "long" | "short";
    confidence: number;
    entryPrice: number;
    description: string;
}
interface PaperPosition {
    id: string;
    source: string;
    pair: string;
    strategyType: string;
    direction: "long" | "short";
    entryPrice: number;
    qty: number;
    currentPrice: number;
    pnl: number;
    pnlPct: number;
    stopLoss: number;
    takeProfit: number;
    openedAt: number;
    /** Max age in ms before forced exit (default: 4h for momentum, 1h for spread) */
    maxAgeMs: number;
    /** UUID returned by store.openPosition — set when the position is also
     * persisted to the `positions` table so it can be closed via the store on
     * exit and rehydrated after a daemon restart. Optional because in-memory-
     * only positions (failed persist, legacy callers) still need to function. */
    dbId?: string;
    /** Signal confidence at entry time (0..1) */
    confidence?: number;
    /** Sizing multiplier applied based on confidence tier (0..1) */
    sizingMultiplier?: number;
}
/**
 * Callback fired immediately after a position is opened and persisted,
 * so consumers (e.g. StopMonitor) can pick it up without waiting for
 * the next polling tick — closing the R7 stop-loss arming gap.
 */
interface PositionOpenedEvent {
    dbId: string;
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    qty: number;
    stopLoss: number;
    takeProfit: number;
}
interface OpportunityTraderConfig {
    /** Starting paper equity in USD */
    startingEquity: number;
    /** Max % of equity per trade */
    maxPositionPct: number;
    /** Max open positions */
    maxPositions: number;
    /** Min confidence to trade */
    minConfidence: number;
    /** Default stop loss % */
    defaultStopPct: number;
    /** Default take profit % */
    defaultTakeProfitPct: number;
    /** Cooldown between trades on same pair (ms) */
    cooldownMs: number;
    /** Max drawdown % from peak equity before halting new trades (default: 15) */
    maxDrawdownPct: number;
    /** Max consecutive losses before halting (default: 6) */
    maxConsecutiveLosses: number;
    /**
     * If true, a consecutive-loss halt is permanent and requires
     * `resetCircuitBreaker()`. If false (default), the halt becomes a timed
     * pause that auto-resumes after a cooldown that escalates with each halt.
     */
    haltOnStreakPermanently: boolean;
    /**
     * Escalating cooldown durations in ms, indexed by halt count.
     * Index 0 = first halt, index 1 = second halt, etc. The last entry is
     * reused for any subsequent halts. Default: [30 min, 2h, 6h].
     */
    streakHaltCooldownsMs: number[];
    /**
     * Confidence-based position-sizing tiers. Each tier specifies a minimum
     * confidence (inclusive) and the fraction of the max position size to use.
     * Tiers are evaluated highest minConfidence first; the first match wins.
     * Defaults to the same tiers used by ShadowModeExecutor:
     *   >= 0.7 → 100%, >= 0.6 → 75%, >= 0.5 → 50%, below → 0 (rejected).
     */
    confidenceSizingTiers?: {
        minConfidence: number;
        sizePct: number;
    }[];
    /**
     * Called immediately after a position is opened and persisted to the
     * trading store. Use this to notify StopMonitor so it can begin
     * monitoring the position without waiting for the next polling cycle.
     */
    onPositionOpened?: (event: PositionOpenedEvent) => void;
}
/** Snapshot of the trades that triggered a streak halt — picked up by the
 * learning system to detect regime mismatches. */
interface StreakAnalysis {
    trippedAt: number;
    haltCount: number;
    cooldownMs: number;
    resumeAt: number;
    lossCount: number;
    losingTrades: {
        pair: string;
        source: string;
        strategyType: string;
        direction: "long" | "short";
        pnlPct: number;
        exitReason: string;
        durationMs: number;
    }[];
    byStrategy: Record<string, number>;
    bySource: Record<string, number>;
    byPair: Record<string, number>;
}
declare class OpportunityTrader {
    private config;
    private store;
    private positions;
    private lastTradeTime;
    private equity;
    private peakEquity;
    private totalPnl;
    private closedTrades;
    private tradeCount;
    private winCount;
    private consecutiveLosses;
    private halted;
    private haltReason;
    /** ms epoch when a streak cooldown ends; 0 means no active cooldown
     * (i.e. either not halted or halted permanently). Mirrors the
     * `cooldown_until` column on `circuit_breaker_state`. */
    private pausedUntil;
    /** How many times the streak halt has tripped — the index into
     * `streakHaltCooldownsMs` for cooldown escalation. Mirrors `trip_count`
     * on the trading circuit breaker rows. */
    private haltCount;
    /**
     * Per-pair mutex that serializes evaluate() so the
     * `positions.has(pair)` → `positions.set(pair)` window is atomic.
     * Fixes R6 TOCTOU: two concurrent async callers can no longer both
     * pass the has-check before either writes the position.
     */
    private pairMutexes;
    /** Callback to notify consumers (StopMonitor) the instant a position
     * is opened — closes the R7 stop-loss arming gap. */
    private onPositionOpened?;
    private riskManager?;
    constructor(store: TradingStore, init?: OpportunityTraderInit);
    /** Get or create a per-pair mutex for serializing position creation. */
    private getPairMutex;
    /**
     * Rebuild the in-memory positions Map from the trading store on startup.
     * Without this, a daemon restart silently drops every in-flight practice
     * position — `trade_log` keeps the entry row but no exit ever fires, so
     * stop-loss / take-profit stop being enforced on those orphans.
     *
     * Only rows tagged `executionVenue = OPP_TRADER_VENUE` and `isPaper = 1`
     * are pulled, so positions opened by other engines stay isolated. Strategy
     * metadata that doesn't have a column on `positions` (source, strategyType,
     * maxAgeMs) is round-tripped through `routeJson`.
     */
    private restorePositionsFromStore;
    /**
     * Restore halted/consecutiveLosses from the trading store settings.
     * Without this, a daemon restart silently wipes a real 6-consecutive-
     * losses halt and the trader resumes trading after a ~2-minute outage —
     * which is exactly what hid the HALT seen in daemon-error.log on
     * 2026-04-18. Cooldown halts auto-clear via `maybeAutoResume()` once
     * `pausedUntil` elapses; permanent halts still need explicit
     * `resetCircuitBreaker()`.
     */
    private restoreHaltStateFromStore;
    private persistHaltState;
    /** Cooldown duration for the Nth halt — last entry is reused once we run
     * past the configured ladder. */
    private cooldownForHaltCount;
    /** If a streak cooldown has elapsed, auto-resume: clear halt, reset the
     * loss counter, and persist. Returns true if the trader was resumed. */
    private maybeAutoResume;
    /** Compose the streak analysis snapshot from recent losing trades and
     * persist it to settings so the learning system can detect regime
     * mismatches (e.g. "every loss was a momentum long during ranging
     * regime"). */
    private recordStreakAnalysis;
    /**
     * Evaluate an opportunity and open a paper trade if it passes filters.
     * Serialized per-pair via AsyncMutex so concurrent callers cannot
     * double-open the same pair (R6 TOCTOU fix).
     *
     * Returns the paper position if opened, null if filtered out.
     */
    evaluate(signal: OpportunitySignal): Promise<PaperPosition | null>;
    /**
     * Synchronous evaluate for callers that already hold the mutex or
     * are in a context where concurrency is not possible (e.g. tests).
     * Prefer `evaluate()` in production code.
     */
    evaluateSync(signal: OpportunitySignal): PaperPosition | null;
    /**
     * Resolve the sizing multiplier for a given confidence by walking the
     * configured tiers (sorted descending by minConfidence). Returns a value
     * in [0,1], or 0 when confidence falls below every tier.
     */
    private getConfidenceSizeMultiplier;
    /** Core evaluate logic — callers must ensure mutual exclusion per pair. */
    private evaluateInner;
    /**
     * Update all open positions with current prices and check for exits.
     * Call this on each scanner tick with a price map.
     */
    update(prices: Map<string, number>): {
        updated: number;
        closed: {
            pair: string;
            reason: string;
            pnl: number;
        }[];
    };
    /** Force close a specific position */
    closePosition(pair: string, exitPrice: number, reason: string): void;
    /** Get all open paper positions */
    getOpenPositions(): PaperPosition[];
    /** Get practice trading performance stats */
    getStats(): {
        equity: number;
        startingEquity: number;
        totalReturn: number;
        totalReturnPct: number;
        peakEquity: number;
        drawdownPct: number;
        totalTrades: number;
        openPositions: number;
        winRate: number;
        avgWin: number;
        avgLoss: number;
        profitFactor: number;
        bestTrade: {
            pair: string;
            pnl: number;
            pnlPct: number;
        } | null;
        worstTrade: {
            pair: string;
            pnl: number;
            pnlPct: number;
        } | null;
        bySource: {
            source: string;
            trades: number;
            pnl: number;
            winRate: number;
        }[];
        byStrategy: {
            type: string;
            trades: number;
            pnl: number;
            winRate: number;
        }[];
        recentTrades: {
            pair: string;
            source: string;
            strategyType: string;
            direction: "long" | "short";
            entryPrice: number;
            exitPrice: number;
            pnl: number;
            pnlPct: number;
            exitReason: string;
            duration: number;
        }[];
    };
    /** Whether new trades are halted (drawdown or consecutive loss limit).
     * Auto-resumes elapsed streak cooldowns as a side-effect so callers see a
     * truthful answer without having to call evaluate() first. */
    isHalted(): boolean;
    /** Get halt reason (empty string if not halted). */
    getHaltReason(): string;
    /** ms remaining on the active streak cooldown, or 0 if none. */
    getCooldownRemainingMs(): number;
    /** Number of times the streak halt has tripped this run (or since reset). */
    getHaltCount(): number;
    /** Most recent streak analysis snapshot, or null if none was recorded. */
    getStreakAnalysis(): StreakAnalysis | null;
    /** Manually reset the circuit breaker after review.
     * Clears halt state, cooldown, and the escalation counter so the next
     * streak halt starts at the shortest cooldown again. */
    resetCircuitBreaker(): void;
    getConfig(): OpportunityTraderConfig;
    updateConfig(updates: Partial<OpportunityTraderConfig>): void;
}

/**
 * Practice trading handlers — ties the OpportunityTrader to all watchers.
 * On each tick: scan markets → evaluate opportunities → open/close paper trades.
 */

interface PracticeHandlerDeps {
    trader: OpportunityTrader;
    xrplWatcher: XRPLDEXWatcher;
    cexWatcher: CexMarketWatcher;
    multiDexWatcher: MultiDEXWatcher;
}
declare function createPracticeHandlers(deps: PracticeHandlerDeps): {
    /** Run one practice trading tick: scan all markets, evaluate opportunities, manage positions */
    practice_tick: () => Promise<string>;
    /** Get full practice trading stats and performance breakdown */
    practice_stats: () => Promise<string>;
    /** Get just the open positions */
    practice_positions: () => Promise<string>;
    /**
     * Clear a HALTED state on the opportunity trader after operator review.
     * Resets consecutiveLosses to 0 and clears the persisted halt flag.
     * Use only when you've looked at the closed-trade history and decided
     * the halt was valid-and-handled (or a false positive).
     */
    practice_resume_trading: () => Promise<string>;
};

/**
 * ShadowReport — summarizes ShadowModeExecutor activity for operator review.
 *
 * Surfaces: total shadow trades, P&L curve, gate activation counts by strategy,
 * and anomaly flags (e.g. gates that never fired, unexpected loss streaks).
 */

interface PnlCurvePoint {
    tradeIndex: number;
    cumulativePnl: number;
    tradePnl: number;
    symbol: string;
    strategy: string;
    closedAt: number;
}
interface GateActivationSummary {
    strategy: string;
    count: number;
}
interface ShadowAnomaly {
    type: "no_gate_activations" | "consecutive_losses" | "high_rejection_rate" | "low_win_rate";
    detail: string;
}
interface ShadowReport {
    generatedAt: number;
    totalShadowTrades: number;
    openPositionCount: number;
    closedPositionCount: number;
    totalPnl: number;
    winRate: number;
    avgSlippageBps: number;
    pnlCurve: PnlCurvePoint[];
    gateActivations: GateActivationSummary[];
    anomalies: ShadowAnomaly[];
    summary: string;
}
declare function generateShadowReport(executor: ShadowModeExecutor): ShadowReport;

/**
 * Bellman-Ford negative cycle detection for multi-currency arbitrage.
 *
 * Math:
 *   Edge weight = -log(exchange_rate)
 *   Negative cycle ⟹ product of rates along cycle > 1 ⟹ profit
 *   Profit multiplier = exp(-sum_of_weights) = ∏(rates)
 *
 * Example cycle: XRP →(2.5)→ USD →(50)→ SOLO →(0.009)→ XRP
 *   product = 2.5 × 50 × 0.009 = 1.125 → 12.5% profit per loop
 */
interface Edge {
    from: string;
    to: string;
    rate: number;
    weight: number;
    pair: string;
    source: string;
    bidQty: number;
    fee: number;
}
interface ArbitrageCycle {
    /** Currencies in the cycle path (first = last to close the loop) */
    path: string[];
    /** Edges traversed */
    edges: Edge[];
    /** Raw profit multiplier before fees (product of rates) */
    rawMultiplier: number;
    /** Net profit multiplier after estimated fees */
    netMultiplier: number;
    /** Net profit as percentage */
    profitPct: number;
    /** Maximum volume that can traverse the full cycle (limited by thinnest depth) */
    maxVolumeUsd: number;
    /** Estimated profit in USD at max volume */
    estimatedProfitUsd: number;
    /** Data sources involved */
    sources: string[];
    /** Number of hops */
    hops: number;
    /** Timestamp of detection */
    detectedAt: number;
}
interface BellmanFordResult {
    cycles: ArbitrageCycle[];
    nodesCount: number;
    edgesCount: number;
    scanTimeMs: number;
}
/**
 * Build an edge from a conversion rate, applying fee deduction.
 */
declare function createEdge(from: string, to: string, rate: number, pair: string, source: string, bidQty: number, fee?: number): Edge;
/**
 * Run Bellman-Ford on the currency graph and extract all profitable negative cycles.
 *
 * @param edges - All exchange rate edges
 * @param minProfitPct - Minimum cycle profit % to report (default: 0.05%)
 * @param maxHops - Maximum cycle length (default: 5)
 */
declare function findArbitrageCycles(edges: Edge[], minProfitPct?: number, maxHops?: number): BellmanFordResult;

interface ExecutableLiquidityLevel {
    /** Output units received per 1 input unit at this depth level. */
    price: number;
    /** Maximum input units executable at this level. */
    sizeIn: number;
}
interface ExecutableRouteEdge {
    from: string;
    to: string;
    source?: string;
    feeBps?: number;
    levels: ExecutableLiquidityLevel[];
}
interface ExecutableRoute {
    id?: string;
    edges: ExecutableRouteEdge[];
}
interface ExecutableRouteCostModel {
    fixedCostInStartAsset?: number;
    gasCostInStartAsset?: number;
    latencyPenaltyBps?: number;
    adverseSelectionBps?: number;
    lvrBps?: number;
}
interface ExecutableLevelFill {
    price: number;
    sizeIn: number;
    sizeOut: number;
}
interface ExecutableHopFill {
    from: string;
    to: string;
    source?: string;
    feeBps: number;
    amountIn: number;
    amountOut: number;
    unfilledInput: number;
    filledLevels: ExecutableLevelFill[];
}
interface ExecutableRouteSimulation {
    routeId?: string;
    amountIn: number;
    amountOut: number;
    grossProfit: number;
    netProfit: number;
    netProfitPct: number;
    totalCostInStartAsset: number;
    hopFills: ExecutableHopFill[];
    isFireable: boolean;
}
interface BestExecutableRouteOptions {
    maxInput: number;
    probeInputs?: number[];
    geometricSteps?: number;
    refinementSteps?: number;
    costs?: ExecutableRouteCostModel;
    minNetProfit?: number;
}
declare function simulateExecutableRoute(route: ExecutableRoute, amountIn: number, costs?: ExecutableRouteCostModel): ExecutableRouteSimulation | null;
declare function simulateExecutableRouteBatch(route: ExecutableRoute, amountsIn: ArrayLike<number>, costs?: ExecutableRouteCostModel): Array<ExecutableRouteSimulation | null>;
declare function findBestExecutableRouteSize(route: ExecutableRoute, options: BestExecutableRouteOptions): ExecutableRouteSimulation | null;

interface RouteKernelModule {
    scoreRouteBatchJson: (rawJson: string) => string;
    tradingKernelBackend?: () => string;
}
interface RouteKernelBatchResult {
    backend: string;
    usedNative: boolean;
    results: Array<ExecutableRouteSimulation | null>;
}
declare function scoreRouteBatchWithKernel(route: ExecutableRoute, amountsIn: ArrayLike<number>, costs?: ExecutableRouteCostModel, nativeModule?: RouteKernelModule | null): RouteKernelBatchResult;
declare function loadNativeRouteKernel(): RouteKernelModule | null;

interface RescoreArbitrageCycleOptions {
    amountIn?: number;
    maxInput?: number;
    probeInputs?: number[];
    geometricSteps?: number;
    refinementSteps?: number;
    costs?: ExecutableRouteCostModel;
    minNetProfit?: number;
}
interface ExecutableCycleScore {
    route: ExecutableRoute;
    simulation: ExecutableRouteSimulation;
    amountIn: number;
    executableProfit: number;
    executableProfitPct: number;
    originalProfitPct: number;
    edgeDeltaPct: number;
}
declare function cycleToExecutableRoute(cycle: ArbitrageCycle): ExecutableRoute | null;
declare function rescoreArbitrageCycle(cycle: ArbitrageCycle, options: RescoreArbitrageCycleOptions): ExecutableCycleScore | null;

/**
 * Graph Builder — converts live market data from all sources into a
 * weighted currency graph for Bellman-Ford arbitrage detection.
 *
 * Creates bidirectional edges for every trading pair, using actual
 * bid/ask prices (not mid) to account for spread cost.
 */

/** Fee estimates per source (as fraction, e.g. 0.001 = 0.1%) */
declare const FEES: Record<string, number>;
interface GraphBuilderConfig {
    /** XRPL pairs to include */
    xrplPairs: {
        base: XRPLCurrency;
        quote: XRPLCurrency;
        label: string;
    }[];
    /** Stellar pairs to include */
    stellarPairs: {
        base: StellarAsset;
        counter: StellarAsset;
        label: string;
    }[];
    /** Solana tokens to query */
    solanaTokens: string[];
    /** Flare tokens to query */
    flareTokens: string[];
    /** CEX pairs to include */
    cexPairs: {
        symbol: string;
        base: string;
        quote: string;
    }[];
    /** Custom fee overrides */
    fees?: Partial<typeof FEES>;
}
interface GraphSnapshot {
    edges: Edge[];
    nodes: string[];
    timestamp: number;
    errors: string[];
}
declare class GraphBuilder {
    private xrpl;
    private stellar;
    private solana;
    private flare;
    private cex;
    private config;
    private fees;
    constructor(sources: {
        xrpl?: XRPLClient;
        stellar?: StellarClient;
        solana?: SolanaClient;
        flare?: FlareClient;
        cex?: CryptoClient;
    }, config: GraphBuilderConfig);
    /**
     * Build the complete currency graph from all available price sources.
     * Returns bidirectional edges with actual bid/ask rates.
     */
    buildGraph(): Promise<GraphSnapshot>;
    private buildXRPLEdges;
    private orderBookToEdges;
    private buildStellarEdges;
    private stellarBookToEdges;
    private buildSolanaEdges;
    private buildFlareEdges;
    private buildCEXEdges;
    private tickerToEdges;
    private buildBridgeEdges;
}

/**
 * Arbitrage Scanner — orchestrates graph building and Bellman-Ford cycle detection.
 * Produces OpportunitySignals for the paper trader and tracks historical arb data.
 */

interface ArbitrageScannerConfig {
    /** Minimum profit % to act on (default: 0.1%) */
    minProfitPct: number;
    /** Minimum profit % to report (default: 0.03%) */
    minReportPct: number;
    /** Maximum hops in a cycle (default: 5) */
    maxHops: number;
    /** Minimum volume in USD for a cycle to be tradeable (default: 10) */
    minVolumeUsd: number;
    /** Cooldown between acting on the same cycle (ms) */
    cycleCooldownMs: number;
    /** When true, Bellman-Ford cycles must clear depth-aware executable simulation. */
    executableRescore?: boolean;
    /** Max start-asset input to probe during executable rescoring. */
    executableRescoreMaxInput?: number;
    /** Explicit start-asset probe inputs for executable rescoring. */
    executableRescoreProbeInputs?: number[];
    executableRescoreGeometricSteps?: number;
    executableRescoreRefinementSteps?: number;
    executableRescoreMinNetProfit?: number;
    executableRescoreCosts?: ExecutableRouteCostModel;
}
interface ScanResult {
    graph: {
        nodes: number;
        edges: number;
    };
    bellmanFord: {
        cycles: number;
        scanTimeMs: number;
    };
    executableRescore?: {
        enabled: boolean;
        scored: number;
        rejected: number;
    };
    /** All profitable cycles found (above minReportPct) */
    allCycles: ArbitrageCycle[];
    /** Cycles that are actionable (above minProfitPct + volume) */
    actionableCycles: ArbitrageCycle[];
    /** Signals emitted to the opportunity trader */
    signals: OpportunitySignal[];
    errors: string[];
    timestamp: number;
}
declare class ArbitrageScanner {
    private graphBuilder;
    private learner;
    private config;
    private lastCycleAction;
    private scanHistory;
    private totalCyclesFound;
    private totalSignalsEmitted;
    constructor(graphBuilder: GraphBuilder, learner?: MarketLearner | null, config?: Partial<ArbitrageScannerConfig>);
    /** Run a full arbitrage scan: build graph → find cycles → emit signals */
    scan(): Promise<ScanResult>;
    /** Get scanning statistics */
    getStats(): {
        totalScans: number;
        totalCyclesFound: number;
        totalSignalsEmitted: number;
        recentScans: {
            timestamp: number;
            cyclesFound: number;
            bestProfitPct: number;
        }[];
        avgCyclesPerScan: number;
        bestEverProfitPct: number;
    };
    getConfig(): ArbitrageScannerConfig;
    updateConfig(updates: Partial<ArbitrageScannerConfig>): void;
    private executableRescoreCycles;
    /** Convert a profitable cycle into an OpportunitySignal for the paper trader */
    private cycleToSignal;
}

/**
 * Tool handlers for Bellman-Ford arbitrage scanning.
 */

interface ArbitrageHandlerDeps {
    scanner: ArbitrageScanner;
}
declare function createArbitrageHandlers(deps: ArbitrageHandlerDeps): {
    /** Run a full Bellman-Ford arbitrage scan across all chains */
    arb_scan: () => Promise<string>;
    /** Get arbitrage scanning statistics */
    arb_stats: () => Promise<string>;
};

declare const manifest: PluginManifest;

export { type ActiveStrategy, type AdaptiveOrderType, type AdaptiveOrderTypeDecision, type AggregatedBalances, type Alert, AlertEscalation, type AlertEscalationConfig, type AlertSeverity, type ArbitrageCycle, type ArbitrageHandlerDeps, ArbitrageScanner, type ArbitrageScannerConfig, type AssetSeries, type BackfillResult, type BacktestConfig, type BacktestResult, type BacktestTrade, Backtester, type Balance, type BellmanFordResult, type BestExecutableRouteOptions, type BinomialResult, type BreakerStatus, type BreakerType, type Candle, type CandleData, CandleFetcher, type CandleFetcherConfig, CandleStore, type CexHandlerDeps, CexMarketWatcher, type CexOpportunity, type CexSnapshot, type CexWatchedSymbol, type CexWatcherConfig, type ChainOpportunity, type ChainSnapshot, type ClosedTradeRow, type CrashRecoveryDeps, CrashRecoveryManager, CryptoClient, type CryptoClientConfig, CryptoComAdapter, type DCAConfig, type DCAInterval, type DCAState, type DCAStore, DEFAULT_PAPER_READINESS, DEFAULT_PAPER_SL_TREE, DEFAULT_RECONCILE_LOOKBACK_HOURS, DEFAULT_RISK_CONFIG, DEFAULT_STAGE_THRESHOLDS, DEFAULT_UNIVERSE, type DEXHandlerDeps, type DEXSnapshot, type DEXWatcherConfig, DEX_EXECUTION_VENUE_SOLANA, DEX_PAIRS, DUAL_DESK_EDUCATION_DRAWDOWN_PCT, DUAL_DESK_SOFT_DRAWDOWN_PCT, type DailyDigest, type DailyPnLPosition, type DailyPnLSummary, type DailySnapshot, type DayBreakdown, type Discrepancy, type DualDeskCtaInput, type DualDeskCtaResult, EDGE_EXPERIMENT_STRATEGIES, type Edge, type EdgeValidation, type EnsembleConfig, type EnsembleResult, type EnsembleVote, type EquitySnapshot, type EvaluateTrendFollowingGateInput, type EvaluateTrendFollowingGateResult, type Exchange, type ExchangeConfig, type ExchangeErrorType, ExchangeManager, type ExecutableCycleScore, type ExecutableHopFill, type ExecutableLevelFill, type ExecutableLiquidityLevel, type ExecutableRoute, type ExecutableRouteCostModel, type ExecutableRouteEdge, type ExecutableRouteSimulation, type ExecuteResult, type ExecutionBookSnapshot, ExecutionManager, type ExecutionManagerDeps, ExecutionQualityController, type ExecutionQualityControllerConfig, type ExecutionQualitySample, type ExecutionQualityStats, type ExecutionSizingAdjustment, FLARE_TOKENS, FLARE_WATCH_TOKENS, type FeeSchedule, type FetchResult, FlareClient, type FlarePair, type FlarePoolReserves, type FullAnalytics, type FundingArbitrage, type FundingRateConfig, type FundingRateEntry, FundingRateMonitor, type FundingRateStats, type GateActivationSummary, type GetFundingStatsFn, type GetPatternsFn, type GraduationStage, type GraduationStatus, type GraduationStep, type GraduationVerdict, GraphBuilder, type GraphBuilderConfig, type GraphSnapshot, type HourlyPattern, type IndicatorValues, type InventoryHedgeRecommendation, type InventorySkewInput, type InventorySkewResult, type JournalExitReason, type JournalSide, type JournalStyle, type JupiterQuoteSummary, JupiterSwapExecutor, type JupiterSwapLiveResult, type JupiterSwapPaperResult, KNOWN_ISSUERS, type KillGateInput, type KillGateResult, type KillGateSnapshot, type LeaderboardPeriod, LeaderboardStore, type LearnedPattern, type LearnerPattern, MACRO_FEATURE_NAMES, MAX_RECONCILE_LOOKBACK_HOURS, MIN_RECONCILE_LOOKBACK_HOURS, type MacroPatternEdge, type MacroPredictionReport, type MacroPredictionTargetResult, MarketLearner, type MarketObservation, type MarketRegime, type MediaCtaMode, type MineMacroPatternOptions, type MonitorInput, type MonteCarloResult, MultiAssetFetcher, type MultiDEXConfig, MultiDEXWatcher, type NetEdgeGateInput, type NetEdgeGateResult, type OHLCVBar, type Opportunity, type OpportunitySignal, OpportunityTrader, type OpportunityTraderConfig, type OpportunityTraderDeps, type OpportunityTraderInit, type OrderBook, OrderReconciler, type OverallHealth, PAPER_SL_TREE_VERSION, PRELIVE_EXCHANGE_VERIFIED_AT_KEY, PRELIVE_VERIFY_TTL_MS, PROFIT_HARD_DISABLED_STRATEGIES, type PaperBalance, type PaperEquityBalance, type PaperEquityDeps, type PaperEquityPosition, type PaperJournalValidation, type PaperPosition, type PaperReadinessThresholds, type PaperSlScenarioResult, type PaperStopLossCheckInput, type PaperStopLossCheckResult, type PaperStopLossTreeConfig, type PaperTradeJournalEntry, type PerformanceMetrics, type PnlCurvePoint, PortfolioAnalyzer, type PortfolioSummary, type Position, PositionGraduation, type PositionGraduationConfig, type PositionSizeResult, type PositionSnapshot, type PositionWithStops, type PracticeHandlerDeps, type PreLiveChecklistInput, type PreLiveChecklistItem, type PreLiveChecklistResult, type PreTradeCheckFn, type PreTradeEdgeInput, type PreTradeEdgeResult, type PriceAlert, type PriceComparison, PriceFeed, type PriceFeedConfig, type PriceFeedEvents, type PriceUpdate, REBALANCE_CONFIG_KEY, type RebalanceConfig, type RebalanceExecutionResult, type RebalanceHandlers, type RebalancePlan, type RebalanceTrade, type ReconciliationResult, type RecoveryPosition, type RecoveryReport, type RegimeAnalysis, RegimeValidationPipeline, type RegimeValidationPipelineConfig, type RescoreArbitrageCycleOptions, type RetrainingTarget, type ReturnAttributionBucket, type RiskConfig, RiskManager, type RollingValidationResult, type RollingValidationWindow, type RouteKernelBatchResult, type RouteKernelModule, type RsiDivergenceBranchCounters, type RsiDivergenceCounters, type RunMacroPredictionOptions, SHADOW_PNL_SNAPSHOT_CAP, SOLANA_TOKENS, SOLANA_WATCH_PAIRS, STELLAR_ASSETS, STELLAR_PAIRS, type ScanResult, type SessionInfo, type ShadowAnomaly, ShadowModeExecutor, type ShadowModeExecutorOpts, type ShadowPerformance, type ShadowPosition, type ShadowReport, type ShadowTradeParams, type ShadowTradeResult, type Signal, SignalEngine, type SignalEngineConfig, type SignalEngineDeps, SignalEnsemble, type SignalRecord, SolanaClient, type SolanaOrderBook, type SolanaPair, type StageThresholds, type StellarAsset, StellarClient, type StellarOrderBook, type StopEvent, type StopLossAction, StopMonitor, type StopMonitorDeps, StopScheduler, type StopSchedulerDeps, type Strategy, StrategyAdaptor, type StrategyAdaptorConfig, type StrategyComparison, type StrategyMetrics, StrategyRegistry, type StrategyRiskParams, type StrategyTradeRecord, type StrategyWeight, type SymbolBreakdown, TF_GATE_DEFAULT_BASELINE_ISO, TF_GATE_DEFAULT_EVAL_AFTER_ISO, type Ticker, type Timeframe, type TradeCostResult, type TradeEvent, TradeJournal, type TradeLog, TradeNotifier, type TradeResult, type TradeRiskStatusSemanticsResult, type TradeStats, type TradeStyle, type TradeValidation, TradingCircuitBreaker, type TradingCircuitBreakerConfig, type TradingHandlerDeps, TradingHealthAggregator, type TradingHealthDeps, type TradingHealthReport, type TradingOrderAuditPayload, type TradingOrderAuditSource, TradingStore, type TradingStoreConfig, type TrendFollowingMode, type WalkForwardConfig, type WalkForwardRegimeLabel, type WalkForwardReport, type WalkForwardValidationResult, WalkForwardValidator, type WalkForwardValidatorConfig, type WalkForwardWindow, type WalkForwardWindowMetrics, type WatchedPair, type WebhookAlertPayload, WebhookAlerter, type XRPLBookEntry, XRPLClient, type XRPLClientConfig, type XRPLCurrency, XRPLDEXWatcher, type XRPLHandlerDeps, type XRPLOrderBook, alignAssetSeries, applyRegimeWeight, applySlippage, binomialTest, breakoutStrategy, buildKillGateSnapshot, calculatePerformance, checkPaperInvalidation, checkPaperStopLoss, checkPaperStopLossBatch, classifyExchangeError, computeADX, computeAdverseImpactBps, computeAdverseSlippageBps, computeIndicators, computeNetEdgeGate, computePaperEquityUsd, computeProxyScale, computeRebalancePlan, computeTradeCost, connorsRsi2Strategy, createArbitrageHandlers, createCexHandlers, createDEXHandlers, createEdge, createFundingSqueezeFadeStrategy, createLearnerMomentumStrategy, createPracticeHandlers, createTradingHandlers, createXRPLHandlers, cycleToExecutableRoute, calculateBuyAmount as dcaCalculateBuyAmount, computeSmaPrice as dcaComputeSmaPrice, emptyState as dcaEmptyState, isDue as dcaIsDue, loadConfigs as dcaLoadConfigs, loadState as dcaLoadState, saveConfigs as dcaSaveConfigs, saveState as dcaSaveState, updateState as dcaUpdateState, deriveBookSnapshot, detectRegime, donchianTrendStrategy, estimateGrossEdgeBpsFromLevels, evaluateGraduation, evaluateInventorySkew, evaluatePreLiveChecklist, evaluatePreTradeEdge, evaluateTradingKillGate, evaluateTrendFollowingGate, executeRebalancePlan, fetchDexSolanaUsdPrice, findArbitrageCycles, findBestExecutableRouteSize, formatGraduationReport, generateShadowReport, generateTradingOrderCorrelationId, getCurrentSession, getDefaultFeeSchedules, getPaperStopLossTreeStatus, getRsiDivergenceCounters, getSessionFitness, getTrendFollowingMode, index as indicators, isDexSolanaExecutionSymbol, isHighQualityWindow, isPartialFillOrderStatus, loadNativeRouteKernel, loadRebalanceConfig, manifest, meanReversionStrategy, mergeDisabledStrategies, mineMacroPatternEdges, monteCarloShuffle, monthsSinceLastHalving, paperJournalSessionChecklist, parseSolanaDexTokenSymbol, predictProba, priceDistanceBps, recordPreLiveExchangeVerified, rescoreArbitrageCycle, resetRsiDivergenceCounters, resolveDualDeskCtaMode, resolveFeeRate, resolveReconcileLookbackHours, resolveVenue, rsiDivergenceStrategy, runMacroPredictionReport, runPaperStopLossScenarios, runWalkForward, saveRebalanceConfig, scoreRouteBatchWithKernel, sessionOrbStrategy, setTrendFollowingMode, simulateExecutableRoute, simulateExecutableRouteBatch, spliceExtendedHistory, squeezeBreakoutStrategy, trainLogisticRegression, trendFollowingStrategy, validateEdge, validatePaperTradeJournal, validateTradeRiskStatusSemantics, walkForwardDegradation, walkForwardTest, withExchangeRetry };
