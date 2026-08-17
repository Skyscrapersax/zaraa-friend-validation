import "./chunk-R5U7XKVJ.js";

// src/mcp/mcp-tool-adapter.ts
function mcpToolName(serverName, toolName) {
  return `mcp_${serverName}_${toolName}`;
}
function flattenMCPResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const textParts = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
  let body;
  if (textParts.length > 0) {
    body = textParts.join("\n");
  } else if (blocks.length > 0) {
    body = JSON.stringify(blocks);
  } else {
    body = JSON.stringify(result ?? {});
  }
  if (result?.isError) {
    return `MCP tool reported an error:
${body}`;
  }
  return body;
}
function buildMCPAdapters(host, tools) {
  const adapters = [];
  const seen = /* @__PURE__ */ new Set();
  for (const resolved of tools) {
    const { serverName, tool } = resolved;
    const name = mcpToolName(serverName, tool.name);
    if (seen.has(name)) {
      console.warn(
        `[mcp-adapter] tool name collision "${name}" (server="${serverName}") \u2014 keeping the first, skipping the duplicate`
      );
      continue;
    }
    seen.add(name);
    const parameters = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
    const definition = {
      name,
      description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
      parameters
    };
    const capturedServer = serverName;
    const capturedTool = tool.name;
    const handler = async (args) => {
      const result = await host.callTool(capturedServer, capturedTool, args ?? {});
      const flattened = flattenMCPResult(result);
      if (result?.isError) {
        throw new Error(flattened);
      }
      return flattened;
    };
    adapters.push({
      definition,
      handler,
      pluginName: `mcp:${serverName}`,
      requiresApproval: resolved.requiresApproval,
      minZone: resolved.minZone,
      isAvailable: () => host.getConnectedServers().includes(capturedServer),
      serverName,
      mcpToolName: tool.name
    });
  }
  return adapters;
}
export {
  buildMCPAdapters,
  flattenMCPResult,
  mcpToolName
};
