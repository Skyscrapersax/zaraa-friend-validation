/**
 * Smart-money consensus watcher (READ-ONLY, no orders).
 *
 * Fills the gap left by the EV/cross-venue engines: instead of pricing markets,
 * it observes the public Polymarket global trades firehose
 * (`data-api.polymarket.com/trades`) and surfaces OUTCOMES that many independent
 * wallets are buying at once — the honest form of "copy trading". Blindly mirroring
 * one high-win-rate account is a trap (favorite-skew / info-asymmetry); convergence
 * across many independent wallets is a stronger, mechanism-based signal.
 *
 * It records each consensus as a shadow "signal" journal entry (no execution) so the
 * operator can watch it accrue and measure forward EV before any capital is risked.
 */

import { z } from "zod";

export interface SmartMoneyConsensusConfig {
	/** Master switch. Default false — inert until the operator opts in + restarts. */
	enabled?: boolean;
	/** Min distinct wallets buying the same outcome to flag a consensus. Default 4. */
	minWallets?: number;
	/** Only count fills >= this USD notional (server-side `filterAmount`). Default 250. */
	minFillUsd?: number;
	/** Firehose pages to scan (500 trades each). Default 4. */
	pages?: number;
	/** Poll interval in ms when started. Default 900000 (15 min). */
	pollIntervalMs?: number;
	/** Drop live sports props (high adverse selection / noise). Default true. */
	excludeSports?: boolean;
	/** Max % of an outcome's USD allowed from one wallet before it's flagged non-independent. Default 60. */
	maxTopWalletPct?: number;
	/** data-api base URL. */
	dataApiBaseUrl?: string;
}

export interface SmartMoneyOpportunity {
	conditionId: string;
	title: string;
	outcome: string;
	category: string;
	/** Number of distinct wallets that bought this outcome in the window. */
	walletCount: number;
	/** Total USD notional bought across those wallets. */
	usd: number;
	/** Most recent trade price for the outcome. */
	lastPrice: number;
	/** Seconds between the first and last buy — tiny span hints at one coordinated actor. */
	spanSec: number;
	/** % of the USD that came from the single biggest wallet (high = concentrated, not broad). */
	topWalletPct: number;
	/** True when participation is broad (not dominated by one wallet) — guards against wash/Sybil. */
	independent: boolean;
}

/** Structural subset of the prediction TradeJournal we depend on (keeps the module decoupled). */
export interface SmartMoneyJournalLike {
	append(entry: {
		type: "signal";
		timestamp: number;
		dateKey: string;
		marketId: string | null;
		question: string | null;
		side: string | null;
		value: number | null;
		context: string;
		summary: string | null;
	}): number;
}

type FetchFn = (input: string, init?: unknown) => Promise<{ json(): Promise<unknown> }>;

const TradeSchema = z
	.object({
		proxyWallet: z.string(),
		side: z.string().optional(),
		conditionId: z.string().optional(),
		outcome: z.string().optional(),
		outcomeIndex: z.coerce.number().optional(),
		price: z.coerce.number().optional(),
		size: z.coerce.number().optional(),
		title: z.string().optional(),
		timestamp: z.coerce.number().optional(),
	})
	.passthrough();

const CATEGORY_RE: Record<string, RegExp> = {
	sports:
		/\b(nba|nfl|nhl|mlb|soccer|premier|league|champions|game|match|super bowl|world cup|ufc|fight|o\/u|vs\.|lck|lol:|esports|set \d|inning|quarter|goals)\b/i,
	military:
		/\b(war|strike|missile|military|troops|invade|nuclear|ceasefire|iran|israel|ukraine|russia|gaza|hormuz|airstrike|attack|drone)\b/i,
	politics:
		/\b(election|president|senate|congress|nominee|vote|poll|trump|biden|harris|democrat|republican|governor|primary|impeach|cabinet|mayor)\b/i,
	crypto: /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|crypto|dogecoin|token|up or down|price of)\b/i,
	econ: /\b(fed|rate cut|interest rate|inflation|cpi|gdp|recession|unemployment|jobs report|tariff)\b/i,
};

/** Pure helper: classify a market title into a coarse category (exported for tests). */
export function categorizeMarket(title: string | undefined | null): string {
	const t = title ?? "";
	for (const key of Object.keys(CATEGORY_RE)) {
		if (CATEGORY_RE[key].test(t)) return key;
	}
	return "other";
}

const DEFAULTS = {
	enabled: false,
	minWallets: 4,
	minFillUsd: 250,
	pages: 4,
	pollIntervalMs: 900_000,
	excludeSports: true,
	maxTopWalletPct: 60,
	dataApiBaseUrl: "https://data-api.polymarket.com",
};

export class SmartMoneyConsensusWatcher {
	private readonly cfg: Required<SmartMoneyConsensusConfig>;
	private readonly journal: SmartMoneyJournalLike;
	private readonly fetchFn: FetchFn;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(deps: {
		journal: SmartMoneyJournalLike;
		config?: SmartMoneyConsensusConfig;
		fetchFn?: FetchFn;
	}) {
		this.journal = deps.journal;
		this.cfg = { ...DEFAULTS, ...(deps.config ?? {}) };
		this.fetchFn = deps.fetchFn ?? ((globalThis as { fetch?: FetchFn }).fetch as FetchFn);
	}

	get enabled(): boolean {
		return this.cfg.enabled === true;
	}

	/** Pull the firehose and compute consensus opportunities. Read-only. */
	async scan(): Promise<SmartMoneyOpportunity[]> {
		if (!this.fetchFn) return [];
		const base = this.cfg.dataApiBaseUrl.replace(/\/$/, "");
		const trades: z.infer<typeof TradeSchema>[] = [];
		for (let p = 0; p < this.cfg.pages; p++) {
			const url = `${base}/trades?limit=500&offset=${p * 500}&filterAmount=${this.cfg.minFillUsd}`;
			let batch: unknown;
			try {
				batch = await this.fetchFn(url).then((r) => r.json());
			} catch {
				break;
			}
			if (!Array.isArray(batch) || batch.length === 0) break;
			for (const raw of batch) {
				const parsed = TradeSchema.safeParse(raw);
				if (parsed.success) trades.push(parsed.data);
			}
			if (batch.length < 500) break;
		}

		const byOutcome = new Map<
			string,
			{
				title: string;
				outcome: string;
				category: string;
				wallets: Set<string>;
				walletUsd: Map<string, number>;
				usd: number;
				lastPrice: number;
				timestamps: number[];
			}
		>();
		for (const t of trades) {
			if (t.side !== "BUY" || !t.conditionId) continue;
			const category = categorizeMarket(t.title);
			if (this.cfg.excludeSports && category === "sports") continue;
			const key = `${t.conditionId}|${t.outcomeIndex ?? 0}`;
			const usd = (t.price ?? 0) * (t.size ?? 0);
			const entry =
				byOutcome.get(key) ??
				{
					title: t.title ?? "",
					outcome: t.outcome ?? "",
					category,
					wallets: new Set<string>(),
					walletUsd: new Map<string, number>(),
					usd: 0,
					lastPrice: t.price ?? 0,
					timestamps: [],
				};
			entry.wallets.add(t.proxyWallet);
			entry.walletUsd.set(t.proxyWallet, (entry.walletUsd.get(t.proxyWallet) ?? 0) + usd);
			entry.usd += usd;
			entry.lastPrice = t.price ?? entry.lastPrice;
			if (typeof t.timestamp === "number" && t.timestamp > 0) entry.timestamps.push(t.timestamp);
			byOutcome.set(key, entry);
		}

		return [...byOutcome.entries()]
			.map(([key, v]) => {
				const ts = v.timestamps.slice().sort((a, b) => a - b);
				const spanSec = ts.length >= 2 ? ts[ts.length - 1] - ts[0] : 0;
				const topWalletUsd = v.walletUsd.size ? Math.max(...v.walletUsd.values()) : 0;
				const topWalletPct = v.usd > 0 ? Math.round((topWalletUsd / v.usd) * 100) : 100;
				return {
					conditionId: key.split("|")[0],
					title: v.title,
					outcome: v.outcome,
					category: v.category,
					walletCount: v.wallets.size,
					usd: Math.round(v.usd),
					lastPrice: v.lastPrice,
					spanSec,
					topWalletPct,
					// broad participation, not dominated by one wallet → less likely wash/Sybil
					independent: topWalletPct <= this.cfg.maxTopWalletPct,
				};
			})
			.filter((o) => o.walletCount >= this.cfg.minWallets)
			.sort((a, b) => b.walletCount - a.walletCount || b.usd - a.usd);
	}

	/** Scan and record each consensus as a shadow "signal" journal entry. No execution. */
	async scanAndRecord(): Promise<{ recorded: number; opportunities: SmartMoneyOpportunity[] }> {
		const opportunities = await this.scan();
		const now = Date.now();
		const dateKey = new Date(now).toISOString().split("T")[0];
		for (const o of opportunities) {
			this.journal.append({
				type: "signal",
				timestamp: now,
				dateKey,
				marketId: o.conditionId,
				question: o.title,
				side: o.outcome,
				value: o.usd,
				context: JSON.stringify({ source: "smart-money-consensus", ...o }),
				summary: `${o.walletCount} wallets → ${o.outcome} ($${o.usd}) [${o.category}] @${o.lastPrice}${o.independent ? "" : ` ⚠concentrated ${o.topWalletPct}%`}`,
			});
		}
		return { recorded: opportunities.length, opportunities };
	}

	/** Begin periodic scanning (no-op unless enabled). Self-contained scheduling. */
	start(): void {
		if (!this.enabled || this.timer) return;
		// Best-effort initial + periodic smart-money scan: a single failed scan
		// (DB / market-data provider) must NOT throw out of start() or kill the
		// interval, but a persistently failing scan (nothing ever recorded) should
		// leave a trace instead of being silently invisible.
		void this.scanAndRecord().catch((err) => {
			console.debug(`[smart-money-consensus] initial scan failed (interval continues): ${err instanceof Error ? err.message : String(err)}`);
		});
		this.timer = setInterval(() => {
			void this.scanAndRecord().catch((err) => {
				console.debug(`[smart-money-consensus] periodic scan failed (will retry next interval): ${err instanceof Error ? err.message : String(err)}`);
			});
		}, this.cfg.pollIntervalMs);
		(this.timer as { unref?: () => void }).unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
