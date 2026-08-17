/**
 * Tool handlers for CEX (centralized exchange) market watching and learning.
 * Covers tokens like FLR, SOL, XLM on Crypto.com.
 */

import type { CexMarketWatcher } from "./cex-market-watcher.js";
import type { MarketLearner } from "./market-learner.js";

export interface CexHandlerDeps {
	watcher: CexMarketWatcher;
	learner: MarketLearner;
}

export function createCexHandlers(deps: CexHandlerDeps) {
	const { watcher, learner } = deps;

	return {
		/** Scan all watched CEX symbols — returns snapshots and opportunities */
		cex_scan_markets: async (): Promise<string> => {
			const result = await watcher.scan();
			return JSON.stringify({
				snapshots: result.snapshots.map((s) => ({
					symbol: s.label,
					price: `$${s.last.toFixed(6)}`,
					change24h: `${s.change24h > 0 ? "+" : ""}${(s.change24h * 100).toFixed(2)}%`,
					high24h: `$${s.high24h.toFixed(6)}`,
					low24h: `$${s.low24h.toFixed(6)}`,
					volume24h: `$${s.volume24h.toFixed(0)}`,
					spreadPct: s.spreadPct.toFixed(3) + "%",
					bidDepth: `$${s.bidDepth.toFixed(0)}`,
					askDepth: `$${s.askDepth.toFixed(0)}`,
					imbalance: s.imbalanceRatio.toFixed(2),
				})),
				opportunities: result.opportunities.map((o) => ({
					type: o.type,
					symbol: o.symbol,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
				scannedAt: new Date().toISOString(),
			});
		},

		/** Get CEX market summary across all watched symbols */
		cex_market_summary: async (): Promise<string> => {
			await watcher.scan();
			const summary = watcher.getSummary();
			return JSON.stringify({
				symbols: summary.symbols.map((s) => ({
					symbol: s.label,
					price: `$${s.last.toFixed(6)}`,
					change24h: s.change24h,
					spreadPct: s.spreadPct.toFixed(3) + "%",
					imbalance: s.imbalance.toFixed(2),
					direction: s.imbalance > 1.5 ? "BUY pressure" : s.imbalance < 0.67 ? "SELL pressure" : "neutral",
				})),
				mostVolatile: summary.mostVolatile
					? { symbol: summary.mostVolatile.label, change24h: `${(summary.mostVolatile.change24h * 100).toFixed(2)}%` }
					: null,
				bestSpread: summary.bestSpread
					? { symbol: summary.bestSpread.label, spreadPct: summary.bestSpread.spreadPct.toFixed(3) + "%" }
					: null,
				strongestImbalance: summary.strongestImbalance
					? { symbol: summary.strongestImbalance.label, ratio: summary.strongestImbalance.ratio.toFixed(2), direction: summary.strongestImbalance.direction }
					: null,
				watchedSymbols: watcher.getSymbols().map((s) => s.label),
			});
		},

		/** Get learned patterns for CEX-traded tokens */
		cex_learned_patterns: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string | undefined;
			const minConfidence = (args.min_confidence as number) ?? 0.2;

			// Run pattern learning
			if (pair) {
				learner.learnPatterns(pair);
			} else {
				for (const sym of watcher.getSymbols()) {
					learner.learnPatterns(sym.label);
				}
			}

			const patterns = learner.getPatterns(pair, minConfidence);
			return JSON.stringify({
				patterns: patterns.map((p) => ({
					type: p.type,
					pair: p.pair,
					confidence: (p.confidence * 100).toFixed(0) + "%",
					description: p.description,
					hour: p.hourOfDay != null ? `${p.hourOfDay}:00 UTC` : null,
					dayOfWeek: p.dayOfWeek != null ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.dayOfWeek] : null,
					occurrences: p.occurrences,
				})),
			});
		},

		/** Get hourly patterns for a CEX symbol */
		cex_hourly_patterns: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string;
			if (!pair) throw new Error("pair is required (e.g., 'FLR/USDT')");
			const days = (args.days as number) ?? 7;

			const hourly = learner.getHourlyPatterns(pair, days);
			return JSON.stringify({
				pair,
				lookbackDays: days,
				hours: hourly.map((h) => ({
					hour: `${String(h.hour).padStart(2, "0")}:00 UTC`,
					avgSpreadPct: h.avgSpreadPct.toFixed(4),
					avgImbalance: h.avgImbalance.toFixed(2),
					avgPriceChangePct: h.avgPriceChangePct.toFixed(4),
					samples: h.sampleCount,
					opportunity: h.bestOpportunityType ?? "none",
				})),
			});
		},

		/** Get daily digest for a CEX symbol */
		cex_daily_digest: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string | undefined;
			const date = args.date as string | undefined;

			// If no pair specified, iterate all watched symbols
			if (!pair) {
				const symbols = watcher.getSymbols();
				const digests: unknown[] = [];
				for (const sym of symbols) {
					const digest = learner.generateDailyDigest(sym.label, date);
					if (digest) {
						digests.push({
							date: digest.date,
							pair: digest.pair,
							open: `$${digest.openPrice?.toFixed(6)}`,
							close: `$${digest.closePrice?.toFixed(6)}`,
							high: `$${digest.highPrice?.toFixed(6)}`,
							low: `$${digest.lowPrice?.toFixed(6)}`,
							changePct: digest.changePct != null ? `${digest.changePct > 0 ? "+" : ""}${digest.changePct.toFixed(2)}%` : null,
							avgSpreadPct: digest.avgSpreadPct.toFixed(4) + "%",
							avgImbalance: digest.avgImbalance.toFixed(2),
							observations: digest.observations,
							patterns: digest.patterns,
						});
					}
				}
				return JSON.stringify({ digestCount: digests.length, digests });
			}

			const digest = learner.generateDailyDigest(pair, date);
			if (!digest) {
				return JSON.stringify({ message: `No observations for ${pair} on ${date ?? "today"}` });
			}

			return JSON.stringify({
				date: digest.date,
				pair: digest.pair,
				open: `$${digest.openPrice?.toFixed(6)}`,
				close: `$${digest.closePrice?.toFixed(6)}`,
				high: `$${digest.highPrice?.toFixed(6)}`,
				low: `$${digest.lowPrice?.toFixed(6)}`,
				changePct: digest.changePct != null ? `${digest.changePct > 0 ? "+" : ""}${digest.changePct.toFixed(2)}%` : null,
				avgSpreadPct: digest.avgSpreadPct.toFixed(4) + "%",
				avgImbalance: digest.avgImbalance.toFixed(2),
				observations: digest.observations,
				patterns: digest.patterns,
			});
		},

		/** Get snapshot history for a CEX symbol */
		cex_price_history: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string;
			if (!pair) throw new Error("pair is required");
			const limit = (args.limit as number) ?? 30;

			// Map label to snapshot history
			const history = watcher.getHistory(pair, limit);
			return JSON.stringify({
				pair,
				snapshots: history.map((s) => ({
					time: new Date(s.timestamp).toISOString(),
					price: `$${s.last.toFixed(6)}`,
					spreadPct: s.spreadPct.toFixed(4),
					volume24h: `$${s.volume24h.toFixed(0)}`,
					change24h: `${(s.change24h * 100).toFixed(2)}%`,
					imbalance: s.imbalanceRatio.toFixed(2),
				})),
				count: history.length,
			});
		},
	};
}
