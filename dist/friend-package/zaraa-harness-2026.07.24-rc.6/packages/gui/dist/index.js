// src/types.ts
import { z } from "zod";
var BboxSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive()
});
var ScreenshotSchema = z.object({
  pngBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.number().int().nonnegative()
});
var ClickAction = z.object({
  type: z.literal("click"),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  button: z.enum(["left", "right", "middle"]),
  clicks: z.union([z.literal(1), z.literal(2)])
});
var TypeAction = z.object({
  type: z.literal("type"),
  text: z.string(),
  redact: z.boolean().optional()
});
var KeyAction = z.object({
  type: z.literal("key"),
  keys: z.array(z.string().min(1)).min(1)
});
var ScrollAction = z.object({
  type: z.literal("scroll"),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  dx: z.number().int(),
  dy: z.number().int()
});
var DragAction = z.object({
  type: z.literal("drag"),
  fromX: z.number().int().nonnegative(),
  fromY: z.number().int().nonnegative(),
  toX: z.number().int().nonnegative(),
  toY: z.number().int().nonnegative(),
  button: z.enum(["left", "right", "middle"]).default("left")
});
var WaitAction = z.object({
  type: z.literal("wait"),
  ms: z.number().int().nonnegative().max(6e4)
});
var ScreenshotAction = z.object({
  type: z.literal("screenshot"),
  region: BboxSchema.optional()
});
var ActionSchema = z.discriminatedUnion("type", [
  ClickAction,
  TypeAction,
  KeyAction,
  ScrollAction,
  DragAction,
  WaitAction,
  ScreenshotAction
]);

// src/protocol.ts
function encodeCommand(cmd) {
  return JSON.stringify(cmd) + "\n";
}
function decodeResponse(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  if (typeof parsed.id !== "string") return null;
  if (parsed.ok === true) {
    const { id, ok, ...data } = parsed;
    return { kind: "response", id, ok: true, data };
  }
  if (parsed.ok === false) {
    return { kind: "response", id: parsed.id, ok: false, error: String(parsed.error ?? "unknown") };
  }
  return null;
}
function decodeEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed?.event && typeof parsed.event === "string" && typeof parsed.name === "string") {
    return { event: parsed.event, name: parsed.name };
  }
  return null;
}

// src/capture/screencapture.ts
import { spawn } from "child_process";
import { randomUUID } from "crypto";
var HelperClient = class {
  constructor(binPath) {
    this.binPath = binPath;
  }
  binPath;
  proc = null;
  pending = /* @__PURE__ */ new Map();
  buf = "";
  starting = null;
  hotkeyListeners = [];
  onHotkey(listener) {
    this.hotkeyListeners.push(listener);
    return () => {
      const i = this.hotkeyListeners.indexOf(listener);
      if (i >= 0) this.hotkeyListeners.splice(i, 1);
    };
  }
  async start() {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      this.proc = spawn(this.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
      this.proc.on("exit", () => this.onExit());
      resolve();
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async stop() {
    if (!this.proc) return;
    for (const p of this.pending.values()) {
      p.reject(new Error("HelperClient stopped"));
    }
    this.pending.clear();
    try {
      this.proc.stdin.end();
    } catch {
    }
    this.proc.kill("SIGTERM");
    this.proc = null;
  }
  async capture(region) {
    const data = await this.send({ id: randomUUID(), cmd: "capture", region });
    return {
      pngBase64: String(data.png_b64),
      width: Number(data.width),
      height: Number(data.height),
      capturedAt: Date.now()
    };
  }
  async click(args) {
    await this.send({ id: randomUUID(), cmd: "click", ...args });
  }
  async key(keys) {
    await this.send({ id: randomUUID(), cmd: "key", keys });
  }
  async type(text) {
    await this.send({ id: randomUUID(), cmd: "type", text });
  }
  async drag(args) {
    await this.send({
      id: randomUUID(),
      cmd: "drag",
      fromX: args.fromX,
      fromY: args.fromY,
      toX: args.toX,
      toY: args.toY,
      button: args.button ?? "left"
    });
  }
  async scroll(args) {
    await this.send({ id: randomUUID(), cmd: "scroll", ...args });
  }
  async frontmostApp() {
    const data = await this.send({ id: randomUUID(), cmd: "frontmost_app" });
    return typeof data.bundle_id === "string" ? data.bundle_id : void 0;
  }
  send(cmd) {
    if (!this.proc) {
      return Promise.reject(new Error("HelperClient not started"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(cmd.id, { resolve, reject });
      try {
        this.proc.stdin.write(encodeCommand(cmd));
      } catch (e) {
        this.pending.delete(cmd.id);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (this.proc.exitCode !== null) {
        this.pending.delete(cmd.id);
        reject(new Error(`helper exited with code ${this.proc.exitCode}`));
      }
    });
  }
  onStdout(chunk) {
    this.buf += chunk;
    while (true) {
      const idx = this.buf.indexOf("\n");
      if (idx < 0) {
        break;
      }
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const ev = decodeEvent(line);
      if (ev) {
        if (ev.event === "hotkey") {
          for (const l of this.hotkeyListeners) {
            try {
              l(ev.name);
            } catch {
            }
          }
        }
        continue;
      }
      const res = decodeResponse(line);
      if (!res) continue;
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.data);
      else p.reject(new Error(res.error));
    }
  }
  onExit() {
    for (const p of this.pending.values()) p.reject(new Error("helper exited"));
    this.pending.clear();
    this.proc = null;
  }
};

// src/vlm/prompt.ts
var SUPPORTED_ACTIONS = [
  `{"type":"click","x":<int>,"y":<int>,"button":"left"|"right"|"middle","clicks":1|2}`,
  `{"type":"type","text":"<string>"}`,
  `{"type":"key","keys":["<keyname>", ...]}  // e.g. ["cmd","space"]`,
  `{"type":"scroll","x":<int>,"y":<int>,"dx":<int>,"dy":<int>}`,
  `{"type":"drag","fromX":<int>,"fromY":<int>,"toX":<int>,"toY":<int>,"button":"left"|"right"}`,
  `{"type":"wait","ms":<int 0..60000>}`,
  `{"type":"screenshot"}  // re-capture if you need to look again`
];
var SYSTEM = `You are a GUI agent operating a macOS desktop. Look at the screenshot and decide
the next 1 to 3 actions that will move toward the user's goal.

OUTPUT FORMAT \u2014 emit JSON only, no prose, no markdown fences:

[
  { "thought": "<short reasoning>", "action": { ... one of the supported actions ... } },
  { "thought": "...", "action": { ... } }
]

Supported actions (use these exact shapes):
${SUPPORTED_ACTIONS.map((s) => "  - " + s).join("\n")}

Coordinates are in screen pixels (origin top-left). Stick to integer values.

If you believe the goal is already complete, return an empty array: [].

Do not invent action types beyond the seven listed above.`;
function renderHistory(history) {
  if (history.length === 0) return "";
  const lines = history.slice(-5).map((h, i) => {
    return `  ${i + 1}. ${h.outcome.toUpperCase()}: ${JSON.stringify(h.action)}`;
  });
  return `Recent actions:
${lines.join("\n")}

`;
}
function buildPlanPrompt(input) {
  const userParts = [
    `Screen: ${input.width} x ${input.height} pixels.
`,
    renderHistory(input.history),
    `Goal: ${input.goal}
`,
    `Decide the next 1-3 actions. Emit JSON only.`
  ];
  return { system: SYSTEM, user: userParts.join("") };
}

// src/vlm/parser.ts
var FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
function stripFences(raw) {
  const trimmed = raw.trim();
  const m = trimmed.match(FENCE_RE);
  return m ? m[1].trim() : trimmed;
}
function extractJsonBlock(raw) {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
  }
  const startArr = raw.indexOf("[");
  const startObj = raw.indexOf("{");
  let start;
  let openCh;
  let closeCh;
  if (startArr === -1 && startObj === -1) throw new Error("parseVlmActions: no JSON found in response");
  if (startArr === -1) {
    start = startObj;
    openCh = "{";
    closeCh = "}";
  } else if (startObj === -1) {
    start = startArr;
    openCh = "[";
    closeCh = "]";
  } else if (startArr < startObj) {
    start = startArr;
    openCh = "[";
    closeCh = "]";
  } else {
    start = startObj;
    openCh = "{";
    closeCh = "}";
  }
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === openCh) depth++;
    else if (raw[i] === closeCh) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error("parseVlmActions: unbalanced JSON in response");
}
function coerceToList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  throw new Error("parseVlmActions: top-level value is not array or object");
}
function parseVlmActions(raw) {
  const stripped = stripFences(raw);
  let block;
  try {
    block = extractJsonBlock(stripped);
  } catch (e) {
    throw new Error(`parseVlmActions: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`parseVlmActions: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const items = coerceToList(parsed);
  const plans = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const obj = it;
    const candidateAction = obj.action ?? (typeof obj.type === "string" ? obj : null);
    if (!candidateAction) continue;
    const result = ActionSchema.safeParse(candidateAction);
    if (!result.success) continue;
    const plan = { action: result.data };
    if (typeof obj.thought === "string" && obj.action) plan.thought = obj.thought;
    plans.push(plan);
  }
  return plans;
}

// src/vlm/ollama.ts
var OllamaProvider = class {
  name;
  isLocal = true;
  model;
  host;
  keepAlive;
  fetchFn;
  constructor(cfg) {
    this.model = cfg.model;
    this.host = cfg.host.replace(/\/+$/, "");
    this.keepAlive = cfg.keepAlive ?? "30m";
    this.fetchFn = cfg.fetch ?? globalThis.fetch;
    this.name = `ollama:${cfg.model}`;
  }
  async plan(input, history) {
    const prompt = buildPlanPrompt({
      goal: input.goal,
      width: input.width,
      height: input.height,
      history
    });
    const body = {
      model: this.model,
      stream: false,
      keep_alive: this.keepAlive,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user, images: [input.screenshotBase64] }
      ]
    };
    const res = await this.fetchFn(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    const content = json.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama response missing message.content");
    }
    return parseVlmActions(content);
  }
};

// src/vlm/anthropic.ts
var AnthropicProvider = class {
  name;
  isLocal = false;
  model;
  apiKey;
  baseUrl;
  maxTokens;
  fetchFn;
  constructor(cfg) {
    this.model = cfg.model;
    const key = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("AnthropicProvider: no API key (set ANTHROPIC_API_KEY or pass apiKey)");
    this.apiKey = key;
    this.baseUrl = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.maxTokens = cfg.maxTokens ?? 1024;
    this.fetchFn = cfg.fetch ?? globalThis.fetch;
    this.name = `anthropic:${cfg.model}`;
  }
  async plan(input, history) {
    const prompt = buildPlanPrompt({
      goal: input.goal,
      width: input.width,
      height: input.height,
      history
    });
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: input.screenshotBase64 }
            },
            { type: "text", text: prompt.user }
          ]
        }
      ]
    };
    const res = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${text2 || res.statusText}`);
    }
    const json = await res.json();
    const text = json.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error("Anthropic response missing text content block");
    }
    return parseVlmActions(text);
  }
};

// src/vlm/openai.ts
var OpenAIProvider = class {
  name;
  isLocal = false;
  model;
  apiKey;
  baseUrl;
  fetchFn;
  constructor(cfg) {
    this.model = cfg.model;
    const key = cfg.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OpenAIProvider: no API key (set OPENAI_API_KEY or pass apiKey)");
    this.apiKey = key;
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    this.fetchFn = cfg.fetch ?? globalThis.fetch;
    this.name = `openai:${cfg.model}`;
  }
  async plan(input, history) {
    const prompt = buildPlanPrompt({
      goal: input.goal,
      width: input.width,
      height: input.height,
      history
    });
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: prompt.system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt.user },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${input.screenshotBase64}` }
            }
          ]
        }
      ]
    };
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI response missing choices[0].message.content");
    }
    return parseVlmActions(content);
  }
};

// src/vlm/chatgpt-subscription.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID as nodeRandomUUID } from "crypto";
var DEFAULT_AUTH_PATHS = [
  join(homedir(), ".codex", "auth.json"),
  join(homedir(), ".zaraa", "openai-auth.json")
];
var DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
function loadChatGptAuth(opts = {}) {
  const paths = opts.paths ?? DEFAULT_AUTH_PATHS;
  const read = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  const tried = [];
  for (const p of paths) {
    let raw;
    try {
      raw = read(p);
    } catch {
      tried.push(`${p} (not found)`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      tried.push(`${p} (invalid JSON)`);
      continue;
    }
    let found;
    for (const src of [json.tokens, json]) {
      const accessToken = src?.access_token;
      const accountId = src?.account_id;
      if (typeof accessToken === "string" && typeof accountId === "string") {
        found = { accessToken, accountId };
        break;
      }
    }
    if (found) return found;
    tried.push(`${p} (missing tokens.access_token/account_id)`);
  }
  throw new Error(
    "ChatGPT subscription auth not found. Sign in with your ChatGPT account via `codex login` (or `zaraa openai-login`) so the OAuth token exists. Tried: " + tried.join("; ")
  );
}
function parseResponsesSse(body) {
  let streamed = "";
  let completed = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(d);
    } catch {
      continue;
    }
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      streamed += ev.delta;
    }
    if (ev.type === "response.completed" && Array.isArray(ev.response?.output)) {
      for (const item of ev.response.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c.text === "string") completed += c.text;
          }
        }
      }
    }
  }
  return streamed || completed;
}
var ChatGptSubscriptionClient = class {
  name;
  isLocal = false;
  model;
  effort;
  endpoint;
  loadAuthFn;
  fetchFn;
  uuid;
  timeoutMs;
  constructor(cfg = {}) {
    this.model = cfg.model ?? "gpt-5.5";
    this.effort = cfg.reasoningEffort ?? "low";
    this.endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
    this.loadAuthFn = cfg.loadAuth ?? (() => loadChatGptAuth({ paths: cfg.authPaths }));
    this.fetchFn = cfg.fetch ?? globalThis.fetch;
    this.uuid = cfg.randomUUID ?? nodeRandomUUID;
    this.timeoutMs = cfg.timeoutMs ?? 45e3;
    this.name = `chatgpt-subscription:${this.model}`;
  }
  async respond(system, user) {
    const auth = await this.loadAuthFn();
    const body = {
      model: this.model,
      instructions: system,
      input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
      stream: true,
      store: false,
      reasoning: { effort: this.effort }
    };
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "content-type": "application/json",
        "chatgpt-account-id": auth.accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: this.uuid(),
        Accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ChatGPT subscription HTTP ${res.status}: ${text || res.statusText}`);
    }
    return parseResponsesSse(await res.text());
  }
};

// src/vlm/observe.ts
var FENCE_RE2 = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
function stripFences2(raw) {
  const t = raw.trim();
  const m = t.match(FENCE_RE2);
  return m ? m[1].trim() : t;
}
function extractJson(raw) {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
  }
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  if (startObj === -1 && startArr === -1) {
    throw new Error("parseScene: no JSON object found in scene response");
  }
  let start;
  let open;
  let close;
  if (startObj === -1 || startArr !== -1 && startArr < startObj) {
    start = startArr;
    open = "[";
    close = "]";
  } else {
    start = startObj;
    open = "{";
    close = "}";
  }
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === open) depth++;
    else if (raw[i] === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error("parseScene: unbalanced JSON in scene response");
}
function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : void 0;
}
function coerceTargets(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const t of value) {
    if (!t || typeof t !== "object") continue;
    const o = t;
    const x = typeof o.x === "number" ? o.x : Number(o.x);
    const y = typeof o.y === "number" ? o.y : Number(o.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ label: str(o.label) ?? "", x: Math.round(x), y: Math.round(y) });
  }
  return out;
}
function parseScene(raw) {
  const block = extractJson(stripFences2(raw));
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`parseScene: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const targets = coerceTargets(Array.isArray(parsed) ? parsed : obj.targets);
  const notes = str(obj.notes);
  const isCredentialScreen = !!notes && /\b(login|log\s?in|sign\s?in|account|password|payment|authenticat|pin)\b/i.test(notes);
  return {
    objective: isCredentialScreen ? void 0 : str(obj.objective),
    dialogue: isCredentialScreen ? void 0 : str(obj.dialogue),
    notes,
    targets
  };
}
var OBSERVE_SYSTEM = `You are the vision system for a desktop game agent. Look at the screenshot and
report EXACTLY what is visible as JSON \u2014 do not decide actions, just describe.

Output JSON only, no prose, no markdown fences:

{
  "objective": "<the current on-screen objective / quest arrow / instruction text, or empty>",
  "dialogue": "<text of any open dialogue box, or empty; note if 'Click here to continue' is shown>",
  "targets": [
    { "label": "<short name of a clickable thing: NPC, item, menu option, button, ground object>", "x": <int>, "y": <int> }
  ],
  "notes": "<brief state: is an inventory/menu open? low health? loading? logged out?>"
}

Coordinates are the pixel CENTER of each target, in THIS image's pixel space
(origin top-left).

Accuracy rules:
- Transcribe on-screen text VERBATIM (objective box, quest text, dialogue). Do
  not paraphrase or invent text that is not actually visible.
- Only list targets you can actually SEE and locate. Never guess elements that
  might be there. An empty targets array is correct if nothing is clickable.
- Prefer the elements most relevant to the goal (highlighted target, NPC, ground
  item, menu option, or a "Click here to continue" dialogue prompt).
- If a login / account / payment / authenticator screen is visible, set notes to
  "login screen" and return an empty targets array (do not transcribe credentials).`;
function buildObservePrompt(goal, width, height) {
  const user = [
    `Image is ${width} x ${height} pixels.`,
    `The player's overall goal: ${goal}`,
    `Describe the current screen as JSON using the schema. JSON only.`
  ].join("\n");
  return { system: OBSERVE_SYSTEM, user };
}
function createOllamaGrounder(cfg) {
  const host = cfg.host.replace(/\/+$/, "");
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const numPredict = cfg.numPredict ?? 512;
  const keepAlive = cfg.keepAlive ?? "30m";
  return async (input) => {
    const prompt = buildObservePrompt(input.goal, input.width, input.height);
    const body = {
      model: cfg.model,
      stream: false,
      // Perception, not chain-of-thought: suppress thinking and bound output so
      // the scene comes back fast even on a small local model.
      think: false,
      // Keep the model resident across frames so each grounding stays warm.
      keep_alive: keepAlive,
      options: { num_predict: numPredict },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user, images: [input.screenshotBase64] }
      ]
    };
    const res = await fetchFn(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama grounder HTTP ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    const content = json.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama grounder response missing message.content");
    }
    return parseScene(content);
  };
}

// src/agent/downscale.ts
import { PNG } from "pngjs";
function downscalePngNearest(pngBase64, targetWidth) {
  const src = PNG.sync.read(Buffer.from(pngBase64, "base64"));
  if (src.width <= targetWidth) {
    return { pngBase64, width: src.width, height: src.height };
  }
  const scale = src.width / targetWidth;
  const w = targetWidth;
  const h = Math.max(1, Math.round(src.height / scale));
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * scale));
      const si = sy * src.width + sx << 2;
      const di = y * w + x << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return { pngBase64: PNG.sync.write(dst).toString("base64"), width: w, height: h };
}

// src/agent/highlight-tracker.ts
import { PNG as PNG2 } from "pngjs";
function isGlow(r, g, b) {
  return r >= 212 && g >= 212 && r - g <= 35 && b <= 140 && g - b >= 80;
}
function colorMatcher(target, tol = 60) {
  return (r, g, b) => Math.abs(r - target.r) <= tol && Math.abs(g - target.g) <= tol && Math.abs(b - target.b) <= tol;
}
var DEFAULT_MIN_BLOB = 25;
var CELL = 60;
var LOCK_RADIUS = 110;
function detectHighlight(source, opts = {}) {
  const frame = typeof source === "string" ? decodePng(source) : source;
  const { width, height, data } = frame;
  const minBlob = opts.minBlob ?? DEFAULT_MIN_BLOB;
  const match = opts.match ?? isGlow;
  const region = opts.region ?? { x: 0, y: 0, w: width, h: height };
  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(width, region.x + region.w);
  const y1 = Math.min(height, region.y + region.h);
  const exclude = opts.exclude ?? [];
  const excluded = (x, y) => {
    for (let r = 0; r < exclude.length; r++) {
      const e = exclude[r];
      if (x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) return true;
    }
    return false;
  };
  const xs = [];
  const ys = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (match(data[i], data[i + 1], data[i + 2]) && !excluded(x, y)) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const glowPixels = xs.length;
  if (glowPixels < minBlob) return null;
  const bins = /* @__PURE__ */ new Map();
  for (let k = 0; k < glowPixels; k++) {
    const key = (ys[k] / CELL | 0) * 1e5 + (xs[k] / CELL | 0);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  let peakKey = 0;
  let peakCount = -1;
  for (const [k, c] of bins) {
    if (c > peakCount) {
      peakCount = c;
      peakKey = k;
    }
  }
  const pcx = peakKey % 1e5 * CELL + CELL / 2;
  const pcy = (peakKey / 1e5 | 0) * CELL + CELL / 2;
  const bx = [];
  const by = [];
  for (let k = 0; k < glowPixels; k++) {
    if (Math.abs(xs[k] - pcx) <= LOCK_RADIUS && Math.abs(ys[k] - pcy) <= LOCK_RADIUS) {
      bx.push(xs[k]);
      by.push(ys[k]);
    }
  }
  const blobSize = bx.length;
  if (blobSize === 0) return null;
  let sx = 0;
  let sy = 0;
  let minX = bx[0];
  let maxX = bx[0];
  let minY = by[0];
  let maxY = by[0];
  for (let k = 0; k < blobSize; k++) {
    sx += bx[k];
    sy += by[k];
    if (bx[k] < minX) minX = bx[k];
    if (bx[k] > maxX) maxX = bx[k];
    if (by[k] < minY) minY = by[k];
    if (by[k] > maxY) maxY = by[k];
  }
  return {
    x: Math.round(sx / blobSize),
    y: Math.round(sy / blobSize),
    blobSize,
    glowPixels,
    bbox: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
  };
}
function decodePng(pngBase64) {
  const png = PNG2.sync.read(Buffer.from(pngBase64, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}

// src/agent/minimap-compass.ts
import { PNG as PNG3 } from "pngjs";
var CELL2 = 20;
function norm180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
function decode(source) {
  if (typeof source !== "string") return source;
  const png = PNG3.sync.read(Buffer.from(source, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}
function detectMinimapArrow(source, minimap, opts = {}) {
  const { width, height, data } = decode(source);
  const minPixels = opts.minPixels ?? 8;
  const edgeFrac = opts.edgeFrac ?? 0.55;
  const { cx, cy, r } = minimap;
  const inner = (edgeFrac * r) ** 2;
  const outer = (r * 1.08) ** 2;
  const x0 = Math.max(0, Math.floor(cx - r * 1.1));
  const y0 = Math.max(0, Math.floor(cy - r * 1.1));
  const x1 = Math.min(width, Math.ceil(cx + r * 1.1));
  const y1 = Math.min(height, Math.ceil(cy + r * 1.1));
  const xs = [];
  const ys = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 < inner || d2 > outer) continue;
      const i = (y * width + x) * 4;
      if (isGlow(data[i], data[i + 1], data[i + 2])) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < minPixels) return null;
  const bins = /* @__PURE__ */ new Map();
  for (let k = 0; k < xs.length; k++) {
    const key = (ys[k] / CELL2 | 0) * 1e5 + (xs[k] / CELL2 | 0);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  let peakKey = 0;
  let peakCount = -1;
  for (const [k, c] of bins) {
    if (c > peakCount) {
      peakCount = c;
      peakKey = k;
    }
  }
  const pcx = peakKey % 1e5 * CELL2 + CELL2 / 2;
  const pcy = (peakKey / 1e5 | 0) * CELL2 + CELL2 / 2;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let k = 0; k < xs.length; k++) {
    if (Math.abs(xs[k] - pcx) <= CELL2 * 2 && Math.abs(ys[k] - pcy) <= CELL2 * 2) {
      sx += xs[k];
      sy += ys[k];
      n++;
    }
  }
  const ax = sx / n;
  const ay = sy / n;
  const dx = ax - cx;
  const dy = ay - cy;
  const bearingDeg = norm180(Math.atan2(dx, -dy) * 180 / Math.PI);
  return { x: Math.round(ax), y: Math.round(ay), bearingDeg, dist: Math.hypot(dx, dy), pixels: n };
}
function planCameraDrag(bearingDeg, opts) {
  const pxPerDeg = opts.pxPerDeg ?? 3;
  const dragSign = opts.dragSign ?? 1;
  const deadzone = opts.deadzoneDeg ?? 10;
  const maxDragPx = opts.maxDragPx ?? 200;
  const turnDeg = norm180(-bearingDeg);
  if (Math.abs(turnDeg) <= deadzone) return null;
  const px = Math.min(maxDragPx, Math.max(1, Math.round(Math.abs(turnDeg) * pxPerDeg)));
  const dir = Math.sign(turnDeg) * dragSign;
  return {
    fromX: Math.round(opts.center.x),
    fromY: Math.round(opts.center.y),
    toX: Math.round(opts.center.x + dir * px),
    toY: Math.round(opts.center.y),
    turnDeg
  };
}

// src/agent/dialogue.ts
import { PNG as PNG4 } from "pngjs";
var DIALOGUE_ADVANCE_KEY = "space";
var DEFAULT_BAND_FRAC = 0.28;
var DEFAULT_MIN_FILL = 0.35;
function isParchment(r, g, b) {
  return r >= 200 && r <= 238 && g >= 188 && g <= 222 && b >= 150 && b <= 196 && r >= g && g >= b;
}
function decode2(source) {
  if (typeof source !== "string") return source;
  const png = PNG4.sync.read(Buffer.from(source, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}
function detectDialogue(source, opts = {}) {
  const { width, height, data } = decode2(source);
  const minFill = opts.minFill ?? DEFAULT_MIN_FILL;
  const region = opts.region ?? {
    x: 0,
    y: Math.floor(height * (1 - DEFAULT_BAND_FRAC)),
    w: width,
    h: Math.ceil(height * DEFAULT_BAND_FRAC)
  };
  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(width, region.x + region.w);
  const y1 = Math.min(height, region.y + region.h);
  const scanned = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (scanned === 0) {
    return { open: false, fill: 0, box: { x: 0, y: 0, w: 0, h: 0 } };
  }
  let parchment = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (isParchment(data[i], data[i + 1], data[i + 2])) {
        parchment++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const fill = parchment / scanned;
  const box = parchment === 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { open: fill >= minFill, fill, box };
}

// src/agent/progress-watch.ts
import { PNG as PNG5 } from "pngjs";
function frameSignature(source, opts = {}) {
  const frame = typeof source === "string" ? decode3(source) : source;
  const { width, height, data } = frame;
  let x0 = 0, y0 = 0, x1 = width, y1 = height;
  if (opts.excludeHud) {
    const hud = opts.excludeHud;
    if (hud.y + hud.h >= height * 0.7) {
      y1 = Math.min(y1, hud.y);
    }
  }
  const gridW = 16;
  const gridH = 12;
  let sum = 0;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const fx = Math.floor(x0 + gx * (x1 - x0) / gridW);
      const fy = Math.floor(y0 + gy * (y1 - y0) / gridH);
      if (fx >= 0 && fx < width && fy >= 0 && fy < height) {
        const offset = (fy * width + fx) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const luma2 = Math.floor(0.299 * r + 0.587 * g + 0.114 * b);
        sum += luma2;
      }
    }
  }
  return sum;
}
function decode3(source) {
  const png = PNG5.sync.read(Buffer.from(source, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}
var ProgressWatch = class {
  historySize;
  stuckThreshold;
  signatureEpsilon;
  targetEpsilon;
  signatures = [];
  targets = [];
  isStuck = false;
  constructor(opts = {}) {
    this.historySize = opts.historySize ?? 5;
    this.stuckThreshold = opts.stuckThreshold ?? 3;
    this.signatureEpsilon = opts.signatureEpsilon ?? 5;
    this.targetEpsilon = opts.targetEpsilon ?? 10;
  }
  /**
   * Check if progress has stalled based on the current frame signature
   * and click target. Returns true if stuck (should trigger recovery).
   */
  noProgress(currentSignature, currentTarget) {
    this.signatures.push(currentSignature);
    this.targets.push({ ...currentTarget });
    if (this.signatures.length > this.historySize) {
      this.signatures.shift();
      this.targets.shift();
    }
    if (this.signatures.length < this.stuckThreshold + 1) {
      this.isStuck = false;
      return false;
    }
    const checkLength = this.stuckThreshold + 1;
    let allSimilar = true;
    for (let i = this.signatures.length - checkLength; i < this.signatures.length - 1; i++) {
      const sig1 = this.signatures[i];
      const sig2 = this.signatures[i + 1];
      const target1 = this.targets[i];
      const target2 = this.targets[i + 1];
      const sigSimilar = Math.abs(sig1 - sig2) <= this.signatureEpsilon;
      const targetSimilar = this.isTargetSimilar(target1, target2);
      if (!sigSimilar || !targetSimilar) {
        allSimilar = false;
        break;
      }
    }
    this.isStuck = allSimilar;
    return this.isStuck;
  }
  /**
   * Clear all tracked history. Call after triggering a recovery action so the
   * post-recovery frames are judged afresh (otherwise the pre-recovery stall
   * lingers in the window and re-trips immediately).
   */
  reset() {
    this.signatures = [];
    this.targets = [];
    this.isStuck = false;
  }
  /**
   * Get recommended recovery actions when stuck.
   * Returns empty array if not currently stuck.
   */
  getRecoveryActions() {
    if (!this.isStuck) {
      return [];
    }
    return [
      "rotate-camera" /* ROTATE_CAMERA */,
      "step-aside" /* STEP_ASIDE */,
      "hand-to-vlm" /* HAND_TO_VLM */
    ];
  }
  isTargetSimilar(target1, target2) {
    const dx = target1.x - target2.x;
    const dy = target1.y - target2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance <= this.targetEpsilon;
  }
};

// src/agent/play-loop.ts
var CREDENTIAL_WORDS = /\b(pass\s?word|passwd|pwd|2fa|otp|one[-\s]?time|authenticator|auth\s?code|backup\s?code|recovery\s?code|seed\s?phrase|secret\s?key|private\s?key)\b/i;
var EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
function looksLikeSecret(text) {
  if (CREDENTIAL_WORDS.test(text)) return true;
  if (EMAIL.test(text)) return true;
  const token = text.trim();
  if (token.length >= 24 && /[A-Za-z]/.test(token) && /\d/.test(token) && !/\s/.test(token)) return true;
  return false;
}
function isRateLimitError(e) {
  return e instanceof Error && /rate limit/i.test(e.message);
}
function translateAction(action, dx, dy) {
  return mapActionToScreen(action, 1, 1, dx, dy);
}
function mapActionToScreen(action, scaleX, scaleY, offX, offY) {
  const mx = (v) => Math.round(v * scaleX) + offX;
  const my = (v) => Math.round(v * scaleY) + offY;
  switch (action.type) {
    case "click":
      return { ...action, x: mx(action.x), y: my(action.y) };
    case "scroll":
      return { ...action, x: mx(action.x), y: my(action.y) };
    case "drag":
      return { ...action, fromX: mx(action.fromX), fromY: my(action.fromY), toX: mx(action.toX), toY: my(action.toY) };
    default:
      return action;
  }
}
function clampActionToScreen(action, region) {
  if (!region) return action;
  const cx = (v) => Math.max(region.x, Math.min(region.x + region.w - 1, v));
  const cy = (v) => Math.max(region.y, Math.min(region.y + region.h - 1, v));
  switch (action.type) {
    case "click":
      return { ...action, x: cx(action.x), y: cy(action.y) };
    case "scroll":
      return { ...action, x: cx(action.x), y: cy(action.y) };
    case "drag":
      return { ...action, fromX: cx(action.fromX), fromY: cy(action.fromY), toX: cx(action.toX), toY: cy(action.toY) };
    default:
      return action;
  }
}
async function runPlayLoop(deps, opts) {
  const { helper, vlm, killSwitch, rateLimiter } = deps;
  const log = deps.log ?? (() => {
  });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isSecret = deps.isSecretText ?? looksLikeSecret;
  const downscale = deps.downscale ?? downscalePngNearest;
  const detectHighlight2 = deps.detectHighlight ?? detectHighlight;
  const detectMinimapArrow2 = deps.detectMinimapArrow ?? detectMinimapArrow;
  const planCameraDrag2 = deps.planCameraDrag ?? planCameraDrag;
  const detectDialogue2 = deps.detectDialogue ?? detectDialogue;
  const frameSignature2 = deps.frameSignature ?? frameSignature;
  const compassMaxTurns = opts.compassMaxTurns ?? 8;
  const maxDialogueAdvances = opts.maxDialogueAdvances ?? 12;
  const stuckCameraRotatePx = opts.stuckCameraRotatePx ?? 380;
  const watch = opts.useStuckRecovery ? new ProgressWatch({
    historySize: opts.stuckHistorySize,
    stuckThreshold: opts.stuckThreshold,
    signatureEpsilon: opts.stuckSignatureEpsilon ?? 600,
    targetEpsilon: opts.stuckTargetEpsilon ?? 12
  }) : null;
  const maxSteps = opts.maxSteps ?? 50;
  const maxMs = opts.maxMs ?? 10 * 6e4;
  const stepDelayMs = opts.stepDelayMs ?? 600;
  const maxEmpty = opts.maxConsecutiveEmptyPlans ?? 3;
  const maxNotFrontmost = opts.maxConsecutiveNotFrontmost ?? 5;
  const maxActionsPerStep = opts.maxActionsPerStep ?? 3;
  const maxPlanErrors = opts.maxConsecutivePlanErrors ?? 5;
  const start = now();
  const history = [];
  let steps = 0;
  let actionsExecuted = 0;
  let refusedSecrets = 0;
  let emptyStreak = 0;
  let notFrontmostStreak = 0;
  let planErrorStreak = 0;
  let compassTurnStreak = 0;
  let dialogueStreak = 0;
  let region = opts.region;
  let stuckRotateCount = 0;
  let stuckWalkCount = 0;
  const refreshRegionIfPossible = async (current) => {
    if (!deps.refreshRegion) return current;
    try {
      const next = await deps.refreshRegion();
      if (next && next.w > 0 && next.h > 0) {
        log({ kind: "region-refresh", region: next });
        return next;
      }
    } catch {
    }
    return current;
  };
  const finish = (reason) => {
    log({ kind: "stop", reason });
    return { stopReason: reason, steps, actionsExecuted, refusedSecrets, history };
  };
  while (true) {
    if (killSwitch.aborted) return finish("killed");
    if (steps >= maxSteps) return finish("max-steps");
    if (now() - start >= maxMs) return finish("max-time");
    const frontmost = await helper.frontmostApp();
    if (frontmost !== opts.targetBundleId) {
      notFrontmostStreak++;
      log({ kind: "not-frontmost", frontmost, consecutive: notFrontmostStreak });
      if (notFrontmostStreak >= maxNotFrontmost) return finish("lost-focus");
      await sleep(stepDelayMs);
      continue;
    }
    if (notFrontmostStreak > 0) {
      region = await refreshRegionIfPossible(region);
    }
    notFrontmostStreak = 0;
    steps++;
    log({ kind: "step", step: steps, frontmost });
    const shot = region ? await helper.capture(region) : await helper.capture();
    const offX = region?.x ?? 0;
    const offY = region?.y ?? 0;
    let plans;
    let scaleX = 1;
    let scaleY = 1;
    let fastPathHit = null;
    if (opts.useHighlightFastPath) {
      try {
        fastPathHit = detectHighlight2(shot.pngBase64, {
          minBlob: opts.highlightMinBlob,
          exclude: opts.highlightExclude,
          // Unset by default → detectHighlight falls back to vanilla `isGlow`.
          match: opts.highlightMatch
        });
      } catch {
        fastPathHit = null;
      }
    }
    let dialogueOpen = false;
    if (!fastPathHit && opts.useDialogueAdvance && dialogueStreak < maxDialogueAdvances) {
      try {
        dialogueOpen = detectDialogue2(shot.pngBase64).open === true;
      } catch {
        dialogueOpen = false;
      }
    }
    let compassDrag = null;
    let compassBearing = 0;
    if (!fastPathHit && !dialogueOpen && opts.useMinimapCompass && opts.minimap && compassTurnStreak < compassMaxTurns) {
      try {
        const arrow = detectMinimapArrow2(shot.pngBase64, opts.minimap);
        if (arrow) {
          compassBearing = arrow.bearingDeg;
          const center = opts.compassCenter ?? { x: Math.round(shot.width / 2), y: Math.round(shot.height / 2) };
          compassDrag = planCameraDrag2(arrow.bearingDeg, {
            center,
            pxPerDeg: opts.compassPxPerDeg,
            dragSign: opts.compassDragSign,
            maxDragPx: opts.compassMaxDragPx
          });
        }
      } catch {
        compassDrag = null;
      }
    }
    let stuckRotate = null;
    let stuckWalk = null;
    if (watch && fastPathHit) {
      let sig = 0;
      try {
        sig = frameSignature2(shot.pngBase64, {
          excludeHud: { x: 0, y: Math.round(shot.height * 0.72), w: shot.width, h: Math.round(shot.height * 0.28) }
        });
      } catch {
        sig = 0;
      }
      if (watch.noProgress(sig, { x: fastPathHit.x, y: fastPathHit.y })) {
        watch.reset();
        region = await refreshRegionIfPossible(region);
        if (opts.stuckRecovery === "walk") {
          const cx = Math.round(shot.width * 0.32);
          const cy = Math.round(shot.height * 0.32);
          const ang = stuckWalkCount * 2.39996;
          stuckWalkCount++;
          const wx = Math.round(cx + Math.cos(ang) * shot.width * 0.22);
          const wy = Math.round(cy + Math.sin(ang) * shot.height * 0.22);
          stuckWalk = {
            x: Math.max(12, Math.min(Math.round(shot.width * 0.6) - 12, wx)),
            y: Math.max(12, Math.min(Math.round(shot.height * 0.62) - 12, wy))
          };
          fastPathHit = null;
          log({ kind: "stuck", step: steps, recovery: "walk" });
        } else {
          const center = opts.compassCenter ?? { x: Math.round(shot.width / 2), y: Math.round(shot.height / 2) };
          const dir = stuckRotateCount % 2 === 0 ? 1 : -1;
          stuckRotateCount++;
          stuckRotate = { fromX: center.x, fromY: center.y, toX: center.x - dir * stuckCameraRotatePx, toY: center.y };
          fastPathHit = null;
          log({ kind: "stuck", step: steps, recovery: "camera-rotate" });
        }
      }
    }
    if (stuckWalk) {
      planErrorStreak = 0;
      compassTurnStreak = 0;
      dialogueStreak = 0;
      plans = [{ action: { type: "click", x: stuckWalk.x, y: stuckWalk.y, button: "left", clicks: 1 } }];
    } else if (stuckRotate) {
      planErrorStreak = 0;
      compassTurnStreak = 0;
      dialogueStreak = 0;
      plans = [
        {
          action: {
            type: "drag",
            fromX: stuckRotate.fromX,
            fromY: stuckRotate.fromY,
            toX: stuckRotate.toX,
            toY: stuckRotate.toY,
            button: "middle"
          }
        }
      ];
    } else if (fastPathHit) {
      log({ kind: "fast-path", step: steps, x: fastPathHit.x, y: fastPathHit.y, blobSize: fastPathHit.blobSize });
      planErrorStreak = 0;
      compassTurnStreak = 0;
      dialogueStreak = 0;
      plans = [{ action: { type: "click", x: fastPathHit.x, y: fastPathHit.y, button: "left", clicks: 1 } }];
    } else if (dialogueOpen) {
      dialogueStreak++;
      log({ kind: "dialogue", step: steps, advances: dialogueStreak });
      planErrorStreak = 0;
      compassTurnStreak = 0;
      plans = [{ action: { type: "key", keys: [DIALOGUE_ADVANCE_KEY] } }];
    } else if (compassDrag) {
      log({ kind: "compass", step: steps, bearingDeg: compassBearing, turnDeg: compassDrag.turnDeg, dragPx: compassDrag.toX - compassDrag.fromX });
      planErrorStreak = 0;
      compassTurnStreak++;
      dialogueStreak = 0;
      plans = [{
        action: {
          type: "drag",
          fromX: compassDrag.fromX,
          fromY: compassDrag.fromY,
          toX: compassDrag.toX,
          toY: compassDrag.toY,
          button: "middle"
        }
      }];
    } else {
      let sendB64 = shot.pngBase64;
      let sendW = shot.width;
      let sendH = shot.height;
      if (opts.downscaleWidth && shot.width > opts.downscaleWidth) {
        const ds = downscale(shot.pngBase64, opts.downscaleWidth);
        sendB64 = ds.pngBase64;
        sendW = ds.width;
        sendH = ds.height;
        scaleX = shot.width / ds.width;
        scaleY = shot.height / ds.height;
      }
      try {
        plans = await vlm.plan(
          { screenshotBase64: sendB64, width: sendW, height: sendH, goal: opts.goal },
          history
        );
      } catch (e) {
        planErrorStreak++;
        log({ kind: "plan-error", step: steps, detail: e instanceof Error ? e.message : String(e) });
        if (planErrorStreak >= maxPlanErrors) return finish("error");
        await sleep(stepDelayMs);
        continue;
      }
      planErrorStreak = 0;
      compassTurnStreak = 0;
      dialogueStreak = 0;
      log({ kind: "plan", step: steps, actions: plans.length });
    }
    if (plans.length === 0) {
      emptyStreak++;
      if (emptyStreak >= maxEmpty) return finish("idle");
      await sleep(stepDelayMs);
      continue;
    }
    emptyStreak = 0;
    for (const planned of plans.slice(0, maxActionsPerStep)) {
      if (killSwitch.aborted) return finish("killed");
      const action = planned.action;
      if (action.type === "type" && isSecret(action.text)) {
        refusedSecrets++;
        log({ kind: "refused-secret", preview: "[redacted]" });
        history.push({ action: { ...action, text: "[redacted-secret]" }, outcome: "error", at: now() });
        continue;
      }
      try {
        rateLimiter.consume();
      } catch (e) {
        if (isRateLimitError(e)) {
          log({ kind: "throttled" });
          await sleep(stepDelayMs);
          break;
        }
        throw e;
      }
      try {
        await executeAction(helper, clampActionToScreen(mapActionToScreen(action, scaleX, scaleY, offX, offY), region), sleep);
        actionsExecuted++;
        history.push({ action, outcome: "ok", at: now() });
        log({ kind: "action", action, outcome: "ok" });
      } catch (e) {
        history.push({ action, outcome: "error", at: now() });
        log({ kind: "action", action, outcome: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    await sleep(stepDelayMs);
  }
}
async function executeAction(helper, action, sleep) {
  switch (action.type) {
    case "click":
      await helper.click({ x: action.x, y: action.y, button: action.button, clicks: action.clicks });
      return;
    case "type":
      await helper.type(action.text);
      return;
    case "key":
      await helper.key(action.keys);
      return;
    case "scroll":
      await helper.scroll({ x: action.x, y: action.y, dx: action.dx, dy: action.dy });
      return;
    case "drag":
      await helper.drag({ fromX: action.fromX, fromY: action.fromY, toX: action.toX, toY: action.toY, button: action.button });
      return;
    case "wait":
      await sleep(action.ms);
      return;
    case "screenshot":
      return;
  }
}

// src/vlm/hybrid.ts
function redact(text) {
  return looksLikeSecret(text) ? "[redacted]" : text;
}
function redactAction(action) {
  if (action.type === "type" && looksLikeSecret(action.text)) return { ...action, text: "[redacted]" };
  return action;
}
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
function sceneIsEmpty(s) {
  return s.targets.length === 0 && !s.objective && !s.dialogue && !s.notes;
}
var STRATEGIST_SYSTEM = `You are the strategist for an agent playing Old School RuneScape. A local vision
model has already read the screen and given you a structured description of it.
Decide the next 1 to 3 actions that best advance the player's goal.

Choose click coordinates ONLY from the listed targets (they are the pixel centers
the vision model located). For type/key/scroll/drag/wait you may use your own
values. All coordinate values (x, y, fromX, fromY, toX, toY) are in the SAME
pixel space as the listed targets and the stated screen size.

OUTPUT FORMAT \u2014 emit JSON only, no prose, no markdown fences:
[
  { "thought": "<short reasoning>", "action": { ... one supported action ... } }
]

Supported actions:
  - {"type":"click","x":<int>,"y":<int>,"button":"left"|"right"|"middle","clicks":1|2}
  - {"type":"type","text":"<string>"}
  - {"type":"key","keys":["<keyname>", ...]}
  - {"type":"scroll","x":<int>,"y":<int>,"dx":<int>,"dy":<int>}
  - {"type":"drag","fromX":<int>,"fromY":<int>,"toX":<int>,"toY":<int>,"button":"left"|"right"}
  - {"type":"wait","ms":<int 0..60000>}
  - {"type":"screenshot"}

Rules:
- If the goal is already complete, or only a login / account / payment /
  authenticator screen is visible, return an empty array: [].
- NEVER type passwords, emails, PINs, or authenticator codes.
- Prefer advancing dialogue ("Click here to continue") and the current objective.
- Avoid repeating an action that just failed in the recent history.`;
function renderHistory2(history) {
  if (history.length === 0) return "Recent actions: none.\n";
  const lines = history.slice(-5).map((h, i) => `  ${i + 1}. ${h.outcome.toUpperCase()}: ${JSON.stringify(redactAction(h.action))}`);
  return `Recent actions:
${lines.join("\n")}
`;
}
function buildStrategistPrompt(scene, input, history) {
  const targets = scene.targets.length > 0 ? scene.targets.map((t) => `  - "${redact(t.label)}" at (${t.x}, ${t.y})`).join("\n") : "  (none located)";
  const user = [
    `Goal: ${input.goal}`,
    `Screen: ${input.width} x ${input.height} px.`,
    scene.objective ? `On-screen objective: ${redact(scene.objective)}` : "On-screen objective: (none)",
    scene.dialogue ? `Open dialogue: ${redact(scene.dialogue)}` : "Open dialogue: (none)",
    scene.notes ? `Notes: ${redact(scene.notes)}` : "",
    `Clickable targets:
${targets}`,
    renderHistory2(history),
    `Decide the next 1-3 actions. Emit JSON only.`
  ].filter(Boolean).join("\n");
  return { system: STRATEGIST_SYSTEM, user };
}
var HybridVlmProvider = class {
  name;
  isLocal = false;
  deps;
  constructor(deps) {
    this.deps = deps;
    this.name = deps.name ?? "hybrid";
  }
  async plan(input, history) {
    const log = this.deps.log ?? (() => {
    });
    let scene;
    try {
      scene = await this.deps.observe(input);
    } catch (e) {
      log({ kind: "grounder-error", detail: msg(e) });
      return this.safeFallback(input, history);
    }
    if (sceneIsEmpty(scene)) {
      log({ kind: "idle" });
      return [];
    }
    log({ kind: "grounded", targets: scene.targets.length });
    const { system, user } = buildStrategistPrompt(scene, input, history);
    try {
      const text = await this.deps.strategize(system, user);
      return parseVlmActions(text);
    } catch (e) {
      log({ kind: "strategist-error", detail: msg(e) });
      return this.safeFallback(input, history);
    }
  }
  /**
   * Run the local fallback planner; if IT also fails (e.g. the local model is
   * down too), return [] (idle) rather than throwing — the loop must never crash.
   */
  async safeFallback(input, history) {
    try {
      return await this.deps.fallbackPlan(input, history);
    } catch (e) {
      (this.deps.log ?? (() => {
      }))({ kind: "fallback-error", detail: msg(e) });
      return [];
    }
  }
};

// src/policy/allowlist.ts
var DEFAULT_GUI_TOOLS = [
  "gui_screenshot",
  "gui_describe",
  "gui_plan",
  "gui_wait",
  "gui_scroll",
  "gui_click",
  "gui_key",
  "gui_type",
  "gui_drag"
];
var GuiAllowlist = class {
  set;
  constructor(names = DEFAULT_GUI_TOOLS) {
    this.set = new Set(names);
  }
  allows(name) {
    return this.set.has(name);
  }
  names() {
    return Array.from(this.set);
  }
};

// src/policy/rate-limit.ts
var RateLimitError = class extends Error {
  constructor(bucket, limit, windowMs) {
    super(`rate limit exceeded for ${bucket}: ${limit} events / ${windowMs}ms`);
    this.bucket = bucket;
    this.limit = limit;
    this.windowMs = windowMs;
    this.name = "RateLimitError";
  }
  bucket;
  limit;
  windowMs;
};
var RateLimiter = class {
  name;
  windowMs;
  maxEvents;
  times = [];
  nowFn;
  constructor(cfg, nowFn = Date.now) {
    this.name = cfg.name ?? "default";
    this.windowMs = cfg.windowMs;
    this.maxEvents = cfg.maxEvents;
    this.nowFn = nowFn;
  }
  consume() {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    while (this.times.length > 0 && this.times[0] <= cutoff) this.times.shift();
    if (this.times.length >= this.maxEvents) {
      throw new RateLimitError(this.name, this.maxEvents, this.windowMs);
    }
    this.times.push(now);
  }
  available() {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    while (this.times.length > 0 && this.times[0] <= cutoff) this.times.shift();
    return Math.max(0, this.maxEvents - this.times.length);
  }
};

// src/policy/sensitive-apps.ts
var DEFAULT_SENSITIVE_BUNDLES = [
  "com.agilebits.onepassword7",
  "com.agilebits.onepassword4",
  "com.1password.1password",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",
  "com.apple.SecurityAgent"
];
var SensitiveAppGuard = class {
  set;
  constructor(cfg = {}) {
    const base = cfg.baseList ?? DEFAULT_SENSITIVE_BUNDLES;
    const extra = cfg.extra ?? [];
    this.set = /* @__PURE__ */ new Set([...base, ...extra]);
  }
  isBlocked(bundleId) {
    if (!bundleId) return false;
    return this.set.has(bundleId);
  }
  reasonFor(bundleId) {
    if (!this.isBlocked(bundleId)) return null;
    return `frontmost app ${bundleId} is in the sensitive-app deny list`;
  }
};

// src/policy/redact.ts
import { PNG as PNG6 } from "pngjs";
async function redactPng(pngBuffer, regions) {
  if (regions.length === 0) return pngBuffer;
  const usable = regions.filter((r) => r.w > 0 && r.h > 0);
  if (usable.length === 0) return pngBuffer;
  const decoded = PNG6.sync.read(pngBuffer);
  for (const r of usable) {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(decoded.width, r.x + r.w);
    const y1 = Math.min(decoded.height, r.y + r.h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * decoded.width + x) * 4;
        decoded.data[i] = 0;
        decoded.data[i + 1] = 0;
        decoded.data[i + 2] = 0;
        decoded.data[i + 3] = 255;
      }
    }
  }
  return PNG6.sync.write(decoded);
}
async function redactBase64(pngBase64, regions) {
  if (regions.length === 0) return pngBase64;
  const buf = Buffer.from(pngBase64, "base64");
  const out = await redactPng(buf, regions);
  return out.toString("base64");
}

// src/policy/kill-switch.ts
var KillSwitch = class {
  _aborted = false;
  tripListeners = [];
  resetListeners = [];
  get aborted() {
    return this._aborted;
  }
  trip(reason) {
    if (this._aborted) return;
    this._aborted = true;
    for (const l of this.tripListeners) {
      try {
        l(reason);
      } catch {
      }
    }
  }
  onTrip(listener) {
    this.tripListeners.push(listener);
    return () => {
      const i = this.tripListeners.indexOf(listener);
      if (i >= 0) this.tripListeners.splice(i, 1);
    };
  }
  reset(reason = "") {
    if (!this._aborted) return;
    this._aborted = false;
    for (const l of this.resetListeners) {
      try {
        l(reason);
      } catch {
      }
    }
  }
  onReset(listener) {
    this.resetListeners.push(listener);
    return () => {
      const i = this.resetListeners.indexOf(listener);
      if (i >= 0) this.resetListeners.splice(i, 1);
    };
  }
  attachHelper(helper) {
    return helper.onHotkey((name) => {
      if (name === "kill") this.trip("hotkey:kill");
    });
  }
};

// src/agent/inventory.ts
import { PNG as PNG7 } from "pngjs";
var DEFAULT_MIN_BOX = 20;
function decode4(source) {
  if (typeof source !== "string") return source;
  const png = PNG7.sync.read(Buffer.from(source, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}
function detectHighlightedSlots(source, opts = {}) {
  const { width, height, data } = decode4(source);
  const minBox = opts.minBox ?? DEFAULT_MIN_BOX;
  const region = opts.region ?? { x: 0, y: 0, w: width, h: height };
  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(width, region.x + region.w);
  const y1 = Math.min(height, region.y + region.h);
  if (x1 <= x0 || y1 <= y0) return [];
  const rw = x1 - x0;
  const rh = y1 - y0;
  const glow = new Uint8Array(rw * rh);
  let any = false;
  for (let ry = 0; ry < rh; ry++) {
    const fy = ry + y0;
    for (let rx = 0; rx < rw; rx++) {
      const fx = rx + x0;
      const i = (fy * width + fx) * 4;
      if (isGlow(data[i], data[i + 1], data[i + 2])) {
        glow[ry * rw + rx] = 1;
        any = true;
      }
    }
  }
  if (!any) return [];
  const seen = new Uint8Array(rw * rh);
  const stack = [];
  const slots = [];
  for (let start = 0; start < glow.length; start++) {
    if (glow[start] === 0 || seen[start] === 1) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let sx = 0;
    let sy = 0;
    let count = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    while (stack.length > 0) {
      const p = stack.pop();
      const rx = p % rw;
      const ry = p / rw | 0;
      const fx = rx + x0;
      const fy = ry + y0;
      sx += fx;
      sy += fy;
      count++;
      if (fx < minX) minX = fx;
      if (fx > maxX) maxX = fx;
      if (fy < minY) minY = fy;
      if (fy > maxY) maxY = fy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = ry + dy;
        if (ny < 0 || ny >= rh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = rx + dx;
          if (nx < 0 || nx >= rw) continue;
          const q = ny * rw + nx;
          if (glow[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (count < minBox) continue;
    slots.push({
      x: Math.round(sx / count),
      y: Math.round(sy / count),
      blobSize: count,
      bbox: { minX, minY, maxX, maxY }
    });
  }
  slots.sort((a, b) => a.y === b.y ? a.x - b.x : a.y - b.y);
  return slots;
}

// src/agent/screen-state.ts
import { PNG as PNG8 } from "pngjs";
var DEFAULT_DARK_THRESHOLD = 30;
var DEFAULT_PARCHMENT_FRAC_THRESHOLD = 0.3;
var DEFAULT_BOTTOM_BAND_FRAC = 0.28;
function isParchment2(r, g, b) {
  return r >= 200 && r <= 238 && g >= 188 && g <= 222 && b >= 150 && b <= 196 && r >= g && g >= b;
}
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function decode5(source) {
  if (typeof source !== "string") return source;
  const png = PNG8.sync.read(Buffer.from(source, "base64"));
  return { width: png.width, height: png.height, data: png.data };
}
function classifyScreen(source, opts = {}) {
  const { width, height, data } = decode5(source);
  const darkThreshold = opts.darkThreshold ?? DEFAULT_DARK_THRESHOLD;
  const parchmentFracThreshold = opts.parchmentFracThreshold ?? DEFAULT_PARCHMENT_FRAC_THRESHOLD;
  let lumaSum = 0;
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    lumaSum += luma(data[o], data[o + 1], data[o + 2]);
  }
  const overallBrightness = pixelCount > 0 ? lumaSum / pixelCount : 0;
  const band = opts.bottomBand ?? {
    x: 0,
    y: Math.floor(height * (1 - DEFAULT_BOTTOM_BAND_FRAC)),
    w: width,
    h: Math.ceil(height * DEFAULT_BOTTOM_BAND_FRAC)
  };
  const bx0 = Math.max(0, band.x);
  const by0 = Math.max(0, band.y);
  const bx1 = Math.min(width, band.x + band.w);
  const by1 = Math.min(height, band.y + band.h);
  let parchmentPixels = 0;
  let bandPixels = 0;
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const o = (y * width + x) * 4;
      bandPixels++;
      if (isParchment2(data[o], data[o + 1], data[o + 2])) parchmentPixels++;
    }
  }
  const bottomParchmentFrac = bandPixels > 0 ? parchmentPixels / bandPixels : 0;
  const signals = { bottomParchmentFrac, overallBrightness };
  let mode;
  if (overallBrightness < darkThreshold) mode = "dark";
  else if (bottomParchmentFrac >= parchmentFracThreshold) mode = "dialogue";
  else mode = "play";
  return { mode, signals };
}

// src/index.ts
var VERSION = "0.0.1";
export {
  ActionSchema,
  AnthropicProvider,
  BboxSchema,
  ChatGptSubscriptionClient,
  DEFAULT_GUI_TOOLS,
  DEFAULT_SENSITIVE_BUNDLES,
  DIALOGUE_ADVANCE_KEY,
  GuiAllowlist,
  HelperClient,
  HybridVlmProvider,
  KillSwitch,
  OllamaProvider,
  OpenAIProvider,
  RateLimitError,
  RateLimiter,
  ScreenshotSchema,
  SensitiveAppGuard,
  VERSION,
  buildObservePrompt,
  buildStrategistPrompt,
  classifyScreen,
  colorMatcher,
  createOllamaGrounder,
  decodeEvent,
  decodeResponse,
  detectDialogue,
  detectHighlight,
  detectHighlightedSlots,
  detectMinimapArrow,
  downscalePngNearest,
  encodeCommand,
  isGlow,
  isParchment,
  loadChatGptAuth,
  looksLikeSecret,
  mapActionToScreen,
  parseResponsesSse,
  parseScene,
  planCameraDrag,
  redactBase64,
  redactPng,
  runPlayLoop,
  translateAction
};
