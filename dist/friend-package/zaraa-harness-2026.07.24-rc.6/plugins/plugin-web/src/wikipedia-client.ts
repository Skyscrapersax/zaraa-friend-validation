import type { SearchClient, SearchResult } from "./brave-client.js";

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
// Wikipedia asks API clients to send a descriptive, identifying User-Agent.
const WIKI_USER_AGENT =
	"ZaraaAssistant/1.0 (personal AI assistant; keyless research fallback)";

/**
 * Keyless fallback search using the MediaWiki (Wikipedia) search API.
 *
 * Unlike DuckDuckGo's HTML endpoint, the Wikipedia API is a stable, documented
 * JSON API that does not bot-block or IP-rate-limit ordinary use — so it is a
 * reliable last resort when the primary web backend (DuckDuckGo / Brave) is
 * unavailable. It is factual/encyclopedic only (no current-events / prices),
 * so it complements rather than replaces a real web search backend.
 */
export class WikipediaSearchClient implements SearchClient {
	async search(query: string, count?: number): Promise<SearchResult[]> {
		const limit = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);
		const params = new URLSearchParams({
			action: "query",
			list: "search",
			srsearch: query,
			format: "json",
			srlimit: String(limit),
			srprop: "snippet",
		});

		const response = await fetch(`${WIKI_API}?${params.toString()}`, {
			headers: {
				"User-Agent": WIKI_USER_AGENT,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(
				`Wikipedia search error: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as {
			query?: { search?: Array<{ title?: string; snippet?: string }> };
		};

		const hits = data.query?.search ?? [];
		return hits
			.filter((h): h is { title: string; snippet?: string } => typeof h.title === "string")
			.map((h) => ({
				title: h.title,
				url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
				snippet: stripHtml(h.snippet ?? ""),
			}));
	}
}

/** Strip the inline HTML/entities the search API returns in snippets. */
function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.trim();
}
