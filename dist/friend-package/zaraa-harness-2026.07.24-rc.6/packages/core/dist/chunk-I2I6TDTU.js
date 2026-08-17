// src/integrations/grokbot-tools.ts
var manifest = {
  name: "grokbot",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.grokbot"],
  trust: "core",
  tools: [
    {
      name: "grokbot_list",
      description: "List Grok Bot sidebar agents (not Zaraa fleet tags). Returns name and id. Use this instead of shell_exec node/python grokbot-bridge.",
      parameters: { type: "object", properties: {}, required: [] },
      requiresApproval: false
    },
    {
      name: "grokbot_send",
      description: "Send one prompt to a Grok Bot by name or id (sidebar layer, not Have Ivy fleet dispatch). One owner per bot.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Grok Bot name or id (e.g. Vesper, Reed)"
          },
          prompt: {
            type: "string",
            description: "Single job + constraints"
          }
        },
        required: ["target", "prompt"]
      },
      requiresApproval: true
    },
    {
      name: "grokbot_tail",
      description: "Read the latest transcript entries for a Grok Bot by name or id.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Grok Bot name or id"
          },
          limit: {
            type: "number",
            description: "Max entries (default 20)"
          }
        },
        required: ["target"]
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(client) {
  return {
    grokbot_list: async () => {
      const agents = await client.listAgents();
      return agents.map((a) => `${a.name}	${a.id}`).join("\n");
    },
    grokbot_send: async (args) => {
      const target = String(args.target ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      if (!target || !prompt) throw new Error("target and prompt are required");
      const result = await client.sendPrompt(target, prompt);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    grokbot_tail: async (args) => {
      const target = String(args.target ?? "").trim();
      if (!target) throw new Error("target is required");
      const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 20;
      const result = await client.tail(target, limit);
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  };
}

export {
  manifest,
  createHandlers
};
