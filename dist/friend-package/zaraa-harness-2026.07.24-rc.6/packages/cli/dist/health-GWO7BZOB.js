import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/health.tsx
import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { z } from "zod";
import { jsx, jsxs } from "react/jsx-runtime";
var HealthSchema = z.object({
  status: z.string().optional(),
  version: z.string().optional(),
  uptime: z.number().optional()
}).passthrough();
var ExtendedHealthSchema = z.object({
  memory: z.object({
    rss: z.number().optional(),
    heapUsed: z.number().optional(),
    heapTotal: z.number().optional()
  }).passthrough().optional()
}).passthrough();
var CircuitBreakerSchema = z.object({
  tripped: z.boolean(),
  reason: z.string().nullable().optional()
}).passthrough();
function fmtUptime(seconds) {
  if (seconds === void 0 || !Number.isFinite(seconds)) return "\u2014";
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor(s % 86400 / 3600);
  const minutes = Math.floor(s % 3600 / 60);
  const secs = s % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}
function fmtMb(bytes) {
  if (bytes === void 0 || !Number.isFinite(bytes)) return "\u2014";
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function Health({ port }) {
  const { exit } = useApp();
  const [state, setState] = useState({ loading: true, snapshot: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [healthRes, extendedRes, breakerRes] = await Promise.all([
        requestGatewayJson(port, "/api/health"),
        requestGatewayJson(port, "/api/health/extended"),
        requestGatewayJson(port, "/api/circuit-breaker")
      ]);
      if (cancelled) return;
      if (!healthRes.ok || healthRes.data === null) {
        setState({
          loading: false,
          snapshot: null,
          error: healthRes.error ?? `HTTP ${healthRes.status}`
        });
        return;
      }
      const healthParsed = HealthSchema.safeParse(healthRes.data);
      if (!healthParsed.success) {
        setState({
          loading: false,
          snapshot: null,
          error: `Schema validation failed: ${healthParsed.error.issues[0]?.message ?? "unknown"}`
        });
        return;
      }
      let memory;
      if (extendedRes.ok && extendedRes.data !== null) {
        const parsed = ExtendedHealthSchema.safeParse(extendedRes.data);
        if (parsed.success) memory = parsed.data.memory;
      }
      let breaker2 = null;
      let breakerError = null;
      if (breakerRes.ok && breakerRes.data !== null) {
        const parsed = CircuitBreakerSchema.safeParse(breakerRes.data);
        if (parsed.success) breaker2 = parsed.data;
        else breakerError = `Schema validation failed: ${parsed.error.issues[0]?.message ?? "unknown"}`;
      } else {
        breakerError = breakerRes.error ?? `HTTP ${breakerRes.status}`;
      }
      setState({
        loading: false,
        snapshot: {
          status: healthParsed.data.status,
          version: healthParsed.data.version,
          uptime: healthParsed.data.uptime,
          memory,
          breaker: breaker2,
          breakerError
        },
        error: null
      });
    })().catch((err) => {
      if (cancelled) return;
      setState({
        loading: false,
        snapshot: null,
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
      "Fetching health from http://localhost:",
      port,
      "/api/health\u2026"
    ] }) });
  }
  if (state.error) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Text, { color: "red", bold: true, children: "Health request failed" }),
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: state.error }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", dimColor: true, children: [
        "Is the gateway running on port ",
        port,
        "? Check with `lsof -i :",
        port,
        "`."
      ] })
    ] });
  }
  const snap = state.snapshot;
  const statusColor = snap.status === "ok" ? "green" : snap.status ? "yellow" : "red";
  const breaker = snap.breaker;
  const breakerColor = !breaker ? "gray" : breaker.tripped ? "red" : "green";
  const breakerLabel = !breaker ? snap.breakerError ?? "unavailable" : breaker.tripped ? `TRIPPED${breaker.reason ? ` \u2014 ${breaker.reason}` : ""}` : "armed";
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, color: "white", children: "Zaraa Health" }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        "  port: ",
        port,
        snap.version ? `  |  v${snap.version}` : ""
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs(Text, { children: [
        "Status:    ",
        /* @__PURE__ */ jsx(Text, { color: statusColor, bold: true, children: snap.status ?? "unknown" })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Uptime:    ",
        /* @__PURE__ */ jsx(Text, { color: "white", children: fmtUptime(snap.uptime) })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Memory:    ",
        snap.memory ? /* @__PURE__ */ jsx(Text, { color: "white", children: `heap ${fmtMb(snap.memory.heapUsed)} / ${fmtMb(snap.memory.heapTotal)}  rss ${fmtMb(snap.memory.rss)}` }) : /* @__PURE__ */ jsx(Text, { color: "gray", children: "\u2014 (extended health unavailable)" })
      ] }),
      /* @__PURE__ */ jsxs(Text, { children: [
        "Breakers:  ",
        /* @__PURE__ */ jsx(Text, { color: breakerColor, bold: breaker?.tripped === true, children: breakerLabel })
      ] })
    ] })
  ] });
}
export {
  Health
};
