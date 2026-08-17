import type { ArbitrageCycle } from "./bellman-ford.js";
import {
	findBestExecutableRouteSize,
	simulateExecutableRoute,
	type BestExecutableRouteOptions,
	type ExecutableRoute,
	type ExecutableRouteCostModel,
	type ExecutableRouteSimulation,
} from "./executable-route.js";

export interface RescoreArbitrageCycleOptions {
	amountIn?: number;
	maxInput?: number;
	probeInputs?: number[];
	geometricSteps?: number;
	refinementSteps?: number;
	costs?: ExecutableRouteCostModel;
	minNetProfit?: number;
}

export interface ExecutableCycleScore {
	route: ExecutableRoute;
	simulation: ExecutableRouteSimulation;
	amountIn: number;
	executableProfit: number;
	executableProfitPct: number;
	originalProfitPct: number;
	edgeDeltaPct: number;
}

export function cycleToExecutableRoute(cycle: ArbitrageCycle): ExecutableRoute | null {
	if (!cycle || !Array.isArray(cycle.edges) || cycle.edges.length < 2) return null;
	const edges = [];
	for (const edge of cycle.edges) {
		if (
			!edge ||
			!edge.from ||
			!edge.to ||
			!isPositiveFinite(edge.rate) ||
			!isPositiveFinite(edge.bidQty) ||
			!isValidFeeFraction(edge.fee)
		) {
			return null;
		}
		edges.push({
			from: edge.from,
			to: edge.to,
			source: edge.source,
			feeBps: edge.fee * 10_000,
			levels: [{ price: edge.rate, sizeIn: edge.bidQty }],
		});
	}

	const first = edges[0];
	const last = edges[edges.length - 1];
	if (!first || !last || first.from !== last.to) return null;

	return {
		id: cycle.path?.length ? cycle.path.join("->") : edges.map((edge) => edge.from).concat(last.to).join("->"),
		edges,
	};
}

export function rescoreArbitrageCycle(
	cycle: ArbitrageCycle,
	options: RescoreArbitrageCycleOptions,
): ExecutableCycleScore | null {
	const route = cycleToExecutableRoute(cycle);
	if (!route) return null;

	const simulation = options.amountIn != null
		? simulateExecutableRoute(route, options.amountIn, options.costs)
		: findBestExecutableRouteSize(route, bestSizeOptions(options));
	if (!simulation) return null;

	return {
		route,
		simulation,
		amountIn: simulation.amountIn,
		executableProfit: simulation.netProfit,
		executableProfitPct: simulation.netProfitPct,
		originalProfitPct: cycle.profitPct,
		edgeDeltaPct: simulation.netProfitPct - cycle.profitPct,
	};
}

function bestSizeOptions(options: RescoreArbitrageCycleOptions): BestExecutableRouteOptions {
	return {
		maxInput: options.maxInput ?? 0,
		probeInputs: options.probeInputs,
		geometricSteps: options.geometricSteps,
		refinementSteps: options.refinementSteps,
		costs: options.costs,
		minNetProfit: options.minNetProfit,
	};
}

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function isValidFeeFraction(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value < 1;
}
