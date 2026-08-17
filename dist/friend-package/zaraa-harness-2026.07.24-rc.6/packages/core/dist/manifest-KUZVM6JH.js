import "./chunk-R5U7XKVJ.js";

// src/plugins/codex-agent/manifest.json
var manifest_default = {
  name: "codex-agent",
  version: "1.0.0",
  type: "tool",
  minZone: "trusted",
  capabilities: ["shell.exec"],
  trust: "core",
  tools: [
    {
      name: "codex_agent",
      description: "Run a coding task using OpenAI Codex CLI agent. Codex has its own sandboxed tool-use (file editing, shell commands). Use for code generation, refactoring, debugging, or review tasks.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The coding task to send to Codex"
          },
          workingDir: {
            type: "string",
            description: "Working directory for Codex (defaults to project root)"
          },
          model: {
            type: "string",
            description: "Model override (defaults to gpt-5.4; use gpt-5.6-luna for Luna)"
          },
          reasoningEffort: {
            type: "string",
            enum: ["none", "low", "medium", "high", "xhigh", "max"],
            description: "Reasoning override (use max with gpt-5.6-luna for Luna Max)"
          }
        },
        required: ["task"]
      },
      requiresApproval: true
    }
  ]
};
export {
  manifest_default as default
};
