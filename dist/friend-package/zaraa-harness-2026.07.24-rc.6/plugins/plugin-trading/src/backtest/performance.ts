export interface BacktestTrade {
	entryTime: number;
	exitTime: number;
	direction: "long" | "short";
	entryPrice: number;
	exitPrice: number;
	qty: number;
	pnl: number;
	rMultiple: number; // pnl in terms of initial risk units
	exitReason: "stop-loss" | "take-profit" | "signal-exit" | "end-of-data";
}

export interface PerformanceMetrics {
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
	expectancy: number; // avg profit per trade
	maxDrawdown: number;
	maxDrawdownPct: number;
	sharpeRatio: number;
	sortinoRatio: number;
	avgHoldingBars: number;
	bestTrade: number;
	worstTrade: number;
}

export function calculatePerformance(
	trades: BacktestTrade[],
	equityCurve: number[],
): PerformanceMetrics {
	if (trades.length === 0) {
		return emptyMetrics();
	}

	const winners = trades.filter((t) => t.pnl > 0);
	const losers = trades.filter((t) => t.pnl < 0);

	// Single pass for totalPnl + best/worst trade: avoids two extra map() arrays
	// and the V8 spread-arg cap (~65-125k) that Math.max(...) would hit on large
	// trade arrays (trades is guaranteed non-empty by the early return above).
	let totalPnl = 0;
	let bestTrade = trades[0].pnl;
	let worstTrade = trades[0].pnl;
	for (const t of trades) {
		totalPnl += t.pnl;
		if (t.pnl > bestTrade) bestTrade = t.pnl;
		if (t.pnl < worstTrade) worstTrade = t.pnl;
	}
	const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
	const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

	const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
	const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
	const avgRMultiple = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;

	// Drawdown from equity curve
	let maxDrawdown = 0;
	let maxDrawdownPct = 0;
	let peak = equityCurve[0] ?? 0;
	for (const equity of equityCurve) {
		if (equity > peak) peak = equity;
		const dd = peak - equity;
		if (dd > maxDrawdown) maxDrawdown = dd;
		const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
		if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
	}

	// Sharpe ratio (annualized, assuming daily returns)
	const returns = tradePnlReturns(trades, equityCurve[0] ?? 10000);
	const sharpeRatio = computeSharpe(returns);
	const sortinoRatio = computeSortino(returns);

	// Average holding period in bars
	const avgHoldingBars = trades.length > 0
		? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length
		: 0;

	return {
		totalTrades: trades.length,
		winningTrades: winners.length,
		losingTrades: losers.length,
		winRate: r2((winners.length / trades.length) * 100),
		totalPnl: r2(totalPnl),
		grossProfit: r2(grossProfit),
		grossLoss: r2(grossLoss),
		profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
		avgWin: r2(avgWin),
		avgLoss: r2(avgLoss),
		avgRMultiple: r2(avgRMultiple),
		expectancy: r2(totalPnl / trades.length),
		maxDrawdown: r2(maxDrawdown),
		maxDrawdownPct: r2(maxDrawdownPct),
		sharpeRatio: r2(sharpeRatio),
		sortinoRatio: r2(sortinoRatio),
		avgHoldingBars: Math.round(avgHoldingBars),
		bestTrade: r2(bestTrade),
		worstTrade: r2(worstTrade),
	};
}

function tradePnlReturns(trades: BacktestTrade[], startingEquity: number): number[] {
	let equity = startingEquity;
	return trades.map((t) => {
		const ret = equity > 0 ? t.pnl / equity : 0;
		equity += t.pnl;
		return ret;
	});
}

function computeSharpe(returns: number[]): number {
	if (returns.length < 2) return 0;
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
	const stdDev = Math.sqrt(variance);
	if (stdDev === 0) return 0;
	// Annualize assuming ~365 trades/year
	return (mean / stdDev) * Math.sqrt(365);
}

function computeSortino(returns: number[]): number {
	if (returns.length < 2) return 0;
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const downside = returns.filter((r) => r < 0);
	if (downside.length === 0) return mean > 0 ? Infinity : 0;
	const downsideVariance = downside.reduce((s, r) => s + r ** 2, 0) / downside.length;
	const downsideDev = Math.sqrt(downsideVariance);
	if (downsideDev === 0) return 0;
	return (mean / downsideDev) * Math.sqrt(365);
}

function emptyMetrics(): PerformanceMetrics {
	return {
		totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
		totalPnl: 0, grossProfit: 0, grossLoss: 0, profitFactor: 0,
		avgWin: 0, avgLoss: 0, avgRMultiple: 0, expectancy: 0,
		maxDrawdown: 0, maxDrawdownPct: 0, sharpeRatio: 0, sortinoRatio: 0,
		avgHoldingBars: 0, bestTrade: 0, worstTrade: 0,
	};
}

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
