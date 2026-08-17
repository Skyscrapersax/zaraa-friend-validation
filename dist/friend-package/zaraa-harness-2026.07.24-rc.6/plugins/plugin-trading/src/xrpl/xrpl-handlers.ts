/**
 * Tool handlers for XRPL DEX watching, market learning, and opportunity detection.
 * These integrate with the existing trading plugin architecture.
 */

import type { XRPLClient } from "./xrpl-client.js";
import { DEX_PAIRS } from "./xrpl-client.js";
import type { XRPLDEXWatcher } from "./xrpl-dex-watcher.js";
import type { MarketLearner } from "./market-learner.js";

export interface XRPLHandlerDeps {
	client: XRPLClient;
	watcher: XRPLDEXWatcher;
	learner: MarketLearner;
}

export function createXRPLHandlers(deps: XRPLHandlerDeps) {
	const { client, watcher, learner } = deps;

	return {
		/** Scan the XRPL DEX for all watched pairs — returns order book snapshots and opportunities */
		xrpl_scan_dex: async (): Promise<string> => {
			const result = await watcher.scan();
			return JSON.stringify({
				snapshots: result.snapshots.map((s) => ({
					pair: s.pair,
					midPrice: s.midPrice?.toFixed(6),
					spreadPct: s.spreadPct?.toFixed(3),
					bidDepth: s.bidDepth.toFixed(2),
					askDepth: s.askDepth.toFixed(2),
					imbalance: s.imbalanceRatio.toFixed(2),
					bidLevels: s.bidLevels,
					askLevels: s.askLevels,
				})),
				opportunities: result.opportunities.map((o) => ({
					type: o.type,
					pair: o.pair,
					confidence: (o.confidence * 100).toFixed(0) + "%",
					description: o.description,
				})),
				errors: result.errors,
				scannedAt: new Date().toISOString(),
			});
		},

		/** Get the order book for a specific XRPL DEX trading pair */
		xrpl_get_orderbook: async (args: Record<string, unknown>): Promise<string> => {
			const pairLabel = args.pair as string;
			const depth = (args.depth as number) ?? 15;

			// Find the pair config
			const pair = DEX_PAIRS.find((p) => p.label.toLowerCase() === pairLabel.toLowerCase())
				?? watcher.getPairs().find((p) => p.label.toLowerCase() === pairLabel.toLowerCase());

			if (!pair) {
				return JSON.stringify({
					error: `Unknown pair: ${pairLabel}. Available: ${[...DEX_PAIRS.map((p) => p.label), ...watcher.getPairs().map((p) => p.label)].join(", ")}`,
				});
			}

			const book = await client.getOrderBook(pair.base, pair.quote, depth);
			return JSON.stringify({
				pair: pairLabel,
				midPrice: book.midPrice?.toFixed(6),
				spread: book.spread?.toFixed(8),
				spreadPct: book.spreadPct?.toFixed(3) + "%",
				bids: book.bids.slice(0, depth).map((b) => ({ price: b.price.toFixed(6), qty: b.quantity.toFixed(4) })),
				asks: book.asks.slice(0, depth).map((a) => ({ price: a.price.toFixed(6), qty: a.quantity.toFixed(4) })),
				timestamp: new Date(book.timestamp).toISOString(),
			});
		},

		/** Get the DEX summary across all watched pairs */
		xrpl_dex_summary: async (): Promise<string> => {
			// Trigger a fresh scan first
			await watcher.scan();
			const summary = watcher.getSummary();
			return JSON.stringify({
				pairs: summary.pairs.map((p) => ({
					pair: p.label,
					midPrice: p.midPrice?.toFixed(6),
					spreadPct: p.spreadPct?.toFixed(3),
					imbalance: p.imbalance.toFixed(2),
					direction: p.imbalance > 1.5 ? "BUY pressure" : p.imbalance < 0.67 ? "SELL pressure" : "neutral",
				})),
				bestSpread: summary.bestSpread
					? { pair: summary.bestSpread.pair, spreadPct: summary.bestSpread.spreadPct.toFixed(3) + "%" }
					: null,
				strongestImbalance: summary.strongestImbalance
					? { pair: summary.strongestImbalance.pair, ratio: summary.strongestImbalance.ratio.toFixed(2), direction: summary.strongestImbalance.direction }
					: null,
				watchedPairs: watcher.getPairs().map((p) => p.label),
			});
		},

		/** Get XRPL account info (balance, reserves, trust lines) */
		xrpl_account_info: async (args: Record<string, unknown>): Promise<string> => {
			const address = args.address as string;
			if (!address) throw new Error("address is required");

			const [info, lines] = await Promise.all([
				client.getAccountInfo(address),
				client.getTrustLines(address),
			]);

			return JSON.stringify({
				address,
				balanceXRP: info.balance.toFixed(6),
				reserveXRP: info.reserve.toFixed(6),
				availableXRP: (info.balance - info.reserve).toFixed(6),
				ownedObjects: info.ownerCount,
				trustLines: lines.map((l) => ({
					currency: l.currency.length > 3 ? hexToString(l.currency) : l.currency,
					issuer: l.account,
					balance: l.balance,
					limit: l.limit,
				})),
			});
		},

		/** Get what Zaraa has learned about market patterns */
		xrpl_learned_patterns: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string | undefined;
			const minConfidence = (args.min_confidence as number) ?? 0.2;

			// Run pattern learning first
			if (pair) {
				learner.learnPatterns(pair);
			} else {
				for (const p of watcher.getPairs()) {
					learner.learnPatterns(p.label);
				}
			}

			const patterns = learner.getPatterns(pair, minConfidence);
			const summary = learner.getLearningSummary();

			return JSON.stringify({
				summary: {
					totalObservations: summary.totalObservations,
					pairsTracked: summary.pairsTracked,
					patternsLearned: summary.patternsLearned,
					digestCount: summary.digestCount,
				},
				patterns: patterns.map((p) => ({
					type: p.type,
					pair: p.pair,
					confidence: (p.confidence * 100).toFixed(0) + "%",
					description: p.description,
					hour: p.hourOfDay != null ? `${p.hourOfDay}:00 UTC` : null,
					dayOfWeek: p.dayOfWeek != null ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.dayOfWeek] : null,
					occurrences: p.occurrences,
					lastSeen: p.lastSeen,
				})),
			});
		},

		/** Get hourly patterns for a pair — when do spreads widen, when does momentum hit? */
		xrpl_hourly_patterns: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string;
			if (!pair) throw new Error("pair is required");
			const days = (args.days as number) ?? 7;

			const hourly = learner.getHourlyPatterns(pair, days);
			return JSON.stringify({
				pair,
				lookbackDays: days,
				hours: hourly.map((h) => ({
					hour: `${String(h.hour).padStart(2, "0")}:00 UTC`,
					avgSpreadPct: h.avgSpreadPct.toFixed(3),
					avgImbalance: h.avgImbalance.toFixed(2),
					avgPriceChangePct: h.avgPriceChangePct.toFixed(3),
					samples: h.sampleCount,
					opportunity: h.bestOpportunityType ?? "none",
				})),
			});
		},

		/** Get daily digest for a pair — what happened today/on a specific date? */
		xrpl_daily_digest: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string | undefined;
			const date = args.date as string | undefined;

			// If no pair specified, iterate all watched pairs
			if (!pair) {
				const pairs = watcher.getPairs();
				const digests: unknown[] = [];
				for (const p of pairs) {
					const digest = learner.generateDailyDigest(p.label, date);
					if (digest) {
						digests.push({
							date: digest.date,
							pair: digest.pair,
							open: digest.openPrice?.toFixed(6),
							close: digest.closePrice?.toFixed(6),
							high: digest.highPrice?.toFixed(6),
							low: digest.lowPrice?.toFixed(6),
							changePct: digest.changePct != null ? `${digest.changePct > 0 ? "+" : ""}${digest.changePct.toFixed(2)}%` : null,
							avgSpreadPct: digest.avgSpreadPct.toFixed(3) + "%",
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
				open: digest.openPrice?.toFixed(6),
				close: digest.closePrice?.toFixed(6),
				high: digest.highPrice?.toFixed(6),
				low: digest.lowPrice?.toFixed(6),
				changePct: digest.changePct != null ? `${digest.changePct > 0 ? "+" : ""}${digest.changePct.toFixed(2)}%` : null,
				avgSpreadPct: digest.avgSpreadPct.toFixed(3) + "%",
				avgImbalance: digest.avgImbalance.toFixed(2),
				observations: digest.observations,
				patterns: digest.patterns,
			});
		},

		/** Get recent daily digests for a pair */
		xrpl_digest_history: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string;
			if (!pair) throw new Error("pair is required");
			const limit = (args.limit as number) ?? 14;

			const digests = learner.getDigests(pair, limit);
			return JSON.stringify({
				pair,
				digests: digests.map((d) => ({
					date: d.date,
					changePct: d.changePct != null ? `${d.changePct > 0 ? "+" : ""}${d.changePct.toFixed(2)}%` : null,
					avgSpread: d.avgSpreadPct.toFixed(3) + "%",
					observations: d.observations,
					patterns: d.patterns,
				})),
			});
		},

		/** Get snapshot history for a pair — recent price/depth observations */
		xrpl_price_history: async (args: Record<string, unknown>): Promise<string> => {
			const pair = args.pair as string;
			if (!pair) throw new Error("pair is required");
			const limit = (args.limit as number) ?? 30;

			const history = watcher.getHistory(pair, limit);
			return JSON.stringify({
				pair,
				snapshots: history.map((s) => ({
					time: new Date(s.timestamp).toISOString(),
					midPrice: s.midPrice?.toFixed(6),
					spreadPct: s.spreadPct?.toFixed(3),
					bidDepth: s.bidDepth.toFixed(2),
					askDepth: s.askDepth.toFixed(2),
					imbalance: s.imbalanceRatio.toFixed(2),
				})),
				count: history.length,
			});
		},

		/** Get XRPL server info (ledger status, fees) */
		xrpl_server_info: async (): Promise<string> => {
			const info = await client.getServerInfo();
			return JSON.stringify({
				ledgerIndex: info.ledgerIndex,
				baseFeeXRP: info.baseFeeXRP,
				serverState: info.serverState,
			});
		},
	};
}

/** Convert hex-encoded currency code to readable string */
function hexToString(hex: string): string {
	try {
		const bytes = Buffer.from(hex, "hex");
		return bytes.toString("utf8").replace(/\0/g, "").trim();
	} catch (err) {
		console.debug("[xrpl-handlers] hex decode failed:", err instanceof Error ? err.message : err);
		return hex;
	}
}
