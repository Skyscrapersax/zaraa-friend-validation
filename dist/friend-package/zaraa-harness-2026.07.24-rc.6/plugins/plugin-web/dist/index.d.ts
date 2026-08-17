import { PluginManifest } from '@zaraa/shared';

interface SanitizeResult {
    sanitized: string;
    patternsDetected: string[];
    truncated: boolean;
}
/**
 * Extract sentences containing factual data points (numbers, dates, names, prices).
 * Useful for identifying key claims that can be verified.
 */
declare function extractKeyFacts(content: string): string[];
/**
 * Detect facts that contain conflicting numeric claims about the same subject.
 * Returns array of conflict descriptions.
 */
declare function detectConflictingClaims(facts: string[]): string[];
/**
 * Detect if content appears to be a redirect page rather than real content.
 */
declare function isRedirectContent(content: string): boolean;
/**
 * Detect cryptocurrency scam patterns in content.
 * Returns array of matched scam indicators.
 */
declare function detectCryptoScams(content: string): string[];
/**
 * Detect phishing patterns in content.
 */
declare function detectPhishing(content: string): string[];
/**
 * Strip data: URLs from content (can contain malicious payloads).
 */
declare function stripDataUrls(text: string): string;
/**
 * Detect if content has excessive external links (likely spam).
 */
declare function hasExcessiveLinks(content: string): boolean;
/**
 * Rate fetched content quality 0-1 based on:
 * - Text-to-markup ratio (higher = better)
 * - Presence of ad indicators (lower quality)
 * - Readability (paragraph length, sentence structure)
 */
declare function scoreContentQuality(rawHtml: string, cleanText: string): number;
/**
 * Strip common boilerplate text (newsletter CTAs, cookie policy notices)
 * from content for cleaner LLM consumption.
 */
declare function stripBoilerplate(text: string): string;
interface SanitizeOptions {
    maxLength?: number;
}
declare class WebContentSanitizer {
    sanitize(raw: string, options?: SanitizeOptions): SanitizeResult;
}

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}
/** Common interface for all search providers */
interface SearchClient {
    search(query: string, count?: number): Promise<SearchResult[]>;
}
declare class BraveSearchClient {
    private apiKey;
    constructor(apiKey: string);
    search(query: string, count?: number): Promise<SearchResult[]>;
}

/**
 * Free search client using DuckDuckGo's HTML endpoint.
 * No API key required. Parses the lightweight HTML results page.
 * Includes retry with exponential backoff and User-Agent rotation.
 */
declare class DuckDuckGoClient implements SearchClient {
    search(query: string, count?: number): Promise<SearchResult[]>;
    private parseResults;
    private stripTags;
    private decodeEntities;
}

/**
 * Keyless fallback search using the MediaWiki (Wikipedia) search API.
 *
 * Unlike DuckDuckGo's HTML endpoint, the Wikipedia API is a stable, documented
 * JSON API that does not bot-block or IP-rate-limit ordinary use — so it is a
 * reliable last resort when the primary web backend (DuckDuckGo / Brave) is
 * unavailable. It is factual/encyclopedic only (no current-events / prices),
 * so it complements rather than replaces a real web search backend.
 */
declare class WikipediaSearchClient implements SearchClient {
    search(query: string, count?: number): Promise<SearchResult[]>;
}

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
declare class SearxngSearchClient implements SearchClient {
    private readonly baseUrl;
    constructor(baseUrl?: string);
    search(query: string, count?: number): Promise<SearchResult[]>;
}

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
declare class TavilySearchClient implements SearchClient {
    private readonly apiKey;
    constructor(apiKey: string);
    search(query: string, count?: number): Promise<SearchResult[]>;
}

/**
 * Tries an ordered list of search backends and returns the first non-empty
 * result set. A single backend is a single point of failure: when DuckDuckGo
 * IP-blocks the host (network-level, no HTTP response), web research returns
 * nothing and the model can only say "search timed out". Chaining a keyless
 * fallback (e.g. Wikipedia) keeps research alive — degraded, but real.
 *
 * Semantics:
 *  - first backend that returns ≥1 result wins (later backends are skipped);
 *  - a backend that throws is treated as unavailable and the next is tried;
 *  - if every backend throws, the last error is rethrown so the handler's
 *    timeout-recovery still fires;
 *  - if at least one backend completed (even with zero results), an empty array
 *    is returned so the model degrades gracefully instead of erroring.
 */
interface FallbackSearchOptions {
    /**
     * Max time to wait on a single backend before giving up and trying the next.
     * A blocked primary (e.g. DuckDuckGo IP-block) can hang ~10s per attempt ×
     * retries; without this bound the whole chat turn is spent before the fast
     * fallback runs. Defaults to 10s.
     */
    perClientTimeoutMs?: number;
}
declare class FallbackSearchClient implements SearchClient {
    private readonly clients;
    private readonly perClientTimeoutMs;
    constructor(clients: SearchClient[], options?: FallbackSearchOptions);
    search(query: string, count?: number): Promise<SearchResult[]>;
    private withTimeout;
}

/** Exported for testing — clears the in-memory search cache. */
declare function clearSearchCache(): void;
/** Exported for testing — returns current cache size. */
declare function getSearchCacheSize(): number;
interface WebStats {
    searchCount: number;
    fetchCount: number;
    cacheHits: number;
    cacheMisses: number;
}
/** Get web search/fetch usage stats for dashboard integration. */
declare function getWebStats(): Readonly<WebStats> & {
    cacheHitRate: number;
};
/** Reset web stats (for testing). */
declare function resetWebStats(): void;
interface SearchMemoryEntry {
    query: string;
    topUrls: string[];
    timestamp: number;
}
/** Get recent search queries and their top URLs for cross-referencing. */
declare function getSearchMemory(): ReadonlyArray<Readonly<SearchMemoryEntry>>;
/** Clear search memory (for testing). */
declare function clearSearchMemory(): void;
interface ScoredSearchResult extends SearchResult {
    score: number;
}
/**
 * Score a search result 0-1 based on domain reputation, snippet length,
 * and title relevance to the query.
 */
declare function scoreResult(result: SearchResult, query: string): number;
/** Exported for testing — returns the audit log of fetched URLs. */
declare function getFetchAuditLog(): Array<{
    url: string;
    timestamp: string;
    status: number | null;
}>;
/** Exported for testing — clears the audit log. */
declare function clearFetchAuditLog(): void;
interface WebHandlerDeps {
    searchClient: SearchClient;
    sanitizer: WebContentSanitizer;
    assertSafeUrl?: (url: string) => void;
    /** Optional secondary search client for parallel search (Iter 4 #9) */
    secondarySearchClient?: SearchClient;
    /** Optional logger for warnings. Defaults to console.warn. */
    warn?: (msg: string) => void;
}
declare function createWebHandlers(deps: WebHandlerDeps): {
    web_search: (args: Record<string, unknown>) => Promise<string>;
    web_fetch: (args: Record<string, unknown>) => Promise<string>;
    web_search_and_read: (args: Record<string, unknown>) => Promise<string>;
    web_quick_answer: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Extract meta description and title from HTML head.
 * Returns a summary string to prepend to content. (Iter 2 #7)
 */
declare function extractMetaSummary(html: string): string;
/**
 * Converts HTML to clean plaintext with improved content extraction.
 * - Removes nav/header/footer/aside chrome before converting
 * - Extracts article/main content preferentially
 * - Preserves list formatting (bullet points)
 * - Keeps link URLs inline: text (url)
 * - Strips cookie consent banners (Iter 2 #8)
 */
declare function htmlToText(html: string): string;
/**
 * Extract the main article content from HTML if identifiable.
 * Falls back to full htmlToText if no main content container found.
 * Used when content is very long (>16K chars) to avoid blind truncation.
 */
declare function extractMainContent(html: string): string;

/**
 * Domain reputation scoring for search result quality ranking.
 * Trusted domains get a bonus; blocked domains are filtered out.
 * Includes dynamic reputation tracking (Iter 4 #7, #8).
 * Includes auto-learning from task completions and category tags (Iter 5 #7, #8).
 */
type DomainCategory = "news" | "docs" | "crypto" | "social" | "reference" | "general";
/**
 * Get the category tag for a domain.
 * Returns "general" for unknown domains.
 */
declare function getDomainCategory(url: string): DomainCategory;
/**
 * Get a context-aware score boost based on domain category matching the search context.
 * E.g., crypto domains get a boost for crypto-related queries.
 */
declare function getCategoryBoost(url: string, queryContext?: string): number;
declare const TRUSTED_DOMAINS: Set<string>;
declare const BLOCKED_DOMAINS: Set<string>;
/**
 * Record a successful content fetch from a domain.
 */
declare function recordDomainSuccess(url: string): void;
/**
 * Record an error or empty result from a domain.
 */
declare function recordDomainFailure(url: string, type: "error" | "empty"): void;
/**
 * Auto-learn: boost a domain's reputation when a search result from it
 * contributed to a successful task completion (Iter 5 #7).
 * Called with the trace score (0-1) from the task trace store.
 */
declare function boostDomainFromTraceScore(url: string, traceScore: number): void;
/** Exported for testing — clears dynamic reputation data. */
declare function clearDynamicReputation(): void;
/** Exported for testing — returns dynamic reputation map size. */
declare function getDynamicReputationSize(): number;
/**
 * Extract the registrable domain from a URL (e.g. "en.wikipedia.org" -> "wikipedia.org").
 */
declare function extractDomain(url: string): string;
/**
 * Returns a reputation score 0-1 for a given URL.
 * - Trusted domains: 1.0
 * - Blocked domains: 0.0
 * - Unknown domains: 0.5
 * - Dynamic adjustment applied on top (Iter 4 #7, #8)
 */
declare function getDomainScore(url: string): number;
/**
 * Check whether a URL belongs to a blocked domain.
 * Also checks ad/tracking domains (Iter 2 #10).
 */
declare function isBlockedDomain(url: string): boolean;
/**
 * Get a human-readable reliability label for a URL (Iter 2 #5).
 * Used in source citations.
 */
declare function getReliabilityLabel(url: string): string;

declare const manifest: PluginManifest;

export { BLOCKED_DOMAINS, BraveSearchClient, type DomainCategory, DuckDuckGoClient, FallbackSearchClient, type SanitizeResult, type ScoredSearchResult, type SearchClient, type SearchResult, SearxngSearchClient, TRUSTED_DOMAINS, TavilySearchClient, WebContentSanitizer, type WebHandlerDeps, WikipediaSearchClient, boostDomainFromTraceScore, clearDynamicReputation, clearFetchAuditLog, clearSearchCache, clearSearchMemory, createWebHandlers, detectConflictingClaims, detectCryptoScams, detectPhishing, extractDomain, extractKeyFacts, extractMainContent, extractMetaSummary, getCategoryBoost, getDomainCategory, getDomainScore, getDynamicReputationSize, getFetchAuditLog, getReliabilityLabel, getSearchCacheSize, getSearchMemory, getWebStats, hasExcessiveLinks, htmlToText, isBlockedDomain, isRedirectContent, manifest, recordDomainFailure, recordDomainSuccess, resetWebStats, scoreContentQuality, scoreResult, stripBoilerplate, stripDataUrls };
