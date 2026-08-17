/**
 * Paper-mode equity computation.
 *
 * Sums every paper balance priced in USD plus the mark-to-market value of
 * open SHORT positions and DEX longs. Non-USDT currencies are priced via
 * their <CCY>_USDT ticker so BTC/SOL/XRP holdings count toward equity. A
 * balance whose ticker fetch fails falls back to the last-known-good price
 * (15-minute TTL) so a transient feed glitch doesn't drop the asset from
 * equity and trip the drawdown CB on a portfolio that hasn't actually drawn
 * down. If the cache is also empty/stale the balance is excluded rather
 * than face-valued: conflating "5 MOONTOKEN" with "$5" silently inflates
 * equity.
 *
 * Spot long positions do NOT add to `openPositionValue` because their mark
 * is already reflected in `balances` — `store.openPosition` debits quote
 * and credits base on entry, `closePosition` mirrors that on exit. Counting
 * a spot long again here would double-count its mark. DEX longs (solana:*)
 * aren't reconciled into paper_balances by the spot helper (different
 * symbol layout), so they still contribute through the position record.
 * Shorts can't be modeled via spot balances (no margin in paper). Their sale
 * notional stays in USDT cash (the reconcile helpers skip non-longs), so a
 * short contributes ONLY its unrealized PnL `(entryPrice - mark) * qty` here —
 * adding the notional again would double-count it and inflate equity.
 *
 * This logic was duplicated across three call sites (handlers.ts,
 * zaraa.ts hourly interval, zaraa.ts position-close). When one site was
 * fixed in isolation the others kept reporting USDT-only equity, which
 * tripped the drawdown breaker on a portfolio that hadn't actually drawn
 * down. One helper means one place to get it right.
 */
export interface PaperEquityBalance {
	currency: string;
	balance: number;
}

export interface PaperEquityPosition {
	symbol: string;
	side: "long" | "short";
	entryPrice: number;
	qty: number;
}

export interface PaperEquityDeps {
	balances: PaperEquityBalance[];
	openPositions: PaperEquityPosition[];
	/** Fetch a ticker for a CEX symbol (e.g. "BTC_USDT"). May throw for unknown markets. */
	getTicker: (symbol: string) => Promise<{ last: number }>;
	/** Called when a <CCY>_USDT lookup fails AND no fresh cached price is available. */
	onNoTicker?: (currency: string, balance: number) => void;
	/** Called when the ticker fetch fails but a cached price is used as fallback. */
	onStalePriceFallback?: (
		currency: string,
		balance: number,
		cachedPrice: number,
		ageMs: number,
	) => void;
	/** Optional: for Solana DEX symbols, fetch USD price (returns null if unavailable). */
	getDexPrice?: (symbol: string) => Promise<number | null>;
	/** Returns true if the symbol is a Solana DEX symbol and should use getDexPrice. */
	isDexSymbol?: (symbol: string) => boolean;
}

const STALE_PRICE_TTL_MS = 15 * 60 * 1000;
const priceCache = new Map<string, { price: number; ts: number }>();

/** Test-only: reset the module-scoped last-known-good price cache. */
export function _resetPaperEquityPriceCache(): void {
	priceCache.clear();
}

function isPositiveFinite(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function rememberPrice(symbol: string, price: number, now: number): void {
	if (isPositiveFinite(price)) {
		priceCache.set(symbol, { price, ts: now });
	}
}

function recallPrice(
	symbol: string,
	now: number,
): { price: number; ageMs: number } | null {
	const hit = priceCache.get(symbol);
	if (!hit) return null;
	const ageMs = now - hit.ts;
	if (ageMs > STALE_PRICE_TTL_MS) return null;
	if (!isPositiveFinite(hit.price)) return null;
	return { price: hit.price, ageMs };
}

export async function computePaperEquityUsd(deps: PaperEquityDeps): Promise<number> {
	const now = Date.now();
	let cashEquityUsd = 0;
	for (const { currency, balance } of deps.balances) {
		if (balance <= 0) continue;
		if (currency === "USDT" || currency === "USD") {
			cashEquityUsd += balance;
			continue;
		}
		const symbol = `${currency}_USDT`;
		try {
			const ticker = await deps.getTicker(symbol);
			rememberPrice(symbol, ticker.last, now);
			cashEquityUsd += ticker.last * balance;
		} catch {
			const cached = recallPrice(symbol, now);
			if (cached !== null) {
				console.warn(
					`[paper-equity] ${symbol} ticker fetch failed; using cached price ${cached.price} (age ${Math.floor(cached.ageMs / 1000)}s)`,
				);
				deps.onStalePriceFallback?.(currency, balance, cached.price, cached.ageMs);
				cashEquityUsd += cached.price * balance;
			} else {
				deps.onNoTicker?.(currency, balance);
			}
		}
	}

	let openPositionValue = 0;
	for (const pos of deps.openPositions) {
		const isDex = deps.isDexSymbol?.(pos.symbol) ?? false;
		// Spot-pair longs are already valued via `balances` — store.openPosition
		// debits quote and credits base on entry, store.closePosition mirrors
		// it on exit. Counting them here would double-count their mark.
		// DEX longs (e.g. solana:TOKEN) are NOT reconciled into paper_balances
		// by the spot helper (different symbol layout) and still need to
		// contribute their mark here.
		if (pos.side === "long" && !isDex) continue;
		try {
			let price: number;
			if (isDex && deps.getDexPrice) {
				const dp = await deps.getDexPrice(pos.symbol);
				price = dp ?? pos.entryPrice;
			} else {
				const ticker = await deps.getTicker(pos.symbol);
				price = ticker.last;
			}
			openPositionValue +=
				pos.side === "long"
					? price * pos.qty
					: // Short: contribute ONLY unrealized PnL. Paper shorts never touch
						// paper_balances (the reconcile helpers early-return for non-long),
						// so the short-sale notional already sits untouched in USDT cash —
						// adding entryNotional here double-counts it, inflating equity and
						// poisoning the peak/drawdown breaker + position sizing.
						(pos.entryPrice - price) * pos.qty;
		} catch {
			// Price fetch failed — fall back conservatively. A DEX long is worth its
			// entry mark; a short's PnL is ~0 at entry and its notional already lives
			// in USDT cash, so it contributes nothing.
			openPositionValue += pos.side === "long" ? pos.entryPrice * pos.qty : 0;
		}
	}

	return cashEquityUsd + openPositionValue;
}
