export interface TradeRecord {
  symbol: string;
  pnl: number;
  side: "BUY" | "SELL";
  strategy?: string;
  closedAt: string;
}

export interface PositionSnapshot {
  symbol: string;
  unrealizedPnl: number;
  sizeUsd: number;
}

export interface DailyDigest {
  date: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  riskUtilization: number;
  strategyBreakdown: Record<string, { trades: number; pnl: number; winRate: number }>;
  anomalyFlags: string[];
  generatedAt: string;
}

export class DailyDigestGenerator {
  /**
   * Generate a daily digest from trades closed today and current positions.
   */
  generate(input: {
    closedTrades: TradeRecord[];
    openPositions: PositionSnapshot[];
    maxPositionSizeUsd: number;
    anomalyFlags?: string[];
    date?: string;
  }): DailyDigest {
    const { closedTrades, openPositions, maxPositionSizeUsd, anomalyFlags = [] } = input;
    const date = input.date ?? new Date().toISOString().slice(0, 10);

    const realizedPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalPnl = realizedPnl + unrealizedPnl;

    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl <= 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;

    const sorted = [...closedTrades].sort((a, b) => b.pnl - a.pnl);
    const bestTrade = sorted.length > 0 ? { symbol: sorted[0].symbol, pnl: sorted[0].pnl } : null;
    const worstTrade = sorted.length > 0 ? { symbol: sorted[sorted.length - 1].symbol, pnl: sorted[sorted.length - 1].pnl } : null;

    const totalExposure = openPositions.reduce((sum, p) => sum + Math.abs(p.sizeUsd), 0);
    const riskUtilization = maxPositionSizeUsd > 0 ? (totalExposure / maxPositionSizeUsd) * 100 : 0;

    // Strategy breakdown
    const strategyBreakdown: Record<string, { trades: number; pnl: number; winRate: number }> = {};
    for (const trade of closedTrades) {
      const strat = trade.strategy ?? "unknown";
      if (!strategyBreakdown[strat]) strategyBreakdown[strat] = { trades: 0, pnl: 0, winRate: 0 };
      strategyBreakdown[strat].trades++;
      strategyBreakdown[strat].pnl += trade.pnl;
    }
    for (const [strat, data] of Object.entries(strategyBreakdown)) {
      const stratTrades = closedTrades.filter(t => (t.strategy ?? "unknown") === strat);
      const stratWins = stratTrades.filter(t => t.pnl > 0);
      data.winRate = stratTrades.length > 0 ? (stratWins.length / stratTrades.length) * 100 : 0;
    }

    return {
      date,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      tradesCount: closedTrades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: Math.round(winRate * 10) / 10,
      bestTrade,
      worstTrade,
      riskUtilization: Math.round(riskUtilization * 10) / 10,
      strategyBreakdown,
      anomalyFlags,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Format digest as a human-readable notification message */
  formatForNotification(digest: DailyDigest): string {
    const lines = [
      `📊 Daily Trading Digest — ${digest.date}`,
      `P&L: $${digest.totalPnl.toFixed(2)} (realized: $${digest.realizedPnl.toFixed(2)}, unrealized: $${digest.unrealizedPnl.toFixed(2)})`,
      `Trades: ${digest.tradesCount} (${digest.winCount}W / ${digest.lossCount}L, ${digest.winRate}% win rate)`,
    ];
    if (digest.bestTrade) lines.push(`Best: ${digest.bestTrade.symbol} +$${digest.bestTrade.pnl.toFixed(2)}`);
    if (digest.worstTrade) lines.push(`Worst: ${digest.worstTrade.symbol} $${digest.worstTrade.pnl.toFixed(2)}`);
    lines.push(`Risk utilization: ${digest.riskUtilization}%`);
    if (digest.anomalyFlags.length > 0) {
      lines.push(`⚠️ Anomalies: ${digest.anomalyFlags.join(", ")}`);
    }
    return lines.join("\n");
  }
}
