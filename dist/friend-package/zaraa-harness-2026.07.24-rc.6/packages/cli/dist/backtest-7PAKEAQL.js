import {
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  fetchGatewayResponse
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/backtest.tsx
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function buildStableLineEntries(text) {
  const seen = /* @__PURE__ */ new Map();
  return text.split("\n").map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return { id: `${line}-${count}`, line };
  });
}
function buildStableCellEntries(cells) {
  const seen = /* @__PURE__ */ new Map();
  return cells.map((cell) => {
    const trimmed = cell.trim();
    const count = (seen.get(trimmed) ?? 0) + 1;
    seen.set(trimmed, count);
    return { id: `${trimmed}-${count}`, cell: trimmed };
  });
}
async function callTool(toolName, args, port) {
  try {
    const res = await fetchGatewayResponse(port, `/tool/${toolName}`, {
      method: "POST",
      body: args,
      timeoutMs: 3e4
    });
    if (!res.ok) {
      const text2 = (await res.text()).trim();
      if (res.status === 401 || res.status === 404) {
        const snapshot = await collectGatewayAccessSnapshot(port);
        throw new Error(
          buildGatewayEndpointFailureMessage(
            `Backtest tool \`${toolName}\` is unavailable.`,
            `/tool/${toolName}`,
            port,
            snapshot,
            [{ ok: false, status: res.status, data: null, error: `HTTP ${res.status}` }]
          )
        );
      }
      throw new Error(
        `Backtest tool \`${toolName}\` failed with HTTP ${res.status}${text2 ? `: ${text2}` : ""}`
      );
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Backtest tool `")) {
      throw error;
    }
    const snapshot = await collectGatewayAccessSnapshot(port);
    throw new Error(
      buildGatewayEndpointFailureMessage(
        `Backtest tool \`${toolName}\` is unavailable.`,
        `/tool/${toolName}`,
        port,
        snapshot,
        [{ ok: false, status: 0, data: null, error: message }]
      )
    );
  }
}
function RunBacktest({ strategy, pair, period, equity }) {
  const [status, setStatus] = useState("running");
  const [report, setReport] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const run = async () => {
      const port = parseInt(process.env.ZARAA_PORT ?? "3927", 10);
      try {
        setStatus("running");
        const symbol = pair?.replace(/\//g, "_").replace(/-/g, "_");
        const result = await callTool("trade_backtest", {
          strategy,
          ...symbol ? { symbol } : {},
          ...period ? { period } : {},
          ...equity ? { starting_equity: equity } : {}
        }, port);
        if (result && typeof result === "object" && "error" in result) {
          setError(result.error);
          setStatus("error");
          return;
        }
        const mdReport = result.report;
        setReport(mdReport ?? "No report generated.");
        const perf = result.performance;
        if (perf) {
          const returnPct = result.returnPct;
          const arrow = returnPct >= 0 ? "\u25B2" : "\u25BC";
          setSummary(
            `${arrow} ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}% return \xB7 ${perf.totalTrades} trades \xB7 ${perf.winRate.toFixed(1)}% win rate \xB7 Sharpe ${perf.sharpeRatio} \xB7 Max DD ${perf.maxDrawdownPct.toFixed(1)}%`
          );
        }
        setStatus("done");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
      }
    };
    run();
  }, [strategy, pair, period, equity]);
  if (status === "running") {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsxs(Text, { color: "cyan", children: [
        "Running backtest: ",
        strategy,
        " on ",
        pair ?? "BTC",
        " ",
        period ? `(${period})` : "",
        "..."
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "This may take a moment while indicators are computed." })
    ] });
  }
  if (status === "error") {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsxs(Text, { color: "red", children: [
        "Backtest failed: ",
        error
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", dimColor: true, children: "Try: zaraa backtest --strategy trend-following --pair BTC --period 30d" })
    ] });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsx(Box, { borderStyle: "single", paddingX: 1, marginBottom: 1, children: /* @__PURE__ */ jsx(Text, { bold: true, color: "green", children: "Backtest Complete" }) }),
    summary ? /* @__PURE__ */ jsx(Box, { marginBottom: 1, children: /* @__PURE__ */ jsx(Text, { color: "cyan", bold: true, children: summary }) }) : null,
    buildStableLineEntries(report).map(({ id, line }) => /* @__PURE__ */ jsx(ReportLine, { line }, id))
  ] });
}
function ReportLine({ line }) {
  if (line.startsWith("# ")) {
    return /* @__PURE__ */ jsx(Text, { bold: true, color: "white", children: line.slice(2) });
  }
  if (line.startsWith("## ")) {
    return /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { bold: true, color: "yellow", children: line.slice(3) }) });
  }
  if (/^\|[-| ]+\|$/.test(line)) {
    return null;
  }
  if (line.startsWith("|")) {
    const cells = buildStableCellEntries(line.split("|").filter((c) => c.trim() !== ""));
    return /* @__PURE__ */ jsx(Box, { children: cells.map(({ id, cell }, index) => /* @__PURE__ */ jsxs(Text, { color: "white", children: [
      index > 0 ? "  " : "",
      cell
    ] }, id)) });
  }
  if (line.startsWith("> ")) {
    return /* @__PURE__ */ jsx(Text, { color: "cyan", children: line.slice(2) });
  }
  if (line.startsWith("- **")) {
    return /* @__PURE__ */ jsx(Text, { color: "green", children: line });
  }
  if (line.includes("Warning") || line.includes("Caution") || line.includes("Unprofitable")) {
    return /* @__PURE__ */ jsx(Text, { color: "red", children: line });
  }
  if (line.startsWith("```")) {
    return null;
  }
  if (line.trim() === "") {
    return /* @__PURE__ */ jsx(Text, { children: "" });
  }
  return /* @__PURE__ */ jsx(Text, { color: "white", dimColor: line.startsWith("_"), children: line });
}
function ListBacktests({ listStrategy }) {
  const [status, setStatus] = useState("loading");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const run = async () => {
      const port = parseInt(process.env.ZARAA_PORT ?? "3927", 10);
      try {
        const result = await callTool("trade_backtest_list", {
          ...listStrategy ? { strategy: listStrategy } : {},
          limit: 15
        }, port);
        setResults(result.results ?? []);
        setStatus("done");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
      }
    };
    run();
  }, [listStrategy]);
  if (status === "loading") {
    return /* @__PURE__ */ jsx(Text, { color: "cyan", children: "Loading backtest history..." });
  }
  if (status === "error") {
    return /* @__PURE__ */ jsxs(Text, { color: "red", children: [
      "Error: ",
      error
    ] });
  }
  if (results.length === 0) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: "No backtest results found." }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "Run: zaraa backtest --strategy trend-following --pair BTC --period 30d" })
    ] });
  }
  const fmtDate = (iso) => iso.slice(0, 10);
  const fmtReturn = (pct) => `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsx(Box, { borderStyle: "single", paddingX: 1, marginBottom: 1, children: /* @__PURE__ */ jsxs(Text, { bold: true, children: [
      "Backtest History (",
      results.length,
      " results)"
    ] }) }),
    /* @__PURE__ */ jsx(Box, { marginBottom: 1, children: /* @__PURE__ */ jsxs(Text, { bold: true, color: "yellow", children: [
      "Strategy".padEnd(18),
      " ",
      "Symbol".padEnd(12),
      " ",
      "Period".padEnd(22),
      " ",
      "Return".padEnd(10),
      " ",
      "WinRate".padEnd(9),
      " ",
      "Sharpe".padEnd(8),
      " ",
      "Trades".padEnd(8),
      " ",
      "MaxDD"
    ] }) }),
    results.map((r) => {
      const returnPct = r.returnPct;
      const retColor = returnPct >= 5 ? "green" : returnPct >= 0 ? "cyan" : "red";
      const period = `${fmtDate(r.period.start)} \u2192 ${fmtDate(r.period.end)}`;
      return /* @__PURE__ */ jsxs(Box, { children: [
        /* @__PURE__ */ jsxs(Text, { color: "white", children: [
          r.strategy.padEnd(18),
          r.symbol.padEnd(12),
          period.padEnd(22)
        ] }),
        /* @__PURE__ */ jsx(Text, { color: retColor, children: fmtReturn(returnPct).padEnd(10) }),
        /* @__PURE__ */ jsxs(Text, { color: "white", children: [
          `${r.winRate.toFixed(1)}%`.padEnd(9),
          `${r.sharpeRatio}`.padEnd(8),
          `${r.totalTrades}`.padEnd(8),
          `${r.maxDrawdownPct.toFixed(1)}%`
        ] })
      ] }, r.id);
    }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", dimColor: true, children: "To run a new backtest: zaraa backtest --strategy <name> --pair <BTC> --period 30d" }) })
  ] });
}
function Backtest({ strategy, pair, period, equity, list, listStrategy }) {
  if (list) {
    return /* @__PURE__ */ jsx(ListBacktests, { listStrategy });
  }
  if (!strategy) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "red", children: "Error: --strategy is required." }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "" }),
      /* @__PURE__ */ jsx(Text, { color: "white", children: "Usage:" }),
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: "  zaraa backtest --strategy trend-following --pair BTC --period 30d" }),
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: "  zaraa backtest --strategy mean-reversion --pair ETH/USDT --period 90d --equity 5000" }),
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: "  zaraa backtest --list" }),
      /* @__PURE__ */ jsx(Text, { color: "cyan", children: "  zaraa backtest --list --strategy breakout" }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "" }),
      /* @__PURE__ */ jsx(Text, { color: "white", children: "Available strategies: trend-following, mean-reversion, breakout" })
    ] });
  }
  return /* @__PURE__ */ jsx(RunBacktest, { strategy, pair, period, equity });
}
export {
  Backtest
};
