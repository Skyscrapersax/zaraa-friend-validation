/**
 * Market Scanner — Scans prediction markets for positive EV opportunities.
 *
 * This is the prediction market equivalent of SignalEngine. It periodically
 * scans all open markets, applies probability models, and generates signals
 * for contracts with positive expected value.
 *
 * Models:
 * - Spread model: Large bid-ask spreads indicate mispricing opportunities
 * - Volume model: Volume-weighted probability estimation
 * - LLM Ensemble (opt-in): Multi-model probability estimation with Platt calibration
 *
 * Cycle 002 additions:
 * - Category classifier: 90+ regex rules for zero-cost market categorization
 * - Auto-classification feeds into category-specific Platt calibration
 */
import type { PredictionExchange, PredictionMarket, PredictionSignal } from "../types.js";
import { generateSignal } from "./ev-calculator.js";
import type { LLMForecaster } from "./llm-forecaster.js";

export interface MarketScannerConfig {
	/** Minimum expected value to generate a signal (default: 0.02 = 2 cents per dollar) */
	minEV: number;
	/** Minimum liquidity in USD to consider a market (default: 1000) */
	minLiquidity: number;
	/** Minimum volume in USD to consider a market (default: 500) */
	minVolume: number;
	/** Maximum spread to consider (default: 0.10 = 10%) */
	maxSpread: number;
	/** Bankroll for position sizing (default: 1000) */
	bankroll: number;
	/** Cooldown between scans of the same market in ms (default: 5 min) */
	cooldownMs: number;
}

const DEFAULT_CONFIG: MarketScannerConfig = {
	minEV: 0.02,
	minLiquidity: 1000,
	minVolume: 500,
	maxSpread: 0.1,
	bankroll: 1000,
	cooldownMs: 5 * 60 * 1000,
};

export interface ScanResult {
	signals: PredictionSignal[];
	marketsScanned: number;
	marketsFiltered: number;
	timestamp: number;
}

/** Function that fetches markets from an exchange */
export type MarketFetcher = (exchange: PredictionExchange) => Promise<PredictionMarket[]>;

// ── Category Classifier (Cycle 002) ──

/**
 * Regex rules for zero-cost market category classification.
 * Each entry: [category, patterns[]] — a market matches a category if
 * one or more patterns match its question text. Highest match count wins.
 */
const CATEGORY_RULES: [string, RegExp[]][] = [
	[
		"politics",
		[
			/\b(president|presidential|election|ballot|vote|voter|candidate)\b/i,
			/\b(congress|senate|house|representative|senator|governor)\b/i,
			/\b(democrat|republican|GOP|DNC|RNC|primary|caucus)\b/i,
			/\b(impeach|legislation|bill\s+pass|executive\s+order|veto)\b/i,
			/\b(trump|biden|desantis|newsom|harris|pence)\b/i,
			/\b(supreme\s+court|scotus|justice\s+\w+)\b/i,
			/\b(nato|un\s+|united\s+nations|sanctions|tariff|geopolit)\b/i,
			/\b(midterm|midterms|inaugurat|cabinet|pardon|filibuster)\b/i,
			// Cycle 003: 2026 midterm-specific patterns
			/\b(ballot\s+measure|proposition|referendum|initiative)\b/i,
			/\b(redistrict\w*|gerrymander\w*|electoral\s+college|popular\s+vote)\b/i,
			/\b(speaker|majority\s+leader|minority\s+leader|whip)\b/i,
			/\b(approval\s+rating|favorab|unfavorab|generic\s+ballot)\b/i,
			/\b(swing\s+state|battleground|toss[- ]up|lean\s+(dem|rep))\b/i,
			/\b(2026\s+election|november\s+2026|runoff|ranked[- ]choice)\b/i,
		],
	],
	[
		"crypto",
		[
			/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|cardano|ada)\b/i,
			/\b(crypto|cryptocurrency|blockchain|defi|nft|web3)\b/i,
			/\b(binance|coinbase|kraken|uniswap|opensea)\b/i,
			/\b(altcoin|memecoin|stablecoin|usdc|usdt|tether|dai)\b/i,
			/\b(halving|mining|staking|airdrop|token|dex)\b/i,
			/\b(polygon|avalanche|arbitrum|optimism|base\s+chain)\b/i,
		],
	],
	[
		"economics",
		[
			/\b(fed|federal\s+reserve|interest\s+rate|rate\s+cut|rate\s+hike|fomc)\b/i,
			/\b(gdp|inflation|cpi|ppi|unemployment|jobs?\s+report|nonfarm)\b/i,
			/\b(recession|depression|bear\s+market|bull\s+market|correction)\b/i,
			/\b(treasury|bond|yield|s&p|nasdaq|dow\s+jones|russell)\b/i,
			/\b(tariff|trade\s+war|trade\s+deficit|import\s+ban|export)\b/i,
			/\b(housing|mortgage|real\s+estate|rent|consumer\s+confidence)\b/i,
		],
	],
	[
		"sports",
		[
			/\b(nfl|nba|mlb|nhl|mls|premier\s+league|champions\s+league|la\s+liga|bundesliga)\b/i,
			/\b(super\s+bowl|world\s+series|world\s+cup|olympics|grand\s+slam|wimbledon)\b/i,
			/\b(championship|playoff|finals|mvp|draft|trade\s+deadline|all[- ]star)\b/i,
			/\b(touchdown|home\s+run|slam\s+dunk|hat\s+trick|grand\s+prix|formula\s+1|f1)\b/i,
			/\b(ufc|boxing|tennis|golf|pga|masters|open\s+championship)\b/i,
			/\b(hits?\s*\+\s*runs?\s*\+\s*rbis?|rbis?|stolen\s+bases?|first\s+goalscorer)\b/i,
			/\b(win\s+set\s+\d+|more\s+games?\s+than|vs\.?|match)\b/i,
		],
	],
	[
		"tech",
		[
			/\b(apple|google|microsoft|amazon|meta|nvidia|tesla|openai|anthropic|deepmind)\b/i,
			/\b(iphone|android|windows|macos|pixel|galaxy)\b/i,
			/\b(ai\s|artificial\s+intelligence|machine\s+learning|gpt|llm|chatbot|robot)\b/i,
			/\b(launch|release|ship|announce|unveil|keynote|wwdc|io\b)\b/i,
			/\b(tiktok\s+ban|antitrust|acquisition|merger|ipo|sec\s+filing)\b/i,
			/\b(spacex|starlink|neuralink|xai|groq|mistral|hugging\s*face)\b/i,
		],
	],
	[
		"science",
		[
			/\b(nasa|esa|isro|artemis|starship|mars|moon\s+land|lunar)\b/i,
			/\b(climate|temperature|carbon|emissions|paris\s+agreement|net\s+zero)\b/i,
			/\b(vaccine|virus|pandemic|epidemic|outbreak|cdc|who\s+declar)\b/i,
			/\b(study\s+find|research\s+show|scientific|peer.review|journal|nature\b)\b/i,
			/\b(crispr|gene\s+edit|fusion|quantum\s+comput)\b/i,
		],
	],
	[
		"weather",
		[
			/\b(hurricane|tornado|typhoon|cyclone|tropical\s+storm)\b/i,
			/\b(temperature|heat\s+wave|cold\s+snap|snowfall|rainfall|blizzard)\b/i,
			/\b(flood|drought|wildfire|earthquake|tsunami)\b/i,
			/\b(noaa|weather\s+service|el\s+ni[nñ]o|la\s+ni[nñ]a|polar\s+vortex)\b/i,
		],
	],
	[
		"entertainment",
		[
			/\b(oscar|emmy|grammy|golden\s+globe|tony\s+award|bafta)\b/i,
			/\b(box\s+office|movie|film|netflix|disney|hbo|streaming|hulu)\b/i,
			/\b(album|song|concert|tour|billboard|spotify|grammy)\b/i,
			/\b(reality\s+tv|bachelor|survivor|idol|big\s+brother)\b/i,
			/\b(celebrity|actor|actress|director|producer|premiere)\b/i,
		],
	],
];

/**
 * Classify a market question into a category using regex rules.
 * Zero LLM cost — pure pattern matching. Returns "default" if no category matches.
 *
 * Scoring: counts the number of pattern matches per category.
 * The category with the most matches wins (minimum 1 match required).
 */
export function classifyCategory(question: string): string {
	// Cap input length to prevent ReDoS from very long strings
	const q = question.length > 5000 ? question.slice(0, 5000) : question;
	let bestCategory = "default";
	let bestScore = 0;

	for (const [category, patterns] of CATEGORY_RULES) {
		let score = 0;
		for (const pattern of patterns) {
			if (pattern.test(q)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestCategory = category;
		}
	}

	return bestCategory;
}

// ── Market Scanner ──

export class MarketScanner {
	private config: MarketScannerConfig;
	private lastScanTime = new Map<string, number>();
	private fetchMarkets: MarketFetcher;
	private forecaster: LLMForecaster | null = null;

	constructor(fetchMarkets: MarketFetcher, config: Partial<MarketScannerConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.fetchMarkets = fetchMarkets;
	}

	/**
	 * Enable LLM ensemble forecasting for probability estimation.
	 * When set, analyzeMarket will use the ensemble for eligible markets
	 * and fall back to the spread/volume model on failure.
	 */
	setForecaster(forecaster: LLMForecaster): void {
		this.forecaster = forecaster;
	}

	/**
	 * Scan all markets on the given exchanges for +EV opportunities.
	 */
	async scan(exchanges: PredictionExchange[] = ["polymarket"]): Promise<ScanResult> {
		const allMarkets: PredictionMarket[] = [];

		for (const exchange of exchanges) {
			try {
				const markets = await this.fetchMarkets(exchange);
				allMarkets.push(...markets);
			} catch (err) {
				console.warn(
					`[predictions] exchange fetch failed for ${exchange}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		// Filter markets
		const filtered = allMarkets.filter((m) => this.isEligible(m));

		// Auto-classify categories for markets missing them (Cycle 002)
		for (const market of filtered) {
			if (!market.category || market.category === "default" || market.category === "") {
				market.category = classifyCategory(market.question);
			}
		}

		// Generate signals
		const signals: PredictionSignal[] = [];
		for (const market of filtered) {
			const cooldownKey = `${market.exchange}:${market.id}`;
			const lastScan = this.lastScanTime.get(cooldownKey);
			if (lastScan && Date.now() - lastScan < this.config.cooldownMs) continue;

			const signal = await this.analyzeMarket(market);
			if (signal) {
				signals.push(signal);
				this.lastScanTime.set(cooldownKey, Date.now());
			}
		}

		// Sort by expected value (highest first)
		signals.sort((a, b) => b.expectedValue - a.expectedValue);

		return {
			signals,
			marketsScanned: allMarkets.length,
			marketsFiltered: filtered.length,
			timestamp: Date.now(),
		};
	}

	private isEligible(market: PredictionMarket): boolean {
		if (market.status !== "open") return false;
		if (market.liquidity < this.config.minLiquidity) return false;
		if (market.volume24h < this.config.minVolume) return false;

		const spread = market.yesAsk - market.yesBid;
		if (spread > this.config.maxSpread) return false;

		// Skip markets too close to 0 or 1 (already decided)
		if (market.yesPrice < 0.05 || market.yesPrice > 0.95) return false;

		return true;
	}

	/**
	 * Analyze a single market using available models.
	 * If an LLM forecaster is configured, uses ensemble estimation with
	 * the spread/volume model as fallback. Otherwise uses spread/volume only.
	 */
	private async analyzeMarket(market: PredictionMarket): Promise<PredictionSignal | null> {
		// Try LLM ensemble first if available
		if (this.forecaster) {
			try {
				const forecast = await this.forecaster.forecast(market);
				const reason = `Ensemble(${forecast.votes.length} models, conf=${forecast.confidence.toFixed(2)}, spread_penalty=${forecast.spreadPenaltyApplied}, cat=${market.category})`;
				const signal = generateSignal(
					market,
					forecast.finalProbability,
					this.config.bankroll,
					reason,
				);
				if (signal && signal.expectedValue >= this.config.minEV) {
					return signal;
				}
				return null;
			} catch (err) {
				console.warn(
					"[predictions] LLM ensemble failed for market " +
						market.id +
						", falling back to spread/volume:",
					err instanceof Error ? err.message : err,
				);
			}
		}

		return this.analyzeMarketClassic(market);
	}

	/**
	 * Classic spread/volume analysis — no LLM calls needed.
	 * Used as the default when no forecaster is configured, or as fallback.
	 */
	private analyzeMarketClassic(market: PredictionMarket): PredictionSignal | null {
		// Model 1: Spread-based mispricing detection
		const spread = market.yesAsk - market.yesBid;
		const midpoint = (market.yesAsk + market.yesBid) / 2;

		let modelProb = midpoint;
		let reason = `Spread=${(spread * 100).toFixed(1)}%`;

		// Model 2: Volume-weighted probability
		if (market.volume24h > 10000) {
			modelProb = market.yesPrice;
			reason = "High volume, efficient pricing";
		} else if (market.volume24h < 1000) {
			modelProb = market.yesPrice * 0.9 + 0.5 * 0.1;
			reason = `Low volume, mean-reversion bias (vol=$${market.volume24h.toFixed(0)})`;
		}

		const signal = generateSignal(market, modelProb, this.config.bankroll, reason);

		if (signal && signal.expectedValue >= this.config.minEV) {
			return signal;
		}

		return null;
	}

	getConfig(): MarketScannerConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<MarketScannerConfig>): void {
		Object.assign(this.config, updates);
	}

	clearCooldowns(): void {
		this.lastScanTime.clear();
	}
}
