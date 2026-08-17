import {
  ClaudeCliProvider
} from "./chunk-H6G63P2E.js";

// src/providers/claude-cli-tools.ts
function createClaudeCliManifest(approveAsk = false, approveCode = true) {
  return {
    name: "claude-cli",
    version: "1.0.0",
    type: "tool",
    minZone: "guarded",
    capabilities: ["claude.ask", "claude.code"],
    trust: "core",
    tools: [
      {
        name: "claude_ask",
        description: "Send a question to Claude CLI and get an answer. Use this when you need higher-quality reasoning, broader knowledge, or a second opinion on a complex topic.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The question or prompt to send to Claude"
            },
            model: {
              type: "string",
              description: 'Model to use: "claude-sonnet-4-6" (default), "claude-sonnet-5", "claude-fable-5", "claude-opus-4-6", or "claude-haiku-4-5-20251001"'
            },
            systemPrompt: {
              type: "string",
              description: "Optional system prompt to guide Claude's response"
            },
            maxTurns: {
              type: "number",
              description: "Max agentic turns (default 1 for simple Q&A)"
            }
          },
          required: ["prompt"]
        },
        requiresApproval: approveAsk
      },
      {
        name: "claude_code",
        description: "Delegate a coding task to Claude CLI with full agentic file access. Claude will read, write, and edit files to complete the task. Use for complex refactors, bug fixes, or code generation.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Description of the coding task"
            },
            workingDir: {
              type: "string",
              description: "Working directory for file operations (defaults to project root)"
            },
            allowedTools: {
              type: "string",
              description: "Comma-separated tool allowlist (e.g. Read,Write,Edit,Bash,Glob,Grep). Omit for default set."
            },
            maxTurns: {
              type: "number",
              description: "Max agentic turns (default 10)"
            }
          },
          required: ["prompt"]
        },
        requiresApproval: approveCode
      }
    ]
  };
}
var manifest = createClaudeCliManifest(false);
function createClaudeCliHandlers(deps = {}) {
  return {
    async claude_ask(args) {
      const prompt = args.prompt;
      const model = args.model || deps.defaultModel || "claude-sonnet-4-6";
      const systemPrompt = args.systemPrompt;
      const maxTurns = args.maxTurns || 3;
      const provider = new ClaudeCliProvider({
        model,
        maxTurns,
        timeoutMs: 3e5,
        // 5 min for Q&A
        disallowedTools: "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"
      });
      const health = await provider.healthCheck();
      if (!health.ok) {
        return `[error] Claude CLI is not available: ${health.error}`;
      }
      const messages = [
        ...systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
        { role: "user", content: prompt }
      ];
      try {
        const response = await provider.chat(messages);
        if (deps.saveDocument && response.content && response.content.length > 200) {
          const title = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
          deps.saveDocument({ title, content: response.content, type: "note", tags: ["claude-cli"], source: "claude-cli" });
        }
        return response.content;
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    async claude_code(args) {
      const prompt = args.prompt;
      const workingDir = args.workingDir || deps.workingDir;
      const allowedTools = args.allowedTools;
      const maxTurns = args.maxTurns || 10;
      const codePrompt = allowedTools ? `${prompt}

Only use these tools: ${allowedTools}` : prompt;
      const provider = new ClaudeCliProvider({
        model: deps.defaultModel || "claude-sonnet-4-6",
        maxTurns,
        timeoutMs: 6e5,
        // 10 min for coding tasks
        permissionMode: "accept-edits",
        workingDir
      });
      const health = await provider.healthCheck();
      if (!health.ok) {
        return `[error] Claude CLI is not available: ${health.error}`;
      }
      try {
        const response = await provider.chat([
          { role: "user", content: codePrompt }
        ]);
        if (deps.saveDocument && response.content && response.content.length > 200) {
          const title = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
          deps.saveDocument({ title, content: response.content, type: "plan", tags: ["claude-cli", "code"], source: "claude-cli" });
        }
        return response.content;
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
}

export {
  createClaudeCliManifest,
  manifest,
  createClaudeCliHandlers
};
