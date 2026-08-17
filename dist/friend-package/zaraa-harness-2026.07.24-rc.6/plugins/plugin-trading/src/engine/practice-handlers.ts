/**
 * Practice trading handlers — ties the OpportunityTrader to all watchers.
 * On each tick: scan markets → evaluate opportunities → open/close paper trades.
 */

import type { OpportunityTrader, OpportunitySignal } from "./opportunity-trader.js";
import type { XRPLDEXWatcher } from "../xrpl/xrpl-dex-watcher.js";
import type { CexMarketWatcher } from "../xrpl/cex-market-watcher.js";
import type { MultiDEXWatcher } from "../dex/multi-dex-watcher.js";

export interface PracticeHandlerDeps {
	trader: OpportunityTrader;
	xrplWatcher: XRPLDEXWatcher;
	cexWatcher: CexMarketWatcher;
	multiDexWatcher: MultiDEXWatcher;
}

/**
 * Bound a market scan that can hang on a stalled upstream fetch. Per-fetch
 * AbortSignal timeouts live in the clients, but a watcher fans out many fetches,
 * so one wedged feed can still keep `practice_tick` awaiting past the 300s cron
 * budget — the scheduler then kills the tick before evaluate() ever runs and no
 * paper trades open (inv#24). On timeout the promise rejects, so the caller's
 * existing try/catch skips-and-logs that feed and evaluate() still runs on
 * whatever the other feeds returned.
 * ponytail: fixed 20s cap (3 scans worst-case 60s « 300s budget); make per-feed
 * configurable only if a specific feed legitimately needs longer.
 */
const SCAN_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, label: string, ms = SCAN_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} scan timed out after ${ms}ms`)), ms);
	});
	// Swallow a late rejection from the loser so a slow scan that settles after
	// the race is decided can't surface as an unhandledRejection.
	promise.catch(() => {});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createPracticeHandlers(deps: PracticeHandlerDeps) {
	const { trader, xrplWatcher, cexWatcher, multiDexWatcher } = deps;

	return {
		/** Run one practice trading tick: scan all markets, evaluate opportunities, manage positions */
		practice_tick: async (): Promise<string> => {
			const signals: OpportunitySignal[] = [];
			const prices = new Map<string, number>();
			const errors: string[] = [];

			// 1. Scan XRPL DEX
			try {
				const xrpl = await withTimeout(xrplWatcher.scan(), "xrpl");
				for (const opp of xrpl.opportunities) {
					signals.push({
						source: "xrpl",
						pair: opp.pair,
						type: opp.type as OpportunitySignal["type"],
						direction: inferDirection(opp.type, opp.details),
						confidence: opp.confidence,
						entryPrice: (opp.details.midPrice as number) ?? 0,
						description: opp.description,
					});
				}
				for (const s of xrpl.snapshots) {
					if (s.midPrice != null) prices.set(s.pair, s.midPrice);
				}
			} catch (e) {
				errors.push(`xrpl: ${e instanceof Error ? e.message : String(e)}`);
			}

			// 2. Scan CEX markets
			try {
				const cex = await withTimeout(cexWatcher.scan(), "cex");
				for (const opp of cex.opportunities) {
					signals.push({
						source: "cex",
						pair: opp.symbol,
						type: opp.type as OpportunitySignal["type"],
						direction: inferDirection(opp.type, opp.details),
						confidence: opp.confidence,
						entryPrice: (opp.details.last as number) ?? (opp.details.midPrice as number) ?? 0,
						description: opp.description,
					});
				}
				for (const s of cex.snapshots) {
					prices.set(s.label, s.last);
				}
			} catch (e) {
				errors.push(`cex: ${e instanceof Error ? e.message : String(e)}`);
			}

			// 3. Scan multi-chain DEXes (Stellar, Solana, Flare)
			try {
				const dex = await withTimeout(multiDexWatcher.scanAll(), "dex");
				for (const opp of dex.opportunities) {
					signals.push({
						source: opp.chain,
						pair: opp.pair,
						type: opp.type as OpportunitySignal["type"],
						direction: inferDirection(opp.type, opp.details),
						confidence: opp.confidence,
						entryPrice: (opp.details.midPrice as number) ?? (opp.details.priceEnd as number) ?? 0,
						description: opp.description,
					});
				}
				for (const s of dex.snapshots) {
					if (s.midPrice != null) prices.set(s.pair, s.midPrice);
				}
			} catch (e) {
				errors.push(`dex: ${e instanceof Error ? e.message : String(e)}`);
			}

			// 4. Evaluate signals and open trades
			const opened: { pair: string; direction: string; price: number; type: string }[] = [];
			for (const signal of signals) {
				if (signal.entryPrice <= 0) continue;
				// Ensure price is in the map for position tracking
				if (!prices.has(signal.pair)) prices.set(signal.pair, signal.entryPrice);

				const pos = await trader.evaluate(signal);
				if (pos) {
					opened.push({
						pair: pos.pair,
						direction: pos.direction,
						price: pos.entryPrice,
						type: pos.strategyType,
					});
				}
			}

			// 5. Update open positions with current prices and check exits
			const updateResult = trader.update(prices);

			// 6. Get stats
			const stats = trader.getStats();

			return JSON.stringify({
				tick: new Date().toISOString(),
				signalsFound: signals.length,
				tradesOpened: opened,
				positionsUpdated: updateResult.updated,
				tradesClosed: updateResult.closed,
				openPositions: trader.getOpenPositions().map((p) => ({
					pair: p.pair,
					source: p.source,
					type: p.strategyType,
					direction: p.direction,
					entry: p.entryPrice.toFixed(6),
					current: p.currentPrice.toFixed(6),
					pnl: `$${p.pnl.toFixed(2)}`,
					pnlPct: `${p.pnlPct.toFixed(2)}%`,
					age: `${Math.round((Date.now() - p.openedAt) / 60000)}m`,
				})),
				performance: {
					equity: `$${stats.equity.toFixed(2)}`,
					totalReturn: `$${stats.totalReturn.toFixed(2)} (${stats.totalReturnPct.toFixed(2)}%)`,
					trades: stats.totalTrades,
					winRate: `${stats.winRate}%`,
					profitFactor: stats.profitFactor,
					drawdown: `${stats.drawdownPct}%`,
				},
				errors,
			});
		},

		/** Get full practice trading stats and performance breakdown */
		practice_stats: async (): Promise<string> => {
			const stats = trader.getStats();
			return JSON.stringify({
				halted: trader.isHalted(),
				haltReason: trader.isHalted() ? trader.getHaltReason() : null,
				equity: `$${stats.equity.toFixed(2)}`,
				startingEquity: `$${stats.startingEquity.toFixed(2)}`,
				totalReturn: `$${stats.totalReturn.toFixed(2)}`,
				totalReturnPct: `${stats.totalReturnPct.toFixed(2)}%`,
				peakEquity: `$${stats.peakEquity.toFixed(2)}`,
				drawdown: `${stats.drawdownPct.toFixed(2)}%`,
				totalTrades: stats.totalTrades,
				openPositions: stats.openPositions,
				winRate: `${stats.winRate}%`,
				avgWin: `$${stats.avgWin.toFixed(2)}`,
				avgLoss: `$${stats.avgLoss.toFixed(2)}`,
				profitFactor: stats.profitFactor,
				bestTrade: stats.bestTrade
					? `${stats.bestTrade.pair}: $${stats.bestTrade.pnl.toFixed(2)} (${stats.bestTrade.pnlPct.toFixed(2)}%)`
					: null,
				worstTrade: stats.worstTrade
					? `${stats.worstTrade.pair}: $${stats.worstTrade.pnl.toFixed(2)} (${stats.worstTrade.pnlPct.toFixed(2)}%)`
					: null,
				bySource: stats.bySource.map((s) => ({
					source: s.source,
					trades: s.trades,
					pnl: `$${s.pnl.toFixed(2)}`,
					winRate: `${s.winRate}%`,
				})),
				byStrategy: stats.byStrategy.map((s) => ({
					type: s.type,
					trades: s.trades,
					pnl: `$${s.pnl.toFixed(2)}`,
					winRate: `${s.winRate}%`,
				})),
				recentTrades: stats.recentTrades.slice(0, 10).map((t: { pair: string; source: string; strategyType: string; direction: string; pnl: number; pnlPct: number; exitReason: string; duration: number }) => ({
					pair: t.pair,
					source: t.source,
					type: t.strategyType,
					direction: t.direction,
					pnl: `$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%)`,
					exit: t.exitReason,
					duration: `${Math.round(t.duration / 60000)}m`,
				})),
				positions: trader.getOpenPositions().map((p) => ({
					pair: p.pair,
					source: p.source,
					direction: p.direction,
					entry: `$${p.entryPrice.toFixed(6)}`,
					current: `$${p.currentPrice.toFixed(6)}`,
					pnl: `$${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(2)}%)`,
					stop: `$${p.stopLoss.toFixed(6)}`,
					tp: `$${p.takeProfit.toFixed(6)}`,
					age: `${Math.round((Date.now() - p.openedAt) / 60000)}m`,
				})),
			});
		},

		/** Get just the open positions */
		practice_positions: async (): Promise<string> => {
			const positions = trader.getOpenPositions();
			return JSON.stringify({
				positions: positions.map((p) => ({
					pair: p.pair,
					source: p.source,
					type: p.strategyType,
					direction: p.direction,
					entry: `$${p.entryPrice.toFixed(6)}`,
					current: `$${p.currentPrice.toFixed(6)}`,
					pnl: `$${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(2)}%)`,
					stopLoss: `$${p.stopLoss.toFixed(6)}`,
					takeProfit: `$${p.takeProfit.toFixed(6)}`,
					age: `${Math.round((Date.now() - p.openedAt) / 60000)}m`,
					maxAge: `${Math.round(p.maxAgeMs / 60000)}m`,
				})),
				count: positions.length,
				equity: `$${trader.getStats().equity.toFixed(2)}`,
			});
		},

		/**
		 * Clear a HALTED state on the opportunity trader after operator review.
		 * Resets consecutiveLosses to 0 and clears the persisted halt flag.
		 * Use only when you've looked at the closed-trade history and decided
		 * the halt was valid-and-handled (or a false positive).
		 */
		practice_resume_trading: async (): Promise<string> => {
			const wasHalted = trader.isHalted();
			const priorReason = trader.getHaltReason();
			trader.resetCircuitBreaker();
			return JSON.stringify({
				wasHalted,
				priorReason: wasHalted ? priorReason : null,
				halted: trader.isHalted(),
				message: wasHalted
					? `Halt cleared (was: ${priorReason}). Consecutive losses reset to 0.`
					: "Trader was not halted; no change.",
			});
		},
	};
}

/** Infer trade direction from opportunity type and details */
function inferDirection(type: string, details: Record<string, unknown>): "long" | "short" {
	switch (type) {
		case "momentum": {
			const dir = details.direction as string | undefined;
			return dir === "down" ? "short" : "long";
		}
		case "imbalance":
		case "buy_sell_ratio": {
			const dir = details.direction as string | undefined;
			return dir === "selling" || dir === "sell" ? "short" : "long";
		}
		case "volatility": {
			const dir = details.direction as string | undefined;
			return dir === "down" ? "short" : "long";
		}
		case "spread_capture":
			return "long"; // Buy low side of spread
		case "depth_gap":
			return "long"; // Thin ask side = potential upside
		case "liquidity_shift": {
			const change = details.liqChange as number | undefined;
			return change != null && change > 0 ? "long" : "short";
		}
		default:
			return "long";
	}
}
