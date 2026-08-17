import { createRequire } from "node:module";
import {
	simulateExecutableRouteBatch,
	type ExecutableHopFill,
	type ExecutableRoute,
	type ExecutableRouteCostModel,
	type ExecutableRouteSimulation,
} from "./executable-route.js";

export interface RouteKernelModule {
	scoreRouteBatchJson: (rawJson: string) => string;
	tradingKernelBackend?: () => string;
}

export interface RouteKernelBatchResult {
	backend: string;
	usedNative: boolean;
	results: Array<ExecutableRouteSimulation | null>;
}

interface NativeScoreBatchOk {
	ok: true;
	backend?: unknown;
	results: unknown;
}

let cachedNativeRouteKernel: RouteKernelModule | null | undefined;

export function scoreRouteBatchWithKernel(
	route: ExecutableRoute,
	amountsIn: ArrayLike<number>,
	costs: ExecutableRouteCostModel = {},
	nativeModule: RouteKernelModule | null = loadNativeRouteKernel(),
): RouteKernelBatchResult {
	const amounts = Array.from(amountsIn);
	const fallback = (): RouteKernelBatchResult => ({
		backend: "typescript-fallback",
		usedNative: false,
		results: simulateExecutableRouteBatch(route, amounts, costs),
	});

	if (!nativeModule) return fallback();

	try {
		const raw = nativeModule.scoreRouteBatchJson(JSON.stringify({ route, amountsIn: amounts, costs }));
		const parsed = JSON.parse(raw) as unknown;
		const nativeResult = normalizeNativeResult(parsed, amounts.length);
		if (!nativeResult) return fallback();

		return {
			backend: nativeBackend(nativeModule, nativeResult),
			usedNative: true,
			results: nativeResult.results,
		};
	} catch {
		return fallback();
	}
}

export function loadNativeRouteKernel(): RouteKernelModule | null {
	if (cachedNativeRouteKernel !== undefined) return cachedNativeRouteKernel;

	const requireNative = createRequire(import.meta.url);
	try {
		const loaded = requireNative("@zaraa/trading-kernel") as unknown;
		cachedNativeRouteKernel = unwrapRouteKernelModule(loaded);
	} catch {
		cachedNativeRouteKernel = null;
	}

	return cachedNativeRouteKernel;
}

function unwrapRouteKernelModule(value: unknown): RouteKernelModule | null {
	if (isRouteKernelModule(value)) return value;
	if (isRecord(value) && isRouteKernelModule(value.default)) return value.default;
	return null;
}

function isRouteKernelModule(value: unknown): value is RouteKernelModule {
	return (
		isRecord(value) &&
		typeof value.scoreRouteBatchJson === "function" &&
		(value.tradingKernelBackend === undefined || typeof value.tradingKernelBackend === "function")
	);
}

function normalizeNativeResult(
	value: unknown,
	expectedLength: number,
): { backend?: string; results: Array<ExecutableRouteSimulation | null> } | null {
	if (!isNativeScoreBatchOk(value) || !Array.isArray(value.results) || value.results.length !== expectedLength) {
		return null;
	}

	const results: Array<ExecutableRouteSimulation | null> = [];
	for (const entry of value.results) {
		if (entry === null) {
			results.push(null);
			continue;
		}

		const normalized = normalizeNativeSimulation(entry);
		if (!normalized) return null;
		results.push(normalized);
	}

	return {
		backend: typeof value.backend === "string" && value.backend.length > 0 ? value.backend : undefined,
		results,
	};
}

function isNativeScoreBatchOk(value: unknown): value is NativeScoreBatchOk {
	return isRecord(value) && value.ok === true && Object.prototype.hasOwnProperty.call(value, "results");
}

function normalizeNativeSimulation(value: unknown): ExecutableRouteSimulation | null {
	if (!isRecord(value)) return null;

	const routeId = value.routeId;
	const hopFills = value.hopFills;
	if (routeId !== undefined && typeof routeId !== "string") return null;
	if (hopFills !== undefined && !Array.isArray(hopFills)) return null;

	const amountIn = finiteNumber(value.amountIn);
	const amountOut = finiteNumber(value.amountOut);
	const grossProfit = finiteNumber(value.grossProfit);
	const netProfit = finiteNumber(value.netProfit);
	const netProfitPct = finiteNumber(value.netProfitPct);
	const totalCostInStartAsset = finiteNumber(value.totalCostInStartAsset);
	if (
		amountIn === null ||
		amountOut === null ||
		grossProfit === null ||
		netProfit === null ||
		netProfitPct === null ||
		totalCostInStartAsset === null ||
		typeof value.isFireable !== "boolean"
	) {
		return null;
	}

	return {
		routeId,
		amountIn,
		amountOut,
		grossProfit,
		netProfit,
		netProfitPct,
		totalCostInStartAsset,
		hopFills: hopFills === undefined ? [] : (hopFills as ExecutableHopFill[]),
		isFireable: value.isFireable,
	};
}

function nativeBackend(
	nativeModule: RouteKernelModule,
	result: { backend?: string },
): string {
	if (result.backend) return result.backend;
	try {
		const backend = nativeModule.tradingKernelBackend?.();
		return backend && backend.length > 0 ? backend : "native-rust";
	} catch {
		return "native-rust";
	}
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
