import type { Position } from "../trading-store.js";

export interface RiskConfig {
	/** Max % of account equity to risk per trade (default: 1%) */
	riskPerTradePct: number;
	/** Max % of portfolio in a single position (default: 5%) */
	maxPositionPct: number;
	/** Max total % of portfolio in open positions (default: 30%) */
	maxExposurePct: number;
	/** Max drawdown % before halting all new trades (default: 10%) */
	maxDrawdownPct: number;
	/** Default stop-loss as ATR multiplier (default: 1.5) */
	defaultStopAtrMultiplier: number;
	/** Default risk:reward ratio for take-profit (default: 1.5) */
	defaultRiskRewardRatio: number;
	/** Max number of concurrent open positions (default: 5) */
	maxOpenPositions: number;
	/** Max consecutive losses before halting trading (default: 5) */
	maxConsecutiveLosses?: number;
	/** Max positions per individual asset (default: 3). Prevents piling into one symbol. */
	maxPositionsPerAsset?: number;
	/** Default trailing stop % applied to all new positions (default: 3). Set 0 to disable. */
	defaultTrailingStopPct?: number;
	/** Min price distance % from existing position to allow new entry for same symbol (default: 2). Prevents clustering. */
	minEntryDistancePct?: number;
	/** ATR multiplier for DEX stop-loss calculation (default: 2.0). Higher than CEX default to account for on-chain volatility. */
	dexStopAtrMultiplier?: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
	riskPerTradePct: 1,
	maxPositionPct: 5,
	maxExposurePct: 30,
	maxDrawdownPct: 10,
	defaultStopAtrMultiplier: 1.5,
	defaultRiskRewardRatio: 1.5,
	maxOpenPositions: 5,
	maxPositionsPerAsset: 3,
	defaultTrailingStopPct: 3,
	minEntryDistancePct: 2,
	dexStopAtrMultiplier: 2.0,
};

export interface PositionSizeResult {
	qty: number;
	riskAmount: number;
	stopLoss: number;
	takeProfit: number;
	riskRewardRatio: number;
	positionValueUsd: number;
	portfolioPct: number;
}

export interface TradeValidation {
	allowed: boolean;
	reasons: string[];
	suggested?: PositionSizeResult;
	/**
	 * When a trade is rejected for size-related reasons (exposure or position size),
	 * this field contains the maximum quantity that WOULD pass all size constraints.
	 * Undefined when the trade is allowed or when rejection is for non-size reasons
	 * (drawdown, circuit breaker, min distance, max positions).
	 * Value is 0 when no size would pass (e.g., exposure already at max).
	 */
	suggestedQty?: number;
}

export class RiskManager {
	private config: RiskConfig;

	constructor(config: Partial<RiskConfig> = {}) {
		this.config = { ...DEFAULT_RISK_CONFIG, ...config };
	}

	/**
	 * Calculate position size based on risk per trade.
	 * Uses the formula: qty = (equity * riskPct) / (entryPrice - stopLossPrice)
	 */
	calculatePositionSize(
		accountEquity: number,
		entryPrice: number,
		stopLossPrice: number,
	): PositionSizeResult {
		// Input validation — reject nonsense values that would produce dangerous sizing
		if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
			return zeroPosResult(stopLossPrice, entryPrice);
		}
		if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
			return zeroPosResult(stopLossPrice, entryPrice);
		}
		if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
			return zeroPosResult(stopLossPrice, entryPrice);
		}

		const riskDistance = Math.abs(entryPrice - stopLossPrice);
		if (riskDistance === 0) {
			return zeroPosResult(stopLossPrice, entryPrice);
		}

		// Reject if stop distance is less than 0.1% — too tight, guaranteed to get stopped out by noise
		if (riskDistance / entryPrice < 0.001) {
			return zeroPosResult(stopLossPrice, entryPrice);
		}

		const riskAmount = accountEquity * (this.config.riskPerTradePct / 100);
		let qty = riskAmount / riskDistance;

		// Cap position size by max position %
		const maxPositionValue = accountEquity * (this.config.maxPositionPct / 100);
		const positionValue = qty * entryPrice;
		if (positionValue > maxPositionValue) {
			qty = maxPositionValue / entryPrice;
		}

		const takeProfit = entryPrice > stopLossPrice
			? entryPrice + riskDistance * this.config.defaultRiskRewardRatio
			: entryPrice - riskDistance * this.config.defaultRiskRewardRatio;

		const finalPositionValue = qty * entryPrice;

		return {
			qty: roundQty(qty),
			riskAmount: round2(Math.min(riskAmount, qty * riskDistance)),
			stopLoss: round2(stopLossPrice),
			takeProfit: round2(takeProfit),
			riskRewardRatio: this.config.defaultRiskRewardRatio,
			positionValueUsd: round2(finalPositionValue),
			portfolioPct: round2((finalPositionValue / accountEquity) * 100),
		};
	}

	/**
	 * Calculate ATR-based stop-loss price.
	 */
	calculateStopLoss(
		entryPrice: number,
		atrValue: number,
		side: "long" | "short",
		multiplier?: number,
	): number {
		const mult = multiplier ?? this.config.defaultStopAtrMultiplier;
		return side === "long"
			? round2(entryPrice - atrValue * mult)
			: round2(entryPrice + atrValue * mult);
	}

	/**
	 * Calculate take-profit price based on risk:reward ratio.
	 */
	calculateTakeProfit(
		entryPrice: number,
		stopLossPrice: number,
		riskRewardRatio?: number,
	): number {
		const rr = riskRewardRatio ?? this.config.defaultRiskRewardRatio;
		const riskDistance = Math.abs(entryPrice - stopLossPrice);
		return entryPrice > stopLossPrice
			? round2(entryPrice + riskDistance * rr)
			: round2(entryPrice - riskDistance * rr);
	}

	/**
	 * Check if current drawdown exceeds the max allowed.
	 */
	isDrawdownExceeded(currentEquity: number, peakEquity: number): boolean {
		if (peakEquity <= 0) return false;
		const drawdownPct = ((peakEquity - currentEquity) / peakEquity) * 100;
		return drawdownPct >= this.config.maxDrawdownPct;
	}

	/**
	 * Calculate current drawdown percentage.
	 */
	getDrawdownPct(currentEquity: number, peakEquity: number): number {
		if (peakEquity <= 0) return 0;
		return round2(((peakEquity - currentEquity) / peakEquity) * 100);
	}

	/**
	 * Validate a proposed trade against all risk rules.
	 */
	validateTrade(input: {
		entryPrice: number;
		qty: number;
		side: "long" | "short";
		accountEquity: number;
		peakEquity: number;
		openPositions: Position[];
		atrValue?: number;
		/** Symbol being traded — used for per-asset position limit */
		symbol?: string;
		/** Number of recent consecutive losses (for circuit breaker) */
		consecutiveLosses?: number;
	}): TradeValidation {
		const reasons: string[] = [];
		const { entryPrice, qty, side, accountEquity, peakEquity, openPositions, atrValue } = input;

		// 0. Input sanity checks
		if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
			return { allowed: false, reasons: ["Invalid entry price"] };
		}
		if (!Number.isFinite(qty) || qty <= 0) {
			return { allowed: false, reasons: ["Invalid quantity"] };
		}
		if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
			return { allowed: false, reasons: ["Cannot determine account equity — refusing trade"] };
		}

		// 1. Check drawdown limit
		if (this.isDrawdownExceeded(accountEquity, peakEquity)) {
			const dd = this.getDrawdownPct(accountEquity, peakEquity);
			reasons.push(
				`Drawdown limit exceeded: ${dd}% (max: ${this.config.maxDrawdownPct}%). Trading halted.`,
			);
		}

		// 1b. Consecutive loss circuit breaker
		const maxLosses = this.config.maxConsecutiveLosses ?? 5;
		if (input.consecutiveLosses != null && input.consecutiveLosses >= maxLosses) {
			reasons.push(
				`Circuit breaker: ${input.consecutiveLosses} consecutive losses (max: ${maxLosses}). Take a break and review strategy.`,
			);
		}

		// 2. Check max open positions
		if (openPositions.length >= this.config.maxOpenPositions) {
			reasons.push(
				`Max open positions reached: ${openPositions.length}/${this.config.maxOpenPositions}`,
			);
		}

		// 3. Check per-asset position limit
		const maxPerAsset = this.config.maxPositionsPerAsset ?? 3;
		if (input.symbol) {
			const sameSymbol = openPositions.filter((p) => p.symbol === input.symbol);
			if (sameSymbol.length >= maxPerAsset) {
				reasons.push(
					`Already have ${sameSymbol.length}/${maxPerAsset} position(s) for ${input.symbol} — close existing before opening new`,
				);
			}
		}

		// 3b. Check minimum price distance from existing positions for same symbol
		const minDistPct = this.config.minEntryDistancePct ?? 2;
		if (input.symbol && minDistPct > 0) {
			const sameSymbol = openPositions.filter((p) => p.symbol === input.symbol);
			for (const existing of sameSymbol) {
				const distPct = Math.abs(entryPrice - existing.entryPrice) / existing.entryPrice * 100;
				if (distPct < minDistPct) {
					reasons.push(
						`Entry too close to existing ${input.symbol} position at $${existing.entryPrice.toFixed(2)} (${distPct.toFixed(1)}% apart, min: ${minDistPct}%)`,
					);
					break;
				}
			}
		}

		// 4. Check max exposure
		const currentExposure = openPositions.reduce(
			(sum, p) => sum + p.entryPrice * p.qty,
			0,
		);
		const newExposure = currentExposure + entryPrice * qty;
		const exposurePct = (newExposure / accountEquity) * 100;
		// Track whether size-related constraints are the reason for rejection
		let hasSizeRejection = false;
		if (exposurePct > this.config.maxExposurePct + 0.01) {
			reasons.push(
				`Total exposure would be ${round2(exposurePct)}% (max: ${this.config.maxExposurePct}%)`,
			);
			hasSizeRejection = true;
		}

		// 5. Check single position size (0.1% tolerance for floating-point rounding)
		const positionValue = entryPrice * qty;
		const positionPct = (positionValue / accountEquity) * 100;
		if (positionPct > this.config.maxPositionPct + 0.1) {
			reasons.push(
				`Position size ${round2(positionPct)}% exceeds max ${this.config.maxPositionPct}% of portfolio`,
			);
			hasSizeRejection = true;
		}

		// 6. Suggest proper position size if ATR available
		let suggested: PositionSizeResult | undefined;
		if (atrValue && atrValue > 0) {
			const stopLoss = this.calculateStopLoss(entryPrice, atrValue, side);
			suggested = this.calculatePositionSize(accountEquity, entryPrice, stopLoss);
		}

		// 7. Compute suggestedQty — the max quantity that would pass all size constraints.
		// Only populated when size-related checks (exposure or position size) caused rejection.
		// Non-size rejections (drawdown, circuit breaker, max positions, min distance) do NOT
		// produce a suggestedQty because reducing size won't fix those issues.
		let suggestedQty: number | undefined;
		if (hasSizeRejection && reasons.length > 0) {
			// Max qty allowed by exposure limit
			const exposureHeadroomUsd = (this.config.maxExposurePct / 100 * accountEquity) - currentExposure;
			const maxQtyByExposure = entryPrice > 0 ? exposureHeadroomUsd / entryPrice : 0;

			// Max qty allowed by single position size limit
			const maxQtyByPosition = entryPrice > 0
				? (this.config.maxPositionPct / 100 * accountEquity) / entryPrice
				: 0;

			// Take the minimum of all size constraints
			suggestedQty = roundQty(Math.max(0, Math.min(maxQtyByExposure, maxQtyByPosition)));
		}

		return {
			allowed: reasons.length === 0,
			reasons,
			suggested,
			suggestedQty,
		};
	}

	getConfig(): RiskConfig {
		return { ...this.config };
	}

	updateConfig(updates: Partial<RiskConfig>): void {
		Object.assign(this.config, updates);
	}
}

function zeroPosResult(stopLoss: number, entryPrice: number): PositionSizeResult {
	return {
		qty: 0,
		riskAmount: 0,
		stopLoss,
		takeProfit: entryPrice,
		riskRewardRatio: 0,
		positionValueUsd: 0,
		portfolioPct: 0,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function roundQty(n: number): number {
	// 8 decimal places for crypto quantities
	return Math.round(n * 1e8) / 1e8;
}
