export interface Observer {
	key: string;
	tool: string;
	args: Record<string, unknown>;
}

export interface OODAPreset {
	name: string;
	description: string;
	observers: Observer[];
	orientGuidance: string;
	decideGuidance: string;
}

export const PRESETS: Record<string, OODAPreset> = {
	trading: {
		name: "trading",
		description: "Market analysis and trade decisions",
		observers: [
			{ key: "btcPrice", tool: "trade_get_price", args: { symbol: "BTC_USDT" } },
			{ key: "ethPrice", tool: "trade_get_price", args: { symbol: "ETH_USDT" } },
			{ key: "solPrice", tool: "trade_get_price", args: { symbol: "SOL_USDT" } },
			{ key: "portfolio", tool: "trade_portfolio", args: {} },
			{ key: "signals", tool: "trade_scan_signals", args: {} },
			{ key: "marketNews", tool: "web_search", args: { query: "crypto market news today", count: 3 } },
		],
		orientGuidance: "Compare against historical patterns, assess regime (trending/ranging/volatile), evaluate risk exposure and position sizing. Factor in recent market news sentiment — bullish or bearish headlines may indicate near-term momentum shifts.",
		decideGuidance: "Recommend entry/exit/hold. Include confidence 0-1, risk level, position sizing rationale, and alternatives.",
	},
	agent: {
		name: "agent",
		description: "System health and self-improvement decisions",
		observers: [
			{ key: "health", tool: "memory_search", args: { query: "system health status" } },
		],
		orientGuidance: "Compare metrics against baselines. Identify anomalies, degradation trends, or underperforming models.",
		decideGuidance: "Recommend: fix, escalate, or ignore. Rate risk.",
	},
	"problem-solving": {
		name: "problem-solving",
		description: "Structured problem decomposition and solution planning",
		observers: [],
		orientGuidance: "Decompose into sub-problems. Identify constraints. Recall similar past solutions.",
		decideGuidance: "Pick the best approach with rationale. Estimate effort and risk. List alternatives.",
	},
};

export type PresetName = keyof typeof PRESETS | "custom";

export function getPreset(name: string): OODAPreset | null {
	return PRESETS[name] ?? null;
}
