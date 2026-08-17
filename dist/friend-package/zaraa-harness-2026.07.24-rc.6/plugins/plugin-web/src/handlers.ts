import type { SearchClient, SearchResult } from "./brave-client.js";
import type { WebContentSanitizer } from "./sanitizer.js";
import { isRedirectContent } from "./sanitizer.js";
import { htmlToText, extractMainContent, extractMetaSummary } from "./html-to-text.js";
import { getDomainScore, isBlockedDomain, getReliabilityLabel, getCategoryBoost } from "./domain-reputation.js";
import { extractKeyFacts, stripBoilerplate } from "./sanitizer.js";

// ---------------------------------------------------------------------------
// Search result cache (Improvement #6)
// ---------------------------------------------------------------------------

interface CacheEntry {
	results: ScoredSearchResult[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 50;

const searchCache = new Map<string, CacheEntry>();

function getCachedResults(key: string): ScoredSearchResult[] | null {
	const entry = searchCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
		searchCache.delete(key);
		return null;
	}
	return entry.results;
}

function setCachedResults(key: string, results: ScoredSearchResult[]): void {
	// Evict oldest entries if at capacity
	if (searchCache.size >= CACHE_MAX_ENTRIES) {
		const oldestKey = searchCache.keys().next().value;
		if (oldestKey !== undefined) searchCache.delete(oldestKey);
	}
	searchCache.set(key, { results, timestamp: Date.now() });
}

/** Exported for testing — clears the in-memory search cache. */
export function clearSearchCache(): void {
	searchCache.clear();
}

/** Exported for testing — returns current cache size. */
export function getSearchCacheSize(): number {
	return searchCache.size;
}

// ---------------------------------------------------------------------------
// Search usage tracking (Iter 5 #2)
// ---------------------------------------------------------------------------

interface WebStats {
	searchCount: number;
	fetchCount: number;
	cacheHits: number;
	cacheMisses: number;
}

const webStats: WebStats = { searchCount: 0, fetchCount: 0, cacheHits: 0, cacheMisses: 0 };

/** Get web search/fetch usage stats for dashboard integration. */
export function getWebStats(): Readonly<WebStats> & { cacheHitRate: number } {
	const total = webStats.cacheHits + webStats.cacheMisses;
	return {
		...webStats,
		cacheHitRate: total > 0 ? webStats.cacheHits / total : 0,
	};
}

/** Reset web stats (for testing). */
export function resetWebStats(): void {
	webStats.searchCount = 0;
	webStats.fetchCount = 0;
	webStats.cacheHits = 0;
	webStats.cacheMisses = 0;
}

// ---------------------------------------------------------------------------
// Search result memory (Iter 5 #3)
// ---------------------------------------------------------------------------

interface SearchMemoryEntry {
	query: string;
	topUrls: string[];
	timestamp: number;
}

const MAX_SEARCH_MEMORY = 10;
const searchMemory: SearchMemoryEntry[] = [];

function recordSearchMemory(query: string, urls: string[]): void {
	searchMemory.push({ query, topUrls: urls.slice(0, 3), timestamp: Date.now() });
	if (searchMemory.length > MAX_SEARCH_MEMORY) {
		searchMemory.shift();
	}
}

/** Get recent search queries and their top URLs for cross-referencing. */
export function getSearchMemory(): ReadonlyArray<Readonly<SearchMemoryEntry>> {
	return searchMemory;
}

/** Clear search memory (for testing). */
export function clearSearchMemory(): void {
	searchMemory.length = 0;
}

// ---------------------------------------------------------------------------
// Quality scoring (Improvement #1)
// ---------------------------------------------------------------------------

export interface ScoredSearchResult extends SearchResult {
	score: number;
}

/**
 * Score a search result 0-1 based on domain reputation, snippet length,
 * and title relevance to the query.
 */
export function scoreResult(result: SearchResult, query: string): number {
	// Domain reputation (0-1), weight 40%
	const domainScore = getDomainScore(result.url);

	// Snippet length heuristic (0-1), weight 30%
	// Longer snippets tend to be more informative; cap at 200 chars
	const snippetScore = Math.min(result.snippet.length / 200, 1.0);

	// Title relevance (0-1), weight 30%
	const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
	const titleLower = result.title.toLowerCase();
	const matchCount = queryTerms.filter(term => titleLower.includes(term)).length;
	const titleScore = queryTerms.length > 0 ? matchCount / queryTerms.length : 0.5;

	const base = domainScore * 0.4 + snippetScore * 0.3 + titleScore * 0.3;
	// Category-aware boost (Iter 5 #8)
	const categoryBoost = getCategoryBoost(result.url, query);
	return Math.min(1.0, base + categoryBoost);
}

// ---------------------------------------------------------------------------
// Deduplication (Improvement #3)
// ---------------------------------------------------------------------------

function deduplicateResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return results.filter(r => {
		try {
			const parsed = new URL(r.url);
			// Same domain + path = same page (ignore query params/fragment)
			const key = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		} catch {
			return true; // Keep results with unparseable URLs
		}
	});
}

// ---------------------------------------------------------------------------
// Date-aware search hints (Improvement #4)
// ---------------------------------------------------------------------------

const TIME_SENSITIVE_TERMS = /\b(latest|current|today|recent|now|this\s+week|this\s+month|this\s+year|2025|2026)\b/i;

function augmentQueryWithDate(query: string): string {
	if (TIME_SENSITIVE_TERMS.test(query)) {
		const now = new Date();
		const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		// Only append if not already containing date info
		if (!query.includes(dateStr)) {
			return `${query} ${dateStr}`;
		}
	}
	return query;
}

// ---------------------------------------------------------------------------
// Empty result retry (Improvement #8)
// ---------------------------------------------------------------------------

function simplifyQuery(query: string): string {
	// Remove quotes
	let simplified = query.replace(/["']/g, "");
	// Remove extra operators
	simplified = simplified.replace(/\b(site:|filetype:|intitle:)\S+/gi, "");
	// Keep only the most significant words (drop short ones, keep up to 4)
	const words = simplified.split(/\s+/).filter(w => w.length > 2);
	return words.slice(0, 4).join(" ");
}

// ---------------------------------------------------------------------------
// Max redirect hops (Improvement #9)
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Content-type validation (Iter 3 #5)
// ---------------------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = [
	"text/html",
	"text/plain",
	"application/json",
	"application/xml",
	"text/xml",
	"text/css",
	"text/javascript",
	"application/javascript",
];

function isAllowedContentType(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return ALLOWED_CONTENT_TYPES.some(t => lower.includes(t));
}

// ---------------------------------------------------------------------------
// Response size guard (Iter 3 #6)
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB

// ---------------------------------------------------------------------------
// Action journal for audit trail (Iter 3 #7)
// ---------------------------------------------------------------------------

const fetchAuditLog: Array<{ url: string; timestamp: string; status: number | null }> = [];

/** Exported for testing — returns the audit log of fetched URLs. */
export function getFetchAuditLog(): Array<{ url: string; timestamp: string; status: number | null }> {
	return fetchAuditLog;
}

/** Exported for testing — clears the audit log. */
export function clearFetchAuditLog(): void {
	fetchAuditLog.length = 0;
}

// ---------------------------------------------------------------------------
// Multi-query decomposition (Iter 4 #1)
// ---------------------------------------------------------------------------

const COMPLEX_QUERY_PATTERN = /\b(and|vs|versus|compared to|difference between|or)\b/i;
const QUESTION_WORDS = /^(what|how|why|when|where|who|which|is|are|does|do|can|will|should)\b/i;

function decomposeQuery(query: string): string[] {
	// Only decompose if query looks complex (has conjunctions or is very long)
	if (!COMPLEX_QUERY_PATTERN.test(query) && query.split(/\s+/).length < 8) {
		return [query];
	}

	const subQueries: string[] = [];

	// Split on "and", "vs", "or", "compared to"
	const parts = query.split(/\s+(?:and|vs\.?|versus|compared\s+to|or)\s+/i).filter(p => p.trim().length > 3);

	if (parts.length >= 2 && parts.length <= 4) {
		// Re-add context from the original query if sub-parts are short
		for (const part of parts) {
			const trimmed = part.trim();
			if (trimmed.split(/\s+/).length < 3 && QUESTION_WORDS.test(query)) {
				// Borrow the question structure
				const questionWord = query.match(QUESTION_WORDS)?.[0] ?? "";
				subQueries.push(`${questionWord} ${trimmed}`.trim());
			} else {
				subQueries.push(trimmed);
			}
		}
	} else {
		subQueries.push(query);
	}

	return subQueries.slice(0, 3); // Max 3 sub-queries
}

// ---------------------------------------------------------------------------
// Search timeout recovery (Iter 4 #4)
// ---------------------------------------------------------------------------

function shortenQuery(query: string): string {
	const words = query.split(/\s+/);
	if (words.length <= 3) return query;
	return words.slice(0, 3).join(" ");
}

// ---------------------------------------------------------------------------
// Cross-search result merging (Iter 4 #3)
// ---------------------------------------------------------------------------

function mergeSearchResults(...resultSets: SearchResult[][]): SearchResult[] {
	const seen = new Set<string>();
	const merged: SearchResult[] = [];

	for (const results of resultSets) {
		for (const r of results) {
			try {
				const parsed = new URL(r.url);
				const key = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					merged.push(r);
				}
			} catch {
				merged.push(r);
			}
		}
	}

	return merged;
}

// ---------------------------------------------------------------------------
// User-friendly fetch error messages (Iter 6 #4)
// ---------------------------------------------------------------------------

function getFriendlyFetchError(status: number, url: string): string {
	switch (status) {
		case 401: return `Authentication required — ${url} needs login credentials. Try a different source.`;
		case 403: return `Access denied — this site blocks automated access. Try a different source.`;
		case 404: return `Page not found — ${url} does not exist or was removed.`;
		case 429: return `Rate limited — too many requests to this site. Wait a moment and try again.`;
		case 451: return `Content unavailable for legal reasons — ${url} is geo-blocked or restricted.`;
		case 500: return `Server error at ${url} — the site is having issues. Try again later.`;
		case 502: return `Bad gateway at ${url} — the site's server is down. Try a different source.`;
		case 503: return `Service unavailable at ${url} — the site is temporarily offline. Try again later.`;
		default: return `Fetch failed: ${status} — could not retrieve ${url}.`;
	}
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface WebHandlerDeps {
	searchClient: SearchClient;
	sanitizer: WebContentSanitizer;
	assertSafeUrl?: (url: string) => void;
	/** Optional secondary search client for parallel search (Iter 4 #9) */
	secondarySearchClient?: SearchClient;
	/** Optional logger for warnings. Defaults to console.warn. */
	warn?: (msg: string) => void;
}

export function createWebHandlers(deps: WebHandlerDeps) {
	const { searchClient, sanitizer, assertSafeUrl, secondarySearchClient, warn = console.warn } = deps;

	return {
		// ------------------------------------------------------------------
		// web_search — with scoring, dedup, caching, date hints, retry,
		// multi-query decomposition, parallel search, result preview
		// ------------------------------------------------------------------
		web_search: async (args: Record<string, unknown>): Promise<string> => {
			const searchStartMs = Date.now();
			const query = args.query as string | undefined;
			if (!query) throw new Error("query is required");

			const count = args.count as number | undefined;

			webStats.searchCount++;

			// Check cache first (Improvement #6)
			const cacheKey = `${query}::${count ?? ""}`;
			const cached = getCachedResults(cacheKey);
			if (cached) {
				webStats.cacheHits++;
				return formatScoredResults(cached, sanitizer);
			}
			webStats.cacheMisses++;

			// Augment query with date if time-sensitive (Improvement #4)
			const augmented = augmentQueryWithDate(query);

			// Multi-query decomposition (Iter 4 #1)
			const subQueries = decomposeQuery(augmented);

			let allResults: SearchResult[] = [];

			for (const subQ of subQueries) {
				try {
					// Search with timeout recovery (Iter 4 #4)
					let results: SearchResult[];
					try {
						results = await searchClient.search(subQ, count);
					} catch (err) {
						// Timeout recovery — retry with shorter query
						if (err instanceof Error && (err.name === "TimeoutError" || err.message.includes("timeout"))) {
							const shorter = shortenQuery(subQ);
							if (shorter !== subQ) {
								results = await searchClient.search(shorter, count);
							} else {
								results = [];
							}
						} else {
							throw err;
						}
					}

					// Parallel search with secondary client (Iter 4 #9)
					if (secondarySearchClient && subQueries.length === 1) {
						try {
							const secondaryResults = await secondarySearchClient.search(subQ, count);
							results = mergeSearchResults(results, secondaryResults);
						} catch {
							// Secondary search failure is non-fatal
						}
					}

					allResults.push(...results);
				} catch {
					// Individual sub-query failure is non-fatal if we have other results
				}
			}

			// Merge cross-query results (Iter 4 #3)
			if (subQueries.length > 1) {
				allResults = mergeSearchResults(allResults);
			}

			// If <3 results, retry with simplified query (Iter 4 #2)
			if (allResults.length < 3) {
				const simplified = simplifyQuery(query);
				if (simplified && simplified !== query && simplified !== augmented) {
					try {
						const retryResults = await searchClient.search(simplified, count);
						allResults = mergeSearchResults(allResults, retryResults);
					} catch {
						// Retry failure is non-fatal
					}
				}
			}

			// Original retry logic for 0 results
			if (allResults.length === 0 && augmented !== query) {
				const originalResults = await searchClient.search(query, count);
				allResults.push(...originalResults);
			}
			if (allResults.length === 0) {
				const simplified = simplifyQuery(query);
				if (simplified && simplified !== query) {
					const simplifiedResults = await searchClient.search(simplified, count);
					allResults.push(...simplifiedResults);
				}
			}

			if (allResults.length === 0) {
				return "No results found for the given query.";
			}

			// Filter blocked domains (Improvement #2)
			allResults = allResults.filter(r => !isBlockedDomain(r.url));

			// Deduplicate (Improvement #3)
			allResults = deduplicateResults(allResults);

			// Score and sort (Improvement #1)
			const scored: ScoredSearchResult[] = allResults
				.map(r => ({ ...r, score: scoreResult(r, query) }))
				.sort((a, b) => b.score - a.score);

			// Cache the scored results (Improvement #6)
			setCachedResults(cacheKey, scored);

			// Record in search memory for cross-referencing (Iter 5 #3)
			recordSearchMemory(query, scored.map(r => r.url));

			// Add timing and token estimate metadata (Iter 6 #2, #3)
			const searchElapsedMs = Date.now() - searchStartMs;
			const formatted = formatScoredResults(scored, sanitizer);
			const tokenEstimate = Math.ceil(formatted.length / 4);
			return `${formatted}\n[Search completed in ${searchElapsedMs}ms | ~${tokenEstimate} tokens]`;
		},

		// ------------------------------------------------------------------
		// web_fetch — with main content extraction, redirect safety,
		// citation, confidence, content-type validation, size guard
		// ------------------------------------------------------------------
		web_fetch: async (args: Record<string, unknown>): Promise<string> => {
			const fetchStartMs = Date.now();
			const url = args.url as string | undefined;
			if (!url) throw new Error("url is required");

			const maxLength = args.maxLength as number | undefined;

			if (!assertSafeUrl) {
				throw new Error("SSRF protection not configured — web_fetch disabled");
			}
			assertSafeUrl(url);

			webStats.fetchCount++;

			// Fetch with redirect limit (Improvement #9)
			let currentUrl = url;
			let response: Response | null = null;
			let redirectCount = 0;

			while (redirectCount <= MAX_REDIRECTS) {
				response = await fetch(currentUrl, {
					headers: {
						"User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
						Accept: "text/html, text/plain, */*",
					},
					redirect: "manual",
					signal: AbortSignal.timeout(30_000),
				});

				// Handle redirects manually to count hops
				if (
					response.status >= 300 &&
					response.status < 400 &&
					response.headers.get("location")
				) {
					redirectCount++;
					const location = response.headers.get("location")!;
					// Resolve relative redirects
					currentUrl = new URL(location, currentUrl).toString();

					if (redirectCount > MAX_REDIRECTS) {
						warn(
							`web_fetch: Redirect chain exceeded ${MAX_REDIRECTS} hops for ${url} — aborting`,
						);
						throw new Error(
							`Too many redirects (>${MAX_REDIRECTS}) for ${url}`,
						);
					}
					if (redirectCount >= 3) {
						warn(
							`web_fetch: Redirect chain at ${redirectCount} hops for ${url}`,
						);
					}
					continue;
				}
				break;
			}

			if (!response || !response.ok) {
				const status = response?.status ?? 0;
				const statusText = response?.statusText ?? "Unknown";
				// Audit log (Iter 3 #7)
				fetchAuditLog.push({ url, timestamp: new Date().toISOString(), status });
				// User-friendly error messages (Iter 6 #4)
				const friendlyMsg = getFriendlyFetchError(status, url);
				throw new Error(friendlyMsg);
			}

			// Content-type validation (Iter 3 #5)
			const contentType =
				response.headers.get("content-type") ?? "text/html";
			if (!isAllowedContentType(contentType)) {
				fetchAuditLog.push({ url, timestamp: new Date().toISOString(), status: response.status });
				throw new Error(`Rejected content-type: ${contentType} — only text/html, text/plain, application/json accepted`);
			}

			// Response size guard (Iter 3 #6)
			const contentLength = response.headers.get("content-length");
			if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
				fetchAuditLog.push({ url, timestamp: new Date().toISOString(), status: response.status });
				throw new Error(`Response too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`);
			}

			const raw = await response.text();

			// Post-download size check (in case content-length header was missing)
			if (raw.length > MAX_RESPONSE_SIZE) {
				fetchAuditLog.push({ url, timestamp: new Date().toISOString(), status: response.status });
				throw new Error(`Response too large: ${raw.length} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`);
			}

			// Audit log (Iter 3 #7)
			fetchAuditLog.push({ url, timestamp: new Date().toISOString(), status: response.status });

			let text: string;
			let metaSummary = "";
			if (contentType.includes("text/html")) {
				// Extract meta summary from HTML head (Iter 2 #7)
				metaSummary = extractMetaSummary(raw);

				// Content length intelligence (Improvement #7)
				if (raw.length > 16_000) {
					text = extractMainContent(raw);
				} else {
					text = htmlToText(raw);
				}
			} else {
				text = raw;
			}

			// Redirect content detection (Iter 2 #3)
			if (isRedirectContent(text)) {
				text = `[WARNING: Page appears to be a redirect page, not actual content]\n${text}`;
			}

			// Short content warning (Iter 2 #6)
			if (text.replace(/\s+/g, "").length < 100) {
				text = `[WARNING: Page content is very short — may be paywalled, empty, or require JavaScript]\n${text}`;
			}

			// Strip boilerplate (Iter 5 #10)
			text = stripBoilerplate(text);

			// Prepend meta summary if available (Iter 2 #7)
			if (metaSummary) {
				text = `${metaSummary}\n---\n${text}`;
			}

			// Extract key facts and format as bullet list at top (Iter 5 #4)
			const keyFacts = extractKeyFacts(text);
			if (keyFacts.length > 0) {
				const factsBullets = keyFacts.slice(0, 8).map(f => `- ${f}`).join("\n");
				text = `KEY FACTS:\n${factsBullets}\n---\n${text}`;
			}

			const { sanitized } = sanitizer.sanitize(text, { maxLength });

			// Append source citation (Iter 2 #4) and confidence (Iter 2 #5)
			const fetchTime = new Date().toISOString();
			const reliability = getReliabilityLabel(url);
			const fetchElapsedMs = Date.now() - fetchStartMs;
			const tokenEstimate = Math.ceil(sanitized.length / 4);
			const citation = `\nSource: ${currentUrl}\nFetched: ${fetchTime}\nSource reliability: ${reliability}\n[Fetched in ${fetchElapsedMs}ms | ~${tokenEstimate} tokens]`;
			return `${sanitized}\n${citation}`;
		},

		// ------------------------------------------------------------------
		// web_search_and_read — composite tool (Improvement #10)
		// with result preview (Iter 4 #10)
		// ------------------------------------------------------------------
		web_search_and_read: async (args: Record<string, unknown>): Promise<string> => {
			const query = args.query as string | undefined;
			if (!query) throw new Error("query is required");

			const maxLength = args.maxLength as number | undefined;

			if (!assertSafeUrl) {
				throw new Error("SSRF protection not configured — web_search_and_read disabled");
			}

			// Use the web_search handler internally to get results
			const count = 5;
			const augmented = augmentQueryWithDate(query);
			let results = await searchClient.search(augmented, count);

			if (results.length === 0 && augmented !== query) {
				results = await searchClient.search(query, count);
			}
			if (results.length === 0) {
				const simplified = simplifyQuery(query);
				if (simplified && simplified !== query) {
					results = await searchClient.search(simplified, count);
				}
			}

			if (results.length === 0) {
				return "No results found for the given query.";
			}

			// Filter and score
			results = results.filter(r => !isBlockedDomain(r.url));
			results = deduplicateResults(results);
			const scored = results
				.map(r => ({ ...r, score: scoreResult(r, query) }))
				.sort((a, b) => b.score - a.score);

			if (scored.length === 0) {
				return "No usable results found for the given query.";
			}

			// Pick top result and fetch it
			const topResult = scored[0];

			try {
				assertSafeUrl(topResult.url);
			} catch {
				return `Top result URL not safe to fetch: ${topResult.url}\n\nOther results:\n${formatResultList(scored.slice(1))}`;
			}

			let fetchedContent: string;
			try {
				let currentUrl = topResult.url;
				let response: Response | null = null;
				let redirectCount = 0;

				while (redirectCount <= MAX_REDIRECTS) {
					response = await fetch(currentUrl, {
						headers: {
							"User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
							Accept: "text/html, text/plain, */*",
						},
						redirect: "manual",
						signal: AbortSignal.timeout(30_000),
					});

					if (
						response.status >= 300 &&
						response.status < 400 &&
						response.headers.get("location")
					) {
						redirectCount++;
						currentUrl = new URL(
							response.headers.get("location")!,
							currentUrl,
						).toString();
						if (redirectCount > MAX_REDIRECTS) {
							throw new Error(`Too many redirects`);
						}
						continue;
					}
					break;
				}

				if (!response || !response.ok) {
					throw new Error(`HTTP ${response?.status}`);
				}

				// Content-type validation (Iter 3 #5)
				const contentType =
					response.headers.get("content-type") ?? "text/html";
				if (!isAllowedContentType(contentType)) {
					throw new Error(`Rejected content-type: ${contentType}`);
				}

				const raw = await response.text();

				// Size guard (Iter 3 #6)
				if (raw.length > MAX_RESPONSE_SIZE) {
					throw new Error(`Response too large: ${raw.length} bytes`);
				}

				let text: string;
				let metaSummary = "";
				if (contentType.includes("text/html")) {
					metaSummary = extractMetaSummary(raw);
					text = raw.length > 16_000 ? extractMainContent(raw) : htmlToText(raw);
				} else {
					text = raw;
				}

				// Prepend meta summary if available
				if (metaSummary) {
					text = `${metaSummary}\n---\n${text}`;
				}

				const { sanitized } = sanitizer.sanitize(text, { maxLength });
				fetchedContent = sanitized;
			} catch (err) {
				// If fetch fails, return search results as fallback
				const errMsg = err instanceof Error ? err.message : String(err);
				return `Failed to fetch top result (${errMsg}).\n\nSearch results:\n${formatResultList(scored)}`;
			}

			// Return source info + content + reliability
			const reliability = getReliabilityLabel(topResult.url);
			const header = `Source: ${topResult.title}\nURL: ${topResult.url}\nSource reliability: ${reliability}\n${"=".repeat(60)}\n\n`;

			// Search result preview for remaining results (Iter 4 #10)
			const otherPreviews = scored.slice(1, 4).map((r, i) =>
				`${i + 2}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet.slice(0, 200)}`,
			).join("\n\n");

			const footer = otherPreviews
				? `\n\n${"=".repeat(60)}\nOther results:\n${otherPreviews}`
				: "";

			return header + fetchedContent + footer;
		},

		// ------------------------------------------------------------------
		// web_quick_answer — search + read top 3 + extract answer (Iter 6 #5)
		// ------------------------------------------------------------------
		web_quick_answer: async (args: Record<string, unknown>): Promise<string> => {
			const question = args.question as string | undefined;
			if (!question) throw new Error("question is required");

			const quickStartMs = Date.now();

			if (!assertSafeUrl) {
				throw new Error("SSRF protection not configured — web_quick_answer disabled");
			}

			webStats.searchCount++;

			// Search for the question
			const augmented = augmentQueryWithDate(question);
			let results = await searchClient.search(augmented, 5);

			if (results.length === 0 && augmented !== question) {
				results = await searchClient.search(question, 5);
			}
			if (results.length === 0) {
				return "Could not find an answer to this question.";
			}

			// Filter, dedup, score
			results = results.filter(r => !isBlockedDomain(r.url));
			results = deduplicateResults(results);
			const scored = results
				.map(r => ({ ...r, score: scoreResult(r, question) }))
				.sort((a, b) => b.score - a.score);

			if (scored.length === 0) {
				return "Could not find an answer to this question.";
			}

			// Fetch top 3 results in parallel, extract key facts
			const top3 = scored.slice(0, 3);
			const excerpts: string[] = [];

			const fetchPromises = top3.map(async (result) => {
				try {
					assertSafeUrl!(result.url);
					const resp = await fetch(result.url, {
						headers: {
							"User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
							Accept: "text/html, text/plain, */*",
						},
						redirect: "follow",
						signal: AbortSignal.timeout(10_000),
					});

					if (!resp.ok) return null;

					const contentType = resp.headers.get("content-type") ?? "text/html";
					if (!isAllowedContentType(contentType)) return null;

					const raw = await resp.text();
					if (raw.length > MAX_RESPONSE_SIZE) return null;

					let text: string;
					if (contentType.includes("text/html")) {
						text = raw.length > 16_000 ? extractMainContent(raw) : htmlToText(raw);
					} else {
						text = raw;
					}

					// Strip boilerplate
					text = stripBoilerplate(text);

					// Extract key facts
					const facts = extractKeyFacts(text);

					// Get the most relevant paragraph (containing query terms)
					const queryTerms = question.toLowerCase().split(/\s+/).filter(t => t.length > 2);
					const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 30);
					const relevantParagraph = paragraphs.find(p => {
						const lower = p.toLowerCase();
						return queryTerms.some(t => lower.includes(t));
					}) ?? paragraphs[0] ?? "";

					return {
						title: result.title,
						url: result.url,
						facts: facts.slice(0, 3),
						excerpt: relevantParagraph.slice(0, 500),
						reliability: getReliabilityLabel(result.url),
					};
				} catch {
					return null;
				}
			});

			const fetchedResults = await Promise.all(fetchPromises);

			for (const fr of fetchedResults) {
				if (!fr) continue;
				const parts: string[] = [];
				parts.push(`From: ${fr.title} (${fr.url}) [${fr.reliability}]`);
				if (fr.facts.length > 0) {
					parts.push("Key facts:");
					for (const f of fr.facts) parts.push(`  - ${f}`);
				}
				if (fr.excerpt) {
					parts.push(`Excerpt: ${fr.excerpt}`);
				}
				excerpts.push(parts.join("\n"));
			}

			if (excerpts.length === 0) {
				// Fall back to snippets if all fetches failed
				const snippetAnswer = scored.slice(0, 3).map((r, i) =>
					`${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.url}`,
				).join("\n\n");
				return `Could not fetch pages, but here are search snippets:\n\n${snippetAnswer}`;
			}

			const elapsedMs = Date.now() - quickStartMs;
			const answer = excerpts.join("\n\n---\n\n");
			const tokenEstimate = Math.ceil(answer.length / 4);
			return `Quick answer for: "${question}"\n${"=".repeat(60)}\n\n${answer}\n\n[Answered in ${elapsedMs}ms from ${excerpts.length} sources | ~${tokenEstimate} tokens]`;
		},
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatScoredResults(
	results: ScoredSearchResult[],
	sanitizer: WebContentSanitizer,
): string {
	const formatted = results
		.map(
			(r, i) =>
				`${i + 1}. ${r.title} [score: ${r.score.toFixed(2)}]\n   URL: ${r.url}\n   ${r.snippet}`,
		)
		.join("\n\n");

	const { sanitized } = sanitizer.sanitize(formatted);
	return sanitized;
}

function formatResultList(results: SearchResult[]): string {
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}
