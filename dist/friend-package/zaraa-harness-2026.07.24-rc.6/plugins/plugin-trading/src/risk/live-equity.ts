import type { CryptoClient } from "../crypto-client.js";
import type { LiveEquitySnapshot, TradingStore } from "../trading-store.js";

export const MAX_LIVE_EQUITY_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 10_000;

function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Fetch authenticated exchange balances, price every positive asset, then
 * persist a dedicated LIVE snapshot. Missing prices fail closed; partial NAV
 * is never allowed to authorize a real-money entry.
 */
export async function refreshLiveAccountEquity(input: {
	client: CryptoClient;
	store: TradingStore;
	now?: number;
}): Promise<LiveEquitySnapshot> {
	const { client, store } = input;
	if (!client.hasCredentials) throw new Error("authenticated exchange balances unavailable");

	const balances = (await client.getBalances()).filter((balance) => positiveFinite(balance.total));
	if (balances.length === 0) throw new Error("live account has no positive balances");

	let equity = 0;
	for (const balance of balances) {
		const currency = balance.currency.trim().toUpperCase();
		if (!currency) throw new Error("live balance currency is missing");
		if (currency === "USD" || currency === "USDT") {
			equity += balance.total;
			continue;
		}

		const ticker = await client.getTicker(`${currency}_USDT`);
		if (!positiveFinite(ticker.last)) {
			throw new Error(`live NAV price unavailable for ${currency}`);
		}
		equity += balance.total * ticker.last;
	}

	if (!positiveFinite(equity)) throw new Error("live account equity is invalid");
	const timestamp = new Date(input.now ?? Date.now()).toISOString();
	const source = `${client.exchangeId || "exchange"}:authenticated-balances`;
	store.recordLiveEquity(equity, source, timestamp);
	return { timestamp, equity, source };
}

/** Require a recent authenticated LIVE snapshot; paper/global snapshots never qualify. */
export function requireFreshLiveEquity(
	store: TradingStore,
	now = Date.now(),
	maxAgeMs = MAX_LIVE_EQUITY_AGE_MS,
): LiveEquitySnapshot {
	const snapshot = store.getLatestLiveEquitySnapshot();
	if (!snapshot || !positiveFinite(snapshot.equity) || !snapshot.source) {
		throw new Error("fresh authenticated live equity is unavailable");
	}
	const observedAt = Date.parse(snapshot.timestamp);
	const ageMs = now - observedAt;
	if (!Number.isFinite(observedAt) || ageMs > maxAgeMs || ageMs < -MAX_FUTURE_SKEW_MS) {
		throw new Error("authenticated live equity snapshot is stale or has invalid time");
	}
	return snapshot;
}
