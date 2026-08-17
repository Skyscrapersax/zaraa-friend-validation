/**
 * Orchestrates Yahoo multi-asset fetch, SPY regime labels, feature construction,
 * walk-forward logistic evaluation, and a live directional probability for each target.
 */

import { getPredictor } from "./predict-bridge.js";
import { CrossAssetAnalyzer } from "./cross-asset-analyzer.js";
import { RegimeDetector, type RegimeLabel } from "./regime-detector.js";
import { DEFAULT_UNIVERSE, MultiAssetFetcher } from "./multi-asset-fetcher.js";
import {
	mineMacroPatternEdges,
	type MacroPatternEdge,
} from "./macro-pattern-miner.js";
import {
	MACRO_FEATURE_NAMES,
	alignAssetSeries,
	buildLiveFeatureRow,
	buildMacroFeatureMatrix,
} from "./pattern-feature-engine.js";
import {
	normalizeSingleRow,
	runWalkForward,
	trainFullSample,
	predictProba,
	type WalkForwardConfig,
} from "./walk-forward-predictor.js";

export interface MacroPredictionTargetResult {
	symbol: string;
	walkForwardMeanAccuracy: number;
	walkForwardMeanBaseline: number;
	accuracyLiftVsBaseline: number;
	foldCount: number;
	liveAsOfDate: string | null;
	probUpNextHorizon: number | null;
	predictedDirection: "up" | "down" | null;
	featureImportanceTop5: { name: string; meanAbsWeight: number }[];
	topPatternEdges: MacroPatternEdge[];
}

export interface MacroPredictionReport {
	generatedAt: string;
	dataSource: string;
	sourcesUsed: string[];
	seriesSources: Record<string, string[]>;
	fetchErrors: { symbol: string; error: string }[];
	horizonDays: number;
	period: { start: string; end: string; days: number };
	crossAssetSummary: {
		profiles: { symbol: string; cagr: number; maxDrawdown: number; sharpeRatio: number }[];
	};
	targets: MacroPredictionTargetResult[];
	notes: string[];
}

const DEFAULT_HORIZON = 20;
const DEFAULT_YEARS = 10;

export interface RunMacroPredictionOptions {
	symbols?: string[];
	/** Calendar years of history to request from Yahoo (default 10) */
	years?: number;
	horizonDays?: number;
	walkForward?: Partial<WalkForwardConfig>;
}

export async function runMacroPredictionReport(
	options: RunMacroPredictionOptions = {},
): Promise<MacroPredictionReport> {
	const rustPredictor = await getPredictor();
	if (rustPredictor) {
		try {
			const reportJson = await rustPredictor.fullReport(String(options.horizonDays ?? 20));
			return JSON.parse(reportJson) as MacroPredictionReport;
		} catch (e) {
			console.warn("[predict] Rust predictor failed, falling back to TS:", e);
		}
	}
	// TS pipeline fallback continues below
	const symbols = options.symbols?.length
		? options.symbols
		: [...DEFAULT_UNIVERSE.symbols];
	const years = options.years ?? DEFAULT_YEARS;
	const horizon = options.horizonDays ?? DEFAULT_HORIZON;
	const wfConfig = options.walkForward ?? {};

	const to = new Date();
	const from = new Date();
	from.setFullYear(from.getFullYear() - years);

	const fetcher = new MultiAssetFetcher();
	const { series, errors, fetchedAt, sourcesUsed, seriesSources } = await fetcher.fetchAll(symbols, from, to);

	const notes: string[] = [
		"Logistic model predicts probability that forward log return over the horizon is positive.",
		"Walk-forward uses expanding windows; baseline is majority-class on the training slice.",
		"History is fetched from Yahoo daily bars and backfilled with normalized proxies when the requested window predates the target ticker's own inception.",
		"Top pattern edges are descriptive conditional signals mined from the same history and are best used for feature discovery, not as standalone trading rules.",
	];

	if (series.length < 2) {
		return {
			generatedAt: fetchedAt,
			dataSource: sourcesUsed.join(",") || "yahoo_finance_v8",
			sourcesUsed,
			seriesSources,
			fetchErrors: errors,
			horizonDays: horizon,
			period: { start: "", end: "", days: 0 },
			crossAssetSummary: { profiles: [] },
			targets: [],
			notes: [...notes, "Insufficient series after fetch — need at least 2 symbols."],
		};
	}

	const panel = alignAssetSeries(series);
	const spySeries = series.find((s) => s.symbol === "SPY");
	if (!spySeries) {
		notes.push("SPY missing: regime and spy_sma_spread features degraded (zeros).");
	}

	let regimeByDate = new Map<string, RegimeLabel>();
	if (spySeries && spySeries.bars.length >= 210) {
		const det = new RegimeDetector();
		const summary = det.detect("SPY", spySeries.bars);
		regimeByDate = new Map(summary.bars.map((b) => [b.date, b.regime]));
	}

	const regimesForCross = spySeries && spySeries.bars.length >= 210
		? [new RegimeDetector().detect("SPY", spySeries.bars)]
		: [];

	const cross = new CrossAssetAnalyzer().analyze(series, regimesForCross);

	const targets: MacroPredictionTargetResult[] = [];

	for (const sym of series.map((s) => s.symbol)) {
		let built: ReturnType<typeof buildMacroFeatureMatrix>;
		try {
			built = buildMacroFeatureMatrix(panel, regimeByDate, sym, horizon);
			const { X } = built;
			if (X.length < (wfConfig.minTrainRows ?? 400) + 50) {
				targets.push({
					symbol: sym,
					walkForwardMeanAccuracy: 0,
					walkForwardMeanBaseline: 0,
					accuracyLiftVsBaseline: 0,
					foldCount: 0,
					liveAsOfDate: null,
					probUpNextHorizon: null,
					predictedDirection: null,
					featureImportanceTop5: [],
					topPatternEdges: [],
				});
				continue;
			}
		} catch {
			targets.push({
				symbol: sym,
				walkForwardMeanAccuracy: 0,
				walkForwardMeanBaseline: 0,
				accuracyLiftVsBaseline: 0,
				foldCount: 0,
				liveAsOfDate: null,
				probUpNextHorizon: null,
				predictedDirection: null,
				featureImportanceTop5: [],
				topPatternEdges: [],
			});
			continue;
		}

		const { X, y, forwardLogRet, datesRow } = built;
		const wf = runWalkForward(X, y, MACRO_FEATURE_NAMES, wfConfig);
		const live = buildLiveFeatureRow(panel, regimeByDate, sym);
		const topPatternEdges = mineMacroPatternEdges({
			X,
			y,
			forwardLogRet,
			datesRow,
			liveRow: live?.row,
			liveDate: live?.date,
			maxPatterns: 3,
			minSample: Math.max(25, Math.floor(X.length * 0.08)),
		});

		let prob: number | null = null;
		let dir: "up" | "down" | null = null;
		let liveDate: string | null = null;

		if (live && X.length >= 50) {
			const full = trainFullSample(X, y, wfConfig);
			const xn = normalizeSingleRow(live.row, full.mean, full.std);
			prob = predictProba(full.w, full.b, xn);
			dir = prob >= 0.5 ? "up" : "down";
			liveDate = live.date;
		}

		targets.push({
			symbol: sym,
			walkForwardMeanAccuracy: wf.meanAccuracy,
			walkForwardMeanBaseline: wf.meanBaseline,
			accuracyLiftVsBaseline: wf.meanAccuracy - wf.meanBaseline,
			foldCount: wf.folds.length,
			liveAsOfDate: liveDate,
			probUpNextHorizon: prob,
			predictedDirection: dir,
			featureImportanceTop5: wf.featureImportance.slice(0, 5),
			topPatternEdges,
		});
	}

	return {
		generatedAt: fetchedAt,
		dataSource: sourcesUsed.join(",") || "yahoo_finance_v8",
		sourcesUsed,
		seriesSources,
		fetchErrors: errors,
		horizonDays: horizon,
		period: {
			start: panel.dates[0] ?? "",
			end: panel.dates[panel.dates.length - 1] ?? "",
			days: panel.dates.length,
		},
		crossAssetSummary: {
			profiles: cross.profiles.map((p) => ({
				symbol: p.symbol,
				cagr: p.cagr,
				maxDrawdown: p.maxDrawdown,
				sharpeRatio: p.sharpeRatio,
			})),
		},
		targets,
		notes,
	};
}
