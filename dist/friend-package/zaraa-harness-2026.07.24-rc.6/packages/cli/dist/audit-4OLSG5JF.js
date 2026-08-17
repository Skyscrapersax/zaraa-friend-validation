import {
  buildGatewayEndpointFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/audit.tsx
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function Audit({ port = 3927 }) {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const fetchAudit = async () => {
      const result = await requestGatewayJson(
        port,
        "/api/audit"
      );
      if (!result.ok) {
        const snapshot = await collectGatewayAccessSnapshot(port);
        setError(
          buildGatewayEndpointFailureMessage(
            "Audit trail is unavailable.",
            "/api/audit",
            port,
            snapshot,
            [result]
          )
        );
        setLoading(false);
        return;
      }
      const data = result.data;
      setEntries(
        Array.isArray(data) ? data : data?.entries || []
      );
      setLoading(false);
    };
    void fetchAudit();
  }, [port]);
  if (loading) {
    return /* @__PURE__ */ jsx(Box, { padding: 1, children: /* @__PURE__ */ jsx(Text, { color: "gray", children: "Loading audit trail..." }) });
  }
  if (error) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ jsx(Box, { borderStyle: "single", paddingX: 1, children: /* @__PURE__ */ jsx(Text, { bold: true, children: "Audit Trail" }) }),
      /* @__PURE__ */ jsx(Box, { marginTop: 1, children: /* @__PURE__ */ jsxs(Text, { color: "red", children: [
        "Error: ",
        error
      ] }) }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: "Use `zaraa pulse` for the current operator diagnosis." })
    ] });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { borderStyle: "single", paddingX: 1, children: [
      /* @__PURE__ */ jsx(Text, { bold: true, children: "Audit Trail" }),
      /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
        " (",
        entries.length,
        " entries)"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginTop: 1, children: entries.length === 0 ? /* @__PURE__ */ jsx(Text, { color: "gray", children: "No audit entries found." }) : entries.map((entry) => /* @__PURE__ */ jsxs(
      Box,
      {
        marginBottom: 1,
        children: [
          /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
            "[",
            entry.timestamp,
            "]"
          ] }),
          /* @__PURE__ */ jsx(Text, { children: " " }),
          /* @__PURE__ */ jsx(
            Text,
            {
              color: entry.decision === "allow" ? "green" : "red",
              children: entry.decision.toUpperCase()
            }
          ),
          /* @__PURE__ */ jsx(Text, { children: " " }),
          /* @__PURE__ */ jsx(Text, { bold: true, children: entry.action }),
          /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
            " ",
            "(zone: ",
            entry.zone,
            ")"
          ] }),
          entry.reason && /* @__PURE__ */ jsxs(Text, { color: "gray", children: [
            " - ",
            entry.reason
          ] })
        ]
      },
      `${entry.timestamp}-${entry.action}-${entry.zone}-${entry.decision}`
    )) })
  ] });
}
export {
  Audit
};
