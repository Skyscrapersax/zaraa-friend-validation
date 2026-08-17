/**
 * ShadowReport — summarizes ShadowModeExecutor activity for operator review.
 *
 * Surfaces: total shadow trades, P&L curve, gate activation counts by strategy,
 * and anomaly flags (e.g. gates that never fired, unexpected loss streaks).
 */

import type { ShadowModeExecutor } from "./shadow-mode.js";

export interface PnlCurvePoint {
  tradeIndex: number;
  cumulativePnl: number;
  tradePnl: number;
  symbol: string;
  strategy: string;
  closedAt: number;
}

export interface GateActivationSummary {
  strategy: string;
  count: number;
}

export interface ShadowAnomaly {
  type: "no_gate_activations" | "consecutive_losses" | "high_rejection_rate" | "low_win_rate";
  detail: string;
}

export interface ShadowReport {
  generatedAt: number;
  totalShadowTrades: number;
  openPositionCount: number;
  closedPositionCount: number;
  totalPnl: number;
  winRate: number;
  avgSlippageBps: number;
  pnlCurve: PnlCurvePoint[];
  gateActivations: GateActivationSummary[];
  anomalies: ShadowAnomaly[];
  summary: string;
}

export function generateShadowReport(executor: ShadowModeExecutor): ShadowReport {
  const now = Date.now();
  const perf = executor.getShadowPerformance();
  const openPositions = executor.getOpenPositions();
  const closedPositions = executor.getClosedPositions();

  // ── P&L curve ────────────────────────────────────────────────────────────
  let cumulative = 0;
  const pnlCurve: PnlCurvePoint[] = closedPositions.map((pos, i) => {
    const tradePnl = pos.pnl ?? 0;
    cumulative += tradePnl;
    return {
      tradeIndex: i + 1,
      cumulativePnl: Math.round(cumulative * 10_000) / 10_000,
      tradePnl: Math.round(tradePnl * 10_000) / 10_000,
      symbol: pos.symbol,
      strategy: pos.strategy,
      closedAt: pos.exitedAt ?? now,
    };
  });

  // ── Gate activation counts by strategy ───────────────────────────────────
  const activationMap = new Map<string, number>();
  for (const pos of closedPositions) {
    const key = pos.strategy ?? "unknown";
    activationMap.set(key, (activationMap.get(key) ?? 0) + 1);
  }
  const gateActivations: GateActivationSummary[] = Array.from(activationMap.entries())
    .map(([strategy, count]) => ({ strategy, count }))
    .sort((a, b) => b.count - a.count);

  // ── Anomaly detection ─────────────────────────────────────────────────────
  const anomalies: ShadowAnomaly[] = [];

  if (closedPositions.length > 0 && gateActivations.length === 0) {
    anomalies.push({
      type: "no_gate_activations",
      detail: "Positions were closed but no strategy gate activations recorded — strategy field may be missing.",
    });
  }

  // Detect consecutive loss streak (≥ 3)
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const pos of closedPositions) {
    if ((pos.pnl ?? 0) < 0) {
      lossStreak++;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else {
      lossStreak = 0;
    }
  }
  if (maxLossStreak >= 3) {
    anomalies.push({
      type: "consecutive_losses",
      detail: `Max consecutive loss streak: ${maxLossStreak} trades. Review signal quality or stop-loss placement.`,
    });
  }

  // Win rate below 40% is a red flag
  if (closedPositions.length >= 5 && perf.winRate < 0.4) {
    anomalies.push({
      type: "low_win_rate",
      detail: `Win rate ${(perf.winRate * 100).toFixed(1)}% is below 40% threshold over ${closedPositions.length} closed trades.`,
    });
  }

  // ── Human-readable summary ────────────────────────────────────────────────
  const pnlSign = perf.totalPnl >= 0 ? "+" : "";
  const summaryParts: string[] = [
    `Shadow mode: ${closedPositions.length} closed trades, ${openPositions.length} open.`,
    `P&L: ${pnlSign}$${perf.totalPnl.toFixed(2)} | Win rate: ${(perf.winRate * 100).toFixed(1)}%.`,
  ];
  if (anomalies.length > 0) {
    summaryParts.push(`Anomalies: ${anomalies.map((a) => a.type).join(", ")}.`);
  } else {
    summaryParts.push("No anomalies detected.");
  }

  return {
    generatedAt: now,
    totalShadowTrades: perf.trades,
    openPositionCount: openPositions.length,
    closedPositionCount: closedPositions.length,
    totalPnl: perf.totalPnl,
    winRate: perf.winRate,
    avgSlippageBps: perf.avgSlippage,
    pnlCurve,
    gateActivations,
    anomalies,
    summary: summaryParts.join(" "),
  };
}
