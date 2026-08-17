// src/sanitizer.ts
var FACT_PATTERNS = [
  /\$[\d,.]+\s*(billion|million|thousand|trillion|[BMKk])?/,
  // Dollar amounts
  /\d+(\.\d+)?%/,
  // Percentages
  /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,
  // Dates (MM/DD/YYYY etc.)
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
  // Written dates
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/,
  // Proper nouns (multi-word capitalized)
  /\b\d{1,3}(,\d{3})+(\.\d+)?\b/
  // Large numbers with commas
];
function extractKeyFacts(content) {
  const sentences = content.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
  const facts = [];
  for (const sentence of sentences) {
    for (const pattern of FACT_PATTERNS) {
      if (pattern.test(sentence)) {
        const trimmed = sentence.trim();
        if (!facts.includes(trimmed)) {
          facts.push(trimmed);
        }
        break;
      }
    }
  }
  return facts;
}
var VALUE_CLAIM_PATTERN = /\b(\w+(?:\s+\w+)?)\s+(?:is|was|are|were|costs?|at)\s+\$?([\d,.]+%?)\b/gi;
function detectConflictingClaims(facts) {
  const conflicts = [];
  const claims = /* @__PURE__ */ new Map();
  for (const fact of facts) {
    const matches = fact.matchAll(VALUE_CLAIM_PATTERN);
    for (const match of matches) {
      const subject = match[1].toLowerCase().trim();
      const value = match[2];
      if (!claims.has(subject)) {
        claims.set(subject, []);
      }
      const existing = claims.get(subject);
      if (existing.length > 0 && !existing.includes(value)) {
        conflicts.push(
          `Conflicting values for "${subject}": ${existing[0]} vs ${value}`
        );
      }
      if (!existing.includes(value)) {
        existing.push(value);
      }
    }
  }
  return conflicts;
}
var REDIRECT_PHRASES = [
  /you are being redirected/i,
  /redirecting you to/i,
  /please wait while we redirect/i,
  /click here if you are not redirected/i,
  /if you are not automatically redirected/i,
  /meta\s+http-equiv=["']?refresh/i
];
function isRedirectContent(content) {
  return REDIRECT_PHRASES.some((p) => p.test(content));
}
var CRYPTO_SCAM_PATTERNS = [
  /\bsend\s+\d+(\.\d+)?\s*(BTC|ETH|SOL|XRP|USDT|USDC|crypto)\b/gi,
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,
  // Bitcoin address
  /\b0x[a-fA-F0-9]{40}\b/,
  // Ethereum address
  /\bguaranteed\s+(returns?|profit|gains?|income)\b/gi,
  /\b(double|triple|10x|100x)\s+your\s+(money|investment|crypto|BTC|ETH)\b/gi,
  /\bfree\s+(BTC|ETH|crypto|tokens?|airdrop)\b/gi
];
function detectCryptoScams(content) {
  const detected = [];
  for (const pattern of CRYPTO_SCAM_PATTERNS) {
    const fresh = new RegExp(pattern.source, pattern.flags);
    if (fresh.test(content)) {
      detected.push(pattern.source.slice(0, 40));
    }
  }
  return detected;
}
var PHISHING_PATTERNS = [
  /\bverify\s+your\s+(account|identity|email|password)\b/gi,
  /\bclick\s+here\s+to\s+(confirm|verify|validate|secure)\b/gi,
  /\b(suspended|locked|compromised)\s+account\b/gi,
  /\bunusual\s+(activity|login|sign.?in)\s+(detected|noticed)\b/gi,
  /\byour\s+account\s+(will\s+be|has\s+been)\s+(suspended|closed|terminated)\b/gi,
  /\b(urgent|immediate)\s+(action|verification)\s+(required|needed)\b/gi
];
function detectPhishing(content) {
  const detected = [];
  for (const pattern of PHISHING_PATTERNS) {
    const fresh = new RegExp(pattern.source, pattern.flags);
    if (fresh.test(content)) {
      detected.push(pattern.source.slice(0, 40));
    }
  }
  return detected;
}
var DATA_URL_PATTERN = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
function stripDataUrls(text) {
  return text.replace(DATA_URL_PATTERN, "[DATA_URL_REMOVED]");
}
var LINK_PATTERN = /https?:\/\/[^\s<>"']+/g;
var EXCESSIVE_LINK_THRESHOLD = 50;
function hasExcessiveLinks(content) {
  const matches = content.match(LINK_PATTERN);
  return (matches?.length ?? 0) > EXCESSIVE_LINK_THRESHOLD;
}
function scoreContentQuality(rawHtml, cleanText) {
  if (!cleanText || cleanText.length < 10) return 0;
  const ratio = rawHtml.length > 0 ? cleanText.length / rawHtml.length : 0;
  const ratioScore = Math.min(ratio * 3, 1);
  const adPatterns = /\b(sponsored|advertisement|promoted|click here to subscribe|sign up for our newsletter|cookie policy|privacy policy|terms of service|ad by|advert)\b/gi;
  const adMatches = cleanText.match(adPatterns);
  const adScore = adMatches ? Math.max(0, 1 - adMatches.length * 0.15) : 1;
  const paragraphs = cleanText.split(/\n\n+/).filter((p) => p.trim().length > 50);
  const readabilityScore = Math.min(paragraphs.length / 5, 1);
  return ratioScore * 0.4 + adScore * 0.3 + readabilityScore * 0.3;
}
var BOILERPLATE_PATTERNS = [
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
  /\b(copyright\s+©?\s*\d{4})[^.]*\.?/gi
];
function stripBoilerplate(text) {
  let cleaned = text;
  for (const pattern of BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(pattern.source, pattern.flags), "");
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}
var INJECTION_PATTERNS = [
  {
    regex: /\b(ignore|forget|disregard|override)\b.{0,30}\b(previous|prior|above|all|earlier)\b.{0,30}\b(instructions?|prompts?|rules?|context)\b/gi,
    label: "instruction_override"
  },
  {
    regex: /\b(you are now|you are a new|act as|pretend to be|roleplay as)\b/gi,
    label: "role_hijack"
  },
  {
    regex: /^(System|Assistant|Human|User|Admin|Developer):\s/gim,
    label: "fake_role_marker"
  },
  {
    regex: /```(system|instruction|prompt|admin|override)[\s\S]*?```/gi,
    label: "fake_code_block_instruction"
  }
];
var ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\uFEFF|\u2060|\u180E/g;
var BASE64_BLOCK = /[A-Za-z0-9+/]{20,}={0,2}/g;
var DEFAULT_MAX_LENGTH = 16e3;
var WebContentSanitizer = class {
  sanitize(raw, options) {
    const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
    const patternsDetected = [];
    let text = raw;
    text = text.replace(ZERO_WIDTH_CHARS, "");
    text = stripDataUrls(text);
    const cryptoScams = detectCryptoScams(text);
    if (cryptoScams.length > 0) {
      patternsDetected.push("crypto_scam");
      text = `[WARNING: Potential cryptocurrency scam content detected]
${text}`;
    }
    const phishing = detectPhishing(text);
    if (phishing.length > 0) {
      patternsDetected.push("phishing");
      text = `[WARNING: Potential phishing content detected]
${text}`;
    }
    if (hasExcessiveLinks(text)) {
      patternsDetected.push("excessive_links");
      text = `[WARNING: Page contains excessive links \u2014 possible spam]
${text}`;
    }
    for (const { regex, label } of INJECTION_PATTERNS) {
      const fresh = new RegExp(regex.source, regex.flags);
      if (fresh.test(text)) {
        if (!patternsDetected.includes(label)) {
          patternsDetected.push(label);
        }
        text = text.replace(
          new RegExp(regex.source, regex.flags),
          "[BLOCKED_INJECTION]"
        );
      }
    }
    const b64Matches = text.match(BASE64_BLOCK);
    if (b64Matches) {
      for (const match of b64Matches) {
        try {
          const decoded = Buffer.from(match, "base64").toString("utf-8");
          const lowerDecoded = decoded.toLowerCase();
          if (/[a-z]{3,}/.test(decoded) && (lowerDecoded.includes("ignore") || lowerDecoded.includes("instruction") || lowerDecoded.includes("system") || lowerDecoded.includes("execute") || lowerDecoded.includes("override") || lowerDecoded.includes("forget") || lowerDecoded.includes("you are"))) {
            if (!patternsDetected.includes("base64_instruction")) {
              patternsDetected.push("base64_instruction");
            }
            text = text.replace(match, "[BLOCKED_BASE64]");
          }
        } catch {
        }
      }
    }
    let truncated = false;
    if (text.length > maxLength) {
      text = `${text.slice(0, maxLength)}
[CONTENT_TRUNCATED: ${text.length - maxLength} characters omitted]`;
      truncated = true;
    }
    const sanitized = `[EXTERNAL_WEB_CONTENT_START]
${text}
[EXTERNAL_WEB_CONTENT_END]`;
    return { sanitized, patternsDetected, truncated };
  }
};

// src/brave-client.ts
var BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
var MAX_COUNT = 10;
var DEFAULT_COUNT = 5;
var BraveSearchClient = class {
  apiKey;
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  async search(query, count) {
    const effectiveCount = Math.min(count ?? DEFAULT_COUNT, MAX_COUNT);
    const params = new URLSearchParams({
      q: query,
      count: String(effectiveCount)
    });
    const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
      headers: {
        "X-Subscription-Token": this.apiKey,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(
        `Brave Search API error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    const results = data.web?.results ?? [];
    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description
    }));
  }
};

// src/ddg-client.ts
var DDG_URL = "https://html.duckduckgo.com/html/";
var MAX_COUNT2 = 10;
var DEFAULT_COUNT2 = 5;
var USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0"
  // NOTE: every entry MUST be a real browser UA — DuckDuckGo's HTML endpoint
  // silently blocks/stalls bot-shaped agents (a former "Zaraa/1.0" entry made
  // every 6th search dead-end into a timeout). Covered by ddg-client.test.ts.
];
var uaIndex = 0;
function getNextUserAgent() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 1e3;
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var DuckDuckGoClient = class {
  async search(query, count) {
    const effectiveCount = Math.min(count ?? DEFAULT_COUNT2, MAX_COUNT2);
    const params = new URLSearchParams({ q: query });
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${DDG_URL}?${params.toString()}`, {
          method: "POST",
          headers: {
            "User-Agent": getNextUserAgent(),
            Accept: "text/html"
          },
          signal: AbortSignal.timeout(15e3)
        });
        if (!response.ok) {
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            lastError = new Error(
              `DuckDuckGo search error: ${response.status} ${response.statusText}`
            );
            await sleep(BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          throw new Error(
            `DuckDuckGo search error: ${response.status} ${response.statusText}`
          );
        }
        const html = await response.text();
        return this.parseResults(html, effectiveCount);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const isTransient = lastError.name === "TimeoutError" || lastError.message.includes("timeout") || lastError.message.includes("ECONNRESET") || lastError.message.includes("ENOTFOUND") || lastError.message.includes("fetch failed") || lastError.message.includes("DuckDuckGo search error: 5");
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
  parseResults(html, limit) {
    const results = [];
    const resultBlocks = html.split(/class="result\s/);
    for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
      const block = resultBlocks[i];
      const urlMatch = block.match(
        /class="result__a"[^>]*href="([^"]+)"/
      );
      const titleMatch = block.match(
        /class="result__a"[^>]*>([^<]+)</
      );
      const snippetMatch = block.match(
        /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
      );
      if (urlMatch && titleMatch) {
        let url = urlMatch[1];
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          url = decodeURIComponent(uddgMatch[1]);
        }
        const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : "";
        results.push({
          title: this.decodeEntities(titleMatch[1].trim()),
          url,
          snippet: this.decodeEntities(snippet)
        });
      }
    }
    return results;
  }
  stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }
  decodeEntities(text) {
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
  }
};

// src/wikipedia-client.ts
var WIKI_API = "https://en.wikipedia.org/w/api.php";
var DEFAULT_COUNT3 = 5;
var MAX_COUNT3 = 10;
var WIKI_USER_AGENT = "ZaraaAssistant/1.0 (personal AI assistant; keyless research fallback)";
var WikipediaSearchClient = class {
  async search(query, count) {
    const limit = Math.min(count ?? DEFAULT_COUNT3, MAX_COUNT3);
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      format: "json",
      srlimit: String(limit),
      srprop: "snippet"
    });
    const response = await fetch(`${WIKI_API}?${params.toString()}`, {
      headers: {
        "User-Agent": WIKI_USER_AGENT,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      throw new Error(
        `Wikipedia search error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    const hits = data.query?.search ?? [];
    return hits.filter((h) => typeof h.title === "string").map((h) => ({
      title: h.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
      snippet: stripHtml(h.snippet ?? "")
    }));
  }
};
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
}

// src/searxng-client.ts
var DEFAULT_COUNT4 = 5;
var MAX_COUNT4 = 10;
var DEFAULT_BASE_URL = "http://127.0.0.1:8888";
var SearxngSearchClient = class {
  baseUrl;
  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  async search(query, count) {
    const limit = Math.min(count ?? DEFAULT_COUNT4, MAX_COUNT4);
    const params = new URLSearchParams({ q: query, format: "json" });
    const response = await fetch(`${this.baseUrl}/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      throw new Error(
        `SearXNG search error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    return (data.results ?? []).filter(
      (r) => typeof r.title === "string" && typeof r.url === "string"
    ).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
};

// src/tavily-client.ts
var TAVILY_API_URL = "https://api.tavily.com/search";
var DEFAULT_COUNT5 = 5;
var MAX_COUNT5 = 10;
var TavilySearchClient = class {
  apiKey;
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error("TavilySearchClient requires an API key");
    }
    this.apiKey = apiKey;
  }
  async search(query, count) {
    const maxResults = Math.min(count ?? DEFAULT_COUNT5, MAX_COUNT5);
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic"
      }),
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      throw new Error(
        `Tavily search error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    return (data.results ?? []).filter(
      (r) => typeof r.title === "string" && typeof r.url === "string"
    ).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
};

// src/fallback-client.ts
var DEFAULT_PER_CLIENT_TIMEOUT_MS = 1e4;
var FallbackSearchClient = class {
  clients;
  perClientTimeoutMs;
  constructor(clients, options) {
    if (clients.length === 0) {
      throw new Error("FallbackSearchClient requires at least one client");
    }
    this.clients = clients;
    this.perClientTimeoutMs = options?.perClientTimeoutMs ?? DEFAULT_PER_CLIENT_TIMEOUT_MS;
  }
  async search(query, count) {
    let lastError;
    let anySucceeded = false;
    for (const client of this.clients) {
      try {
        const results = await this.withTimeout(client.search(query, count));
        anySucceeded = true;
        if (results.length > 0) return results;
      } catch (err) {
        lastError = err;
      }
    }
    if (!anySucceeded && lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return [];
  }
  withTimeout(p) {
    p.catch(() => {
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("search backend timed out")),
        this.perClientTimeoutMs
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
};

// src/html-to-text.ts
function extractMetaSummary(html) {
  if (!html) return "";
  const parts = [];
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (title) parts.push(`Title: ${decodeEntities(title)}`);
  }
  const descMatch = html.match(
    /<meta\s[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i
  );
  if (descMatch) {
    const desc = descMatch[1].trim();
    if (desc) parts.push(`Description: ${decodeEntities(desc)}`);
  }
  if (!descMatch) {
    const ogMatch = html.match(
      /<meta\s[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i
    );
    if (ogMatch) {
      const desc = ogMatch[1].trim();
      if (desc) parts.push(`Description: ${decodeEntities(desc)}`);
    }
  }
  return parts.join("\n");
}
function decodeEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(
    /&#(\d+);/g,
    (_match, code) => String.fromCharCode(Number.parseInt(code, 10))
  );
}
var COOKIE_BANNER_PATTERNS = [
  /<div\s[^>]*class="[^"]*(?:cookie[-_]?banner|cookie[-_]?consent|cookie[-_]?notice|gdpr[-_]?banner|gdpr[-_]?consent|consent[-_]?banner|consent[-_]?dialog|cookie[-_]?popup|cookie[-_]?bar|cookie[-_]?modal|cc[-_]?banner)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
  /<div\s[^>]*id="[^"]*(?:cookie[-_]?banner|cookie[-_]?consent|cookie[-_]?notice|gdpr[-_]?banner|gdpr[-_]?consent|consent[-_]?banner|cookie[-_]?popup|cookie[-_]?bar|cookie[-_]?modal)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
  /<section\s[^>]*class="[^"]*(?:cookie[-_]?banner|consent[-_]?banner|gdpr)[^"]*"[^>]*>[\s\S]*?<\/section>/gi
];
function htmlToText(html) {
  if (!html) return "";
  let text = html;
  for (const pattern of COOKIE_BANNER_PATTERNS) {
    text = text.replace(new RegExp(pattern.source, pattern.flags), "");
  }
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, "");
  text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url, inner) => {
    const linkText = inner.replace(/<[^>]+>/g, "").trim();
    if (!linkText || !url || url.startsWith("#") || url.startsWith("javascript:")) {
      return linkText;
    }
    return `${linkText} (${url})`;
  });
  text = text.replace(/<li(?:\s[^>]*)?>[\s]*([\s\S]*?)<\/li>/gi, (_m, content) => {
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `
- ${clean}`;
  });
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
function extractMainContent(html) {
  if (!html) return "";
  const patterns = [
    /<article[\s>][\s\S]*?<\/article>/gi,
    /<main[\s>][\s\S]*?<\/main>/gi,
    /<div\s[^>]*class="[^"]*content[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\s[^>]*id="[^"]*content[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\s[^>]*role="main"[^>]*>[\s\S]*?<\/div>/gi
  ];
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches && matches.length > 0) {
      const largest = matches.reduce((a, b) => a.length > b.length ? a : b);
      const extracted = htmlToText(largest);
      if (extracted.length > 200) {
        return extracted;
      }
    }
  }
  return htmlToText(html);
}

// src/domain-reputation.ts
var DOMAIN_CATEGORIES = /* @__PURE__ */ new Map([
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
  ["decrypt.co", "crypto"]
]);
function getDomainCategory(url) {
  const domain = extractDomain(url);
  return DOMAIN_CATEGORIES.get(domain) ?? "general";
}
function getCategoryBoost(url, queryContext) {
  if (!queryContext) return 0;
  const category = getDomainCategory(url);
  const ctx = queryContext.toLowerCase();
  if (category === "crypto" && /\b(crypto|bitcoin|btc|eth|blockchain|defi|token|web3|solana|xrp)\b/.test(ctx)) return 0.1;
  if (category === "news" && /\b(news|latest|today|breaking|update|announce|report)\b/.test(ctx)) return 0.1;
  if (category === "docs" && /\b(how to|tutorial|guide|documentation|api|install|setup|configure|error|bug|fix)\b/.test(ctx)) return 0.1;
  if (category === "reference" && /\b(what is|define|meaning|explain|overview|history|wiki)\b/.test(ctx)) return 0.1;
  return 0;
}
var TRUSTED_DOMAINS = /* @__PURE__ */ new Set([
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
  "learn.microsoft.com"
]);
var BLOCKED_DOMAINS = /* @__PURE__ */ new Set([
  "malware.com",
  "phishing-site.com"
]);
var AD_TRACKING_DOMAINS = /* @__PURE__ */ new Set([
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
  "amplitude.com"
]);
var dynamicReputation = /* @__PURE__ */ new Map();
function recordDomainSuccess(url) {
  const domain = extractDomain(url);
  if (!domain) return;
  const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
  stats.successCount++;
  dynamicReputation.set(domain, stats);
}
function recordDomainFailure(url, type) {
  const domain = extractDomain(url);
  if (!domain) return;
  const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
  if (type === "error") stats.errorCount++;
  else stats.emptyCount++;
  dynamicReputation.set(domain, stats);
}
function getDynamicAdjustment(domain) {
  const stats = dynamicReputation.get(domain);
  if (!stats) return 0;
  const total = stats.successCount + stats.errorCount + stats.emptyCount;
  if (total < 3) return 0;
  const failRate = (stats.errorCount + stats.emptyCount) / total;
  if (failRate > 0.7) return -0.2;
  if (failRate > 0.5) return -0.1;
  if (failRate < 0.1 && stats.successCount >= 5) return 0.1;
  return 0;
}
function boostDomainFromTraceScore(url, traceScore) {
  if (traceScore < 0.6) return;
  const domain = extractDomain(url);
  if (!domain) return;
  const stats = dynamicReputation.get(domain) ?? { successCount: 0, errorCount: 0, emptyCount: 0 };
  const bonus = Math.round(traceScore * 3);
  stats.successCount += bonus;
  dynamicReputation.set(domain, stats);
}
function clearDynamicReputation() {
  dynamicReputation.clear();
}
function getDynamicReputationSize() {
  return dynamicReputation.size;
}
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return hostname;
  } catch {
    return "";
  }
}
function getDomainScore(url) {
  const domain = extractDomain(url);
  if (!domain) return 0.3;
  if (BLOCKED_DOMAINS.has(domain) || AD_TRACKING_DOMAINS.has(domain)) return 0;
  const base = TRUSTED_DOMAINS.has(domain) ? 1 : 0.5;
  const adjustment = getDynamicAdjustment(domain);
  return Math.max(0, Math.min(1, base + adjustment));
}
function isBlockedDomain(url) {
  const domain = extractDomain(url);
  return BLOCKED_DOMAINS.has(domain) || AD_TRACKING_DOMAINS.has(domain);
}
function getReliabilityLabel(url) {
  const score = getDomainScore(url);
  if (score >= 0.8) return "HIGH";
  if (score >= 0.4) return "MEDIUM";
  return "LOW";
}

// src/handlers.ts
var CACHE_TTL_MS = 5 * 60 * 1e3;
var CACHE_MAX_ENTRIES = 50;
var searchCache = /* @__PURE__ */ new Map();
function getCachedResults(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}
function setCachedResults(key, results) {
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== void 0) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { results, timestamp: Date.now() });
}
function clearSearchCache() {
  searchCache.clear();
}
function getSearchCacheSize() {
  return searchCache.size;
}
var webStats = { searchCount: 0, fetchCount: 0, cacheHits: 0, cacheMisses: 0 };
function getWebStats() {
  const total = webStats.cacheHits + webStats.cacheMisses;
  return {
    ...webStats,
    cacheHitRate: total > 0 ? webStats.cacheHits / total : 0
  };
}
function resetWebStats() {
  webStats.searchCount = 0;
  webStats.fetchCount = 0;
  webStats.cacheHits = 0;
  webStats.cacheMisses = 0;
}
var MAX_SEARCH_MEMORY = 10;
var searchMemory = [];
function recordSearchMemory(query, urls) {
  searchMemory.push({ query, topUrls: urls.slice(0, 3), timestamp: Date.now() });
  if (searchMemory.length > MAX_SEARCH_MEMORY) {
    searchMemory.shift();
  }
}
function getSearchMemory() {
  return searchMemory;
}
function clearSearchMemory() {
  searchMemory.length = 0;
}
function scoreResult(result, query) {
  const domainScore = getDomainScore(result.url);
  const snippetScore = Math.min(result.snippet.length / 200, 1);
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const titleLower = result.title.toLowerCase();
  const matchCount = queryTerms.filter((term) => titleLower.includes(term)).length;
  const titleScore = queryTerms.length > 0 ? matchCount / queryTerms.length : 0.5;
  const base = domainScore * 0.4 + snippetScore * 0.3 + titleScore * 0.3;
  const categoryBoost = getCategoryBoost(result.url, query);
  return Math.min(1, base + categoryBoost);
}
function deduplicateResults(results) {
  const seen = /* @__PURE__ */ new Set();
  return results.filter((r) => {
    try {
      const parsed = new URL(r.url);
      const key = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return true;
    }
  });
}
var TIME_SENSITIVE_TERMS = /\b(latest|current|today|recent|now|this\s+week|this\s+month|this\s+year|2025|2026)\b/i;
function augmentQueryWithDate(query) {
  if (TIME_SENSITIVE_TERMS.test(query)) {
    const now = /* @__PURE__ */ new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (!query.includes(dateStr)) {
      return `${query} ${dateStr}`;
    }
  }
  return query;
}
function simplifyQuery(query) {
  let simplified = query.replace(/["']/g, "");
  simplified = simplified.replace(/\b(site:|filetype:|intitle:)\S+/gi, "");
  const words = simplified.split(/\s+/).filter((w) => w.length > 2);
  return words.slice(0, 4).join(" ");
}
var MAX_REDIRECTS = 5;
var ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
  "text/css",
  "text/javascript",
  "application/javascript"
];
function isAllowedContentType(contentType) {
  const lower = contentType.toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((t) => lower.includes(t));
}
var MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
var fetchAuditLog = [];
function getFetchAuditLog() {
  return fetchAuditLog;
}
function clearFetchAuditLog() {
  fetchAuditLog.length = 0;
}
var COMPLEX_QUERY_PATTERN = /\b(and|vs|versus|compared to|difference between|or)\b/i;
var QUESTION_WORDS = /^(what|how|why|when|where|who|which|is|are|does|do|can|will|should)\b/i;
function decomposeQuery(query) {
  if (!COMPLEX_QUERY_PATTERN.test(query) && query.split(/\s+/).length < 8) {
    return [query];
  }
  const subQueries = [];
  const parts = query.split(/\s+(?:and|vs\.?|versus|compared\s+to|or)\s+/i).filter((p) => p.trim().length > 3);
  if (parts.length >= 2 && parts.length <= 4) {
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.split(/\s+/).length < 3 && QUESTION_WORDS.test(query)) {
        const questionWord = query.match(QUESTION_WORDS)?.[0] ?? "";
        subQueries.push(`${questionWord} ${trimmed}`.trim());
      } else {
        subQueries.push(trimmed);
      }
    }
  } else {
    subQueries.push(query);
  }
  return subQueries.slice(0, 3);
}
function shortenQuery(query) {
  const words = query.split(/\s+/);
  if (words.length <= 3) return query;
  return words.slice(0, 3).join(" ");
}
function mergeSearchResults(...resultSets) {
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
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
function getFriendlyFetchError(status, url) {
  switch (status) {
    case 401:
      return `Authentication required \u2014 ${url} needs login credentials. Try a different source.`;
    case 403:
      return `Access denied \u2014 this site blocks automated access. Try a different source.`;
    case 404:
      return `Page not found \u2014 ${url} does not exist or was removed.`;
    case 429:
      return `Rate limited \u2014 too many requests to this site. Wait a moment and try again.`;
    case 451:
      return `Content unavailable for legal reasons \u2014 ${url} is geo-blocked or restricted.`;
    case 500:
      return `Server error at ${url} \u2014 the site is having issues. Try again later.`;
    case 502:
      return `Bad gateway at ${url} \u2014 the site's server is down. Try a different source.`;
    case 503:
      return `Service unavailable at ${url} \u2014 the site is temporarily offline. Try again later.`;
    default:
      return `Fetch failed: ${status} \u2014 could not retrieve ${url}.`;
  }
}
function createWebHandlers(deps) {
  const { searchClient, sanitizer, assertSafeUrl, secondarySearchClient, warn = console.warn } = deps;
  return {
    // ------------------------------------------------------------------
    // web_search — with scoring, dedup, caching, date hints, retry,
    // multi-query decomposition, parallel search, result preview
    // ------------------------------------------------------------------
    web_search: async (args) => {
      const searchStartMs = Date.now();
      const query = args.query;
      if (!query) throw new Error("query is required");
      const count = args.count;
      webStats.searchCount++;
      const cacheKey = `${query}::${count ?? ""}`;
      const cached = getCachedResults(cacheKey);
      if (cached) {
        webStats.cacheHits++;
        return formatScoredResults(cached, sanitizer);
      }
      webStats.cacheMisses++;
      const augmented = augmentQueryWithDate(query);
      const subQueries = decomposeQuery(augmented);
      let allResults = [];
      for (const subQ of subQueries) {
        try {
          let results;
          try {
            results = await searchClient.search(subQ, count);
          } catch (err) {
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
          if (secondarySearchClient && subQueries.length === 1) {
            try {
              const secondaryResults = await secondarySearchClient.search(subQ, count);
              results = mergeSearchResults(results, secondaryResults);
            } catch {
            }
          }
          allResults.push(...results);
        } catch {
        }
      }
      if (subQueries.length > 1) {
        allResults = mergeSearchResults(allResults);
      }
      if (allResults.length < 3) {
        const simplified = simplifyQuery(query);
        if (simplified && simplified !== query && simplified !== augmented) {
          try {
            const retryResults = await searchClient.search(simplified, count);
            allResults = mergeSearchResults(allResults, retryResults);
          } catch {
          }
        }
      }
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
      allResults = allResults.filter((r) => !isBlockedDomain(r.url));
      allResults = deduplicateResults(allResults);
      const scored = allResults.map((r) => ({ ...r, score: scoreResult(r, query) })).sort((a, b) => b.score - a.score);
      setCachedResults(cacheKey, scored);
      recordSearchMemory(query, scored.map((r) => r.url));
      const searchElapsedMs = Date.now() - searchStartMs;
      const formatted = formatScoredResults(scored, sanitizer);
      const tokenEstimate = Math.ceil(formatted.length / 4);
      return `${formatted}
[Search completed in ${searchElapsedMs}ms | ~${tokenEstimate} tokens]`;
    },
    // ------------------------------------------------------------------
    // web_fetch — with main content extraction, redirect safety,
    // citation, confidence, content-type validation, size guard
    // ------------------------------------------------------------------
    web_fetch: async (args) => {
      const fetchStartMs = Date.now();
      const url = args.url;
      if (!url) throw new Error("url is required");
      const maxLength = args.maxLength;
      if (!assertSafeUrl) {
        throw new Error("SSRF protection not configured \u2014 web_fetch disabled");
      }
      assertSafeUrl(url);
      webStats.fetchCount++;
      let currentUrl = url;
      let response = null;
      let redirectCount = 0;
      while (redirectCount <= MAX_REDIRECTS) {
        response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
            Accept: "text/html, text/plain, */*"
          },
          redirect: "manual",
          signal: AbortSignal.timeout(3e4)
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          redirectCount++;
          const location = response.headers.get("location");
          currentUrl = new URL(location, currentUrl).toString();
          if (redirectCount > MAX_REDIRECTS) {
            warn(
              `web_fetch: Redirect chain exceeded ${MAX_REDIRECTS} hops for ${url} \u2014 aborting`
            );
            throw new Error(
              `Too many redirects (>${MAX_REDIRECTS}) for ${url}`
            );
          }
          if (redirectCount >= 3) {
            warn(
              `web_fetch: Redirect chain at ${redirectCount} hops for ${url}`
            );
          }
          continue;
        }
        break;
      }
      if (!response || !response.ok) {
        const status = response?.status ?? 0;
        const statusText = response?.statusText ?? "Unknown";
        fetchAuditLog.push({ url, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status });
        const friendlyMsg = getFriendlyFetchError(status, url);
        throw new Error(friendlyMsg);
      }
      const contentType = response.headers.get("content-type") ?? "text/html";
      if (!isAllowedContentType(contentType)) {
        fetchAuditLog.push({ url, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status: response.status });
        throw new Error(`Rejected content-type: ${contentType} \u2014 only text/html, text/plain, application/json accepted`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        fetchAuditLog.push({ url, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status: response.status });
        throw new Error(`Response too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`);
      }
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_SIZE) {
        fetchAuditLog.push({ url, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status: response.status });
        throw new Error(`Response too large: ${raw.length} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`);
      }
      fetchAuditLog.push({ url, timestamp: (/* @__PURE__ */ new Date()).toISOString(), status: response.status });
      let text;
      let metaSummary = "";
      if (contentType.includes("text/html")) {
        metaSummary = extractMetaSummary(raw);
        if (raw.length > 16e3) {
          text = extractMainContent(raw);
        } else {
          text = htmlToText(raw);
        }
      } else {
        text = raw;
      }
      if (isRedirectContent(text)) {
        text = `[WARNING: Page appears to be a redirect page, not actual content]
${text}`;
      }
      if (text.replace(/\s+/g, "").length < 100) {
        text = `[WARNING: Page content is very short \u2014 may be paywalled, empty, or require JavaScript]
${text}`;
      }
      text = stripBoilerplate(text);
      if (metaSummary) {
        text = `${metaSummary}
---
${text}`;
      }
      const keyFacts = extractKeyFacts(text);
      if (keyFacts.length > 0) {
        const factsBullets = keyFacts.slice(0, 8).map((f) => `- ${f}`).join("\n");
        text = `KEY FACTS:
${factsBullets}
---
${text}`;
      }
      const { sanitized } = sanitizer.sanitize(text, { maxLength });
      const fetchTime = (/* @__PURE__ */ new Date()).toISOString();
      const reliability = getReliabilityLabel(url);
      const fetchElapsedMs = Date.now() - fetchStartMs;
      const tokenEstimate = Math.ceil(sanitized.length / 4);
      const citation = `
Source: ${currentUrl}
Fetched: ${fetchTime}
Source reliability: ${reliability}
[Fetched in ${fetchElapsedMs}ms | ~${tokenEstimate} tokens]`;
      return `${sanitized}
${citation}`;
    },
    // ------------------------------------------------------------------
    // web_search_and_read — composite tool (Improvement #10)
    // with result preview (Iter 4 #10)
    // ------------------------------------------------------------------
    web_search_and_read: async (args) => {
      const query = args.query;
      if (!query) throw new Error("query is required");
      const maxLength = args.maxLength;
      if (!assertSafeUrl) {
        throw new Error("SSRF protection not configured \u2014 web_search_and_read disabled");
      }
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
      results = results.filter((r) => !isBlockedDomain(r.url));
      results = deduplicateResults(results);
      const scored = results.map((r) => ({ ...r, score: scoreResult(r, query) })).sort((a, b) => b.score - a.score);
      if (scored.length === 0) {
        return "No usable results found for the given query.";
      }
      const topResult = scored[0];
      try {
        assertSafeUrl(topResult.url);
      } catch {
        return `Top result URL not safe to fetch: ${topResult.url}

Other results:
${formatResultList(scored.slice(1))}`;
      }
      let fetchedContent;
      try {
        let currentUrl = topResult.url;
        let response = null;
        let redirectCount = 0;
        while (redirectCount <= MAX_REDIRECTS) {
          response = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
              Accept: "text/html, text/plain, */*"
            },
            redirect: "manual",
            signal: AbortSignal.timeout(3e4)
          });
          if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
            redirectCount++;
            currentUrl = new URL(
              response.headers.get("location"),
              currentUrl
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
        const contentType = response.headers.get("content-type") ?? "text/html";
        if (!isAllowedContentType(contentType)) {
          throw new Error(`Rejected content-type: ${contentType}`);
        }
        const raw = await response.text();
        if (raw.length > MAX_RESPONSE_SIZE) {
          throw new Error(`Response too large: ${raw.length} bytes`);
        }
        let text;
        let metaSummary = "";
        if (contentType.includes("text/html")) {
          metaSummary = extractMetaSummary(raw);
          text = raw.length > 16e3 ? extractMainContent(raw) : htmlToText(raw);
        } else {
          text = raw;
        }
        if (metaSummary) {
          text = `${metaSummary}
---
${text}`;
        }
        const { sanitized } = sanitizer.sanitize(text, { maxLength });
        fetchedContent = sanitized;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return `Failed to fetch top result (${errMsg}).

Search results:
${formatResultList(scored)}`;
      }
      const reliability = getReliabilityLabel(topResult.url);
      const header = `Source: ${topResult.title}
URL: ${topResult.url}
Source reliability: ${reliability}
${"=".repeat(60)}

`;
      const otherPreviews = scored.slice(1, 4).map(
        (r, i) => `${i + 2}. ${r.title}
   URL: ${r.url}
   ${r.snippet.slice(0, 200)}`
      ).join("\n\n");
      const footer = otherPreviews ? `

${"=".repeat(60)}
Other results:
${otherPreviews}` : "";
      return header + fetchedContent + footer;
    },
    // ------------------------------------------------------------------
    // web_quick_answer — search + read top 3 + extract answer (Iter 6 #5)
    // ------------------------------------------------------------------
    web_quick_answer: async (args) => {
      const question = args.question;
      if (!question) throw new Error("question is required");
      const quickStartMs = Date.now();
      if (!assertSafeUrl) {
        throw new Error("SSRF protection not configured \u2014 web_quick_answer disabled");
      }
      webStats.searchCount++;
      const augmented = augmentQueryWithDate(question);
      let results = await searchClient.search(augmented, 5);
      if (results.length === 0 && augmented !== question) {
        results = await searchClient.search(question, 5);
      }
      if (results.length === 0) {
        return "Could not find an answer to this question.";
      }
      results = results.filter((r) => !isBlockedDomain(r.url));
      results = deduplicateResults(results);
      const scored = results.map((r) => ({ ...r, score: scoreResult(r, question) })).sort((a, b) => b.score - a.score);
      if (scored.length === 0) {
        return "Could not find an answer to this question.";
      }
      const top3 = scored.slice(0, 3);
      const excerpts = [];
      const fetchPromises = top3.map(async (result) => {
        try {
          assertSafeUrl(result.url);
          const resp = await fetch(result.url, {
            headers: {
              "User-Agent": "Zaraa/1.0 (Autonomous Assistant)",
              Accept: "text/html, text/plain, */*"
            },
            redirect: "follow",
            signal: AbortSignal.timeout(1e4)
          });
          if (!resp.ok) return null;
          const contentType = resp.headers.get("content-type") ?? "text/html";
          if (!isAllowedContentType(contentType)) return null;
          const raw = await resp.text();
          if (raw.length > MAX_RESPONSE_SIZE) return null;
          let text;
          if (contentType.includes("text/html")) {
            text = raw.length > 16e3 ? extractMainContent(raw) : htmlToText(raw);
          } else {
            text = raw;
          }
          text = stripBoilerplate(text);
          const facts = extractKeyFacts(text);
          const queryTerms = question.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
          const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
          const relevantParagraph = paragraphs.find((p) => {
            const lower = p.toLowerCase();
            return queryTerms.some((t) => lower.includes(t));
          }) ?? paragraphs[0] ?? "";
          return {
            title: result.title,
            url: result.url,
            facts: facts.slice(0, 3),
            excerpt: relevantParagraph.slice(0, 500),
            reliability: getReliabilityLabel(result.url)
          };
        } catch {
          return null;
        }
      });
      const fetchedResults = await Promise.all(fetchPromises);
      for (const fr of fetchedResults) {
        if (!fr) continue;
        const parts = [];
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
        const snippetAnswer = scored.slice(0, 3).map(
          (r, i) => `${i + 1}. ${r.title}
   ${r.snippet}
   Source: ${r.url}`
        ).join("\n\n");
        return `Could not fetch pages, but here are search snippets:

${snippetAnswer}`;
      }
      const elapsedMs = Date.now() - quickStartMs;
      const answer = excerpts.join("\n\n---\n\n");
      const tokenEstimate = Math.ceil(answer.length / 4);
      return `Quick answer for: "${question}"
${"=".repeat(60)}

${answer}

[Answered in ${elapsedMs}ms from ${excerpts.length} sources | ~${tokenEstimate} tokens]`;
    }
  };
}
function formatScoredResults(results, sanitizer) {
  const formatted = results.map(
    (r, i) => `${i + 1}. ${r.title} [score: ${r.score.toFixed(2)}]
   URL: ${r.url}
   ${r.snippet}`
  ).join("\n\n");
  const { sanitized } = sanitizer.sanitize(formatted);
  return sanitized;
}
function formatResultList(results) {
  return results.map((r, i) => `${i + 1}. ${r.title}
   URL: ${r.url}
   ${r.snippet}`).join("\n\n");
}

// src/index.ts
var manifest = {
  name: "web",
  version: "0.4.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["network.request"],
  trust: "core",
  tools: [
    {
      name: "web_search",
      description: "Search the web and return ranked results. Use for finding current information, news, prices, documentation, or anything you don't know. Returns titles, URLs, snippets, quality scores, timing, and token estimate. Results are deduplicated, scored by domain reputation and category relevance, and cached for 5 minutes. Complex queries are automatically split into sub-queries.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query \u2014 be specific for better results"
          },
          count: {
            type: "number",
            description: "Number of results to return (default: 5, max: 10)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "web_fetch",
      description: "Fetch and read a specific web page by URL. Use when you have an exact URL to read (e.g., from a user or from web_search results). Extracts main content from HTML, strips boilerplate/ads/cookie banners, highlights key facts as bullets, and includes source citation with reliability scoring. Protected against crypto scams, phishing, and prompt injection.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL to fetch (must start with https:// or http://)"
          },
          maxLength: {
            type: "number",
            description: "Maximum characters to return (default: 16000). Use lower values for quick reads."
          }
        },
        required: ["url"]
      },
      requiresApproval: false
    },
    {
      name: "web_search_and_read",
      description: "Search the web AND read the top result in one step. Use when you need to find and read about a topic \u2014 saves a round-trip vs. calling web_search then web_fetch. Returns the full page content of the best result plus previews of other results. Falls back to search snippets if the page cannot be fetched.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query \u2014 what you want to find and read about"
          },
          maxLength: {
            type: "number",
            description: "Maximum characters to return (default: 16000)"
          }
        },
        required: ["query"]
      },
      requiresApproval: false
    },
    {
      name: "web_quick_answer",
      description: "Get a concise answer to a factual question. Searches the web, reads the top 3 results, and extracts just the key facts and relevant excerpts \u2014 no full page content. Use for quick factual lookups like 'What is the population of Tokyo?' or 'When was Python 3.12 released?'. Faster and more focused than web_search_and_read.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The factual question to answer"
          }
        },
        required: ["question"]
      },
      requiresApproval: false
    }
  ]
};
export {
  BLOCKED_DOMAINS,
  BraveSearchClient,
  DuckDuckGoClient,
  FallbackSearchClient,
  SearxngSearchClient,
  TRUSTED_DOMAINS,
  TavilySearchClient,
  WebContentSanitizer,
  WikipediaSearchClient,
  boostDomainFromTraceScore,
  clearDynamicReputation,
  clearFetchAuditLog,
  clearSearchCache,
  clearSearchMemory,
  createWebHandlers,
  detectConflictingClaims,
  detectCryptoScams,
  detectPhishing,
  extractDomain,
  extractKeyFacts,
  extractMainContent,
  extractMetaSummary,
  getCategoryBoost,
  getDomainCategory,
  getDomainScore,
  getDynamicReputationSize,
  getFetchAuditLog,
  getReliabilityLabel,
  getSearchCacheSize,
  getSearchMemory,
  getWebStats,
  hasExcessiveLinks,
  htmlToText,
  isBlockedDomain,
  isRedirectContent,
  manifest,
  recordDomainFailure,
  recordDomainSuccess,
  resetWebStats,
  scoreContentQuality,
  scoreResult,
  stripBoilerplate,
  stripDataUrls
};
