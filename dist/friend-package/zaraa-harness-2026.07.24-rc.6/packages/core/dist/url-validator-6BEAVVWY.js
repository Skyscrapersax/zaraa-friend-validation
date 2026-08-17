import "./chunk-R5U7XKVJ.js";

// src/privacy/url-validator.ts
function isRfc6598SharedRange(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}
var BLOCKED_IPV4_RANGES = [
  // Loopback
  { prefix: "127.", bits: 8, label: "loopback" },
  // Private networks (RFC1918)
  { prefix: "10.", bits: 8, label: "private (RFC1918)" },
  { prefix: "172.16.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.17.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.18.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.19.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.20.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.21.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.22.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.23.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.24.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.25.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.26.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.27.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.28.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.29.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.30.", bits: 12, label: "private (RFC1918)" },
  { prefix: "172.31.", bits: 12, label: "private (RFC1918)" },
  { prefix: "192.168.", bits: 16, label: "private (RFC1918)" },
  // Link-local
  { prefix: "169.254.", bits: 16, label: "link-local (cloud metadata)" },
  // RFC2544 benchmark (198.18.0.0/15)
  { prefix: "198.18.", bits: 15, label: "benchmark (RFC2544)" },
  { prefix: "198.19.", bits: 15, label: "benchmark (RFC2544)" },
  // Documentation ranges
  { prefix: "192.0.2.", bits: 24, label: "documentation (RFC5737)" },
  { prefix: "198.51.100.", bits: 24, label: "documentation (RFC5737)" },
  { prefix: "203.0.113.", bits: 24, label: "documentation (RFC5737)" },
  // Shared address space (RFC6598) — carrier-grade NAT (100.64.0.0/10)
  // NOTE: The full /10 range (second octet 64-127) is checked separately via
  // isRfc6598SharedRange() below; this placeholder entry is intentionally
  // omitted so the generic prefix loop does not partially match the range.
  // (No entry here — see the explicit isRfc6598SharedRange guard.)
  // Current network
  { prefix: "0.", bits: 8, label: "current network" }
];
var BLOCKED_HOSTNAMES = /* @__PURE__ */ new Set([
  "localhost",
  "metadata.google.internal",
  // GCP metadata
  "instance-data"
  // AWS legacy metadata
]);
function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Blocked hostname: ${hostname}` };
  }
  const bareHostname = hostname.replace(/^\[|\]$/g, "").split("%")[0];
  if (bareHostname === "::1") {
    return { allowed: false, reason: "IPv6 loopback" };
  }
  if (bareHostname.startsWith("fe80:")) {
    return { allowed: false, reason: "IPv6 link-local" };
  }
  const v4MappedMatch = bareHostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    const mappedIp = v4MappedMatch[1];
    if (isRfc6598SharedRange(mappedIp)) {
      return { allowed: false, reason: "Blocked IP range via IPv4-mapped IPv6: shared (RFC6598)" };
    }
    for (const range of BLOCKED_IPV4_RANGES) {
      if (mappedIp.startsWith(range.prefix)) {
        return { allowed: false, reason: `Blocked IP range via IPv4-mapped IPv6: ${range.label}` };
      }
    }
  }
  const ip = hostname.replace(/^\[|\]$/g, "");
  if (isRfc6598SharedRange(ip)) {
    return { allowed: false, reason: "Blocked IP range: shared (RFC6598) (100.64.0.0/10)" };
  }
  for (const range of BLOCKED_IPV4_RANGES) {
    if (ip.startsWith(range.prefix)) {
      return { allowed: false, reason: `Blocked IP range: ${range.label} (${range.prefix}0/${range.bits})` };
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }
  return { allowed: true };
}
function assertSafeUrl(urlString) {
  const result = validateUrl(urlString);
  if (!result.allowed) {
    throw new Error(`SSRF protection: ${result.reason} \u2014 ${urlString}`);
  }
}
function hasEmbeddedCredentials(urlString) {
  try {
    const parsed = new URL(urlString);
    return !!(parsed.username || parsed.password);
  } catch {
    return false;
  }
}
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_MAX_REQUESTS = 10;
var domainRateLimits = /* @__PURE__ */ new Map();
function checkDomainRateLimit(urlString) {
  let hostname;
  try {
    hostname = new URL(urlString).hostname;
  } catch {
    return true;
  }
  const now = Date.now();
  const entry = domainRateLimits.get(hostname);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    domainRateLimits.set(hostname, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  entry.count++;
  return true;
}
function clearDomainRateLimits() {
  domainRateLimits.clear();
}
function assertSafeUrlFull(urlString) {
  const result = validateUrl(urlString);
  if (!result.allowed) {
    throw new Error(`SSRF protection: ${result.reason} \u2014 ${urlString}`);
  }
  if (hasEmbeddedCredentials(urlString)) {
    throw new Error(`SSRF protection: URL contains embedded credentials \u2014 ${urlString}`);
  }
  if (!checkDomainRateLimit(urlString)) {
    throw new Error(`Rate limited: too many requests to this domain \u2014 ${urlString}`);
  }
}
export {
  assertSafeUrl,
  assertSafeUrlFull,
  checkDomainRateLimit,
  clearDomainRateLimits,
  hasEmbeddedCredentials,
  validateUrl
};
