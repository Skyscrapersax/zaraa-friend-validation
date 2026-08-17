// src/integrations/github-tools.ts
var manifest = {
  name: "github",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["integration.github"],
  trust: "core",
  tools: [
    {
      name: "github_list_issues",
      description: "List issues for a GitHub repository",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner (user or organization)"
          },
          repo: {
            type: "string",
            description: "Repository name"
          },
          state: {
            type: "string",
            description: "Issue state filter: open, closed, or all (default: open)"
          },
          limit: {
            type: "number",
            description: "Maximum number of issues to return (default: 20)"
          }
        },
        required: ["owner", "repo"]
      },
      requiresApproval: false
    },
    {
      name: "github_create_issue",
      description: "Create a new issue in a GitHub repository",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner (user or organization)"
          },
          repo: {
            type: "string",
            description: "Repository name"
          },
          title: {
            type: "string",
            description: "Issue title"
          },
          body: {
            type: "string",
            description: "Issue body content (supports Markdown)"
          }
        },
        required: ["owner", "repo", "title", "body"]
      },
      requiresApproval: true
    },
    {
      name: "github_list_prs",
      description: "List pull requests for a GitHub repository",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner (user or organization)"
          },
          repo: {
            type: "string",
            description: "Repository name"
          },
          state: {
            type: "string",
            description: "PR state filter: open, closed, or all (default: open)"
          },
          limit: {
            type: "number",
            description: "Maximum number of PRs to return (default: 20)"
          }
        },
        required: ["owner", "repo"]
      },
      requiresApproval: false
    },
    {
      name: "github_search_repos",
      description: "Search GitHub repositories by query",
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
      name: "github_read_file",
      description: "Read a file from a GitHub repository",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner (user or organization)"
          },
          repo: {
            type: "string",
            description: "Repository name"
          },
          path: {
            type: "string",
            description: "File path within the repository"
          }
        },
        required: ["owner", "repo", "path"]
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(client) {
  return {
    github_list_issues: async (args) => {
      const owner = args.owner;
      const repo = args.repo;
      if (!owner || !repo) {
        throw new Error("owner and repo are required");
      }
      const state = args.state ?? void 0;
      const limit = args.limit;
      const issues = await client.listIssues(owner, repo, state, limit);
      return JSON.stringify(issues);
    },
    github_create_issue: async (args) => {
      const owner = args.owner;
      const repo = args.repo;
      const title = args.title;
      const body = args.body;
      if (!owner || !repo || !title || !body) {
        throw new Error("owner, repo, title, and body are required");
      }
      const issue = await client.createIssue(owner, repo, title, body);
      return `Created issue #${issue.number}: ${issue.url}`;
    },
    github_list_prs: async (args) => {
      const owner = args.owner;
      const repo = args.repo;
      if (!owner || !repo) {
        throw new Error("owner and repo are required");
      }
      const state = args.state ?? void 0;
      const limit = args.limit;
      const prs = await client.listPRs(owner, repo, state, limit);
      return JSON.stringify(prs);
    },
    github_search_repos: async (args) => {
      const query = args.query;
      if (!query) {
        throw new Error("query is required");
      }
      const limit = args.limit;
      const repos = await client.searchRepos(query, limit);
      return JSON.stringify(repos);
    },
    github_read_file: async (args) => {
      const owner = args.owner;
      const repo = args.repo;
      const path = args.path;
      if (!owner || !repo || !path) {
        throw new Error("owner, repo, and path are required");
      }
      const content = await client.getFileContent(owner, repo, path);
      return JSON.stringify({ owner, repo, path, content });
    }
  };
}

export {
  manifest,
  createHandlers
};
