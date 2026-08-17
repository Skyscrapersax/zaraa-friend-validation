export interface SanitizeResult {
	sanitized: string;
	patternsDetected: string[];
	truncated: boolean;
}

// ---------------------------------------------------------------------------
// Key fact extraction (Iteration 2, Improvement #1)
// ---------------------------------------------------------------------------

/** Regex patterns for sentences containing factual data points */
const FACT_PATTERNS = [
	/\$[\d,.]+\s*(billion|million|thousand|trillion|[BMKk])?/,  // Dollar amounts
	/\d+(\.\d+)?%/,                                              // Percentages
	/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,                       // Dates (MM/DD/YYYY etc.)
	/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i, // Written dates
	/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/,                      // Proper nouns (multi-word capitalized)
	/\b\d{1,3}(,\d{3})+(\.\d+)?\b/,                            // Large numbers with commas
];

/**
 * Extract sentences containing factual data points (numbers, dates, names, prices).
 * Useful for identifying key claims that can be verified.
 */
export function extractKeyFacts(content: string): string[] {
	const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.length > 10);
	const facts: string[] = [];

	for (const sentence of sentences) {
		for (const pattern of FACT_PATTERNS) {
			if (pattern.test(sentence)) {
				const trimmed = sentence.trim();
				if (!facts.includes(trimmed)) {
					facts.push(trimmed);
				}
				break; // One match per sentence is enough
			}
		}
	}

	return facts;
}

// ---------------------------------------------------------------------------
// Conflicting claim detection (Iteration 2, Improvement #2)
// ---------------------------------------------------------------------------

/** Pattern to extract "X is $Y" style price/value claims */
const VALUE_CLAIM_PATTERN = /\b(\w+(?:\s+\w+)?)\s+(?:is|was|are|were|costs?|at)\s+\$?([\d,.]+%?)\b/gi;

/**
 * Detect facts that contain conflicting numeric claims about the same subject.
 * Returns array of conflict descriptions.
 */
export function detectConflictingClaims(facts: string[]): string[] {
	const conflicts: string[] = [];
	const claims = new Map<string, string[]>();

	for (const fact of facts) {
		const matches = fact.matchAll(VALUE_CLAIM_PATTERN);
		for (const match of matches) {
			const subject = match[1].toLowerCase().trim();
			const value = match[2];
			if (!claims.has(subject)) {
				claims.set(subject, []);
			}
			const existing = claims.get(subject)!;
			if (existing.length > 0 && !existing.includes(value)) {
				conflicts.push(
					`Conflicting values for "${subject}": ${existing[0]} vs ${value}`,
				);
			}
			if (!existing.includes(value)) {
				existing.push(value);
			}
		}
	}

	return conflicts;
}

// ---------------------------------------------------------------------------
// Redirect content detection (Iteration 2, Improvement #3)
// ---------------------------------------------------------------------------

const REDIRECT_PHRASES = [
	/you are being redirected/i,
	/redirecting you to/i,
	/please wait while we redirect/i,
	/click here if you are not redirected/i,
	/if you are not automatically redirected/i,
	/meta\s+http-equiv=["']?refresh/i,
];

/**
 * Detect if content appears to be a redirect page rather than real content.
 */
export function isRedirectContent(content: string): boolean {
	return REDIRECT_PHRASES.some(p => p.test(content));
}

// ---------------------------------------------------------------------------
// Crypto scam detection (Iter 3 #1)
// ---------------------------------------------------------------------------

const CRYPTO_SCAM_PATTERNS = [
	/\bsend\s+\d+(\.\d+)?\s*(BTC|ETH|SOL|XRP|USDT|USDC|crypto)\b/gi,
	/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,   // Bitcoin address
	/\b0x[a-fA-F0-9]{40}\b/,                   // Ethereum address
	/\bguaranteed\s+(returns?|profit|gains?|income)\b/gi,
	/\b(double|triple|10x|100x)\s+your\s+(money|investment|crypto|BTC|ETH)\b/gi,
	/\bfree\s+(BTC|ETH|crypto|tokens?|airdrop)\b/gi,
];

/**
 * Detect cryptocurrency scam patterns in content.
 * Returns array of matched scam indicators.
 */
export function detectCryptoScams(content: string): string[] {
	const detected: string[] = [];
	for (const pattern of CRYPTO_SCAM_PATTERNS) {
		const fresh = new RegExp(pattern.source, pattern.flags);
		if (fresh.test(content)) {
			detected.push(pattern.source.slice(0, 40));
		}
	}
	return detected;
}

// ---------------------------------------------------------------------------
// Phishing detection (Iter 3 #2)
// ---------------------------------------------------------------------------

const PHISHING_PATTERNS = [
	/\bverify\s+your\s+(account|identity|email|password)\b/gi,
	/\bclick\s+here\s+to\s+(confirm|verify|validate|secure)\b/gi,
	/\b(suspended|locked|compromised)\s+account\b/gi,
	/\bunusual\s+(activity|login|sign.?in)\s+(detected|noticed)\b/gi,
	/\byour\s+account\s+(will\s+be|has\s+been)\s+(suspended|closed|terminated)\b/gi,
	/\b(urgent|immediate)\s+(action|verification)\s+(required|needed)\b/gi,
];

/**
 * Detect phishing patterns in content.
 */
export function detectPhishing(content: string): string[] {
	const detected: string[] = [];
	for (const pattern of PHISHING_PATTERNS) {
		const fresh = new RegExp(pattern.source, pattern.flags);
		if (fresh.test(content)) {
			detected.push(pattern.source.slice(0, 40));
		}
	}
	return detected;
}

// ---------------------------------------------------------------------------
// Data URL stripping (Iter 3 #3)
// ---------------------------------------------------------------------------

const DATA_URL_PATTERN = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/**
 * Strip data: URLs from content (can contain malicious payloads).
 */
export function stripDataUrls(text: string): string {
	return text.replace(DATA_URL_PATTERN, "[DATA_URL_REMOVED]");
}

// ---------------------------------------------------------------------------
// Excessive external link detection (Iter 3 #4)
// ---------------------------------------------------------------------------

const LINK_PATTERN = /https?:\/\/[^\s<>"']+/g;
const EXCESSIVE_LINK_THRESHOLD = 50;

/**
 * Detect if content has excessive external links (likely spam).
 */
export function hasExcessiveLinks(content: string): boolean {
	const matches = content.match(LINK_PATTERN);
	return (matches?.length ?? 0) > EXCESSIVE_LINK_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Content quality scoring (Iter 5 #9)
// ---------------------------------------------------------------------------

/**
 * Rate fetched content quality 0-1 based on:
 * - Text-to-markup ratio (higher = better)
 * - Presence of ad indicators (lower quality)
 * - Readability (paragraph length, sentence structure)
 */
export function scoreContentQuality(rawHtml: string, cleanText: string): number {
	if (!cleanText || cleanText.length < 10) return 0;

	// Text-to-markup ratio (weight 40%)
	const ratio = rawHtml.length > 0 ? cleanText.length / rawHtml.length : 0;
	const ratioScore = Math.min(ratio * 3, 1.0); // Normalize: 0.33+ ratio = 1.0

	// Ad indicator penalty (weight 30%)
	const adPatterns = /\b(sponsored|advertisement|promoted|click here to subscribe|sign up for our newsletter|cookie policy|privacy policy|terms of service|ad by|advert)\b/gi;
	const adMatches = cleanText.match(adPatterns);
	const adScore = adMatches ? Math.max(0, 1 - adMatches.length * 0.15) : 1.0;

	// Readability — presence of meaningful paragraphs (weight 30%)
	const paragraphs = cleanText.split(/\n\n+/).filter(p => p.trim().length > 50);
	const readabilityScore = Math.min(paragraphs.length / 5, 1.0); // 5+ paragraphs = 1.0

	return ratioScore * 0.4 + adScore * 0.3 + readabilityScore * 0.3;
}

// ---------------------------------------------------------------------------
// Boilerplate stripping (Iter 5 #10)
// ---------------------------------------------------------------------------

const BOILERPLATE_PATTERNS = [
	// Newsletter / subscribe CTAs
	/\b(subscribe\s+to\s+(our\s+)?newsletter)[^.]*\./gi,
	/\b(sign\s+up\s+for\s+(our\s+)?(free\s+)?newsletter)[^.]*\./gi,
	/\b(enter\s+your\s+email\s+(address\s+)?to\s+(subscribe|sign\s+up|get))[^.]*\./gi,
	/\b(get\s+(our\s+)?latest\s+(stories|news|updates)\s+delivered)[^.]*\./gi,
	// Cookie consent text
	/\b(this\s+(site|website)\s+uses\s+cookies)[^.]*\./gi,
	/\b(we\s+use\s+cookies\s+to)[^.]*\./gi,
	/\b(by\s+(continuing|using)\s+(to\s+)?(browse|use|navigate)\s+(this\s+)?(site|website))[^.]*\./gi,
	/\b(accept\s+(all\s+)?cookies)[^.]*\./gi,
	// Generic site footer phrases
	/\b(all\s+rights\s+reserved)[^.]*\.?/gi,
	/\b(copyright\s+©?\s*\d{4})[^.]*\.?/gi,
];

/**
 * Strip common boilerplate text (newsletter CTAs, cookie policy notices)
 * from content for cleaner LLM consumption.
 */
export function stripBoilerplate(text: string): string {
	let cleaned = text;
	for (const pattern of BOILERPLATE_PATTERNS) {
		cleaned = cleaned.replace(new RegExp(pattern.source, pattern.flags), "");
	}
	// Clean up extra whitespace left behind
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
	return cleaned.trim();
}

export interface SanitizeOptions {
	maxLength?: number;
}

const INJECTION_PATTERNS: Array<{
	regex: RegExp;
	label: string;
}> = [
	{
		regex:
			/\b(ignore|forget|disregard|override)\b.{0,30}\b(previous|prior|above|all|earlier)\b.{0,30}\b(instructions?|prompts?|rules?|context)\b/gi,
		label: "instruction_override",
	},
	{
		regex: /\b(you are now|you are a new|act as|pretend to be|roleplay as)\b/gi,
		label: "role_hijack",
	},
	{
		regex: /^(System|Assistant|Human|User|Admin|Developer):\s/gim,
		label: "fake_role_marker",
	},
	{
		regex: /```(system|instruction|prompt|admin|override)[\s\S]*?```/gi,
		label: "fake_code_block_instruction",
	},
];

const ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\uFEFF|\u2060|\u180E/g;

const BASE64_BLOCK = /[A-Za-z0-9+/]{20,}={0,2}/g;

const DEFAULT_MAX_LENGTH = 16000;

export class WebContentSanitizer {
	sanitize(raw: string, options?: SanitizeOptions): SanitizeResult {
		const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
		const patternsDetected: string[] = [];
		let text = raw;

		text = text.replace(ZERO_WIDTH_CHARS, "");

		// Strip data: URLs (Iter 3 #3)
		text = stripDataUrls(text);

		// Detect crypto scams (Iter 3 #1)
		const cryptoScams = detectCryptoScams(text);
		if (cryptoScams.length > 0) {
			patternsDetected.push("crypto_scam");
			text = `[WARNING: Potential cryptocurrency scam content detected]\n${text}`;
		}

		// Detect phishing (Iter 3 #2)
		const phishing = detectPhishing(text);
		if (phishing.length > 0) {
			patternsDetected.push("phishing");
			text = `[WARNING: Potential phishing content detected]\n${text}`;
		}

		// Detect excessive links / spam (Iter 3 #4)
		if (hasExcessiveLinks(text)) {
			patternsDetected.push("excessive_links");
			text = `[WARNING: Page contains excessive links — possible spam]\n${text}`;
		}

		for (const { regex, label } of INJECTION_PATTERNS) {
			const fresh = new RegExp(regex.source, regex.flags);
			if (fresh.test(text)) {
				if (!patternsDetected.includes(label)) {
					patternsDetected.push(label);
				}
				text = text.replace(
					new RegExp(regex.source, regex.flags),
					"[BLOCKED_INJECTION]",
				);
			}
		}

		const b64Matches = text.match(BASE64_BLOCK);
		if (b64Matches) {
			for (const match of b64Matches) {
				try {
					const decoded = Buffer.from(match, "base64").toString("utf-8");
					const lowerDecoded = decoded.toLowerCase();
					if (
						/[a-z]{3,}/.test(decoded) &&
						(lowerDecoded.includes("ignore") ||
							lowerDecoded.includes("instruction") ||
							lowerDecoded.includes("system") ||
							lowerDecoded.includes("execute") ||
							lowerDecoded.includes("override") ||
							lowerDecoded.includes("forget") ||
							lowerDecoded.includes("you are"))
					) {
						if (!patternsDetected.includes("base64_instruction")) {
							patternsDetected.push("base64_instruction");
						}
						text = text.replace(match, "[BLOCKED_BASE64]");
					}
				} catch {
					// Not valid base64
				}
			}
		}

		let truncated = false;
		if (text.length > maxLength) {
			text = `${text.slice(0, maxLength)}\n[CONTENT_TRUNCATED: ${text.length - maxLength} characters omitted]`;
			truncated = true;
		}

		const sanitized = `[EXTERNAL_WEB_CONTENT_START]\n${text}\n[EXTERNAL_WEB_CONTENT_END]`;

		return { sanitized, patternsDetected, truncated };
	}
}
