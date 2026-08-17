/**
 * Remove credentials and common secret patterns from strings before logging
 * or returning error text (TRD-07 — no API keys in logs/stack traces).
 */

export interface ScrubCredentials {
	apiKey?: string;
	apiSecret?: string;
}

/**
 * Redact known credentials and heuristic patterns from free-form text.
 */
export function scrubSecrets(text: string, creds?: ScrubCredentials): string {
	let out = text;
	if (creds?.apiKey && creds.apiKey.length >= 4) {
		out = out.split(creds.apiKey).join("[REDACTED_API_KEY]");
	}
	if (creds?.apiSecret && creds.apiSecret.length >= 4) {
		out = out.split(creds.apiSecret).join("[REDACTED_API_SECRET]");
	}

	// Anthropic / OpenAI-style keys (avoid matching short arbitrary "sk-" tokens)
	out = out.replace(/\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
	out = out.replace(/\bsk-(?:live|proj|test)-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]");
	out = out.replace(/\bsk-[A-Za-z0-9]{24,}\b/g, "[REDACTED]");

	out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+\b/gi, "Bearer [REDACTED]");
	out = out.replace(/Basic\s+[A-Za-z0-9+/=]{16,}/gi, "Basic [REDACTED]");

	// JSON-ish api_key / sig from exchange bodies
	out = out.replace(/"api_key"\s*:\s*"[^"]*"/gi, '"api_key":"[REDACTED]"');
	// camelCase variants (ccxt and most JS exchange SDKs)
	out = out.replace(/"apiKey"\s*:\s*"[^"]*"/g, '"apiKey":"[REDACTED]"');
	out = out.replace(/"apiSecret"\s*:\s*"[^"]*"/g, '"apiSecret":"[REDACTED]"');
	out = out.replace(/"secret"\s*:\s*"[^"]*"/g, '"secret":"[REDACTED]"');
	out = out.replace(/"sig"\s*:\s*"[a-fA-F0-9]{32,128}"/g, '"sig":"[REDACTED]"');
	out = out.replace(/"signature"\s*:\s*"[a-fA-F0-9]{32,128}"/g, '"signature":"[REDACTED]"');

	// Binance query-style leaks
	out = out.replace(/([?&])signature=[^&\s]+/gi, "$1signature=[REDACTED]");
	out = out.replace(/\bX-MBX-APIKEY['":\s]+\S+/gi, "X-MBX-APIKEY [REDACTED]");

	// Ethereum/EVM private keys (0x + 64 hex chars)
	out = out.replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED_ETH_KEY]");

	// Solana private keys — base58, 87-88 chars (full keypair)
	out = out.replace(/\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/g, "[REDACTED_SOLANA_KEY]");

	// Stellar secret seeds — 'S' + 55 base32 chars
	out = out.replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_KEY]");

	// XRPL family seeds — 's' + 28 base58 chars
	out = out.replace(/\bs[1-9A-HJ-NP-Za-km-z]{28}\b/g, "[REDACTED_XRPL_SEED]");

	// BIP-39 mnemonic phrases (12 or 24 lowercase words separated by spaces)
	out = out.replace(/\b(?:[a-z]+\s){11}[a-z]+\b/g, "[REDACTED_MNEMONIC]");
	out = out.replace(/\b(?:[a-z]+\s){23}[a-z]+\b/g, "[REDACTED_MNEMONIC]");

	return out;
}

export function scrubErrorMessage(err: unknown, creds?: ScrubCredentials): string {
	const raw = err instanceof Error ? err.message : String(err);
	return scrubSecrets(raw, creds);
}
