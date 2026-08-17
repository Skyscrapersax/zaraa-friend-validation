/**
 * Cross-venue mispricing matcher for Kalshi and Polymarket.
 *
 * This module is intentionally pure and paper-only. It identifies matched YES
 * markets with enough quoted edge after a conservative fee/slippage buffer, but
 * never places orders or suggests live execution.
 */
import type { PredictionExchange, PredictionMarket } from "../types.js";
import { simulateCrossVenuePaperFills, summarizePaperFills } from "./cross-venue-paper-fill.js";

const DEFAULT_MIN_NET_EDGE = 0.03;
const DEFAULT_FEE_AND_SLIPPAGE_BUFFER = 0.02;
const DEFAULT_MIN_LIQUIDITY = 500;
const DEFAULT_MAX_EXPIRY_DELTA_MS = 36 * 60 * 60 * 1000;
const DEFAULT_MAX_STALENESS_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MIN_PAIR_SIMILARITY = 0.72;
const DEFAULT_EDGE_SENSITIVITY_THRESHOLDS = [0, 0.005, 0.01, 0.02];
const PAIRING_STOPWORDS = new Set([
	"a",
	"above",
	"after",
	"an",
	"and",
	"are",
	"at",
	"be",
	"before",
	"below",
	"by",
	"contract",
	"day",
	"dollar",
	"dollars",
	"end",
	"exceed",
	"exceeding",
	"exceeds",
	"for",
	"in",
	"is",
	"market",
	"party",
	"no",
	"of",
	"on",
	"over",
	"price",
	"reach",
	"reaches",
	"reaching",
	"settle",
	"settles",
	"the",
	"to",
	"trade",
	"trades",
	"trading",
	"under",
	"usd",
	"win",
	"will",
	"with",
	"year",
	"yes",
]);
const TOKEN_ALIASES = new Map([
	["btc", "bitcoin"],
	["xbt", "bitcoin"],
	["eth", "ethereum"],
	["nominee", "nomination"],
	["presidency", "presidential"],
	["jan", "january"],
	["feb", "february"],
	["mar", "march"],
	["apr", "april"],
	["jun", "june"],
	["jul", "july"],
	["aug", "august"],
	["sep", "september"],
	["sept", "september"],
	["oct", "october"],
	["nov", "november"],
	["dec", "december"],
]);

type SupportedExchange = Extract<PredictionExchange, "polymarket" | "kalshi">;
export type CrossVenuePairingMethod = "exact_question" | "fuzzy_tokens";
export type CrossVenueFilterReason =
	| "status_not_open"
	| "non_actionable_price"
	| "crossed_book"
	| "low_liquidity"
	| "stale_or_invalid_update_time"
	| "short_normalized_question";

export interface CrossVenueMispricingOptions {
	minNetEdge?: number;
	feeAndSlippageBuffer?: number;
	minLiquidity?: number;
	maxExpiryDeltaMs?: number;
	maxStalenessMs?: number;
	minPairSimilarity?: number;
	nowMs?: number;
	maxResults?: number;
}

export interface CrossVenueEdgeSensitivityOptions extends CrossVenueMispricingOptions {
	edgeThresholds?: number[];
	paperCapUsd?: number;
}

export interface CrossVenueEdgeSensitivityRow {
	minNetEdge: number;
	candidateCount: number;
	paperFillCount: number;
	cumulativePnlUsd: number;
	bestNetEdge: number | null;
	bestCandidate: CrossVenueEdgeSensitivityBestCandidate | null;
}

export interface CrossVenueEdgeSensitivityBestCandidate {
	pairKey: string;
	question: string;
	netEdge: number;
	grossEdge: number;
	buyExchange: SupportedExchange;
	buyMarketId: string;
	buyPrice: number;
	sellExchange: SupportedExchange;
	sellMarketId: string;
	sellPrice: number;
	pairingMethod: CrossVenuePairingMethod;
	pairSimilarity: number;
}

export interface CrossVenueLeg {
	exchange: SupportedExchange;
	marketId: string;
	question: string;
	yesBid: number;
	yesAsk: number;
	liquidity: number;
	expiresAt: string;
	updatedAt: string;
}

export interface CrossVenueMispricingCandidate {
	pairKey: string;
	normalizedQuestion: string;
	question: string;
	buy: CrossVenueLeg;
	sell: CrossVenueLeg;
	grossEdge: number;
	feeAndSlippageBuffer: number;
	netEdge: number;
	liquidityFloor: number;
	expiryDeltaMs: number;
	pairingMethod: CrossVenuePairingMethod;
	pairSimilarity: number;
	paperOnly: true;
	warning: string;
	reason: string;
}

export interface CrossVenueNearMissCandidate extends CrossVenueMispricingCandidate {
	rejectionReasons: string[];
	thresholdDeltas: Record<string, number>;
}

export interface CrossVenuePairDiagnostics {
	marketsSeen: Record<SupportedExchange, number>;
	actionableMarkets: Record<SupportedExchange, number>;
	filteredMarkets: Record<SupportedExchange, number>;
	filterReasonCounts: Record<SupportedExchange, Partial<Record<CrossVenueFilterReason, number>>>;
	seenCategoryCounts: Record<SupportedExchange, Record<string, number>>;
	actionableCategoryCounts: Record<SupportedExchange, Record<string, number>>;
	pairKeys: {
		polymarket: number;
		kalshi: number;
		matched: number;
		softMatched: number;
	};
	matchedPairKeys: string[];
	softMatchedPairKeys: string[];
	unmatchedPolymarketPairKeys: string[];
	unmatchedKalshiPairKeys: string[];
	rejectedFuzzyPairs: CrossVenueRejectedPairDiagnostics[];
	sampleQuestions: {
		unmatchedPolymarket: string[];
		unmatchedKalshi: string[];
	};
}

export interface CrossVenueRejectedPairDiagnostics {
	polymarketKey: string;
	kalshiKey: string;
	similarity: number;
	minPairSimilarity: number;
	numericAnchorsCompatible: boolean;
	rejectionReasons: string[];
	thresholdDeltas: Record<string, number>;
	sharedTokens: string[];
	polymarketOnlyTokens: string[];
	kalshiOnlyTokens: string[];
}

export interface CrossVenueComparableSelectionOptions {
	maxResults?: number;
}

interface ResolvedOptions {
	minNetEdge: number;
	feeAndSlippageBuffer: number;
	minLiquidity: number;
	maxExpiryDeltaMs: number;
	maxStalenessMs: number;
	minPairSimilarity: number;
	nowMs: number;
	maxResults: number;
}

interface CrossVenueMarketPair {
	normalizedQuestion: string;
	polymarket: PredictionMarket;
	kalshi: PredictionMarket;
	pairingMethod: CrossVenuePairingMethod;
	pairSimilarity: number;
}

export function normalizeMarketQuestion(question: string): string {
	return question
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/(\d),(?=\d)/g, "$1")
		.replace(/\bdwayne\W+the\W+rock\W+johnson\b/g, "dwayne johnson")
		.replace(/\bhilary\s+clinton\b/g, "hillary clinton")
		.replace(/\bgop\b/g, "republican")
		.replace(/\bdem\b/g, "democratic")
		.replace(/\bdems\b/g, "democrats")
		.replace(/\bus president\b/g, "president")
		.replace(/\bu\.s\.\b/g, "us")
		.replace(/\busa\b/g, "us")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function findCrossVenueMispricings(
	markets: PredictionMarket[],
	options: CrossVenueMispricingOptions = {},
): CrossVenueMispricingCandidate[] {
	const resolved = resolveOptions(options);
	const candidates: CrossVenueMispricingCandidate[] = [];

	for (const pair of buildCrossVenueMarketPairs(markets, resolved)) {
		const candidate = evaluatePair(pair, resolved);
		if (candidate) candidates.push(candidate);
	}

	return candidates
		.sort((a, b) => b.netEdge - a.netEdge || b.liquidityFloor - a.liquidityFloor)
		.slice(0, resolved.maxResults);
}

export function findCrossVenueNearMisses(
	markets: PredictionMarket[],
	options: CrossVenueMispricingOptions = {},
): CrossVenueNearMissCandidate[] {
	const resolved = resolveOptions(options);
	const nearMisses: CrossVenueNearMissCandidate[] = [];

	for (const pair of buildCrossVenueMarketPairs(markets, resolved)) {
		const nearMiss = evaluateNearMissPair(pair, resolved);
		if (nearMiss) nearMisses.push(nearMiss);
	}

	return nearMisses
		.sort((a, b) => b.netEdge - a.netEdge || b.liquidityFloor - a.liquidityFloor)
		.slice(0, resolved.maxResults);
}

export function summarizeCrossVenueEdgeSensitivity(
	markets: PredictionMarket[],
	options: CrossVenueEdgeSensitivityOptions = {},
): CrossVenueEdgeSensitivityRow[] {
	const { edgeThresholds, paperCapUsd, ...baseOptions } = options;
	return resolveEdgeThresholds(edgeThresholds, baseOptions.minNetEdge).map((minNetEdge) => {
		const candidates = findCrossVenueMispricings(markets, {
			...baseOptions,
			minNetEdge,
		});
		const fills = simulateCrossVenuePaperFills(candidates, {
			nowMs: baseOptions.nowMs,
			paperCapUsd,
		});
		const fillSummary = summarizePaperFills(fills);
		return {
			minNetEdge,
			candidateCount: candidates.length,
			paperFillCount: fills.length,
			cumulativePnlUsd: fillSummary.cumulativePnlUsd,
			bestNetEdge: candidates[0]?.netEdge ?? null,
			bestCandidate: candidates[0] ? toEdgeSensitivityBestCandidate(candidates[0]) : null,
		};
	});
}

export function diagnoseCrossVenuePairing(
	markets: PredictionMarket[],
	options: CrossVenueMispricingOptions = {},
): CrossVenuePairDiagnostics {
	const resolved = resolveOptions(options);
	const marketsSeen = emptyExchangeCounts();
	const actionableMarkets = emptyExchangeCounts();
	const filterReasonCounts = emptyFilterReasonCounts();
	const seenCategoryCounts = emptyCategoryCounts();
	const actionableCategoryCounts = emptyCategoryCounts();
	const grouped = {
		polymarket: new Map<string, PredictionMarket[]>(),
		kalshi: new Map<string, PredictionMarket[]>(),
	};

	for (const market of markets) {
		if (market.exchange !== "polymarket" && market.exchange !== "kalshi") continue;
		marketsSeen[market.exchange]++;
		addCategoryCount(seenCategoryCounts[market.exchange], market.category);

		const rejectionReasons = marketSupportRejectionReasons(market, resolved);
		if (rejectionReasons.length > 0) {
			addFilterReasons(filterReasonCounts[market.exchange], rejectionReasons);
			continue;
		}

		const normalizedQuestion = normalizeMarketQuestion(market.question);
		if (normalizedQuestion.length < 20) {
			addFilterReasons(filterReasonCounts[market.exchange], ["short_normalized_question"]);
			continue;
		}

		actionableMarkets[market.exchange]++;
		addCategoryCount(actionableCategoryCounts[market.exchange], market.category);
		const marketGroup = grouped[market.exchange].get(normalizedQuestion);
		if (marketGroup) marketGroup.push(market);
		else grouped[market.exchange].set(normalizedQuestion, [market]);
	}

	const polymarketKeys = [...grouped.polymarket.keys()].sort();
	const kalshiKeys = [...grouped.kalshi.keys()].sort();
	const kalshiKeySet = new Set(kalshiKeys);
	const polymarketKeySet = new Set(polymarketKeys);
	const matchedPairKeys = polymarketKeys.filter((key) => kalshiKeySet.has(key));
	const fuzzyPairDiagnostics = fuzzyPairKeyDiagnostics(
		grouped.polymarket,
		grouped.kalshi,
		resolved,
	);
	const softMatchedPairKeys = fuzzyPairDiagnostics
		.filter((diagnostic) => diagnostic.rejectionReasons.length === 0)
		.map((match) => `${match.polymarketKey} ~= ${match.kalshiKey}`);
	const unmatchedPolymarketPairKeys = polymarketKeys.filter((key) => !kalshiKeySet.has(key));
	const unmatchedKalshiPairKeys = kalshiKeys.filter((key) => !polymarketKeySet.has(key));
	const sampleLimit = Math.max(1, resolved.maxResults);

	return {
		marketsSeen,
		actionableMarkets,
		filteredMarkets: {
			polymarket: marketsSeen.polymarket - actionableMarkets.polymarket,
			kalshi: marketsSeen.kalshi - actionableMarkets.kalshi,
		},
		filterReasonCounts,
		seenCategoryCounts,
		actionableCategoryCounts,
		pairKeys: {
			polymarket: polymarketKeys.length,
			kalshi: kalshiKeys.length,
			matched: matchedPairKeys.length,
			softMatched: softMatchedPairKeys.length,
		},
		matchedPairKeys: matchedPairKeys.slice(0, sampleLimit),
		softMatchedPairKeys: softMatchedPairKeys.slice(0, sampleLimit),
		unmatchedPolymarketPairKeys: unmatchedPolymarketPairKeys.slice(0, sampleLimit),
		unmatchedKalshiPairKeys: unmatchedKalshiPairKeys.slice(0, sampleLimit),
		rejectedFuzzyPairs: fuzzyPairDiagnostics
			.filter((diagnostic) => diagnostic.rejectionReasons.length > 0)
			.slice(0, sampleLimit),
		sampleQuestions: {
			unmatchedPolymarket: sampleQuestions(
				grouped.polymarket,
				unmatchedPolymarketPairKeys,
				sampleLimit,
			),
			unmatchedKalshi: sampleQuestions(grouped.kalshi, unmatchedKalshiPairKeys, sampleLimit),
		},
	};
}

export function selectComparableCrossVenueMarkets(
	referenceMarkets: PredictionMarket[],
	candidateMarkets: PredictionMarket[],
	options: CrossVenueComparableSelectionOptions = {},
): PredictionMarket[] {
	const maxResults = Math.max(1, options.maxResults ?? candidateMarkets.length);
	const referenceCategories = new Set(
		referenceMarkets.map((market) => normalizeCategory(market.category)),
	);
	const referenceQuestions = referenceMarkets.map((market) =>
		normalizeMarketQuestion(market.question),
	);

	return [...candidateMarkets]
		.map((market) => ({
			market,
			score: comparableMarketScore(market, referenceCategories, referenceQuestions),
		}))
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.market.liquidity - a.market.liquidity ||
				a.market.id.localeCompare(b.market.id),
		)
		.slice(0, maxResults)
		.map(({ market }) => market);
}

function resolveOptions(options: CrossVenueMispricingOptions): ResolvedOptions {
	return {
		minNetEdge: options.minNetEdge ?? DEFAULT_MIN_NET_EDGE,
		feeAndSlippageBuffer: options.feeAndSlippageBuffer ?? DEFAULT_FEE_AND_SLIPPAGE_BUFFER,
		minLiquidity: options.minLiquidity ?? DEFAULT_MIN_LIQUIDITY,
		maxExpiryDeltaMs: options.maxExpiryDeltaMs ?? DEFAULT_MAX_EXPIRY_DELTA_MS,
		maxStalenessMs: options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS,
		minPairSimilarity: options.minPairSimilarity ?? DEFAULT_MIN_PAIR_SIMILARITY,
		nowMs: options.nowMs ?? Date.now(),
		maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
	};
}

function resolveEdgeThresholds(
	thresholds: number[] | undefined,
	currentMinNetEdge: number | undefined,
): number[] {
	const values = thresholds ?? [
		...DEFAULT_EDGE_SENSITIVITY_THRESHOLDS,
		currentMinNetEdge ?? DEFAULT_MIN_NET_EDGE,
	];
	return [
		...new Set(values.filter((value) => Number.isFinite(value) && value >= 0).map(roundEdge)),
	].sort((a, b) => a - b);
}

function emptyExchangeCounts(): Record<SupportedExchange, number> {
	return {
		polymarket: 0,
		kalshi: 0,
	};
}

function emptyFilterReasonCounts(): Record<
	SupportedExchange,
	Partial<Record<CrossVenueFilterReason, number>>
> {
	return {
		polymarket: {},
		kalshi: {},
	};
}

function normalizeCategory(category: string): string {
	return category.toLowerCase().trim() || "default";
}

function comparableMarketScore(
	market: PredictionMarket,
	referenceCategories: Set<string>,
	referenceQuestions: string[],
): number {
	const categoryScore = referenceCategories.has(normalizeCategory(market.category)) ? 2 : 0;
	const normalizedQuestion = normalizeMarketQuestion(market.question);
	const similarityScore =
		referenceQuestions.reduce(
			(best, question) => Math.max(best, tokenJaccardSimilarity(question, normalizedQuestion)),
			0,
		) * 3;
	const liquidityScore = Math.min(1, Math.log10(Math.max(1, market.liquidity)) / 6);
	return categoryScore + similarityScore + liquidityScore;
}

function emptyCategoryCounts(): Record<SupportedExchange, Record<string, number>> {
	return {
		polymarket: {},
		kalshi: {},
	};
}

function addCategoryCount(counts: Record<string, number>, category: string): void {
	const normalizedCategory = category.toLowerCase().trim() || "unknown";
	counts[normalizedCategory] = (counts[normalizedCategory] ?? 0) + 1;
}

function addFilterReasons(
	counts: Partial<Record<CrossVenueFilterReason, number>>,
	reasons: CrossVenueFilterReason[],
): void {
	for (const reason of reasons) {
		counts[reason] = (counts[reason] ?? 0) + 1;
	}
}

function sampleQuestions(
	grouped: Map<string, PredictionMarket[]>,
	keys: string[],
	limit: number,
): string[] {
	return keys
		.slice(0, limit)
		.map((key) => grouped.get(key)?.[0]?.question)
		.filter((question): question is string => Boolean(question));
}

function buildActionableGroupsByExchange(
	markets: PredictionMarket[],
	options: ResolvedOptions,
): Record<SupportedExchange, Map<string, PredictionMarket[]>> {
	const grouped = {
		polymarket: new Map<string, PredictionMarket[]>(),
		kalshi: new Map<string, PredictionMarket[]>(),
	};

	for (const market of markets) {
		if (!isSupportedMarket(market, options)) continue;

		const normalizedQuestion = normalizeMarketQuestion(market.question);
		if (normalizedQuestion.length < 20) continue;

		const exchange = market.exchange as SupportedExchange;
		const existing = grouped[exchange].get(normalizedQuestion);
		if (existing) existing.push(market);
		else grouped[exchange].set(normalizedQuestion, [market]);
	}

	return grouped;
}

function buildCrossVenueMarketPairs(
	markets: PredictionMarket[],
	options: ResolvedOptions,
): CrossVenueMarketPair[] {
	const grouped = buildActionableGroupsByExchange(markets, options);
	const pairs: CrossVenueMarketPair[] = [];

	for (const [normalizedQuestion, polymarketMarkets] of grouped.polymarket.entries()) {
		const kalshiMarkets = grouped.kalshi.get(normalizedQuestion) ?? [];
		for (const polymarket of polymarketMarkets) {
			for (const kalshi of kalshiMarkets) {
				pairs.push({
					normalizedQuestion,
					polymarket,
					kalshi,
					pairingMethod: "exact_question",
					pairSimilarity: 1,
				});
			}
		}
	}

	for (const match of fuzzyPairKeyMatches(grouped.polymarket, grouped.kalshi, options)) {
		const polymarketMarkets = grouped.polymarket.get(match.polymarketKey) ?? [];
		const kalshiMarkets = grouped.kalshi.get(match.kalshiKey) ?? [];
		for (const polymarket of polymarketMarkets) {
			for (const kalshi of kalshiMarkets) {
				pairs.push({
					normalizedQuestion: `${match.polymarketKey} ~= ${match.kalshiKey}`,
					polymarket,
					kalshi,
					pairingMethod: "fuzzy_tokens",
					pairSimilarity: match.similarity,
				});
			}
		}
	}

	return pairs;
}

function fuzzyPairKeyMatches(
	polymarket: Map<string, PredictionMarket[]>,
	kalshi: Map<string, PredictionMarket[]>,
	options: ResolvedOptions,
): Array<{ polymarketKey: string; kalshiKey: string; similarity: number }> {
	return fuzzyPairKeyDiagnostics(polymarket, kalshi, options)
		.filter((diagnostic) => diagnostic.rejectionReasons.length === 0)
		.map(({ kalshiKey, polymarketKey, similarity }) => ({ kalshiKey, polymarketKey, similarity }));
}

function fuzzyPairKeyDiagnostics(
	polymarket: Map<string, PredictionMarket[]>,
	kalshi: Map<string, PredictionMarket[]>,
	options: ResolvedOptions,
): CrossVenueRejectedPairDiagnostics[] {
	const diagnostics: CrossVenueRejectedPairDiagnostics[] = [];

	for (const polymarketKey of polymarket.keys()) {
		for (const kalshiKey of kalshi.keys()) {
			if (polymarketKey === kalshiKey) continue;
			const tokenDiagnostics = comparePairTokens(polymarketKey, kalshiKey);
			const anchorsCompatible = numericAnchorsCompatible(polymarketKey, kalshiKey);
			const rejectionReasons = [];
			if (!anchorsCompatible) rejectionReasons.push("numeric_anchor_mismatch");
			if (tokenDiagnostics.similarity < options.minPairSimilarity) {
				rejectionReasons.push("similarity_below_min");
			}
			diagnostics.push({
				polymarketKey,
				kalshiKey,
				similarity: roundEdge(tokenDiagnostics.similarity),
				minPairSimilarity: options.minPairSimilarity,
				numericAnchorsCompatible: anchorsCompatible,
				rejectionReasons,
				thresholdDeltas: {
					minPairSimilarity: roundEdge(tokenDiagnostics.similarity - options.minPairSimilarity),
				},
				sharedTokens: tokenDiagnostics.sharedTokens,
				polymarketOnlyTokens: tokenDiagnostics.leftOnlyTokens,
				kalshiOnlyTokens: tokenDiagnostics.rightOnlyTokens,
			});
		}
	}

	return diagnostics.sort(
		(a, b) =>
			b.similarity - a.similarity ||
			a.polymarketKey.localeCompare(b.polymarketKey) ||
			a.kalshiKey.localeCompare(b.kalshiKey),
	);
}

function tokenJaccardSimilarity(left: string, right: string): number {
	return comparePairTokens(left, right).similarity;
}

function comparePairTokens(
	left: string,
	right: string,
): {
	similarity: number;
	sharedTokens: string[];
	leftOnlyTokens: string[];
	rightOnlyTokens: string[];
} {
	const leftTokens = comparableTokenSet(left);
	const rightTokens = comparableTokenSet(right);
	const sharedTokens = [];
	const leftOnlyTokens = [];
	const rightOnlyTokens = [];
	for (const token of leftTokens) {
		if (rightTokens.has(token)) sharedTokens.push(token);
		else leftOnlyTokens.push(token);
	}
	for (const token of rightTokens) {
		if (!leftTokens.has(token)) rightOnlyTokens.push(token);
	}
	const union = leftTokens.size + rightTokens.size - sharedTokens.length;
	return {
		similarity: union > 0 ? sharedTokens.length / union : 0,
		sharedTokens: sharedTokens.sort(),
		leftOnlyTokens: leftOnlyTokens.sort(),
		rightOnlyTokens: rightOnlyTokens.sort(),
	};
}

function comparableTokenSet(value: string): Set<string> {
	return new Set(
		value
			.split(/\s+/)
			.map((token) => TOKEN_ALIASES.get(token) ?? token)
			.filter((token) => token.length > 1)
			.filter((token) => !PAIRING_STOPWORDS.has(token)),
	);
}

function numericAnchorsCompatible(left: string, right: string): boolean {
	const leftNumbers = numericTokens(left);
	const rightNumbers = numericTokens(right);
	if (leftNumbers.length === 0 && rightNumbers.length === 0) return true;
	const leftCoreNumbers = leftNumbers.filter((token) => !isYearToken(token));
	const rightCoreNumbers = rightNumbers.filter((token) => !isYearToken(token));
	if (!sameTokenList(leftCoreNumbers, rightCoreNumbers)) return false;
	const leftYears = leftNumbers.filter(isYearToken);
	const rightYears = rightNumbers.filter(isYearToken);
	if (leftYears.length > 0 && rightYears.length > 0) return sameTokenList(leftYears, rightYears);
	return true;
}

function numericTokens(value: string): string[] {
	return [...comparableTokenSet(value)]
		.filter((token) => /^\d+$/.test(token))
		.sort((a, b) => a.localeCompare(b));
}

function isYearToken(token: string): boolean {
	const value = Number(token);
	return Number.isInteger(value) && value >= 2000 && value <= 2100;
}

function sameTokenList(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((token, index) => token === right[index]);
}

function isSupportedMarket(market: PredictionMarket, options: ResolvedOptions): boolean {
	return marketSupportRejectionReasons(market, options).length === 0;
}

function marketSupportRejectionReasons(
	market: PredictionMarket,
	options: ResolvedOptions,
): CrossVenueFilterReason[] {
	const reasons: CrossVenueFilterReason[] = [];
	if (market.status !== "open") reasons.push("status_not_open");
	if (!isActionablePrice(market.yesBid) || !isActionablePrice(market.yesAsk)) {
		reasons.push("non_actionable_price");
	}
	if (market.yesBid > market.yesAsk) reasons.push("crossed_book");
	if (market.liquidity < options.minLiquidity) reasons.push("low_liquidity");
	if (!isFresh(market, options)) reasons.push("stale_or_invalid_update_time");
	return reasons;
}

function evaluatePair(
	pair: CrossVenueMarketPair,
	options: ResolvedOptions,
): CrossVenueMispricingCandidate | null {
	const { kalshi, polymarket } = pair;
	const expiryDeltaMs = Math.abs(parseTime(polymarket.expiresAt) - parseTime(kalshi.expiresAt));
	if (!Number.isFinite(expiryDeltaMs) || expiryDeltaMs > options.maxExpiryDeltaMs) return null;

	const polymarketToKalshi = buildCandidate(pair, polymarket, kalshi, expiryDeltaMs, options);
	const kalshiToPolymarket = buildCandidate(pair, kalshi, polymarket, expiryDeltaMs, options);

	if (!polymarketToKalshi) return kalshiToPolymarket;
	if (!kalshiToPolymarket) return polymarketToKalshi;
	return polymarketToKalshi.netEdge >= kalshiToPolymarket.netEdge
		? polymarketToKalshi
		: kalshiToPolymarket;
}

function evaluateNearMissPair(
	pair: CrossVenueMarketPair,
	options: ResolvedOptions,
): CrossVenueNearMissCandidate | null {
	const { kalshi, polymarket } = pair;
	const expiryDeltaMs = Math.abs(parseTime(polymarket.expiresAt) - parseTime(kalshi.expiresAt));
	if (!Number.isFinite(expiryDeltaMs) || expiryDeltaMs > options.maxExpiryDeltaMs) return null;

	const candidates = [
		buildNearMissCandidate(pair, polymarket, kalshi, expiryDeltaMs, options),
		buildNearMissCandidate(pair, kalshi, polymarket, expiryDeltaMs, options),
	].filter((candidate): candidate is CrossVenueNearMissCandidate => Boolean(candidate));

	if (candidates.length === 0) return null;
	return candidates.sort((a, b) => b.netEdge - a.netEdge || b.liquidityFloor - a.liquidityFloor)[0];
}

function buildCandidate(
	pair: CrossVenueMarketPair,
	buyMarket: PredictionMarket,
	sellMarket: PredictionMarket,
	expiryDeltaMs: number,
	options: ResolvedOptions,
): CrossVenueMispricingCandidate | null {
	const candidate = buildBaseCandidate(pair, buyMarket, sellMarket, expiryDeltaMs, options);
	if (candidate.netEdge < options.minNetEdge) return null;
	return candidate;
}

function buildNearMissCandidate(
	pair: CrossVenueMarketPair,
	buyMarket: PredictionMarket,
	sellMarket: PredictionMarket,
	expiryDeltaMs: number,
	options: ResolvedOptions,
): CrossVenueNearMissCandidate | null {
	const candidate = buildBaseCandidate(pair, buyMarket, sellMarket, expiryDeltaMs, options);
	if (candidate.netEdge >= options.minNetEdge) return null;
	return {
		...candidate,
		rejectionReasons: ["net_edge_below_min"],
		thresholdDeltas: {
			minNetEdge: roundEdge(candidate.netEdge - options.minNetEdge),
		},
	};
}

function buildBaseCandidate(
	pair: CrossVenueMarketPair,
	buyMarket: PredictionMarket,
	sellMarket: PredictionMarket,
	expiryDeltaMs: number,
	options: ResolvedOptions,
): CrossVenueMispricingCandidate {
	const { normalizedQuestion } = pair;
	const grossEdge = roundEdge(sellMarket.yesBid - buyMarket.yesAsk);
	const netEdge = roundEdge(grossEdge - options.feeAndSlippageBuffer);
	const liquidityFloor = Math.min(buyMarket.liquidity, sellMarket.liquidity);

	const buy = toLeg(buyMarket);
	const sell = toLeg(sellMarket);
	const pairKey = `${normalizedQuestion}:${buy.exchange}:${buy.marketId}:${sell.exchange}:${sell.marketId}`;

	return {
		pairKey,
		normalizedQuestion,
		question: buyMarket.question,
		buy,
		sell,
		grossEdge,
		feeAndSlippageBuffer: options.feeAndSlippageBuffer,
		netEdge,
		liquidityFloor,
		expiryDeltaMs,
		pairingMethod: pair.pairingMethod,
		pairSimilarity: pair.pairSimilarity,
		paperOnly: true,
		warning: "paper-only signal; do not place live trades from this scanner",
		reason:
			pair.pairingMethod === "exact_question"
				? `same normalized question; buy YES ask on ${buy.exchange} and compare with YES bid on ${sell.exchange}`
				: `token similarity ${pair.pairSimilarity.toFixed(4)} with matching numeric anchors; buy YES ask on ${buy.exchange} and compare with YES bid on ${sell.exchange}`,
	};
}

function toEdgeSensitivityBestCandidate(
	candidate: CrossVenueMispricingCandidate,
): CrossVenueEdgeSensitivityBestCandidate {
	return {
		pairKey: candidate.pairKey,
		question: candidate.question,
		netEdge: candidate.netEdge,
		grossEdge: candidate.grossEdge,
		buyExchange: candidate.buy.exchange,
		buyMarketId: candidate.buy.marketId,
		buyPrice: candidate.buy.yesAsk,
		sellExchange: candidate.sell.exchange,
		sellMarketId: candidate.sell.marketId,
		sellPrice: candidate.sell.yesBid,
		pairingMethod: candidate.pairingMethod,
		pairSimilarity: candidate.pairSimilarity,
	};
}

function toLeg(market: PredictionMarket): CrossVenueLeg {
	return {
		exchange: market.exchange as SupportedExchange,
		marketId: market.id,
		question: market.question,
		yesBid: market.yesBid,
		yesAsk: market.yesAsk,
		liquidity: market.liquidity,
		expiresAt: market.expiresAt,
		updatedAt: market.updatedAt,
	};
}

function isActionablePrice(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value < 1;
}

function isFresh(market: PredictionMarket, options: ResolvedOptions): boolean {
	const updatedAtMs = parseTime(market.updatedAt);
	if (!Number.isFinite(updatedAtMs)) return false;
	return options.nowMs - updatedAtMs <= options.maxStalenessMs;
}

function parseTime(value: string): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function roundEdge(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
