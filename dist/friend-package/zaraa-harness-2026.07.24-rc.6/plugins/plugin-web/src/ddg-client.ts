import type { SearchClient, SearchResult } from "./brave-client.js";

const DDG_URL = "https://html.duckduckgo.com/html/";
const MAX_COUNT = 10;
const DEFAULT_COUNT = 5;

// ---------------------------------------------------------------------------
// User-Agent rotation (Iter 4 #6)
// ---------------------------------------------------------------------------

const USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
	// NOTE: every entry MUST be a real browser UA — DuckDuckGo's HTML endpoint
	// silently blocks/stalls bot-shaped agents (a former "Zaraa/1.0" entry made
	// every 6th search dead-end into a timeout). Covered by ddg-client.test.ts.
];

let uaIndex = 0;

function getNextUserAgent(): string {
	const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
	uaIndex++;
	return ua;
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff (Iter 4 #5)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Free search client using DuckDuckGo's HTML endpoint.
 * No API key required. Parses the lightweight HTML results page.
 * Includes retry with exponential backoff and User-Agent rotation.
 */
export class DuckDuckGoClient implements SearchClient {
	async search(query: string, count?: number): Promise<SearchResult[]> {
		const effectiveCount = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);

		const params = new URLSearchParams({ q: query });

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(`${DDG_URL}?${params.toString()}`, {
					method: "POST",
					headers: {
						"User-Agent": getNextUserAgent(),
						Accept: "text/html",
					},
					signal: AbortSignal.timeout(15_000),
				});

				if (!response.ok) {
					// Retry on 5xx server errors
					if (response.status >= 500 && attempt < MAX_RETRIES) {
						lastError = new Error(
							`DuckDuckGo search error: ${response.status} ${response.statusText}`,
						);
						await sleep(BASE_DELAY_MS * 2 ** attempt);
						continue;
					}
					throw new Error(
						`DuckDuckGo search error: ${response.status} ${response.statusText}`,
					);
				}

				const html = await response.text();
				return this.parseResults(html, effectiveCount);
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				// Retry on transient errors (network, timeout)
				if (attempt < MAX_RETRIES) {
					const isTransient =
						lastError.name === "TimeoutError" ||
						lastError.message.includes("timeout") ||
						lastError.message.includes("ECONNRESET") ||
						lastError.message.includes("ENOTFOUND") ||
						lastError.message.includes("fetch failed") ||
						(lastError.message.includes("DuckDuckGo search error: 5"));
					if (isTransient) {
						await sleep(BASE_DELAY_MS * 2 ** attempt);
						continue;
					}
				}
				throw lastError;
			}
		}

		throw lastError ?? new Error("DuckDuckGo search failed after retries");
	}

	private parseResults(html: string, limit: number): SearchResult[] {
		const results: SearchResult[] = [];

		// DDG HTML results have class="result__a" for titles/links
		// and class="result__snippet" for descriptions
		const resultBlocks = html.split(/class="result\s/);

		for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
			const block = resultBlocks[i];

			// Extract URL from result__a href
			const urlMatch = block.match(
				/class="result__a"[^>]*href="([^"]+)"/,
			);
			// Extract title text from result__a
			const titleMatch = block.match(
				/class="result__a"[^>]*>([^<]+)</,
			);
			// Extract snippet from result__snippet
			const snippetMatch = block.match(
				/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
			);

			if (urlMatch && titleMatch) {
				let url = urlMatch[1];
				// DDG wraps URLs in a redirect — extract the actual URL
				const uddgMatch = url.match(/uddg=([^&]+)/);
				if (uddgMatch) {
					url = decodeURIComponent(uddgMatch[1]);
				}

				const snippet = snippetMatch
					? this.stripTags(snippetMatch[1]).trim()
					: "";

				results.push({
					title: this.decodeEntities(titleMatch[1].trim()),
					url,
					snippet: this.decodeEntities(snippet),
				});
			}
		}

		return results;
	}

	private stripTags(html: string): string {
		return html.replace(/<[^>]+>/g, "");
	}

	private decodeEntities(text: string): string {
		return text
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#x27;/g, "'")
			.replace(/&#39;/g, "'")
			.replace(/&apos;/g, "'");
	}
}
