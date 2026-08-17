import type { Position } from "../trading-store.js";
import type { StrategyTradeRecord } from "../engine/trade-journal.js";

export interface PortfolioSummary {
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
	currentStreak: { type: "win" | "loss" | "none"; count: number };
	longestWinStreak: number;
	longestLossStreak: number;
}

export interface SymbolBreakdown {
	symbol: string;
	trades: number;
	winRate: number;
	totalPnl: number;
	avgPnl: number;
}

export interface DayBreakdown {
	day: string;
	trades: number;
	winRate: number;
	totalPnl: number;
}

export interface StrategyComparison {
	name: string;
	trades: number;
	winRate: number;
	totalPnl: number;
	avgRMultiple: number;
	profitFactor: number;
	expectancy: number;
}

export interface FullAnalytics {
	portfolio: PortfolioSummary;
	bySymbol: SymbolBreakdown[];
	byDay: DayBreakdown[];
	equityHigh: number;
	equityLow: number;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Analyzes actual trading performance from closed positions and strategy trades.
 * Pure functions — no DB dependency, works on arrays.
 */
export class PortfolioAnalyzer {
	/**
	 * Compute full portfolio analytics from closed positions.
	 */
	analyze(
		allPositions: Position[],
		equitySnapshots: { equity: number }[],
	): FullAnalytics {
		const closed = allPositions.filter((p) => p.status === "closed" && p.pnl != null);
		const open = allPositions.filter((p) => p.status === "open");

		const portfolio = this.computeSummary(closed, open);
		const bySymbol = this.breakdownBySymbol(closed);
		const byDay = this.breakdownByDay(closed);

		const equities = equitySnapshots.map((s) => s.equity);

		return {
			portfolio,
			bySymbol,
			byDay,
			equityHigh: equities.length > 0 ? Math.max(...equities) : 0,
			equityLow: equities.length > 0 ? Math.min(...equities) : 0,
		};
	}

	private computeSummary(closed: Position[], open: Position[]): PortfolioSummary {
		if (closed.length === 0) {
			const unrealizedPnl = open.reduce((s, p) => s + (p.pnl ?? 0), 0);
			return {
				totalTrades: 0,
				openPositions: open.length,
				winningTrades: 0,
				losingTrades: 0,
				winRate: 0,
				totalPnl: 0,
				unrealizedPnl: r2(unrealizedPnl),
				grossProfit: 0,
				grossLoss: 0,
				profitFactor: 0,
				avgWin: 0,
				avgLoss: 0,
				expectancy: 0,
				bestTrade: 0,
				worstTrade: 0,
				maxDrawdown: 0,
				maxDrawdownPct: 0,
				currentStreak: { type: "none", count: 0 },
				longestWinStreak: 0,
				longestLossStreak: 0,
			};
		}

		const winners = closed.filter((p) => (p.pnl ?? 0) > 0);
		const losers = closed.filter((p) => (p.pnl ?? 0) < 0);
		const unrealizedPnl = open.reduce((s, p) => s + (p.pnl ?? 0), 0);

		const totalPnl = closed.reduce((s, p) => s + (p.pnl ?? 0), 0);
		const grossProfit = winners.reduce((s, p) => s + (p.pnl ?? 0), 0);
		const grossLoss = Math.abs(losers.reduce((s, p) => s + (p.pnl ?? 0), 0));

		const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
		const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;

		const pnls = closed.map((p) => p.pnl ?? 0);
		const { current, longestWin, longestLoss } = computeStreaks(pnls);

		// Drawdown from cumulative P&L
		const { maxDD, maxDDPct } = computeDrawdown(pnls);

		return {
			totalTrades: closed.length,
			openPositions: open.length,
			winningTrades: winners.length,
			losingTrades: losers.length,
			winRate: r2((winners.length / closed.length) * 100),
			totalPnl: r2(totalPnl),
			unrealizedPnl: r2(unrealizedPnl),
			grossProfit: r2(grossProfit),
			grossLoss: r2(grossLoss),
			profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : grossProfit > 0 ? 999.99 : 0,
			avgWin: r2(avgWin),
			avgLoss: r2(avgLoss),
			expectancy: closed.length > 0 ? r2(totalPnl / closed.length) : 0,
			bestTrade: r2(Math.max(...pnls)),
			worstTrade: r2(Math.min(...pnls)),
			maxDrawdown: r2(maxDD),
			maxDrawdownPct: r2(maxDDPct),
			currentStreak: current,
			longestWinStreak: longestWin,
			longestLossStreak: longestLoss,
		};
	}

	private breakdownBySymbol(closed: Position[]): SymbolBreakdown[] {
		const bySymbol = new Map<string, Position[]>();
		for (const p of closed) {
			const list = bySymbol.get(p.symbol) || [];
			list.push(p);
			bySymbol.set(p.symbol, list);
		}

		return Array.from(bySymbol.entries())
			.map(([symbol, positions]) => {
				const wins = positions.filter((p) => (p.pnl ?? 0) > 0).length;
				const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
				return {
					symbol,
					trades: positions.length,
					winRate: r2((wins / positions.length) * 100),
					totalPnl: r2(totalPnl),
					avgPnl: r2(totalPnl / positions.length),
				};
			})
			.sort((a, b) => b.totalPnl - a.totalPnl);
	}

	private breakdownByDay(closed: Position[]): DayBreakdown[] {
		const byDay = new Map<number, Position[]>();
		for (const p of closed) {
			if (!p.closedAt) continue;
			const day = new Date(p.closedAt).getDay();
			const list = byDay.get(day) || [];
			list.push(p);
			byDay.set(day, list);
		}

		return Array.from(byDay.entries())
			.map(([dayIndex, positions]) => {
				const wins = positions.filter((p) => (p.pnl ?? 0) > 0).length;
				const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
				return {
					day: DAYS[dayIndex],
					trades: positions.length,
					winRate: r2((wins / positions.length) * 100),
					totalPnl: r2(totalPnl),
				};
			})
			.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
	}

	/**
	 * Compare strategies side-by-side using strategy trade records.
	 */
	compareStrategies(trades: StrategyTradeRecord[]): StrategyComparison[] {
		const closed = trades.filter((t) => t.exitedAt != null && t.pnl != null);
		const byStrategy = new Map<string, StrategyTradeRecord[]>();
		for (const t of closed) {
			const list = byStrategy.get(t.strategyName) || [];
			list.push(t);
			byStrategy.set(t.strategyName, list);
		}

		return Array.from(byStrategy.entries())
			.map(([name, stratTrades]) => {
				const count = stratTrades.length;
				const wins = stratTrades.filter((t) => (t.pnl ?? 0) > 0);
				const losers = stratTrades.filter((t) => (t.pnl ?? 0) < 0);
				const totalPnl = stratTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
				const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
				const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
				const avgR = count > 0 ? stratTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / count : 0;

				return {
					name,
					trades: count,
					winRate: count > 0 ? r2((wins.length / count) * 100) : 0,
					totalPnl: r2(totalPnl),
					avgRMultiple: r2(avgR),
					profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : grossProfit > 0 ? 999.99 : 0,
					expectancy: count > 0 ? r2(totalPnl / count) : 0,
				};
			})
			.sort((a, b) => b.totalPnl - a.totalPnl);
	}
}

function computeStreaks(pnls: number[]): {
	current: { type: "win" | "loss" | "none"; count: number };
	longestWin: number;
	longestLoss: number;
} {
	if (pnls.length === 0) {
		return { current: { type: "none", count: 0 }, longestWin: 0, longestLoss: 0 };
	}

	let longestWin = 0;
	let longestLoss = 0;
	let currentWin = 0;
	let currentLoss = 0;

	for (const pnl of pnls) {
		if (pnl > 0) {
			currentWin++;
			currentLoss = 0;
			if (currentWin > longestWin) longestWin = currentWin;
		} else if (pnl < 0) {
			currentLoss++;
			currentWin = 0;
			if (currentLoss > longestLoss) longestLoss = currentLoss;
		} else {
			currentWin = 0;
			currentLoss = 0;
		}
	}

	const lastPnl = pnls[pnls.length - 1];
	const current = lastPnl > 0
		? { type: "win" as const, count: currentWin }
		: lastPnl < 0
			? { type: "loss" as const, count: currentLoss }
			: { type: "none" as const, count: 0 };

	return { current, longestWin, longestLoss };
}

function computeDrawdown(pnls: number[]): { maxDD: number; maxDDPct: number } {
	if (pnls.length === 0) return { maxDD: 0, maxDDPct: 0 };

	let cumulative = 0;
	let peak = 0;
	let maxDD = 0;
	let maxDDPct = 0;

	for (const pnl of pnls) {
		cumulative += pnl;
		if (cumulative > peak) peak = cumulative;
		const dd = peak - cumulative;
		if (dd > maxDD) maxDD = dd;
		const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
		if (ddPct > maxDDPct) maxDDPct = ddPct;
	}

	return { maxDD, maxDDPct };
}

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
