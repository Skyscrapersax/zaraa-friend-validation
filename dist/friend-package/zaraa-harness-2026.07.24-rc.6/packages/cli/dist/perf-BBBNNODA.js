import {
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/perf.tsx
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function fmtMs(ms) {
  if (ms < 1e3) return `${ms}ms`;
  return `${(ms / 1e3).toFixed(1)}s`;
}
function SectionHeader({ title }) {
  return /* @__PURE__ */ jsx(Box, { marginTop: 1, marginBottom: 0, children: /* @__PURE__ */ jsxs(Text, { bold: true, color: "cyan", children: [
    "\u2500\u2500 ",
    title,
    " ",
    "\u2500".repeat(Math.max(0, 50 - title.length - 4))
  ] }) });
}
function LLMSection({ providers }) {
  if (providers.length === 0) {
    return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "  No LLM calls recorded yet. Run some tasks first." }) });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { color: "gray", bold: true, children: [
      "  ",
      "Provider".padEnd(16),
      "Calls".padStart(7),
      "Avg".padStart(9),
      "p50".padStart(9),
      "p95".padStart(9),
      "p99".padStart(9),
      "Max".padStart(9)
    ] }) }),
    providers.map((p) => /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { children: [
      "  ",
      /* @__PURE__ */ jsx(Text, { color: "white", bold: true, children: p.provider.padEnd(16) }),
      /* @__PURE__ */ jsx(Text, { color: "green", children: String(p.callCount).padStart(7) }),
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: fmtMs(p.avgMs).padStart(9) }),
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: fmtMs(p.p50Ms).padStart(9) }),
      /* @__PURE__ */ jsx(Text, { color: p.p95Ms > 1e4 ? "red" : "yellow", children: fmtMs(p.p95Ms).padStart(9) }),
      /* @__PURE__ */ jsx(Text, { color: p.p99Ms > 3e4 ? "red" : "yellow", children: fmtMs(p.p99Ms).padStart(9) }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: fmtMs(p.maxMs).padStart(9) })
    ] }) }, p.provider))
  ] });
}
function EndpointSection({ endpoints }) {
  if (endpoints.length === 0) {
    return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "  No API requests recorded yet." }) });
  }
  const top = endpoints.slice(0, 15);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { color: "gray", bold: true, children: [
      "  ",
      "Method".padEnd(8),
      "Path".padEnd(32),
      "Calls".padStart(7),
      "p50".padStart(8),
      "p95".padStart(8),
      "p99".padStart(8)
    ] }) }),
    top.map((e) => {
      const slow = e.p95Ms > 500;
      return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { children: [
        "  ",
        /* @__PURE__ */ jsx(Text, { color: "cyan", children: e.method.padEnd(8) }),
        /* @__PURE__ */ jsx(Text, { color: slow ? "yellow" : "white", children: e.path.slice(0, 32).padEnd(32) }),
        /* @__PURE__ */ jsx(Text, { color: "green", children: String(e.callCount).padStart(7) }),
        /* @__PURE__ */ jsx(Text, { color: "gray", children: fmtMs(e.p50Ms).padStart(8) }),
        /* @__PURE__ */ jsx(Text, { color: e.p95Ms > 200 ? "yellow" : "gray", children: fmtMs(e.p95Ms).padStart(8) }),
        /* @__PURE__ */ jsx(Text, { color: e.p99Ms > 1e3 ? "red" : "gray", children: fmtMs(e.p99Ms).padStart(8) })
      ] }) }, `${e.method}-${e.path}`);
    })
  ] });
}
function DbSection({ queries }) {
  if (queries.length === 0) {
    return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "  No slow DB queries recorded (threshold: 5ms). Great!" }) });
  }
  return /* @__PURE__ */ jsx(Box, { flexDirection: "column", children: queries.map((q, _i) => /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginBottom: 0, children: [
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { children: [
      "  ",
      /* @__PURE__ */ jsxs(Text, { color: q.avgMs > 50 ? "red" : "yellow", bold: true, children: [
        fmtMs(q.avgMs),
        " avg"
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        " | ",
        q.callCount,
        "x | max ",
        fmtMs(q.maxMs)
      ] })
    ] }) }),
    /* @__PURE__ */ jsx(Box, { marginLeft: 2, children: /* @__PURE__ */ jsxs(Text, { color: "gray", dimColor: true, children: [
      q.sql.slice(0, 80),
      q.sql.length > 80 ? "\u2026" : ""
    ] }) })
  ] }, `${q.sql}-${q.avgMs}-${q.callCount}`)) });
}
function TaskSection({ queue }) {
  if (!queue) {
    return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "  Task queue data not available." }) });
  }
  const total = queue.pending + queue.running + queue.completed + queue.failed + queue.blocked;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsx(Text, { children: "  " }),
      /* @__PURE__ */ jsxs(Text, { color: "yellow", bold: true, children: [
        queue.pending,
        " pending"
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "  |  " }),
      /* @__PURE__ */ jsxs(Text, { color: "cyan", children: [
        queue.running,
        " running"
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "  |  " }),
      /* @__PURE__ */ jsxs(Text, { color: "green", children: [
        queue.completed,
        " completed"
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "  |  " }),
      /* @__PURE__ */ jsxs(Text, { color: "red", children: [
        queue.failed,
        " failed"
      ] }),
      queue.blocked > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(Text, { color: "gray", children: "  |  " }),
        /* @__PURE__ */ jsxs(Text, { color: "magenta", children: [
          queue.blocked,
          " blocked"
        ] })
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  (total: ",
        total,
        ")"
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  ",
        "Average queue wait time: "
      ] }),
      /* @__PURE__ */ jsx(Text, { color: queue.avgWaitMs > 5e3 ? "red" : queue.avgWaitMs > 1e3 ? "yellow" : "green", children: fmtMs(queue.avgWaitMs) })
    ] }),
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  ",
        "Operator lane: "
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "white", children: [
        queue.byInitiator.operator.pending,
        " pending / ",
        queue.byInitiator.operator.running,
        " running"
      ] }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  |  ",
        "Agent backlog active: "
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "white", children: queue.byInitiator.agent.active + queue.byInitiator.system.active })
    ] })
  ] });
}
function MemorySection({ memory }) {
  if (!memory) {
    return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "  Memory trend data not available yet." }) });
  }
  const current = memory.currentMB;
  const heapPct = memory.currentMB.heapTotal > 0 ? Math.round(current.heapUsed / current.heapTotal * 100) : 0;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsx(Text, { children: "  " }),
      /* @__PURE__ */ jsx(Text, { color: "white", bold: true, children: "RSS: " }),
      /* @__PURE__ */ jsxs(Text, { color: current.rss > 1e3 ? "yellow" : "green", children: [
        current.rss,
        " MB"
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "   Heap: " }),
      /* @__PURE__ */ jsxs(Text, { color: heapPct > 85 ? "red" : heapPct > 70 ? "yellow" : "green", children: [
        current.heapUsed,
        "/",
        current.heapTotal,
        " MB (",
        heapPct,
        "%)"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
      "  ",
      "Trend (",
      memory.sampleCount,
      " samples): min ",
      memory.minRssMB,
      " MB  avg ",
      memory.avgRssMB,
      " MB  max ",
      memory.maxRssMB,
      " MB RSS"
    ] }) })
  ] });
}
function Perf({ port = 3927 }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const fetchReport = async () => {
      const result = await requestGatewayJson(port, "/api/perf", {
        timeoutMs: 5e3
      });
      if (!result.ok) {
        const snapshot = await collectGatewayAccessSnapshot(port);
        setError(
          buildGatewayEndpointFailureMessage(
            "Perf report is unavailable.",
            "/api/perf",
            port,
            snapshot,
            [result]
          )
        );
        setLoading(false);
        return;
      }
      setReport(result.data);
      setLoading(false);
    };
    void fetchReport();
  }, [port]);
  if (loading) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
      "Fetching performance report from http://localhost:",
      port,
      "/api/perf ..."
    ] }) });
  }
  if (error) {
    return /* @__PURE__ */ jsxs(Box, { padding: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { color: "red", bold: true, children: "Error fetching perf report:" }),
      /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsx(Text, { color: "yellow", children: error }) })
    ] });
  }
  if (!report) return null;
  const uptimeH = Math.floor(report.uptimeSeconds / 3600);
  const uptimeM = Math.floor(report.uptimeSeconds % 3600 / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeM}m` : `${uptimeM}m`;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, color: "white", children: "Zaraa Performance Report" }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  uptime: ",
        uptimeStr,
        "  |  generated: ",
        new Date(report.generatedAt).toLocaleTimeString()
      ] })
    ] }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "LLM Response Times" }),
    /* @__PURE__ */ jsx(LLMSection, { providers: report.llm }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "API Endpoint Latencies (top 15 by p95)" }),
    /* @__PURE__ */ jsx(EndpointSection, { endpoints: report.endpoints }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Slow DB Queries (top 10, threshold: 5ms)" }),
    /* @__PURE__ */ jsx(DbSection, { queries: report.slowDbQueries }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Task Queue" }),
    /* @__PURE__ */ jsx(TaskSection, { queue: report.taskQueue }),
    /* @__PURE__ */ jsx(SectionHeader, { title: "Memory Usage" }),
    /* @__PURE__ */ jsx(MemorySection, { memory: report.memory }),
    /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsxs(Text, { color: "gray", dimColor: true, children: [
      "Web dashboard also shows this at: http://localhost:",
      port,
      "/api/perf"
    ] }) })
  ] });
}
export {
  Perf
};
