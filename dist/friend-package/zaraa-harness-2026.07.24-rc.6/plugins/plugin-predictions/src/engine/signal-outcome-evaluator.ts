/**
 * Signal outcome evaluator (READ-ONLY).
 *
 * Closes the learning loop: takes the shadow "signal" entries recorded in the
 * prediction journal (smart-money consensus, EV pipeline, etc.), looks up how each
 * market actually RESOLVED on gamma, and reports which signal *types* actually paid.
 *
 * The key metric is realized ROI vs 0: the entry price IS the market's implied
 * probability, so a no-edge signal averages ~0 ROI. Persistently positive average
 * ROI for a signal type = a real, measured edge (not a hypothesis). This is what
 * turns the scanners from guesses into something self-correcting.
 *
 * Resolution lookup: gamma `markets?condition_ids=<cid>&closed=true`. A closed market
 * carries `outcomePrices` where the winning outcome = "1". An open market is not
 * returned (→ pending, skipped).
 */

import { categorizeMarket } from "./smart-money-consensus.js";

export interface SignalOutcomeEvaluatorConfig {
	gammaBaseUrl?: string;
	/** Max concurrent resolution lookups. Default 5. */
	concurrency?: number;
}

export interface JournalEntryLite {
	type: string;
	timestamp: number;
	marketId: string | null;
	question: string | null;
	side: string | null;
	value: number | null;
	context: string;
}

export interface SignalJournalQueryLike {
	query(opts: { type?: string; limit?: number; since?: number }): JournalEntryLite[];
}

export interface MarketResolution {
	resolved: boolean;
	winningOutcome: string | null;
}

export type ResolveFn = (conditionId: string) => Promise<MarketResolution>;
type FetchFn = (input: string, init?: unknown) => Promise<{ json(): Promise<unknown> }>;

export interface ScoredSignal {
	conditionId: string;
	question: string;
	side: string;
	source: string;
	category: string;
	entryPrice: number;
	resolved: boolean;
	/** null while pending */
	won: boolean | null;
	/** ROI per $1 staked on the backed side: won → (1-p)/p, lost → -1, pending → null. */
	roi: number | null;
}

export interface OutcomeBucketStat {
	n: number;
	resolved: number;
	wins: number;
	winRate: number | null;
	avgRoi: number | null;
}

export interface OutcomeReport {
	total: number;
	resolved: number;
	pending: number;
	overall: OutcomeBucketStat;
	bySource: Record<string, OutcomeBucketStat>;
	byCategory: Record<string, OutcomeBucketStat>;
	byEntryBucket: Record<string, OutcomeBucketStat>;
	scored: ScoredSignal[];
}

const num = (x: unknown): number => {
	const n = typeof x === "string" ? Number.parseFloat(x) : typeof x === "number" ? x : NaN;
	return Number.isFinite(n) ? n : 0;
};
const parseArr = (s: unknown): unknown[] | null => {
	try {
		const v = typeof s === "string" ? JSON.parse(s) : s;
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
};
const safeJson = (s: string): Record<string, unknown> => {
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};
const entryBucket = (p: number): string =>
	p < 0.2 ? "longshot<.2" : p < 0.5 ? "underdog.2-.5" : p < 0.8 ? "leaning.5-.8" : "favorite.8-1";

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (next === undefined) return;
			await fn(next);
		}
	});
	await Promise.all(workers);
}

export class SignalOutcomeEvaluator {
	private readonly journal: SignalJournalQueryLike;
	private readonly fetchFn: FetchFn | undefined;
	private readonly resolveFn: ResolveFn | undefined;
	private readonly gammaBaseUrl: string;
	private readonly concurrency: number;

	constructor(deps: {
		journal: SignalJournalQueryLike;
		fetchFn?: FetchFn;
		/** Inject to bypass network (tests). */
		resolveFn?: ResolveFn;
		config?: SignalOutcomeEvaluatorConfig;
	}) {
		this.journal = deps.journal;
		this.fetchFn = deps.fetchFn ?? (globalThis as { fetch?: FetchFn }).fetch;
		this.resolveFn = deps.resolveFn;
		this.gammaBaseUrl = deps.config?.gammaBaseUrl ?? "https://gamma-api.polymarket.com";
		this.concurrency = deps.config?.concurrency ?? 5;
	}

	/** Look up whether a market has resolved and which outcome won. */
	async resolveMarket(conditionId: string): Promise<MarketResolution> {
		if (this.resolveFn) return this.resolveFn(conditionId);
		if (!this.fetchFn) return { resolved: false, winningOutcome: null };
		const base = this.gammaBaseUrl.replace(/\/$/, "");
		let arr: unknown;
		try {
			arr = await this.fetchFn(`${base}/markets?condition_ids=${conditionId}&closed=true`).then((r) =>
				r.json(),
			);
		} catch {
			return { resolved: false, winningOutcome: null };
		}
		if (!Array.isArray(arr) || arr.length === 0) return { resolved: false, winningOutcome: null };
		const m = arr[0] as { outcomes?: unknown; outcomePrices?: unknown; closed?: boolean };
		if (m.closed !== true) return { resolved: false, winningOutcome: null };
		const outcomes = parseArr(m.outcomes);
		const prices = parseArr(m.outcomePrices);
		if (!outcomes || !prices) return { resolved: false, winningOutcome: null };
		const winIdx = prices.findIndex((p) => num(p) >= 0.99);
		if (winIdx < 0) return { resolved: false, winningOutcome: null }; // disputed/ambiguous
		return { resolved: true, winningOutcome: String(outcomes[winIdx]) };
	}

	/** Score recorded shadow signals against actual resolutions and aggregate. */
	async evaluate(opts: { limit?: number; since?: number } = {}): Promise<OutcomeReport> {
		const entries = this.journal.query({ type: "signal", limit: opts.limit ?? 2000, since: opts.since });
		const parsed = entries
			.map((e) => {
				const ctx = safeJson(e.context);
				const cid = (e.marketId ?? (ctx.conditionId as string) ?? "").toString();
				const side = (e.side ?? (ctx.outcome as string) ?? "").toString().trim();
				const entryPrice = num(ctx.lastPrice ?? ctx.marketPrice ?? ctx.entryPrice ?? ctx.price);
				return {
					conditionId: cid,
					side,
					question: (e.question ?? (ctx.title as string) ?? "").toString(),
					source: (ctx.source as string) ?? "ev-pipeline",
					category: (ctx.category as string) ?? categorizeMarket((e.question ?? (ctx.title as string)) as string),
					entryPrice,
				};
			})
			.filter((s) => s.conditionId && s.side && s.entryPrice > 0 && s.entryPrice < 1);

		const uniqueCids = [...new Set(parsed.map((s) => s.conditionId))];
		const resMap = new Map<string, MarketResolution>();
		await pool(uniqueCids, this.concurrency, async (cid) => {
			resMap.set(cid, await this.resolveMarket(cid));
		});

		const sameOutcome = (a: string, b: string | null) =>
			b != null && a.toLowerCase() === b.toLowerCase();
		const scored: ScoredSignal[] = parsed.map((s) => {
			const r = resMap.get(s.conditionId) ?? { resolved: false, winningOutcome: null };
			const won = r.resolved ? sameOutcome(s.side, r.winningOutcome) : null;
			const roi = won === null ? null : won ? (1 - s.entryPrice) / s.entryPrice : -1;
			return { ...s, resolved: r.resolved, won, roi };
		});

		const stat = (rows: ScoredSignal[]): OutcomeBucketStat => {
			const res = rows.filter((r) => r.resolved);
			const wins = res.filter((r) => r.won).length;
			const rois = res.map((r) => r.roi as number);
			return {
				n: rows.length,
				resolved: res.length,
				wins,
				winRate: res.length ? +(wins / res.length).toFixed(3) : null,
				avgRoi: rois.length ? +(rois.reduce((a, b) => a + b, 0) / rois.length).toFixed(3) : null,
			};
		};
		const group = (keyFn: (s: ScoredSignal) => string): Record<string, OutcomeBucketStat> => {
			const out: Record<string, OutcomeBucketStat> = {};
			const keys = [...new Set(scored.map(keyFn))];
			for (const k of keys) out[k] = stat(scored.filter((s) => keyFn(s) === k));
			return out;
		};

		return {
			total: scored.length,
			resolved: scored.filter((s) => s.resolved).length,
			pending: scored.filter((s) => !s.resolved).length,
			overall: stat(scored),
			bySource: group((s) => s.source),
			byCategory: group((s) => s.category),
			byEntryBucket: group((s) => entryBucket(s.entryPrice)),
			scored,
		};
	}
}

/** Render an OutcomeReport as a compact text table. */
export function formatOutcomeReport(r: OutcomeReport): string {
	const line = (label: string, s: OutcomeBucketStat) =>
		`  ${label.padEnd(22)} n=${String(s.n).padStart(4)} resolved=${String(s.resolved).padStart(4)} winRate=${
			s.winRate == null ? "  n/a" : `${(s.winRate * 100).toFixed(0)}%`.padStart(5)
		} avgROI=${s.avgRoi == null ? "  n/a" : `${(s.avgRoi * 100).toFixed(1)}%`.padStart(7)}`;
	const block = (title: string, rec: Record<string, OutcomeBucketStat>) =>
		[`\n${title}:`, ...Object.entries(rec).map(([k, s]) => line(k, s))].join("\n");
	return [
		`=== Signal outcome report (${r.total} signals: ${r.resolved} resolved, ${r.pending} pending) ===`,
		line("OVERALL", r.overall),
		"  (avgROI ~0% = no edge / efficient; persistently >0% = a real measured edge)",
		block("by source", r.bySource),
		block("by category", r.byCategory),
		block("by entry-price bucket", r.byEntryBucket),
	].join("\n");
}
