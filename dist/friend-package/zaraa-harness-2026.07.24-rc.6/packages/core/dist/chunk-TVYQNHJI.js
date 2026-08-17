// src/integrations/notion-tools.ts
var manifest = {
  name: "notion",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.notion"],
  trust: "core",
  tools: [
    {
      name: "notion_search",
      description: "Search Notion pages by query",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string"
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 10)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "notion_read_page",
      description: "Read the content of a Notion page",
      parameters: {
        type: "object",
        properties: {
          pageId: {
            type: "string",
            description: "The ID of the Notion page to read"
          }
        },
        required: ["pageId"]
      },
      requiresApproval: false
    },
    {
      name: "notion_create_page",
      description: "Create a new Notion page under a parent page",
      parameters: {
        type: "object",
        properties: {
          parentId: {
            type: "string",
            description: "The ID of the parent page"
          },
          title: {
            type: "string",
            description: "Title for the new page"
          },
          content: {
            type: "string",
            description: "Text content for the page (newlines create separate paragraphs)"
          }
        },
        required: ["parentId", "title", "content"]
      },
      requiresApproval: true
    },
    {
      name: "notion_list_databases",
      description: "List available Notion databases",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of databases to return (default: 10)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "notion_query_database",
      description: "Query rows from a Notion database",
      parameters: {
        type: "object",
        properties: {
          databaseId: {
            type: "string",
            description: "The ID of the database to query"
          },
          limit: {
            type: "number",
            description: "Maximum number of rows to return (default: 20)"
          }
        },
        required: ["databaseId"]
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(client) {
  return {
    notion_search: async (args) => {
      const query = args.query;
      if (!query) {
        throw new Error("query is required");
      }
      const limit = args.limit;
      const pages = await client.searchPages(query, limit);
      return JSON.stringify(pages);
    },
    notion_read_page: async (args) => {
      const pageId = args.pageId;
      if (!pageId) {
        throw new Error("pageId is required");
      }
      const content = await client.readPage(pageId);
      return JSON.stringify({ pageId, content });
    },
    notion_create_page: async (args) => {
      const parentId = args.parentId;
      const title = args.title;
      const content = args.content;
      if (!parentId || !title || !content) {
        throw new Error("parentId, title, and content are required");
      }
      const result = await client.createPage(parentId, title, content);
      return `Created page: ${result.url}`;
    },
    notion_list_databases: async (args) => {
      const limit = args.limit;
      const databases = await client.listDatabases(limit);
      return JSON.stringify(databases);
    },
    notion_query_database: async (args) => {
      const databaseId = args.databaseId;
      if (!databaseId) {
        throw new Error("databaseId is required");
      }
      const limit = args.limit;
      const rows = await client.queryDatabase(databaseId, limit);
      return JSON.stringify(rows);
    }
  };
}

export {
  manifest,
  createHandlers
};
