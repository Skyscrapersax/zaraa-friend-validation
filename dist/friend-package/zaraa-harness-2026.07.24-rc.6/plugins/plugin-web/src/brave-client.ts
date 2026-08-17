export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Common interface for all search providers */
export interface SearchClient {
	search(query: string, count?: number): Promise<SearchResult[]>;
}

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_COUNT = 10;
const DEFAULT_COUNT = 5;

export class BraveSearchClient {
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async search(query: string, count?: number): Promise<SearchResult[]> {
		const effectiveCount = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);

		const params = new URLSearchParams({
			q: query,
			count: String(effectiveCount),
		});

		const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			headers: {
				"X-Subscription-Token": this.apiKey,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(
				`Brave Search API error: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as {
			web?: {
				results?: Array<{
					title: string;
					url: string;
					description: string;
				}>;
			};
		};

		const results = data.web?.results ?? [];
		return results.map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.description,
		}));
	}
}
