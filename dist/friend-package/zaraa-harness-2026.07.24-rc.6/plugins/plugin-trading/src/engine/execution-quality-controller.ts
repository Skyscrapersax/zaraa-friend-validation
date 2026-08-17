export type AdaptiveOrderType = "MARKET" | "LIMIT";

export interface ExecutionBookSnapshot {
	bestBid?: number;
	bestAsk?: number;
	topBidQty?: number;
	topAskQty?: number;
	midPrice?: number;
}

export interface ExecutionQualitySample {
	symbol: string;
	side: "BUY" | "SELL";
	requestedOrderType: AdaptiveOrderType;
	actualOrderType: AdaptiveOrderType;
	expectedPrice: number;
	fillPrice: number;
	latencyMs: number;
	partialFill?: boolean;
	limitFallback?: boolean;
	book?: ExecutionBookSnapshot;
	timestamp?: number;
}

export interface ExecutionQualityStats {
	symbol: string;
	sampleCount: number;
	avgAdverseSlippageBps: number;
	avgAdverseImpactBps: number;
	avgLatencyMs: number;
	limitFallbackRate: number;
	partialFillRate: number;
	marketSampleCount: number;
	limitSampleCount: number;
	marketAvgAdverseSlippageBps: number;
	marketAvgAdverseImpactBps: number;
	limitAvgAdverseSlippageBps: number;
	sizingMultiplier: number;
}

export interface ExecutionSizingAdjustment {
	multiplier: number;
	stats: ExecutionQualityStats;
}

export interface AdaptiveOrderTypeDecision {
	orderType: AdaptiveOrderType;
	confidence: number;
	reason: string;
	stats: ExecutionQualityStats;
}

export interface ExecutionQualityControllerConfig {
	maxSamplesPerSymbol?: number;
	minSamplesForPenalty?: number;
	minSamplesForRouting?: number;
	slippageElevatedThresholdBps?: number;
	slippageCriticalThresholdBps?: number;
	slippageCooldownMs?: number;
	slippageSampleWindow?: number;
}

interface StoredSample extends ExecutionQualitySample {
	timestamp: number;
	adverseSlippageBps: number;
	adverseImpactBps: number;
}

const DEFAULT_CONFIG: Required<ExecutionQualityControllerConfig> = {
	maxSamplesPerSymbol: 24,
	minSamplesForPenalty: 3,
	minSamplesForRouting: 4,
	slippageElevatedThresholdBps: 50,
	slippageCriticalThresholdBps: 100,
	slippageCooldownMs: 30 * 60 * 1000,
	slippageSampleWindow: 10,
};

export function deriveBookSnapshot(book: {
	bids?: Array<{ price: number; qty: number }>;
	asks?: Array<{ price: number; qty: number }>;
} | null | undefined): ExecutionBookSnapshot | undefined {
	if (!book) return undefined;
	const bestBid = book.bids?.[0]?.price;
	const bestAsk = book.asks?.[0]?.price;
	return {
		bestBid,
		bestAsk,
		topBidQty: book.bids?.[0]?.qty,
		topAskQty: book.asks?.[0]?.qty,
		midPrice:
			Number.isFinite(bestBid) && Number.isFinite(bestAsk)
				? ((bestBid as number) + (bestAsk as number)) / 2
				: undefined,
	};
}

export function computeAdverseSlippageBps(input: {
	side: "BUY" | "SELL";
	expectedPrice: number;
	fillPrice: number;
}): number {
	const { side, expectedPrice, fillPrice } = input;
	if (!Number.isFinite(expectedPrice) || expectedPrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
		return 0;
	}
	const raw =
		side === "BUY"
			? ((fillPrice - expectedPrice) / expectedPrice) * 10_000
			: ((expectedPrice - fillPrice) / expectedPrice) * 10_000;
	return roundBps(Math.max(0, raw));
}

export function computeAdverseImpactBps(input: {
	side: "BUY" | "SELL";
	fillPrice: number;
	book?: ExecutionBookSnapshot;
}): number {
	const { side, fillPrice, book } = input;
	if (!book || !Number.isFinite(fillPrice) || fillPrice <= 0) return 0;
	const referencePrice =
		side === "BUY"
			? book.bestAsk ?? book.midPrice
			: book.bestBid ?? book.midPrice;
	if (!Number.isFinite(referencePrice) || (referencePrice as number) <= 0) return 0;
	const raw =
		side === "BUY"
			? ((fillPrice - (referencePrice as number)) / (referencePrice as number)) * 10_000
			: (((referencePrice as number) - fillPrice) / (referencePrice as number)) * 10_000;
	return roundBps(Math.max(0, raw));
}

export interface SlippageBreachStatus {
	breached: boolean;
	severity: "none" | "elevated" | "critical";
	action: "allow" | "limit_only" | "halt";
	cooldownRemainingMs: number;
	avgSlippageBps: number;
}

export class ExecutionQualityController {
	private readonly config: Required<ExecutionQualityControllerConfig>;
	private readonly samplesBySymbol = new Map<string, StoredSample[]>();
	private readonly breachTimestamps = new Map<string, number>();

	constructor(config: ExecutionQualityControllerConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	recordExecution(sample: ExecutionQualitySample): ExecutionQualityStats {
		const stored: StoredSample = {
			...sample,
			timestamp: sample.timestamp ?? Date.now(),
			adverseSlippageBps: computeAdverseSlippageBps(sample),
			adverseImpactBps: computeAdverseImpactBps(sample),
		};
		const existing = this.samplesBySymbol.get(sample.symbol) ?? [];
		existing.push(stored);
		if (existing.length > this.config.maxSamplesPerSymbol) {
			existing.splice(0, existing.length - this.config.maxSamplesPerSymbol);
		}
		this.samplesBySymbol.set(sample.symbol, existing);
		return this.getStats(sample.symbol);
	}

	getSizingAdjustment(symbol: string): ExecutionSizingAdjustment {
		const stats = this.getStats(symbol);
		if (stats.sampleCount < this.config.minSamplesForPenalty) {
			return {
				multiplier: 1,
				stats: {
					...stats,
					sizingMultiplier: 1,
				},
			};
		}
		return {
			multiplier: stats.sizingMultiplier,
			stats,
		};
	}

	getAdaptiveOrderType(symbol: string, fallback: AdaptiveOrderType): AdaptiveOrderTypeDecision {
		const stats = this.getStats(symbol);
		if (stats.sampleCount < this.config.minSamplesForRouting) {
			return {
				orderType: fallback,
				confidence: 0,
				reason: "insufficient execution samples",
				stats,
			};
		}

		if (
			stats.marketSampleCount >= this.config.minSamplesForRouting &&
			(stats.marketAvgAdverseSlippageBps >= 12 || stats.marketAvgAdverseImpactBps >= 10)
		) {
			return {
				orderType: "LIMIT",
				confidence: clamp01(
					Math.max(
						stats.marketAvgAdverseSlippageBps / 24,
						stats.marketAvgAdverseImpactBps / 20,
					),
				),
				reason: `market orders slipped ${stats.marketAvgAdverseSlippageBps.toFixed(1)}bps on average`,
				stats,
			};
		}

		if (
			stats.limitSampleCount >= this.config.minSamplesForRouting &&
			stats.limitFallbackRate >= 0.6 &&
			stats.limitAvgAdverseSlippageBps <= 8 &&
			stats.avgLatencyMs >= 2_500
		) {
			return {
				orderType: "MARKET",
				confidence: clamp01(Math.max(stats.limitFallbackRate, stats.avgLatencyMs / 6_000)),
				reason: `limit orders are timing out/falling back ${Math.round(stats.limitFallbackRate * 100)}% of the time`,
				stats,
			};
		}

		return {
			orderType: fallback,
			confidence: 0.2,
			reason: "recent execution quality is within normal range",
			stats,
		};
	}

	getSlippageBreachStatus(symbol: string): SlippageBreachStatus {
		const samples = this.samplesBySymbol.get(symbol) ?? [];
		const window = samples.slice(-this.config.slippageSampleWindow);

		if (window.length < this.config.slippageSampleWindow) {
			return { breached: false, severity: "none", action: "allow", cooldownRemainingMs: 0, avgSlippageBps: 0 };
		}

		const avgSlippage = average(window.map((s) => s.adverseSlippageBps));

		const lastBreach = this.breachTimestamps.get(symbol);
		if (lastBreach) {
			const elapsed = Date.now() - lastBreach;
			if (elapsed < this.config.slippageCooldownMs) {
				const remaining = this.config.slippageCooldownMs - elapsed;
				const severity = avgSlippage > this.config.slippageCriticalThresholdBps ? "critical" as const : "elevated" as const;
				const action = severity === "critical" ? "halt" as const : "limit_only" as const;
				return { breached: true, severity, action, cooldownRemainingMs: remaining, avgSlippageBps: roundBps(avgSlippage) };
			}
			this.breachTimestamps.delete(symbol);
		}

		if (avgSlippage > this.config.slippageCriticalThresholdBps) {
			this.breachTimestamps.set(symbol, Date.now());
			return { breached: true, severity: "critical", action: "halt", cooldownRemainingMs: this.config.slippageCooldownMs, avgSlippageBps: roundBps(avgSlippage) };
		}
		if (avgSlippage > this.config.slippageElevatedThresholdBps) {
			this.breachTimestamps.set(symbol, Date.now());
			return { breached: true, severity: "elevated", action: "limit_only", cooldownRemainingMs: this.config.slippageCooldownMs, avgSlippageBps: roundBps(avgSlippage) };
		}

		return { breached: false, severity: "none", action: "allow", cooldownRemainingMs: 0, avgSlippageBps: roundBps(avgSlippage) };
	}

	getStats(symbol: string): ExecutionQualityStats {
		const samples = this.samplesBySymbol.get(symbol) ?? [];
		if (samples.length === 0) {
			return {
				symbol,
				sampleCount: 0,
				avgAdverseSlippageBps: 0,
				avgAdverseImpactBps: 0,
				avgLatencyMs: 0,
				limitFallbackRate: 0,
				partialFillRate: 0,
				marketSampleCount: 0,
				limitSampleCount: 0,
				marketAvgAdverseSlippageBps: 0,
				marketAvgAdverseImpactBps: 0,
				limitAvgAdverseSlippageBps: 0,
				sizingMultiplier: 1,
			};
		}

		const marketSamples = samples.filter((sample) => sample.actualOrderType === "MARKET");
		const limitSamples = samples.filter((sample) => sample.requestedOrderType === "LIMIT");
		const avgAdverseSlippageBps = average(samples.map((sample) => sample.adverseSlippageBps));
		const avgAdverseImpactBps = average(samples.map((sample) => sample.adverseImpactBps));
		const avgLatencyMs = average(samples.map((sample) => sample.latencyMs));
		const limitFallbackRate = average(
			limitSamples.map((sample) => (sample.limitFallback ? 1 : 0)),
		);
		const partialFillRate = average(
			samples.map((sample) => (sample.partialFill ? 1 : 0)),
		);
		const marketAvgAdverseSlippageBps = average(
			marketSamples.map((sample) => sample.adverseSlippageBps),
		);
		const marketAvgAdverseImpactBps = average(
			marketSamples.map((sample) => sample.adverseImpactBps),
		);
		const limitAvgAdverseSlippageBps = average(
			limitSamples.map((sample) => sample.adverseSlippageBps),
		);

		const slippagePenalty = clamp(avgAdverseSlippageBps / 50, 0, 0.3);
		const impactPenalty = clamp(avgAdverseImpactBps / 40, 0, 0.2);
		const latencyPenalty = clamp((avgLatencyMs - 1_500) / 8_000, 0, 0.15);
		const fallbackPenalty = clamp(limitFallbackRate * 0.2, 0, 0.2);
		const partialPenalty = clamp(partialFillRate * 0.15, 0, 0.15);
		const sizingMultiplier = clamp(
			1 - (slippagePenalty + impactPenalty + latencyPenalty + fallbackPenalty + partialPenalty),
			0.35,
			1,
		);

		return {
			symbol,
			sampleCount: samples.length,
			avgAdverseSlippageBps: roundBps(avgAdverseSlippageBps),
			avgAdverseImpactBps: roundBps(avgAdverseImpactBps),
			avgLatencyMs: Math.round(avgLatencyMs),
			limitFallbackRate: roundRate(limitFallbackRate),
			partialFillRate: roundRate(partialFillRate),
			marketSampleCount: marketSamples.length,
			limitSampleCount: limitSamples.length,
			marketAvgAdverseSlippageBps: roundBps(marketAvgAdverseSlippageBps),
			marketAvgAdverseImpactBps: roundBps(marketAvgAdverseImpactBps),
			limitAvgAdverseSlippageBps: roundBps(limitAvgAdverseSlippageBps),
			sizingMultiplier: roundRate(sizingMultiplier),
		};
	}
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function roundBps(value: number): number {
	return Math.round(value * 100) / 100;
}

function roundRate(value: number): number {
	return Math.round(value * 1000) / 1000;
}
