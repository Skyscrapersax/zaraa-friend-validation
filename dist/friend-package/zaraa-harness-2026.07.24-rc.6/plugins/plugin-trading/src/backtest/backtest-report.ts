import type { BacktestResult } from "./backtester.js";

/**
 * Generate a human-readable markdown report from a backtest result.
 */
export function generateBacktestReport(result: BacktestResult): string {
	const p = result.performance;
	const returnPct = (((result.config.startingEquity + p.totalPnl) / result.config.startingEquity) - 1) * 100;

	const lines: string[] = [
		`## Backtest Report — ${result.strategy} on ${result.symbol}`,
		``,
		`**Period:** ${result.startDate} → ${result.endDate}  `,
		`**Timeframe:** ${result.timeframe} | **Candles:** ${result.candlesUsed} | **Signals:** ${result.signals}`,
		``,
		`### Performance`,
		`| Metric | Value |`,
		`|--------|-------|`,
		`| Total Return | ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}% |`,
		`| Total P&L | $${p.totalPnl.toFixed(2)} |`,
		`| Starting Equity | $${result.config.startingEquity.toFixed(2)} |`,
		`| Final Equity | $${(result.config.startingEquity + p.totalPnl).toFixed(2)} |`,
		`| Total Trades | ${p.totalTrades} |`,
		`| Win Rate | ${(p.winRate * 100).toFixed(1)}% (${p.winningTrades}W / ${p.losingTrades}L) |`,
		`| Profit Factor | ${p.profitFactor.toFixed(2)} |`,
		`| Avg Win | $${p.avgWin.toFixed(2)} |`,
		`| Avg Loss | $${p.avgLoss.toFixed(2)} |`,
		`| Expectancy | $${p.expectancy.toFixed(2)} / trade |`,
		`| Avg R-Multiple | ${p.avgRMultiple.toFixed(2)}R |`,
		`| Max Drawdown | $${Math.abs(p.maxDrawdown).toFixed(2)} (${p.maxDrawdownPct.toFixed(1)}%) |`,
		`| Sharpe Ratio | ${p.sharpeRatio.toFixed(2)} |`,
		`| Sortino Ratio | ${p.sortinoRatio.toFixed(2)} |`,
		`| Best Trade | $${p.bestTrade.toFixed(2)} |`,
		`| Worst Trade | $${p.worstTrade.toFixed(2)} |`,
		`| Avg Holding Bars | ${p.avgHoldingBars.toFixed(1)} |`,
	];

	if (result.trades.length > 0) {
		lines.push(``, `### Last 10 Trades`);
		lines.push(`| # | Dir | Entry | Exit | P&L | R | Exit Reason |`);
		lines.push(`|---|-----|-------|------|-----|---|-------------|`);
		const recent = result.trades.slice(-10);
		recent.forEach((t, i) => {
			const pnlStr = (t.pnl >= 0 ? "+" : "") + "$" + t.pnl.toFixed(2);
			lines.push(
				`| ${result.trades.length - recent.length + i + 1} | ${t.direction} | $${t.entryPrice.toFixed(2)} | $${t.exitPrice.toFixed(2)} | ${pnlStr} | ${t.rMultiple.toFixed(2)}R | ${t.exitReason} |`,
			);
		});
	}

	return lines.join("\n");
}
