import {
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/leaderboard.tsx
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function fmtUsd(n) {
  const abs = Math.abs(n).toFixed(2);
  return n >= 0 ? `+$${abs}` : `-$${abs}`;
}
function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}
function fmtSharpe(n) {
  return n === 0 ? "\u2014" : n.toFixed(2);
}
function pnlColor(n) {
  if (n > 0) return "green";
  if (n < 0) return "red";
  return "white";
}
function rankMedal(rank) {
  if (rank === 1) return "#1";
  if (rank === 2) return "#2";
  if (rank === 3) return "#3";
  return `#${rank}`;
}
function sparkline(values) {
  const blocks = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.slice(-14).map((v) => {
    const idx = Math.floor((v - min) / range * (blocks.length - 1));
    return blocks[Math.max(0, Math.min(idx, blocks.length - 1))];
  }).join("");
}
function Leaderboard({ period = "30d", port = 3927 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const loadLeaderboard = async () => {
      const result = await requestGatewayJson(
        port,
        `/api/leaderboard?period=${encodeURIComponent(period)}`
      );
      if (!result.ok) {
        const snapshot = await collectGatewayAccessSnapshot(port);
        setError(
          buildGatewayEndpointFailureMessage(
            "Leaderboard is unavailable.",
            "/api/leaderboard",
            port,
            snapshot,
            [result]
          )
        );
        setLoading(false);
        return;
      }
      setData(result.data);
      setLoading(false);
    };
    void loadLeaderboard();
  }, [period, port]);
  if (loading) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "Loading leaderboard\u2026" }) });
  }
  if (error) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsxs(Text, { color: "red", children: [
        "Error: ",
        error
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "Use `zaraa pulse` for the current operator diagnosis." })
    ] });
  }
  if (!data || data.count === 0) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsxs(Text, { bold: true, color: "cyan", children: [
        "Strategy Leaderboard (",
        period,
        ")"
      ] }),
      /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "yellow", children: data?.note ?? "No closed strategy trades found for this period." }) }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "Trades must close before they appear here." })
    ] });
  }
  const COL = {
    rank: 4,
    name: 18,
    trades: 7,
    winRate: 7,
    pnl: 12,
    avg: 11,
    maxDD: 10,
    sharpe: 7,
    spark: 16
  };
  const header = [
    "Rank".padEnd(COL.rank),
    "Strategy".padEnd(COL.name),
    "Trades".padStart(COL.trades),
    "Win%".padStart(COL.winRate),
    "Total P&L".padStart(COL.pnl),
    "Avg/Trade".padStart(COL.avg),
    "MaxDD".padStart(COL.maxDD),
    "Sharpe".padStart(COL.sharpe),
    "Trend (14d)".padStart(COL.spark)
  ].join("  ");
  const separator = "\u2500".repeat(header.length);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", paddingX: 1, paddingY: 1, children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: "cyan", children: `Strategy Leaderboard \u2014 Last ${period === "all" ? "All Time" : period}` }),
    /* @__PURE__ */ jsx(Box, { marginBottom: 1 }),
    /* @__PURE__ */ jsx(Text, { color: "gray", children: header }),
    /* @__PURE__ */ jsx(Text, { color: "gray", children: separator }),
    data.leaderboard.map((m) => /* @__PURE__ */ jsx(Box, { flexDirection: "row", children: /* @__PURE__ */ jsxs(Text, { children: [
      /* @__PURE__ */ jsx(Text, { color: m.rank <= 3 ? "yellow" : "white", children: rankMedal(m.rank).padEnd(COL.rank) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { bold: true, children: m.strategyName.padEnd(COL.name) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { children: String(m.numTrades).padStart(COL.trades) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: m.winRate >= 0.5 ? "green" : "red", children: fmtPct(m.winRate).padStart(COL.winRate) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: pnlColor(m.totalPnl), children: fmtUsd(m.totalPnl).padStart(COL.pnl) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: pnlColor(m.avgReturn), children: fmtUsd(m.avgReturn).padStart(COL.avg) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: m.maxDrawdown < 0 ? "red" : "gray", children: fmtUsd(m.maxDrawdown).padStart(COL.maxDD) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: m.sharpeRatio > 1 ? "green" : m.sharpeRatio > 0 ? "yellow" : "red", children: fmtSharpe(m.sharpeRatio).padStart(COL.sharpe) }),
      "  ",
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: sparkline(m.pnlHistory).padStart(COL.spark) })
    ] }) }, m.strategyName)),
    /* @__PURE__ */ jsx(Text, { color: "gray", children: separator }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: `${data.count} strategies \xB7 ranked by total P&L \xB7 period: ${period}` }) }),
    /* @__PURE__ */ jsx(Text, { color: "gray", children: "Sharpe > 1 = good risk-adjusted return  |  MaxDD = biggest loss from a peak" })
  ] });
}
export {
  Leaderboard
};
