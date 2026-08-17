import {
  CredentialResolver,
  GrokCliTokenManager,
  cursorSdkInlineApiKeyForbidden,
  isFreeRouteModel,
  isLocalOnlyProviderConfig,
  isModelEnabled,
  mergeRoutingDefaults
} from "./chunk-UXKN3EGC.js";
import {
  createLogger
} from "./chunk-RSXICYJP.js";
import {
  OpenAITokenManager,
  decodeExp,
  hasOpenAISessionAuth,
  hasOpenAISessionModelAccess,
  pickFreshestValid,
  readAuthFileSafe,
  writeRotatedToAll
} from "./chunk-VMDTKFKO.js";
import {
  ClaudeCliProvider
} from "./chunk-H6G63P2E.js";

// src/providers/base-provider.ts
var BaseProvider = class {
  modelKey;
  tier;
  billingMode;
  capabilities;
  pricing;
  contextSize;
  sanitizer;
  lastRedactionCount = 0;
  constructor(sanitizer) {
    this.sanitizer = sanitizer ?? null;
  }
  /** Returns the number of redactions applied during the last sanitizeMessages() call. */
  getLastRedactionCount() {
    return this.lastRedactionCount;
  }
  /** Sanitize messages before sending to a cloud provider. */
  sanitizeMessages(messages) {
    if (!this.sanitizer) {
      this.lastRedactionCount = 0;
      return messages;
    }
    let totalRedactions = 0;
    const sanitized = messages.map((msg) => {
      const result = this.sanitizer.sanitize(msg.content);
      totalRedactions += result.redactions;
      return {
        ...msg,
        content: result.text
      };
    });
    this.lastRedactionCount = totalRedactions;
    return sanitized;
  }
};

// src/providers/anthropic-provider.ts
var THINKING_BUDGET = {
  adaptive: void 0,
  // let the model decide
  low: 1024,
  medium: 4096,
  high: 16384,
  none: 0
};
var ADAPTIVE_THINKING_MODELS = [
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-mythos"
];
var AnthropicProvider = class extends BaseProvider {
  name = "anthropic";
  config;
  client;
  // Lazy-loaded Anthropic SDK
  constructor(config, sanitizer) {
    super(sanitizer);
    this.config = config;
    this.client = null;
  }
  async ensureClient() {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({
        apiKey: this.config.apiKey,
        ...this.config.baseUrl && { baseURL: this.config.baseUrl }
      });
    }
    return this.client;
  }
  async chat(messages, tools) {
    const client = await this.ensureClient();
    const sanitized = this.sanitizeMessages(messages);
    const systemMessage = sanitized.find((m) => m.role === "system");
    const conversationMessages = sanitized.filter((m) => m.role !== "system");
    const anthropicTools = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
    const anthropicMessages = conversationMessages.map((m) => ({
      role: m.role,
      content: m.toolCallId ? [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] : m.content
    }));
    const model = this.config.model || "claude-sonnet-5";
    const thinkingLevel = this.config.thinking ?? this.defaultThinkingLevel(model);
    const thinkingParams = this.buildThinkingParams(thinkingLevel, model);
    const response = await client.messages.create({
      model,
      max_tokens: this.config.maxTokens || 4096,
      ...systemMessage && { system: this.buildSystemParam(systemMessage.content) },
      messages: this.applyRollingCacheBreakpoint(anthropicMessages),
      ...anthropicTools?.length && { tools: anthropicTools },
      ...thinkingParams
    });
    const textContent = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const toolCalls = response.content.filter((block) => block.type === "tool_use").map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.input
    }));
    return {
      content: textContent,
      toolCalls,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        ...response.usage.cache_creation_input_tokens != null && {
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens
        },
        ...response.usage.cache_read_input_tokens != null && {
          cacheReadInputTokens: response.usage.cache_read_input_tokens
        }
      },
      model: response.model
    };
  }
  /**
   * Stream a chat response, yielding incremental chunks as they arrive.
   *
   * Uses `client.messages.stream()` which returns an async iterable of
   * server-sent events (content_block_start, content_block_delta, message_stop).
   */
  async *chatStream(messages, tools) {
    const client = await this.ensureClient();
    const sanitized = this.sanitizeMessages(messages);
    const systemMessage = sanitized.find((m) => m.role === "system");
    const conversationMessages = sanitized.filter((m) => m.role !== "system");
    const anthropicTools = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
    const anthropicMessages = conversationMessages.map((m) => ({
      role: m.role,
      content: m.toolCallId ? [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] : m.content
    }));
    const model = this.config.model || "claude-sonnet-5";
    const stream = client.messages.stream({
      model,
      max_tokens: this.config.maxTokens || 4096,
      ...systemMessage && { system: this.buildSystemParam(systemMessage.content) },
      messages: this.applyRollingCacheBreakpoint(anthropicMessages),
      ...anthropicTools?.length && { tools: anthropicTools }
    });
    const toolBlocks = /* @__PURE__ */ new Map();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens;
    let cacheCreationTokens;
    for await (const event of stream) {
      const e = event;
      if (e.type === "message_start" && e.message?.usage) {
        inputTokens = e.message.usage.input_tokens ?? 0;
        cacheReadTokens = e.message.usage.cache_read_input_tokens;
        cacheCreationTokens = e.message.usage.cache_creation_input_tokens;
      } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name });
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") {
          yield { type: "text_delta", content: event.delta.text };
        } else if (event.delta?.type === "input_json_delta") {
          const block = toolBlocks.get(event.index);
          yield {
            type: "tool_call_delta",
            toolCall: {
              index: event.index,
              id: block?.id,
              name: block?.name,
              arguments: event.delta.partial_json
            }
          };
        }
      } else if (e.type === "message_delta" && e.usage) {
        outputTokens = e.usage.output_tokens ?? 0;
      } else if (event.type === "message_stop") {
        yield {
          type: "done",
          finishReason: "end_turn",
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            ...cacheReadTokens != null && { cacheReadInputTokens: cacheReadTokens },
            ...cacheCreationTokens != null && { cacheCreationInputTokens: cacheCreationTokens }
          },
          model
        };
      }
    }
    if (inputTokens === 0 && outputTokens === 0) {
      try {
        const final = await stream.finalMessage();
        if (final?.usage) {
          console.debug(`[anthropic] stream usage fallback: in=${final.usage.input_tokens} out=${final.usage.output_tokens}`);
        }
      } catch {
      }
    }
  }
  /**
   * Determine the default thinking level based on model name.
   * Claude 4.6+ models default to "adaptive"; others default to "none".
   */
  defaultThinkingLevel(model) {
    const isAdaptiveModel = ADAPTIVE_THINKING_MODELS.some(
      (prefix) => model.startsWith(prefix)
    );
    return isAdaptiveModel ? "adaptive" : "none";
  }
  /**
   * Build the thinking parameter object for the API call.
   * Returns an empty object if thinking is disabled.
   */
  buildThinkingParams(level, model) {
    if (level === "none") return {};
    const supportsAdaptive = ADAPTIVE_THINKING_MODELS.some((prefix) => model.startsWith(prefix));
    if (supportsAdaptive) {
      return { thinking: { type: "adaptive" } };
    }
    if (level === "adaptive") return {};
    return { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET[level] } };
  }
  /** Caching is ON unless explicitly disabled. */
  cachingEnabled() {
    return this.config.promptCaching !== false;
  }
  /** Build the `system` parameter: a cache-marked block array when caching is on, else a plain string. */
  buildSystemParam(systemContent) {
    if (!this.cachingEnabled()) return systemContent;
    return [{ type: "text", text: systemContent, cache_control: { type: "ephemeral" } }];
  }
  /**
   * Attach a rolling cache breakpoint to the last content block of the last message,
   * so the growing conversation caches incrementally. Returns a new array (no mutation).
   */
  applyRollingCacheBreakpoint(messages) {
    if (!this.cachingEnabled() || messages.length === 0) return messages;
    const cc = { type: "ephemeral" };
    const copy = messages.slice();
    const last = copy[copy.length - 1];
    if (typeof last.content === "string") {
      copy[copy.length - 1] = { ...last, content: [{ type: "text", text: last.content, cache_control: cc }] };
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      const blocks = last.content.slice();
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cc };
      copy[copy.length - 1] = { ...last, content: blocks };
    }
    return copy;
  }
};

// src/providers/openai-model-profile.ts
var OPENAI_REASONING_EFFORTS = /* @__PURE__ */ new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh"
]);
function resolveOpenAIModelProfile(model) {
  const requestedModel = model.trim();
  const splitIndex = requestedModel.lastIndexOf("-");
  if (splitIndex <= 0) {
    return { requestedModel, apiModel: requestedModel };
  }
  const effortCandidate = requestedModel.slice(splitIndex + 1);
  if (!OPENAI_REASONING_EFFORTS.has(effortCandidate)) {
    return { requestedModel, apiModel: requestedModel };
  }
  const apiModel = requestedModel.slice(0, splitIndex);
  if (!apiModel.startsWith("gpt-5")) {
    return { requestedModel, apiModel: requestedModel };
  }
  return {
    requestedModel,
    apiModel,
    reasoningEffort: effortCandidate
  };
}

// src/providers/caveman-preset.ts
var CAVEMAN_SYSTEM_PROMPT = `# Caveman Mode

Respond terse like smart caveman. All technical substance stay. Only fluff die.

## Rules

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Abbreviate common terms (DB/auth/config/req/res/fn/impl). Strip conjunctions. Use arrows for causality (X -> Y). One word when one word enough.

Technical terms stay exact. Code blocks unchanged. Errors quoted exact.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

## Persistence

Active every response once triggered. No revert. No drift.

## Auto-clarity exception

Drop caveman temporarily for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user asks to clarify. Resume after.

(Adapted from mattpocock/skills caveman; MIT.)`;
function applyCaveman(messages) {
  const first = messages[0];
  if (first?.role === "system") {
    if (first.content.includes(CAVEMAN_SYSTEM_PROMPT)) {
      return messages.slice();
    }
    return [
      { role: "system", content: `${CAVEMAN_SYSTEM_PROMPT}

${first.content}` },
      ...messages.slice(1)
    ];
  }
  return [{ role: "system", content: CAVEMAN_SYSTEM_PROMPT }, ...messages];
}

// src/providers/openai-usage.ts
function normalizeOpenAiCompatibleUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return { promptTokens: 0, completionTokens: 0 };
  }
  const u = raw;
  const asNonNegInt = (v) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n);
  };
  let promptTokens = asNonNegInt(u.prompt_tokens) || asNonNegInt(u.input_tokens) || asNonNegInt(u.promptTokens) || asNonNegInt(u.inputTokens);
  let completionTokens = asNonNegInt(u.completion_tokens) || asNonNegInt(u.output_tokens) || asNonNegInt(u.completionTokens) || asNonNegInt(u.outputTokens);
  const total = asNonNegInt(u.total_tokens) || asNonNegInt(u.totalTokens) || asNonNegInt(u.total);
  if (promptTokens === 0 && completionTokens === 0 && total > 0) {
    completionTokens = total;
  } else if (promptTokens + completionTokens === 0 && total > 0) {
    completionTokens = total;
  } else if (promptTokens > 0 && completionTokens === 0 && total > promptTokens) {
    completionTokens = total - promptTokens;
  } else if (completionTokens > 0 && promptTokens === 0 && total > completionTokens) {
    promptTokens = total - completionTokens;
  }
  return { promptTokens, completionTokens };
}
function estimateTokensFromText(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const byWords = Math.ceil(words * 1.3);
  const byChars = Math.ceil(trimmed.length / 4);
  const symbolHits = (trimmed.match(/[{}\[\]();=<>/\\`|#@$]/g) || []).length;
  const symbolRatio = symbolHits / Math.max(1, trimmed.length);
  const estimate = symbolRatio > 0.04 ? byChars : Math.max(byChars, Math.round((byWords + byChars) / 2));
  return Math.max(1, estimate);
}

// src/providers/openai-provider.ts
var OpenAIProvider = class extends BaseProvider {
  name = "openai";
  config;
  constructor(config, sanitizer) {
    super(sanitizer);
    this.config = config;
  }
  get baseUrl() {
    return this.config.baseUrl || "https://api.openai.com/v1";
  }
  get model() {
    return this.config.model || "gpt-4o";
  }
  get maxTokens() {
    return this.config.maxTokens || 4096;
  }
  async chat(messages, tools, opts) {
    const sanitized = this.sanitizeMessages(messages);
    const body = this.buildRequestBody(sanitized, tools);
    const response = await this.fetchWithTimeout(body, opts?.signal);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`
      );
    }
    const data = await response.json();
    const choice = data.choices?.[0]?.message;
    const resolvedModel = resolveOpenAIModelProfile(this.model);
    const usage = normalizeOpenAiCompatibleUsage(data.usage);
    return {
      content: choice?.content || "",
      toolCalls: this.parseToolCalls(choice?.tool_calls || []),
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      },
      model: resolvedModel.reasoningEffort ? resolvedModel.requestedModel : data.model || resolvedModel.apiModel
    };
  }
  async *chatStream(messages, tools, opts) {
    const sanitized = this.sanitizeMessages(messages);
    const body = this.buildRequestBody(sanitized, tools, true);
    const response = await this.fetchWithTimeout(body, opts?.signal);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`
      );
    }
    yield* this.parseStream(response);
  }
  buildRequestBody(messages, tools, stream = false) {
    const resolvedModel = resolveOpenAIModelProfile(this.model);
    const cavemanMessages = this.config.caveman ? applyCaveman(messages) : messages;
    const requestMessages = this.shouldNormalizeLoopbackMessages(tools) ? this.normalizeLoopbackMessages(cavemanMessages) : cavemanMessages;
    const openaiMessages = requestMessages.map((m) => {
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.toolCallId
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }))
        };
      }
      return {
        role: m.role,
        content: m.content
      };
    });
    const body = {
      model: resolvedModel.apiModel,
      messages: openaiMessages,
      max_tokens: this.maxTokens
    };
    const reasoningEffort = resolvedModel.reasoningEffort ?? this.config.reasoningEffort;
    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }
  shouldNormalizeLoopbackMessages(tools) {
    if ((tools?.length ?? 0) > 0) return false;
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?\/v1\/?$/i.test(this.baseUrl);
  }
  normalizeLoopbackMessages(messages) {
    const systemPreamble = [];
    const normalized = [];
    const appendMessage = (role, content) => {
      if (!content.trim()) return;
      const previous = normalized[normalized.length - 1];
      if (previous && previous.role === role && !previous.toolCalls?.length) {
        previous.content = `${previous.content}

${content}`;
        return;
      }
      normalized.push({ role, content });
    };
    for (const message of messages) {
      if (message.role === "tool" || message.toolCalls?.length) {
        return messages;
      }
      if (message.role === "system") {
        if (message.content.trim()) systemPreamble.push(message.content.trim());
        continue;
      }
      const content = message.content.trim();
      if (!content) continue;
      if (message.role === "user" && systemPreamble.length > 0) {
        appendMessage("user", `${systemPreamble.join("\n\n")}

${content}`);
        systemPreamble.length = 0;
        continue;
      }
      appendMessage(message.role, content);
    }
    if (systemPreamble.length > 0) {
      appendMessage("user", systemPreamble.join("\n\n"));
    }
    return normalized.length > 0 ? normalized : messages;
  }
  async fetchWithTimeout(body, externalSignal) {
    const resolvedApiKey = this.config.apiKeyProvider ? await this.config.apiKeyProvider() : this.config.apiKey;
    const apiKey = resolvedApiKey?.trim() ?? "";
    if (!apiKey) throw new Error("OpenAI-compatible provider credential unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12e4);
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
  parseToolCalls(toolCalls) {
    return toolCalls.map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        args = { _rawArguments: tc.function?.arguments ?? "" };
      }
      return { id: tc.id, name: tc.function?.name ?? "unknown", arguments: args };
    });
  }
  async *parseStream(response) {
    const reader = response.body?.getReader();
    const resolvedModel = resolveOpenAIModelProfile(this.model);
    if (!reader) {
      yield { type: "done", finishReason: "end_turn", model: resolvedModel.requestedModel };
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let streamUsage;
    let streamModel = resolvedModel.requestedModel;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            yield {
              type: "done",
              finishReason: "end_turn",
              usage: streamUsage,
              model: streamModel
            };
            return;
          }
          try {
            const event = JSON.parse(data);
            if (event.model && !resolvedModel.reasoningEffort) streamModel = event.model;
            if (event.usage) {
              streamUsage = normalizeOpenAiCompatibleUsage(event.usage);
            }
            const choice = event.choices?.[0];
            const delta = choice?.delta;
            if (delta?.content) {
              yield { type: "text_delta", content: delta.content };
            }
            for (const toolCall of delta?.tool_calls || []) {
              yield {
                type: "tool_call_delta",
                toolCall: {
                  index: toolCall.index,
                  id: toolCall.id,
                  name: toolCall.function?.name,
                  arguments: toolCall.function?.arguments
                }
              };
            }
          } catch {
          }
        }
      }
    } finally {
      reader.cancel().catch((cancelErr) => {
        console.debug(
          `[openai-provider] stream reader cancel failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
        );
      });
    }
    yield {
      type: "done",
      finishReason: "end_turn",
      usage: streamUsage,
      model: streamModel
    };
  }
};

// src/providers/codex-api-provider.ts
var CodexApiProvider = class _CodexApiProvider extends BaseProvider {
  name = "codex";
  config;
  static RETRYABLE_STATUS_CODES = /* @__PURE__ */ new Set([500, 502, 503, 504]);
  static TRANSIENT_RETRY_DELAY_MS = 300;
  constructor(config, sanitizer) {
    super(sanitizer);
    this.config = config;
  }
  get model() {
    return this.config.model || "gpt-5.4";
  }
  async chat(messages, tools, opts) {
    const sanitized = this.sanitizeMessages(messages);
    return this.doChat(sanitized, tools, true, opts?.signal);
  }
  async *chatStream(messages, tools, opts) {
    const sanitized = this.sanitizeMessages(messages);
    const token = await this.config.tokenManager.getAccessToken();
    const body = this.buildRequestBody(sanitized, tools);
    const request = this.createRequestController(opts?.signal);
    try {
      const response = await this.fetchWithRetry(token, body, request.signal);
      if (!response.ok) {
        if (response.status === 401) {
          const freshToken = await this.config.tokenManager.forceRefresh();
          const retryResponse = await this.fetchWithRetry(freshToken, body, request.signal);
          if (!retryResponse.ok) {
            const errText2 = await retryResponse.text().catch(() => "");
            throw new Error(`Codex API error: ${retryResponse.status} ${retryResponse.statusText}${errText2 ? ` - ${errText2}` : ""}`);
          }
          yield* this.parseStream(retryResponse);
          return;
        }
        const errText = await response.text().catch(() => "");
        throw new Error(`Codex API error: ${response.status} ${response.statusText}${errText ? ` - ${errText}` : ""}`);
      }
      yield* this.parseStream(response);
    } finally {
      request.cleanup();
    }
  }
  async doChat(messages, tools, allowRetry, signal) {
    let content = "";
    const toolCalls = [];
    let usage = { promptTokens: 0, completionTokens: 0 };
    let model = this.model;
    const pendingCalls = /* @__PURE__ */ new Map();
    for await (const chunk of this.chatStream(messages, tools, signal ? { signal } : void 0)) {
      if (chunk.type === "text_delta") {
        content += chunk.content;
      } else if (chunk.type === "tool_call_delta" && chunk.toolCall) {
        const tc = chunk.toolCall;
        if (tc.id && tc.name) {
          let args = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            args = { _rawArguments: tc.arguments };
          }
          toolCalls.push({ id: tc.id, name: tc.name, arguments: args });
        }
      } else if (chunk.type === "done") {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) model = chunk.model;
      }
    }
    return { content, toolCalls, usage, model };
  }
  /**
   * Build a Responses API request body.
   *
   * The ChatGPT backend endpoint accepts:
   *   - `model`, `input` (array of items), `instructions`, `tools`, `stream`
   *
   * It rejects:
   *   - `max_tokens`, `max_output_tokens`, `max_completion_tokens`, `metadata`, `messages`
   */
  buildRequestBody(messages, tools) {
    const resolvedModel = resolveOpenAIModelProfile(this.model);
    let instructions;
    const input = [];
    for (const m of messages) {
      if (m.role === "system") {
        instructions = instructions ? `${instructions}

${m.content}` : m.content;
        continue;
      }
      if (m.role === "tool" && m.toolCallId) {
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content
        });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: m.content
          });
        }
        for (const toolCall of m.toolCalls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments)
          });
        }
        continue;
      }
      input.push({
        type: "message",
        role: m.role,
        content: m.content
      });
    }
    const body = {
      model: resolvedModel.apiModel,
      input
    };
    body.instructions = instructions || "You are a helpful assistant.";
    body.store = false;
    body.stream = true;
    if (resolvedModel.reasoningEffort) {
      body.reasoning = { effort: resolvedModel.reasoningEffort };
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }));
    }
    return body;
  }
  createRequestController(externalSignal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12e4);
    const onAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", onAbort);
      }
    };
  }
  async fetchWithTimeout(token, body, signal) {
    return fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  }
  async fetchWithRetry(token, body, signal) {
    let response = await this.fetchWithTimeout(token, body, signal);
    if (response.ok || !_CodexApiProvider.RETRYABLE_STATUS_CODES.has(response.status) || signal.aborted) {
      return response;
    }
    await this.delay(_CodexApiProvider.TRANSIENT_RETRY_DELAY_MS, signal);
    response = await this.fetchWithTimeout(token, body, signal);
    return response;
  }
  async delay(ms, signal) {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("This operation was aborted");
    }
    await new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve2();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new Error("This operation was aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  /**
   * Parse a streaming Responses API response.
   *
   * The Responses API emits SSE events like:
   *   - `response.output_item.added`
   *   - `response.output_text.delta`  (content text)
   *   - `response.function_call_arguments.delta`  (tool call args)
   *   - `response.completed`
   */
  async *parseStream(response) {
    const reader = response.body?.getReader();
    const resolvedModel = resolveOpenAIModelProfile(this.model);
    if (!reader) {
      yield { type: "done", finishReason: "end_turn", model: resolvedModel.requestedModel };
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let streamUsage;
    let streamModel = resolvedModel.requestedModel;
    const pendingToolCalls = /* @__PURE__ */ new Map();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            const eventType = event.type;
            if (event.model && !resolvedModel.reasoningEffort) {
              streamModel = event.model;
            }
            if (eventType === "response.output_text.delta") {
              const delta = event.delta;
              if (delta) {
                yield { type: "text_delta", content: delta };
              }
            }
            if (eventType === "response.output_item.added") {
              const item = event.item;
              if (item?.type === "function_call") {
                const callId = item.call_id || item.id || "";
                const itemId = item.id || "";
                const entry = {
                  // The emitted id must be the call_id — buildRequestBody
                  // round-trips it as function_call_output.call_id next turn.
                  id: callId,
                  name: item.name || "",
                  arguments: "",
                  emitted: false
                };
                if (callId) pendingToolCalls.set(callId, entry);
                if (itemId && itemId !== callId) pendingToolCalls.set(itemId, entry);
              }
            }
            if (eventType === "response.function_call_arguments.delta") {
              const callId = event.item_id || event.call_id || "";
              const pending = pendingToolCalls.get(callId);
              if (pending) {
                pending.arguments += event.delta || "";
              }
            }
            if (eventType === "response.function_call_arguments.done") {
              const key = event.item_id || event.call_id || "";
              const pending = pendingToolCalls.get(key);
              if (pending && !pending.emitted) {
                pending.emitted = true;
                const completeArgs = typeof event.arguments === "string" && event.arguments.length > 0 ? event.arguments : pending.arguments;
                yield {
                  type: "tool_call_delta",
                  toolCall: {
                    index: 0,
                    id: pending.id,
                    name: pending.name,
                    arguments: completeArgs
                  }
                };
              }
            }
            if (eventType === "response.output_item.done") {
              const item = event.item;
              if (item?.type === "function_call") {
                const callId = item.call_id || item.id || "";
                const pending = pendingToolCalls.get(callId) ?? pendingToolCalls.get(item.id || "");
                if ((callId || pending) && !pending?.emitted) {
                  if (pending) pending.emitted = true;
                  const args = typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : pending?.arguments ?? "";
                  yield {
                    type: "tool_call_delta",
                    toolCall: {
                      index: 0,
                      id: callId || pending?.id || "",
                      name: item.name || pending?.name || "",
                      arguments: args
                    }
                  };
                }
              }
            }
            if (eventType === "response.completed") {
              const resp = event.response;
              if (resp?.usage) {
                const u = resp.usage;
                streamUsage = {
                  promptTokens: u.input_tokens ?? 0,
                  completionTokens: u.output_tokens ?? 0
                };
              }
              if (resp?.model && !resolvedModel.reasoningEffort) {
                streamModel = resp.model;
              }
              yield {
                type: "done",
                finishReason: "end_turn",
                usage: streamUsage,
                model: streamModel
              };
              return;
            }
          } catch {
          }
        }
      }
    } finally {
      reader.cancel().catch((cancelErr) => {
        console.debug(
          `[codex-api-provider] stream reader cancel failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
        );
      });
    }
    yield {
      type: "done",
      finishReason: "end_turn",
      usage: streamUsage,
      model: streamModel
    };
  }
};

// src/providers/openai-session-provider.ts
var OpenAISessionProvider = class extends CodexApiProvider {
  name = "openai";
  constructor(config, sanitizer) {
    super(config, sanitizer);
  }
};

// src/providers/legacy-model-migration.ts
function splitProviderPrefix(modelName) {
  const delimiterIndex = modelName.indexOf(":");
  const providerPrefix = delimiterIndex === -1 ? "" : modelName.slice(0, delimiterIndex + 1);
  const bareModelName = delimiterIndex === -1 ? modelName : modelName.slice(delimiterIndex + 1);
  return { providerPrefix, bareModelName };
}
function migrateLegacyGpt54ModelName(modelName) {
  const { providerPrefix, bareModelName } = splitProviderPrefix(modelName);
  const migratedBareModelName = bareModelName.replace(/^gpt-5\.4-mini\b/i, "gpt-5.5-low").replace(/^gpt-5\.4-pro\b/i, "gpt-5.5-xhigh").replace(/^gpt-5\.4-high\b/i, "gpt-5.5-high").replace(/^gpt-5\.4-medium\b/i, "gpt-5.5-medium").replace(/^gpt-5\.4\b/i, "gpt-5.5");
  return `${providerPrefix}${migratedBareModelName}`;
}
function legacyGpt54ModelNameForGpt55(modelName) {
  const { providerPrefix, bareModelName } = splitProviderPrefix(modelName);
  const legacyBareModelName = bareModelName.replace(/^gpt-5\.5-low\b/i, "gpt-5.4-mini").replace(/^gpt-5\.5-xhigh\b/i, "gpt-5.4-pro").replace(/^gpt-5\.5-high\b/i, "gpt-5.4-high").replace(/^gpt-5\.5-medium\b/i, "gpt-5.4-medium").replace(/^gpt-5\.5\b/i, "gpt-5.4");
  return `${providerPrefix}${legacyBareModelName}`;
}
function migrateLegacyGpt54ModelNameOrNull(modelName) {
  if (modelName == null || modelName === "") return modelName ?? null;
  return migrateLegacyGpt54ModelName(modelName);
}

// src/providers/health-backoff-policy.ts
var HEALTH_WINDOW_MS = 5 * 6e4;
var HARD_FAILURE_THRESHOLD = 3;
var HARD_FAILURE_BASE_MS = 2 * 6e4;
var HARD_FAILURE_MAX_MS = 30 * 6e4;
var RATE_LIMIT_BASE_MS = 6e4;
var RATE_LIMIT_MAX_MS = 30 * 6e4;
var TRANSIENT_SOFT_MS = 6e4;
var OVERLOADED_MS = 6e4;
var AUTH_BACKOFF_MS = 24 * 60 * 6e4;
var BILLING_DEFAULT_MS = 6 * 60 * 6e4;
var SUBSCRIPTION_WINDOW_BACKOFF_MS = 7 * 24 * 60 * 6e4;
var FREE_ROUTE_COOLDOWN_BASE_MS = 10 * 6e4;
var FREE_ROUTE_COOLDOWN_MAX_MS = 2 * 60 * 6e4;
var FREE_ROUTE_CANARY_SUCCESSES = 5;
var FREE_ROUTE_CANARY_MAX_RESETS = 2;
var FREE_ROUTE_TRIP_CONSECUTIVE_FAILURES = 3;
var FREE_ROUTE_RATE_LIMIT_BURST_COUNT = 3;
var FREE_ROUTE_RATE_LIMIT_BURST_WINDOW_MS = RATE_LIMIT_BASE_MS;
function computeRateLimitBackoffMs(rateLimitCount) {
  const n = Math.max(1, Math.floor(rateLimitCount));
  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** (n - 1));
}
function computeHardFailureBackoffMs(consecutiveFailures) {
  const n = Math.floor(consecutiveFailures);
  if (n < HARD_FAILURE_THRESHOLD) return 0;
  const stepsPast = n - HARD_FAILURE_THRESHOLD;
  return Math.min(HARD_FAILURE_MAX_MS, HARD_FAILURE_BASE_MS * 2 ** stepsPast);
}
function computeAuthBillingBackoffMs(reason) {
  return reason === "auth" ? AUTH_BACKOFF_MS : BILLING_DEFAULT_MS;
}
function shouldLogRateLimitWarn(prevCount, nextCount) {
  return prevCount === 0 || nextCount % 5 === 0;
}

// src/providers/model-health-registry.ts
var log = createLogger({ module: "model-health-registry" });
var RATE_LIMIT_WINDOW_MS = RATE_LIMIT_BASE_MS;
function emptySnapshot(key) {
  return {
    key,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    windowFailureCount: 0,
    backoffUntil: 0,
    lastReason: null,
    rateLimitCount: 0,
    rateLimitWindowStart: null,
    failureTimestamps: []
  };
}
var ModelHealthRegistry = class {
  state = /* @__PURE__ */ new Map();
  getSnapshot(key) {
    const s = this.state.get(key) ?? emptySnapshot(key);
    const failureTimestamps = [...s.failureTimestamps];
    return {
      ...s,
      failureTimestamps,
      windowFailureCount: failureTimestamps.length
    };
  }
  getModelHealthEntry(key) {
    const s = this.state.get(key);
    if (!s) return void 0;
    return {
      failureTimestamps: [...s.failureTimestamps],
      backoffUntil: s.backoffUntil,
      rateLimitCount: s.rateLimitCount
    };
  }
  isAvailable(key, now = Date.now()) {
    const s = this.state.get(key);
    if (!s) return true;
    return now >= s.backoffUntil;
  }
  backoffRemainingMs(key, now = Date.now()) {
    const s = this.state.get(key);
    if (!s || now >= s.backoffUntil) return 0;
    return s.backoffUntil - now;
  }
  recordSuccess(key, now = Date.now()) {
    const next = {
      ...emptySnapshot(key),
      lastSuccessAt: now
    };
    this.state.set(key, next);
    return this.getSnapshot(key);
  }
  /**
   * ModelRouter-shaped outcome recording (success / hard fail / rate-limit).
   */
  recordOutcome(key, success, rateLimited = false, now = Date.now(), opts = {}) {
    if (success) return this.recordSuccess(key, now);
    return this.recordFailure(key, {
      now,
      rateLimited,
      reason: rateLimited ? "rate_limit" : "hard",
      logLabel: opts.logLabel,
      warn: opts.warn
    });
  }
  recordFailure(key, opts = {}) {
    const now = opts.now ?? Date.now();
    const prev = this.state.get(key) ?? emptySnapshot(key);
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const failureTimestamps = prev.failureTimestamps.filter((t) => now - t < HEALTH_WINDOW_MS).concat(now);
    let rateLimitCount = prev.rateLimitCount;
    let rateLimitWindowStart = prev.rateLimitWindowStart;
    let backoffMs;
    if (opts.rateLimited) {
      if (rateLimitWindowStart == null || now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitWindowStart = now;
        rateLimitCount = 1;
      } else {
        rateLimitCount += 1;
      }
      const prevCount = rateLimitCount - 1;
      if (opts.baseBackoffMs != null || opts.maxBackoffMs != null) {
        const base = opts.baseBackoffMs ?? RATE_LIMIT_BASE_MS;
        const max = opts.maxBackoffMs ?? RATE_LIMIT_MAX_MS;
        backoffMs = Math.min(max, base * 2 ** Math.max(0, rateLimitCount - 1));
      } else {
        backoffMs = computeRateLimitBackoffMs(rateLimitCount);
      }
      if (opts.warn !== false && shouldLogRateLimitWarn(prevCount, rateLimitCount)) {
        const label = opts.logLabel ?? key;
        log.warn(
          `[model-health] Rate limit #${rateLimitCount} on ${label}, backoff=${Math.round(backoffMs / 1e3)}s`
        );
      }
    } else if (opts.baseBackoffMs != null) {
      const max = opts.maxBackoffMs ?? HARD_FAILURE_MAX_MS;
      backoffMs = Math.min(
        max,
        opts.baseBackoffMs * 2 ** Math.max(0, consecutiveFailures - 1)
      );
    } else {
      const windowCount = failureTimestamps.length;
      backoffMs = computeHardFailureBackoffMs(windowCount);
      if (opts.maxBackoffMs != null && backoffMs > 0) {
        backoffMs = Math.min(opts.maxBackoffMs, backoffMs);
      }
      if (backoffMs > 0 && opts.warn !== false) {
        const label = opts.logLabel ?? key;
        log.warn(
          `[model-health] ${label} hit ${windowCount} failures in ${HEALTH_WINDOW_MS / 6e4}min window, entering ${Math.round(backoffMs / 1e3)}s backoff`
        );
      }
    }
    const next = {
      ...prev,
      key,
      lastFailureAt: now,
      consecutiveFailures,
      windowFailureCount: failureTimestamps.length,
      backoffUntil: backoffMs > 0 ? now + backoffMs : prev.backoffUntil > now ? prev.backoffUntil : 0,
      lastReason: opts.reason ?? prev.lastReason,
      rateLimitCount,
      rateLimitWindowStart,
      failureTimestamps
    };
    this.state.set(key, next);
    return this.getSnapshot(key);
  }
  /**
   * Dual-write bridge for specialty planes that already computed absolute expiry.
   */
  setBackoff(key, backoffUntil, opts = {}) {
    const now = opts.now ?? Date.now();
    const prev = this.state.get(key) ?? emptySnapshot(key);
    let rateLimitCount = prev.rateLimitCount;
    let rateLimitWindowStart = prev.rateLimitWindowStart;
    if (opts.rateLimited) {
      if (rateLimitWindowStart == null || now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitWindowStart = now;
        rateLimitCount = 1;
      } else {
        rateLimitCount += 1;
      }
    }
    const consecutive = opts.consecutiveFailures ?? Math.max(1, prev.consecutiveFailures);
    const next = {
      ...prev,
      key,
      lastFailureAt: now,
      consecutiveFailures: consecutive,
      windowFailureCount: Math.max(prev.windowFailureCount, consecutive),
      backoffUntil: Math.max(0, backoffUntil),
      lastReason: opts.reason !== void 0 ? opts.reason : prev.lastReason,
      rateLimitCount,
      rateLimitWindowStart
    };
    this.state.set(key, next);
    return this.getSnapshot(key);
  }
  reset(key) {
    this.state.delete(key);
  }
  resetAll() {
    this.state.clear();
  }
  listUnavailable(now = Date.now()) {
    const out = [];
    for (const [k, s] of this.state) {
      if (now < s.backoffUntil) out.push(k);
    }
    return out.sort();
  }
  dump(_now = Date.now()) {
    return [...this.state.values()].map((s) => this.getSnapshot(s.key)).sort((a, b) => a.key.localeCompare(b.key));
  }
};
var defaultRegistry = null;
function getDefaultModelHealthRegistry() {
  if (!defaultRegistry) defaultRegistry = new ModelHealthRegistry();
  return defaultRegistry;
}

// src/providers/model-router.ts
var log2 = createLogger({ module: "model-router" });
var HIGH_RISK_TASK_TYPES = /* @__PURE__ */ new Set([
  "coding",
  "codereview",
  "toolcaller",
  "superdebug"
]);
var TimedProviderProxy = class {
  constructor(inner, collector) {
    this.inner = inner;
    this.collector = collector;
  }
  inner;
  collector;
  get name() {
    return this.inner.name;
  }
  get modelKey() {
    return this.inner.modelKey;
  }
  set modelKey(value) {
    this.inner.modelKey = value;
  }
  get tier() {
    return this.inner.tier;
  }
  set tier(value) {
    this.inner.tier = value;
  }
  get billingMode() {
    return this.inner.billingMode;
  }
  set billingMode(value) {
    this.inner.billingMode = value;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  set capabilities(value) {
    this.inner.capabilities = value;
  }
  get pricing() {
    return this.inner.pricing;
  }
  set pricing(value) {
    this.inner.pricing = value;
  }
  get contextSize() {
    return this.inner.contextSize;
  }
  set contextSize(value) {
    this.inner.contextSize = value;
  }
  async chat(messages, tools) {
    const start = Date.now();
    try {
      return await this.inner.chat(messages, tools);
    } finally {
      this.collector.recordLLM(this.inner.name, Date.now() - start);
    }
  }
  embed(text) {
    if (!this.inner.embed) {
      return Promise.reject(new Error(`${this.inner.name} does not support embed()`));
    }
    return this.inner.embed(text);
  }
  chatStream(messages, tools) {
    if (!this.inner.chatStream) {
      throw new Error(`${this.inner.name} does not support chatStream()`);
    }
    return this.inner.chatStream(messages, tools);
  }
  warmup() {
    if (!this.inner.warmup) {
      return Promise.reject(new Error(`${this.inner.name} does not support warmup()`));
    }
    return this.inner.warmup();
  }
  getMetrics() {
    if (!this.inner.getMetrics) {
      return {};
    }
    return this.inner.getMetrics();
  }
};
var ModelRouter = class _ModelRouter {
  providers;
  routing;
  aliasMap = /* @__PURE__ */ new Map();
  perfCollector = null;
  proxyCache = /* @__PURE__ */ new WeakMap();
  /** Model-level health/backoff — sole source of truth (LE-W1.1). */
  healthRegistry;
  // Selection log — ring buffer of recent routing decisions
  selectionLog = [];
  static MAX_SELECTION_LOG = 50;
  // Per-(model, reason) warn dedup. Stale tracer rows + persisted hints
  // can hammer the same not-found warning thousands of times per hour.
  warnedModels = /* @__PURE__ */ new Set();
  static MAX_WARN = 500;
  /** Add a key to the warn-dedup Set with FIFO eviction capped at MAX_WARN. */
  cappedWarnAdd(key) {
    if (this.warnedModels.has(key)) return;
    if (this.warnedModels.size >= _ModelRouter.MAX_WARN) {
      const oldest = this.warnedModels.values().next().value;
      if (oldest !== void 0) this.warnedModels.delete(oldest);
    }
    this.warnedModels.add(key);
  }
  isModelAvailable = null;
  constructor(config) {
    this.providers = config.providers;
    this.routing = config.routing;
    this.isModelAvailable = config.isModelAvailable ?? null;
    this.healthRegistry = config.healthRegistry ?? new ModelHealthRegistry();
    for (const [alias, target] of Object.entries(config.routing.aliases ?? {})) {
      if (!alias || !target) continue;
      this.aliasMap.set(alias, target);
    }
  }
  /** Health registry (tests / health export / shared wiring). */
  getHealthRegistry() {
    return this.healthRegistry;
  }
  setPerfCollector(collector) {
    this.perfCollector = collector;
  }
  setAvailabilityFilter(filter) {
    this.isModelAvailable = filter;
  }
  isRoutingAllowed(modelKey) {
    if (!this.isModelAvailable) return true;
    return this.isModelAvailable(modelKey);
  }
  // ---------------------------------------------------------------------------
  // Health tracking (public — callers report outcomes)
  // ---------------------------------------------------------------------------
  /**
   * Report the outcome of a model invocation.
   * Delegates entirely to ModelHealthRegistry (policy ladders shared).
   * A single success resets all failure state for that model.
   */
  recordModelOutcome(modelName, success, rateLimited = false) {
    const key = this.resolveAlias(modelName);
    this.perfCollector?.recordRoutingOutcome(key, success, rateLimited);
    this.healthRegistry.recordOutcome(key, success, rateLimited, Date.now(), {
      logLabel: modelName
    });
  }
  /** Returns true when a model has no active backoff. Unknown models are assumed healthy. */
  isModelHealthy(modelName) {
    return this.healthRegistry.isAvailable(this.resolveAlias(modelName));
  }
  /** Get the raw health entry for inspection (e.g. for status APIs). */
  getModelHealth(modelName) {
    return this.healthRegistry.getModelHealthEntry(this.resolveAlias(modelName));
  }
  // ---------------------------------------------------------------------------
  // Selection log (public)
  // ---------------------------------------------------------------------------
  /** Get last N routing decisions (newest-first). */
  getSelectionLog(limit = 50) {
    return this.selectionLog.slice(-limit).reverse();
  }
  logSelection(model, zone, taskType, reason) {
    this.selectionLog.push({ model, zone, taskType, reason, timestamp: Date.now() });
    if (this.selectionLog.length > _ModelRouter.MAX_SELECTION_LOG) {
      this.selectionLog.shift();
    }
  }
  // ---------------------------------------------------------------------------
  // Alias resolution
  // ---------------------------------------------------------------------------
  resolveAlias(modelName) {
    const startName = this.providers.has(modelName) ? modelName : migrateLegacyGpt54ModelName(modelName);
    let current = startName;
    const seen = /* @__PURE__ */ new Set();
    while (this.aliasMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliasMap.get(current);
    }
    return current;
  }
  findProvider(modelName) {
    const resolvedName = this.resolveAlias(modelName);
    const direct = this.providers.get(resolvedName);
    if (direct) return direct;
    const colonIndex = resolvedName.indexOf(":");
    if (colonIndex === -1) return void 0;
    return this.providers.get(resolvedName.slice(colonIndex + 1));
  }
  resolveProviderHint(providerHint, zone, taskType) {
    const preferredModel = this.resolveConfiguredModel(zone, taskType);
    if (preferredModel) {
      const preferredWithProvider = `${providerHint}:${this.resolveAlias(preferredModel).split(":").pop()}`;
      if (this.providers.has(preferredWithProvider)) {
        return preferredWithProvider;
      }
    }
    return Array.from(this.providers.keys()).find((key) => key.startsWith(`${providerHint}:`));
  }
  resolveConfiguredModel(zone, taskType) {
    if (taskType === "chat" && (this.routing.chat || this.routing.default)) return this.routing.chat ?? this.routing.default;
    if (taskType === "agent" && this.routing.agent) return this.routing.agent;
    if (taskType === "background" && this.routing.background) return this.routing.background;
    if (taskType === "coding" && this.routing.coding) return this.routing.coding;
    if (taskType === "opus" && this.routing.opus) return this.routing.opus;
    if (taskType === "deep" && this.routing.deep) return this.routing.deep;
    if (taskType === "deeper" && this.routing.deeper) return this.routing.deeper;
    if (taskType === "superdebug" && this.routing.superdebug) return this.routing.superdebug;
    if (taskType === "fast" && this.routing.fast) return this.routing.fast;
    if (taskType === "toolcaller" && this.routing.toolcaller) return this.routing.toolcaller;
    if (taskType === "codereview" && this.routing.codereview) return this.routing.codereview;
    if (taskType === "introspection") return this.routing.introspection ?? this.routing.deep ?? this.routing.default;
    return this.routing[zone] || this.routing.default;
  }
  isHighRiskRoutingContext(zone, taskType) {
    return zone === "trusted" || (taskType ? HIGH_RISK_TASK_TYPES.has(taskType) : false);
  }
  modelFamily(modelName) {
    const resolved = this.resolveAlias(modelName);
    const colonIndex = resolved.indexOf(":");
    if (colonIndex > 0) return resolved.slice(0, colonIndex);
    const slashIndex = resolved.indexOf("/");
    if (slashIndex > 0) return resolved.slice(0, slashIndex);
    return void 0;
  }
  isSafeFallbackCandidate(candidateModel, candidateProvider, requestedModel, requestedProvider, zone, taskType) {
    if (!this.isHighRiskRoutingContext(zone, taskType)) return true;
    if (taskType === "toolcaller" && candidateProvider.capabilities?.supportsNativeTools !== true) {
      return false;
    }
    if (requestedProvider) {
      if (candidateProvider.name === requestedProvider.name) return true;
      if (candidateProvider.tier && requestedProvider.tier && candidateProvider.tier === requestedProvider.tier) {
        return true;
      }
      if (candidateProvider.capabilities?.supportsNativeTools === true && requestedProvider.capabilities?.supportsNativeTools === true) {
        return true;
      }
    }
    const requestedFamily = this.modelFamily(requestedModel);
    const candidateFamily = this.modelFamily(candidateModel);
    return Boolean(requestedFamily && candidateFamily && requestedFamily === candidateFamily);
  }
  // ---------------------------------------------------------------------------
  // Healthy alternative finder
  // ---------------------------------------------------------------------------
  /**
   * Find an alternative healthy model when the primary is in backoff.
   * Tries routing config models in priority order before any registered provider.
   */
  findHealthyAlternative(zone, taskType, excludeModel, requestedProvider) {
    const results = this.findHealthyAlternatives(
      zone,
      taskType,
      excludeModel,
      /* @__PURE__ */ new Set([excludeModel]),
      requestedProvider,
      1
    );
    return results[0] ?? null;
  }
  /**
   * Multi-candidate form of findHealthyAlternative: returns up to `limit`
   * distinct healthy alternatives, skipping every model in `excludeModels`.
   * `primaryModel` is the reference model for the free→free cascade rule and
   * the safe-fallback family check (same semantics as the single-result form).
   */
  findHealthyAlternatives(zone, taskType, primaryModel, excludeModels, requestedProvider, limit) {
    const results = [];
    const taken = new Set(excludeModels);
    const primaryIsFree = isFreeRouteModel(primaryModel);
    const consider = (resolved, provider) => {
      if (results.length >= limit) return;
      if (!provider) return;
      if (taken.has(resolved)) return;
      if (primaryIsFree && isFreeRouteModel(resolved)) return;
      if (!this.isRoutingAllowed(resolved)) return;
      if (!this.isModelHealthy(resolved)) return;
      if (!this.isSafeFallbackCandidate(resolved, provider, primaryModel, requestedProvider, zone, taskType)) {
        return;
      }
      taken.add(resolved);
      results.push({ provider, modelName: resolved });
    };
    const chain = Array.isArray(this.routing.fallbackChain) ? this.routing.fallbackChain : [];
    const candidates = [
      ...chain,
      this.routing.default,
      this.routing[zone],
      this.routing.background,
      this.routing.agent,
      this.routing.chat,
      this.routing.deep,
      this.routing.coding,
      this.routing.opus
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const resolved = this.resolveAlias(candidate);
      consider(resolved, this.findProvider(resolved));
    }
    for (const [modelName, provider] of this.providers) {
      consider(this.resolveAlias(modelName), provider);
    }
    return results;
  }
  /**
   * Ordered provider chain for retry-with-fallback consumers — background
   * pipelines that must survive a runtime provider failure (e.g. memory
   * consolidation dying overnight on a billing-disabled provider, Jun 2026).
   *
   * Element 0 is exactly what getProvider() would return; subsequent
   * elements are distinct healthy alternatives in routing-priority order.
   * All entries are timing-wrapped and modelKey-stamped like getProvider
   * results. Callers should walk the array, trying each provider until one
   * succeeds. Routing-level failures (nothing configured/registered) yield
   * an empty array rather than a throw.
   */
  getProviderChain(zone, taskType, maxProviders = 3) {
    const chainOut = [];
    const seen = /* @__PURE__ */ new Set();
    let primaryModel;
    try {
      const primary = this.getProvider(zone, taskType);
      chainOut.push(primary);
      primaryModel = primary.modelKey ? this.resolveAlias(primary.modelKey) : void 0;
      if (primaryModel) seen.add(primaryModel);
    } catch {
    }
    if (chainOut.length >= maxProviders) return chainOut;
    const reference = primaryModel ?? "";
    const requestedProvider = primaryModel ? this.findProvider(primaryModel) : void 0;
    const alternatives = this.findHealthyAlternatives(
      zone,
      taskType,
      reference,
      seen,
      requestedProvider,
      maxProviders - chainOut.length
    );
    for (const alt of alternatives) {
      alt.provider.modelKey = alt.modelName;
      this.logSelection(alt.modelName, zone, taskType, "chain-fallback");
      chainOut.push(this.wrapWithTiming(alt.provider));
    }
    return chainOut;
  }
  // ---------------------------------------------------------------------------
  // Core routing — public
  // ---------------------------------------------------------------------------
  /**
   * Get the provider for a zone and optional task type.
   *
   * When the configured model is in backoff (too many recent failures or 429s),
   * automatically reroutes to the best available healthy alternative.
   * All routing decisions are recorded in the selection log for debugging.
   */
  getProvider(zone, taskType, routeHint) {
    let modelName;
    let hintResolved = false;
    if (routeHint?.alias) {
      modelName = this.resolveAlias(routeHint.alias);
      hintResolved = Boolean(modelName);
    } else if (routeHint?.model) {
      modelName = this.resolveAlias(routeHint.model);
      hintResolved = Boolean(modelName);
    } else if (routeHint?.provider) {
      modelName = this.resolveProviderHint(routeHint.provider, zone, taskType);
      hintResolved = Boolean(modelName);
    }
    if (!modelName) {
      modelName = this.resolveConfiguredModel(zone, taskType);
    }
    if (!modelName) {
      throw new Error(`No model configured for zone "${zone}" and no default set`);
    }
    const resolvedModelName = this.resolveAlias(modelName);
    const requestedProvider = this.findProvider(resolvedModelName);
    if (!this.isRoutingAllowed(resolvedModelName)) {
      const alternative = this.findHealthyAlternative(zone, taskType, resolvedModelName, requestedProvider);
      if (alternative) {
        log2.warn(
          `[model-router] ${resolvedModelName} disabled \u2192 rerouting to ${alternative.modelName} (zone=${zone}${taskType ? ` task=${taskType}` : ""})`
        );
        alternative.provider.modelKey = alternative.modelName;
        this.logSelection(alternative.modelName, zone, taskType, "availability-reroute");
        return this.wrapWithTiming(alternative.provider);
      }
      throw new Error(
        `Model "${resolvedModelName}" is disabled and no enabled fallback is available (zone=${zone}${taskType ? ` task=${taskType}` : ""})`
      );
    }
    const bypassBackoff = hintResolved && routeHint?.force === true;
    if (!this.isModelHealthy(resolvedModelName) && !bypassBackoff) {
      const alternative = this.findHealthyAlternative(zone, taskType, resolvedModelName, requestedProvider);
      if (alternative) {
        log2.warn(
          `[model-router] ${resolvedModelName} in backoff \u2192 rerouting to ${alternative.modelName} (zone=${zone}${taskType ? ` task=${taskType}` : ""})`
        );
        alternative.provider.modelKey = alternative.modelName;
        this.logSelection(alternative.modelName, zone, taskType, "health-reroute");
        return this.wrapWithTiming(alternative.provider);
      }
      if (this.isHighRiskRoutingContext(zone, taskType)) {
        throw new Error(
          `No safe healthy fallback provider for high-risk route "${resolvedModelName}" (zone=${zone}${taskType ? ` task=${taskType}` : ""})`
        );
      }
      log2.warn(`[model-router] ${resolvedModelName} in backoff, no healthy alternative \u2014 attempting anyway`);
    } else if (!this.isModelHealthy(resolvedModelName)) {
      log2.warn(`[model-router] ${resolvedModelName} in backoff but force-routed \u2014 attempting anyway`);
    }
    const provider = this.findProvider(resolvedModelName);
    if (provider) {
      provider.modelKey = resolvedModelName;
      this.logSelection(resolvedModelName, zone, taskType, "configured");
      return this.wrapWithTiming(provider);
    }
    for (const [candidateModel, candidateProvider] of this.providers) {
      if (!this.isRoutingAllowed(candidateModel)) continue;
      if (!this.isModelHealthy(candidateModel)) continue;
      if (!this.isSafeFallbackCandidate(candidateModel, candidateProvider, resolvedModelName, requestedProvider, zone, taskType)) {
        continue;
      }
      const warnKey = `not-found-fallback:${resolvedModelName}`;
      if (!this.warnedModels.has(warnKey)) {
        this.cappedWarnAdd(warnKey);
        log2.warn(
          `[model-router] Model "${resolvedModelName}" not found \u2014 falling back to "${candidateProvider.name}". Check routing config. (further occurrences suppressed)`
        );
      }
      candidateProvider.modelKey = candidateModel;
      this.logSelection(candidateModel, zone, taskType, "not-found-fallback");
      return this.wrapWithTiming(candidateProvider);
    }
    const first = this.providers.entries().next();
    if (!first.done) {
      if (this.isHighRiskRoutingContext(zone, taskType)) {
        throw new Error(
          `No safe fallback provider registered for high-risk route "${resolvedModelName}" (zone=${zone}${taskType ? ` task=${taskType}` : ""})`
        );
      }
      const [firstModel, firstProvider] = first.value;
      const warnKey = `last-resort:${resolvedModelName}`;
      if (!this.warnedModels.has(warnKey)) {
        this.cappedWarnAdd(warnKey);
        log2.warn(
          `[model-router] Model "${resolvedModelName}" not found, all providers unhealthy \u2014 using "${firstProvider.name}" as last resort. (further occurrences suppressed)`
        );
      }
      firstProvider.modelKey = firstModel;
      this.logSelection(firstProvider.name, zone, taskType, "last-resort");
      return this.wrapWithTiming(firstProvider);
    }
    throw new Error(`No provider registered for model "${resolvedModelName}"`);
  }
  getDefaultProvider() {
    const first = this.providers.values().next();
    return first.done ? null : this.wrapWithTiming(first.value);
  }
  wrapWithTiming(provider) {
    if (!this.perfCollector) return provider;
    let cached = this.proxyCache.get(provider);
    if (!cached) {
      cached = new TimedProviderProxy(provider, this.perfCollector);
      this.proxyCache.set(provider, cached);
    }
    return cached;
  }
  getEmbeddingProvider() {
    for (const [, provider] of this.providers) {
      if (provider.embed) {
        return provider;
      }
    }
    throw new Error("No embedding provider available");
  }
  getProviders() {
    return this.providers;
  }
  getRouting() {
    return this.routing;
  }
  listProviders() {
    return Array.from(this.providers.keys());
  }
  hasModel(modelName) {
    return !!this.findProvider(this.resolveAlias(modelName));
  }
  getProviderByName(modelName) {
    const resolvedModelName = this.resolveAlias(modelName);
    const provider = this.findProvider(resolvedModelName);
    if (provider) provider.modelKey = resolvedModelName;
    return provider;
  }
};

// src/providers/parse-text-tool-calls.ts
function looseJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
  }
  const fixed = s.replace(/([:,[]\s*)True\b/g, "$1true").replace(/([:,[]\s*)False\b/g, "$1false").replace(/([:,[]\s*)None\b/g, "$1null").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}
function jsonObjectCandidates(s) {
  const out = [];
  if (s.startsWith("{")) out.push(s);
  const start = s.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(s.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return [...new Set(out)];
}
function findUnregisteredTextToolName(content, tools) {
  if (!tools?.length) return null;
  const toolNames = new Set(tools.map((tool) => tool.name));
  const stripped = content.replace(/```[\w]*\n?/g, "").trim();
  for (const line of stripped.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex <= 0) continue;
    const name = line.slice(0, spaceIndex);
    const args = line.slice(spaceIndex + 1);
    if (!toolNames.has(name) && args.startsWith("{") && looseJsonParse(args)) return name;
  }
  for (const candidate of jsonObjectCandidates(stripped)) {
    const parsed = looseJsonParse(candidate);
    if (!parsed || typeof parsed !== "object") continue;
    const candidates = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [parsed];
    for (const raw of candidates) {
      const call = raw;
      if (!call || typeof call !== "object") continue;
      const name = call.name ?? call.function?.name;
      const args = call.parameters ?? call.arguments ?? call.function?.arguments;
      if (name && args !== void 0 && !toolNames.has(name)) return name;
    }
  }
  return null;
}
function parseTextToolCalls(content, tools) {
  const toolNames = new Set(tools?.map((t) => t.name) ?? []);
  const calls = [];
  const stripped = content.replace(/```[\w]*\n?/g, "").trim();
  const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx > 0) {
      const name = line.slice(0, spaceIdx);
      const argsStr = line.slice(spaceIdx + 1);
      if (toolNames.has(name) && argsStr.startsWith("{")) {
        const args = looseJsonParse(argsStr);
        if (args && typeof args === "object") {
          calls.push({ id: crypto.randomUUID(), name, arguments: args });
        }
      }
    }
  }
  if (calls.length > 0) return calls;
  for (const candidate of jsonObjectCandidates(stripped)) {
    const parsed = looseJsonParse(candidate);
    if (!parsed || typeof parsed !== "object") continue;
    const tcArray = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [parsed];
    for (const raw of tcArray) {
      const tc = raw;
      if (!tc || typeof tc !== "object") continue;
      const name = tc.name ?? tc.function?.name;
      const args = tc.parameters ?? tc.arguments ?? tc.function?.arguments ?? {};
      if (name && toolNames.has(name)) {
        calls.push({ id: crypto.randomUUID(), name, arguments: typeof args === "object" && args ? args : {} });
      }
    }
    if (calls.length > 0) return calls;
  }
  return calls;
}

// src/providers/ollama-provider.ts
var log3 = createLogger({ module: "ollama-provider" });
function categorizeOllamaError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (lower.includes("aborted") || lower.includes("timeout") || lower.includes("too slow") || lower.includes("idle for")) return "timeout";
  if (lower.includes("econnrefused") || lower.includes("fetch failed") || lower.includes("cannot connect")) return "connection_refused";
  if (lower.includes("not found") || lower.includes("pull it with")) return "model_not_found";
  if (lower.includes("context") && (lower.includes("overflow") || lower.includes("too long") || lower.includes("exceed"))) return "context_overflow";
  if (lower.includes("does not support tools")) return "tool_unsupported";
  return "unknown";
}
var OllamaProvider = class {
  name = "ollama";
  modelKey;
  tier;
  billingMode;
  capabilities;
  pricing;
  /** The specific model name (e.g., "qwen3.5-zaraa") for trace recording and budget tracking */
  modelName;
  /** Last error category for structured error tracking */
  lastErrorCategory = null;
  /** Exposed context window size so callers can budget tokens appropriately */
  contextSize;
  config;
  metrics = { totalRequests: 0, totalTokens: 0, totalResponseMs: 0, lastResponseMs: 0, errors: 0, timeouts: 0, fallbacks: 0 };
  cachedHeaders;
  cachedOptions;
  requestTimeoutMs;
  /** Cached compressed tools — keyed by a cheap fingerprint to avoid recomputing on every request */
  compressedToolsCache = null;
  constructor(config = {}) {
    this.config = {
      model: config.model || "llama3.2",
      baseUrl: config.baseUrl || "http://localhost:11434",
      embedModel: config.embedModel || config.model || "llama3.2",
      apiKey: config.apiKey,
      numCtx: config.numCtx,
      numGpu: config.numGpu,
      numThread: config.numThread,
      temperature: config.temperature,
      keepAlive: config.keepAlive,
      think: config.think,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      fallbackModel: config.fallbackModel,
      caveman: config.caveman
    };
    this.modelName = this.config.model;
    this.contextSize = config.numCtx ?? 8192;
    this.requestTimeoutMs = config.timeoutMs ?? this.autoDetectTimeout(this.config.model);
    const h = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      h["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    this.cachedHeaders = h;
    const opts = {};
    if (this.config.numCtx !== void 0) opts.num_ctx = this.config.numCtx;
    if (this.config.numGpu !== void 0) opts.num_gpu = this.config.numGpu;
    if (this.config.numThread !== void 0) opts.num_thread = this.config.numThread;
    if (this.config.temperature !== void 0) opts.temperature = this.config.temperature;
    if (this.config.maxOutputTokens !== void 0) opts.num_predict = this.config.maxOutputTokens;
    this.cachedOptions = opts;
  }
  getMetrics() {
    const avgResponseMs = this.metrics.totalRequests > 0 ? Math.round(this.metrics.totalResponseMs / this.metrics.totalRequests) : 0;
    const errorRate = this.metrics.totalRequests > 0 ? this.metrics.errors / this.metrics.totalRequests : 0;
    return {
      avgLatencyMs: avgResponseMs,
      totalCalls: this.metrics.totalRequests,
      errorRate,
      totalRequests: this.metrics.totalRequests,
      totalTokens: this.metrics.totalTokens,
      avgResponseMs,
      lastResponseMs: this.metrics.lastResponseMs,
      errors: this.metrics.errors
    };
  }
  async chat(messages, tools, opts) {
    const t0 = Date.now();
    const effectiveMessages = this.config.caveman ? applyCaveman(messages) : messages;
    const body = {
      model: this.config.model,
      messages: effectiveMessages.map((m) => ({
        role: m.role,
        content: m.content
      })),
      stream: false,
      // Always send think explicitly — Qwen 3.5 models default to thinking mode
      // which adds 30-40s of latency. Sending think=false suppresses this.
      // Empty-final retry forces think=false (harvest P1).
      think: opts?.emptyFinalRetried ? false : this.config.think ?? false,
      ...Object.keys(this.cachedOptions).length > 0 && { options: this.cachedOptions },
      ...this.config.keepAlive && { keep_alive: this.config.keepAlive }
    };
    if (tools?.length) {
      body.tools = this.compressTools(tools);
    }
    const timeoutMs = this.requestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: this.cachedHeaders,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onAbort);
      this.metrics.errors++;
      this.lastErrorCategory = categorizeOllamaError(err);
      if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed"))) {
        throw new Error(
          `Cannot connect to Ollama at ${this.config.baseUrl}. Is Ollama running? Start it with: ollama serve`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        const reason = opts?.signal?.reason;
        if (reason instanceof Error) {
          if (reason.name === "TimeoutError" || reason.message.startsWith("ETIMEDOUT:") || reason.message.includes("exceeded response SLA")) {
            throw reason;
          }
        }
        if (opts?.signal?.aborted) {
          throw err;
        }
        this.metrics.timeouts++;
        const timeoutMin = Math.round(timeoutMs / 6e4);
        if (this.config.fallbackModel && this.config.fallbackModel !== this.config.model) {
          log3.warn(`[ollama] Model "${this.config.model}" timed out after ${timeoutMin}min \u2014 retrying with fallback "${this.config.fallbackModel}"`);
          this.metrics.fallbacks++;
          const fallbackBody = { ...body, model: this.config.fallbackModel };
          const fbController = new AbortController();
          const fbTimeout = setTimeout(() => fbController.abort(), 3e5);
          const onFallbackAbort = () => fbController.abort();
          if (opts?.signal) {
            if (opts.signal.aborted) fbController.abort();
            else opts.signal.addEventListener("abort", onFallbackAbort, { once: true });
          }
          try {
            response = await fetch(`${this.config.baseUrl}/api/chat`, {
              method: "POST",
              headers: this.cachedHeaders,
              body: JSON.stringify(fallbackBody),
              signal: fbController.signal
            });
            clearTimeout(fbTimeout);
          } catch (fbErr) {
            clearTimeout(fbTimeout);
            opts?.signal?.removeEventListener("abort", onFallbackAbort);
            const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
            throw new Error(
              `Ollama request aborted after ${timeoutMin} minutes \u2014 model "${this.config.model}" is too slow. Fallback "${this.config.fallbackModel}" also failed: ${fbMsg}`
            );
          } finally {
            opts?.signal?.removeEventListener("abort", onFallbackAbort);
          }
        } else {
          throw new Error(
            `Ollama request aborted after ${timeoutMin} minutes \u2014 model "${this.config.model}" is too slow or stuck. Try a smaller model.`
          );
        }
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      if (response.status === 400 && tools?.length) {
        const errText = await response.text().catch(() => "");
        if (errText.includes("does not support tools")) {
          this.lastErrorCategory = "tool_unsupported";
          log3.debug(`[ollama] ${this.config.model} does not support tools \u2014 retrying without`);
          const noToolBody = { ...body };
          delete noToolBody.tools;
          const retryResp = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: "POST",
            headers: this.cachedHeaders,
            body: JSON.stringify(noToolBody)
          });
          if (retryResp.ok) {
            response = retryResp;
          } else {
            this.metrics.errors++;
            throw new Error(`Ollama API error: ${retryResp.status} ${retryResp.statusText}`);
          }
        } else {
          this.metrics.errors++;
          throw new Error(`Ollama API error: ${response.status} \u2014 ${errText.slice(0, 200)}`);
        }
      } else {
        this.metrics.errors++;
        if (response.status === 404) {
          throw new Error(
            `Model "${this.config.model}" not found. Pull it with: ollama pull ${this.config.model}`
          );
        }
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }
    }
    const data = await response.json();
    const elapsed = Date.now() - t0;
    const tokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);
    this.metrics.totalRequests++;
    this.metrics.totalTokens += tokens;
    this.metrics.totalResponseMs += elapsed;
    this.metrics.lastResponseMs = elapsed;
    const unavailableNativeTool = tools?.length ? data.message?.tool_calls?.find(
      (call) => !tools.some((tool) => tool.name === call.function.name)
    )?.function.name : null;
    const unavailableTool = unavailableNativeTool ?? findUnregisteredTextToolName(data.message?.content || "", tools);
    if (unavailableTool) {
      log3.debug(
        `[ollama] ${this.config.model} invented unavailable tool "${unavailableTool}" \u2014 retrying without tools`
      );
      const retry = await this.chat(messages, void 0, opts);
      return {
        ...retry,
        usage: {
          promptTokens: (data.prompt_eval_count || 0) + retry.usage.promptTokens,
          completionTokens: (data.eval_count || 0) + retry.usage.completionTokens
        }
      };
    }
    let toolCalls = (data.message?.tool_calls || []).filter((tc) => tc?.function?.name).map((tc) => ({
      id: crypto.randomUUID(),
      // Ollama doesn't provide IDs
      name: tc.function.name,
      arguments: this.repairToolArgs(tc.function.arguments)
    }));
    if (toolCalls.length === 0 && data.message?.content) {
      const textToolCalls = parseTextToolCalls(data.message.content, tools);
      if (textToolCalls.length > 0) {
        toolCalls = textToolCalls;
        data.message.content = "";
      }
    }
    let rawContent = data.message?.content || "";
    if (rawContent.includes("<think>")) {
      rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!rawContent && data.message?.content) rawContent = data.message.content;
    }
    const maxResponseChars = (this.contextSize || 8192) * 2;
    const content = rawContent.length > maxResponseChars ? rawContent.slice(0, maxResponseChars) + "\n[response truncated \u2014 exceeded context limit]" : rawContent;
    if (!content.trim() && toolCalls.length === 0 && !opts?.emptyFinalRetried) {
      log3.debug(
        `[ollama] empty final from ${this.config.model} \u2014 retrying once with think=false`
      );
      try {
        const retryBody = {
          ...body,
          think: false
        };
        const retryResp = await fetch(`${this.config.baseUrl}/api/chat`, {
          method: "POST",
          headers: this.cachedHeaders,
          body: JSON.stringify(retryBody),
          signal: opts?.signal
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          let retryRaw = retryData.message?.content || "";
          if (retryRaw.includes("<think>")) {
            retryRaw = retryRaw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
            if (!retryRaw && retryData.message?.content) {
              retryRaw = retryData.message.content;
            }
          }
          const retryContent = retryRaw.length > maxResponseChars ? retryRaw.slice(0, maxResponseChars) + "\n[response truncated \u2014 exceeded context limit]" : retryRaw;
          this.metrics.totalRequests++;
          this.metrics.totalTokens += (retryData.prompt_eval_count || 0) + (retryData.eval_count || 0);
          return {
            content: retryContent,
            toolCalls: [],
            usage: {
              promptTokens: (data.prompt_eval_count || 0) + (retryData.prompt_eval_count || 0),
              completionTokens: (data.eval_count || 0) + (retryData.eval_count || 0)
            },
            model: retryData.model || this.config.model
          };
        }
      } catch (err) {
        log3.debug(
          `[ollama] empty-final retry failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return {
      content,
      toolCalls,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0
      },
      model: data.model || this.config.model
    };
  }
  async *chatStream(messages, tools, opts) {
    const effectiveMessages = this.config.caveman ? applyCaveman(messages) : messages;
    const body = {
      model: this.config.model,
      messages: effectiveMessages.map((m) => ({
        role: m.role,
        content: m.content
      })),
      stream: true,
      think: this.config.think ?? false,
      ...Object.keys(this.cachedOptions).length > 0 && { options: this.cachedOptions },
      ...this.config.keepAlive && { keep_alive: this.config.keepAlive }
    };
    if (tools?.length) {
      body.tools = this.compressTools(tools);
    }
    const streamController = new AbortController();
    const onAbort = () => streamController.abort(opts?.signal?.reason);
    if (opts?.signal) {
      if (opts.signal.aborted) streamController.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const streamTimeout = setTimeout(() => {
      streamController.abort(new Error(`Ollama stream aborted after ${Math.round(this.requestTimeoutMs / 6e4)} minutes \u2014 model "${this.config.model}" is too slow or stuck. Try a smaller model.`));
    }, this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: this.cachedHeaders,
        body: JSON.stringify(body),
        signal: streamController.signal
      });
    } catch (err) {
      clearTimeout(streamTimeout);
      opts?.signal?.removeEventListener("abort", onAbort);
      if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed"))) {
        throw new Error(
          `Cannot connect to Ollama at ${this.config.baseUrl}. Is Ollama running? Start it with: ollama serve`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        const reason = streamController.signal.reason;
        if (reason instanceof Error) {
          if (opts?.signal?.aborted || reason.name === "TimeoutError" || reason.message.startsWith("ETIMEDOUT:")) {
            throw reason;
          }
        }
        if (opts?.signal?.aborted) {
          throw err;
        }
        if (this.config.fallbackModel && this.config.fallbackModel !== this.config.model) {
          const timeoutMin = Math.round(this.requestTimeoutMs / 6e4);
          log3.warn(`[ollama] Stream model "${this.config.model}" timed out after ${timeoutMin}min \u2014 retrying stream with fallback "${this.config.fallbackModel}"`);
          this.metrics.timeouts++;
          this.metrics.fallbacks++;
          const fallbackBody = { ...body, model: this.config.fallbackModel };
          const fbController = new AbortController();
          const fbTimeout = setTimeout(() => fbController.abort(), 3e5);
          try {
            response = await fetch(`${this.config.baseUrl}/api/chat`, {
              method: "POST",
              headers: this.cachedHeaders,
              body: JSON.stringify(fallbackBody),
              signal: fbController.signal
            });
            clearTimeout(fbTimeout);
          } catch (fbErr) {
            clearTimeout(fbTimeout);
            const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
            throw new Error(
              `Ollama stream aborted after ${timeoutMin} minutes \u2014 model "${this.config.model}" is too slow. Fallback "${this.config.fallbackModel}" also failed: ${fbMsg}`
            );
          }
        } else {
          const timeoutMin = Math.round(this.requestTimeoutMs / 6e4);
          throw new Error(
            `Ollama stream aborted after ${timeoutMin} minutes \u2014 model "${this.config.model}" is too slow or stuck. Try a smaller model.`
          );
        }
      } else {
        throw err;
      }
    }
    clearTimeout(streamTimeout);
    if (!response.ok) {
      if (response.status === 400 && tools?.length) {
        const errText = await response.text().catch(() => "");
        if (errText.includes("does not support tools")) {
          log3.debug(`[ollama] Stream: ${this.config.model} does not support tools \u2014 retrying without`);
          const noToolBody = { ...body };
          delete noToolBody.tools;
          response = await fetch(`${this.config.baseUrl}/api/chat`, {
            method: "POST",
            headers: this.cachedHeaders,
            body: JSON.stringify(noToolBody)
          });
          if (!response.ok) {
            throw new Error(`Ollama stream error: ${response.status} ${response.statusText}`);
          }
        } else {
          throw new Error(`Ollama stream error: ${response.status} \u2014 ${errText.slice(0, 200)}`);
        }
      } else {
        throw new Error(`Ollama stream error: ${response.status} ${response.statusText}`);
      }
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const IDLE_TIMEOUT_MS = this.adaptiveIdleTimeout();
    let idleHandle;
    const resetIdle = () => {
      if (idleHandle) clearTimeout(idleHandle);
      return new Promise((_, reject) => {
        idleHandle = setTimeout(
          () => reject(new Error(`Ollama stream idle for ${IDLE_TIMEOUT_MS / 1e3}s \u2014 model "${this.config.model}" may be stuck`)),
          IDLE_TIMEOUT_MS
        );
      });
    };
    let idlePromise = resetIdle();
    try {
      while (true) {
        let readResult;
        try {
          readResult = await Promise.race([reader.read(), idlePromise]);
        } catch (idleErr) {
          streamController.abort(idleErr);
          reader.cancel().catch(() => {
          });
          throw idleErr;
        }
        idlePromise = resetIdle();
        const { done, value } = readResult;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.done) {
              if (data.message?.tool_calls?.length) {
                for (let idx = 0; idx < data.message.tool_calls.length; idx++) {
                  const tc = data.message.tool_calls[idx];
                  yield {
                    type: "tool_call_delta",
                    toolCall: {
                      index: idx,
                      id: crypto.randomUUID(),
                      name: tc.function.name,
                      arguments: JSON.stringify(this.repairToolArgs(tc.function.arguments))
                    }
                  };
                }
              }
              yield {
                type: "done",
                finishReason: "end_turn",
                usage: {
                  promptTokens: data.prompt_eval_count || 0,
                  completionTokens: data.eval_count || 0
                },
                model: data.model || this.config.model
              };
            } else if (data.message?.tool_calls?.length) {
              for (let idx = 0; idx < data.message.tool_calls.length; idx++) {
                const tc = data.message.tool_calls[idx];
                yield {
                  type: "tool_call_delta",
                  toolCall: {
                    index: idx,
                    id: crypto.randomUUID(),
                    name: tc.function.name,
                    arguments: JSON.stringify(this.repairToolArgs(tc.function.arguments))
                  }
                };
              }
            } else if (data.message?.content) {
              yield { type: "text_delta", content: data.message.content };
            }
          } catch (err) {
            log3.debug(`[ollama] malformed stream JSON line: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      if (idleHandle) clearTimeout(idleHandle);
      await reader.cancel().catch(() => {
      });
      streamController.abort();
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
  /**
   * Warm the model into GPU/memory by sending a minimal request.
   * Prevents cold-start timeouts on the first real request.
   * Non-throwing — logs warnings but never blocks startup.
   */
  async warmup() {
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6e4);
      const res = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: this.cachedHeaders,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          options: { num_predict: 1, ...this.cachedOptions },
          // Generate 1 token — just load the model
          keep_alive: this.config.keepAlive || "30m"
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        log3.warn(`[ollama] Warmup for "${this.config.model}" failed: HTTP ${res.status} (${latencyMs}ms)`);
        return { ok: false, ms: latencyMs, latencyMs };
      }
      await res.json();
      log3.info(`[ollama] Model "${this.config.model}" warmed up in ${latencyMs}ms`);
      return { ok: true, ms: latencyMs, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      log3.warn(`[ollama] Warmup for "${this.config.model}" failed: ${err instanceof Error ? err.message : err} (${latencyMs}ms)`);
      return { ok: false, ms: latencyMs, latencyMs };
    }
  }
  async healthCheck() {
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5e3);
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
        headers: this.cachedHeaders,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, error: `HTTP ${res.status}` };
      const data = await res.json();
      const modelLoaded = data.models?.some((m) => m.name === this.config.model || m.name.startsWith(this.config.model + ":"));
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        ...!modelLoaded && { error: `Model "${this.config.model}" not loaded. Pull with: ollama pull ${this.config.model}` }
      };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
  async embed(text) {
    const maxChars = 8e3;
    const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6e4);
    let response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/embed`, {
        method: "POST",
        headers: this.cachedHeaders,
        body: JSON.stringify({
          model: this.config.embedModel,
          input: truncatedText
        }),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      this.metrics.errors++;
      if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed"))) {
        throw new Error(
          `Cannot connect to Ollama at ${this.config.baseUrl} for embeddings. Is Ollama running?`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Ollama embed timed out after 60s for model "${this.config.embedModel}"`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      this.metrics.errors++;
      throw new Error(`Ollama embed error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.embeddings?.[0] || [];
  }
  /**
   * Build a cheap fingerprint for a tools array without serializing the whole thing.
   * Uses count + concatenated names + total description length — unique enough to detect changes
   * while being O(n) in tool count with minimal allocations.
   */
  toolsFingerprint(tools) {
    let descLen = 0;
    let names = "";
    for (const t of tools) {
      names += t.name + ",";
      descLen += (t.description || "").length;
    }
    return `${tools.length}:${descLen}:${names}`;
  }
  /**
   * Compress tool definitions for local models to save context tokens.
   * Strips verbose descriptions (keep first sentence) and simplifies parameter schemas.
   * Typically reduces tool tokens by 60-70% (e.g., 5000 → 1500 tokens for 25 tools).
   * Results are cached since tool definitions rarely change between calls.
   */
  compressTools(tools) {
    const fp = this.toolsFingerprint(tools);
    if (this.compressedToolsCache && this.compressedToolsCache.fingerprint === fp) {
      return this.compressedToolsCache.result;
    }
    const result = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        // Keep first sentence only (up to 80 chars)
        description: (t.description || t.name).split(/\.\s/)[0].slice(0, 80),
        parameters: this.compressParams(t.parameters)
      }
    }));
    this.compressedToolsCache = { fingerprint: fp, result };
    return result;
  }
  /**
   * Simplify JSON Schema parameters: keep property names, types, enums, and required.
   * Strip verbose descriptions and nested details.
   */
  compressParams(params) {
    if (!params || typeof params !== "object") return params || {};
    const props = params.properties;
    if (!props) return params;
    const compressed = { type: "object", properties: {} };
    const compressedProps = {};
    for (const [key, val] of Object.entries(props)) {
      const v = val;
      const prop = { type: v?.type || "string" };
      if (v?.enum) prop.enum = v.enum;
      if (v?.default !== void 0) prop.default = v.default;
      compressedProps[key] = prop;
    }
    compressed.properties = compressedProps;
    if (params.required) compressed.required = params.required;
    return compressed;
  }
  /**
   * Repair malformed tool call arguments from local models.
   * Common issues: stringified JSON instead of object, trailing commas,
   * unquoted keys, null/undefined values.
   */
  repairToolArgs(args) {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args;
    }
    if (typeof args === "string") {
      const trimmed = args.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "object" && parsed !== null) return parsed;
        } catch (err) {
          log3.debug(`[ollama] tool args JSON parse failed, attempting repair: ${err instanceof Error ? err.message : String(err)}`);
          try {
            let repaired = trimmed;
            repaired = repaired.replace(/,\s*}/g, "}");
            repaired = repaired.replace(/,\s*]/g, "]");
            repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
            repaired = repaired.replace(/(?<=[{,]\s*)([a-zA-Z_]\w*)\s*:/g, '"$1":');
            const parsed = JSON.parse(repaired);
            if (typeof parsed === "object" && parsed !== null) return parsed;
          } catch (repairErr) {
            log3.debug(`[ollama] tool args repair also failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`);
          }
        }
      }
    }
    return {};
  }
  /**
   * Adaptive streaming idle timeout based on model size.
   * Small models (phi4-mini): 45s — they should produce tokens quickly
   * Medium models (8B): 90s — moderate generation speed
   * Large models (14B+): 120s — need more time per token on limited hardware
   */
  adaptiveIdleTimeout() {
    const lower = this.config.model.toLowerCase();
    if (lower.includes("phi4-mini") || lower.includes("phi3-mini") || lower.includes("tinyllama") || lower.includes("gemma:2b") || lower.includes("gemma3-zaraa") || lower.includes("gemma3:4b") || lower.includes("gemma4-e2b") || lower.includes("gemma4:e2b") || lower.includes("gemma4-e4b") || lower.includes("gemma4:e4b")) {
      return 45e3;
    }
    if (lower.includes(":8b") || lower.includes("mistral") || lower.includes("qwen2.5-coder") || lower.includes("gemma:7b")) {
      return 9e4;
    }
    return 12e4;
  }
  /**
   * Auto-detect a reasonable timeout based on model name/size.
   * Larger models need longer timeouts on CPU-only or limited GPU systems.
   */
  autoDetectTimeout(model) {
    const lower = model.toLowerCase();
    if (lower.includes("qwen3.5-zaraa")) {
      return 75e3;
    }
    if (/:(3[5-9]b|[4-9]\db|\d{3,}b)/i.test(model) || lower.includes(":70b")) {
      return 25 * 6e4;
    }
    if (lower.includes("phi4-mini") || lower.includes("phi3-mini") || lower.includes("gemma:2b") || lower.includes("tinyllama") || lower.includes("gemma3-zaraa") || lower.includes("gemma3:4b") || lower.includes("gemma4-e2b") || lower.includes("gemma4:e2b") || lower.includes("gemma4-e4b") || lower.includes("gemma4:e4b")) {
      return 5 * 6e4;
    }
    if (lower.includes("llama3.1:8b") || lower.includes("mistral") || lower.includes("qwen2.5-coder") || lower.includes("gemma:7b")) {
      return 10 * 6e4;
    }
    if (lower.includes("qwen3.5") || lower.includes("opus-distilled") || lower.includes("llama3.1:13b") || lower.includes("codellama:13b")) {
      return 15 * 6e4;
    }
    return 20 * 6e4;
  }
};

// src/providers/gemini-provider.ts
var GeminiProvider = class extends BaseProvider {
  name = "gemini";
  config;
  constructor(config, sanitizer) {
    super(sanitizer);
    this.config = config;
  }
  async chat(messages, tools) {
    const sanitized = this.sanitizeMessages(messages);
    const model = this.config.model || "gemini-2.0-flash";
    const systemParts = sanitized.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = [];
    for (const msg of sanitized) {
      if (msg.role === "system") continue;
      if (msg.role === "tool" && msg.toolCallId) {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId,
                response: { result: msg.content }
              }
            }
          ]
        });
      } else if (msg.role === "assistant") {
        const parts2 = [];
        if (msg.content) {
          parts2.push({ text: msg.content });
        }
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            parts2.push({
              functionCall: { name: tc.name, args: tc.arguments }
            });
          }
        }
        if (parts2.length === 0) {
          parts2.push({ text: msg.content });
        }
        contents.push({ role: "model", parts: parts2 });
      } else {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      }
    }
    const body = { contents };
    if (systemParts) {
      body.systemInstruction = { parts: [{ text: systemParts }] };
    }
    if (this.config.maxTokens) {
      body.generationConfig = { maxOutputTokens: this.config.maxTokens };
    }
    if (tools?.length) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }))
        }
      ];
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.config.apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12e4);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Gemini API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`
      );
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    let content = "";
    const toolCalls = [];
    for (const part of parts) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name,
          // Gemini doesn't have separate IDs
          name: part.functionCall.name,
          arguments: part.functionCall.args || {}
        });
      }
    }
    return {
      content,
      toolCalls,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount || 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount || 0
      },
      model
    };
  }
};

// src/secrets/keychain.ts
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync
} from "crypto";
import { readFileSync, existsSync, renameSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
var Keychain = class {
  service;
  storagePath;
  store;
  masterKey;
  constructor(config) {
    this.service = config.service || "zaraa";
    this.storagePath = config.storagePath || `${process.env.HOME}/.zaraa/secrets.enc`;
    const salt = `${process.env.USER || "default"}-${process.platform}-${process.env.HOSTNAME || process.env.COMPUTERNAME || "local"}`;
    this.masterKey = pbkdf2Sync(
      this.service,
      salt,
      31e4,
      // OWASP recommended minimum for PBKDF2-SHA256
      32,
      "sha256"
    );
    this.store = this.loadStore();
  }
  async set(key, value) {
    this.store.set(key, value);
    await this.saveStore();
  }
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async delete(key) {
    const result = this.store.delete(key);
    if (result) await this.saveStore();
    return result;
  }
  async has(key) {
    return this.store.has(key);
  }
  async list() {
    return Array.from(this.store.keys());
  }
  // Encrypt and save to disk using atomic write (write to temp, then rename)
  async saveStore() {
    const data = JSON.stringify(Object.fromEntries(this.store));
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(data, "utf8"),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    const output = Buffer.concat([iv, authTag, encrypted]);
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmpPath = join(dir, `.secrets.enc.tmp.${process.pid}`);
    await writeFile(tmpPath, output, { mode: 384 });
    renameSync(tmpPath, this.storagePath);
  }
  // Decrypt and load from disk
  loadStore() {
    try {
      if (!existsSync(this.storagePath)) {
        return /* @__PURE__ */ new Map();
      }
      const raw = readFileSync(this.storagePath);
      if (raw.length < 33) {
        console.warn("[keychain] Secrets file too small \u2014 starting fresh");
        return /* @__PURE__ */ new Map();
      }
      const iv = raw.subarray(0, 16);
      const authTag = raw.subarray(16, 32);
      const encrypted = raw.subarray(32);
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      const data = JSON.parse(decrypted.toString("utf8"));
      return new Map(Object.entries(data));
    } catch (err) {
      console.warn(
        "[keychain] Failed to decrypt secrets file \u2014 starting fresh:",
        err instanceof Error ? err.message : String(err)
      );
      return /* @__PURE__ */ new Map();
    }
  }
};

// src/providers/provider-factory.ts
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync3, writeFileSync } from "fs";
import { homedir as homedir4 } from "os";
import { dirname as dirname2, join as join5 } from "path";

// src/privacy/prompt-sanitizer.ts
import picomatch from "picomatch";
var BUILTIN_PATTERNS = [
  {
    regex: /sk-[a-zA-Z0-9_-]{20,}/g,
    label: "[REDACTED_API_KEY]",
    type: "api_key"
  },
  {
    regex: /AKIA[0-9A-Z]{16}/g,
    label: "[REDACTED_AWS_KEY]",
    type: "aws_key"
  },
  {
    regex: /gh[pos]_[A-Za-z0-9_]{36,}/g,
    label: "[REDACTED_GITHUB_TOKEN]",
    type: "github_token"
  },
  {
    regex: /[ps]k_(live|test)_[A-Za-z0-9]{24,}/g,
    label: "[REDACTED_STRIPE_KEY]",
    type: "stripe_key"
  },
  {
    regex: /-----BEGIN\s(?:RSA\s|EC\s|DSA\s)?PRIVATE\sKEY-----[\s\S]*?(?:-----END\s(?:RSA\s|EC\s|DSA\s)?PRIVATE\sKEY-----|$)/g,
    label: "[REDACTED_PRIVATE_KEY]",
    type: "private_key"
  },
  {
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    label: "[REDACTED_JWT]",
    type: "jwt"
  },
  // Trading-specific secrets (ngt-0461)
  {
    // Solana private keys: base58 alphabet, 87–88 chars. Base58 excludes 0/O/I/l.
    // Floor at 87 chars avoids wallet addresses (44 chars) and tx hashes (88 hex chars
    // which use a different alphabet). Upper-bound omitted — base58 keys are always 88.
    regex: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/g,
    label: "[REDACTED_SOLANA_KEY]",
    type: "solana_private_key"
  },
  {
    // CEX HMAC secrets (Crypto.com, Binance, etc.): 64-char lowercase hex.
    // Anchored to word boundaries so it doesn't fire on 64-char substrings
    // inside longer hex strings (e.g. SHA-256 hashes in logs).
    regex: /\b[0-9a-f]{64}\b/g,
    label: "[REDACTED_EXCHANGE_SECRET]",
    type: "exchange_hmac_secret"
  },
  {
    // EVM private keys (Polymarket CLOB, MetaMask exports): 0x + 64 hex chars.
    regex: /\b0x[0-9a-fA-F]{64}\b/g,
    label: "[REDACTED_EVM_PRIVATE_KEY]",
    type: "evm_private_key"
  }
];
function classifyPattern(pattern) {
  if (pattern.includes("sk-")) {
    return { label: "[REDACTED_API_KEY]", type: "api_key" };
  }
  if (pattern.includes("\\d{3}-\\d{2}-\\d{4}")) {
    return { label: "[REDACTED_PII]", type: "ssn" };
  }
  if (pattern.includes("\\d{4}") && pattern.includes("\\d{4}[\\s-]?\\d{4}")) {
    return { label: "[REDACTED_PII]", type: "credit_card" };
  }
  return { label: "[REDACTED_PII]", type: "pii" };
}
var PromptSanitizer = class {
  patterns;
  pathMatcher;
  totalRedactions = 0;
  constructor(config) {
    this.patterns = [...BUILTIN_PATTERNS];
    for (const pattern of config.neverSendPatterns) {
      const classification = classifyPattern(pattern);
      if (classification.type === "api_key") {
        continue;
      }
      try {
        this.patterns.push({
          regex: new RegExp(pattern, "g"),
          label: classification.label,
          type: classification.type
        });
      } catch {
        console.warn(`[sanitizer] Skipping invalid neverSendPattern: "${pattern}"`);
      }
    }
    this.pathMatcher = picomatch(config.confidentialPaths, { dot: true });
  }
  sanitize(text) {
    let sanitized = text;
    let redactions = 0;
    const redactedTypesSet = /* @__PURE__ */ new Set();
    const confidentialPathsDetected = [];
    const pathRegex = /(?:~\/|\/)[^\s,;'")\]}>]+/g;
    let pathMatch = pathRegex.exec(sanitized);
    while (pathMatch !== null) {
      const detectedPath = pathMatch[0];
      if (this.pathMatcher(detectedPath)) {
        confidentialPathsDetected.push(detectedPath);
      }
      pathMatch = pathRegex.exec(sanitized);
    }
    for (const detectedPath of confidentialPathsDetected) {
      sanitized = sanitized.replaceAll(detectedPath, "[REDACTED_CONFIDENTIAL_PATH]");
      redactions++;
      redactedTypesSet.add("confidential_path");
    }
    for (const entry of this.patterns) {
      const regex = new RegExp(entry.regex.source, entry.regex.flags);
      let matchCount = 0;
      sanitized = sanitized.replace(regex, () => {
        matchCount++;
        return entry.label;
      });
      if (matchCount > 0) {
        redactions += matchCount;
        redactedTypesSet.add(entry.type);
      }
    }
    this.totalRedactions += redactions;
    return {
      text: sanitized,
      redactions,
      redactedTypes: [...redactedTypesSet],
      confidentialPathsDetected
    };
  }
  /** Cumulative counters across all sanitize() calls, for status/safety snapshots. */
  getStats() {
    return { privacyRedactions: this.totalRedactions };
  }
};

// src/providers/codex-token-manager.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { writeFile as writeFile2 } from "fs/promises";
import { homedir } from "os";
import { join as join2 } from "path";
var REFRESH_URL = "https://auth.openai.com/oauth/token";
var DEFAULT_OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var EXPIRY_BUFFER_S = 60;
var INFERENCE_SCOPE_PREFIXES = [
  "api.responses.",
  "api.chat.",
  "api.chat_completions.",
  "api.completions.",
  "api.assistants.",
  "api.model.",
  "api.connectors.invoke"
];
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return null;
  }
}
function getOpenAIOAuthClientId() {
  const envClientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
  return envClientId && envClientId.length > 0 ? envClientId : DEFAULT_OPENAI_OAUTH_CLIENT_ID;
}
function getCodexAccessTokenScopes(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return [];
  if (Array.isArray(payload.scp)) {
    return payload.scp.filter((scope) => typeof scope === "string" && scope.length > 0);
  }
  if (typeof payload.scp === "string" && payload.scp.length > 0) {
    return payload.scp.split(/\s+/).filter(Boolean);
  }
  if (typeof payload.scope === "string" && payload.scope.length > 0) {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  return [];
}
function hasCodexInferenceScopes(scopes) {
  return scopes.some((scope) => INFERENCE_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix)));
}
function getDefaultCodexAuthFilePath() {
  return join2(homedir(), ".codex", "auth.json");
}
function hasCodexSessionAuth(authFilePath) {
  const path = authFilePath ?? getDefaultCodexAuthFilePath();
  try {
    if (!existsSync2(path)) return false;
    const raw = readFileSync2(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}
function hasCodexSessionInferenceAccess(authFilePath) {
  const path = authFilePath ?? getDefaultCodexAuthFilePath();
  try {
    if (!existsSync2(path)) return false;
    const raw = readFileSync2(path, "utf-8");
    const parsed = JSON.parse(raw);
    const token = parsed.tokens?.access_token;
    if (typeof token !== "string" || token.length === 0) return false;
    const scopes = getCodexAccessTokenScopes(token);
    if (scopes.length === 0) {
      return Boolean(parsed.OPENAI_API_KEY);
    }
    return hasCodexInferenceScopes(scopes);
  } catch {
    return false;
  }
}
var CodexTokenManager = class {
  authFilePath;
  peerAuthFilePath;
  cachedToken = null;
  cachedExp = 0;
  refreshPromise = null;
  constructor(authFilePath, peerAuthFilePath) {
    this.authFilePath = authFilePath ?? getDefaultCodexAuthFilePath();
    this.peerAuthFilePath = peerAuthFilePath ?? join2(homedir(), ".zaraa", "openai-auth.json");
  }
  async forceRefresh() {
    this.cachedToken = null;
    this.cachedExp = 0;
    return this.getAccessToken();
  }
  async getAccessToken() {
    const now = Math.floor(Date.now() / 1e3);
    if (this.cachedToken && this.cachedExp > now + EXPIRY_BUFFER_S) {
      return this.cachedToken;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.loadAndRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  async loadAndRefresh() {
    const auth = await this.readAuthFile();
    const peerAuth = await readAuthFileSafe(this.peerAuthFilePath);
    const token = auth.tokens.access_token;
    const exp = decodeExp(token);
    const now = Math.floor(Date.now() / 1e3);
    const freshest = pickFreshestValid(auth, peerAuth, now, EXPIRY_BUFFER_S);
    if (freshest && freshest.source === "peer") {
      await this.writeOwnAuthFile(freshest.auth);
      this.cachedToken = freshest.auth.tokens.access_token;
      this.cachedExp = decodeExp(freshest.auth.tokens.access_token);
      return freshest.auth.tokens.access_token;
    }
    if (exp > now + EXPIRY_BUFFER_S) {
      this.cachedToken = token;
      this.cachedExp = decodeExp(token);
      return token;
    }
    try {
      const refreshed = await this.refreshToken(auth.tokens.refresh_token);
      const newAuth = {
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          id_token: refreshed.id_token
        },
        last_refresh: (/* @__PURE__ */ new Date()).toISOString()
      };
      await writeRotatedToAll(this.authFilePath, this.peerAuthFilePath, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        id_token: refreshed.id_token,
        account_id: auth.tokens.account_id,
        last_refresh: newAuth.last_refresh
      });
      const newExp = decodeExp(refreshed.access_token);
      this.cachedToken = refreshed.access_token;
      this.cachedExp = newExp;
      return refreshed.access_token;
    } catch {
      const fallback = await this.readAuthFile({ ignoreMissingRefresh: true }).catch(() => null);
      const fallbackPeer = await readAuthFileSafe(this.peerAuthFilePath);
      const fallbackFresh = pickFreshestValid(fallback, fallbackPeer, now, EXPIRY_BUFFER_S);
      if (fallbackFresh) {
        await this.writeOwnAuthFile(fallbackFresh.auth);
        this.cachedToken = fallbackFresh.auth.tokens.access_token;
        this.cachedExp = decodeExp(fallbackFresh.auth.tokens.access_token);
        return fallbackFresh.auth.tokens.access_token;
      }
      throw new Error(
        "Codex auth expired \u2014 run `codex` or open the Codex app to re-authenticate"
      );
    }
  }
  async writeOwnAuthFile(auth) {
    const existing = await readAuthFileSafe(this.authFilePath);
    const updated = {
      ...existing,
      ...auth,
      tokens: {
        ...existing?.tokens,
        ...auth.tokens
      }
    };
    await writeFile2(this.authFilePath, JSON.stringify(updated, null, 2));
  }
  async refreshToken(refreshToken) {
    const response = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: getOpenAIOAuthClientId()
      })
    });
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    return await response.json();
  }
  async readAuthFile(options = {}) {
    const auth = await readAuthFileSafe(this.authFilePath);
    if (auth) {
      return auth;
    }
    if (options.ignoreMissingRefresh) {
      return null;
    }
    throw new Error("Codex not authenticated \u2014 run the Codex app to sign in");
  }
};

// src/providers/cursor-agent-provider.ts
import { execFile, spawn } from "child_process";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
import { promisify } from "util";

// src/providers/cursor-error.ts
var CURSOR_CLASSIFICATION_COOLDOWNS = {
  auth: 10 * 60,
  quota: 60 * 60,
  parse: 0,
  spawn: 15,
  rateLimit: 60,
  timeout: 30,
  transient: 5,
  overloaded: 60,
  model: 0,
  unknown: 30
};
var RULES = [
  {
    category: "auth",
    reason: "auth",
    severity: "hard",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.auth,
    fallbackEligible: true,
    signal: "auth",
    match: (s) => /SecItemCopyMatching failed -50/i.test(s) || /keychain/i.test(s)
  },
  {
    category: "quota",
    reason: "billing",
    severity: "hard",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.quota,
    fallbackEligible: true,
    signal: "quota",
    match: (s) => /out of usage|increase your limit|increase limits for faster responses/i.test(s)
  },
  {
    category: "rate_limit",
    reason: "rate_limit",
    severity: "retryable",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.rateLimit,
    fallbackEligible: false,
    signal: "rate_limit",
    match: (s) => /\b429\b|rate\s*_?\s*limit|too many requests/i.test(s)
  },
  {
    category: "parse",
    reason: "invalid_response",
    severity: "hard",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.parse,
    fallbackEligible: true,
    signal: "parse",
    match: (s) => /invalid json|json parser|unexpected token|non-json output|empty response|\bnot-json\b/i.test(
      s
    )
  },
  {
    category: "timeout",
    reason: "timeout",
    severity: "retryable",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.timeout,
    fallbackEligible: false,
    signal: "timeout",
    match: (s) => /\btimed out\b|\btimeout\b/i.test(s)
  },
  {
    category: "overloaded",
    reason: "unknown",
    severity: "retryable",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.overloaded,
    fallbackEligible: false,
    signal: "overloaded",
    match: (s) => /\b503\b|\b529\b|overloaded|service unavailable/i.test(s)
  },
  {
    category: "spawn",
    reason: "unknown",
    severity: "retryable",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.spawn,
    fallbackEligible: false,
    signal: "spawn",
    match: (s) => /enoent|eacces|permission denied|spawn\s+failed/i.test(s)
  }
];
function classifyCursorFailure(input) {
  const text = `${input.stderr ?? ""}
${input.stdout ?? ""}`.trim();
  for (const rule of RULES) {
    if (rule.match(text)) {
      return {
        category: rule.category,
        reason: rule.reason,
        severity: rule.severity,
        retrySeconds: rule.retrySeconds,
        fallbackEligible: rule.fallbackEligible,
        signal: rule.signal
      };
    }
  }
  switch (input.exitCode) {
    case 401:
    case 403:
      return {
        category: "auth",
        reason: "auth",
        severity: "hard",
        retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.auth,
        fallbackEligible: true,
        signal: "http_status"
      };
    case 402:
      return {
        category: "quota",
        reason: "billing",
        severity: "hard",
        retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.quota,
        fallbackEligible: true,
        signal: "http_status"
      };
    case 429:
      return {
        category: "rate_limit",
        reason: "rate_limit",
        severity: "retryable",
        retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.rateLimit,
        fallbackEligible: false,
        signal: "http_status"
      };
    case 503:
    case 529:
      return {
        category: "overloaded",
        reason: "unknown",
        severity: "retryable",
        retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.overloaded,
        fallbackEligible: false,
        signal: "http_status"
      };
    case 504:
      return {
        category: "timeout",
        reason: "timeout",
        severity: "retryable",
        retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.timeout,
        fallbackEligible: false,
        signal: "http_status"
      };
    default:
      break;
  }
  if (input.exitCode !== void 0 && input.exitCode !== 0) {
    return {
      category: "transient",
      reason: "unknown",
      severity: "retryable",
      retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.transient,
      fallbackEligible: false,
      signal: "exit_code"
    };
  }
  return {
    category: "unknown",
    reason: "unknown",
    severity: "hard",
    retrySeconds: CURSOR_CLASSIFICATION_COOLDOWNS.unknown,
    fallbackEligible: false,
    signal: "unknown"
  };
}
function cursorFailureToFailoverCooldownReason(classification) {
  switch (classification.category) {
    case "auth":
      return "auth";
    case "quota":
      return "billing";
    case "timeout":
      return "overloaded";
    case "rate_limit":
      return "rate_limit";
    case "overloaded":
      return "overloaded";
    default:
      return "unknown";
  }
}
function extractCursorAgentFailureInput(error) {
  const msg = error.message;
  const exitMatch = msg.match(/cursor-agent exited with code (\d+):\s*(.*)/is);
  if (exitMatch) {
    const exitCode = Number(exitMatch[1]);
    const rest = exitMatch[2]?.trim() ?? "";
    return {
      exitCode: Number.isFinite(exitCode) ? exitCode : void 0,
      stderr: rest
    };
  }
  return { stderr: msg };
}
function extractCursorSdkFailureInput(error) {
  const maybe = error;
  const status = typeof maybe.status === "number" ? maybe.status : typeof maybe.statusCode === "number" ? maybe.statusCode : void 0;
  const code = typeof maybe.code === "string" ? maybe.code : void 0;
  return {
    stderr: [error.message, code].filter(Boolean).join("\n"),
    exitCode: status
  };
}

// src/providers/cursor-agent-provider.ts
var execFileAsync = promisify(execFile);
var CURSOR_AGENT_BIN = join3(homedir2(), ".local", "bin", "cursor-agent");
var DEFAULT_CURSOR_AGENT_SPAWN_TIMEOUT_MS = 3e4;
function mapCursorAgentUsage(usage) {
  return {
    promptTokens: usage?.input_tokens ?? usage?.inputTokens ?? 0,
    completionTokens: usage?.output_tokens ?? usage?.outputTokens ?? 0
  };
}
var CursorAgentProvider = class {
  name = "cursor-agent";
  modelKey;
  tier;
  billingMode;
  capabilities;
  pricing;
  config;
  timeoutConfig;
  metrics = {
    totalRequests: 0,
    totalDurationMs: 0,
    avgResponseMs: 0,
    lastResponseMs: 0,
    errors: 0,
    timeoutCount: 0,
    spawnTimeoutCount: 0,
    streamTimeoutCount: 0,
    lastTimeoutReason: null,
    lastTimeoutAt: null
  };
  /** Cached env object — avoids spreading process.env on every spawn */
  spawnEnv;
  /** Skip repeated launches for a while after a known startup auth failure. */
  keychainCooldownUntil = 0;
  /** Skip launches after Cursor reports the subscription quota is exhausted. */
  quotaCooldownUntil = 0;
  constructor(config = {}) {
    const baseTimeoutMs = config.timeoutMs ?? 6e5;
    const cliTimeouts = config.cliTimeouts ?? {};
    this.config = {
      model: config.model || "auto",
      timeoutMs: baseTimeoutMs,
      force: config.force ?? false,
      trust: config.trust ?? false,
      workingDir: config.workingDir,
      binaryPath: config.binaryPath
    };
    const apiKey = config.apiKey?.trim() || process.env.CURSOR_API_KEY?.trim();
    this.spawnEnv = apiKey ? { ...process.env, CURSOR_API_KEY: apiKey } : { ...process.env };
    const overallMs = this.normalizeTimeoutMs(cliTimeouts.overallMs, baseTimeoutMs);
    this.timeoutConfig = {
      spawnMs: Math.min(
        this.normalizeTimeoutMs(
          cliTimeouts.spawnMs,
          Math.min(DEFAULT_CURSOR_AGENT_SPAWN_TIMEOUT_MS, baseTimeoutMs)
        ),
        overallMs
      ),
      streamMs: Math.min(
        this.normalizeTimeoutMs(cliTimeouts.streamMs, Math.min(6e4, baseTimeoutMs)),
        overallMs
      ),
      overallMs
    };
  }
  /**
   * Chat — spawns `cursor-agent --print` with JSON output, collects stdout via spawn.
   * Merges system + conversation messages into a single prompt string
   * since the CLI takes a flat prompt, not a message array.
   */
  async chat(messages, _tools, opts) {
    this.assertAvailable();
    if (opts?.signal?.aborted) {
      throw this.createAbortError(opts.signal);
    }
    const { systemPrompt, userPrompt } = this.flattenMessages(messages);
    const args = this.buildArgs(userPrompt, systemPrompt, "json");
    const t0 = Date.now();
    this.metrics.totalRequests++;
    let stdout;
    try {
      stdout = await this.spawnCollect(args, opts?.signal);
    } catch (err) {
      throw err;
    }
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      const jsonStart = stdout.indexOf("{");
      try {
        if (jsonStart > 0) {
          data = JSON.parse(stdout.slice(jsonStart));
        } else {
          throw new Error(`cursor-agent returned non-JSON output: ${stdout.slice(0, 200)}`);
        }
      } catch (err) {
        this.metrics.errors++;
        const message = err instanceof Error ? err.message : String(err);
        const classified = classifyCursorFailure({ stderr: message });
        if (classified.category === "auth") {
          throw this.enterKeychainCooldown(message);
        }
        if (classified.category === "quota") {
          throw this.enterQuotaCooldown(message);
        }
        throw new Error(message);
      }
    }
    const elapsed = Date.now() - t0;
    this.metrics.totalDurationMs += elapsed;
    this.metrics.lastResponseMs = elapsed;
    this.metrics.avgResponseMs = this.computeAverageResponseMs();
    if (data.is_error) {
      this.metrics.errors++;
      const classified = classifyCursorFailure({ stderr: data.result ?? "error" });
      if (classified.category === "auth") {
        throw this.enterKeychainCooldown(data.result ?? "error");
      }
      if (classified.category === "quota") {
        throw this.enterQuotaCooldown(data.result ?? "error");
      }
      throw new Error(`cursor-agent error: ${data.result ?? "error"}`);
    }
    return {
      content: data.result || "",
      toolCalls: [],
      usage: mapCursorAgentUsage(data.usage),
      model: this.config.model
    };
  }
  /**
   * Streaming chat — spawns `cursor-agent --print` with stream-json output.
   * Yields text deltas as NDJSON events arrive from stdout.
   */
  async *chatStream(messages, _tools, opts) {
    this.assertAvailable();
    if (opts?.signal?.aborted) throw this.createAbortError(opts.signal);
    const { systemPrompt, userPrompt } = this.flattenMessages(messages);
    const args = this.buildArgs(userPrompt, systemPrompt, "stream-json");
    const t0 = Date.now();
    let timeoutReason = null;
    let timeoutMs = 0;
    let aborted = false;
    let sawResult = false;
    const proc = spawn(this.config.binaryPath ?? CURSOR_AGENT_BIN, args, {
      cwd: this.config.workingDir,
      env: this.spawnEnv,
      signal: opts?.signal,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let spawnTimer = null;
    let streamTimer = null;
    let overallTimer = null;
    const clearSpawnTimer = () => {
      if (spawnTimer) {
        clearTimeout(spawnTimer);
        spawnTimer = null;
      }
    };
    const clearStreamTimer = () => {
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
    };
    const clearTimers = () => {
      clearSpawnTimer();
      clearStreamTimer();
      if (overallTimer) {
        clearTimeout(overallTimer);
        overallTimer = null;
      }
    };
    const onAbort = () => {
      aborted = true;
      clearTimers();
      proc.kill("SIGTERM");
    };
    if (opts?.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const setTimeoutReason = (reason, ms) => {
      if (timeoutReason) return;
      timeoutReason = reason;
      timeoutMs = ms;
      this.recordTimeout(reason, ms);
      proc.kill("SIGTERM");
    };
    const armStreamTimer = () => {
      clearStreamTimer();
      streamTimer = setTimeout(() => {
        setTimeoutReason("stream", this.timeoutConfig.streamMs);
      }, this.timeoutConfig.streamMs);
    };
    const markActivity = () => {
      clearSpawnTimer();
      armStreamTimer();
    };
    spawnTimer = setTimeout(() => {
      setTimeoutReason("spawn", this.timeoutConfig.spawnMs);
    }, this.timeoutConfig.spawnMs);
    overallTimer = setTimeout(() => {
      setTimeoutReason("overall", this.timeoutConfig.overallMs);
    }, this.timeoutConfig.overallMs);
    let buffer = "";
    let stderr = "";
    let emittedText = "";
    this.metrics.totalRequests++;
    proc.stderr?.on("data", (chunk) => {
      markActivity();
      stderr += chunk.toString();
    });
    let exitError;
    const exitPromise = new Promise((resolve2, reject) => {
      proc.on("error", (err) => {
        if (aborted || opts?.signal?.aborted) {
          reject(this.createAbortError(opts?.signal));
          return;
        }
        if (timeoutReason) {
          reject(this.createTimeoutError(timeoutReason, timeoutMs));
          return;
        }
        reject(this.normalizeProcessError(err));
      });
      proc.on("close", (code) => {
        if (opts?.signal) {
          opts.signal.removeEventListener("abort", onAbort);
        }
        if (aborted || opts?.signal?.aborted) {
          reject(this.createAbortError(opts?.signal));
          return;
        }
        if (timeoutReason) {
          reject(this.createTimeoutError(timeoutReason, timeoutMs));
          return;
        }
        if (code !== 0) {
          reject(this.normalizeExitError(code, stderr));
          return;
        }
        resolve2();
      });
    }).catch((err) => {
      exitError = err;
    });
    try {
      const stdoutStream = proc.stdout;
      if (!stdoutStream) throw new Error("cursor-agent stdout stream is unavailable");
      for await (const chunk of stdoutStream) {
        markActivity();
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (err) {
            this.metrics.errors++;
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`cursor-agent stream protocol error: ${message}`);
          }
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                if (typeof event.timestamp_ms === "number") {
                  yield { type: "text_delta", content: block.text };
                  emittedText += block.text;
                  continue;
                }
                if (block.text === emittedText) continue;
                const newContent = block.text.startsWith(emittedText) ? block.text.slice(emittedText.length) : block.text;
                if (newContent) {
                  yield { type: "text_delta", content: newContent };
                  emittedText += newContent;
                }
              }
            }
          } else if (event.type === "result") {
            sawResult = true;
            if (event.is_error) {
              this.metrics.errors++;
              const errorText = event.result ?? "error";
              const classified = classifyCursorFailure({ stderr: errorText });
              if (classified.category === "auth") {
                throw this.enterKeychainCooldown(errorText);
              }
              if (classified.category === "quota") {
                throw this.enterQuotaCooldown(errorText);
              }
              throw new Error(`cursor-agent error: ${errorText}`);
            }
            yield {
              type: "done",
              finishReason: "end_turn",
              model: this.config.model,
              usage: mapCursorAgentUsage(event.usage)
            };
          }
        }
      }
      if (opts?.signal?.aborted) {
        throw this.createAbortError(opts.signal);
      }
      await exitPromise;
      if (exitError) throw exitError;
      const elapsed = Date.now() - t0;
      this.metrics.totalDurationMs += elapsed;
      this.metrics.lastResponseMs = elapsed;
      this.metrics.avgResponseMs = this.computeAverageResponseMs();
    } finally {
      clearTimers();
      if (opts?.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      if (!proc.killed) proc.kill("SIGTERM");
    }
  }
  /**
   * Health check — verifies the `cursor-agent` binary is installed and responsive.
   */
  async healthCheck() {
    try {
      const { stdout } = await execFileAsync(
        this.config.binaryPath ?? CURSOR_AGENT_BIN,
        ["--version"],
        { timeout: 5e3 }
      );
      return { ok: true, version: stdout.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  getMetrics() {
    return { ...this.metrics };
  }
  isAvailable() {
    const now = Date.now();
    return now >= this.keychainCooldownUntil && now >= this.quotaCooldownUntil;
  }
  // ─── Private ───────────────────────────────────────────
  normalizeTimeoutMs(value, fallbackMs) {
    if (value === void 0) return fallbackMs;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return fallbackMs;
    }
    return value;
  }
  /**
   * Spawn cursor-agent and collect stdout until the process closes.
   * Uses spawn instead of execFile because the binary can keep inherited
   * pipes open after exit, causing execFile to hang.
   */
  spawnCollect(args, signal) {
    if (signal?.aborted) {
      return Promise.reject(this.createAbortError(signal));
    }
    return new Promise((resolve2, reject) => {
      let timeoutReason = null;
      let timeoutMs = 0;
      let aborted = false;
      let settled = false;
      const proc = spawn(this.config.binaryPath ?? CURSOR_AGENT_BIN, args, {
        cwd: this.config.workingDir,
        env: this.spawnEnv,
        signal,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let spawnTimer = null;
      let overallTimer = null;
      const clearSpawnTimer = () => {
        if (spawnTimer) {
          clearTimeout(spawnTimer);
          spawnTimer = null;
        }
      };
      const clearTimers = () => {
        clearSpawnTimer();
        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = null;
        }
      };
      const setTimeoutReason = (reason, ms) => {
        if (settled || timeoutReason) return;
        timeoutReason = reason;
        timeoutMs = ms;
        this.recordTimeout(reason, ms);
        proc.kill("SIGTERM");
      };
      proc.stdout?.on("data", (d) => {
        clearSpawnTimer();
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        clearSpawnTimer();
        stderr += d.toString();
      });
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const abort = () => {
        if (settled) return;
        aborted = true;
        proc.kill("SIGTERM");
        clearTimers();
        finish(() => reject(this.createAbortError(signal)));
      };
      spawnTimer = setTimeout(() => {
        setTimeoutReason("spawn", this.timeoutConfig.spawnMs);
      }, this.timeoutConfig.spawnMs);
      overallTimer = setTimeout(() => {
        setTimeoutReason("overall", this.timeoutConfig.overallMs);
      }, this.timeoutConfig.overallMs);
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
      }
      proc.on("error", (err) => {
        clearTimers();
        if (signal) {
          signal.removeEventListener("abort", abort);
        }
        if (aborted) {
          finish(() => reject(this.createAbortError(signal)));
          return;
        }
        if (timeoutReason) {
          const reason = timeoutReason;
          finish(() => reject(this.createTimeoutError(reason, timeoutMs)));
          return;
        }
        finish(() => reject(this.normalizeProcessError(err)));
      });
      proc.on("close", (code) => {
        clearTimers();
        if (signal) {
          signal.removeEventListener("abort", abort);
        }
        if (aborted) {
          finish(() => reject(this.createAbortError(signal)));
          return;
        }
        if (timeoutReason) {
          const reason = timeoutReason;
          finish(() => reject(this.createTimeoutError(reason, timeoutMs)));
          return;
        }
        if (code !== 0 && !stdout.trim()) {
          finish(() => reject(this.normalizeExitError(code, stderr)));
        } else {
          finish(() => resolve2(stdout.trim()));
        }
      });
    });
  }
  createAbortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) {
      return reason;
    }
    const error = new Error("Request was aborted");
    error.name = "AbortError";
    return error;
  }
  recordTimeout(reason, timeoutMs = this.timeoutMsForReason(reason)) {
    this.metrics.errors++;
    this.metrics.timeoutCount++;
    if (reason === "spawn") this.metrics.spawnTimeoutCount++;
    if (reason === "stream") this.metrics.streamTimeoutCount++;
    this.metrics.lastTimeoutReason = reason;
    this.metrics.lastTimeoutMs = timeoutMs;
    this.metrics.lastTimeoutAt = Date.now();
  }
  createTimeoutError(reason, timeoutMs = this.timeoutMsForReason(reason)) {
    const label = reason === "stream" ? "stream" : reason === "overall" ? "overall" : "spawn";
    return new Error(`cursor-agent ${label} timed out after ${timeoutMs}ms`);
  }
  timeoutMsForReason(reason) {
    if (reason === "spawn") return this.timeoutConfig.spawnMs;
    if (reason === "stream") return this.timeoutConfig.streamMs;
    return this.timeoutConfig.overallMs;
  }
  computeAverageResponseMs() {
    return this.metrics.totalRequests > 0 ? Math.round(this.metrics.totalDurationMs / this.metrics.totalRequests) : 0;
  }
  /**
   * Flatten LLM message array into system + user prompt strings.
   * The CLI takes a flat prompt, so we concatenate conversation turns.
   */
  flattenMessages(messages) {
    const system = messages.find((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");
    if (conversation.length === 1) {
      return { systemPrompt: system?.content, userPrompt: conversation[0].content };
    }
    const flat = conversation.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    return { systemPrompt: system?.content, userPrompt: flat };
  }
  /**
   * Build CLI argument array for cursor-agent invocation.
   */
  buildArgs(prompt, systemPrompt, format = "json") {
    const args = ["--print", "--output-format", format, "--model", this.config.model];
    if (format === "stream-json") {
      args.push("--stream-partial-output");
    }
    if (this.config.force) {
      args.push("--force");
    }
    if (this.config.trust) {
      args.push("--trust");
    }
    if (systemPrompt) {
      prompt = `[System Instructions]
${systemPrompt}

[User Request]
${prompt}`;
    }
    args.push(prompt);
    return args;
  }
  assertAvailable() {
    if (Date.now() < this.quotaCooldownUntil) {
      throw this.createQuotaCooldownError();
    }
    if (Date.now() < this.keychainCooldownUntil) {
      throw this.createKeychainCooldownError();
    }
  }
  normalizeProcessError(err) {
    this.metrics.errors++;
    if (err.message.includes("ENOENT")) {
      return new Error(
        `cursor-agent not found at ${CURSOR_AGENT_BIN}. Install Cursor and enable cursor-agent.`
      );
    }
    const classified = classifyCursorFailure({ stderr: err.message });
    if (classified.category === "auth") {
      return this.enterKeychainCooldown(err.message);
    }
    if (classified.category === "quota") {
      return this.enterQuotaCooldown(err.message);
    }
    return err;
  }
  normalizeExitError(code, stderr) {
    this.metrics.errors++;
    const trimmed = stderr.trim();
    const classified = classifyCursorFailure({
      stderr: trimmed,
      exitCode: code ?? void 0
    });
    if (classified.category === "auth") {
      return this.enterKeychainCooldown(trimmed);
    }
    if (classified.category === "quota") {
      return this.enterQuotaCooldown(trimmed);
    }
    return new Error(`cursor-agent exited with code ${code}: ${trimmed || "(no output)"}`);
  }
  enterKeychainCooldown(details) {
    this.keychainCooldownUntil = Date.now() + CURSOR_CLASSIFICATION_COOLDOWNS.auth * 1e3;
    const error = new Error(
      `cursor-agent service unavailable after keychain startup failure: ${details}`
    );
    error.name = "CursorAgentStartupError";
    error.status = 503;
    return error;
  }
  createKeychainCooldownError() {
    const secondsRemaining = Math.max(
      1,
      Math.ceil((this.keychainCooldownUntil - Date.now()) / 1e3)
    );
    const error = new Error(
      `cursor-agent service unavailable during keychain cooldown (${secondsRemaining}s remaining)`
    );
    error.name = "CursorAgentStartupError";
    error.status = 503;
    return error;
  }
  enterQuotaCooldown(details) {
    this.quotaCooldownUntil = Date.now() + CURSOR_CLASSIFICATION_COOLDOWNS.quota * 1e3;
    const error = new Error(
      `cursor-agent out of usage quota \u2014 cooling down ${Math.round(CURSOR_CLASSIFICATION_COOLDOWNS.quota * 1e3 / 6e4)}m: ${details}`
    );
    error.name = "CursorAgentQuotaError";
    error.status = 402;
    return error;
  }
  createQuotaCooldownError() {
    const secondsRemaining = Math.max(1, Math.ceil((this.quotaCooldownUntil - Date.now()) / 1e3));
    const error = new Error(
      `cursor-agent out of usage quota (cooldown ${secondsRemaining}s remaining)`
    );
    error.name = "CursorAgentQuotaError";
    error.status = 402;
    return error;
  }
};

// src/providers/cursor-provider.ts
import { existsSync as existsSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4 } from "path";
import Database from "better-sqlite3";
var CURSOR_API_URL = "https://api2.cursor.sh/v1";
var CURSOR_API_TIMEOUT_MS = 12e4;
var CURSOR_STORAGE_PATH = join4(
  homedir3(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb"
);
var CursorProvider = class extends BaseProvider {
  name = "cursor";
  modelKey;
  config;
  cachedToken = null;
  tokenExpiresAt = 0;
  storagePath;
  constructor(config, sanitizer) {
    super(sanitizer);
    this.config = config;
    this.modelKey = config.model ?? "claude-sonnet-4-6";
    this.storagePath = config.storagePath ?? CURSOR_STORAGE_PATH;
  }
  /**
   * Read the access token from Cursor's local SQLite storage.
   * Caches for 30 minutes to avoid hammering the DB.
   */
  getToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    if (!existsSync3(this.storagePath)) {
      throw new Error(
        "Cursor storage not found. Is Cursor installed? Expected: " + this.storagePath
      );
    }
    const db = new Database(this.storagePath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
      if (!row?.value) {
        throw new Error("No Cursor access token found. Log into Cursor first.");
      }
      this.cachedToken = row.value;
      this.tokenExpiresAt = Date.now() + 30 * 60 * 1e3;
      return this.cachedToken;
    } finally {
      db.close();
    }
  }
  async chat(messages, tools, opts) {
    const token = this.getToken();
    const sanitized = this.sanitizeMessages(messages);
    const openaiMessages = sanitized.map((m) => {
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.toolCallId
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
          }))
        };
      }
      return {
        role: m.role,
        content: m.content
      };
    });
    const body = {
      model: this.modelKey,
      messages: openaiMessages,
      max_tokens: this.config.maxTokens ?? 4096
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? { type: "object", properties: {} }
        }
      }));
    }
    const { signal, cleanup } = this.createRequestSignal(opts?.signal);
    let response;
    try {
      response = await fetch(`${CURSOR_API_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal
      });
    } finally {
      cleanup();
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      const error = new Error(`Cursor API error ${response.status}: ${errText.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Cursor API returned no choices");
    const toolCalls = [];
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        toolCalls.push({
          id: tc.id ?? `tc-${Date.now()}`,
          name: tc.function?.name ?? "",
          arguments: args
        });
      }
    }
    return {
      content: choice.message?.content ?? "",
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0
      },
      model: data.model ?? this.modelKey
    };
  }
  createRequestSignal(signal) {
    const timeoutSignal = AbortSignal.timeout(CURSOR_API_TIMEOUT_MS);
    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => {
      } };
    }
    const anySignal = AbortSignal.any;
    if (typeof anySignal === "function") {
      return { signal: anySignal([signal, timeoutSignal]), cleanup: () => {
      } };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    const onTimeout = () => controller.abort(
      new Error(`Cursor provider request timed out after ${CURSOR_API_TIMEOUT_MS}ms`)
    );
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      timeoutSignal.removeEventListener("abort", onTimeout);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });
    return { signal: controller.signal, cleanup };
  }
};

// src/providers/cursor-sdk-provider.ts
var DEFAULT_CURSOR_SDK_MODEL = "auto";
function modelSelectionId(model) {
  if (typeof model === "string") return model;
  if (!model || typeof model !== "object") return void 0;
  const id = model.id;
  return typeof id === "string" ? id : void 0;
}
function extractAssistantText(event) {
  if (!event || typeof event !== "object") return [];
  const typedEvent = event;
  if (typedEvent.type !== "assistant" || !Array.isArray(typedEvent.message?.content)) {
    return [];
  }
  const chunks = [];
  for (const block of typedEvent.message.content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text.length > 0) {
      chunks.push(typedBlock.text);
    }
  }
  return chunks;
}
var CursorSdkProvider = class {
  name = "cursor-sdk";
  modelKey;
  tier = "mid";
  billingMode = "subscription";
  capabilities = {
    supportsNativeTools: false,
    supportsStreaming: true,
    supportsStreamingTools: false,
    supportsLongContext: true
  };
  apiKey;
  model;
  workspace;
  agentName;
  agentPromise = null;
  metrics = {
    totalRequests: 0,
    totalDurationMs: 0,
    lastResponseMs: 0,
    avgResponseMs: 0,
    errors: 0
  };
  constructor(config = {}) {
    this.apiKey = config.apiKey ?? process.env.CURSOR_API_KEY;
    this.model = config.model ?? DEFAULT_CURSOR_SDK_MODEL;
    this.workspace = config.workspace ?? process.cwd();
    this.agentName = config.name ?? "Zaraa Cursor SDK";
    this.modelKey = this.model;
  }
  setApiKey(apiKey) {
    if (apiKey === this.apiKey) return;
    this.apiKey = apiKey;
    this.agentPromise = null;
  }
  async chat(messages, _tools, opts) {
    if (opts?.signal?.aborted) {
      throw this.createAbortError(opts.signal);
    }
    const start = Date.now();
    this.metrics.totalRequests++;
    try {
      const agent = await this.getAgent();
      const run = await this.withAbort(agent.send(this.formatMessages(messages)), opts?.signal);
      const result = await this.withAbort(run.wait(), opts?.signal, () => this.stopRun(run));
      const resultModel = modelSelectionId(result.model) ?? this.model;
      this.recordLatency(start);
      return {
        content: result.result ?? "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0 },
        model: resultModel
      };
    } catch (error) {
      this.recordError(start);
      throw error;
    }
  }
  async *chatStream(messages, _tools, opts) {
    if (opts?.signal?.aborted) {
      throw this.createAbortError(opts.signal);
    }
    const start = Date.now();
    this.metrics.totalRequests++;
    try {
      const agent = await this.getAgent();
      const run = await this.withAbort(agent.send(this.formatMessages(messages)), opts?.signal);
      const signal = opts?.signal;
      let onAbort;
      if (signal) {
        onAbort = () => {
          void this.stopRun(run);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        for await (const event of run.stream()) {
          if (signal?.aborted) {
            throw this.createAbortError(signal);
          }
          for (const text of extractAssistantText(event)) {
            yield {
              type: "text_delta",
              content: text,
              model: this.model
            };
          }
        }
      } finally {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
      const result = await this.withAbort(run.wait(), signal, () => this.stopRun(run));
      if (opts?.signal?.aborted) {
        throw this.createAbortError(opts.signal);
      }
      this.recordLatency(start);
      const status = result.status;
      yield {
        type: "done",
        finishReason: status === "finished" || status === "completed" ? "stop" : status,
        usage: { promptTokens: 0, completionTokens: 0 },
        model: modelSelectionId(result.model) ?? this.model
      };
    } catch (error) {
      this.recordError(start);
      throw error;
    }
  }
  async healthCheck() {
    if (!this.apiKey) {
      return {
        ok: false,
        error: "Cursor SDK provider requires a Cursor API key. Set CURSOR_API_KEY or configure auth/envVar for the cursor-sdk provider."
      };
    }
    try {
      await this.getAgent();
      return { ok: true, model: this.model };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async stopRun(run) {
    const typedRun = run;
    try {
      if (typeof typedRun.stop === "function") {
        await typedRun.stop();
        return;
      }
      if (typeof typedRun.cancel === "function") {
        await typedRun.cancel();
        return;
      }
    } catch {
    }
  }
  getMetrics() {
    return { ...this.metrics };
  }
  async getAgent() {
    if (!this.apiKey) {
      throw new Error(
        "Cursor SDK provider requires a Cursor API key. Set CURSOR_API_KEY or configure auth/envVar for the cursor-sdk provider."
      );
    }
    if (!this.agentPromise) {
      const { Agent } = await import("@cursor/sdk");
      this.agentPromise = Agent.create({
        apiKey: this.apiKey,
        name: this.agentName,
        model: { id: this.model },
        local: { cwd: this.workspace }
      });
    }
    try {
      return await this.agentPromise;
    } catch (error) {
      this.agentPromise = null;
      throw error;
    }
  }
  async withAbort(value, signal, onAbortCallback) {
    if (!signal) return value;
    if (signal.aborted) {
      throw this.createAbortError(signal);
    }
    return new Promise((resolve2, reject) => {
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const abortHandler = () => {
        const abortError = this.createAbortError(signal);
        const finalize = () => settle(() => reject(abortError));
        if (onAbortCallback) {
          Promise.resolve(onAbortCallback()).finally(finalize);
          return;
        }
        finalize();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      value.then((result) => {
        settle(() => {
          cleanup();
          resolve2(result);
        });
      }).catch((error) => {
        settle(() => {
          cleanup();
          reject(error);
        });
      });
    });
  }
  createAbortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error) {
      return reason;
    }
    const error = new Error("Request was aborted");
    error.name = "AbortError";
    return error;
  }
  formatMessages(messages) {
    return messages.map((message) => {
      const label = message.role === "tool" ? `Tool${message.toolCallId ? ` (${message.toolCallId})` : ""}` : message.role.charAt(0).toUpperCase() + message.role.slice(1);
      const toolCalls = message.toolCalls?.length ? `
Tool calls:
${message.toolCalls.map((call) => `- ${call.name} (${call.id}): ${JSON.stringify(call.arguments)}`).join("\n")}` : "";
      return `${label}:
${message.content}${toolCalls}`;
    }).join("\n\n").trim();
  }
  recordLatency(start) {
    const elapsed = Date.now() - start;
    this.metrics.totalDurationMs += elapsed;
    this.metrics.lastResponseMs = elapsed;
    this.metrics.avgResponseMs = this.metrics.totalRequests > 0 ? Math.round(this.metrics.totalDurationMs / this.metrics.totalRequests) : 0;
  }
  recordError(start) {
    this.metrics.errors++;
    this.recordLatency(start);
  }
};

// src/providers/provider-metadata.ts
var LONG_CONTEXT_THRESHOLD = 128e3;
var METERED_PRICING_RULES = [
  {
    match: (modelName) => /^gpt-5\.4-pro(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 30,
      completionPerMillionUsd: 180,
      source: "official-openai-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gpt-5\.4-mini(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.75,
      completionPerMillionUsd: 4.5,
      source: "official-openai-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gpt-5\.4-nano(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.2,
      completionPerMillionUsd: 1.25,
      source: "official-openai-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gpt-5\.4(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 2.5,
      completionPerMillionUsd: 15,
      source: "official-openai-2026-04-05"
    }
  },
  {
    match: (modelName) => /(?:^|\/)claude-opus-(?:4(?:\.1)?|4-6)(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 15,
      completionPerMillionUsd: 75,
      source: "official-anthropic-2026-04-05"
    }
  },
  {
    match: (modelName) => /(?:^|\/)claude-sonnet-(?:4|4-6|3\.7|3\.5)(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 3,
      completionPerMillionUsd: 15,
      source: "official-anthropic-2026-04-05"
    }
  },
  {
    match: (modelName) => /(?:^|\/)claude-haiku-3\.5(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.8,
      completionPerMillionUsd: 4,
      source: "official-anthropic-2026-04-05"
    }
  },
  {
    match: (modelName) => /(?:^|\/)claude-haiku-3(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.25,
      completionPerMillionUsd: 1.25,
      source: "official-anthropic-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gemini-2\.5-pro(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 1.25,
      completionPerMillionUsd: 10,
      source: "official-google-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gemini-2\.5-flash-lite(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.1,
      completionPerMillionUsd: 0.4,
      source: "official-google-2026-04-05"
    }
  },
  {
    match: (modelName) => /^gemini-2\.5-flash(?:$|[-:])/i.test(modelName),
    pricing: {
      promptPerMillionUsd: 0.3,
      completionPerMillionUsd: 2.5,
      source: "official-google-2026-04-05"
    }
  }
];
function normalizeModelName(modelName) {
  return modelName.toLowerCase().replace(/^[a-z0-9._-]+:/i, "");
}
function inferLongContextSupport(modelName, contextSize) {
  if ((contextSize ?? 0) >= LONG_CONTEXT_THRESHOLD) return true;
  return /^gpt-5\.4(?:$|[-:])/i.test(modelName) || /^gemini-2\.5-(?:pro|flash|flash-lite)(?:$|[-:])/i.test(modelName) || /(?:^|\/)claude-sonnet-4(?:$|[-:])/i.test(modelName) || /(?:^|\/)claude-(?:sonnet|fable|mythos)-5(?:$|[-:])/i.test(modelName);
}
function getProviderCapabilities(args) {
  const { providerType, model, provider } = args;
  const isLocalProvider = provider.billingMode === "local" || provider.tier === "local";
  const explicitSupportsNativeTools = provider.capabilities?.supportsNativeTools;
  const supportsNativeTools = explicitSupportsNativeTools ?? (providerType !== "cursor-agent" && providerType !== "cursor-sdk" && providerType !== "claude-cli" && providerType !== "ollama" && !isLocalProvider);
  const supportsStreaming = typeof provider.chatStream === "function";
  const supportsStreamingTools = supportsStreaming && supportsNativeTools && providerType !== "ollama" && !isLocalProvider;
  return {
    supportsNativeTools,
    supportsStreaming,
    supportsStreamingTools,
    supportsLongContext: provider.capabilities?.supportsLongContext ?? inferLongContextSupport(normalizeModelName(model), provider.contextSize)
  };
}
function getFallbackMeteredPricing(modelName) {
  if (/opus/i.test(modelName)) {
    return {
      promptPerMillionUsd: 15,
      completionPerMillionUsd: 75,
      source: "fallback-registry"
    };
  }
  if (/claude|gpt|gemini/i.test(modelName)) {
    return {
      promptPerMillionUsd: 3,
      completionPerMillionUsd: 15,
      source: "fallback-registry"
    };
  }
  return void 0;
}
function getProviderPricing(args) {
  const { model, billingMode } = args;
  if (billingMode !== "metered") {
    return {
      promptPerMillionUsd: 0,
      completionPerMillionUsd: 0,
      source: "effective-non-metered"
    };
  }
  const normalized = normalizeModelName(model);
  for (const rule of METERED_PRICING_RULES) {
    if (rule.match(normalized)) return rule.pricing;
  }
  return getFallbackMeteredPricing(normalized);
}
function attachProviderMetadata(args) {
  const { providerType, model, provider } = args;
  const billingMode = provider.billingMode ?? "metered";
  provider.capabilities = getProviderCapabilities({ providerType, model, provider });
  provider.pricing = getProviderPricing({ providerType, model, billingMode });
}
function providerSupportsNativeTools(provider) {
  return provider?.capabilities?.supportsNativeTools ?? false;
}
function providerSupportsStreaming(provider) {
  return provider?.capabilities?.supportsStreaming ?? typeof provider?.chatStream === "function";
}
function providerSupportsStreamingTools(provider) {
  return provider?.capabilities?.supportsStreamingTools ?? false;
}
function getProviderBlendedPricePerMillion(provider) {
  const prompt = provider?.pricing?.promptPerMillionUsd;
  const completion = provider?.pricing?.completionPerMillionUsd;
  if (prompt == null && completion == null) return null;
  if (prompt == null) return completion ?? null;
  if (completion == null) return prompt;
  return (prompt + completion) / 2;
}
function getRelativeMeteredCostScore(provider, billingMode) {
  if (!provider || billingMode !== "metered") return 0;
  const blended = getProviderBlendedPricePerMillion(provider);
  if (blended == null || blended <= 0) return 0;
  return Math.log10(1 + blended);
}
function estimateUsageCostUsd(args) {
  const { modelName, promptTokens, completionTokens, provider, billingMode } = args;
  if (billingMode !== "metered") return 0;
  const promptRate = provider?.pricing?.promptPerMillionUsd;
  const completionRate = provider?.pricing?.completionPerMillionUsd;
  if (promptRate != null || completionRate != null) {
    return (promptTokens * (promptRate ?? 0) + completionTokens * (completionRate ?? 0)) / 1e6;
  }
  const normalized = normalizeModelName(modelName);
  if (/opus/i.test(normalized)) {
    return (promptTokens + completionTokens) * 0.015 / 1e3;
  }
  if (/claude|gpt|gemini/i.test(normalized)) {
    return (promptTokens + completionTokens) * 3e-3 / 1e3;
  }
  return 0;
}

// src/providers/provider-factory.ts
var log4 = createLogger({ module: "provider-factory" });
function formatDisabledProvidersSkipMessage(names) {
  if (names.length === 0) return null;
  const list = names.join(", ");
  return `[provider-factory] skipping ${names.length} disabled provider(s): ${list}`;
}
var DISABLED_PROVIDERS_SKIP_LOG_COOLDOWN_MS = 24 * 60 * 6e4;
function disabledProvidersSkipSignature(names) {
  return [...names].map((n) => n.trim()).filter(Boolean).sort().join(",");
}
function shouldLogDisabledProvidersSkip(nowMs, lastLogAtMs, signature, lastSignature, cooldownMs = DISABLED_PROVIDERS_SKIP_LOG_COOLDOWN_MS) {
  if (!signature) return false;
  if (signature !== (lastSignature ?? "")) return true;
  if (lastLogAtMs == null || !Number.isFinite(lastLogAtMs) || lastLogAtMs <= 0) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(cooldownMs) || cooldownMs <= 0) return true;
  return nowMs - lastLogAtMs >= cooldownMs;
}
function parseDisabledProvidersSkipLogState(raw) {
  try {
    const o = JSON.parse(raw);
    const n = Number(o?.lastLogAtMs);
    const sig = typeof o?.signature === "string" ? o.signature : "";
    return {
      lastLogAtMs: Number.isFinite(n) && n > 0 ? n : 0,
      signature: sig
    };
  } catch {
    return { lastLogAtMs: 0, signature: "" };
  }
}
function serializeDisabledProvidersSkipLogState(lastLogAtMs, signature, nowMs = Date.now()) {
  return `${JSON.stringify({
    lastLogAtMs,
    signature,
    updatedAt: new Date(nowMs).toISOString()
  })}
`;
}
function disabledProvidersSkipLogPath(stateDir) {
  const homeDir = process.env.ZARAA_HOME_DIR?.trim() || homedir4();
  return join5(stateDir ?? join5(homeDir, ".zaraa", "state"), "disabled-providers-skip-log.json");
}
function noteDisabledProvidersSkipLog(names, nowMs = Date.now(), stateDir) {
  const message = formatDisabledProvidersSkipMessage(names);
  if (!message) return { shouldLog: false, message: null };
  const signature = disabledProvidersSkipSignature(names);
  const path = disabledProvidersSkipLogPath(stateDir);
  let lastLogAtMs = 0;
  let lastSignature = "";
  try {
    if (existsSync4(path)) {
      const parsed = parseDisabledProvidersSkipLogState(readFileSync3(path, "utf8"));
      lastLogAtMs = parsed.lastLogAtMs;
      lastSignature = parsed.signature;
    }
  } catch {
  }
  const shouldLog = shouldLogDisabledProvidersSkip(
    nowMs,
    lastLogAtMs,
    signature,
    lastSignature
  );
  if (shouldLog) {
    try {
      mkdirSync(dirname2(path), { recursive: true });
      writeFileSync(
        path,
        serializeDisabledProvidersSkipLogState(nowMs, signature, nowMs),
        "utf8"
      );
    } catch {
    }
  }
  return { shouldLog, message };
}
function normalizeProviderType(type) {
  if (type === "openai-compatible") return "custom";
  if (type === "xai") return "custom";
  return type;
}
function isLoopbackBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
function isLocalHttpProviderConfig(providerConfig) {
  if (!isLoopbackBaseUrl(providerConfig.baseUrl)) return false;
  return providerConfig.type === "openai" || providerConfig.type === "openai-compatible" || providerConfig.type === "custom";
}
function isProviderFactoryEnabled(providerConfig, modelControls) {
  const toggle = modelControls?.providers?.[providerConfig.name];
  return toggle ?? providerConfig.enabled !== false;
}
function isProviderFactoryModelEnabled(providerConfig, model, modelControls, allProviders) {
  if (!modelControls?.models) return true;
  return isModelEnabled(
    { providers: allProviders ?? [providerConfig], modelControls },
    model,
    providerConfig.name,
    "global"
  );
}
function getDefaultOllamaTimeoutMs(model, configuredTimeoutMs) {
  if (configuredTimeoutMs !== void 0) return configuredTimeoutMs;
  if (model === "qwen3.5-zaraa") return 45e3;
  if (isOrnithModelName(model)) return 45e3;
  if (model === "qwen35-opus-distilled") return 45e3;
  return void 0;
}
function getDefaultOllamaMaxOutputTokens(model, configuredMaxOutputTokens) {
  if (configuredMaxOutputTokens !== void 0) return configuredMaxOutputTokens;
  if (model === "qwen3.5-zaraa") return 384;
  return void 0;
}
function getDefaultOllamaFallbackModel(model, configuredFallback) {
  if (model === "qwen35-opus-distilled") return void 0;
  if (configuredFallback) return configuredFallback;
  return void 0;
}
function getDefaultOllamaKeepAlive(model, configuredKeepAlive) {
  if (configuredKeepAlive) return configuredKeepAlive;
  const modelLower = model.toLowerCase();
  const isHuge = /:(3[5-9]b|[4-9]\db|\d{3,}b)/i.test(model) || model.includes(":70b");
  if (modelLower.includes("phi4-mini")) return "5m";
  if (/e4b-qat/i.test(model) || isOrnithModelName(modelLower)) return "60m";
  if (model.includes("gemma4") || model.includes("gemma3")) return "15m";
  if (model.includes("opus-distilled")) return "10m";
  if (isHuge) return "5m";
  return "30m";
}
var KNOWN_LOCAL_MODEL_CONTEXTS = {
  "phi4-mini": 2048,
  "phi4-mini-zaraa": 2048,
  // The lightweight Gemma fallback now regularly sees ~2.2k-token live prompts
  // during operational and chat recoveries, so 2k causes avoidable 400s.
  "gemma-3-1b-local": 4096,
  "gemma4:e2b": 4096,
  "gemma4:2b": 4096,
  "gemma4-e2b-zaraa": 4096,
  "gemma4:e4b": 8192,
  "gemma4:4b": 8192,
  "gemma4-e4b-zaraa": 8192,
  // QAT E4B is the primary local tier (served via Ollama's OpenAI-compat shim
  // today; `-llamacpp` is the llama.cpp `llama-server` A/B arm). Both are the
  // 8K-ctx E4B model — keep them explicit so the openai-compatible/custom path
  // publishes the right contextSize instead of leaving it undefined.
  "gemma4-e4b-qat-zaraa": 8192,
  "gemma4-e4b-qat-llamacpp": 8192,
  "gemma3-zaraa": 8192,
  // Keep the live local deep model within a smaller KV/cache footprint on 16 GB
  // Macs. The broader stack already pages/summarizes aggressively, and the live
  // workload prompts are well below this ceiling, so 8k is a better latency/
  // stability trade-off than the old 16k default.
  "qwen3.5-zaraa": 8192,
  "qwen35-opus-distilled": 16384,
  // 23 GB MoE (3B active) on a 16 GB host — mmap-paged; 8k keeps the KV cache
  // small enough to be viable. Routed only to background/agent lanes, and only
  // if scripts/bench-qwen36.mjs passes its gate (see bench-qwen36-results.json).
  "qwen3.6:35b-a3b": 8192,
  // 9B 4Q Ornith used for escalation/risk-lane routing. Prompt + tool context
  // stays stable at 8k in current guardrails.
  "hf.co/deepreinforce-ai/ornith-1.0-9b-gguf:q4_k_m": 8192,
  "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M": 8192,
  "hf.co/deepreinforce-ai/orinth-1.0-9b-gguf:q4_k_m": 8192
};
function getKnownLocalModelContextSize(model) {
  const explicitContext = KNOWN_LOCAL_MODEL_CONTEXTS[model];
  if (explicitContext !== void 0) return explicitContext;
  return isOrnithModelName(model) ? 8192 : void 0;
}
function registerProviderModel(providerMap, provider, config) {
  for (const key of [
    config.model,
    `${config.providerName}:${config.model}`,
    ...(config.providerAliases ?? []).map((alias) => `${alias}:${config.model}`),
    ...config.aliases ?? []
  ]) {
    if (!key || providerMap.has(key)) continue;
    providerMap.set(key, provider);
  }
}
function buildProviderModelAliases(model, configuredAliases = []) {
  const aliases = [...configuredAliases];
  if (isOrnithModelName(model)) {
    aliases.push(
      "orinth",
      "ornith",
      "hf.co/deepreinforce-ai/orinth-1.0-9b-gguf:q4_k_m",
      "hf.co/deepreinforce-ai/ornith-1.0-9b-gguf:q4_k_m",
      "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M"
    );
  }
  return [...new Set(aliases.filter((alias) => alias && alias !== model))];
}
function getBillingModeForConfig(providerType, model, source = "metered") {
  if (providerType === "ollama") return "local";
  if (providerType === "claude-cli" || providerType === "codex" || providerType === "cursor" || providerType === "cursor-agent" || providerType === "cursor-sdk") {
    return "subscription";
  }
  if ((providerType === "openrouter" || providerType === "openai-compatible") && /:free$/i.test(model)) {
    return "free";
  }
  if (providerType === "openai" && source === "subscription") {
    return "subscription";
  }
  return source;
}
function buildAuthProfiles(providers) {
  const result = {};
  for (const p of providers) {
    if (p.type === "ollama" || p.type === "claude-cli" || p.type === "codex" || p.type === "cursor" || p.type === "cursor-sdk" || p.type === "cursor-agent") {
      continue;
    }
    const rawKeys = p.keys ?? [];
    if (rawKeys.length > 0) {
      result[p.name] = rawKeys.map((key, idx) => ({
        key,
        label: `${p.name}-${idx}`
      }));
    } else if (p.apiKey) {
      result[p.name] = [{ key: p.apiKey, label: `${p.name}-0` }];
    }
  }
  return result;
}
async function createProviders(config) {
  const { dataDir } = config;
  const localOnly = config.privacy.networkMode === "local-only";
  const providers = localOnly ? (config.providers ?? []).filter((provider) => isLocalOnlyProviderConfig(provider)) : config.providers ?? [];
  let codexTokenManager = null;
  let openaiTokenManager = null;
  const runtimeHomeDir = config.homeDir ?? (process.env.ZARAA_HOME_DIR?.trim() || homedir4());
  const runtimeConfigDir = config.configDir ?? join5(runtimeHomeDir, ".zaraa");
  const codexAuthFilePath = join5(runtimeHomeDir, ".codex", "auth.json");
  const openAIAuthFilePath = join5(runtimeConfigDir, "openai-auth.json");
  const grokAuthFilePath = join5(runtimeHomeDir, ".grok", "auth.json");
  const grokTokenManager = new GrokCliTokenManager({
    authPath: grokAuthFilePath,
    grokBin: join5(runtimeHomeDir, ".grok", "bin", "grok")
  });
  const authProfiles = buildAuthProfiles(providers ?? []);
  if (!providers?.length) {
    return {
      router: null,
      keychain: null,
      sanitizer: new PromptSanitizer({ neverSendPatterns: [], confidentialPaths: [] }),
      codexTokenManager: null,
      openaiTokenManager: null,
      authProfiles
    };
  }
  let keychain = null;
  const keychainPath = dataDir === ":memory:" ? void 0 : `${dataDir}/secrets.enc`;
  try {
    keychain = new Keychain({
      service: "zaraa",
      ...keychainPath && { storagePath: keychainPath }
    });
  } catch (err) {
    log4.debug(
      `[provider-factory] non-fatal: keychain init failed: ${err instanceof Error ? err.message : err}`
    );
  }
  const resolver = new CredentialResolver({
    keychain: keychain ?? void 0,
    grokAuthPath: grokAuthFilePath
  });
  const getOrCreateCodexTokenManager = () => {
    if (!codexTokenManager) {
      codexTokenManager = new CodexTokenManager(codexAuthFilePath, openAIAuthFilePath);
    }
    return codexTokenManager;
  };
  const getOrCreateOpenAITokenManager = () => {
    if (!openaiTokenManager) {
      openaiTokenManager = new OpenAITokenManager(openAIAuthFilePath, codexAuthFilePath);
    }
    return openaiTokenManager;
  };
  if (providers.some((p) => p.type === "openai" && p.auth === "oauth")) {
    getOrCreateOpenAITokenManager();
  }
  const sanitizer = new PromptSanitizer({
    neverSendPatterns: config.privacy.neverSendPatterns ?? [],
    confidentialPaths: config.privacy.confidential ?? []
  });
  const providerMap = /* @__PURE__ */ new Map();
  const skippedDisabled = [];
  for (const providerConfig of providers) {
    if (!isProviderFactoryEnabled(providerConfig, config.modelControls)) {
      skippedDisabled.push(providerConfig.name);
      continue;
    }
    try {
      const providerType = normalizeProviderType(providerConfig.type);
      const models = providerConfig.models.filter(
        (model) => isProviderFactoryModelEnabled(
          providerConfig,
          model,
          config.modelControls,
          providers
        )
      );
      if (models.length === 0) continue;
      if (providerType === "claude-cli") {
        const claudeHealth = await new ClaudeCliProvider().healthCheck();
        if (!claudeHealth.ok) {
          log4.warn(
            `[provider-factory] skipping Claude CLI provider "${providerConfig.name}": ${claudeHealth.error ?? "unavailable"}`
          );
          continue;
        }
        for (const model of models) {
          const provider = new ClaudeCliProvider({
            model,
            maxTurns: providerConfig.maxTurns ?? 5,
            timeoutMs: providerConfig.timeoutMs ?? 3e5,
            permissionMode: providerConfig.permissionMode
          });
          provider.modelKey = model;
          provider.tier = "mid";
          provider.billingMode = getBillingModeForConfig(
            providerConfig.type,
            model,
            "subscription"
          );
          attachProviderMetadata({ providerType: providerConfig.type, model, provider });
          registerProviderModel(providerMap, provider, {
            model,
            providerName: providerConfig.name,
            providerAliases: providerConfig.aliases,
            aliases: buildProviderModelAliases(model, providerConfig.modelAliases?.[model])
          });
        }
        continue;
      }
      if (providerType === "codex") {
        const tokenManager = new CodexTokenManager(codexAuthFilePath, openAIAuthFilePath);
        for (const model of models) {
          const provider = new CodexApiProvider(
            {
              model,
              tokenManager
            },
            sanitizer
          );
          provider.modelKey = model;
          provider.tier = "mid";
          provider.billingMode = getBillingModeForConfig(
            providerConfig.type,
            model,
            "subscription"
          );
          attachProviderMetadata({ providerType: providerConfig.type, model, provider });
          registerProviderModel(providerMap, provider, {
            model,
            providerName: providerConfig.name,
            providerAliases: providerConfig.aliases,
            aliases: buildProviderModelAliases(model, providerConfig.modelAliases?.[model])
          });
        }
        if (!codexTokenManager) codexTokenManager = tokenManager;
        continue;
      }
      if (providerType === "cursor-agent") {
        let apiKey;
        try {
          const credential = await resolver.resolve(providerConfig);
          apiKey = credential?.apiKey?.trim() || void 0;
        } catch (err) {
          log4.warn(
            `[provider-factory] Credential resolution failed for cursor-agent \u2014 continuing with CLI login/env: ${err instanceof Error ? err.message : err}`
          );
        }
        for (const model of models) {
          const provider = new CursorAgentProvider({
            model,
            timeoutMs: providerConfig.timeoutMs ?? 6e5,
            cliTimeouts: providerConfig.cliTimeouts,
            force: providerConfig.force ?? false,
            trust: providerConfig.trust ?? false,
            workingDir: providerConfig.workspace,
            binaryPath: providerConfig.binaryPath,
            apiKey
          });
          provider.modelKey = model;
          provider.tier = "mid";
          provider.billingMode = getBillingModeForConfig(
            providerConfig.type,
            model,
            "subscription"
          );
          attachProviderMetadata({ providerType: providerConfig.type, model, provider });
          registerProviderModel(providerMap, provider, {
            model,
            providerName: providerConfig.name,
            providerAliases: providerConfig.aliases,
            aliases: [
              ...buildProviderModelAliases(model, providerConfig.modelAliases?.[model]),
              ...providerConfig.name === "cursor-agent" ? [] : [`cursor-agent:${model}`]
            ]
          });
        }
        continue;
      }
      if (providerType === "cursor-sdk") {
        if (cursorSdkInlineApiKeyForbidden(providerConfig)) {
          log4.warn(
            `[provider-factory] skipping Cursor SDK provider "${providerConfig.name}" \u2014 inline apiKey in config is not allowed; use env or keychain`
          );
          continue;
        }
        const credential = await resolver.resolve(providerConfig);
        if (!credential?.apiKey) {
          log4.warn(
            `[provider-factory] Skipping Cursor SDK provider "${providerConfig.name}" - no credentials available`
          );
          continue;
        }
        for (const model of models) {
          const provider = new CursorSdkProvider({
            apiKey: credential.apiKey,
            model,
            workspace: providerConfig.workspace,
            name: providerConfig.name
          });
          provider.modelKey = model;
          provider.tier = "mid";
          provider.billingMode = getBillingModeForConfig(
            providerConfig.type,
            model,
            "subscription"
          );
          attachProviderMetadata({ providerType: providerConfig.type, model, provider });
          registerProviderModel(providerMap, provider, {
            model,
            providerName: providerConfig.name,
            providerAliases: providerConfig.aliases,
            aliases: [
              ...buildProviderModelAliases(model, providerConfig.modelAliases?.[model]),
              ...providerConfig.name === "cursor-sdk" ? [] : [`cursor-sdk:${model}`]
            ]
          });
        }
        continue;
      }
      if (providerType === "ollama") {
        let ollamaCred = null;
        try {
          ollamaCred = await resolver.resolve(providerConfig);
        } catch (err) {
          log4.warn(
            `[provider-factory] Credential resolution failed for ollama \u2014 continuing without auth: ${err instanceof Error ? err.message : err}`
          );
        }
        for (const model of models) {
          const keepAlive = getDefaultOllamaKeepAlive(model, providerConfig.keepAlive);
          const provider = new OllamaProvider({
            model,
            baseUrl: providerConfig.baseUrl,
            apiKey: ollamaCred?.apiKey,
            numCtx: getKnownLocalModelContextSize(model) ?? await detectOptimalContext(model),
            temperature: 0.3,
            keepAlive,
            timeoutMs: getDefaultOllamaTimeoutMs(model, providerConfig.timeoutMs),
            maxOutputTokens: getDefaultOllamaMaxOutputTokens(model, providerConfig.maxOutputTokens),
            fallbackModel: getDefaultOllamaFallbackModel(model, providerConfig.fallbackModel),
            caveman: providerConfig.caveman
          });
          provider.modelKey = model;
          provider.tier = "local";
          provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "local");
          attachProviderMetadata({ providerType: providerConfig.type, model, provider });
          registerProviderModel(providerMap, provider, {
            model,
            providerName: providerConfig.name,
            providerAliases: providerConfig.aliases,
            aliases: buildProviderModelAliases(model, providerConfig.modelAliases?.[model])
          });
        }
        continue;
      }
      for (const model of models) {
        const instance = await createSingleProvider(
          providerConfig,
          model,
          resolver,
          sanitizer,
          getOrCreateCodexTokenManager,
          getOrCreateOpenAITokenManager,
          () => grokTokenManager.getAccessToken(),
          { codexAuthFilePath, openAIAuthFilePath },
          config.anthropicPromptCaching
        );
        if (!instance) {
          log4.warn(
            `[provider-factory] Skipping provider "${providerConfig.type}" \u2014 no credentials available`
          );
          break;
        }
        instance.modelKey = model;
        instance.tier = providerType === "anthropic" ? "frontier" : isLocalHttpProviderConfig(providerConfig) ? "local" : "mid";
        if (!instance.billingMode) {
          instance.billingMode = getBillingModeForConfig(providerConfig.type, model);
        }
        attachProviderMetadata({ providerType: providerConfig.type, model, provider: instance });
        registerProviderModel(providerMap, instance, {
          model,
          providerName: providerConfig.name,
          providerAliases: providerConfig.aliases,
          aliases: buildProviderModelAliases(model, providerConfig.modelAliases?.[model])
        });
      }
    } catch (err) {
      log4.error(
        `[provider-factory] Failed to create provider "${providerConfig.type}": ${err instanceof Error ? err.message : err}`
      );
    }
  }
  const { shouldLog: logDisabledSkip, message: disabledSkipMsg } = noteDisabledProvidersSkipLog(skippedDisabled, Date.now(), config.stateDir);
  if (logDisabledSkip && disabledSkipMsg) log4.warn(disabledSkipMsg);
  if (providerMap.size === 0) {
    return {
      router: null,
      keychain,
      sanitizer,
      codexTokenManager: null,
      openaiTokenManager: null,
      authProfiles
    };
  }
  const routing = mergeRoutingDefaults(config.models, providers, { localOnly });
  const router = new ModelRouter({
    providers: providerMap,
    routing
  });
  return { router, keychain, sanitizer, codexTokenManager, openaiTokenManager, authProfiles };
}
async function createSingleProvider(providerConfig, model, resolver, sanitizer, getCodexTokenManager, getOpenAITokenManager, getGrokAccessToken, authPaths, anthropicPromptCaching) {
  const providerType = normalizeProviderType(providerConfig.type);
  const isLocalHttpProvider = isLocalHttpProviderConfig(providerConfig);
  if (providerType === "ollama") {
    const ollamaCred = await resolver.resolve(providerConfig);
    const provider = new OllamaProvider({
      model,
      baseUrl: providerConfig.baseUrl,
      apiKey: ollamaCred?.apiKey,
      keepAlive: getDefaultOllamaKeepAlive(model, providerConfig.keepAlive),
      timeoutMs: getDefaultOllamaTimeoutMs(model, providerConfig.timeoutMs),
      maxOutputTokens: getDefaultOllamaMaxOutputTokens(model, providerConfig.maxOutputTokens),
      fallbackModel: getDefaultOllamaFallbackModel(model, providerConfig.fallbackModel),
      caveman: providerConfig.caveman
    });
    provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "local");
    return provider;
  }
  if (providerType === "cursor") {
    if (!providerConfig.allowLegacyLocalStorageAuth) {
      log4.warn(
        `[provider-factory] skipping legacy Cursor REST provider "${providerConfig.name}": set allowLegacyLocalStorageAuth: true to opt into Cursor local-storage auth`
      );
      return null;
    }
    const provider = new CursorProvider({ model }, sanitizer);
    provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "subscription");
    return provider;
  }
  if (providerType === "openai") {
    if (providerConfig.auth === "oauth" && hasOpenAISessionModelAccess(authPaths.openAIAuthFilePath)) {
      const provider = new OpenAISessionProvider(
        { model, tokenManager: getOpenAITokenManager() },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "subscription");
      return provider;
    }
    const credential2 = await resolver.resolve(providerConfig);
    if (credential2) {
      const provider = new OpenAIProvider(
        {
          apiKey: credential2.apiKey,
          model,
          baseUrl: providerConfig.baseUrl,
          caveman: providerConfig.caveman
        },
        sanitizer
      );
      provider.billingMode = isLocalHttpProvider ? "local" : getBillingModeForConfig(providerConfig.type, model, "metered");
      return provider;
    }
    if (hasOpenAISessionModelAccess(authPaths.openAIAuthFilePath)) {
      const provider = new OpenAISessionProvider(
        { model, tokenManager: getOpenAITokenManager() },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "subscription");
      return provider;
    }
    if (hasOpenAISessionAuth(authPaths.openAIAuthFilePath)) {
      log4.warn(
        `[provider-factory] OpenAI session auth is present but lacks inference scope \u2014 skipping OpenAI session provider for "${model}"`
      );
    }
    const allowsSessionFallback = !providerConfig.auth || providerConfig.auth === "none";
    const hasSessionAuth = allowsSessionFallback && hasCodexSessionAuth(authPaths.codexAuthFilePath);
    const hasSessionInferenceAccess = hasSessionAuth && hasCodexSessionInferenceAccess(authPaths.codexAuthFilePath);
    if (hasSessionInferenceAccess) {
      const provider = new OpenAISessionProvider(
        {
          model,
          tokenManager: getCodexTokenManager()
        },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "subscription");
      return provider;
    }
    if (hasSessionAuth) {
      log4.warn(
        `[provider-factory] Codex session auth is present but lacks OpenAI API inference scopes \u2014 skipping OpenAI session fallback for "${model}"`
      );
    }
    return null;
  }
  if (providerType === "cursor-sdk") {
    const credential2 = await resolver.resolve(providerConfig);
    if (!credential2) return null;
    const provider = new CursorSdkProvider({
      apiKey: credential2.apiKey,
      model,
      workspace: providerConfig.workspace,
      name: providerConfig.name
    });
    provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "subscription");
    return provider;
  }
  const credential = await resolver.resolve(providerConfig);
  if (!credential) return null;
  switch (providerType) {
    case "anthropic": {
      const provider = new AnthropicProvider(
        {
          apiKey: credential.apiKey,
          model,
          baseUrl: providerConfig.baseUrl,
          promptCaching: anthropicPromptCaching
        },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "metered");
      return provider;
    }
    case "openrouter": {
      const provider = new OpenAIProvider(
        {
          apiKey: credential.apiKey,
          model,
          baseUrl: providerConfig.baseUrl || "https://openrouter.ai/api/v1",
          caveman: providerConfig.caveman
        },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(
        providerConfig.type,
        model,
        /:free$/i.test(model) ? "free" : "metered"
      );
      return provider;
    }
    case "xai": {
      const provider = new OpenAIProvider(
        {
          apiKey: credential.apiKey,
          model,
          baseUrl: providerConfig.baseUrl || "https://api.x.ai/v1",
          caveman: providerConfig.caveman
        },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "metered");
      return provider;
    }
    case "gemini": {
      const provider = new GeminiProvider(
        {
          apiKey: credential.apiKey,
          model
        },
        sanitizer
      );
      provider.billingMode = getBillingModeForConfig(providerConfig.type, model, "metered");
      return provider;
    }
    case "custom": {
      const baseUrl = providerConfig.baseUrl || (providerConfig.type === "xai" ? "https://api.x.ai/v1" : void 0);
      if (!baseUrl) return null;
      const provider = new OpenAIProvider(
        {
          apiKey: credential.apiKey,
          apiKeyProvider: credential.source === "oauth" ? getGrokAccessToken : void 0,
          model,
          baseUrl,
          caveman: providerConfig.caveman,
          reasoningEffort: providerConfig.reasoningEffort
        },
        sanitizer
      );
      provider.billingMode = isLocalHttpProvider ? "local" : getBillingModeForConfig(providerConfig.type, model, "metered");
      if (isLocalHttpProvider) {
        provider.contextSize = getKnownLocalModelContextSize(model);
      }
      return provider;
    }
    default:
      return null;
  }
}
function isOrnithModelName(model) {
  const normalized = model.toLowerCase();
  return normalized.includes("ornith") || normalized.includes("orinth");
}
var _ctxCache = /* @__PURE__ */ new Map();
async function detectOptimalContext(model) {
  const cacheKey = model || "_default";
  const cached = _ctxCache.get(cacheKey);
  if (cached !== void 0) return cached;
  let baseCtx;
  try {
    const os = await import("os");
    const totalGB = os.totalmem() / 1024 ** 3;
    if (totalGB <= 8) baseCtx = 4096;
    else if (totalGB <= 16) baseCtx = 8192;
    else if (totalGB <= 32) baseCtx = 16384;
    else baseCtx = 32768;
  } catch (err) {
    log4.debug(
      `[provider-factory] non-fatal: RAM detection failed, using default context: ${err instanceof Error ? err.message : err}`
    );
    baseCtx = 8192;
  }
  if (model) {
    const lower = model.toLowerCase();
    const isTiny = lower.includes("phi4-mini") || lower.includes("phi3-mini") || lower.includes("tinyllama") || lower.includes("gemma:2b") || lower.includes("gemma3-zaraa") || lower.includes("gemma3:4b");
    const isSmall = lower.includes(":8b") || lower.includes("mistral") || lower.includes("qwen2.5-coder") || lower.includes("gemma:7b");
    const isLarge = /:(3[5-9]b|[4-9]\db|\d{3,}b)/i.test(model) || lower.includes(":70b");
    const isMedium = !isLarge && (lower.includes("qwen3.5") || lower.includes("opus-distilled") || lower.includes(":13b") || lower.includes(":14b") || lower.includes("codellama:13b"));
    if (isLarge) baseCtx = Math.floor(baseCtx * 0.4);
    else if (isMedium) baseCtx = Math.floor(baseCtx * 0.5);
    else if (isSmall) baseCtx = Math.floor(baseCtx * 0.75);
    else if (!isTiny) baseCtx = Math.floor(baseCtx * 0.4);
  }
  baseCtx = Math.max(baseCtx, 2048);
  _ctxCache.set(cacheKey, baseCtx);
  return baseCtx;
}

// src/zaraacoder/blocking-error.ts
var DEFAULT_NEXT_ACTION = {
  "model-invalid-json": "Retry the model call with strict JSON-only instructions.",
  "model-invalid-response": "Retry the model call with the required Zaraacoder response schema.",
  "unsafe-inspection-path": "Inspect only relative text files inside the Zaraacoder worktree.",
  "denied-capability": "Ask the operator to approve the capability or revise the plan to stay within policy.",
  "edit-rejected": "Review the requested edit path and retry with a safe worktree-relative target.",
  "command-denied": "Use an allowlisted verification command or update Zaraacoder policy.",
  "verification-failed": "Inspect the failed check output, fix the cause, and rerun verification.",
  "executor-unavailable": "Configure a Zaraacoder executor before running full task mode."
};
var ZaraacoderBlockingError = class extends Error {
  reason;
  constructor(input) {
    super(input.message);
    this.name = "ZaraacoderBlockingError";
    this.reason = {
      code: input.code,
      message: input.message,
      safestNextAction: input.safestNextAction ?? DEFAULT_NEXT_ACTION[input.code],
      ...input.details ? { details: input.details } : {}
    };
  }
};
function isZaraacoderBlockingError(error) {
  return error instanceof ZaraacoderBlockingError;
}
function messageFromUnknown(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function blockedReasonFromError(error, phase) {
  if (!isZaraacoderBlockingError(error)) return null;
  return { ...error.reason, phase };
}
function createBlockedPlan(reason) {
  return {
    summary: `Zaraacoder blocked during ${reason.phase}: ${reason.message}`,
    steps: ["Review the blocked reason", reason.safestNextAction],
    filesToInspect: [],
    verificationCommands: [],
    risks: [`${reason.code}: ${reason.message}`],
    doneCriteria: ["Operator reviews the blocker and chooses the next safe action"]
  };
}
function createBlockedReview(input) {
  const edits = input.edits ?? [];
  const checks = input.checks ?? [];
  const changedFiles = [...new Set(edits.map((edit) => edit.path))];
  return {
    status: "blocked",
    summary: "Zaraacoder task is blocked pending operator review.",
    evidence: [
      `${edits.length} edit(s) recorded before blocker`,
      `${checks.filter((check) => check.exitCode === 0).length} check(s) passed before blocker`,
      `${checks.filter((check) => check.exitCode !== 0).length} check(s) failed before blocker`
    ],
    risks: [`${input.reason.code}: ${input.reason.message}`],
    changedFiles,
    checks,
    blockedReason: input.reason
  };
}
function asBlockingError(error, fallback) {
  if (isZaraacoderBlockingError(error)) return error;
  return new ZaraacoderBlockingError({
    ...fallback,
    message: fallback.message || messageFromUnknown(error),
    details: {
      ...fallback.details ?? {},
      cause: messageFromUnknown(error)
    }
  });
}

// src/zaraacoder/executor-adapter.ts
function assertPolicyValid(policy) {
  if (!Number.isSafeInteger(policy.maxToolCalls) || policy.maxToolCalls < 0) {
    throw new Error("Zaraacoder executor policy maxToolCalls must be a non-negative safe integer");
  }
}
function assertCapabilityAllowed(capability, policy) {
  switch (capability) {
    case "network":
      if (!policy.allowNetwork) {
        throw new ZaraacoderBlockingError({
          code: "denied-capability",
          message: "Zaraacoder executor requested network access, but policy denies it",
          safestNextAction: "Ask the operator to approve network access or revise the plan to use local context only."
        });
      }
      return;
    case "package-install":
      if (!policy.allowPackageInstall) {
        throw new ZaraacoderBlockingError({
          code: "denied-capability",
          message: "Zaraacoder executor requested package install, but policy denies it",
          safestNextAction: "Ask the operator to approve package installation or revise the plan to avoid new dependencies."
        });
      }
      return;
    default:
      throw new ZaraacoderBlockingError({
        code: "denied-capability",
        message: `Zaraacoder executor requested unknown capability: ${String(capability)}`
      });
  }
}
function assertCapabilitiesAllowed(capabilities, policy) {
  if (capabilities === void 0) return;
  if (!Array.isArray(capabilities)) {
    throw new ZaraacoderBlockingError({
      code: "denied-capability",
      message: "Zaraacoder executor requested malformed capabilities"
    });
  }
  for (const capability of capabilities) {
    assertCapabilityAllowed(capability, policy);
  }
}
function createZaraacoderExecutorAdapter(input) {
  return async (context) => {
    assertPolicyValid(input.policy);
    assertCapabilitiesAllowed(input.requiredCapabilities, input.policy);
    if (!input.planner) {
      throw new ZaraacoderBlockingError({
        code: "executor-unavailable",
        message: "Zaraacoder executor planner is not configured"
      });
    }
    const result = await input.planner(context, input.policy);
    assertCapabilitiesAllowed(result.requestedCapabilities, input.policy);
    return {
      plan: result.plan,
      edits: result.edits,
      checks: result.checks
    };
  };
}

// src/zaraacoder/isolated-executor.ts
import { fork } from "child_process";
import { randomUUID } from "crypto";
import { existsSync as existsSync5 } from "fs";
import { fileURLToPath } from "url";
var WORKER_RUN_MESSAGE = "zaraacoder.executor.run";
var WORKER_RESULT_MESSAGE = "zaraacoder.executor.result";
var WORKER_ERROR_MESSAGE = "zaraacoder.executor.error";
function configuredExecutorWorkerPath() {
  const bundledPath = fileURLToPath(
    new URL("./zaraacoder/configured-executor-worker.js", import.meta.url)
  );
  if (existsSync5(bundledPath)) return bundledPath;
  return fileURLToPath(new URL("./configured-executor-worker.js", import.meta.url));
}
function stderrPreview(chunks) {
  const text = chunks.join("").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
function errorFromWorker(message, label) {
  if (message.blockingReason) {
    return new ZaraacoderBlockingError(message.blockingReason);
  }
  const error = new Error(message.message || `${label} failed inside isolated worker`);
  error.name = message.name || "ZaraacoderIsolatedExecutorError";
  if (message.stack) {
    error.stack = message.stack;
  }
  return error;
}
function serializableContext(context) {
  const { signal: _signal, onExecutorRoute: _onExecutorRoute, ...rest } = context;
  return rest;
}
function createIsolatedZaraacoderExecutor(input) {
  const label = input.label ?? "Zaraacoder isolated executor";
  return (context) => new Promise((resolve2, reject) => {
    if (context.signal?.aborted) {
      reject(new Error(`${label} aborted before worker start`));
      return;
    }
    const requestId = randomUUID();
    const stderrChunks = [];
    const child = fork(input.workerPath, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let settled = false;
    let killTimer = null;
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      context.signal?.removeEventListener("abort", onAbort);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stderr?.removeAllListeners("data");
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const killChild = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1e3);
      }
    };
    function onAbort() {
      killChild();
      finish(() => reject(new Error(`${label} aborted`)));
    }
    function onMessage(raw) {
      const message2 = raw;
      if (!message2 || message2.requestId !== requestId) return;
      if (message2.type === WORKER_RESULT_MESSAGE) {
        finish(() => resolve2(message2.result));
        return;
      }
      if (message2.type === WORKER_ERROR_MESSAGE) {
        finish(() => reject(errorFromWorker(message2.error, label)));
      }
    }
    function onError(error) {
      finish(() => reject(error));
    }
    function onExit(code, signal) {
      const stderr = stderrPreview(stderrChunks);
      const detail = stderr ? `: ${stderr}` : "";
      finish(
        () => reject(
          new Error(
            `${label} exited before responding with code ${code ?? "null"} signal ${signal ?? "null"}${detail}`
          )
        )
      );
    }
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
      while (stderrChunks.join("").length > 2e3) stderrChunks.shift();
    });
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const message = {
      type: WORKER_RUN_MESSAGE,
      requestId,
      request: input.buildRequest(context)
    };
    try {
      child.send(message);
    } catch (error) {
      killChild();
      finish(() => reject(error));
    }
  });
}
function createIsolatedConfiguredZaraacoderExecutor(input) {
  return createIsolatedZaraacoderExecutor({
    workerPath: input.workerPath ?? configuredExecutorWorkerPath(),
    label: "Zaraacoder configured executor",
    buildRequest: (context) => ({
      config: input.config,
      dataDir: input.dataDir,
      model: input.model,
      policy: input.policy,
      context: serializableContext(context)
    })
  });
}
var zaraacoderIsolatedExecutorProtocol = {
  run: WORKER_RUN_MESSAGE,
  result: WORKER_RESULT_MESSAGE,
  error: WORKER_ERROR_MESSAGE
};

// src/zaraacoder/file-inspector.ts
import { lstat, readFile, realpath } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";
var DEFAULT_MAX_INSPECTION_BYTES_PER_FILE = 4e4;
function assertInsideWorktree(root, target, requestedPath) {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ZaraacoderBlockingError({
      code: "unsafe-inspection-path",
      message: `Refusing to inspect outside Zaraacoder worktree: ${requestedPath}`
    });
  }
}
function normalizeRelativePath(relativePath) {
  if (isAbsolute(relativePath)) {
    throw new ZaraacoderBlockingError({
      code: "unsafe-inspection-path",
      message: `Zaraacoder inspection path must be relative: ${relativePath}`
    });
  }
  if (!relativePath.trim()) {
    throw new ZaraacoderBlockingError({
      code: "unsafe-inspection-path",
      message: "Zaraacoder inspection path must be non-empty"
    });
  }
  return relativePath;
}
function assertTextFile(buffer, requestedPath) {
  if (buffer.includes(0)) {
    throw new ZaraacoderBlockingError({
      code: "unsafe-inspection-path",
      message: `Refusing to inspect binary Zaraacoder file: ${requestedPath}`
    });
  }
}
async function loadZaraacoderInspectedFiles(input) {
  const root = resolve(input.repoRoot);
  const realRoot = await realpath(root);
  const maxBytesPerFile = input.maxBytesPerFile ?? DEFAULT_MAX_INSPECTION_BYTES_PER_FILE;
  if (!Number.isSafeInteger(maxBytesPerFile) || maxBytesPerFile < 1) {
    throw new ZaraacoderBlockingError({
      code: "unsafe-inspection-path",
      message: "Zaraacoder maxBytesPerFile must be a positive safe integer"
    });
  }
  const uniquePaths = [...new Set(input.relativePaths.map(normalizeRelativePath))];
  const inspected = [];
  for (const requestedPath of uniquePaths) {
    const target = resolve(root, requestedPath);
    assertInsideWorktree(root, target, requestedPath);
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new ZaraacoderBlockingError({
        code: "unsafe-inspection-path",
        message: `Refusing to inspect symlink Zaraacoder file: ${requestedPath}`
      });
    }
    if (!stats.isFile()) {
      throw new ZaraacoderBlockingError({
        code: "unsafe-inspection-path",
        message: `Refusing to inspect non-regular file: ${requestedPath}`
      });
    }
    const realTarget = await realpath(target);
    assertInsideWorktree(realRoot, realTarget, requestedPath);
    const buffer = await readFile(realTarget);
    assertTextFile(buffer, requestedPath);
    const truncated = buffer.byteLength > maxBytesPerFile;
    const content = buffer.subarray(0, maxBytesPerFile).toString("utf-8");
    inspected.push({
      relativePath: requestedPath,
      content,
      truncated,
      bytes: buffer.byteLength
    });
  }
  return inspected;
}

// src/zaraacoder/model-planner.ts
var MAX_INSPECTION_FILES = 8;
var INVALID_JSON_PREVIEW_CHARS = 500;
var DEFAULT_VERIFICATION_CHECK = ["git", "diff", "--check"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertString(value, path) {
  if (typeof value !== "string") {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: `Zaraacoder model plan ${path} must be a string`
    });
  }
  return value;
}
function assertStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: `Zaraacoder model plan ${path} must be an array of strings`
    });
  }
  return value;
}
function assertCommandArray(value, path) {
  if (!Array.isArray(value)) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: `Zaraacoder model plan ${path} must be an array`
    });
  }
  return value.map((command, index) => {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
      throw new ZaraacoderBlockingError({
        code: "model-invalid-response",
        message: `Zaraacoder model plan ${path}[${index}] must be a non-empty string array`
      });
    }
    return command;
  });
}
function redactModelPreview(raw) {
  return raw.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]").replace(/ghp_[A-Za-z0-9_]+/g, "ghp_[REDACTED]").replace(/AKIA[A-Z0-9]+/g, "AKIA[REDACTED]");
}
function rawPreview(raw) {
  const preview = raw.length > INVALID_JSON_PREVIEW_CHARS ? `${raw.slice(0, INVALID_JSON_PREVIEW_CHARS)}...` : raw;
  return redactModelPreview(preview);
}
function fencedJsonCandidate(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() || null;
}
function embeddedJsonObjectCandidates(raw) {
  const candidates = [];
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let escaped = false;
    let inString = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(start, index + 1).trim());
          break;
        }
      }
    }
  }
  return candidates;
}
function jsonCandidates(raw) {
  const trimmed = raw.trim();
  return [trimmed, fencedJsonCandidate(raw), ...embeddedJsonObjectCandidates(raw)].filter(
    (candidate, index, candidates) => {
      return Boolean(candidate) && candidates.indexOf(candidate) === index;
    }
  );
}
function parseJson(raw) {
  if (typeof raw !== "string") return raw;
  let parseError = "unknown parse error";
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    return JSON.parse(raw.trim());
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    throw new ZaraacoderBlockingError({
      code: "model-invalid-json",
      message: "Zaraacoder model planner response must be valid JSON",
      details: {
        parseError,
        rawPreview: rawPreview(raw)
      }
    });
  }
}
function parsePlan(value) {
  if (!isRecord(value)) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: "Zaraacoder model payload.plan must be an object"
    });
  }
  return {
    summary: assertString(value.summary, "plan.summary"),
    steps: assertStringArray(value.steps, "plan.steps"),
    filesToInspect: assertStringArray(value.filesToInspect, "plan.filesToInspect"),
    verificationCommands: assertCommandArray(
      value.verificationCommands,
      "plan.verificationCommands"
    ),
    risks: assertStringArray(value.risks, "plan.risks"),
    doneCriteria: assertStringArray(value.doneCriteria, "plan.doneCriteria")
  };
}
function parseEdits(value) {
  if (!Array.isArray(value)) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: "Zaraacoder model plan edits must be an array"
    });
  }
  return value.map((edit, index) => {
    if (!isRecord(edit)) {
      throw new ZaraacoderBlockingError({
        code: "model-invalid-response",
        message: `Zaraacoder model plan edits[${index}] must be an object`
      });
    }
    return {
      relativePath: assertString(edit.relativePath, `edits[${index}].relativePath`),
      content: assertString(edit.content, `edits[${index}].content`),
      reason: assertString(edit.reason, `edits[${index}].reason`)
    };
  });
}
function parseRequestedCapabilities(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.some((item) => item !== "network" && item !== "package-install")) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: "Zaraacoder model plan requestedCapabilities must contain only known capabilities"
    });
  }
  return value;
}
function parseZaraacoderInspectionRequest(raw) {
  const value = parseJson(raw);
  if (!isRecord(value)) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: "Zaraacoder inspection request must be an object"
    });
  }
  const filesToInspect = assertStringArray(value.filesToInspect, "filesToInspect");
  if (filesToInspect.length > MAX_INSPECTION_FILES) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: `Zaraacoder inspection request may include at most ${MAX_INSPECTION_FILES} files`
    });
  }
  const requestedCapabilities = parseRequestedCapabilities(value.requestedCapabilities);
  return requestedCapabilities ? { filesToInspect, requestedCapabilities } : { filesToInspect };
}
function parseZaraacoderModelPlanPayload(raw, policy) {
  const value = parseJson(raw);
  if (!isRecord(value)) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: "Zaraacoder model plan payload must be an object"
    });
  }
  const plan = parsePlan(value.plan);
  const edits = parseEdits(value.edits);
  const parsedChecks = assertCommandArray(value.checks, "checks");
  const checks = parsedChecks.length > 0 ? parsedChecks : plan.verificationCommands.length > 0 ? plan.verificationCommands : [DEFAULT_VERIFICATION_CHECK];
  const normalizedPlan = plan.verificationCommands.length > 0 ? plan : { ...plan, verificationCommands: checks };
  if (edits.length + checks.length > policy.maxToolCalls) {
    throw new ZaraacoderBlockingError({
      code: "model-invalid-response",
      message: `Zaraacoder model plan exceeds maxToolCalls (${policy.maxToolCalls})`
    });
  }
  const requestedCapabilities = parseRequestedCapabilities(value.requestedCapabilities);
  return requestedCapabilities ? { plan: normalizedPlan, edits, checks, requestedCapabilities } : { plan: normalizedPlan, edits, checks };
}
function buildCompactContext(context, policy) {
  const scripts = context.repoContext.scripts.map((script) => `${script.name}: ${script.command}`);
  const verificationLanes = (context.repoContext.verificationLanes ?? []).map(
    (lane) => [
      `${lane.name}: ${lane.command}`,
      `scope=${lane.scope}`,
      lane.fullSuite ? "full-suite" : "focused",
      `use=${lane.useWhen}`
    ].join(" | ")
  );
  const instructionPaths = context.repoContext.instructions.map((instruction) => instruction.path);
  const projectMemory = context.repoContext.projectMemory;
  return {
    task: context.session.task,
    repoRoot: context.repoContext.repoRoot,
    targetPath: context.repoContext.targetPath,
    repoSummary: context.repoContext.summary,
    instructionFiles: instructionPaths,
    /** Size-capped AGENTS/CLAUDE/README pack — prefer over raw instruction bodies. */
    projectMemory: projectMemory?.combinedPromptSection || void 0,
    packageScripts: scripts,
    verificationLanes,
    policy
  };
}
function buildInspectionMessages(context, policy) {
  return [
    {
      role: "system",
      content: [
        "You are Zaraacoder, Zaraa's local task-to-worktree coding executor.",
        "First choose which repo files you need before editing.",
        "Return only strict JSON with keys filesToInspect and optional requestedCapabilities.",
        "Do not request more than eight files. Do not request capabilities unless the task needs them."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          ...buildCompactContext(context, policy),
          requiredShape: {
            filesToInspect: ["relative/path.ts"],
            requestedCapabilities: ["network", "package-install"]
          }
        },
        null,
        2
      )
    }
  ];
}
function buildFinalMessages(context, policy, inspectedFiles) {
  return [
    {
      role: "system",
      content: [
        "You are Zaraacoder, Zaraa's local task-to-worktree coding executor.",
        "Return only strict JSON with keys plan, edits, checks, and optional requestedCapabilities.",
        "The plan key must be a JSON object, not an array or string.",
        "Edits must contain complete replacement file contents. Do not use markdown outside a JSON fence."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          ...buildCompactContext(context, policy),
          inspectedFiles,
          requiredShape: {
            plan: {
              summary: "string",
              steps: ["string"],
              filesToInspect: ["relative/path.ts"],
              verificationCommands: [["command", "arg"]],
              risks: ["string"],
              doneCriteria: ["string"]
            },
            edits: [
              {
                relativePath: "relative/path.ts",
                content: "complete file content",
                reason: "string"
              }
            ],
            checks: [["command", "arg"]],
            requestedCapabilities: ["network", "package-install"]
          }
        },
        null,
        2
      )
    }
  ];
}
function hasFinalPlanShape(value) {
  return isRecord(value) && value.plan !== void 0 && value.edits !== void 0 && value.checks !== void 0;
}
function mergeCapabilities(first, second) {
  const merged = [.../* @__PURE__ */ new Set([...first ?? [], ...second ?? []])];
  return merged.length ? merged : void 0;
}
function createZaraacoderModelPlanner(input) {
  return async (context, policy) => {
    const chatOptions = context.signal ? { signal: context.signal } : void 0;
    const firstResponse = await input.chat(
      buildInspectionMessages(context, policy),
      void 0,
      chatOptions
    );
    const firstPayload = parseJson(firstResponse.content);
    if (hasFinalPlanShape(firstPayload)) {
      return parseZaraacoderModelPlanPayload(firstPayload, policy);
    }
    const request = parseZaraacoderInspectionRequest(firstPayload);
    const inspectFiles = input.inspectFiles ?? loadZaraacoderInspectedFiles;
    let inspectedFiles;
    try {
      inspectedFiles = await inspectFiles({
        repoRoot: context.repoContext.repoRoot,
        relativePaths: request.filesToInspect
      });
    } catch (error) {
      throw asBlockingError(error, {
        code: "unsafe-inspection-path",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    const finalResponse = await input.chat(
      buildFinalMessages(context, policy, inspectedFiles),
      void 0,
      chatOptions
    );
    const finalResult = parseZaraacoderModelPlanPayload(finalResponse.content, policy);
    const requestedCapabilities = mergeCapabilities(
      request.requestedCapabilities,
      finalResult.requestedCapabilities
    );
    return requestedCapabilities ? { ...finalResult, requestedCapabilities } : finalResult;
  };
}

export {
  BaseProvider,
  AnthropicProvider,
  estimateTokensFromText,
  OpenAIProvider,
  OpenAISessionProvider,
  migrateLegacyGpt54ModelName,
  legacyGpt54ModelNameForGpt55,
  migrateLegacyGpt54ModelNameOrNull,
  HARD_FAILURE_THRESHOLD,
  TRANSIENT_SOFT_MS,
  OVERLOADED_MS,
  AUTH_BACKOFF_MS,
  SUBSCRIPTION_WINDOW_BACKOFF_MS,
  FREE_ROUTE_COOLDOWN_BASE_MS,
  FREE_ROUTE_COOLDOWN_MAX_MS,
  FREE_ROUTE_CANARY_SUCCESSES,
  FREE_ROUTE_CANARY_MAX_RESETS,
  FREE_ROUTE_TRIP_CONSECUTIVE_FAILURES,
  FREE_ROUTE_RATE_LIMIT_BURST_COUNT,
  FREE_ROUTE_RATE_LIMIT_BURST_WINDOW_MS,
  computeRateLimitBackoffMs,
  computeHardFailureBackoffMs,
  computeAuthBillingBackoffMs,
  getDefaultModelHealthRegistry,
  ModelRouter,
  parseTextToolCalls,
  OllamaProvider,
  GeminiProvider,
  providerSupportsNativeTools,
  providerSupportsStreaming,
  providerSupportsStreamingTools,
  getRelativeMeteredCostScore,
  estimateUsageCostUsd,
  classifyCursorFailure,
  cursorFailureToFailoverCooldownReason,
  extractCursorAgentFailureInput,
  extractCursorSdkFailureInput,
  PromptSanitizer,
  Keychain,
  createProviders,
  ZaraacoderBlockingError,
  isZaraacoderBlockingError,
  messageFromUnknown,
  blockedReasonFromError,
  createBlockedPlan,
  createBlockedReview,
  asBlockingError,
  createZaraacoderExecutorAdapter,
  createIsolatedConfiguredZaraacoderExecutor,
  zaraacoderIsolatedExecutorProtocol,
  loadZaraacoderInspectedFiles,
  parseZaraacoderInspectionRequest,
  parseZaraacoderModelPlanPayload,
  createZaraacoderModelPlanner
};
