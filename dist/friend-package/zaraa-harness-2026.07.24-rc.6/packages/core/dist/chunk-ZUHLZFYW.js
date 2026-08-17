// src/integrations/github-client.ts
import { Octokit } from "@octokit/rest";
var GitHubClient = class {
  octokit;
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
  }
  async listIssues(owner, repo, state = "open", limit = 20) {
    const response = await this.octokit.issues.listForRepo({
      owner,
      repo,
      state,
      per_page: limit
    });
    return response.data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body ?? "",
      url: issue.html_url,
      createdAt: issue.created_at,
      labels: issue.labels.map(
        (label) => typeof label === "string" ? label : label.name ?? ""
      )
    }));
  }
  async createIssue(owner, repo, title, body) {
    const response = await this.octokit.issues.create({
      owner,
      repo,
      title,
      body
    });
    const issue = response.data;
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body ?? "",
      url: issue.html_url,
      createdAt: issue.created_at,
      labels: issue.labels.map(
        (label) => typeof label === "string" ? label : label.name ?? ""
      )
    };
  }
  async listPRs(owner, repo, state = "open", limit = 20) {
    const response = await this.octokit.pulls.list({
      owner,
      repo,
      state,
      per_page: limit
    });
    return response.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      body: pr.body ?? "",
      url: pr.html_url,
      createdAt: pr.created_at,
      head: pr.head.ref,
      base: pr.base.ref
    }));
  }
  async searchRepos(query, limit = 10) {
    const response = await this.octokit.search.repos({
      q: query,
      per_page: limit
    });
    return response.data.items.map((item) => ({
      name: item.name,
      fullName: item.full_name,
      description: item.description ?? "",
      url: item.html_url,
      stars: item.stargazers_count,
      language: item.language ?? ""
    }));
  }
  async getFileContent(owner, repo, path) {
    const response = await this.octokit.repos.getContent({
      owner,
      repo,
      path
    });
    const data = response.data;
    if (!data.content) {
      throw new Error(`No content found at ${path}`);
    }
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
};

export {
  GitHubClient
};
