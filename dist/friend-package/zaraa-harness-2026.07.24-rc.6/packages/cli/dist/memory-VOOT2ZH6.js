import {
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/memory.tsx
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function Memory({ action, query, port = 3927 }) {
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  useEffect(() => {
    if (!action || !query) {
      setError(
        "Usage: zaraa memory search <query> | zaraa memory forget <query>"
      );
      setLoading(false);
      return;
    }
    const run = async () => {
      try {
        if (action === "search") {
          const result = await requestGatewayJson(
            port,
            `/api/memory/search?q=${encodeURIComponent(query)}`
          );
          if (!result.ok) {
            const snapshot = await collectGatewayAccessSnapshot(port);
            setError(
              buildGatewayEndpointFailureMessage(
                "Memory search failed.",
                "/api/memory/search",
                port,
                snapshot,
                [result]
              )
            );
            return;
          }
          const data = result.data;
          setResults(
            Array.isArray(data) ? data : data?.results || []
          );
        } else if (action === "forget") {
          const result = await requestGatewayJson(
            port,
            "/api/memory/forget",
            {
              method: "POST",
              body: { query }
            }
          );
          if (!result.ok) {
            const snapshot = await collectGatewayAccessSnapshot(port);
            setError(
              buildGatewayEndpointFailureMessage(
                "Memory forget failed.",
                "/api/memory/forget",
                port,
                snapshot,
                [result]
              )
            );
            return;
          }
          setMessage(
            result.data?.message || `Forgotten memories matching "${query}"`
          );
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to access the Zaraa gateway"
        );
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [action, query, port]);
  if (loading) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: action === "search" ? "Searching memories..." : "Forgetting memories..." }) });
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
  if (message) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsx(Text, { color: "green", children: message }) });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, children: "Memory Search" }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        " ",
        '- "',
        query,
        '" (',
        results.length,
        " results)"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginTop: 1, children: results.length === 0 ? /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
      'No memories found matching "',
      query,
      '".'
    ] }) : results.map((result, i) => /* @__PURE__ */ jsxs(
      Box,
      {
        flexDirection: "column",
        marginBottom: 1,
        children: [
          /* @__PURE__ */ jsxs(Box, { children: [
            /* @__PURE__ */ jsxs(Text, { color: "cyan", bold: true, children: [
              "[",
              i + 1,
              "]"
            ] }),
            result.score !== void 0 && /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
              " ",
              "(score: ",
              result.score.toFixed(3),
              ")"
            ] })
          ] }),
          /* @__PURE__ */ jsx(Text, { children: result.content }),
          result.createdAt && /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
            "Created: ",
            result.createdAt
          ] })
        ]
      },
      result.id || i
    )) })
  ] });
}
export {
  Memory
};
