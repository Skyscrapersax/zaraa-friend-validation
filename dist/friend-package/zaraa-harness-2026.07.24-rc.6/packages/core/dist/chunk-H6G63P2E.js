// src/providers/claude-cli-provider.ts
import { execFile, spawn } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
function parseClaudeJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const jsonStart = stdout.indexOf("{");
    if (jsonStart > 0) {
      return JSON.parse(stdout.slice(jsonStart));
    }
    throw new Error(`Claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
}
function throwIfClaudeResultError(data, maxTurns) {
  if (!data.result && data.subtype === "error_max_turns") {
    throw new Error(`Claude CLI hit max turns (${maxTurns}) without producing a response. Try increasing maxTurns.`);
  }
  if (data.is_error) {
    const errorText = typeof data.result === "string" && data.result.trim() ? data.result : data.subtype || "error";
    throw new Error(`Claude CLI error: ${errorText}`);
  }
}
var ClaudeCliProvider = class {
  name = "claude-cli";
  modelKey;
  tier;
  billingMode;
  capabilities;
  pricing;
  config;
  metrics = { totalRequests: 0, totalCostUsd: 0, totalDurationMs: 0, errors: 0 };
  /** Cached env object — avoids spreading process.env on every spawn */
  spawnEnv;
  /** Last session ID for session reuse (avoids full CLI startup on repeat calls) */
  lastSessionId;
  constructor(config = {}) {
    this.config = {
      model: config.model || "claude-sonnet-4-6",
      maxTurns: config.maxTurns ?? 5,
      timeoutMs: config.timeoutMs ?? 3e5,
      permissionMode: config.permissionMode,
      workingDir: config.workingDir,
      disallowedTools: config.disallowedTools
    };
    this.spawnEnv = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "zaraa" };
  }
  /**
   * Chat — spawns `claude -p` with JSON output, collects stdout via spawn.
   * Merges system + conversation messages into a single prompt string
   * since the CLI takes a flat prompt, not a message array.
   */
  async chat(messages, _tools) {
    const { systemPrompt, userPrompt } = this.flattenMessages(messages);
    const args = this.buildArgs(userPrompt, systemPrompt, "json");
    const t0 = Date.now();
    this.metrics.totalRequests++;
    const stdout = await this.spawnCollect(args);
    const data = parseClaudeJsonEnvelope(stdout);
    const elapsed = Date.now() - t0;
    const cost = data.total_cost_usd ?? data.cost_usd ?? 0;
    this.metrics.totalCostUsd += cost;
    this.metrics.totalDurationMs += elapsed;
    if (data.session_id) {
      this.lastSessionId = data.session_id;
    }
    try {
      throwIfClaudeResultError(data, this.config.maxTurns);
    } catch (err) {
      this.metrics.errors++;
      throw err;
    }
    return {
      content: data.result || "",
      toolCalls: [],
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0
      },
      model: this.config.model
    };
  }
  /**
   * Streaming chat — spawns `claude -p` with stream-json output.
   * Yields text deltas as NDJSON events arrive from stdout.
   */
  async *chatStream(messages, _tools) {
    const { systemPrompt, userPrompt } = this.flattenMessages(messages);
    const args = this.buildArgs(userPrompt, systemPrompt, "stream-json");
    const proc = spawn("claude", args, {
      cwd: this.config.workingDir,
      env: this.spawnEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => proc.kill("SIGTERM"), this.config.timeoutMs);
    let buffer = "";
    this.metrics.totalRequests++;
    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (err) {
            console.debug("[claude-cli] malformed stream JSON line:", err instanceof Error ? err.message : err);
            continue;
          }
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                yield { type: "text_delta", content: block.text };
              }
            }
          } else if (event.type === "result") {
            this.metrics.totalCostUsd += event.total_cost_usd ?? event.cost_usd ?? 0;
            if (event.is_error) {
              this.metrics.errors++;
              const errorText = typeof event.result === "string" && event.result.trim() ? event.result : event.subtype || "error";
              throw new Error(`Claude CLI error: ${errorText}`);
            }
            yield { type: "done", finishReason: "end_turn", model: this.config.model };
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      if (!proc.killed) proc.kill("SIGTERM");
    }
  }
  /**
   * Health check — verifies the `claude` binary is installed and responsive.
   */
  async healthCheck() {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5e3 });
      const version = stdout.trim();
      const auth = await execFileAsync("claude", ["auth", "status"], { timeout: 5e3 });
      const status = JSON.parse(auth.stdout);
      if (!status.loggedIn) {
        return { ok: false, version, error: "Claude CLI is installed but not logged in" };
      }
      return { ok: true, version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  getMetrics() {
    return { ...this.metrics };
  }
  // ─── Private ───────────────────────────────────────────
  /**
   * Spawn the CLI and collect stdout until the process closes.
   * Uses spawn instead of execFile because the Claude binary can
   * keep inherited pipes open after exit, causing execFile to hang.
   */
  spawnCollect(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd: this.config.workingDir,
        env: this.spawnEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        this.metrics.errors++;
        reject(new Error(
          `Claude CLI timed out after ${Math.round(this.config.timeoutMs / 6e4)} minutes`
        ));
      }, this.config.timeoutMs);
      proc.on("error", (err) => {
        clearTimeout(timer);
        this.metrics.errors++;
        if (err.message.includes("ENOENT")) {
          reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(err);
        }
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          this.metrics.errors++;
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.trim() || "(no output)"}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
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
   * Build CLI argument array from template (matches claude-cli.xml invocation spec).
   */
  buildArgs(prompt, systemPrompt, format = "json") {
    const args = [
      "-p",
      prompt,
      "--output-format",
      format,
      "--model",
      this.config.model,
      "--max-turns",
      String(this.config.maxTurns)
    ];
    if (format === "stream-json") {
      args.push("--verbose");
    }
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }
    if (this.config.permissionMode) {
      args.push("--permission-mode", this.config.permissionMode);
    }
    if (this.config.disallowedTools) {
      args.push("--disallowedTools", this.config.disallowedTools);
    }
    if (this.lastSessionId) {
      args.push("--resume", this.lastSessionId);
    }
    return args;
  }
};

export {
  parseClaudeJsonEnvelope,
  throwIfClaudeResultError,
  ClaudeCliProvider
};
