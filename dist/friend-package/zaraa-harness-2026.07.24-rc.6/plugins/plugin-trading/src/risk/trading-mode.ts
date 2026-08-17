export interface TradingModeSettings {
	getSetting(key: string): string | undefined;
}

export interface TradingModeSnapshot {
	paperMode: boolean;
	shadowMode: boolean;
}

/**
 * Fail-safe paper-mode resolver: only the literal string "false" disables paper mode.
 * Missing, malformed, deleted, or differently-cased values stay paper-safe.
 */
export function resolvePaperMode(
	settings: TradingModeSettings,
	envOverride = process.env.PAPER_TRADING,
): boolean {
	if (envOverride === "true") return true;
	return settings.getSetting("paper_mode") !== "false";
}

export function resolveTradingModeSnapshot(
	settings: TradingModeSettings,
	envOverride = process.env.PAPER_TRADING,
): TradingModeSnapshot {
	const paperRaw = settings.getSetting("paper_mode");
	const shadowRaw = settings.getSetting("shadow_mode");
	return {
		paperMode: envOverride === "true" ? true : paperRaw !== "false",
		shadowMode: shadowRaw === "true",
	};
}
