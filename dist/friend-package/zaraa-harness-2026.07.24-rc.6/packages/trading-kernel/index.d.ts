export interface RouteKernelModule {
	scoreRouteBatchJson(rawJson: string): string;
	tradingKernelBackend(): string;
}

export function scoreRouteBatchJson(rawJson: string): string;
export function tradingKernelBackend(): string;
