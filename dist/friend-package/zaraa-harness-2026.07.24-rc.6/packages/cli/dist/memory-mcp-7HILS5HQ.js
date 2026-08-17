import {
  loadGatewayApiKey
} from "./chunk-5Q7ELQ3Z.js";
import "./chunk-DI2OPTT7.js";

// src/commands/memory-mcp.ts
var PROTOCOL_VERSION = "2024-11-05";
var tools = [
  {
    name: "zaraa_memory_search",
    description: "Search Zaraa memories across semantic, episodic, and procedural tiers.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        tier: {
          type: "string",
          enum: ["semantic", "episodic", "procedural"],
          description: "Optional tier filter"
        },
        limit: { type: "number", description: "Maximum results" }
      },
      required: ["query"]
    }
  },
  {
    name: "zaraa_memory_store",
    description: "Store an explicit durable memory in Zaraa.",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["semantic", "episodic", "procedural"] },
        content: { type: "string" },
        metadata: { type: "object" },
        source_agent: { type: "string" },
        session_id: { type: "string" },
        trigger: { type: "string" },
        steps: { type: "array", items: { type: "string" } }
      },
      required: ["tier", "content"]
    }
  }
];
function createMemoryMcpHandler(options = {}) {
  const gatewayUrl = normalizeGatewayUrl(
    options.gatewayUrl ?? process.env.ZARAA_GATEWAY_URL ?? "http://localhost:3927"
  );
  const apiKey = options.apiKey ?? loadGatewayApiKey() ?? "";
  const sourceAgent = options.sourceAgent ?? process.env.ZARAA_MEMORY_AGENT_ID ?? "zaraa-mcp";
  const sessionId = options.sessionId ?? process.env.ZARAA_MEMORY_SESSION_ID;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime");
  }
  const gatewayHeaders = () => ({
    ...apiKey ? { "X-Api-Key": apiKey } : {}
  });
  const readJson = async (url, init) => {
    const response2 = await fetchImpl(url, init);
    const text = await response2.text();
    let parsed = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response2.ok) {
      const message = typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string" ? parsed.error : `Gateway request failed (${response2.status})`;
      throw new Error(message);
    }
    return parsed;
  };
  const callSearch = async (rawArgs) => {
    const args = asRecord(rawArgs);
    if (typeof args.query !== "string" || args.query.trim().length === 0) {
      throw new Error("query is required");
    }
    const url = new URL("/api/memory/search", gatewayUrl);
    url.searchParams.set("query", args.query);
    if (typeof args.tier === "string") url.searchParams.set("tier", args.tier);
    if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
      url.searchParams.set("limit", String(Math.max(1, Math.min(Math.floor(args.limit), 500))));
    }
    return readJson(url.toString(), { headers: gatewayHeaders() });
  };
  const callStore = async (rawArgs) => {
    const args = asRecord(rawArgs);
    const metadata = args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata) ? { ...args.metadata, source: "mcp" } : { source: "mcp" };
    const body = {
      ...args,
      metadata,
      source_agent: typeof args.source_agent === "string" ? args.source_agent : sourceAgent,
      ...typeof args.session_id === "string" ? { session_id: args.session_id } : sessionId ? { session_id: sessionId } : {}
    };
    return readJson(new URL("/api/memory/store", gatewayUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...gatewayHeaders()
      },
      body: JSON.stringify(body)
    });
  };
  const handleToolCall = async (params) => {
    const request = asRecord(params);
    const name = request.name;
    const args = request.arguments ?? {};
    try {
      if (name === "zaraa_memory_search") {
        return toolTextResult(await callSearch(args));
      }
      if (name === "zaraa_memory_store") {
        return toolTextResult(await callStore(args));
      }
      return toolErrorResult(`Unknown tool: ${String(name)}`);
    } catch (err) {
      return toolErrorResult(err instanceof Error ? err.message : "Tool call failed");
    }
  };
  const handleMessage = async (message) => {
    const id = message.id ?? null;
    if (message.method?.startsWith("notifications/")) return null;
    if (message.method === "initialize") {
      return response(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "zaraa-memory", version: "0.1.0" }
      });
    }
    if (message.method === "tools/list") {
      return response(id, { tools });
    }
    if (message.method === "tools/call") {
      return response(id, await handleToolCall(message.params));
    }
    if (message.method === "ping") {
      return response(id, {});
    }
    return errorResponse(id, -32601, `Method not found: ${String(message.method)}`);
  };
  return {
    handleMessage,
    async handleLine(line) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return errorResponse(null, -32700, "Parse error");
      }
      return handleMessage(parsed);
    }
  };
}
async function runMemoryMcpServer(options = {}) {
  const handler = createMemoryMcpHandler(options);
  let buffer = "";
  const writeResponse = (message) => {
    if (!message) return;
    process.stdout.write(`${JSON.stringify(message)}
`);
  };
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let parsed = readNextMessage(buffer);
    while (parsed !== null) {
      buffer = buffer.slice(parsed.length);
      const payload = stripFrame(parsed);
      if (payload.trim()) {
        try {
          writeResponse(await handler.handleMessage(JSON.parse(payload)));
        } catch (err) {
          writeResponse(errorResponse(null, -32603, err instanceof Error ? err.message : "Internal error"));
        }
      }
      parsed = readNextMessage(buffer);
    }
  }
}
function normalizeGatewayUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toolTextResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}
function toolErrorResult(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}
function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function readNextMessage(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd >= 0) {
    const header = buffer.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) return null;
    const contentLength = Number.parseInt(match[1], 10);
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) return null;
    return buffer.slice(0, messageEnd);
  }
  const newline = buffer.indexOf("\n");
  if (newline < 0) return null;
  return buffer.slice(0, newline + 1);
}
function stripFrame(message) {
  const headerEnd = message.indexOf("\r\n\r\n");
  if (headerEnd >= 0) return message.slice(headerEnd + 4);
  return message.trim();
}
export {
  createMemoryMcpHandler,
  runMemoryMcpServer
};
