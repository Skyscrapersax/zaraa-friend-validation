// src/engine/portfolio-rebalancer.ts
import { z } from "zod";
var RebalanceConfigureInputSchema = z.object({
  target_allocations: z.record(z.string(), z.number().min(0).max(1)),
  drift_threshold_pct: z.number().min(0.1).max(50).optional().default(5),
  max_trade_per_rebalance_pct: z.number().min(1).max(100).optional().default(10),
  enabled: z.boolean().optional().default(true)
});
var REBALANCE_CONFIG_KEY = "rebalance_config";
function computeRebalancePlan(config, positions, cashUsd) {
  const totalValue = positions.reduce((sum, p) => sum + p.valueUsd, 0) + cashUsd;
  if (totalValue <= 0) {
    return {
      trades: [],
      currentAllocations: {},
      targetAllocations: config.targetAllocations,
      totalDriftPct: 0,
      totalPortfolioValueUsd: 0,
      needsRebalance: false
    };
  }
  const currentAllocations = {};
  for (const pos of positions) {
    currentAllocations[pos.symbol] = pos.valueUsd / totalValue;
  }
  const allSymbols = /* @__PURE__ */ new Set([
    ...Object.keys(config.targetAllocations),
    ...Object.keys(currentAllocations)
  ]);
  let totalDriftPct = 0;
  const trades = [];
  for (const symbol of allSymbols) {
    const target = config.targetAllocations[symbol] ?? 0;
    const current = currentAllocations[symbol] ?? 0;
    const driftPct = Math.abs(current - target) * 100;
    totalDriftPct += driftPct;
    const diffUsd = (target - current) * totalValue;
    const maxTradeUsd = config.maxTradePerRebalancePct / 100 * totalValue;
    const cappedAmountUsd = Math.min(Math.abs(diffUsd), maxTradeUsd);
    if (driftPct < 0.5 || cappedAmountUsd < 1) continue;
    if (diffUsd > 0) {
      trades.push({
        symbol,
        direction: "buy",
        amountUsd: round2(cappedAmountUsd),
        reason: `Underweight: current ${(current * 100).toFixed(1)}% vs target ${(target * 100).toFixed(1)}% (drift ${driftPct.toFixed(1)}%)`
      });
    } else {
      trades.push({
        symbol,
        direction: "sell",
        amountUsd: round2(cappedAmountUsd),
        reason: `Overweight: current ${(current * 100).toFixed(1)}% vs target ${(target * 100).toFixed(1)}% (drift ${driftPct.toFixed(1)}%)`
      });
    }
  }
  trades.sort((a, b) => {
    if (a.direction === "sell" && b.direction === "buy") return -1;
    if (a.direction === "buy" && b.direction === "sell") return 1;
    return b.amountUsd - a.amountUsd;
  });
  const needsRebalance = totalDriftPct > config.driftThresholdPct;
  return {
    trades: needsRebalance ? trades : [],
    currentAllocations,
    targetAllocations: config.targetAllocations,
    totalDriftPct: round2(totalDriftPct),
    totalPortfolioValueUsd: round2(totalValue),
    needsRebalance
  };
}
async function executeRebalancePlan(plan, handlers, prices) {
  const executed = [];
  let totalSellsUsd = 0;
  let totalBuysUsd = 0;
  for (const trade of plan.trades) {
    const price = prices[trade.symbol];
    if (!price || price <= 0) {
      executed.push({
        symbol: trade.symbol,
        direction: trade.direction,
        requestedAmountUsd: trade.amountUsd,
        success: false,
        error: `No valid price available for ${trade.symbol}`
      });
      continue;
    }
    const qty = trade.amountUsd / price;
    try {
      let resultJson;
      if (trade.direction === "sell") {
        resultJson = await handlers.trade_sell({
          symbol: trade.symbol,
          qty,
          type: "MARKET"
        });
        const parsed = JSON.parse(resultJson);
        if (parsed.error) {
          executed.push({
            symbol: trade.symbol,
            direction: trade.direction,
            requestedAmountUsd: trade.amountUsd,
            success: false,
            resultJson,
            error: parsed.error
          });
        } else {
          totalSellsUsd += trade.amountUsd;
          executed.push({
            symbol: trade.symbol,
            direction: trade.direction,
            requestedAmountUsd: trade.amountUsd,
            success: true,
            resultJson
          });
        }
      } else {
        resultJson = await handlers.trade_buy({
          symbol: trade.symbol,
          qty,
          type: "MARKET"
        });
        const parsed = JSON.parse(resultJson);
        if (parsed.error) {
          executed.push({
            symbol: trade.symbol,
            direction: trade.direction,
            requestedAmountUsd: trade.amountUsd,
            success: false,
            resultJson,
            error: parsed.error
          });
        } else {
          totalBuysUsd += trade.amountUsd;
          executed.push({
            symbol: trade.symbol,
            direction: trade.direction,
            requestedAmountUsd: trade.amountUsd,
            success: true,
            resultJson
          });
        }
      }
    } catch (err) {
      executed.push({
        symbol: trade.symbol,
        direction: trade.direction,
        requestedAmountUsd: trade.amountUsd,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const succeeded = executed.filter((e) => e.success).length;
  const failed = executed.filter((e) => !e.success).length;
  return {
    plan,
    executed,
    summary: {
      totalTradesAttempted: executed.length,
      totalTradesSucceeded: succeeded,
      totalTradesFailed: failed,
      totalSellsUsd: round2(totalSellsUsd),
      totalBuysUsd: round2(totalBuysUsd)
    }
  };
}
function loadRebalanceConfig(getSetting) {
  const raw = getSetting(REBALANCE_CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveRebalanceConfig(setSetting, config) {
  setSetting(REBALANCE_CONFIG_KEY, JSON.stringify(config));
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

export {
  RebalanceConfigureInputSchema,
  REBALANCE_CONFIG_KEY,
  computeRebalancePlan,
  executeRebalancePlan,
  loadRebalanceConfig,
  saveRebalanceConfig
};
