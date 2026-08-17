import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/shadow-status.tsx
import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { z } from "zod";
import { jsx, jsxs } from "react/jsx-runtime";
var ShadowStatusSchema = z.object({
  available: z.boolean().optional(),
  enabled: z.boolean().optional(),
  error: z.string().optional(),
  // Counts
  openPositionCount: z.number().optional(),
  closedTrades: z.number().optional(),
  totalShadowTrades: z.number().optional(),
  // PnL / win rate
  totalPnl: z.number().optional(),
  winRate: z.number().optional(),
  // Equity / drawdown — historically not in trade_shadow_status output,
  // but reserved here so a future gateway version can populate them.
  totalEquity: z.number().optional(),
  equity: z.number().optional(),
  peakEquity: z.number().optional(),
  drawdown: z.number().optional(),
  drawdownPct: z.number().optional()
}).passthrough();
function fmtUsd(value) {
  if (value === void 0 || !Number.isFinite(value)) return "\u2014";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtPct(value, fractionDigits = 2) {
  if (value === void 0 || !Number.isFinite(value)) return "\u2014";
  return `${value.toFixed(fractionDigits)}%`;
}
function deriveDrawdownPct(data) {
  if (data.drawdownPct !== void 0) return data.drawdownPct;
  if (data.drawdown !== void 0) {
    return Math.abs(data.drawdown) <= 1 ? data.drawdown * 100 : data.drawdown;
  }
  const equity = data.equity ?? data.totalEquity;
  const peak = data.peakEquity;
  if (equity !== void 0 && peak !== void 0 && peak > 0) {
    return (peak - equity) / peak * 100;
  }
  return void 0;
}
function ShadowStatusView({ port }) {
  const { exit } = useApp();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await requestGatewayJson(port, "/api/trading/shadow-status");
      if (cancelled) return;
      if (!res.ok || res.data === null) {
        setState({ loading: false, data: null, error: res.error ?? `HTTP ${res.status}` });
        return;
      }
      const parsed = ShadowStatusSchema.safeParse(res.data);
      if (!parsed.success) {
        setState({
          loading: false,
          data: null,
          error: `Schema validation failed: ${parsed.error.issues[0]?.message ?? "unknown"}`
        });
        return;
      }
      setState({ loading: false, data: parsed.data, error: null });
    })().catch((err) => {
      if (cancelled) return;
      setState({
        loading: false,
        data: null,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return () => {
      cancelled = true;
    };
  }, [port]);
  useEffect(() => {
    if (!state.loading) {
      const t = setTimeout(() => exit(), 0);
      return () => clearTimeout(t);
    }
  }, [state.loading, exit]);
  if (state.loading) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
      "Fetching shadow status from http://localhost:",
      port,
      "/api/trading/shadow-status\u2026"
    ] }) });
  }
  if (state.error) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "red", bold: true, children: "Shadow status request failed" }),
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: state.error }),
      /* @__PURE__ */ jsx(Text, { color: "gray", dimColor: true, children: "Endpoint: /api/trading/shadow-status (auth via gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY)" })
    ] });
  }
  const data = state.data;
  if (data.available === false) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "yellow", bold: true, children: "Shadow executor not configured" }),
      data.error ? /* @__PURE__ */ jsx(Text, { color: "gray", children: data.error }) : null
    ] });
  }
  const equity = data.equity ?? data.totalEquity;
  const drawdownPct = deriveDrawdownPct(data);
  const pnl = data.totalPnl ?? 0;
  const winRate = data.winRate;
  const pnlColor = pnl > 0 ? "green" : pnl < 0 ? "red" : "gray";
  const drawdownColor = drawdownPct === void 0 ? "gray" : drawdownPct >= 5 ? "red" : drawdownPct >= 2 ? "yellow" : "green";
  const winColor = winRate === void 0 ? "gray" : winRate >= 0.5 ? "green" : winRate > 0 ? "red" : "gray";
  const winRatePct = winRate === void 0 ? void 0 : winRate * 100;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, color: "white", children: "Zaraa Shadow Status" }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  port: ",
        port
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs(Text, { children: [
        "Equity:           ",
        /* @__PURE__ */ jsx(Text, { color: "white", children: fmtUsd(equity) })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Drawdown:         ",
        /* @__PURE__ */ jsx(Text, { color: drawdownColor, children: fmtPct(drawdownPct) })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Open Positions:   ",
        /* @__PURE__ */ jsx(Text, { color: "white", children: data.openPositionCount ?? "\u2014" })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Closed Trades:    ",
        /* @__PURE__ */ jsx(Text, { color: "white", children: data.closedTrades ?? "\u2014" })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Cumulative P&L:   ",
        /* @__PURE__ */ jsx(Text, { color: pnlColor, bold: true, children: fmtUsd(pnl) })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Win Rate:         ",
        /* @__PURE__ */ jsx(Text, { color: winColor, children: fmtPct(winRatePct, 1) })
      ] })
    ] })
  ] });
}
export {
  ShadowStatusView
};
