/**
 * Builds supervised-learning feature rows from aligned multi-asset daily closes.
 * Encodes: momentum/vol for the target, SPY trend (50/200), cross-asset ratios
 * (gold/silver, BTC/gold), Bitcoin halving cycle phase (sin/cos), and SPY regime.
 */

import type { AssetSeries } from "./multi-asset-fetcher.js";
import type { RegimeLabel } from "./regime-detector.js";

/** Approximate Bitcoin halving dates (UTC). */
export const BTC_HALVING_ISO_DATES = [
	"2012-11-28",
	"2016-07-09",
	"2020-05-11",
	"2024-04-20",
] as const;

const HALVING_MS = BTC_HALVING_ISO_DATES.map((d) => new Date(`${d}T00:00:00Z`).getTime());

const REGIME_ORDER: RegimeLabel[] = ["bull", "bear", "sideways", "volatile"];

export const MACRO_FEATURE_NAMES = [
	"target_ret_1d",
	"target_ret_5d",
	"target_ret_20d",
	"target_vol_20d",
	"spy_sma_spread",
	"log_gld_slv_ratio_5d",
	"log_btc_gld_ratio_5d",
	"halving_sin",
	"halving_cos",
	"regime_bull",
	"regime_bear",
	"regime_sideways",
	"regime_volatile",
] as const;

export type MacroFeatureName = (typeof MACRO_FEATURE_NAMES)[number];

export interface AlignedPanel {
	dates: string[];
	prices: Record<string, number[]>;
	symbols: string[];
}

/**
 * Align series to intersection of trading dates (same logic as CrossAssetAnalyzer).
 */
export function alignAssetSeries(series: AssetSeries[]): AlignedPanel {
	if (series.length === 0) throw new Error("No series to align");

	const dateSets = series.map((s) => new Set(s.bars.map((b) => b.date)));
	let common = [...dateSets[0]];
	for (let i = 1; i < dateSets.length; i++) {
		common = common.filter((d) => dateSets[i].has(d));
	}
	common.sort();

	const prices: Record<string, number[]> = {};
	const symbols: string[] = [];

	for (const s of series) {
		const barMap = new Map(s.bars.map((b) => [b.date, b.adjClose]));
		const p = common.map((d) => barMap.get(d)).filter((v): v is number => v != null && v > 0);
		if (p.length !== common.length) {
			throw new Error(`Alignment mismatch for ${s.symbol}`);
		}
		prices[s.symbol] = p;
		symbols.push(s.symbol);
	}

	return { dates: common, prices, symbols };
}

/** Whole months since last halving (calendar months, UTC). */
export function monthsSinceLastHalving(dateIso: string): number {
	const t = new Date(`${dateIso}T00:00:00Z`).getTime();
	let last = HALVING_MS[0];
	for (const h of HALVING_MS) {
		if (h <= t) last = h;
	}
	const d0 = new Date(last);
	const d1 = new Date(t);
	return (
		(d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 +
		(d1.getUTCMonth() - d0.getUTCMonth())
	);
}

function rollingSma(values: number[], window: number): (number | null)[] {
	return values.map((_, i) => {
		if (i < window - 1) return null;
		let s = 0;
		for (let j = i - window + 1; j <= i; j++) s += values[j];
		return s / window;
	});
}

function logRet(prices: number[], i: number, lag: number): number {
	const j = i - lag;
	if (j < 0 || prices[j] <= 0 || prices[i] <= 0) return 0;
	return Math.log(prices[i] / prices[j]);
}

function rollingVol20(prices: number[], i: number): number {
	if (i < 20) return 0;
	const rets: number[] = [];
	for (let k = i - 19; k <= i; k++) {
		if (prices[k - 1] > 0 && prices[k] > 0) {
			rets.push(Math.log(prices[k] / prices[k - 1]));
		}
	}
	if (rets.length < 5) return 0;
	const m = rets.reduce((a, b) => a + b, 0) / rets.length;
	const v = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / rets.length) * Math.sqrt(252);
	return v;
}

function ratioLogChange(
	pricesA: number[] | undefined,
	pricesB: number[] | undefined,
	i: number,
	lag: number,
): number {
	if (!pricesA || !pricesB) return 0;
	const j = i - lag;
	if (j < 0 || pricesA[i] <= 0 || pricesB[i] <= 0 || pricesA[j] <= 0 || pricesB[j] <= 0) return 0;
	const rNow = Math.log(pricesA[i] / pricesB[i]);
	const rPast = Math.log(pricesA[j] / pricesB[j]);
	return rNow - rPast;
}

function regimeOneHot(regime: RegimeLabel | undefined): number[] {
	return REGIME_ORDER.map((r) => (regime === r ? 1 : 0));
}

export interface FeatureBuildResult {
	/** Row-aligned with y / datesRow */
	X: number[][];
	y: number[];
	/** Date for each row (the "as-of" date for features); label is forward return from this close */
	datesRow: string[];
	/** Index in panel.dates for each row */
	indices: number[];
	/** Forward log return over horizon (same length as y) */
	forwardLogRet: number[];
}

const WARMUP = 200; // SMA200 + headroom

/**
 * Build X, y for walk-forward training. Rows use panel index i where i + horizon < n.
 */
export function buildMacroFeatureMatrix(
	panel: AlignedPanel,
	regimeByDate: Map<string, RegimeLabel>,
	targetSymbol: string,
	horizon: number,
): FeatureBuildResult {
	const { dates, prices } = panel;
	const n = dates.length;
	const pt = prices[targetSymbol];
	if (!pt) throw new Error(`Target symbol ${targetSymbol} not in panel`);

	const spy = prices["SPY"];
	const gld = prices["GLD"];
	const slv = prices["SLV"];
	const btc = prices["BTC-USD"];

	const sma50 = spy ? rollingSma(spy, 50) : null;
	const sma200 = spy ? rollingSma(spy, 200) : null;

	const X: number[][] = [];
	const y: number[] = [];
	const datesRow: string[] = [];
	const indices: number[] = [];
	const forwardLogRet: number[] = [];

	for (let i = WARMUP; i + horizon < n; i++) {
		if (pt[i] <= 0 || pt[i + horizon] <= 0) continue;

		const fLog = Math.log(pt[i + horizon] / pt[i]);
		const regime = regimeByDate.get(dates[i]);

		let spySpread = 0;
		if (sma50 && sma200 && sma50[i] != null && sma200[i] != null && sma200[i]! > 0) {
			spySpread = (sma50[i]! - sma200[i]!) / sma200[i]!;
		}

		const m = monthsSinceLastHalving(dates[i]);
		const phase = (2 * Math.PI * (m % 48)) / 48;

		const row: number[] = [
			logRet(pt, i, 1),
			logRet(pt, i, 5),
			logRet(pt, i, 20),
			rollingVol20(pt, i),
			spySpread,
			ratioLogChange(gld, slv, i, 5),
			ratioLogChange(btc, gld, i, 5),
			Math.sin(phase),
			Math.cos(phase),
			...regimeOneHot(regime),
		];

		X.push(row);
		y.push(fLog > 0 ? 1 : 0);
		datesRow.push(dates[i]);
		indices.push(i);
		forwardLogRet.push(fLog);
	}

	return { X, y, datesRow, indices, forwardLogRet };
}

/**
 * Feature vector at the last bar (for live directional probability). No label.
 */
export function buildLiveFeatureRow(
	panel: AlignedPanel,
	regimeByDate: Map<string, RegimeLabel>,
	targetSymbol: string,
): { row: number[]; date: string } | null {
	const { dates, prices } = panel;
	const n = dates.length;
	const last = n - 1;
	if (last < WARMUP) return null;

	const pt = prices[targetSymbol];
	if (!pt) return null;

	const spy = prices["SPY"];
	const gld = prices["GLD"];
	const slv = prices["SLV"];
	const btc = prices["BTC-USD"];

	const sma50 = spy ? rollingSma(spy, 50) : null;
	const sma200 = spy ? rollingSma(spy, 200) : null;

	let spySpread = 0;
	if (sma50 && sma200 && sma50[last] != null && sma200[last] != null && sma200[last]! > 0) {
		spySpread = (sma50[last]! - sma200[last]!) / sma200[last]!;
	}

	const m = monthsSinceLastHalving(dates[last]);
	const phase = (2 * Math.PI * (m % 48)) / 48;
	const regime = regimeByDate.get(dates[last]);

	const row: number[] = [
		logRet(pt, last, 1),
		logRet(pt, last, 5),
		logRet(pt, last, 20),
		rollingVol20(pt, last),
		spySpread,
		ratioLogChange(gld, slv, last, 5),
		ratioLogChange(btc, gld, last, 5),
		Math.sin(phase),
		Math.cos(phase),
		...regimeOneHot(regime),
	];

	return { row, date: dates[last] };
}
