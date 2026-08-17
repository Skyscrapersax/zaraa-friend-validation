export interface FeeSchedule {
	venue: string;
	makerRate: number;
	takerRate: number;
}

const FALLBACK_RATE = 0.001;

const VENUE_PREFIXES: Record<string, string> = {
	"solana:": "jupiter",
	"stellar:": "stellar",
	"flare:": "flare",
	"xrpl:": "xrpl",
};

export function resolveVenue(symbol: string): string {
	const lower = symbol.toLowerCase();
	for (const [prefix, venue] of Object.entries(VENUE_PREFIXES)) {
		if (lower.startsWith(prefix)) return venue;
	}
	return "crypto.com";
}

export function resolveFeeRate(
	venue: string,
	orderType: "MARKET" | "LIMIT",
	schedules: FeeSchedule[],
): number {
	const entry = schedules.find((s) => s.venue === venue);
	if (!entry) return FALLBACK_RATE;
	return orderType === "LIMIT" ? entry.makerRate : entry.takerRate;
}

export function getDefaultFeeSchedules(): FeeSchedule[] {
	return [
		{ venue: "crypto.com", makerRate: 0.00040, takerRate: 0.00075 },
		{ venue: "jupiter", makerRate: 0.003, takerRate: 0.003 },
		{ venue: "stellar", makerRate: 0.0001, takerRate: 0.0001 },
		{ venue: "flare", makerRate: 0.003, takerRate: 0.003 },
		{ venue: "xrpl", makerRate: 0.0, takerRate: 0.0 },
	];
}
