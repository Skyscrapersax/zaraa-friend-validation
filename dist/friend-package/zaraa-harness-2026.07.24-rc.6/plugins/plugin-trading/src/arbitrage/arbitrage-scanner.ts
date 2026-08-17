/**
 * Arbitrage Scanner — orchestrates graph building and Bellman-Ford cycle detection.
 * Produces OpportunitySignals for the paper trader and tracks historical arb data.
 */

import type { GraphBuilder, GraphSnapshot } from "./graph-builder.js";
import { findArbitrageCycles, type ArbitrageCycle, type BellmanFordResult } from "./bellman-ford.js";
import { rescoreArbitrageCycle } from "./executable-cycle.js";
import type { ExecutableRouteCostModel } from "./executable-route.js";
import type { OpportunitySignal } from "../engine/opportunity-trader.js";
import type { MarketLearner } from "../xrpl/market-learner.js";

export interface ArbitrageScannerConfig {
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

const DEFAULT_CONFIG: ArbitrageScannerConfig = {
	minProfitPct: 0.1,
	minReportPct: 0.03,
	maxHops: 5,
	minVolumeUsd: 10,
	cycleCooldownMs: 5 * 60 * 1000,
};

export interface ScanResult {
	graph: { nodes: number; edges: number };
	bellmanFord: { cycles: number; scanTimeMs: number };
	executableRescore?: { enabled: boolean; scored: number; rejected: number };
	/** All profitable cycles found (above minReportPct) */
	allCycles: ArbitrageCycle[];
	/** Cycles that are actionable (above minProfitPct + volume) */
	actionableCycles: ArbitrageCycle[];
	/** Signals emitted to the opportunity trader */
	signals: OpportunitySignal[];
	errors: string[];
	timestamp: number;
}

export class ArbitrageScanner {
	private graphBuilder: GraphBuilder;
	private learner: MarketLearner | null;
	private config: ArbitrageScannerConfig;
	private lastCycleAction = new Map<string, number>();
	private scanHistory: { timestamp: number; cyclesFound: number; bestProfitPct: number }[] = [];
	private totalCyclesFound = 0;
	private totalSignalsEmitted = 0;

	constructor(
		graphBuilder: GraphBuilder,
		learner: MarketLearner | null = null,
		config: Partial<ArbitrageScannerConfig> = {},
	) {
		this.graphBuilder = graphBuilder;
		this.learner = learner;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Run a full arbitrage scan: build graph → find cycles → emit signals */
	async scan(): Promise<ScanResult> {
		const errors: string[] = [];

		// 1. Build the currency graph
		let graphSnapshot: GraphSnapshot;
		try {
			graphSnapshot = await this.graphBuilder.buildGraph();
			errors.push(...graphSnapshot.errors);
		} catch (e) {
			return {
				graph: { nodes: 0, edges: 0 },
				bellmanFord: { cycles: 0, scanTimeMs: 0 },
				allCycles: [],
				actionableCycles: [],
				signals: [],
				errors: [`Graph build failed: ${e instanceof Error ? e.message : String(e)}`],
				timestamp: Date.now(),
			};
		}

		// 2. Run Bellman-Ford
		const result: BellmanFordResult = findArbitrageCycles(
			graphSnapshot.edges,
			this.config.minReportPct,
			this.config.maxHops,
		);

		this.totalCyclesFound += result.cycles.length;
		const rescored = this.executableRescoreCycles(result.cycles);
		const candidateCycles = rescored.cycles;

		// 3. Filter actionable cycles
		const actionableCycles = candidateCycles.filter((c) =>
			c.profitPct >= this.config.minProfitPct &&
			c.maxVolumeUsd >= this.config.minVolumeUsd,
		);

		// 4. Convert to signals (with cooldown)
		const signals: OpportunitySignal[] = [];
		for (const cycle of actionableCycles) {
			const key = cycle.path.join("→");
			const lastAction = this.lastCycleAction.get(key);
			if (lastAction && Date.now() - lastAction < this.config.cycleCooldownMs) continue;

			const signal = this.cycleToSignal(cycle);
			signals.push(signal);
			this.lastCycleAction.set(key, Date.now());
			this.totalSignalsEmitted++;
		}

		// 5. Record to learner
		if (this.learner && candidateCycles.length > 0) {
			const best = candidateCycles[0];
			this.learner.recordObservation({
				pair: `arb:${best.path.slice(0, -1).join("→")}`,
				midPrice: best.profitPct,
				spreadPct: best.profitPct,
				bidDepth: best.maxVolumeUsd,
				askDepth: 0,
				imbalanceRatio: best.rawMultiplier,
				timestamp: Date.now(),
			});
		}

		// 6. Track history
		this.scanHistory.push({
			timestamp: Date.now(),
			cyclesFound: candidateCycles.length,
			bestProfitPct: candidateCycles[0]?.profitPct ?? 0,
		});
		if (this.scanHistory.length > 1000) this.scanHistory.shift();

		return {
			graph: { nodes: graphSnapshot.nodes.length, edges: graphSnapshot.edges.length },
			bellmanFord: { cycles: result.cycles.length, scanTimeMs: result.scanTimeMs },
			executableRescore: rescored.summary,
			allCycles: candidateCycles,
			actionableCycles,
			signals,
			errors,
			timestamp: Date.now(),
		};
	}

	/** Get scanning statistics */
	getStats(): {
		totalScans: number;
		totalCyclesFound: number;
		totalSignalsEmitted: number;
		recentScans: { timestamp: number; cyclesFound: number; bestProfitPct: number }[];
		avgCyclesPerScan: number;
		bestEverProfitPct: number;
	} {
		const recent = this.scanHistory.slice(-50);
		const avgCycles = recent.length > 0
			? recent.reduce((s, r) => s + r.cyclesFound, 0) / recent.length
			: 0;
		const bestEver = this.scanHistory.length > 0
			? Math.max(...this.scanHistory.map((s) => s.bestProfitPct))
			: 0;

		return {
			totalScans: this.scanHistory.length,
			totalCyclesFound: this.totalCyclesFound,
			totalSignalsEmitted: this.totalSignalsEmitted,
			recentScans: recent.slice(-10),
			avgCyclesPerScan: Math.round(avgCycles * 100) / 100,
			bestEverProfitPct: Math.round(bestEver * 1000) / 1000,
		};
	}

	getConfig(): ArbitrageScannerConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<ArbitrageScannerConfig>): void {
		Object.assign(this.config, updates);
	}

	private executableRescoreCycles(cycles: ArbitrageCycle[]): {
		cycles: ArbitrageCycle[];
		summary?: { enabled: boolean; scored: number; rejected: number };
	} {
		if (!this.config.executableRescore) return { cycles };

		const rescored: ArbitrageCycle[] = [];
		let rejected = 0;
		for (const cycle of cycles) {
			const score = rescoreArbitrageCycle(cycle, {
				maxInput: this.config.executableRescoreMaxInput ?? cycle.maxVolumeUsd,
				probeInputs: this.config.executableRescoreProbeInputs,
				geometricSteps: this.config.executableRescoreGeometricSteps,
				refinementSteps: this.config.executableRescoreRefinementSteps,
				minNetProfit: this.config.executableRescoreMinNetProfit,
				costs: this.config.executableRescoreCosts,
			});
			if (!score) {
				rejected += 1;
				continue;
			}
			rescored.push({
				...cycle,
				netMultiplier: 1 + score.executableProfitPct / 100,
				profitPct: score.executableProfitPct,
				maxVolumeUsd: round(score.amountIn, 8),
				estimatedProfitUsd: round(score.executableProfit, 8),
			});
		}

		rescored.sort((a, b) => b.profitPct - a.profitPct);
		return {
			cycles: rescored,
			summary: { enabled: true, scored: rescored.length, rejected },
		};
	}

	/** Convert a profitable cycle into an OpportunitySignal for the paper trader */
	private cycleToSignal(cycle: ArbitrageCycle): OpportunitySignal {
		const firstEdge = cycle.edges[0];
		return {
			source: cycle.sources.join("+"),
			pair: `arb:${cycle.path.slice(0, -1).join("→")}`,
			type: "spread_capture",
			direction: "long",
			confidence: Math.min(cycle.profitPct / 2, 0.95), // 2% profit = max confidence
			entryPrice: firstEdge.rate,
			description: `${cycle.hops}-hop arb: ${cycle.path.join(" → ")} | ${cycle.profitPct.toFixed(3)}% profit | ~$${cycle.estimatedProfitUsd.toFixed(2)} on $${cycle.maxVolumeUsd.toFixed(0)} vol`,
		};
	}
}

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}
