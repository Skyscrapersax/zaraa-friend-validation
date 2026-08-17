/**
 * Market regime detector using a combination of:
 * 1. Trend identification via SMA crossover (50/200-day equivalent on daily bars)
 * 2. Volatility clustering (realized vol vs trailing median)
 * 3. Drawdown depth as regime confirmation
 *
 * Produces per-bar regime labels and aggregate regime statistics for any price series.
 */

import type { OHLCVBar } from "./multi-asset-fetcher.js";

export type RegimeLabel = "bull" | "bear" | "sideways" | "volatile";

export interface RegimeBar {
	date: string;
	timestamp: number;
	adjClose: number;
	regime: RegimeLabel;
	smaFast: number | null;
	smaSlow: number | null;
	realizedVol: number | null; // 20-day annualized
	drawdownFromPeak: number;   // 0 → -1
}

export interface RegimePeriod {
	regime: RegimeLabel;
	startDate: string;
	endDate: string;
	durationDays: number;
	returnPct: number;
	maxDrawdown: number;
	annualizedReturn: number;
	annualizedVol: number;
}

export interface RegimeSummary {
	symbol: string;
	totalDays: number;
	periods: RegimePeriod[];
	regimeStats: Record<RegimeLabel, {
		daysInRegime: number;
		pctOfTime: number;
		avgReturn: number;
		avgDuration: number;
		avgAnnVol: number;
		maxDrawdown: number;
	}>;
	bars: RegimeBar[];
}

const SMA_FAST = 50;
const SMA_SLOW = 200;
const VOL_WINDOW = 20;
/** Threshold: realized vol is "high" if above this multiple of its median */
const VOL_SPIKE_MULTIPLIER = 1.5;
/** Bear market threshold: drawdown from ATH */
const BEAR_DRAWDOWN = -0.15;
/** Sideways: fast SMA within this % of slow SMA */
const SIDEWAYS_BAND = 0.02;

export class RegimeDetector {
	/**
	 * Detect regimes for a price series.
	 * Requires adjClose prices only. Bars must be sorted ascending by date.
	 */
	detect(symbol: string, bars: OHLCVBar[]): RegimeSummary {
		if (bars.length < SMA_SLOW + 10) {
			throw new Error(
				`Insufficient data for ${symbol}: need ${SMA_SLOW + 10}+ bars, got ${bars.length}`,
			);
		}

		const closes = bars.map((b) => b.adjClose);
		const smaFast = this.rollingMean(closes, SMA_FAST);
		const smaSlow = this.rollingMean(closes, SMA_SLOW);
		const logReturns = this.logReturns(closes);
		const realizedVol = this.rollingVol(logReturns, VOL_WINDOW);

		// Drawdown from ATH
		const drawdowns = this.drawdownSeries(closes);

		// Median vol for spike detection
		const validVols = realizedVol.filter((v): v is number => v !== null);
		const medianVol = validVols.length > 0 ? this.median(validVols) : 0;

		const regimeBars: RegimeBar[] = bars.map((bar, i) => {
			const sf = smaFast[i];
			const ss = smaSlow[i];
			const rv = realizedVol[i];
			const dd = drawdowns[i];

			let regime: RegimeLabel;

			if (sf === null || ss === null) {
				// Not enough data yet — default to sideways
				regime = "sideways";
			} else if (rv !== null && rv > medianVol * VOL_SPIKE_MULTIPLIER && dd < BEAR_DRAWDOWN) {
				// High vol + deep drawdown = volatile/crash regime
				regime = "volatile";
			} else if (dd < BEAR_DRAWDOWN || sf < ss * (1 - SIDEWAYS_BAND * 2)) {
				// Below ATH threshold or fast well below slow = bear
				regime = "bear";
			} else if (sf > ss * (1 + SIDEWAYS_BAND)) {
				// Fast cleanly above slow = bull
				regime = "bull";
			} else {
				// SMAs close together = sideways/ranging
				regime = "sideways";
			}

			return {
				date: bar.date,
				timestamp: bar.timestamp,
				adjClose: bar.adjClose,
				regime,
				smaFast: sf,
				smaSlow: ss,
				realizedVol: rv,
				drawdownFromPeak: dd,
			};
		});

		const periods = this.extractPeriods(regimeBars, bars);
		const regimeStats = this.summarizeByRegime(periods, regimeBars.length);

		return { symbol, totalDays: bars.length, periods, regimeStats, bars: regimeBars };
	}

	/** Collapse consecutive same-regime bars into labeled periods */
	private extractPeriods(regimeBars: RegimeBar[], rawBars: OHLCVBar[]): RegimePeriod[] {
		if (regimeBars.length === 0) return [];

		const periods: RegimePeriod[] = [];
		let periodStart = 0;

		for (let i = 1; i <= regimeBars.length; i++) {
			const isLast = i === regimeBars.length;
			const changed = !isLast && regimeBars[i].regime !== regimeBars[periodStart].regime;

			if (changed || isLast) {
				const end = isLast ? i - 1 : i - 1;
				const startBar = regimeBars[periodStart];
				const endBar = regimeBars[end];

				const startPrice = rawBars[periodStart].adjClose;
				const endPrice = rawBars[end].adjClose;
				const returnPct = (endPrice - startPrice) / startPrice;
				const durationDays = end - periodStart + 1;

				// Annualized return & vol for this period
				const periodReturns = rawBars
					.slice(periodStart, end + 1)
					.map((b) => b.adjClose);
				const annRet = this.annualizeReturn(returnPct, durationDays);
				const logRets = this.logReturns(periodReturns);
				const annVol = logRets.length > 1
					? this.stdDev(logRets) * Math.sqrt(252)
					: 0;

				const maxDD = Math.min(
					...regimeBars.slice(periodStart, end + 1).map((b) => b.drawdownFromPeak),
				);

				periods.push({
					regime: startBar.regime,
					startDate: startBar.date,
					endDate: endBar.date,
					durationDays,
					returnPct,
					maxDrawdown: maxDD,
					annualizedReturn: annRet,
					annualizedVol: annVol,
				});

				periodStart = i;
			}
		}

		return periods;
	}

	private summarizeByRegime(
		periods: RegimePeriod[],
		totalBars: number,
	): RegimeSummary["regimeStats"] {
		const labels: RegimeLabel[] = ["bull", "bear", "sideways", "volatile"];
		const stats = {} as RegimeSummary["regimeStats"];

		for (const label of labels) {
			const ps = periods.filter((p) => p.regime === label);
			const daysInRegime = ps.reduce((s, p) => s + p.durationDays, 0);

			stats[label] = {
				daysInRegime,
				pctOfTime: totalBars > 0 ? daysInRegime / totalBars : 0,
				avgReturn: ps.length > 0
					? ps.reduce((s, p) => s + p.annualizedReturn, 0) / ps.length
					: 0,
				avgDuration: ps.length > 0
					? ps.reduce((s, p) => s + p.durationDays, 0) / ps.length
					: 0,
				avgAnnVol: ps.length > 0
					? ps.reduce((s, p) => s + p.annualizedVol, 0) / ps.length
					: 0,
				maxDrawdown: ps.length > 0
					? Math.min(...ps.map((p) => p.maxDrawdown))
					: 0,
			};
		}

		return stats;
	}

	// ── Math utilities ────────────────────────────────────────────────────────

	private rollingMean(data: number[], window: number): (number | null)[] {
		return data.map((_, i) => {
			if (i < window - 1) return null;
			const slice = data.slice(i - window + 1, i + 1);
			return slice.reduce((a, b) => a + b, 0) / window;
		});
	}

	private logReturns(prices: number[]): number[] {
		const out: number[] = [];
		for (let i = 1; i < prices.length; i++) {
			if (prices[i - 1] > 0 && prices[i] > 0) {
				out.push(Math.log(prices[i] / prices[i - 1]));
			} else {
				out.push(0);
			}
		}
		return out;
	}

	/** Rolling annualized volatility (std of log returns * sqrt(252)) */
	private rollingVol(logRets: number[], window: number): (number | null)[] {
		// logRets is one element shorter than prices — index i here = bar i+1 in prices
		return logRets.map((_, i) => {
			if (i < window - 1) return null;
			const slice = logRets.slice(i - window + 1, i + 1);
			return this.stdDev(slice) * Math.sqrt(252);
		});
	}

	/** Max drawdown from ATH at each bar (value in [−1, 0]) */
	private drawdownSeries(prices: number[]): number[] {
		let peak = -Infinity;
		return prices.map((p) => {
			if (p > peak) peak = p;
			return peak > 0 ? (p - peak) / peak : 0;
		});
	}

	private stdDev(values: number[]): number {
		if (values.length === 0) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
		return Math.sqrt(variance);
	}

	private median(values: number[]): number {
		const sorted = [...values].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0
			? (sorted[mid - 1] + sorted[mid]) / 2
			: sorted[mid];
	}

	private annualizeReturn(returnPct: number, days: number): number {
		if (days <= 0) return 0;
		return (1 + returnPct) ** (252 / days) - 1;
	}
}
