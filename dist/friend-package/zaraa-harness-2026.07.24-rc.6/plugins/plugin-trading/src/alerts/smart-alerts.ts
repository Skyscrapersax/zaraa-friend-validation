import { rsi, macd, bollingerBands, atr } from "../indicators/index.js";
import type { Candle } from "../data/candle-store.js";

// ── Alert condition types ──

export type AlertCondition =
	| { type: "rsi"; symbol: string; threshold: number; direction: "above" | "below"; timeframe: string }
	| { type: "volume_spike"; symbol: string; multiplier: number; timeframe: string }
	| { type: "volatility"; symbol: string; atrMultiplier: number; timeframe: string }
	| { type: "price_change"; symbol: string; percentChange: number; periodMinutes: number }
	| { type: "macd_cross"; symbol: string; timeframe: string; direction: "bullish" | "bearish" }
	| { type: "bollinger_squeeze"; symbol: string; timeframe: string; squeezePct: number };

export interface SmartAlert {
	id: string;
	condition: AlertCondition;
	message: string;
	enabled: boolean;
	createdAt: string;
	lastTriggered: string | null;
	triggerCount: number;
	cooldownMinutes: number;
}

export interface SmartAlertOptions {
	message?: string;
	cooldownMinutes?: number;
}

export interface TriggerResult {
	alert: SmartAlert;
	value: number | string;
	timestamp: string;
}

// ── Candle fetcher callback ──

/**
 * Function signature for retrieving candle data.
 * The engine calls this to pull candles for a given symbol/timeframe.
 * Returns candles ordered oldest-first (ascending openTime).
 */
export type CandleFetcherFn = (symbol: string, timeframe: string, limit: number) => Candle[] | Promise<Candle[]>;

// ── Constants ──

const DEFAULT_COOLDOWN_MINUTES = 60;
const RSI_PERIOD = 14;
const MIN_CANDLES_RSI = RSI_PERIOD + 2;
const MIN_CANDLES_MACD = 35; // 26 slow + 9 signal
const MIN_CANDLES_BOLLINGER = 21;
const MIN_CANDLES_ATR = 15;
const VOLUME_AVG_LOOKBACK = 20;

let nextId = 1;

function generateId(): string {
	return `sa_${Date.now()}_${nextId++}`;
}

/**
 * Smart alert engine that evaluates indicator-based conditions against
 * market data. Goes beyond simple price-level alerts to support RSI,
 * MACD crossovers, Bollinger squeezes, volume spikes, ATR volatility,
 * and percentage price changes.
 *
 * Usage:
 *   const engine = new SmartAlertEngine();
 *   engine.createAlert({ type: "rsi", symbol: "BTC_USDT", threshold: 70, direction: "above", timeframe: "1h" });
 *   const triggered = await engine.evaluate((sym, tf, lim) => candleStore.get(sym, tf, lim));
 */
export class SmartAlertEngine {
	private alerts: Map<string, SmartAlert> = new Map();

	// ── CRUD ──

	createAlert(condition: AlertCondition, options?: SmartAlertOptions): SmartAlert {
		const alert: SmartAlert = {
			id: generateId(),
			condition,
			message: options?.message ?? defaultMessage(condition),
			enabled: true,
			createdAt: new Date().toISOString(),
			lastTriggered: null,
			triggerCount: 0,
			cooldownMinutes: options?.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
		};
		this.alerts.set(alert.id, alert);
		return alert;
	}

	removeAlert(id: string): boolean {
		return this.alerts.delete(id);
	}

	getAlert(id: string): SmartAlert | undefined {
		return this.alerts.get(id);
	}

	listAlerts(): SmartAlert[] {
		return Array.from(this.alerts.values());
	}

	enableAlert(id: string): boolean {
		const alert = this.alerts.get(id);
		if (!alert) return false;
		alert.enabled = true;
		return true;
	}

	disableAlert(id: string): boolean {
		const alert = this.alerts.get(id);
		if (!alert) return false;
		alert.enabled = false;
		return true;
	}

	/** Import previously persisted alerts (e.g., from a database). */
	loadAlerts(alerts: SmartAlert[]): void {
		for (const a of alerts) {
			this.alerts.set(a.id, { ...a });
		}
	}

	/** Export all alerts for persistence. */
	exportAlerts(): SmartAlert[] {
		return this.listAlerts();
	}

	// ── Evaluation ──

	/**
	 * Evaluate all enabled alerts against current market data.
	 * Returns an array of triggered alerts with their current indicator values.
	 */
	async evaluate(getCandles: CandleFetcherFn): Promise<TriggerResult[]> {
		const now = Date.now();
		const results: TriggerResult[] = [];

		for (const alert of this.alerts.values()) {
			if (!alert.enabled) continue;

			// Respect cooldown
			if (alert.lastTriggered) {
				const elapsed = now - new Date(alert.lastTriggered).getTime();
				if (elapsed < alert.cooldownMinutes * 60_000) continue;
			}

			try {
				const result = await this.evaluateOne(alert, getCandles);
				if (result) {
					alert.lastTriggered = new Date(now).toISOString();
					alert.triggerCount++;
					results.push(result);
				}
			} catch (err) {
				console.debug("[smart-alerts] alert evaluation failed:", err instanceof Error ? err.message : err);
			}
		}

		return results;
	}

	private async evaluateOne(alert: SmartAlert, getCandles: CandleFetcherFn): Promise<TriggerResult | null> {
		const { condition } = alert;

		switch (condition.type) {
			case "rsi": {
				const candles = await getCandles(condition.symbol, condition.timeframe, MIN_CANDLES_RSI + 50);
				const closes = sortedCloses(candles);
				if (closes.length < MIN_CANDLES_RSI) return null;

				const triggered = this.evaluateRSI(closes, condition.threshold, condition.direction);
				if (!triggered) return null;

				const rsiValues = rsi(closes, RSI_PERIOD);
				const currentRsi = rsiValues[rsiValues.length - 1];
				return { alert, value: r2(currentRsi), timestamp: new Date().toISOString() };
			}

			case "volume_spike": {
				const candles = await getCandles(condition.symbol, condition.timeframe, VOLUME_AVG_LOOKBACK + 5);
				const sorted = sortByTime(candles);
				if (sorted.length < VOLUME_AVG_LOOKBACK + 1) return null;

				const volumes = sorted.map((c) => c.volume);
				const triggered = this.evaluateVolume(volumes, condition.multiplier);
				if (!triggered) return null;

				const currentVol = volumes[volumes.length - 1];
				const avgVol = avg(volumes.slice(0, -1).slice(-VOLUME_AVG_LOOKBACK));
				return { alert, value: r2(currentVol / avgVol), timestamp: new Date().toISOString() };
			}

			case "volatility": {
				const candles = await getCandles(condition.symbol, condition.timeframe, MIN_CANDLES_ATR + 50);
				const sorted = sortByTime(candles);
				if (sorted.length < MIN_CANDLES_ATR + 1) return null;

				const highs = sorted.map((c) => c.high);
				const lows = sorted.map((c) => c.low);
				const closes = sorted.map((c) => c.close);

				const triggered = this.evaluateATR(highs, lows, closes, condition.atrMultiplier);
				if (!triggered) return null;

				const atrValues = atr(highs, lows, closes);
				const currentAtr = atrValues[atrValues.length - 1];
				return { alert, value: r2(currentAtr), timestamp: new Date().toISOString() };
			}

			case "price_change": {
				// Use 1m candles for sub-hour precision
				const candlesNeeded = Math.max(condition.periodMinutes + 5, 30);
				const candles = await getCandles(condition.symbol, "1m", candlesNeeded);
				const sorted = sortByTime(candles);
				if (sorted.length < 2) return null;

				const closes = sorted.map((c) => c.close);
				const triggered = this.evaluatePriceChange(closes, condition.percentChange, condition.periodMinutes, sorted);
				if (!triggered) return null;

				const current = closes[closes.length - 1];
				const periodStart = this.findPriceAtMinutesAgo(sorted, condition.periodMinutes);
				const actualPct = periodStart > 0 ? ((current - periodStart) / periodStart) * 100 : 0;
				return { alert, value: r2(actualPct), timestamp: new Date().toISOString() };
			}

			case "macd_cross": {
				const candles = await getCandles(condition.symbol, condition.timeframe, MIN_CANDLES_MACD + 50);
				const closes = sortedCloses(candles);
				if (closes.length < MIN_CANDLES_MACD) return null;

				const crossDirection = this.evaluateMACDCross(closes);
				if (crossDirection !== condition.direction) return null;

				return { alert, value: crossDirection, timestamp: new Date().toISOString() };
			}

			case "bollinger_squeeze": {
				const candles = await getCandles(condition.symbol, condition.timeframe, MIN_CANDLES_BOLLINGER + 50);
				const closes = sortedCloses(candles);
				if (closes.length < MIN_CANDLES_BOLLINGER) return null;

				const triggered = this.evaluateBollingerSqueeze(closes, condition.squeezePct);
				if (!triggered) return null;

				const bands = bollingerBands(closes);
				const lastUpper = bands.upper[bands.upper.length - 1];
				const lastLower = bands.lower[bands.lower.length - 1];
				const lastMiddle = bands.middle[bands.middle.length - 1];
				const bandwidthPct = lastMiddle > 0 ? ((lastUpper - lastLower) / lastMiddle) * 100 : 0;
				return { alert, value: r2(bandwidthPct), timestamp: new Date().toISOString() };
			}

			default:
				return null;
		}
	}

	// ── Indicator evaluators ──

	private evaluateRSI(closes: number[], threshold: number, direction: string): boolean {
		const values = rsi(closes, RSI_PERIOD);
		if (values.length === 0) return false;

		const current = values[values.length - 1];
		return direction === "above" ? current >= threshold : current <= threshold;
	}

	private evaluateVolume(volumes: number[], multiplier: number): boolean {
		if (volumes.length < VOLUME_AVG_LOOKBACK + 1) return false;

		// Average of the previous N candles (excluding the current one)
		const historical = volumes.slice(0, -1).slice(-VOLUME_AVG_LOOKBACK);
		const avgVolume = avg(historical);
		if (avgVolume <= 0) return false;

		const currentVolume = volumes[volumes.length - 1];
		return currentVolume >= avgVolume * multiplier;
	}

	private evaluateATR(highs: number[], lows: number[], closes: number[], multiplier: number): boolean {
		const values = atr(highs, lows, closes);
		if (values.length < 2) return false;

		// Compare current ATR to the average ATR over the lookback period
		const avgAtr = avg(values.slice(0, -1));
		if (avgAtr <= 0) return false;

		const currentAtr = values[values.length - 1];
		return currentAtr >= avgAtr * multiplier;
	}

	private evaluatePriceChange(
		closes: number[],
		targetPctChange: number,
		periodMinutes: number,
		candles: Candle[],
	): boolean {
		if (closes.length < 2) return false;

		const currentPrice = closes[closes.length - 1];
		const periodStartPrice = this.findPriceAtMinutesAgo(candles, periodMinutes);
		if (periodStartPrice <= 0) return false;

		const actualPct = ((currentPrice - periodStartPrice) / periodStartPrice) * 100;

		// For positive targetPctChange, trigger when price moved up at least that much.
		// For negative targetPctChange, trigger when price dropped at least that much.
		if (targetPctChange >= 0) {
			return actualPct >= targetPctChange;
		}
		return actualPct <= targetPctChange;
	}

	/**
	 * Detect MACD line crossing above/below the signal line on the most recent bar.
	 * Returns "bullish" for a cross above, "bearish" for a cross below, or null.
	 */
	private evaluateMACDCross(closes: number[]): "bullish" | "bearish" | null {
		const result = macd(closes);
		if (result.macd.length < 2 || result.signal.length < 2) return null;

		const len = result.macd.length;
		const prevDiff = result.macd[len - 2] - result.signal[len - 2];
		const currDiff = result.macd[len - 1] - result.signal[len - 1];

		// Cross from below to above = bullish
		if (prevDiff <= 0 && currDiff > 0) return "bullish";
		// Cross from above to below = bearish
		if (prevDiff >= 0 && currDiff < 0) return "bearish";

		return null;
	}

	/**
	 * Bollinger squeeze: bandwidth (upper - lower) / middle is unusually narrow.
	 * A squeeze indicates low volatility, often preceding a breakout.
	 */
	private evaluateBollingerSqueeze(closes: number[], squeezePct: number): boolean {
		const bands = bollingerBands(closes);
		if (bands.upper.length === 0) return false;

		const len = bands.upper.length;
		const lastUpper = bands.upper[len - 1];
		const lastLower = bands.lower[len - 1];
		const lastMiddle = bands.middle[len - 1];

		if (lastMiddle <= 0) return false;

		const bandwidthPct = ((lastUpper - lastLower) / lastMiddle) * 100;
		return bandwidthPct <= squeezePct;
	}

	// ── Helpers ──

	/**
	 * Find the close price from approximately `minutesAgo` in the past
	 * by searching candle timestamps.
	 */
	private findPriceAtMinutesAgo(candles: Candle[], minutesAgo: number): number {
		if (candles.length === 0) return 0;

		const targetTime = candles[candles.length - 1].openTime - minutesAgo * 60_000;
		let closest = candles[0];
		let closestDiff = Math.abs(candles[0].openTime - targetTime);

		for (const c of candles) {
			const diff = Math.abs(c.openTime - targetTime);
			if (diff < closestDiff) {
				closestDiff = diff;
				closest = c;
			}
		}

		return closest.close;
	}
}

// ── Module-level helpers ──

function defaultMessage(condition: AlertCondition): string {
	switch (condition.type) {
		case "rsi":
			return `RSI ${condition.direction} ${condition.threshold} on ${condition.symbol} (${condition.timeframe})`;
		case "volume_spike":
			return `Volume spike ${condition.multiplier}x average on ${condition.symbol} (${condition.timeframe})`;
		case "volatility":
			return `ATR volatility spike ${condition.atrMultiplier}x on ${condition.symbol} (${condition.timeframe})`;
		case "price_change":
			return `Price change ${condition.percentChange > 0 ? "+" : ""}${condition.percentChange}% in ${condition.periodMinutes}min on ${condition.symbol}`;
		case "macd_cross":
			return `MACD ${condition.direction} crossover on ${condition.symbol} (${condition.timeframe})`;
		case "bollinger_squeeze":
			return `Bollinger squeeze (bandwidth <= ${condition.squeezePct}%) on ${condition.symbol} (${condition.timeframe})`;
	}
}

/** Sort candles by openTime ascending and extract closes. */
function sortedCloses(candles: Candle[]): number[] {
	return sortByTime(candles).map((c) => c.close);
}

/** Sort candles by openTime ascending (CandleStore.get returns DESC). */
function sortByTime(candles: Candle[]): Candle[] {
	return [...candles].sort((a, b) => a.openTime - b.openTime);
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}
