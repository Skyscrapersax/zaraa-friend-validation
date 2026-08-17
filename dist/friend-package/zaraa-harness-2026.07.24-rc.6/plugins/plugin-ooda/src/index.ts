import type { PluginManifest } from "@zaraa/shared";
import { OODACycleEngine, type OODACycleConfig } from "./ooda-engine.js";
import type { OODAStore, StoredCycle } from "./ooda-store.js";

export { OODAStore } from "./ooda-store.js";
export { OODACycleEngine } from "./ooda-engine.js";
export type { OODACycleConfig, ObserveResult, OODAEngineConfig } from "./ooda-engine.js";
export type { StoredCycle } from "./ooda-store.js";
export { PRESETS, getPreset } from "./presets.js";
export type { OODAPreset, PresetName, Observer } from "./presets.js";

export const manifest: PluginManifest = {
	name: "ooda",
	version: "0.1.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["reasoning.ooda"],
	trust: "core",
	tools: [
		{
			name: "ooda_cycle",
			description: "Run a structured OODA (Observe-Orient-Decide-Act) cycle. Use for complex decisions: trading signals, system problems, multi-step tasks. Returns a compact summary with observation, analysis, decision (with confidence and risk level), and recommended action.",
			parameters: {
				type: "object",
				properties: {
					preset: { type: "string", enum: ["trading", "agent", "problem-solving", "custom"], description: 'MUST be exactly one of: "trading", "agent", "problem-solving", "custom"' },
					context: { type: "string", description: "Situation description or question" },
					urgency: { type: "string", description: '"low", "normal", or "high"' },
				},
				required: ["preset"],
			},
			requiresApproval: false,
		},
		{
			name: "ooda_observe",
			description: "Run only the Observe phase — gather data without analyzing or deciding. For situational awareness.",
			parameters: {
				type: "object",
				properties: {
					preset: { type: "string", description: "Domain preset" },
					context: { type: "string", description: "Optional context" },
				},
				required: ["preset"],
			},
			requiresApproval: false,
		},
		{
			name: "ooda_get_cycles",
			description: "Retrieve past OODA cycles for review — shows decisions, outcomes, and patterns.",
			parameters: {
				type: "object",
				properties: {
					preset: { type: "string", description: "Filter by preset" },
					limit: { type: "number", description: "Max cycles (default: 5)" },
				},
				required: [],
			},
			requiresApproval: false,
		},
	],
};

export interface OODAHandlerDeps {
	store: OODAStore;
	toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	llmCall: (observeData: Record<string, unknown>, context: string | undefined, preset: string, recentCycles: StoredCycle[]) => Promise<any>;
	onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}

export function createOODAHandlers(deps: OODAHandlerDeps) {
	const engine = new OODACycleEngine({
		toolExecutor: deps.toolExecutor,
		llmCall: deps.llmCall,
		store: deps.store,
		onEvent: deps.onEvent,
	});

	const VALID_PRESETS = new Set(["trading", "agent", "problem-solving", "custom"]);
	const normalizePreset = (raw: unknown): OODACycleConfig["preset"] => {
		const s = String(raw ?? "").toLowerCase();
		if (VALID_PRESETS.has(s)) return s as OODACycleConfig["preset"];
		// Fuzzy match: if the value contains a valid preset name, use it
		for (const p of VALID_PRESETS) {
			if (s.includes(p)) return p as OODACycleConfig["preset"];
		}
		return "problem-solving";
	};

	return {
		ooda_cycle: async (args: Record<string, unknown>): Promise<string> => {
			const cycle = await engine.runCycle({
				preset: normalizePreset(args.preset),
				context: args.context as string | undefined,
				urgency: args.urgency as OODACycleConfig["urgency"],
			});
			return engine.formatSummary(cycle);
		},

		ooda_observe: async (args: Record<string, unknown>): Promise<string> => {
			const result = await engine.observe({
				preset: normalizePreset(args.preset),
				context: args.context as string | undefined,
			});
			return `Observations (${args.preset}):\n${result.summary}\n\nRaw data:\n${JSON.stringify(result.data, null, 2).slice(0, 2000)}`;
		},

		ooda_get_cycles: async (args: Record<string, unknown>): Promise<string> => {
			const cycles = deps.store.getRecentCycles(args.preset as string | undefined, (args.limit as number) || 5);
			if (cycles.length === 0) return `No OODA cycles found${args.preset ? ` for "${args.preset}"` : ""}.`;
			const summaries = cycles.map(c => {
				const d = c.phases?.decide;
				return `[${c.createdAt?.slice(0, 19)}] ${c.preset}: ${d?.decision ?? "?"} (conf=${d?.confidence ?? "?"}, risk=${d?.risk ?? "?"}, outcome=${c.outcome ?? "pending"})`;
			});
			return `${cycles.length} cycles:\n${summaries.join("\n")}`;
		},
	};
}
