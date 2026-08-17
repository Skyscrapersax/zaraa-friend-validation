import type { SearchClient, SearchResult } from "./brave-client.js";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

/**
 * Self-hosted SearXNG metasearch backend.
 *
 * SearXNG is a local, keyless metasearch engine that fans a query out across
 * many upstream engines (Brave, DuckDuckGo, Bing, Mojeek, Wikipedia, …) and
 * returns whatever succeeds. Running it locally is strictly better than a
 * single cloud search API for an always-on daemon: no API key in the keychain,
 * no credit card, no monthly quota, full privacy (queries never leave the
 * host), and — crucially — no single upstream IP-block can kill research,
 * because a blocked engine just drops out of the fan-out. This directly fixes
 * the failure mode of the lone DuckDuckGo scraper, which IP-blocks the host
 * under load.
 *
 * Requires SearXNG to expose the JSON output format
 * (`search.formats: [html, json]` in settings.yml); without it SearXNG answers
 * `format=json` requests with HTTP 403.
 */
export class SearxngSearchClient implements SearchClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string = DEFAULT_BASE_URL) {
		// Tolerate a trailing slash so `http://host:8888/` and `http://host:8888`
		// both build a correct `/search` path.
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async search(query: string, count?: number): Promise<SearchResult[]> {
		const limit = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);
		const params = new URLSearchParams({ q: query, format: "json" });

		const response = await fetch(`${this.baseUrl}/search?${params.toString()}`, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			// 403 typically means the JSON format isn't enabled in settings.yml.
			throw new Error(
				`SearXNG search error: ${response.status} ${response.statusText}`,
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
			.slice(0, limit)
			.map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
	}
}
