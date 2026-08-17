// src/embeddings/ollama-embedder.ts
var OllamaEmbedder = class _OllamaEmbedder {
  model;
  baseUrl;
  dimensions;
  retryDelayMs;
  static DIMENSION_PROBE_TIMEOUT_MS = 8e3;
  constructor(config = {}) {
    this.model = config.model || "nomic-embed-text";
    this.baseUrl = config.baseUrl || "http://localhost:11434";
    this.retryDelayMs = config.retryDelayMs ?? 2e3;
  }
  /**
   * Check whether the Ollama server is reachable and the embedding model is available.
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3e3)
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (!data.models) return false;
      return data.models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
      );
    } catch (err) {
      console.debug("[ollama-embedder] availability check failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }
  /**
   * Generate an embedding vector for the given text.
   * Calls Ollama's /api/embed endpoint.
   * Retries once after a short delay if Ollama is temporarily busy.
   */
  async embed(text) {
    return this.embedWithRetry(text, 1);
  }
  async embedWithRetry(text, retriesLeft) {
    const maxChars = 1800;
    const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: truncatedText
        }),
        signal: AbortSignal.timeout(6e4)
      });
      if (!response.ok) {
        throw new Error(
          `Ollama embed error: ${response.status} ${response.statusText}`
        );
      }
      const data = await response.json();
      const embedding = data.embeddings?.[0];
      if (!embedding || embedding.length === 0) {
        throw new Error("Ollama returned empty embedding");
      }
      return embedding;
    } catch (err) {
      if (retriesLeft > 0) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timeout") || msg.includes("aborted") || msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("empty embedding")) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          return this.embedWithRetry(text, retriesLeft - 1);
        }
      }
      throw err;
    }
  }
  /**
   * Probe the embedding dimension by generating a test embedding.
   * Caches the result after the first successful call.
   */
  async getDimensions() {
    if (this.dimensions !== void 0) {
      return this.dimensions;
    }
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: "dimension probe"
      }),
      // Startup should fail open if the embedding model is cold or busy.
      signal: AbortSignal.timeout(_OllamaEmbedder.DIMENSION_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(
        `Ollama dimension probe error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    const testEmbedding = data.embeddings?.[0];
    if (!testEmbedding || testEmbedding.length === 0) {
      throw new Error("Ollama returned empty embedding");
    }
    this.dimensions = testEmbedding.length;
    return this.dimensions;
  }
};

// src/embeddings/openai-embedder.ts
var DIMENSIONS_SUPPORTED_MODELS = ["text-embedding-3-small", "text-embedding-3-large"];
var TRANSIENT_STATUSES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var MAX_RETRIES = 2;
var BASE_RETRY_DELAY_MS = 1e3;
var OpenAIEmbedder = class {
  apiKey;
  model;
  baseUrl;
  configuredDimensions;
  cachedDimensions = null;
  availableCache = null;
  retryDelayMs;
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      ""
    );
    this.configuredDimensions = config.dimensions;
    this.retryDelayMs = config.retryDelayMs ?? BASE_RETRY_DELAY_MS;
    if (this.configuredDimensions !== void 0 && this.isSupportedDimensionsModel()) {
      this.cachedDimensions = this.configuredDimensions;
    }
  }
  isSupportedDimensionsModel() {
    return DIMENSIONS_SUPPORTED_MODELS.some((m) => this.model.startsWith(m));
  }
  async isAvailable() {
    if (this.availableCache && Date.now() - this.availableCache.checkedAt < 5 * 60 * 1e3) {
      return this.availableCache.value;
    }
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(1e4)
      });
      const available = res.ok;
      this.availableCache = { value: available, checkedAt: Date.now() };
      return available;
    } catch (err) {
      console.debug("[openai-embedder] availability check failed:", err instanceof Error ? err.message : err);
      this.availableCache = { value: false, checkedAt: Date.now() };
      return false;
    }
  }
  async embed(text) {
    return this.embedWithRetry(text, MAX_RETRIES);
  }
  async embedWithRetry(text, retriesLeft) {
    const requestBody = {
      input: text,
      model: this.model
    };
    if (this.configuredDimensions !== void 0 && this.isSupportedDimensionsModel()) {
      requestBody.dimensions = this.configuredDimensions;
    }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(3e4)
      });
    } catch (err) {
      if (retriesLeft > 0) {
        await this.delay(retriesLeft);
        return this.embedWithRetry(text, retriesLeft - 1);
      }
      throw err;
    }
    if (!res.ok) {
      if (!TRANSIENT_STATUSES.has(res.status)) {
        const body2 = await res.text();
        throw new Error(`OpenAI embeddings API error ${res.status}: ${body2}`);
      }
      if (retriesLeft > 0) {
        await this.delay(retriesLeft);
        return this.embedWithRetry(text, retriesLeft - 1);
      }
      const body = await res.text();
      throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`);
    }
    const json = await res.json();
    const vector = json.data[0].embedding;
    if (this.configuredDimensions !== void 0 && this.isSupportedDimensionsModel() && vector.length !== this.configuredDimensions) {
      throw new Error(
        `OpenAI embeddings dimension mismatch: configured ${this.configuredDimensions}, API returned ${vector.length}`
      );
    }
    return vector;
  }
  /** Linear backoff: attempt 2 → 2×delay, attempt 1 → 1×delay. */
  delay(retriesLeft) {
    const attempt = MAX_RETRIES - retriesLeft + 1;
    return new Promise((r) => setTimeout(r, attempt * this.retryDelayMs));
  }
  async getDimensions() {
    if (this.cachedDimensions !== null) return this.cachedDimensions;
    const probe = await this.embed("dimension probe");
    this.cachedDimensions = probe.length;
    return this.cachedDimensions;
  }
};

// src/embeddings/create-embedder.ts
function createEmbedder(config) {
  if (!config || config.provider === "ollama") {
    return new OllamaEmbedder({
      model: config?.model,
      baseUrl: config?.baseUrl
    });
  }
  if (config.provider === "openai") {
    return new OpenAIEmbedder({
      apiKey: config.apiKey ?? "",
      model: config.model,
      baseUrl: config.baseUrl
    });
  }
  return new OllamaEmbedder();
}

export {
  OllamaEmbedder,
  createEmbedder
};
