import type { PluginManifest } from "@zaraa/shared";

export { WebContentSanitizer, extractKeyFacts, detectConflictingClaims, isRedirectContent, detectCryptoScams, detectPhishing, stripDataUrls, hasExcessiveLinks, scoreContentQuality, stripBoilerplate } from "./sanitizer.js";
export type { SanitizeResult } from "./sanitizer.js";
export { BraveSearchClient } from "./brave-client.js";
export { DuckDuckGoClient } from "./ddg-client.js";
export { WikipediaSearchClient } from "./wikipedia-client.js";
export { SearxngSearchClient } from "./searxng-client.js";
export { TavilySearchClient } from "./tavily-client.js";
export { FallbackSearchClient } from "./fallback-client.js";
export type { SearchClient, SearchResult } from "./brave-client.js";
export { createWebHandlers, scoreResult, clearSearchCache, getSearchCacheSize, getFetchAuditLog, clearFetchAuditLog, getWebStats, resetWebStats, getSearchMemory, clearSearchMemory } from "./handlers.js";
export type { ScoredSearchResult, WebHandlerDeps } from "./handlers.js";
export { htmlToText, extractMainContent, extractMetaSummary } from "./html-to-text.js";
export { getDomainScore, isBlockedDomain, getReliabilityLabel, TRUSTED_DOMAINS, BLOCKED_DOMAINS, extractDomain, recordDomainSuccess, recordDomainFailure, clearDynamicReputation, getDynamicReputationSize, boostDomainFromTraceScore, getDomainCategory, getCategoryBoost } from "./domain-reputation.js";
export type { DomainCategory } from "./domain-reputation.js";

export const manifest: PluginManifest = {
	name: "web",
	version: "0.4.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["network.request"],
	trust: "core",
	tools: [
		{
			name: "web_search",
			description:
				"Search the web and return ranked results. Use for finding current information, news, prices, documentation, or anything you don't know. Returns titles, URLs, snippets, quality scores, timing, and token estimate. Results are deduplicated, scored by domain reputation and category relevance, and cached for 5 minutes. Complex queries are automatically split into sub-queries.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The search query — be specific for better results",
					},
					count: {
						type: "number",
						description:
							"Number of results to return (default: 5, max: 10)",
					},
				},
				required: ["query"],
			},
			requiresApproval: false,
		},
		{
			name: "web_fetch",
			description:
				"Fetch and read a specific web page by URL. Use when you have an exact URL to read (e.g., from a user or from web_search results). Extracts main content from HTML, strips boilerplate/ads/cookie banners, highlights key facts as bullets, and includes source citation with reliability scoring. Protected against crypto scams, phishing, and prompt injection.",
			parameters: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "The full URL to fetch (must start with https:// or http://)",
					},
					maxLength: {
						type: "number",
						description:
							"Maximum characters to return (default: 16000). Use lower values for quick reads.",
					},
				},
				required: ["url"],
			},
			requiresApproval: false,
		},
		{
			name: "web_search_and_read",
			description:
				"Search the web AND read the top result in one step. Use when you need to find and read about a topic — saves a round-trip vs. calling web_search then web_fetch. Returns the full page content of the best result plus previews of other results. Falls back to search snippets if the page cannot be fetched.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The search query — what you want to find and read about",
					},
					maxLength: {
						type: "number",
						description:
							"Maximum characters to return (default: 16000)",
					},
				},
				required: ["query"],
			},
			requiresApproval: false,
		},
		{
			name: "web_quick_answer",
			description:
				"Get a concise answer to a factual question. Searches the web, reads the top 3 results, and extracts just the key facts and relevant excerpts — no full page content. Use for quick factual lookups like 'What is the population of Tokyo?' or 'When was Python 3.12 released?'. Faster and more focused than web_search_and_read.",
			parameters: {
				type: "object",
				properties: {
					question: {
						type: "string",
						description: "The factual question to answer",
					},
				},
				required: ["question"],
			},
			requiresApproval: false,
		},
	],
};
