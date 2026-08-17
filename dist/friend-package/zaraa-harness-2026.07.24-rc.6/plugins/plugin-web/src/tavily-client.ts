import type { SearchClient, SearchResult } from "./brave-client.js";

const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

/**
 * Tavily Search API backend — an LLM-focused web search whose free tier
 * (1,000 credits/month, recurring) requires no credit card, unlike Brave's
 * now card-mandatory plan. Because Tavily is key-gated rather than IP-gated it
 * does not bot-block bursty agent traffic the way scraping DuckDuckGo does,
 * which makes it a reliable network fallback behind a local SearXNG instance.
 *
 * Defaults to `search_depth: "basic"` (1 credit/query) to stretch the free
 * monthly cap; "advanced" would cost 2 credits per query.
 */
export class TavilySearchClient implements SearchClient {
	private readonly apiKey: string;

	constructor(apiKey: string) {
		if (!apiKey) {
			throw new Error("TavilySearchClient requires an API key");
		}
		this.apiKey = apiKey;
	}

	async search(query: string, count?: number): Promise<SearchResult[]> {
		const maxResults = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);

		const response = await fetch(TAVILY_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				query,
				max_results: maxResults,
				search_depth: "basic",
			}),
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(
				`Tavily search error: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as {
			results?: Array<{ title?: string; url?: string; content?: string }>;
		};

		return (data.results ?? [])
			.filter(
				(r): r is { title: string; url: string; content?: string } =>
					typeof r.title === "string" && typeof r.url === "string",
			)
			.map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
	}
}
