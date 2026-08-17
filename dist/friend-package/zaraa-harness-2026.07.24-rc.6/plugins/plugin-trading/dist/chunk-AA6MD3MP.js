import {
  __export
} from "./chunk-MLKGABMK.js";

// src/engine/dca-strategy.ts
import { z } from "zod";

// src/indicators/index.ts
var indicators_exports = {};
__export(indicators_exports, {
  atr: () => atr,
  bollingerBands: () => bollingerBands,
  detectEmaCrossovers: () => detectEmaCrossovers,
  ema: () => ema,
  macd: () => macd,
  obv: () => obv,
  rsi: () => rsi,
  sma: () => sma,
  stochRsi: () => stochRsi,
  vwap: () => vwap
});
function sma(prices, period) {
  if (prices.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  result.push(sum / period);
  for (let i = period; i < prices.length; i++) {
    sum += prices[i] - prices[i - period];
    result.push(sum / period);
  }
  return result;
}
function ema(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  const result = [sum / period];
  for (let i = period; i < prices.length; i++) {
    const prev = result[result.length - 1];
    result.push(prices[i] * k + prev * (1 - k));
  }
  return result;
}
function detectEmaCrossovers(prices, fastPeriod, slowPeriod) {
  if (!Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod) || fastPeriod <= 0 || slowPeriod <= 0) {
    return [];
  }
  if (fastPeriod >= slowPeriod) {
    return [];
  }
  const fastSeries = ema(prices, fastPeriod);
  const slowSeries = ema(prices, slowPeriod);
  if (fastSeries.length === 0 || slowSeries.length === 0) return [];
  const offset = fastSeries.length - slowSeries.length;
  const out = [];
  const baseBarIndex = slowPeriod - 1;
  for (let i = 1; i < slowSeries.length; i++) {
    const f0 = fastSeries[offset + i - 1];
    const f1 = fastSeries[offset + i];
    const s0 = slowSeries[i - 1];
    const s1 = slowSeries[i];
    if (![f0, f1, s0, s1].every((x) => Number.isFinite(x))) continue;
    const barIndex = baseBarIndex + i;
    const price = prices[barIndex];
    if (!Number.isFinite(price)) continue;
    if (f0 <= s0 && f1 > s1) {
      out.push({ type: "golden_cross", index: barIndex, price });
    } else if (f0 >= s0 && f1 < s1) {
      out.push({ type: "death_cross", index: barIndex, price });
    }
  }
  return out;
}
function rsi(prices, period = 14) {
  if (prices.length < period + 1) return [];
  const result = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const smoothRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + smoothRs));
  }
  return result;
}
function macd(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastEma = ema(prices, fastPeriod);
  const slowEma = ema(prices, slowPeriod);
  const offset = fastEma.length - slowEma.length;
  const macdLine = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }
  const signalLine = ema(macdLine, signalPeriod);
  const sigOffset = macdLine.length - signalLine.length;
  const trimmedMacd = macdLine.slice(sigOffset);
  const histogram = trimmedMacd.map((m, i) => m - signalLine[i]);
  return { macd: trimmedMacd, signal: signalLine, histogram };
}
function bollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  const middle = sma(prices, period);
  if (middle.length === 0) return { upper: [], middle: [], lower: [] };
  const upper = [];
  const lower = [];
  let sumX = 0;
  let sumX2 = 0;
  for (let i = 0; i < period; i++) {
    sumX += prices[i];
    sumX2 += prices[i] * prices[i];
  }
  for (let i = 0; i < middle.length; i++) {
    if (i > 0) {
      const incoming = prices[i + period - 1];
      const outgoing = prices[i - 1];
      sumX += incoming - outgoing;
      sumX2 += incoming * incoming - outgoing * outgoing;
    }
    const mean = sumX / period;
    const variance = Math.max(0, sumX2 / period - mean * mean);
    const stdDev = Math.sqrt(variance);
    upper.push(mean + stdDevMultiplier * stdDev);
    lower.push(mean - stdDevMultiplier * stdDev);
  }
  return { upper, middle, lower };
}
function atr(highs, lows, closes, period = 14) {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < 2) return [];
  const tr = [];
  for (let i = 1; i < len; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  if (tr.length < period) return [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  const result = [sum / period];
  for (let i = period; i < tr.length; i++) {
    const prev = result[result.length - 1];
    result.push((prev * (period - 1) + tr[i]) / period);
  }
  return result;
}
function vwap(highs, lows, closes, volumes) {
  const len = Math.min(highs.length, lows.length, closes.length, volumes.length);
  if (len === 0) return [];
  const result = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < len; i++) {
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    cumulativeTPV += typicalPrice * volumes[i];
    cumulativeVolume += volumes[i];
    result.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }
  return result;
}
function stochRsi(prices, rsiPeriod = 14, stochPeriod = 14) {
  const rsiValues = rsi(prices, rsiPeriod);
  if (rsiValues.length < stochPeriod) return [];
  const result = [];
  const minDeque = [];
  const maxDeque = [];
  for (let i = 0; i < rsiValues.length; i++) {
    const val = rsiValues[i];
    const windowStart = i - stochPeriod + 1;
    if (minDeque.length > 0 && minDeque[0] < windowStart) minDeque.shift();
    if (maxDeque.length > 0 && maxDeque[0] < windowStart) maxDeque.shift();
    while (minDeque.length > 0 && rsiValues[minDeque[minDeque.length - 1]] >= val) {
      minDeque.pop();
    }
    minDeque.push(i);
    while (maxDeque.length > 0 && rsiValues[maxDeque[maxDeque.length - 1]] <= val) {
      maxDeque.pop();
    }
    maxDeque.push(i);
    if (i >= stochPeriod - 1) {
      const min = rsiValues[minDeque[0]];
      const max = rsiValues[maxDeque[0]];
      result.push(max === min ? 50 : (val - min) / (max - min) * 100);
    }
  }
  return result;
}
function obv(closes, volumes) {
  const len = Math.min(closes.length, volumes.length);
  if (len === 0) return [];
  const result = [0];
  for (let i = 1; i < len; i++) {
    if (closes[i] > closes[i - 1]) {
      result.push(result[i - 1] + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      result.push(result[i - 1] - volumes[i]);
    } else {
      result.push(result[i - 1]);
    }
  }
  return result;
}

// src/engine/dca-strategy.ts
var DCAIntervalSchema = z.enum(["hourly", "daily", "weekly"]);
var DCAConfigSchema = z.object({
  symbol: z.string().min(1),
  amountUsd: z.number().positive(),
  interval: DCAIntervalSchema,
  dipBonusPct: z.number().min(0).max(100).optional(),
  dipBonusMultiplier: z.number().min(1).max(10).default(2),
  enabled: z.boolean().default(true)
});
var DCAConfigureInputSchema = z.object({
  pairs: z.array(DCAConfigSchema).min(1).max(20)
});
var DCAStateSchema = z.object({
  symbol: z.string().min(1),
  totalInvestedUsd: z.number().finite().nonnegative(),
  totalQtyBought: z.number().finite().nonnegative(),
  avgCostBasis: z.number().finite().nonnegative(),
  lastBuyAt: z.string().nullable(),
  buyCount: z.number().int().nonnegative()
});
var INTERVAL_MS = {
  hourly: 60 * 60 * 1e3,
  daily: 24 * 60 * 60 * 1e3,
  weekly: 7 * 24 * 60 * 60 * 1e3
};
function isDue(config, state, now) {
  if (!config.enabled) return false;
  if (!state.lastBuyAt) return true;
  const last = new Date(state.lastBuyAt).getTime();
  const current = (now ?? /* @__PURE__ */ new Date()).getTime();
  return current - last >= INTERVAL_MS[config.interval];
}
function calculateBuyAmount(config, currentPrice, smaPrice, maxTradeUsd) {
  if (currentPrice <= 0) throw new Error("currentPrice must be positive");
  let amountUsd = config.amountUsd;
  let isDipBuy = false;
  if (smaPrice != null && smaPrice > 0 && config.dipBonusPct != null && config.dipBonusPct > 0) {
    const threshold = smaPrice * (1 - config.dipBonusPct / 100);
    if (currentPrice < threshold) {
      amountUsd *= config.dipBonusMultiplier ?? 2;
      isDipBuy = true;
    }
  }
  if (maxTradeUsd != null && maxTradeUsd > 0) {
    amountUsd = Math.min(amountUsd, maxTradeUsd);
  }
  return { amountUsd, isDipBuy };
}
function updateState(state, boughtQty, spentUsd, buyTime) {
  const newTotalInvested = state.totalInvestedUsd + spentUsd;
  const newTotalQty = state.totalQtyBought + boughtQty;
  return {
    symbol: state.symbol,
    totalInvestedUsd: newTotalInvested,
    totalQtyBought: newTotalQty,
    avgCostBasis: newTotalQty > 0 ? newTotalInvested / newTotalQty : 0,
    lastBuyAt: (buyTime ?? /* @__PURE__ */ new Date()).toISOString(),
    buyCount: state.buyCount + 1
  };
}
function emptyState(symbol) {
  return {
    symbol,
    totalInvestedUsd: 0,
    totalQtyBought: 0,
    avgCostBasis: 0,
    lastBuyAt: null,
    buyCount: 0
  };
}
var DCA_CONFIG_KEY = "dca_configs";
var DCA_STATE_PREFIX = "dca_state_";
function loadConfigs(store) {
  const raw = store.getSetting(DCA_CONFIG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return z.array(DCAConfigSchema).parse(parsed);
  } catch {
    return [];
  }
}
function saveConfigs(store, configs) {
  store.setSetting(DCA_CONFIG_KEY, JSON.stringify(configs));
}
function loadState(store, symbol) {
  const raw = store.getSetting(DCA_STATE_PREFIX + symbol);
  if (!raw) return emptyState(symbol);
  try {
    return DCAStateSchema.parse(JSON.parse(raw));
  } catch {
    return emptyState(symbol);
  }
}
function saveState(store, state) {
  store.setSetting(DCA_STATE_PREFIX + state.symbol, JSON.stringify(state));
}
function computeSmaPrice(closingPrices, period = 20) {
  const values = sma(closingPrices, period);
  return values.length > 0 ? values[values.length - 1] : void 0;
}

export {
  sma,
  ema,
  detectEmaCrossovers,
  rsi,
  macd,
  bollingerBands,
  atr,
  vwap,
  stochRsi,
  obv,
  indicators_exports,
  DCAIntervalSchema,
  DCAConfigSchema,
  DCAConfigureInputSchema,
  DCAStateSchema,
  isDue,
  calculateBuyAmount,
  updateState,
  emptyState,
  loadConfigs,
  saveConfigs,
  loadState,
  saveState,
  computeSmaPrice
};
