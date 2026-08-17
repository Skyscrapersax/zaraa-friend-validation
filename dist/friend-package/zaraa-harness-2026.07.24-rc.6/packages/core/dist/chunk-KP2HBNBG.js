// src/mcp/mcp-types.ts
function isJsonRpcResponse(msg) {
  return typeof msg === "object" && msg !== null && msg.jsonrpc === "2.0" && "id" in msg && ("result" in msg || "error" in msg);
}
function isJsonRpcRequest(msg) {
  return typeof msg === "object" && msg !== null && msg.jsonrpc === "2.0" && typeof msg.method === "string" && "id" in msg;
}
var MCP_PROTOCOL_VERSION = "2024-11-05";

export {
  isJsonRpcResponse,
  isJsonRpcRequest,
  MCP_PROTOCOL_VERSION
};
