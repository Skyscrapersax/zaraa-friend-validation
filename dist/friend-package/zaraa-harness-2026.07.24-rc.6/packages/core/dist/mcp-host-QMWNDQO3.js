import {
  MCP_PROTOCOL_VERSION,
  isJsonRpcResponse
} from "./chunk-KP2HBNBG.js";
import {
  createLogger
} from "./chunk-RSXICYJP.js";
import "./chunk-R5U7XKVJ.js";

// src/mcp/transports/stdio-transport.ts
import { spawn } from "child_process";
var StdioTransport = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  child = null;
  buffer = "";
  messageHandler = null;
  closeHandler = null;
  closed = false;
  async start() {
    const { command, args = [], env, serverName } = this.opts;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) console.debug(`[mcp:${serverName}:stderr] ${text}`);
    });
    child.on("error", (err) => {
      this.handleClose(err);
    });
    child.on("exit", (code, signal) => {
      const reason = code === 0 || this.closed ? void 0 : new Error(
        `MCP stdio server "${serverName}" exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
      this.handleClose(reason);
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      child.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }
  onStdout(chunk) {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      newlineIdx = this.buffer.indexOf("\n");
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.debug(`[mcp:${this.opts.serverName}] non-JSON line dropped: ${line.slice(0, 120)}`);
        continue;
      }
      this.messageHandler?.(parsed);
    }
  }
  async send(message) {
    if (!this.child || this.closed) {
      throw new Error(`MCP stdio transport for "${this.opts.serverName}" is not open`);
    }
    const line = `${JSON.stringify(message)}
`;
    await new Promise((resolve, reject) => {
      this.child.stdin.write(line, (err) => err ? reject(err) : resolve());
    });
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onClose(handler) {
    this.closeHandler = handler;
  }
  handleClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(reason);
  }
  async close() {
    const child = this.child;
    this.closed = true;
    if (!child || child.killed || child.exitCode !== null) return;
    const grace = this.opts.killGraceMs ?? 2e3;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        } catch {
        }
        resolve();
      }, grace);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.child = null;
  }
};

// src/mcp/transports/http-transport.ts
var MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
var HttpTransport = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  messageHandler = null;
  closeHandler = null;
  closed = false;
  sessionId = null;
  getController = null;
  async start() {
    this.closed = false;
    void this.openGetStream();
  }
  baseHeaders() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.opts.headers ?? {}
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }
  async openGetStream() {
    try {
      const controller = new AbortController();
      this.getController = controller;
      const res = await fetch(this.opts.url, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.opts.headers ?? {} },
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        if (this.opts.mode === "sse") {
          this.handleClose(new Error(`SSE GET stream failed: HTTP ${res.status}`));
        }
        return;
      }
      void this.consumeSse(res.body);
    } catch (err) {
      if (this.opts.mode === "sse" && !this.closed) {
        this.handleClose(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  async consumeSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
          }
          throw new Error(
            `MCP server "${this.opts.serverName}" exceeded max response size (${MAX_RESPONSE_BYTES} bytes)`
          );
        }
        buffer += decoder.decode(value, { stream: true });
        let sepIdx = buffer.indexOf("\n\n");
        while (sepIdx >= 0) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          this.dispatchSseEvent(rawEvent);
          sepIdx = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.handleClose(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  /** Read a Response body as text with a hard byte cap (bounds memory). */
  async readBodyCapped(res) {
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let total = 0;
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
        }
        throw new Error(
          `MCP server "${this.opts.serverName}" exceeded max response size (${MAX_RESPONSE_BYTES} bytes)`
        );
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  dispatchSseEvent(rawEvent) {
    const dataLines = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;
    try {
      const msg = JSON.parse(payload);
      this.messageHandler?.(msg);
    } catch {
      console.debug(`[mcp:${this.opts.serverName}] non-JSON SSE data dropped`);
    }
  }
  async send(message) {
    if (this.closed) {
      throw new Error(`MCP http transport for "${this.opts.serverName}" is closed`);
    }
    const timeoutMs = this.opts.requestTimeoutMs ?? 3e4;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid && sid.length <= 256) this.sessionId = sid;
    if (res.status === 202) return;
    if (!res.ok) {
      throw new Error(
        `MCP http POST to "${this.opts.serverName}" failed: HTTP ${res.status}`
      );
    }
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream") && res.body) {
      await this.consumeSse(res.body);
      return;
    }
    const text = await this.readBodyCapped(res);
    if (!text.trim()) return;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const m of parsed) this.messageHandler?.(m);
      } else {
        this.messageHandler?.(parsed);
      }
    } catch {
      console.debug(`[mcp:${this.opts.serverName}] non-JSON POST response dropped`);
    }
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onClose(handler) {
    this.closeHandler = handler;
  }
  handleClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(reason);
  }
  async close() {
    this.closed = true;
    try {
      this.getController?.abort();
    } catch {
    }
    this.getController = null;
  }
};

// src/mcp/mcp-client.ts
var log = createLogger({ module: "mcp-client" });
var MCPClient = class {
  constructor(opts) {
    this.opts = opts;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 3e4;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1e3;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 3e4;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 8;
    this.clientName = opts.clientName ?? "zaraa";
    this.clientVersion = opts.clientVersion ?? "1.0.0";
  }
  opts;
  transport = null;
  pending = /* @__PURE__ */ new Map();
  nextId = 1;
  tools = [];
  status = "disconnected";
  lastError;
  reconnectAttempts = 0;
  reconnectTimer = null;
  intentionalClose = false;
  serverInfo;
  requestTimeoutMs;
  reconnectBaseMs;
  reconnectMaxMs;
  maxReconnectAttempts;
  clientName;
  clientVersion;
  get name() {
    return this.opts.config.name;
  }
  get minZone() {
    return this.opts.config.minZone ?? "guarded";
  }
  get requiresApproval() {
    return this.opts.config.requiresApproval ?? true;
  }
  getStatus() {
    return this.status;
  }
  getLastError() {
    return this.lastError;
  }
  getTools() {
    return this.tools;
  }
  /** Connect: build transport, handshake, discover tools. Throws on failure. */
  async connect() {
    this.intentionalClose = false;
    this.status = "connecting";
    this.transport = this.buildTransport();
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose((reason) => this.handleTransportClose(reason));
    await this.transport.start();
    await this.handshake();
    this.tools = await this.listTools();
    this.status = "connected";
    this.reconnectAttempts = 0;
    this.lastError = void 0;
  }
  buildTransport() {
    const cfg = this.opts.config;
    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        throw new Error(`MCP server "${cfg.name}": stdio transport requires "command"`);
      }
      return new StdioTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        serverName: cfg.name
      });
    }
    if (cfg.transport === "http" || cfg.transport === "sse") {
      if (!cfg.url) {
        throw new Error(`MCP server "${cfg.name}": ${cfg.transport} transport requires "url"`);
      }
      return new HttpTransport({
        url: cfg.url,
        headers: cfg.headers,
        serverName: cfg.name,
        mode: cfg.transport
      });
    }
    throw new Error(`MCP server "${cfg.name}": unknown transport "${String(cfg.transport)}"`);
  }
  async handshake() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion }
    });
    this.serverInfo = result?.serverInfo;
    await this.notify("notifications/initialized");
  }
  async listTools() {
    const collected = [];
    let cursor;
    do {
      const params = cursor ? { cursor } : {};
      const res = await this.request("tools/list", params);
      if (Array.isArray(res?.tools)) collected.push(...res.tools);
      cursor = res?.nextCursor;
    } while (cursor);
    return collected;
  }
  /** Invoke a tool on this server. */
  async callTool(toolName, args) {
    if (this.status !== "connected") {
      throw new Error(`MCP server "${this.name}" is not connected (status=${this.status})`);
    }
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args ?? {}
    });
    return result;
  }
  async request(method, params) {
    if (!this.transport) throw new Error(`MCP server "${this.name}": no transport`);
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(req).catch((err) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(err);
      });
    });
  }
  async notify(method, params) {
    if (!this.transport) return;
    await this.transport.send({ jsonrpc: "2.0", method, ...params ? { params } : {} });
  }
  handleMessage(msg) {
    if (isJsonRpcResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      const response = msg;
      if (response.error) {
        entry.reject(
          new Error(`MCP error ${response.error.code}: ${response.error.message}`)
        );
      } else {
        entry.resolve(response.result);
      }
      return;
    }
  }
  handleTransportClose(reason) {
    if (reason) this.lastError = reason.message;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason ?? new Error(`MCP server "${this.name}" connection closed`));
    }
    this.pending.clear();
    if (this.intentionalClose) {
      this.status = "disconnected";
      return;
    }
    this.status = "error";
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.debug(
        `[mcp:${this.name}] giving up reconnect after ${this.reconnectAttempts} attempts`
      );
      return;
    }
    const exp = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempts
    );
    const delay = Math.floor(Math.random() * exp);
    this.reconnectAttempts++;
    log.debug(
      `[mcp:${this.name}] reconnect attempt ${this.reconnectAttempts} in ${delay}ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
  async reconnect() {
    if (this.intentionalClose) return;
    try {
      if (this.transport) {
        await this.transport.close().catch((closeErr) => {
          log.debug(
            `[mcp:${this.name}] close before reconnect: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
          );
        });
        this.transport = null;
      }
      await this.connect();
      log.debug(`[mcp:${this.name}] reconnected (${this.tools.length} tools)`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = "error";
      this.scheduleReconnect();
    }
  }
  /** Intentional disconnect: stop reconnecting and tear down the transport. */
  async close() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP server "${this.name}" closing`));
    }
    this.pending.clear();
    if (this.transport) {
      await this.transport.close().catch((closeErr) => {
        log.debug(
          `[mcp:${this.name}] close on disconnect: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
        );
      });
      this.transport = null;
    }
    this.status = "disconnected";
  }
  getServerInfo() {
    return this.serverInfo;
  }
};

// src/mcp/mcp-host.ts
var log2 = createLogger({ module: "mcp-host" });
var MCPHost = class {
  constructor(config, opts = {}) {
    this.opts = opts;
    this.config = config;
  }
  opts;
  clients = /* @__PURE__ */ new Map();
  config;
  /**
   * Connect all enabled servers. Returns the list of successfully connected
   * server names. A server that fails to connect is logged and skipped — never
   * fatal (matches the daemon's non-fatal plugin startup contract).
   */
  async connectAll() {
    if (this.config.enabled !== true) {
      log2.debug("[mcp-host] disabled (mcp.enabled !== true) \u2014 not connecting");
      return [];
    }
    const servers = (this.config.servers ?? []).filter((s) => s.enabled !== false);
    const results = await Promise.allSettled(
      servers.map((server) => this.connectServer(server))
    );
    const connected = [];
    results.forEach((res, i) => {
      const name = servers[i]?.name ?? `[${i}]`;
      if (res.status === "fulfilled" && res.value) {
        connected.push(name);
      } else if (res.status === "rejected") {
        log2.debug(
          `[mcp-host] server "${name}" failed to connect: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`
        );
      }
    });
    log2.debug(
      `[mcp-host] connected ${connected.length}/${servers.length} server(s): ${connected.join(", ") || "(none)"}`
    );
    return connected;
  }
  async connectServer(server) {
    if (this.clients.has(server.name)) {
      log2.warn(`[mcp-host] duplicate server name "${server.name}" \u2014 keeping the first, skipping the rest`);
      return false;
    }
    const client = new MCPClient({
      config: server,
      requestTimeoutMs: this.opts.requestTimeoutMs
    });
    this.clients.set(server.name, client);
    try {
      await client.connect();
      return true;
    } catch (err) {
      log2.debug(
        `[mcp-host] connect "${server.name}": ${err instanceof Error ? err.message : String(err)}`
      );
      await client.close().catch((closeErr) => {
        log2.debug(
          `[mcp-host] close after failed connect "${server.name}": ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
        );
      });
      this.clients.delete(server.name);
      return false;
    }
  }
  /** Names of servers with a live (connected) client. */
  getConnectedServers() {
    return Array.from(this.clients.values()).filter((c) => c.getStatus() === "connected").map((c) => c.name);
  }
  /** Status rows for every registered server (for the gateway). */
  getServerStatuses() {
    const rows = [];
    for (const server of this.config.servers ?? []) {
      const client = this.clients.get(server.name);
      rows.push({
        name: server.name,
        transport: server.transport,
        status: client?.getStatus() ?? "disconnected",
        toolCount: client?.getTools().length ?? 0,
        minZone: server.minZone ?? "guarded",
        requiresApproval: server.requiresApproval ?? true,
        lastError: client?.getLastError()
      });
    }
    return rows;
  }
  /** Discovered tools for one server (empty if unknown/disconnected). */
  getToolsForServer(serverName) {
    const client = this.clients.get(serverName);
    if (!client) return [];
    return client.getTools().map((tool) => ({
      serverName: client.name,
      tool,
      minZone: client.minZone,
      requiresApproval: client.requiresApproval
    }));
  }
  /** All discovered tools across all connected servers, tagged with gating. */
  getAllTools() {
    const all = [];
    for (const client of this.clients.values()) {
      if (client.getStatus() !== "connected") continue;
      for (const tool of client.getTools()) {
        all.push({
          serverName: client.name,
          tool,
          minZone: client.minZone,
          requiresApproval: client.requiresApproval
        });
      }
    }
    return all;
  }
  /** Route a tool call to the owning client. */
  async callTool(serverName, toolName, args) {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" is not registered`);
    }
    return client.callTool(toolName, args);
  }
  getConfig() {
    return this.config;
  }
  /**
   * Replace the live server set. Tears down every existing client (killing
   * stdio children) and reconnects from the new config.
   */
  async reload(config) {
    await this.shutdown();
    this.config = config;
    this.clients = /* @__PURE__ */ new Map();
    return this.connectAll();
  }
  /** Disconnect every client and kill all stdio children. Idempotent. */
  async shutdown() {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
};
export {
  MCPHost
};
