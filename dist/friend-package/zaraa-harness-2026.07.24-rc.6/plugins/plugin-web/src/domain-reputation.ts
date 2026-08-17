/**
 * Domain reputation scoring for search result quality ranking.
 * Trusted domains get a bonus; blocked domains are filtered out.
 * Includes dynamic reputation tracking (Iter 4 #7, #8).
 * Includes auto-learning from task completions and category tags (Iter 5 #7, #8).
 */

// ---------------------------------------------------------------------------
// Domain category tags (Iter 5 #8)
// ---------------------------------------------------------------------------

export type DomainCategory = "news" | "docs" | "crypto" | "social" | "reference" | "general";

const DOMAIN_CATEGORIES = new Map<string, DomainCategory>([
	// Reference
	["wikipedia.org", "reference"],
	["arxiv.org", "reference"],
	["nature.com", "reference"],
	["investopedia.com", "reference"],
	// Docs (use registrable domain — extractDomain strips subdomains)
	["github.com", "docs"],
	["stackoverflow.com", "docs"],
	["python.org", "docs"],
	["mozilla.org", "docs"],
	["npmjs.com", "docs"],
	["typescriptlang.org", "docs"],
	["rust-lang.org", "docs"],
	["docs.rs", "docs"],
	["nodejs.org", "docs"],
	["anthropic.com", "docs"],
	["openai.com", "docs"],
	["docker.com", "docs"],
	["google.com", "docs"],
	["microsoft.com", "docs"],
	["dev.to", "docs"],
	["medium.com", "docs"],
	// News
	["reuters.com", "news"],
	["bbc.com", "news"],
	["nytimes.com", "news"],
	["apnews.com", "news"],
	["cnbc.com", "news"],
	["bloomberg.com", "news"],
	["techcrunch.com", "news"],
	["theverge.com", "news"],
	["arstechnica.com", "news"],
	["wired.com", "news"],
	// Crypto
	["coindesk.com", "crypto"],
	["coingecko.com", "crypto"],
	["cointelegraph.com", "crypto"],
	["messari.io", "crypto"],
	["defillama.com", "crypto"],
	["dune.com", "crypto"],
	["theblock.co", "crypto"],
	["decrypt.co", "crypto"],
]);

/**
 * Get the category tag for a domain.
 * Returns "general" for unknown domains.
 */
export function getDomainCategory(url: string): DomainCategory {
	const domain = extractDomain(url);
	return DOMAIN_CATEGORIES.get(domain) ?? "general";
}

/**
 * Get a context-aware score boost based on domain category matching the search context.
 * E.g., crypto domains get a boost for crypto-related queries.
 */
export function getCategoryBoost(url: string, queryContext?: string): number {
	if (!queryContext) return 0;
	const category = getDomainCategory(url);
	const ctx = queryContext.toLowerCase();

	if (category === "crypto" && /\b(crypto|bitcoin|btc|eth|blockchain|defi|token|web3|solana|xrp)\b/.test(ctx)) return 0.1;
	if (category === "news" && /\b(news|latest|today|breaking|update|announce|report)\b/.test(ctx)) return 0.1;
	if (category === "docs" && /\b(how to|tutorial|guide|documentation|api|install|setup|configure|error|bug|fix)\b/.test(ctx)) return 0.1;
	if (category === "reference" && /\b(what is|define|meaning|explain|overview|history|wiki)\b/.test(ctx)) return 0.1;

	return 0;
}

export const TRUSTED_DOMAINS = new Set([
	"wikipedia.org",
	"github.com",
	"stackoverflow.com",
	"arxiv.org",
	"reuters.com",
	"docs.python.org",
	"developer.mozilla.org",
	"investopedia.com",
	"coindesk.com",
	"coingecko.com",
	"cointelegraph.com",
	"npmjs.com",
	"typescriptlang.org",
	"rust-lang.org",
	"docs.rs",
	"python.org",
	"nodejs.org",
	"bbc.com",
	"nytimes.com",
	"apnews.com",
	"nature.com",
	"medium.com",
	"dev.to",
	// News sources (Iter 2 #9)
	"cnbc.com",
	"bloomberg.com",
	"techcrunch.com",
	"theverge.com",
	"arstechnica.com",
	"wired.com",
	// Crypto sources (Iter 2 #9)
	"messari.io",
	"defillama.com",
	"dune.com",
	"theblock.co",
	"decrypt.co",
	// Dev docs (Iter 2 #9)
	"docs.anthropic.com",
	"platform.openai.com",
	"docs.docker.com",
	"docs.github.com",
	"cloud.google.com",
	"learn.microsoft.com",
]);

export const BLOCKED_DOMAINS = new Set([
	"malware.com",
	"phishing-site.com",
]);

// ---------------------------------------------------------------------------
// Ad/tracking domain blocklist (Iter 2 #10)
// ---------------------------------------------------------------------------

const AD_TRACKING_DOMAINS = new Set([
	"doubleclick.net",
	"googlesyndication.com",
	"googleadservices.com",
	"google-analytics.com",
	"googletagmanager.com",
	"facebook.com",
	"facebook.net",
	"fbcdn.net",
	"amazon-adsystem.com",
	"adsrvr.org",
	"adnxs.com",
	"criteo.com",
	"outbrain.com",
	"taboola.com",
	"scorecardresearch.com",
	"quantserve.com",
	"moatads.com",
	"mixpanel.com",
	"hotjar.com",
	"segment.io",
	"amplitude.com",
]);

// ---------------------------------------------------------------------------
// Dynamic reputation tracking (Iter 4 #7, #8)
// ---------------------------------------------------------------------------

interface DomainStats {
	successCount: number;
	errorCount: number;
	emptyCount: number;
}

const dynamicReputation = new Map<string, DomainStats>();

/**
 * Record a successful content fetch from a domain.
 */
export function recordDomainSuccess(url: string): void {
	const domain = extractDomain(url);
	if (!domain) return;
	const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
	stats.successCount++;
	dynamicReputation.set(domain, stats);
}

/**
 * Record an error or empty result from a domain.
 */
export function recordDomainFailure(url: string, type: "error" | "empty"): void {
	const domain = extractDomain(url);
	if (!domain) return;
	const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
	if (type === "error") stats.errorCount++;
	else stats.emptyCount++;
	dynamicReputation.set(domain, stats);
}

/**
 * Get the dynamic reputation adjustment for a domain (-0.2 to +0.1).
 * Domains that frequently return errors/empty get downranked (Iter 4 #8).
 */
function getDynamicAdjustment(domain: string): number {
	const stats = dynamicReputation.get(domain);
	if (!stats) return 0;
	const total = stats.successCount + stats.errorCount + stats.emptyCount;
	if (total < 3) return 0; // Not enough data
	const failRate = (stats.errorCount + stats.emptyCount) / total;
	if (failRate > 0.7) return -0.2;
	if (failRate > 0.5) return -0.1;
	if (failRate < 0.1 && stats.successCount >= 5) return 0.1;
	return 0;
}

/**
 * Auto-learn: boost a domain's reputation when a search result from it
 * contributed to a successful task completion (Iter 5 #7).
 * Called with the trace score (0-1) from the task trace store.
 */
export function boostDomainFromTraceScore(url: string, traceScore: number): void {
	if (traceScore < 0.6) return; // Only boost on good outcomes
	const domain = extractDomain(url);
	if (!domain) return;
	const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
	// Each high-score trace counts as extra successes proportional to score
	const bonus = Math.round(traceScore * 3);
	stats.successCount += bonus;
	dynamicReputation.set(domain, stats);
}

/** Exported for testing — clears dynamic reputation data. */
export function clearDynamicReputation(): void {
	dynamicReputation.clear();
}

/** Exported for testing — returns dynamic reputation map size. */
export function getDynamicReputationSize(): number {
	return dynamicReputation.size;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Extract the registrable domain from a URL (e.g. "en.wikipedia.org" -> "wikipedia.org").
 */
export function extractDomain(url: string): string {
	try {
		const hostname = new URL(url).hostname;
		const parts = hostname.split(".");
		// Handle 2-part TLDs like co.uk
		if (parts.length >= 2) {
			return parts.slice(-2).join(".");
		}
		return hostname;
	} catch {
		return "";
	}
}

/**
 * Returns a reputation score 0-1 for a given URL.
 * - Trusted domains: 1.0
 * - Blocked domains: 0.0
 * - Unknown domains: 0.5
 * - Dynamic adjustment applied on top (Iter 4 #7, #8)
 */
export function getDomainScore(url: string): number {
	const domain = extractDomain(url);
	if (!domain) return 0.3;
	if (BLOCKED_DOMAINS.has(domain) || AD_TRACKING_DOMAINS.has(domain)) return 0.0;
	const base = TRUSTED_DOMAINS.has(domain) ? 1.0 : 0.5;
	const adjustment = getDynamicAdjustment(domain);
	return Math.max(0, Math.min(1, base + adjustment));
}

/**
 * Check whether a URL belongs to a blocked domain.
 * Also checks ad/tracking domains (Iter 2 #10).
 */
export function isBlockedDomain(url: string): boolean {
	const domain = extractDomain(url);
	return BLOCKED_DOMAINS.has(domain) || AD_TRACKING_DOMAINS.has(domain);
}

/**
 * Get a human-readable reliability label for a URL (Iter 2 #5).
 * Used in source citations.
 */
export function getReliabilityLabel(url: string): string {
	const score = getDomainScore(url);
	if (score >= 0.8) return "HIGH";
	if (score >= 0.4) return "MEDIUM";
	return "LOW";
}
