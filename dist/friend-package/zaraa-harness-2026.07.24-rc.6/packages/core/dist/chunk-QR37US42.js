// src/integrations/obsidian-tools.ts
var CANONICAL_GOALS_PATH = "brain/Goals Canonical.md";
var manifest = {
  name: "obsidian",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.obsidian"],
  trust: "core",
  tools: [
    {
      name: "obsidian_list",
      description: "List notes in an Obsidian vault",
      parameters: {
        type: "object",
        properties: {
          subdir: {
            type: "string",
            description: "Subdirectory to list notes from (relative to vault root)"
          },
          limit: {
            type: "number",
            description: "Maximum number of notes to return (default: 50)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "obsidian_read",
      description: "Read the content of an Obsidian note",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note relative to vault root (must be .md)"
          }
        },
        required: ["path"]
      },
      requiresApproval: false
    },
    {
      name: "obsidian_write",
      description: "Write or create an Obsidian note",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note relative to vault root (must be .md)"
          },
          content: {
            type: "string",
            description: "Markdown content to write"
          }
        },
        required: ["path", "content"]
      },
      requiresApproval: true
    },
    {
      name: "obsidian_search",
      description: "Search notes by filename or content in an Obsidian vault",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (case-insensitive)"
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 20)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "obsidian_append",
      description: "Append content to an existing Obsidian note",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note relative to vault root (must be .md)"
          },
          content: {
            type: "string",
            description: "Content to append to the note"
          }
        },
        required: ["path", "content"]
      },
      requiresApproval: true
    },
    {
      name: "obsidian_read_canonical_goals",
      description: "Read the canonical goals document at brain/Goals Canonical.md",
      parameters: { type: "object", properties: {}, required: [] },
      requiresApproval: false
    },
    {
      name: "obsidian_append_canonical_goals",
      description: "Append content to the canonical goals document at brain/Goals Canonical.md",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Content to append to the canonical goals note"
          }
        },
        required: ["content"]
      },
      requiresApproval: true
    }
  ]
};
function createHandlers(client) {
  return {
    obsidian_list: async (args) => {
      const subdir = args.subdir ?? "";
      const limit = args.limit ?? 50;
      const notes = client.listNotes(subdir, limit);
      const summaries = notes.map((n) => ({
        path: n.path,
        name: n.name,
        lastModified: n.lastModified
      }));
      return JSON.stringify(summaries);
    },
    obsidian_read: async (args) => {
      const path = args.path;
      if (!path) {
        throw new Error("path is required");
      }
      const content = client.readNote(path);
      return JSON.stringify({ path, content });
    },
    obsidian_write: async (args) => {
      const path = args.path;
      const content = args.content;
      if (!path || !content) {
        throw new Error("path and content are required");
      }
      client.writeNote(path, content);
      return JSON.stringify({ success: true, path });
    },
    obsidian_search: async (args) => {
      const query = args.query;
      if (!query) {
        throw new Error("query is required");
      }
      const limit = args.limit ?? 20;
      const results = client.searchNotes(query, limit);
      return JSON.stringify(results);
    },
    obsidian_append: async (args) => {
      const path = args.path;
      const content = args.content;
      if (!path || !content) {
        throw new Error("path and content are required");
      }
      client.appendToNote(path, content);
      return JSON.stringify({ success: true, path });
    },
    obsidian_read_canonical_goals: async () => {
      const content = client.readNote(CANONICAL_GOALS_PATH);
      return JSON.stringify({ path: CANONICAL_GOALS_PATH, content });
    },
    obsidian_append_canonical_goals: async (args = {}) => {
      const content = args.content;
      if (!content) {
        throw new Error("content is required");
      }
      client.appendToNote(CANONICAL_GOALS_PATH, content);
      return JSON.stringify({ success: true, path: CANONICAL_GOALS_PATH });
    }
  };
}

export {
  manifest,
  createHandlers
};
