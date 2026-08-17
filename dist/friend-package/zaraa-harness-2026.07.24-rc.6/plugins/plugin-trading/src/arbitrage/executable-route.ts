const DEFAULT_MAX_HOPS = 6;
const DEFAULT_GEOMETRIC_STEPS = 8;
const DEFAULT_REFINEMENT_STEPS = 7;
const EPSILON = 1e-12;

export interface ExecutableLiquidityLevel {
	/** Output units received per 1 input unit at this depth level. */
	price: number;
	/** Maximum input units executable at this level. */
	sizeIn: number;
}

export interface ExecutableRouteEdge {
	from: string;
	to: string;
	source?: string;
	feeBps?: number;
	levels: ExecutableLiquidityLevel[];
}

export interface ExecutableRoute {
	id?: string;
	edges: ExecutableRouteEdge[];
}

export interface ExecutableRouteCostModel {
	fixedCostInStartAsset?: number;
	gasCostInStartAsset?: number;
	latencyPenaltyBps?: number;
	adverseSelectionBps?: number;
	lvrBps?: number;
}

export interface ExecutableLevelFill {
	price: number;
	sizeIn: number;
	sizeOut: number;
}

export interface ExecutableHopFill {
	from: string;
	to: string;
	source?: string;
	feeBps: number;
	amountIn: number;
	amountOut: number;
	unfilledInput: number;
	filledLevels: ExecutableLevelFill[];
}

export interface ExecutableRouteSimulation {
	routeId?: string;
	amountIn: number;
	amountOut: number;
	grossProfit: number;
	netProfit: number;
	netProfitPct: number;
	totalCostInStartAsset: number;
	hopFills: ExecutableHopFill[];
	isFireable: boolean;
}

export interface BestExecutableRouteOptions {
	maxInput: number;
	probeInputs?: number[];
	geometricSteps?: number;
	refinementSteps?: number;
	costs?: ExecutableRouteCostModel;
	minNetProfit?: number;
}

export function simulateExecutableRoute(
	route: ExecutableRoute,
	amountIn: number,
	costs: ExecutableRouteCostModel = {},
): ExecutableRouteSimulation | null {
	if (!isPositiveFinite(amountIn) || !isValidRoute(route)) return null;

	const first = route.edges[0];
	const last = route.edges[route.edges.length - 1];
	if (!first || !last || first.from !== last.to) return null;

	const cost = computeRouteCost(amountIn, costs);
	if (cost == null) return null;

	let currentAmount = amountIn;
	const hopFills: ExecutableHopFill[] = [];

	for (const edge of route.edges) {
		const fill = fillEdge(edge, currentAmount);
		if (!fill) return null;
		hopFills.push(fill);
		currentAmount = fill.amountOut;
	}

	const grossProfit = currentAmount - amountIn;
	const netProfit = grossProfit - cost;
	const netProfitPct = amountIn > 0 ? (netProfit / amountIn) * 100 : 0;
	if (![currentAmount, grossProfit, netProfit, netProfitPct].every(Number.isFinite)) return null;

	return {
		routeId: route.id,
		amountIn,
		amountOut: currentAmount,
		grossProfit,
		netProfit,
		netProfitPct,
		totalCostInStartAsset: cost,
		hopFills,
		isFireable: netProfit > 0,
	};
}

export function simulateExecutableRouteBatch(
	route: ExecutableRoute,
	amountsIn: ArrayLike<number>,
	costs: ExecutableRouteCostModel = {},
): Array<ExecutableRouteSimulation | null> {
	if (!amountsIn || !Number.isInteger(amountsIn.length) || amountsIn.length < 0) return [];
	if (!isValidRoute(route)) return Array.from({ length: amountsIn.length }, () => null);

	const first = route.edges[0];
	const last = route.edges[route.edges.length - 1];
	const costParts = routeCostParts(costs);
	if (!first || !last || first.from !== last.to || !costParts) {
		return Array.from({ length: amountsIn.length }, () => null);
	}

	const out: Array<ExecutableRouteSimulation | null> = new Array(amountsIn.length);
	for (let i = 0; i < amountsIn.length; i += 1) {
		const amountIn = amountsIn[i];
		out[i] = isPositiveFinite(amountIn)
			? simulateExecutableRouteWithCostParts(route, amountIn, costParts)
			: null;
	}
	return out;
}

export function findBestExecutableRouteSize(
	route: ExecutableRoute,
	options: BestExecutableRouteOptions,
): ExecutableRouteSimulation | null {
	if (!isPositiveFinite(options.maxInput)) return null;

	const candidates = buildCandidateInputs(options);
	let best = bestSimulation(route, candidates, options.costs, options.minNetProfit);
	if (!best) return null;

	const refined = refinementInputs(best.amountIn, options.maxInput, options.refinementSteps ?? DEFAULT_REFINEMENT_STEPS);
	best = bestSimulation(route, [...candidates, ...refined], options.costs, options.minNetProfit) ?? best;
	return best;
}

function simulateExecutableRouteWithCostParts(
	route: ExecutableRoute,
	amountIn: number,
	costParts: { fixed: number; bps: number },
): ExecutableRouteSimulation | null {
	let currentAmount = amountIn;
	const hopFills: ExecutableHopFill[] = [];

	for (const edge of route.edges) {
		const fill = fillEdge(edge, currentAmount);
		if (!fill) return null;
		hopFills.push(fill);
		currentAmount = fill.amountOut;
	}

	const cost = costParts.fixed + amountIn * costParts.bps;
	const grossProfit = currentAmount - amountIn;
	const netProfit = grossProfit - cost;
	const netProfitPct = amountIn > 0 ? (netProfit / amountIn) * 100 : 0;
	if (![currentAmount, cost, grossProfit, netProfit, netProfitPct].every(Number.isFinite)) return null;

	return {
		routeId: route.id,
		amountIn,
		amountOut: currentAmount,
		grossProfit,
		netProfit,
		netProfitPct,
		totalCostInStartAsset: cost,
		hopFills,
		isFireable: netProfit > 0,
	};
}

function bestSimulation(
	route: ExecutableRoute,
	candidates: number[],
	costs: ExecutableRouteCostModel | undefined,
	minNetProfit = 0,
): ExecutableRouteSimulation | null {
	let best: ExecutableRouteSimulation | null = null;
	for (const result of simulateExecutableRouteBatch(route, dedupePositiveFinite(candidates), costs)) {
		if (!result || result.netProfit <= minNetProfit) continue;
		if (!best || result.netProfit > best.netProfit) best = result;
	}
	return best;
}

function buildCandidateInputs(options: BestExecutableRouteOptions): number[] {
	const candidates = [...(options.probeInputs ?? [])];
	candidates.push(...geometricInputs(options.maxInput, options.geometricSteps ?? DEFAULT_GEOMETRIC_STEPS));
	candidates.push(options.maxInput);
	return candidates.filter((v) => v <= options.maxInput);
}

function geometricInputs(maxInput: number, steps: number): number[] {
	if (!isPositiveFinite(maxInput) || !Number.isInteger(steps) || steps <= 0) return [];
	const safeSteps = Math.min(steps, 64);
	const out: number[] = [];
	for (let i = safeSteps - 1; i >= 0; i -= 1) {
		const value = maxInput / 2 ** i;
		if (isPositiveFinite(value)) out.push(value);
	}
	return out;
}

function refinementInputs(center: number, maxInput: number, steps: number): number[] {
	if (!isPositiveFinite(center) || !isPositiveFinite(maxInput) || !Number.isInteger(steps) || steps <= 1) return [];
	const safeSteps = Math.min(steps, 101);
	const lo = Math.max(center / 2, Number.EPSILON);
	const hi = Math.min(center * 1.5, maxInput);
	if (hi <= lo) return [center];
	const span = hi - lo;
	const out: number[] = [];
	for (let i = 0; i < safeSteps; i += 1) {
		out.push(lo + (span * i) / (safeSteps - 1));
	}
	return out;
}

function fillEdge(edge: ExecutableRouteEdge, amountIn: number): ExecutableHopFill | null {
	if (!isPositiveFinite(amountIn) || !isValidFee(edge.feeBps)) return null;
	let remaining = amountIn;
	let grossOut = 0;
	const filledLevels: ExecutableLevelFill[] = [];

	for (const level of edge.levels) {
		if (!isPositiveFinite(level.price) || !isPositiveFinite(level.sizeIn)) return null;
		if (remaining <= EPSILON) break;
		const sizeIn = Math.min(remaining, level.sizeIn);
		const sizeOut = sizeIn * level.price;
		if (!isPositiveFinite(sizeOut)) return null;
		filledLevels.push({ price: level.price, sizeIn, sizeOut });
		grossOut += sizeOut;
		remaining -= sizeIn;
	}

	if (remaining > EPSILON || !isPositiveFinite(grossOut)) return null;
	const feeBps = edge.feeBps ?? 0;
	const amountOut = grossOut * (1 - feeBps / 10_000);
	if (!isPositiveFinite(amountOut)) return null;

	return {
		from: edge.from,
		to: edge.to,
		source: edge.source,
		feeBps,
		amountIn,
		amountOut,
		unfilledInput: Math.max(0, remaining),
		filledLevels,
	};
}

function computeRouteCost(amountIn: number, costs: ExecutableRouteCostModel): number | null {
	const parts = routeCostParts(costs);
	if (!parts) return null;
	const total = parts.fixed + amountIn * parts.bps;
	return Number.isFinite(total) ? total : null;
}

function routeCostParts(costs: ExecutableRouteCostModel): { fixed: number; bps: number } | null {
	const fixed = costs.fixedCostInStartAsset ?? 0;
	const gas = costs.gasCostInStartAsset ?? 0;
	const bps =
		(costs.latencyPenaltyBps ?? 0) +
		(costs.adverseSelectionBps ?? 0) +
		(costs.lvrBps ?? 0);
	if (![fixed, gas, bps].every(isNonNegativeFinite)) return null;
	return { fixed: fixed + gas, bps: bps / 10_000 };
}

function isValidRoute(route: ExecutableRoute): boolean {
	if (!route || !Array.isArray(route.edges) || route.edges.length < 2 || route.edges.length > DEFAULT_MAX_HOPS) {
		return false;
	}
	for (let i = 0; i < route.edges.length; i += 1) {
		const edge = route.edges[i];
		const next = route.edges[i + 1];
		if (!edge || !edge.from || !edge.to || !Array.isArray(edge.levels) || edge.levels.length === 0) return false;
		if (!isValidFee(edge.feeBps)) return false;
		if (next && edge.to !== next.from) return false;
	}
	return true;
}

function isValidFee(value: number | undefined): boolean {
	return value == null || (isNonNegativeFinite(value) && value < 10_000);
}

function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function dedupePositiveFinite(values: number[]): number[] {
	return [...new Set(values.filter(isPositiveFinite))].sort((a, b) => a - b);
}
