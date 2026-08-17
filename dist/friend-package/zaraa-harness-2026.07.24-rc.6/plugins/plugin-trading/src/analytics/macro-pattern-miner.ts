import { MACRO_FEATURE_NAMES, monthsSinceLastHalving } from "./pattern-feature-engine.js";

export interface MacroPatternEdge {
	label: string;
	sampleSize: number;
	hitRate: number;
	baselineHitRate: number;
	uplift: number;
	avgForwardReturn: number;
	currentMatch: boolean;
	direction: "bullish" | "bearish";
	strength: "weak" | "moderate" | "strong";
}

export interface MineMacroPatternOptions {
	X: number[][];
	y: number[];
	forwardLogRet: number[];
	datesRow: string[];
	liveRow?: number[] | null;
	liveDate?: string | null;
	maxPatterns?: number;
	minSample?: number;
}

interface PatternDefinition {
	label: string;
	matches: (row: number[], rowIdx: number) => boolean;
	liveMatches: (row: number[] | null | undefined, liveDate: string | null | undefined) => boolean;
}

const IDX = Object.fromEntries(
	MACRO_FEATURE_NAMES.map((name, idx) => [name, idx]),
) as Record<(typeof MACRO_FEATURE_NAMES)[number], number>;

function quantile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const clamped = Math.min(1, Math.max(0, q));
	const pos = (sorted.length - 1) * clamped;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	const weight = pos - lo;
	return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function strengthFrom(uplift: number, sampleSize: number): MacroPatternEdge["strength"] {
	const absUplift = Math.abs(uplift);
	if (absUplift >= 0.12 && sampleSize >= 40) return "strong";
	if (absUplift >= 0.06 && sampleSize >= 25) return "moderate";
	return "weak";
}

function halvingBucket(months: number): "early" | "mid" | "late" | "reset" {
	if (months < 12) return "early";
	if (months < 24) return "mid";
	if (months < 36) return "late";
	return "reset";
}

export function mineMacroPatternEdges(
	options: MineMacroPatternOptions,
): MacroPatternEdge[] {
	const {
		X,
		y,
		forwardLogRet,
		datesRow,
		liveRow,
		liveDate,
		maxPatterns = 3,
		minSample = 30,
	} = options;

	if (X.length === 0 || y.length !== X.length || forwardLogRet.length !== X.length || datesRow.length !== X.length) {
		return [];
	}

	const volValues = X.map((row) => row[IDX.target_vol_20d]);
	const lowVolThreshold = quantile(volValues, 0.33);
	const highVolThreshold = quantile(volValues, 0.67);
	const baselineHitRate = y.reduce((sum, label) => sum + label, 0) / y.length;

	const definitions: PatternDefinition[] = [
		{
			label: "Target 20d momentum positive",
			matches: (row) => row[IDX.target_ret_20d] > 0,
			liveMatches: (row) => (row?.[IDX.target_ret_20d] ?? 0) > 0,
		},
		{
			label: "Target 20d momentum negative",
			matches: (row) => row[IDX.target_ret_20d] < 0,
			liveMatches: (row) => (row?.[IDX.target_ret_20d] ?? 0) < 0,
		},
		{
			label: "Target volatility compressed",
			matches: (row) => row[IDX.target_vol_20d] <= lowVolThreshold,
			liveMatches: (row) => (row?.[IDX.target_vol_20d] ?? 0) <= lowVolThreshold,
		},
		{
			label: "Target volatility elevated",
			matches: (row) => row[IDX.target_vol_20d] >= highVolThreshold,
			liveMatches: (row) => (row?.[IDX.target_vol_20d] ?? 0) >= highVolThreshold,
		},
		{
			label: "SPY trend spread positive",
			matches: (row) => row[IDX.spy_sma_spread] > 0,
			liveMatches: (row) => (row?.[IDX.spy_sma_spread] ?? 0) > 0,
		},
		{
			label: "SPY trend spread negative",
			matches: (row) => row[IDX.spy_sma_spread] < 0,
			liveMatches: (row) => (row?.[IDX.spy_sma_spread] ?? 0) < 0,
		},
		{
			label: "Gold outperforming silver",
			matches: (row) => row[IDX.log_gld_slv_ratio_5d] > 0,
			liveMatches: (row) => (row?.[IDX.log_gld_slv_ratio_5d] ?? 0) > 0,
		},
		{
			label: "Silver outperforming gold",
			matches: (row) => row[IDX.log_gld_slv_ratio_5d] < 0,
			liveMatches: (row) => (row?.[IDX.log_gld_slv_ratio_5d] ?? 0) < 0,
		},
		{
			label: "Bitcoin outperforming gold",
			matches: (row) => row[IDX.log_btc_gld_ratio_5d] > 0,
			liveMatches: (row) => (row?.[IDX.log_btc_gld_ratio_5d] ?? 0) > 0,
		},
		{
			label: "Gold outperforming bitcoin",
			matches: (row) => row[IDX.log_btc_gld_ratio_5d] < 0,
			liveMatches: (row) => (row?.[IDX.log_btc_gld_ratio_5d] ?? 0) < 0,
		},
		{
			label: "SPY bull regime",
			matches: (row) => row[IDX.regime_bull] === 1,
			liveMatches: (row) => row?.[IDX.regime_bull] === 1,
		},
		{
			label: "SPY bear regime",
			matches: (row) => row[IDX.regime_bear] === 1,
			liveMatches: (row) => row?.[IDX.regime_bear] === 1,
		},
		{
			label: "SPY sideways regime",
			matches: (row) => row[IDX.regime_sideways] === 1,
			liveMatches: (row) => row?.[IDX.regime_sideways] === 1,
		},
		{
			label: "SPY volatile regime",
			matches: (row) => row[IDX.regime_volatile] === 1,
			liveMatches: (row) => row?.[IDX.regime_volatile] === 1,
		},
		{
			label: "Bitcoin halving cycle early phase",
			matches: (_row, rowIdx) => halvingBucket(monthsSinceLastHalving(datesRow[rowIdx])) === "early",
			liveMatches: (_row, date) => date != null && halvingBucket(monthsSinceLastHalving(date)) === "early",
		},
		{
			label: "Bitcoin halving cycle mid phase",
			matches: (_row, rowIdx) => halvingBucket(monthsSinceLastHalving(datesRow[rowIdx])) === "mid",
			liveMatches: (_row, date) => date != null && halvingBucket(monthsSinceLastHalving(date)) === "mid",
		},
		{
			label: "Bitcoin halving cycle late phase",
			matches: (_row, rowIdx) => halvingBucket(monthsSinceLastHalving(datesRow[rowIdx])) === "late",
			liveMatches: (_row, date) => date != null && halvingBucket(monthsSinceLastHalving(date)) === "late",
		},
		{
			label: "Bitcoin halving cycle reset phase",
			matches: (_row, rowIdx) => halvingBucket(monthsSinceLastHalving(datesRow[rowIdx])) === "reset",
			liveMatches: (_row, date) => date != null && halvingBucket(monthsSinceLastHalving(date)) === "reset",
		},
	];

	const mined = definitions
		.map((definition) => {
			const matchedRows = X.map((row, idx) => ({ row, idx }))
				.filter(({ row, idx }) => definition.matches(row, idx));
			if (matchedRows.length < minSample) return null;

			const sampleIdx = matchedRows.map(({ idx }) => idx);
			const hitRate = sampleIdx.reduce((sum, idx) => sum + y[idx], 0) / sampleIdx.length;
			const avgForwardReturn = sampleIdx.reduce((sum, idx) => sum + forwardLogRet[idx], 0) / sampleIdx.length;
			const uplift = hitRate - baselineHitRate;

			return {
				label: definition.label,
				sampleSize: sampleIdx.length,
				hitRate,
				baselineHitRate,
				uplift,
				avgForwardReturn,
				currentMatch: definition.liveMatches(liveRow, liveDate),
				direction: uplift >= 0 ? "bullish" : "bearish",
				strength: strengthFrom(uplift, sampleIdx.length),
				score: Math.abs(uplift) * Math.sqrt(sampleIdx.length),
			};
		})
		.filter((edge): edge is MacroPatternEdge & { score: number } => edge != null)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxPatterns)
		.map(({ score: _score, ...edge }) => edge);

	return mined;
}
