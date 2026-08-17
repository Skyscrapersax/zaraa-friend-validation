import type { SearchClient, SearchResult } from "./brave-client.js";

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
export interface FallbackSearchOptions {
	/**
	 * Max time to wait on a single backend before giving up and trying the next.
	 * A blocked primary (e.g. DuckDuckGo IP-block) can hang ~10s per attempt ×
	 * retries; without this bound the whole chat turn is spent before the fast
	 * fallback runs. Defaults to 10s.
	 */
	perClientTimeoutMs?: number;
}

const DEFAULT_PER_CLIENT_TIMEOUT_MS = 10_000;

export class FallbackSearchClient implements SearchClient {
	private readonly clients: SearchClient[];
	private readonly perClientTimeoutMs: number;

	constructor(clients: SearchClient[], options?: FallbackSearchOptions) {
		if (clients.length === 0) {
			throw new Error("FallbackSearchClient requires at least one client");
		}
		this.clients = clients;
		this.perClientTimeoutMs =
			options?.perClientTimeoutMs ?? DEFAULT_PER_CLIENT_TIMEOUT_MS;
	}

	async search(query: string, count?: number): Promise<SearchResult[]> {
		let lastError: unknown;
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

	private withTimeout(p: Promise<SearchResult[]>): Promise<SearchResult[]> {
		// Swallow a late rejection from the loser so it never surfaces as an
		// unhandled rejection after the race is decided.
		p.catch(() => {});
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("search backend timed out")),
				this.perClientTimeoutMs,
			);
		});
		return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
	}
}
