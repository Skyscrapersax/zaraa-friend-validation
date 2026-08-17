import type { Candle } from "../data/candle-store.js";
import type { Strategy, StrategyRiskParams } from "../strategies/strategy.js";
import { Backtester, type BacktestConfig } from "../backtest/backtester.js";
import type { TrialsLedger, TrialsGateResult } from "../risk/trials-ledger.js";
import { deflatedSharpeGate } from "../risk/deflated-sharpe.js";
import {
	computeNetEdgeGate,
	type NetEdgeGateInput,
	type NetEdgeGateResult,
} from "../cost/net-edge-gate.js";

export interface OptimizerParams extends StrategyRiskParams {}

export interface ParameterSetResult {
	params: OptimizerParams;
	sharpeRatio: number;
	winRate: number;
	maxDrawdownPct: number;
	totalPnl: number;
	tradeCount: number;
	rank: number;
}

export interface OptimizerGate {
	/** Combined verdict: deflated-Sharpe AND (net-edge if evaluated). */
	pass: boolean;
	reasons: string[];
}

export interface StrategyOptimizerOptions {
	/**
	 * Shared, append-only trials ledger (D14). When present, every variant is
	 * recorded and the deflated-Sharpe gate uses the CUMULATIVE N across runs,
	 * crash-resumes, and peer agents — not this run's grid size.
	 */
	trialsLedger?: TrialsLedger;
	/** Identifies this agent/process in the ledger (peer-aware N). */
	agentId?: string;
	/** Conservative minimum deflated Sharpe required to pass the gate (default 0.5). */
	deflatedMinSharpe?: number;
	/** Cost inputs for the net-edge gate (D1). Omit to skip net-edge evaluation. */
	netEdgeInputs?: Omit<NetEdgeGateInput, "grossEdgeBps">;
}

export interface OptimizationRun {
	strategyName: string;
	candlesUsed: number;
	paramsTestedCount: number;
	top3: ParameterSetResult[];
	/** D14: cumulative trials recorded for this strategy (ledger) or this run's grid size. */
	trialsEvaluatedTotal: number;
	/** D14: deflated-Sharpe (multiple-testing) gate on the top pick. */
	deflatedSharpe: TrialsGateResult;
	/** D1: net-edge gate on the top pick — present only when cost inputs were supplied. */
	netEdge?: NetEdgeGateResult;
	/** Combined promotion gate verdict. */
	gate: OptimizerGate;
}

// Parameter search space — vary riskParams that directly affect backtester exit logic
const STOP_LOSS_ATR_VARIANTS = [1.0, 1.5, 2.0, 2.5];
const TAKE_PROFIT_RATIO_VARIANTS = [1.5, 2.0, 2.5, 3.0];
const RISK_PER_TRADE_VARIANTS = [0.5, 1.0, 1.5, 2.0];

function createVariant(base: Strategy, params: OptimizerParams): Strategy {
	// Pre-build the bound `this` target ONCE per param set so every per-bar
	// evaluate() call reuses it instead of shallow-cloning the strategy object
	// on every bar (64 * N clones -> 64 clones per optimize run). Builtin
	// strategies read `this.riskParams.*` only, so the single shared target is
	// observationally identical to re-cloning each bar.
	const bound = { ...base, riskParams: { ...params } };
	return {
		...base,
		riskParams: bound.riskParams,
		// Rebind so `this.riskParams` still resolves inside evaluate()
		evaluate: (candles, indicators) => base.evaluate.call(bound, candles, indicators),
	};
}

export class StrategyOptimizer {
	private backtester: Backtester;
	private opts: StrategyOptimizerOptions;

	constructor(backtestConfig: Partial<BacktestConfig> = {}, opts: StrategyOptimizerOptions = {}) {
		this.backtester = new Backtester({ startingEquity: 10_000, ...backtestConfig });
		this.opts = opts;
	}

	run(strategy: Strategy, candles: Candle[]): OptimizationRun {
		const results: Omit<ParameterSetResult, "rank">[] = [];
		const symbol = candles[0]?.symbol ?? "";
		const windowStart = candles[0]?.openTime ?? 0;
		const windowEnd = candles[candles.length - 1]?.openTime ?? 0;
		const evaluatedAt = Date.now();

		for (const sl of STOP_LOSS_ATR_VARIANTS) {
			for (const tp of TAKE_PROFIT_RATIO_VARIANTS) {
				for (const risk of RISK_PER_TRADE_VARIANTS) {
					const params: OptimizerParams = {
						stopLossAtrMultiplier: sl,
						takeProfitRatio: tp,
						riskPerTradePct: risk,
					};
					const variant = createVariant(strategy, params);
					const result = this.backtester.run(variant, candles);
					const { sharpeRatio, winRate, maxDrawdownPct, totalPnl, totalTrades } = result.performance;
					results.push({ params, sharpeRatio, winRate, maxDrawdownPct, totalPnl, tradeCount: totalTrades });

					// D14: record every evaluated variant to the shared, append-only ledger.
					this.opts.trialsLedger?.record({
						strategyName: strategy.name,
						paramsHash: `${sl}-${tp}-${risk}`,
						symbol,
						windowStart,
						windowEnd,
						agentId: this.opts.agentId,
						backtestSharpe: sharpeRatio,
						evaluatedAt,
					});
				}
			}
		}

		// Primary sort: Sharpe ratio descending. Tiebreaker: win rate descending.
		results.sort((a, b) => {
			if (b.sharpeRatio !== a.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
			return b.winRate - a.winRate;
		});

		const top3: ParameterSetResult[] = results.slice(0, 3).map((r, i) => ({ ...r, rank: i + 1 }));
		const top = top3[0];
		const ledger = this.opts.trialsLedger;

		// D14: deflated-Sharpe gate. Cumulative N from the ledger when present
		// (peer-shared, crash-resilient), else this run's grid size.
		const deflatedSharpe: TrialsGateResult = ledger
			? ledger.gate({
					strategyName: strategy.name,
					rawSharpe: top?.sharpeRatio ?? 0,
					nObs: top?.tradeCount ?? 0,
					minDeflatedSharpe: this.opts.deflatedMinSharpe,
				})
			: {
					...deflatedSharpeGate({
						rawSharpe: top?.sharpeRatio ?? 0,
						nTrials: results.length,
						nObs: top?.tradeCount ?? 0,
						minDeflatedSharpe: this.opts.deflatedMinSharpe,
					}),
					nTrials: results.length,
				};

		const trialsEvaluatedTotal = ledger ? ledger.count(strategy.name) : results.length;

		// D1: net-edge gate — only when cost inputs are supplied. grossEdgeBps is a
		// proxy: average per-trade PnL over the assumed per-trade notional.
		let netEdge: NetEdgeGateResult | undefined;
		if (this.opts.netEdgeInputs && top) {
			const notional = this.opts.netEdgeInputs.avgTradeNotionalUsd;
			const grossEdgeBps =
				top.tradeCount > 0 && notional > 0
					? (top.totalPnl / top.tradeCount / notional) * 10_000
					: 0;
			netEdge = computeNetEdgeGate({ grossEdgeBps, ...this.opts.netEdgeInputs });
		}

		const reasons = [deflatedSharpe.reason];
		if (netEdge) reasons.push(netEdge.reason);
		const gate: OptimizerGate = {
			pass: deflatedSharpe.pass && (netEdge ? netEdge.pass : true),
			reasons,
		};

		return {
			strategyName: strategy.name,
			candlesUsed: candles.length,
			paramsTestedCount: results.length,
			top3,
			trialsEvaluatedTotal,
			deflatedSharpe,
			netEdge,
			gate,
		};
	}
}
