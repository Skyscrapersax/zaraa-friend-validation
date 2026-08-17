/**
 * Opportunity Pack Scanner — single-pass, EV-led opportunity discovery for
 * Polymarket and Kalshi.
 */
import type { PredictionExchange, PredictionMarket } from "../types.js";

const DEFAULT_REQUESTED_COUNT = 500;
const DEFAULT_MAX_MARKETS_PER_EXCHANGE = 500;
const MAX_REQUESTED_COUNT = 5000;
const MAX_MARKETS_PER_EXCHANGE = 5000;
const EXCHANGES: readonly PredictionExchange[] = ["polymarket", "kalshi"];

const TWO_DECIMALS = 10_000;
const DAY_MS = 1000 * 60 * 60 * 24;

type Outcome = "YES" | "NO";
type Grade = "A" | "B" | "C";
type EvBasis = "scanner" | "model" | "manual";
type ExchangeStatus = "ok" | "unsupported";

interface Threshold {
	name: "strict" | "fallback_min_ev" | "fallback_min_liquidity" | "fallback_max_spread";
	minEV: number;
	minLiquidity: number;
	maxSpread: number;
}

const FALLBACK_TIERS: readonly Threshold[] = [
	{ name: "strict", minEV: 0.02, minLiquidity: 1000, maxSpread: 0.10 },
	{ name: "fallback_min_ev", minEV: 0.015, minLiquidity: 1000, maxSpread: 0.10 },
	{ name: "fallback_min_liquidity", minEV: 0.015, minLiquidity: 500, maxSpread: 0.10 },
	{ name: "fallback_max_spread", minEV: 0.015, minLiquidity: 500, maxSpread: 0.15 },
];

export interface ExchangeProbe {
	exchange: PredictionExchange;
	reachable: boolean;
	endpoint_ok: boolean;
	reason_if_blocked: string | null;
	exchange_status: ExchangeStatus;
	markets_seen: number;
}

export interface ExchangeSource {
	exchange: PredictionExchange;
	fetchMarkets: (opts?: { maxMarkets?: number }) => Promise<PredictionMarket[]>;
	sourceUrl: (market: PredictionMarket) => string;
}

export interface OpportunityRejection {
	exchange: PredictionExchange;
	market_id: string;
	market_title: string;
	outcome: Outcome;
	reason: string;
	value: number;
	criteria: string;
}

export interface OpportunityPackRow {
	exchange: PredictionExchange;
	market_id: string;
	market_title: string;
	outcome: Outcome;
	token_id?: string | null;
	entry_price: number;
	implied_prob: number;
	predicted_prob: number;
	expected_value: number;
	ev_basis: EvBasis;
	liquidity: number;
	volume_24h: number;
	spread: number;
	time_to_resolve: string;
	grade: Grade;
	source_url: string;
	notes: string;
}

export interface OpportunityPackSummary {
	status: "complete" | "partial" | "blocked";
	total_requested: number;
	total_returned: number;
	exchange_breakdown: Record<
		PredictionExchange,
		{
			reachable: boolean;
			endpoint_ok: boolean;
			reason_if_blocked: string | null;
			exchange_status: ExchangeStatus;
			markets_scanned: number;
			candidates_considered: number;
			opportunities_returned: number;
		}
	>;
}

export interface OpportunityPackResult {
	run_summary: OpportunityPackSummary;
	opportunities: OpportunityPackRow[];
	rejections: OpportunityRejection[];
	raw_results_json: {
		opportunities: OpportunityPackRow[];
		rejections: OpportunityRejection[];
	};
	top50_markdown_table: string;
	exchange_probes: ExchangeProbe[];
}

export interface OpportunityPackOptions {
	requested_count?: number;
	exchanges?: PredictionExchange[];
	max_markets_per_exchange?: number;
	includeManualModel?: boolean;
}

interface OpportunityPackConfig {
	sources: ExchangeSource[];
	predictionProvider: (market: PredictionMarket) => number;
	manualPredictionProvider?: (market: PredictionMarket) => number;
	now?: () => number;
}

interface InternalOpportunity {
	exchange: PredictionExchange;
	market_id: string;
	market_title: string;
	outcome: Outcome;
	token_id: string | null;
	entry_price: number;
	implied_prob: number;
	predicted_prob: number;
	expected_value: number;
	liquidity: number;
	volume_24h: number;
	spread: number;
	time_to_resolve: string;
	grade: Grade;
	source_url: string;
	edge: number;
	key: string;
	recencyMs: number;
	selectedTier?: Threshold["name"];
}

interface RejectionMeta {
	reason: string;
	criteria: string;
	value: number;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function round4(value: number): number {
	return Math.round(value * TWO_DECIMALS) / TWO_DECIMALS;
}

function safeDate(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function recencyMs(updatedAt: string | undefined, createdAt: string | undefined, nowMs: number): number {
	const updated = safeDate(updatedAt);
	const created = safeDate(createdAt);
	const base = updated ?? created;
	if (base == null) return Number.MAX_SAFE_INTEGER;
	return Math.max(0, nowMs - base);
}

function timeToResolve(expiresAt: string | undefined, nowMs: number): string {
	const expiry = safeDate(expiresAt);
	if (expiry == null) return "unresolved";
	const deltaMs = expiry - nowMs;
	if (deltaMs <= 0) return "resolved";
	const totalMinutes = Math.floor(deltaMs / (1000 * 60));
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	return `${hours}h`;
}

function computeSpread(market: PredictionMarket): number {
	return round4(Math.max(0, clamp01(market.yesAsk) - clamp01(market.yesBid)));
}

function grade(liquidity: number, spread: number, recencyMsValue: number): Grade {
	if (liquidity >= 5000 && spread <= 0.05 && recencyMsValue <= 7 * DAY_MS) return "A";
	if (liquidity >= 1000 && spread <= 0.10 && recencyMsValue <= 30 * DAY_MS) return "B";
	return "C";
}

function buildSourceSummary(): OpportunityPackSummary["exchange_breakdown"][PredictionExchange] {
	return {
		reachable: false,
		endpoint_ok: false,
		reason_if_blocked: null,
		exchange_status: "unsupported",
		markets_scanned: 0,
		candidates_considered: 0,
		opportunities_returned: 0,
	};
}

function computeExpectedValue(predictedProb: number, entryPrice: number, _outcome: Outcome): number {
	const p = clamp01(predictedProb);
	const price = clamp01(entryPrice);
	return round4(p * (1 - price) - (1 - p) * price);
}

function meetsThreshold(candidate: InternalOpportunity, tier: Threshold): RejectionMeta | null {
	if (candidate.expected_value <= 0) {
		return {
			reason: "expected_value_not_positive",
			criteria: "ev",
			value: candidate.expected_value,
		};
	}
	if (candidate.liquidity < tier.minLiquidity) {
		return {
			reason: "liquidity_too_low",
			criteria: "liquidity",
			value: candidate.liquidity,
		};
	}
	if (candidate.spread > tier.maxSpread) {
		return {
			reason: "spread_too_wide",
			criteria: "spread",
			value: candidate.spread,
		};
	}
	if (candidate.expected_value < tier.minEV) {
		return {
			reason: "ev_too_low",
			criteria: "ev",
			value: candidate.expected_value,
		};
	}
	return null;
}

function toMarkdownTable(opportunities: OpportunityPackRow[]): string {
	const top = opportunities.slice(0, 50);
	const rows = [
		"| Rank | Exchange | Market | Outcome | EV | Spread | Liquidity |",
		"| --- | --- | --- | --- | ---: | ---: | ---: |",
		...top.map((opp, index) => {
			const title = opp.market_title.replace(/\|/g, "\\|");
			return `| ${index + 1} | ${opp.exchange} | ${title} | ${opp.outcome} | ${opp.expected_value.toFixed(4)} | ${opp.spread.toFixed(4)} | ${opp.liquidity.toFixed(0)} |`;
		}),
	];
	return rows.join("\n");
}

function normalizeRequestedExchanges(requested?: PredictionExchange[]): PredictionExchange[] {
	if (!requested?.length) return [...EXCHANGES];
	const seen = new Set<PredictionExchange>();
	for (const exchange of requested) {
		if (exchange === "polymarket" || exchange === "kalshi") {
			seen.add(exchange);
		}
	}
	return EXCHANGES.filter((exchange) => seen.has(exchange));
}

/**
 * Build a ranked list of up to `requested_count` opportunities.
 * Discovery is single-pass with four in-flow fallback tiers.
 */
export class OpportunityPackScanner {
	private readonly sources: Map<PredictionExchange, ExchangeSource>;
	private readonly predictFn: (market: PredictionMarket) => number;
	private readonly manualPredictFn?: (market: PredictionMarket) => number;
	private readonly now: () => number;

	constructor(config: OpportunityPackConfig) {
		this.sources = new Map(config.sources.map((source) => [source.exchange, source]));
		this.predictFn = config.predictionProvider;
		this.manualPredictFn = config.manualPredictionProvider;
		this.now = config.now ?? (() => Date.now());
	}

	async generateOpportunityPack(options: OpportunityPackOptions = {}): Promise<OpportunityPackResult> {
		const requestedCount = Math.max(1, Math.min(MAX_REQUESTED_COUNT, options.requested_count ?? DEFAULT_REQUESTED_COUNT));
		const maxMarketsPerExchange = Math.max(1, Math.min(MAX_MARKETS_PER_EXCHANGE, options.max_markets_per_exchange ?? DEFAULT_MAX_MARKETS_PER_EXCHANGE));
		const nowMs = this.now();
		const requestedExchanges = normalizeRequestedExchanges(options.exchanges);
		const requestedSet = new Set(requestedExchanges);
		const useManualModel = Boolean(options.includeManualModel && this.manualPredictFn);
		const evBasis: EvBasis = useManualModel ? "manual" : "scanner";

		const exchangeBreakdown: OpportunityPackSummary["exchange_breakdown"] = {
			polymarket: buildSourceSummary(),
			kalshi: buildSourceSummary(),
		};
		const exchangeProbes = new Map<PredictionExchange, ExchangeProbe>(
			EXCHANGES.map((exchange) => [
				exchange,
				{
					exchange,
					reachable: false,
					endpoint_ok: false,
					reason_if_blocked: null,
					exchange_status: "unsupported",
					markets_seen: 0,
				},
			]),
		);

		const allCandidates: InternalOpportunity[] = [];
		const rejectionByKey = new Map<string, OpportunityRejection>();
		const selectedKeys = new Set<string>();

		for (const exchange of EXCHANGES) {
			const probe = exchangeProbes.get(exchange);
			if (!probe) continue;

			if (!requestedSet.has(exchange)) {
				probe.reachable = false;
				probe.endpoint_ok = false;
				probe.exchange_status = "unsupported";
				probe.reason_if_blocked = "exchange not requested";
				exchangeBreakdown[exchange].reason_if_blocked = "exchange not requested";
				continue;
			}

			const source = this.sources.get(exchange);
			if (!source) {
				probe.reason_if_blocked = `${exchange} source unavailable`;
				exchangeBreakdown[exchange].reason_if_blocked = `${exchange} source unavailable`;
				continue;
			}

			try {
				const markets = await source.fetchMarkets({ maxMarkets: maxMarketsPerExchange });
				exchangeBreakdown[exchange].reachable = true;
				exchangeBreakdown[exchange].endpoint_ok = true;
				exchangeBreakdown[exchange].exchange_status = "ok";
				exchangeBreakdown[exchange].markets_scanned = markets.length;
				probe.reachable = true;
				probe.endpoint_ok = true;
				probe.exchange_status = "ok";
				probe.markets_seen = markets.length;
				for (const market of markets) {
					const question = market.question ?? "";
					const marketId = market.id;
					const sourceUrl = source.sourceUrl(market);

					if (market.status !== "open") {
						for (const outcome of ["YES", "NO"] as const) {
							const key = `${exchange}:${marketId}:${outcome}`;
							rejectionByKey.set(key, {
								exchange,
								market_id: marketId,
								market_title: question,
								outcome,
								reason: "market_not_open",
								value: 0,
								criteria: "status",
							});
						}
						continue;
					}

					const yesPrice = clamp01(market.yesPrice);
					const noPrice = clamp01(market.noPrice);
					const spread = computeSpread(market);
					const liquidity = Math.max(0, market.liquidity);
					const volume24h = Math.max(0, market.volume24h);
					const baseRecency = recencyMs(market.updatedAt, market.createdAt, nowMs);
					const ttl = timeToResolve(market.expiresAt, nowMs);
					const predictor = useManualModel ? this.manualPredictFn! : this.predictFn;
					const marketPrediction = clamp01(predictor(market));

					for (const outcome of ["YES", "NO"] as const) {
						const isYes = outcome === "YES";
						const entryPrice = isYes ? yesPrice : noPrice;
						const tokenId = isYes ? market.outcomeTokenIds?.yes ?? null : market.outcomeTokenIds?.no ?? null;
						if (entryPrice <= 0 || entryPrice >= 1) {
							const key = `${exchange}:${marketId}:${outcome}`;
							rejectionByKey.set(key, {
								exchange,
								market_id: marketId,
								market_title: question,
								outcome,
								reason: "invalid_entry_price",
								value: entryPrice,
								criteria: "price",
							});
							continue;
						}

						const implied = isYes ? yesPrice : noPrice;
						const predicted = isYes ? marketPrediction : 1 - marketPrediction;
						const candidate: InternalOpportunity = {
							exchange,
							market_id: marketId,
							market_title: question,
							outcome,
							token_id: tokenId,
							entry_price: round4(entryPrice),
							implied_prob: round4(implied),
							predicted_prob: round4(predicted),
							expected_value: computeExpectedValue(predicted, entryPrice, outcome),
							liquidity,
							volume_24h: volume24h,
							spread,
							time_to_resolve: ttl,
							grade: grade(liquidity, spread, baseRecency),
							source_url: sourceUrl,
							edge: round4(predicted - implied),
							key: `${exchange}:${marketId}:${outcome}`,
							recencyMs: baseRecency,
						};
						allCandidates.push(candidate);
						exchangeBreakdown[exchange].candidates_considered += 1;
					}
				}
			} catch (err: unknown) {
				const reason = err instanceof Error ? err.message : "exchange fetch failed";
				probe.reachable = false;
				probe.endpoint_ok = false;
				probe.exchange_status = "unsupported";
				probe.reason_if_blocked = reason;
				exchangeBreakdown[exchange].exchange_status = "unsupported";
				exchangeBreakdown[exchange].reason_if_blocked = reason;
			}
		}

		allCandidates.sort((a, b) => {
			if (b.expected_value !== a.expected_value) return b.expected_value - a.expected_value;
			if (b.liquidity !== a.liquidity) return b.liquidity - a.liquidity;
			if (a.recencyMs !== b.recencyMs) return a.recencyMs - b.recencyMs;
			if (a.market_id !== b.market_id) return a.market_id.localeCompare(b.market_id);
			return a.outcome.localeCompare(b.outcome);
		});

		const selected: InternalOpportunity[] = [];

		for (const tier of FALLBACK_TIERS) {
			for (const candidate of allCandidates) {
				if (selected.length >= requestedCount) break;
				if (selectedKeys.has(candidate.key)) continue;

				const fail = meetsThreshold(candidate, tier);
				if (fail) {
					const key = `${candidate.exchange}:${candidate.market_id}:${candidate.outcome}`;
					if (!rejectionByKey.has(key)) {
						rejectionByKey.set(key, {
							exchange: candidate.exchange,
							market_id: candidate.market_id,
							market_title: candidate.market_title,
							outcome: candidate.outcome,
							reason: fail.reason,
							value: round4(fail.value),
							criteria: fail.criteria,
						});
					}
					continue;
				}

				candidate.selectedTier = tier.name;
				selectedKeys.add(candidate.key);
				selected.push(candidate);
				exchangeBreakdown[candidate.exchange].opportunities_returned += 1;
			}
		}

		if (selected.length < requestedCount) {
			for (const candidate of allCandidates) {
				const key = `${candidate.exchange}:${candidate.market_id}:${candidate.outcome}`;
				if (selectedKeys.has(key) || rejectionByKey.has(key)) continue;
				rejectionByKey.set(key, {
					exchange: candidate.exchange,
					market_id: candidate.market_id,
					market_title: candidate.market_title,
					outcome: candidate.outcome,
					reason: "outside_top_500_after_scoring",
					value: candidate.expected_value,
					criteria: "ranking",
				});
			}
		}

		const opportunities: OpportunityPackRow[] = selected.map((candidate) => ({
			exchange: candidate.exchange,
			market_id: candidate.market_id,
			market_title: candidate.market_title,
			outcome: candidate.outcome,
			token_id: candidate.token_id,
			entry_price: round4(candidate.entry_price),
			implied_prob: round4(candidate.implied_prob),
			predicted_prob: round4(candidate.predicted_prob),
			expected_value: round4(candidate.expected_value),
			ev_basis: evBasis,
			liquidity: round4(candidate.liquidity),
			volume_24h: round4(candidate.volume_24h),
			spread: round4(candidate.spread),
			time_to_resolve: candidate.time_to_resolve,
			grade: candidate.grade,
			source_url: candidate.source_url,
			notes: `selected_tier=${candidate.selectedTier ?? "strict"}${candidate.selectedTier === "strict" ? "" : "; fallback_source"}`,
		}));

		const selectedExchanges = new Set(opportunities.map((opp) => opp.exchange));
		const summaryStatus: OpportunityPackSummary["status"] = opportunities.length >= requestedCount
			? "complete"
			: selectedExchanges.size > 0
				? "partial"
				: "blocked";

		const rejectionRows = Array.from(rejectionByKey.values())
			.filter((candidate) => {
				const key = `${candidate.exchange}:${candidate.market_id}:${candidate.outcome}`;
				return !selectedKeys.has(key);
			})
			.sort((a, b) => {
				if (a.exchange !== b.exchange) return a.exchange.localeCompare(b.exchange);
				if (a.market_id !== b.market_id) return a.market_id.localeCompare(b.market_id);
				return a.outcome.localeCompare(b.outcome);
			});

		return {
			run_summary: {
				status: summaryStatus,
				total_requested: requestedCount,
				total_returned: opportunities.length,
				exchange_breakdown: exchangeBreakdown,
			},
			opportunities,
			rejections: rejectionRows,
			raw_results_json: {
				opportunities,
				rejections: rejectionRows,
			},
			top50_markdown_table: toMarkdownTable(opportunities),
			exchange_probes: EXCHANGES.map((exchange) => exchangeProbes.get(exchange)).filter(
				(value): value is ExchangeProbe => Boolean(value),
			),
		};
	}
}
