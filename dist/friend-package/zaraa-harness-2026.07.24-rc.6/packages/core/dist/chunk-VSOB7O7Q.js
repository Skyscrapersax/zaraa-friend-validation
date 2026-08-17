// src/integrations/grokbot-client.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var DEFAULT_GROKBOT_CONNECTION = join(
  homedir(),
  ".grokbot/local-exec-daemon-connection.json"
);
function loadGrokBotConnection(path = process.env.GROKBOT_CONNECTION || DEFAULT_GROKBOT_CONNECTION) {
  const conn = JSON.parse(readFileSync(path, "utf8"));
  if (!conn.baseUrl || !conn.token) {
    throw new Error("Grok Bot connection file missing baseUrl or token");
  }
  return conn;
}
function asAgentList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const rec = data;
    if (Array.isArray(rec.agents)) return rec.agents;
    if (Array.isArray(rec.items)) return rec.items;
  }
  return [];
}
function resolveGrokBot(agents, nameOrId) {
  const byId = agents.find((a) => a.id === nameOrId);
  if (byId) return byId;
  const q = nameOrId.toLowerCase();
  const hits = agents.filter((a) => String(a.name ?? "").toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`ambiguous Grok Bot name: ${nameOrId}`);
  throw new Error(`unknown Grok Bot: ${nameOrId}`);
}
var GrokBotClient = class _GrokBotClient {
  constructor(conn, fetchFn = globalThis.fetch) {
    this.conn = conn;
    this.fetchFn = fetchFn;
  }
  conn;
  fetchFn;
  static fromFile(path, fetchFn) {
    return new _GrokBotClient(loadGrokBotConnection(path), fetchFn);
  }
  async post(path, body = {}) {
    const url = `${this.conn.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.conn.token}`,
        "content-type": "application/json",
        ...this.conn.headers ?? {}
      },
      body: JSON.stringify(body ?? {})
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async listAgents() {
    return asAgentList(await this.post("/api/listAgents", {}));
  }
  async sendPrompt(nameOrId, prompt) {
    const agent = resolveGrokBot(await this.listAgents(), nameOrId);
    return this.post("/api/sendPrompt", { prompt, agentId: agent.id });
  }
  async tail(nameOrId, limit = 20) {
    const agent = resolveGrokBot(await this.listAgents(), nameOrId);
    return this.post("/api/getAgentTranscriptTail", { id: agent.id, limit });
  }
};

export {
  DEFAULT_GROKBOT_CONNECTION,
  loadGrokBotConnection,
  asAgentList,
  resolveGrokBot,
  GrokBotClient
};
