/**
 * ScanScheduler — Daemon loop that orchestrates prediction market scanning.
 *
 * Cycle 011: The wiring layer that connects PolymarketClient -> ScanPipeline ->
 * PaperExecutor -> TradeJournal into a running scan loop.
 *
 * Runs every N minutes (default: 5), fetching active markets, running them
 * through the full 6-stage pipeline, and executing paper trades for qualifying
 * signals. Every action is logged to the TradeJournal for audit/compliance.
 *
 * Usage:
 *   const scheduler = new ScanScheduler({ ... });
 *   scheduler.start();
 *   // later:
 *   scheduler.stop();
 */
import type { PredictionSignal } from "../types.js";
import type { ScanPipeline, PipelineResult, PipelineMetrics } from "./scan-pipeline.js";
import type { TradeJournal } from "./trade-journal.js";
import type { PolymarketClient } from "../polymarket/polymarket-client.js";
import type { PaperExecutor } from "../polymarket/paper-executor.js";

// ── Configuration ──

export interface ScanSchedulerConfig {
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

const DEFAULT_CONFIG: ScanSchedulerConfig = {
	intervalMs: 300_000, // 5 minutes
	maxMarkets: 200,
	fetchOrderBooks: false,
	minEVForTrade: 0.02,
	enabled: true,
	log: (msg: string, ...args: unknown[]) => console.log(`[prediction-scanner] ${msg}`, ...args),
};

// ── Scheduler State ──

export interface ScanSchedulerState {
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

// ── Dependencies ──

export interface ScanSchedulerDeps {
	client: PolymarketClient;
	pipeline: ScanPipeline;
	executor: PaperExecutor;
	journal: TradeJournal;
}

// ── Scheduler ──

export class ScanScheduler {
	private config: ScanSchedulerConfig;
	private deps: ScanSchedulerDeps;
	private timer: ReturnType<typeof setInterval> | null = null;
	private state: ScanSchedulerState = {
		running: false,
		scanning: false,
		scanCount: 0,
		lastScanAt: null,
		lastScanDurationMs: null,
		lastSignalCount: 0,
		lastTradeCount: 0,
		totalSignals: 0,
		totalTrades: 0,
		totalErrors: 0,
		nextScanAt: null,
		successStreak: 0,
		errorStreak: 0,
		backoffMultiplier: 1,
		health: "healthy",
	};

	/** Most recent pipeline result (for API queries) */
	private lastResult: PipelineResult | null = null;
	/** Most recent pipeline metrics */
	private lastMetrics: PipelineMetrics | null = null;

	constructor(deps: ScanSchedulerDeps, config: Partial<ScanSchedulerConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.deps = deps;
	}

	/** Start the scan loop */
	start(): void {
		if (this.state.running) return;
		if (!this.config.enabled) {
			this.config.log("Scheduler disabled, not starting");
			return;
		}

		this.state.running = true;
		this.config.log(`Starting scan loop (interval: ${this.config.intervalMs / 1000}s)`);

		// Run immediately, then schedule with adaptive interval
		void this.runScan();
		this.scheduleNext();
	}

	/** Schedule next scan with backoff-adjusted interval */
	private scheduleNext(): void {
		if (!this.state.running) return;
		if (this.timer) clearTimeout(this.timer);

		const interval = this.config.intervalMs * this.state.backoffMultiplier;
		this.state.nextScanAt = Date.now() + interval;

		this.timer = setTimeout(() => {
			void this.runScan()
				.then(() => this.scheduleNext())
				.catch((err) => {
					this.config.log(`Scan chain error: ${err instanceof Error ? err.message : String(err)}`);
					this.scheduleNext();
				});
		}, interval);

		// Allow Node to exit even if timer is running
		if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
			(this.timer as NodeJS.Timeout).unref();
		}
	}

	/** Stop the scan loop */
	stop(): void {
		if (!this.state.running) return;

		this.state.running = false;
		this.state.nextScanAt = null;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		this.config.log("Scan loop stopped");
	}

	/** Trigger a manual scan (outside the scheduled loop) */
	async triggerScan(): Promise<PipelineResult | null> {
		return this.runScan();
	}

	/** Get current scheduler state */
	getState(): ScanSchedulerState {
		return { ...this.state };
	}

	/** Get the most recent pipeline result */
	getLastResult(): PipelineResult | null {
		return this.lastResult;
	}

	/** Get the most recent pipeline metrics */
	getLastMetrics(): PipelineMetrics | null {
		return this.lastMetrics;
	}

	/** Update config at runtime */
	updateConfig(updates: Partial<ScanSchedulerConfig>): void {
		const wasRunning = this.state.running;
		const intervalChanged = updates.intervalMs && updates.intervalMs !== this.config.intervalMs;

		Object.assign(this.config, updates);

		// Restart timer if interval changed
		if (wasRunning && intervalChanged) {
			this.stop();
			this.start();
		}
	}

	/** Dispose all resources */
	dispose(): void {
		this.stop();
		this.deps.client.dispose();
	}

	// ── Core Scan Logic ──

	private async runScan(): Promise<PipelineResult | null> {
		if (this.state.scanning) {
			this.config.log("Scan already in progress, skipping");
			return null;
		}

		// Check kill switch before scanning
		const killSwitch = this.deps.executor.getKillSwitchStatus();
		if (killSwitch.active && killSwitch.level === "halt") {
			this.config.log(`Kill switch HALT active: ${killSwitch.reason} — skipping scan`);
			return null;
		}

		this.state.scanning = true;
		const t0 = Date.now();

		try {
			// Stage 1: Fetch markets from Polymarket
			this.config.log("Fetching active markets...");
			const markets = await this.deps.client.fetchActiveMarkets({
				maxMarkets: this.config.maxMarkets,
				fetchOrderBooks: this.config.fetchOrderBooks,
			});
			this.config.log(`Fetched ${markets.length} markets`);

			if (markets.length === 0) {
				this.deps.journal.logScan({
					marketsReceived: 0,
					finalSignals: 0,
					totalTimeMs: Date.now() - t0,
					passedPreScreen: 0,
					passedEnrichment: 0,
				});
				return null;
			}

			// Stage 2: Run through pipeline
			this.config.log("Running pipeline...");
			const result = await this.deps.pipeline.execute(markets);
			this.lastResult = result;
			this.lastMetrics = result.metrics;

			this.config.log(
				`Pipeline: ${result.metrics.marketsReceived} -> ` +
				`${result.metrics.passedPreScreen} pre-screen -> ` +
				`${result.metrics.passedEnrichment} enriched -> ` +
				`${result.metrics.finalSignals} signals (${result.metrics.totalTimeMs}ms)`,
			);

			// Log scan to journal
			this.deps.journal.logScan(result.metrics);

			// Stage 3: Log all signals
			for (const signal of result.signals) {
				this.deps.journal.logSignal({
					marketId: signal.marketId,
					question: signal.question,
					side: signal.side,
					expectedValue: signal.expectedValue,
					modelProbability: signal.modelProbability,
					marketPrice: signal.marketPrice,
					kellySize: signal.quarterKellySize,
					reason: signal.reason,
				});
			}

			// Stage 4: Execute paper trades for qualifying signals
			const tradableSignals = result.signals.filter(
				(s) => s.expectedValue >= this.config.minEVForTrade,
			);

			let tradesExecuted = 0;
			if (tradableSignals.length > 0 && !killSwitch.active) {
				this.config.log(`Executing ${tradableSignals.length} paper trades...`);
				const execResults = this.deps.executor.executeBatch(tradableSignals);

				for (const er of execResults) {
					this.deps.journal.logTrade({
						tradeId: er.tradeId,
						marketId: er.signal.marketId,
						question: er.signal.question,
						side: er.signal.side,
						size: er.signal.quarterKellySize,
						entryPrice: er.signal.side === "yes" ? er.signal.marketPrice : 1 - er.signal.marketPrice,
						accepted: er.accepted,
						reason: er.reason,
					});

					if (er.accepted) {
						tradesExecuted++;
						this.config.log(`  TRADE: ${er.signal.side.toUpperCase()} ${er.signal.question.slice(0, 60)} $${er.signal.quarterKellySize.toFixed(2)} [${er.tradeId}]`);
					} else {
						this.config.log(`  SKIP:  ${er.signal.question.slice(0, 60)} — ${er.reason}`);
					}
				}
			}

			// Update state
			const elapsed = Date.now() - t0;
			this.state.scanCount++;
			this.state.lastScanAt = Date.now();
			this.state.lastScanDurationMs = elapsed;
			this.state.lastSignalCount = result.signals.length;
			this.state.lastTradeCount = tradesExecuted;
			this.state.totalSignals += result.signals.length;
			this.state.totalTrades += tradesExecuted;

			this.config.log(
				`Scan #${this.state.scanCount} complete: ` +
				`${result.signals.length} signals, ${tradesExecuted} trades, ${elapsed}ms`,
			);

			// Reset error backoff on success
			this.state.successStreak++;
			this.state.errorStreak = 0;
			this.state.backoffMultiplier = 1;
			this.state.health = this.state.successStreak >= 3 ? "healthy" : "degraded";

			return result;
		} catch (err: unknown) {
			this.state.totalErrors++;
			this.state.errorStreak++;
			this.state.successStreak = 0;

			// Exponential backoff: 2x per consecutive error, max 8x
			this.state.backoffMultiplier = Math.min(8, 2 ** Math.min(3, this.state.errorStreak - 1));
			this.state.health = this.state.errorStreak >= 3 ? "unhealthy" : "degraded";

			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.config.log(`Scan error (streak: ${this.state.errorStreak}, next backoff: ${this.state.backoffMultiplier}x): ${message}`);

			this.deps.journal.logError({
				stage: "scan",
				message,
				stack,
			});

			return null;
		} finally {
			this.state.scanning = false;
		}
	}
}
