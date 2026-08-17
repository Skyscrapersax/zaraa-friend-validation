/**
 * RateLimitedFetcher — Token-bucket rate limiter for external API calls.
 *
 * Cycle 009: Prevents hitting Polymarket API rate limits.
 *
 * Uses a token-bucket algorithm: tokens refill at a fixed rate, each request
 * costs one token. When the bucket is empty, requests queue and wait for
 * tokens to refill. This naturally smooths burst traffic.
 *
 * Polymarket limits:
 * - Gamma API: 4,000 req/10s (we target 300/s = safe headroom)
 * - CLOB reads: 15,000 req/10s (we target 1,000/s)
 * - CLOB writes: 3,500 req/10s (we target 250/s)
 */

export interface TokenBucketConfig {
	/** Tokens added per second */
	refillRate: number;
	/** Maximum bucket capacity */
	maxTokens: number;
	/** Label for logging */
	label?: string;
}

export const POLYMARKET_RATE_LIMITS = {
	gamma: { refillRate: 300, maxTokens: 600, label: "gamma" } satisfies TokenBucketConfig,
	clobRead: { refillRate: 1000, maxTokens: 2000, label: "clob-read" } satisfies TokenBucketConfig,
	clobWrite: { refillRate: 250, maxTokens: 500, label: "clob-write" } satisfies TokenBucketConfig,
} as const;

export class TokenBucket {
	private tokens: number;
	private lastRefill: number;
	private config: TokenBucketConfig;
	private waitQueue: Array<{ resolve: () => void }> = [];
	private drainTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: TokenBucketConfig) {
		this.config = config;
		this.tokens = config.maxTokens;
		this.lastRefill = Date.now();
	}

	/**
	 * Attempt to consume a token. Returns true if a token was available,
	 * false if the bucket is empty.
	 */
	tryConsume(): boolean {
		this.refill();
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}

	/**
	 * Wait until a token is available, then consume it.
	 * This is the primary method for rate-limited operations.
	 */
	async acquire(): Promise<void> {
		if (this.tryConsume()) return;

		// Wait for a token to become available
		return new Promise<void>((resolve) => {
			this.waitQueue.push({ resolve });
			this.scheduleDrain();
		});
	}

	/**
	 * Return current utilization (0-1). Higher = closer to rate limit.
	 */
	get utilization(): number {
		this.refill();
		return 1 - this.tokens / this.config.maxTokens;
	}

	/**
	 * Remaining tokens in the bucket.
	 */
	get remaining(): number {
		this.refill();
		return Math.floor(this.tokens);
	}

	/**
	 * Reset the bucket to full capacity. Used when rate limit headers
	 * indicate we have more headroom than expected.
	 */
	reset(): void {
		this.tokens = this.config.maxTokens;
		this.lastRefill = Date.now();
	}

	/**
	 * Clean up timers. Call when shutting down.
	 */
	dispose(): void {
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = null;
		}
		// Resolve all waiting promises
		for (const waiter of this.waitQueue) {
			waiter.resolve();
		}
		this.waitQueue = [];
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000; // seconds
		const newTokens = elapsed * this.config.refillRate;
		this.tokens = Math.min(this.config.maxTokens, this.tokens + newTokens);
		this.lastRefill = now;
	}

	private scheduleDrain(): void {
		if (this.drainTimer) return;
		// Check every 10ms for available tokens
		this.drainTimer = setTimeout(() => {
			this.drainTimer = null;
			this.refill();
			while (this.waitQueue.length > 0 && this.tokens >= 1) {
				this.tokens -= 1;
				const waiter = this.waitQueue.shift()!;
				waiter.resolve();
			}
			if (this.waitQueue.length > 0) {
				this.scheduleDrain();
			}
		}, 10);
	}
}

/**
 * Wrap a fetch function with rate limiting and retry logic.
 *
 * @param fn - The async function to execute
 * @param bucket - Token bucket for rate limiting
 * @param opts - Retry options
 */
export async function rateLimitedFetch<T>(
	fn: () => Promise<T>,
	bucket: TokenBucket,
	opts: { maxRetries?: number; backoffMs?: number } = {},
): Promise<T> {
	const maxRetries = opts.maxRetries ?? 3;
	const backoffMs = opts.backoffMs ?? 1000;

	await bucket.acquire();

	let lastError: unknown = new Error("rateLimitedFetch: all retries exhausted");
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const msg = err instanceof Error ? err.message.toLowerCase() : "";

			// Don't retry auth errors
			if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")) {
				throw err;
			}

			// Rate limited: exponential backoff
			if (msg.includes("429") || msg.includes("too many") || msg.includes("rate limit")) {
				if (attempt < maxRetries) {
					await sleep(backoffMs * 2 ** attempt);
					await bucket.acquire(); // Re-acquire token after backoff
					continue;
				}
			}

			// Network error: linear backoff
			if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("fetch failed")) {
				if (attempt < maxRetries) {
					await sleep(500);
					continue;
				}
			}

			// Unknown error on last attempt
			if (attempt === maxRetries) throw err;
		}
	}

	throw lastError;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
