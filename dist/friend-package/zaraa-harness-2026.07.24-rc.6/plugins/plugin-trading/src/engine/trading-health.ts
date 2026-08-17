/**
 * TradingHealthAggregator — single pane of glass for trading system health.
 *
 * Aggregates all safety subsystem statuses into one queryable report.
 * This is the canonical endpoint an operator checks to know whether
 * trading is healthy, degraded, or halted.
 */

import type { TradingStore } from "../trading-store.js";
import type { TradingCircuitBreaker } from "../risk/trading-circuit-breaker.js";
import type { ExchangeHealthMonitor } from "./exchange-health-monitor.js";
import type { StopScheduler } from "../risk/stop-scheduler.js";
import type { PriceFreshnessGuard } from "../risk/price-freshness-guard.js";
import { resolvePaperMode } from "../risk/trading-mode.js";

export type OverallHealth = "HEALTHY" | "DEGRADED" | "CRITICAL" | "HALTED";

export interface TradingHealthReport {
  overall: OverallHealth;
  timestamp: number;
  systems: {
    killSwitch: { active: boolean };
    circuitBreaker: { status: string; tripped: boolean };
    drawdownBreaker: { status: string; currentDrawdownPct: number };
    dailyLossLimit: { remaining: number; used: number; limit: number };
    exchangeHealth: Record<string, { status: string; latencyMs: number }>;
    stopScheduler: { running: boolean; lastCheckAt: number };
    openPositions: { count: number; totalExposureUsd: number };
    stalePrices: string[];
  };
  alerts: string[];
}

export interface TradingHealthDeps {
  store?: TradingStore;
  circuitBreaker?: TradingCircuitBreaker;
  exchangeHealthMonitor?: ExchangeHealthMonitor;
  stopScheduler?: StopScheduler;
  priceFreshnessGuard?: PriceFreshnessGuard;
}

export class TradingHealthAggregator {
  private deps: TradingHealthDeps;

  constructor(deps: TradingHealthDeps = {}) {
    this.deps = deps;
  }

  getHealth(): TradingHealthReport {
    const alerts: string[] = [];
    const now = Date.now();

    // ── Kill switch ──────────────────────────────────────────────────────
    const killSwitchActive = this.isKillSwitchActive();
    if (killSwitchActive) {
      alerts.push("Kill switch is active — all trading halted");
    }

    // ── Circuit breaker ──────────────────────────────────────────────────
    const cbStatus = this.getCircuitBreakerInfo();
    if (cbStatus.tripped) {
      alerts.push(`Circuit breaker tripped: ${cbStatus.status}`);
    }

    // ── Drawdown breaker ─────────────────────────────────────────────────
    const ddStatus = this.getDrawdownBreakerInfo();
    if (ddStatus.status === "TRIPPED") {
      alerts.push(`Drawdown breaker tripped at ${ddStatus.currentDrawdownPct.toFixed(1)}%`);
    }

    // ── Daily loss limit ─────────────────────────────────────────────────
    const dailyLoss = this.getDailyLossInfo();
    if (dailyLoss.limit > 0) {
      const usedPct = (dailyLoss.used / dailyLoss.limit) * 100;
      if (usedPct >= 100) {
        alerts.push("Daily loss limit exhausted");
      } else if (usedPct >= 80) {
        alerts.push(`Daily loss limit ${usedPct.toFixed(0)}% used ($${dailyLoss.used.toFixed(2)} / $${dailyLoss.limit.toFixed(2)})`);
      }
    }

    // ── Exchange health ──────────────────────────────────────────────────
    const exchangeHealth = this.getExchangeHealthInfo();
    for (const [exchange, info] of Object.entries(exchangeHealth)) {
      if (info.status === "UNHEALTHY") {
        alerts.push(`Exchange ${exchange} is UNHEALTHY (latency: ${info.latencyMs}ms)`);
      } else if (info.status === "DEGRADED") {
        alerts.push(`Exchange ${exchange} is DEGRADED (latency: ${info.latencyMs}ms)`);
      }
    }

    // ── Stop scheduler ───────────────────────────────────────────────────
    const stopSched = this.getStopSchedulerInfo();
    if (this.deps.stopScheduler && !stopSched.running) {
      alerts.push("Stop scheduler is NOT running — stops will not be enforced");
    }

    // ── Open positions ───────────────────────────────────────────────────
    const positions = this.getOpenPositionInfo();

    // ── Stale prices ─────────────────────────────────────────────────────
    const stalePrices = this.getStalePrices();
    if (stalePrices.length > 0) {
      alerts.push(`Stale prices for: ${stalePrices.join(", ")}`);
    }

    // ── Determine overall status ─────────────────────────────────────────
    const overall = this.computeOverall({
      killSwitchActive,
      cbTripped: cbStatus.tripped,
      ddTripped: ddStatus.status === "TRIPPED",
      dailyLoss,
      exchangeHealth,
      stalePrices,
    });

    return {
      overall,
      timestamp: now,
      systems: {
        killSwitch: { active: killSwitchActive },
        circuitBreaker: cbStatus,
        drawdownBreaker: { status: ddStatus.status, currentDrawdownPct: ddStatus.currentDrawdownPct },
        dailyLossLimit: dailyLoss,
        exchangeHealth,
        stopScheduler: stopSched,
        openPositions: positions,
        stalePrices,
      },
      alerts,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private isKillSwitchActive(): boolean {
    if (!this.deps.store) return false;
    const state = this.deps.store.getTradingState();
    return state === "HALTED";
  }

  private getCircuitBreakerInfo(): { status: string; tripped: boolean } {
    if (!this.deps.circuitBreaker) {
      return { status: "NOT_CONFIGURED", tripped: false };
    }
    const s = this.deps.circuitBreaker.getStatus();
    return {
      status: s.halted ? s.reasons.join("; ") : "OK",
      tripped: s.halted,
    };
  }

  private getDrawdownBreakerInfo(): { status: string; currentDrawdownPct: number } {
    // Drawdown status comes from the SQLite-backed TradingCircuitBreaker, which
    // owns peak-equity drawdown tracking. (The former standalone in-memory
    // DrawdownCircuitBreaker was never wired into live execution — removed to
    // eliminate the false-confidence phantom.)
    if (this.deps.circuitBreaker) {
      const s = this.deps.circuitBreaker.getDrawdownStatus();
      return { status: s.tripped ? "TRIPPED" : "OK", currentDrawdownPct: s.currentDrawdownPct };
    }
    return { status: "NOT_CONFIGURED", currentDrawdownPct: 0 };
  }

  private getDailyLossInfo(): { remaining: number; used: number; limit: number } {
    if (!this.deps.store) {
      return { remaining: 0, used: 0, limit: 0 };
    }
    const limitStr = this.deps.store.getSetting("daily_limit_usd");
    const limit = limitStr ? Number(limitStr) : 0;
    if (!limit || !Number.isFinite(limit) || limit <= 0) {
      return { remaining: 0, used: 0, limit: 0 };
    }
    const isPaper = resolvePaperMode(this.deps.store);
    const today = new Date().toISOString().slice(0, 10);
    const summary = this.deps.store.getDailyPnLSummary(today, isPaper);
    // Daily loss is negative P&L — used is the absolute value of losses
    const used = summary.totalPnl < 0 ? Math.abs(summary.totalPnl) : 0;
    const remaining = Math.max(0, limit - used);
    return { remaining, used, limit };
  }

  private getExchangeHealthInfo(): Record<string, { status: string; latencyMs: number }> {
    if (!this.deps.exchangeHealthMonitor) return {};
    const all = this.deps.exchangeHealthMonitor.getAllHealth();
    const result: Record<string, { status: string; latencyMs: number }> = {};
    for (const h of all) {
      result[h.exchange] = { status: h.status, latencyMs: h.avgLatencyMs };
    }
    return result;
  }

  private getStopSchedulerInfo(): { running: boolean; lastCheckAt: number } {
    if (!this.deps.stopScheduler) {
      return { running: false, lastCheckAt: 0 };
    }
    return {
      running: this.deps.stopScheduler.isRunning,
      lastCheckAt: this.deps.stopScheduler.checkCount > 0 ? Date.now() : 0,
    };
  }

  private getOpenPositionInfo(): { count: number; totalExposureUsd: number } {
    if (!this.deps.store) return { count: 0, totalExposureUsd: 0 };
    const positions = this.deps.store.getOpenPositions();
    const totalExposureUsd = positions.reduce(
      (sum, p) => sum + Math.abs(p.entryPrice * p.qty),
      0,
    );
    return { count: positions.length, totalExposureUsd };
  }

  private getStalePrices(): string[] {
    if (!this.deps.priceFreshnessGuard) return [];
    const allStats = this.deps.priceFreshnessGuard.getAllStats();
    const stale: string[] = [];
    for (const [symbol, stats] of allStats) {
      // Consider a price stale if the last stale event was within the last 2 minutes
      if (stats.lastStaleAt && (Date.now() - stats.lastStaleAt) < 120_000) {
        stale.push(symbol);
      }
    }
    return stale;
  }

  private computeOverall(ctx: {
    killSwitchActive: boolean;
    cbTripped: boolean;
    ddTripped: boolean;
    dailyLoss: { used: number; limit: number };
    exchangeHealth: Record<string, { status: string; latencyMs: number }>;
    stalePrices: string[];
  }): OverallHealth {
    // HALTED: kill switch on or circuit breaker tripped
    if (ctx.killSwitchActive || ctx.cbTripped) {
      return "HALTED";
    }

    // CRITICAL: drawdown breaker active or daily loss > 80% used
    if (ctx.ddTripped) return "CRITICAL";
    if (ctx.dailyLoss.limit > 0) {
      const usedPct = (ctx.dailyLoss.used / ctx.dailyLoss.limit) * 100;
      if (usedPct > 80) return "CRITICAL";
    }

    // DEGRADED: any exchange unhealthy or stale prices
    const anyUnhealthy = Object.values(ctx.exchangeHealth).some(
      (h) => h.status === "UNHEALTHY" || h.status === "DEGRADED",
    );
    if (anyUnhealthy || ctx.stalePrices.length > 0) {
      return "DEGRADED";
    }

    return "HEALTHY";
  }
}
