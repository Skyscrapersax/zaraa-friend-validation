/**
 * Tool handlers for Bellman-Ford arbitrage scanning.
 */

import type { ArbitrageScanner } from "./arbitrage-scanner.js";

export interface ArbitrageHandlerDeps {
	scanner: ArbitrageScanner;
}

export function createArbitrageHandlers(deps: ArbitrageHandlerDeps) {
	const { scanner } = deps;

	return {
		/** Run a full Bellman-Ford arbitrage scan across all chains */
		arb_scan: async (): Promise<string> => {
			const result = await scanner.scan();
			return JSON.stringify({
				graph: { nodes: result.graph.nodes, edges: result.graph.edges },
				scanTimeMs: result.bellmanFord.scanTimeMs,
				cyclesFound: result.bellmanFord.cycles,
				actionable: result.actionableCycles.length,
				signalsEmitted: result.signals.length,
				cycles: result.allCycles.slice(0, 15).map((c) => ({
					path: c.path.join(" → "),
					hops: c.hops,
					profitPct: `${c.profitPct.toFixed(4)}%`,
					rawMultiplier: c.rawMultiplier.toFixed(6),
					netMultiplier: c.netMultiplier.toFixed(6),
					maxVolume: `$${c.maxVolumeUsd.toFixed(0)}`,
					estProfit: `$${c.estimatedProfitUsd.toFixed(2)}`,
					sources: c.sources.join(", "),
					edges: c.edges.map((e) => ({
						from: e.from,
						to: e.to,
						rate: e.rate.toFixed(8),
						pair: e.pair,
						source: e.source,
					})),
				})),
				signals: result.signals.map((s) => ({
					pair: s.pair,
					confidence: (s.confidence * 100).toFixed(0) + "%",
					description: s.description,
				})),
				errors: result.errors,
				scannedAt: new Date().toISOString(),
			});
		},

		/** Get arbitrage scanning statistics */
		arb_stats: async (): Promise<string> => {
			const stats = scanner.getStats();
			return JSON.stringify({
				totalScans: stats.totalScans,
				totalCyclesFound: stats.totalCyclesFound,
				totalSignalsEmitted: stats.totalSignalsEmitted,
				avgCyclesPerScan: stats.avgCyclesPerScan,
				bestEverProfitPct: `${stats.bestEverProfitPct.toFixed(4)}%`,
				recentScans: stats.recentScans.map((s) => ({
					time: new Date(s.timestamp).toISOString(),
					cycles: s.cyclesFound,
					bestProfit: `${s.bestProfitPct.toFixed(4)}%`,
				})),
				config: scanner.getConfig(),
			});
		},
	};
}
