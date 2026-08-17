/**
 * Extract meta description and title from HTML head.
 * Returns a summary string to prepend to content. (Iter 2 #7)
 */
export function extractMetaSummary(html: string): string {
	if (!html) return "";

	const parts: string[] = [];

	// Extract <title>
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (titleMatch) {
		const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
		if (title) parts.push(`Title: ${decodeEntities(title)}`);
	}

	// Extract meta description
	const descMatch = html.match(
		/<meta\s[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i,
	);
	if (descMatch) {
		const desc = descMatch[1].trim();
		if (desc) parts.push(`Description: ${decodeEntities(desc)}`);
	}

	// Also try og:description
	if (!descMatch) {
		const ogMatch = html.match(
			/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i,
		);
		if (ogMatch) {
			const desc = ogMatch[1].trim();
			if (desc) parts.push(`Description: ${decodeEntities(desc)}`);
		}
	}

	return parts.join("\n");
}

/** Decode common HTML entities */
function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_match, code) =>
			String.fromCharCode(Number.parseInt(code, 10)),
		);
}

// ---------------------------------------------------------------------------
// Cookie consent banner patterns (Iter 2 #8)
// ---------------------------------------------------------------------------

const COOKIE_BANNER_PATTERNS = [
	/<div\s[^>]*class="[^"]*(?:cookie[-_]?banner|cookie[-_]?consent|cookie[-_]?notice|gdpr[-_]?banner|gdpr[-_]?consent|consent[-_]?banner|consent[-_]?dialog|cookie[-_]?popup|cookie[-_]?bar|cookie[-_]?modal|cc[-_]?banner)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
	/<div\s[^>]*id="[^"]*(?:cookie[-_]?banner|cookie[-_]?consent|cookie[-_]?notice|gdpr[-_]?banner|gdpr[-_]?consent|consent[-_]?banner|cookie[-_]?popup|cookie[-_]?bar|cookie[-_]?modal)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
	/<section\s[^>]*class="[^"]*(?:cookie[-_]?banner|consent[-_]?banner|gdpr)[^"]*"[^>]*>[\s\S]*?<\/section>/gi,
];

/**
 * Converts HTML to clean plaintext with improved content extraction.
 * - Removes nav/header/footer/aside chrome before converting
 * - Extracts article/main content preferentially
 * - Preserves list formatting (bullet points)
 * - Keeps link URLs inline: text (url)
 * - Strips cookie consent banners (Iter 2 #8)
 */
export function htmlToText(html: string): string {
	if (!html) return "";

	let text = html;

	// Remove cookie consent banners (Iter 2 #8)
	for (const pattern of COOKIE_BANNER_PATTERNS) {
		text = text.replace(new RegExp(pattern.source, pattern.flags), "");
	}

	// Remove script, style, noscript blocks
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

	// Remove nav, header, footer, aside elements (chrome/boilerplate)
	text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
	text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
	text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
	text = text.replace(/<aside[\s\S]*?<\/aside>/gi, "");

	// Convert links to inline format: text (url)
	text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url, inner) => {
		const linkText = inner.replace(/<[^>]+>/g, "").trim();
		if (!linkText || !url || url.startsWith("#") || url.startsWith("javascript:")) {
			return linkText;
		}
		return `${linkText} (${url})`;
	});

	// Convert list items to bullet points
	text = text.replace(/<li(?:\s[^>]*)?>[\s]*([\s\S]*?)<\/li>/gi, (_m, content) => {
		const clean = content.replace(/<[^>]+>/g, "").trim();
		return `\n- ${clean}`;
	});

	// Block-level elements get newlines
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");

	// Strip remaining tags
	text = text.replace(/<[^>]+>/g, "");

	// Decode HTML entities
	text = decodeEntities(text);

	// Normalize whitespace
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");

	return text.trim();
}

/**
 * Extract the main article content from HTML if identifiable.
 * Falls back to full htmlToText if no main content container found.
 * Used when content is very long (>16K chars) to avoid blind truncation.
 */
export function extractMainContent(html: string): string {
	if (!html) return "";

	// Try to extract content from semantic containers in priority order
	const patterns = [
		/<article[\s>][\s\S]*?<\/article>/gi,
		/<main[\s>][\s\S]*?<\/main>/gi,
		/<div\s[^>]*class="[^"]*content[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
		/<div\s[^>]*id="[^"]*content[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
		/<div\s[^>]*role="main"[^>]*>[\s\S]*?<\/div>/gi,
	];

	for (const pattern of patterns) {
		const matches = html.match(pattern);
		if (matches && matches.length > 0) {
			// Use the largest matching block (most likely the real content)
			const largest = matches.reduce((a, b) => (a.length > b.length ? a : b));
			const extracted = htmlToText(largest);
			// Only use extracted content if it's substantial
			if (extracted.length > 200) {
				return extracted;
			}
		}
	}

	// Fallback to full conversion
	return htmlToText(html);
}
