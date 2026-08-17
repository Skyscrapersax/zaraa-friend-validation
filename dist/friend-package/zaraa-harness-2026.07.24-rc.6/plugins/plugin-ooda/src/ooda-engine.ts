import type { OODAStore, StoredCycle } from "./ooda-store.js";
import { getPreset, type Observer } from "./presets.js";

export interface OODACycleConfig {
	preset: "trading" | "agent" | "problem-solving" | "custom";
	context?: string;
	urgency?: "low" | "normal" | "high";
	customObservers?: Array<{ key: string; tool: string; args: Record<string, unknown> }>;
}

export interface ObserveResult {
	data: Record<string, unknown>;
	summary: string;
	durationMs: number;
}

interface LLMDecision {
	orient: { analysis: string; patterns: string[] };
	decide: { decision: string; confidence: number; risk: "low" | "medium" | "high"; alternatives: string[] };
	act: { action: string; shouldExecute: boolean };
}

export interface OODAEngineConfig {
	toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	llmCall: (observeData: Record<string, unknown>, context: string | undefined, preset: string, recentCycles: StoredCycle[]) => Promise<LLMDecision>;
	store: OODAStore;
	onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}

export class OODACycleEngine {
	private config: OODAEngineConfig;

	constructor(config: OODAEngineConfig) {
		this.config = config;
	}

	async observe(opts: Pick<OODACycleConfig, "preset" | "context" | "customObservers">): Promise<ObserveResult> {
		const start = Date.now();
		const preset = getPreset(opts.preset);
		const observers: Observer[] = opts.preset === "custom"
			? (opts.customObservers ?? [])
			: (preset?.observers ?? []);

		const data: Record<string, unknown> = {};
		for (const obs of observers) {
			try {
				data[obs.key] = await this.config.toolExecutor(obs.tool, obs.args);
			} catch {
				data[obs.key] = null;
			}
		}
		return { data, summary: this.summarizeObservations(data), durationMs: Date.now() - start };
	}

	async runCycle(opts: OODACycleConfig): Promise<StoredCycle> {
		const id = `ooda-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const cycleStart = Date.now();

		this.config.onEvent?.({ type: "ooda.cycle.started", data: { id, preset: opts.preset, context: opts.context } });

		const observeResult = await this.observe(opts);
		const recentCycles = this.config.store.getRecentCycles(opts.preset, 3);

		const orientStart = Date.now();
		let llmResult: LLMDecision;
		try {
			llmResult = await this.config.llmCall(observeResult.data, opts.context, opts.preset, recentCycles);
		} catch (err) {
			const failedCycle: StoredCycle = {
				id, preset: opts.preset, context: opts.context ?? null,
				phases: {
					observe: observeResult,
					orient: { analysis: "LLM call failed", patterns: [], durationMs: Date.now() - orientStart },
					decide: { decision: "Unable to decide", confidence: 0, risk: "high", alternatives: [], durationMs: 0 },
					act: { action: "No action", executed: false, result: err instanceof Error ? err.message : String(err), durationMs: 0 },
				},
				outcome: "failed", totalDurationMs: Date.now() - cycleStart,
			};
			this.config.store.saveCycle(failedCycle);
			return failedCycle;
		}
		const orientDurationMs = Date.now() - orientStart;

		const actStart = Date.now();
		const shouldExecute = llmResult.act.shouldExecute && llmResult.decide.risk === "low";

		const cycle: StoredCycle = {
			id, preset: opts.preset, context: opts.context ?? null,
			phases: {
				observe: observeResult,
				orient: { analysis: llmResult.orient.analysis, patterns: llmResult.orient.patterns, durationMs: orientDurationMs },
				decide: { ...llmResult.decide, durationMs: orientDurationMs },
				act: { action: llmResult.act.action, executed: shouldExecute, result: shouldExecute ? "Approved for execution" : null, durationMs: Date.now() - actStart },
			},
			outcome: shouldExecute ? "pending" : null,
			totalDurationMs: Date.now() - cycleStart,
		};

		this.config.store.saveCycle(cycle);
		this.config.onEvent?.({ type: "ooda.cycle.completed", data: { id, preset: opts.preset, decision: llmResult.decide.decision, risk: llmResult.decide.risk, confidence: llmResult.decide.confidence, durationMs: cycle.totalDurationMs } });

		return cycle;
	}

	formatSummary(cycle: StoredCycle): string {
		const p = cycle.phases;
		const conf = (p.decide.confidence * 100).toFixed(0);
		const actionLine = p.act.executed
			? `Action: ${p.act.action} (executed)`
			: p.decide.risk === "low"
				? `Action: ${p.act.action}`
				: `Action: ${p.act.action} — awaiting approval`;

		return [
			`OODA [${cycle.preset}] complete (${(cycle.totalDurationMs / 1000).toFixed(1)}s):`,
			`  Observe: ${p.observe.summary}`,
			`  Orient: ${p.orient.analysis}`,
			`  Decide: ${p.decide.decision} (confidence: ${conf}%, risk: ${p.decide.risk})`,
			`  ${actionLine}`,
		].join("\n");
	}

	private summarizeObservations(data: Record<string, unknown>): string {
		const parts: string[] = [];
		for (const [key, value] of Object.entries(data)) {
			if (value === null) { parts.push(`${key}: unavailable`); continue; }
			if (typeof value === "object") {
				const v = value as { price?: unknown; positions?: unknown[]; signals?: unknown[] };
				if (v.price !== undefined) parts.push(`${key}: $${v.price}`);
				else if (v.positions !== undefined) parts.push(`${key}: ${v.positions.length} positions`);
				else if (v.signals !== undefined) parts.push(`${key}: ${v.signals.length} signals`);
				else parts.push(`${key}: ${JSON.stringify(value).slice(0, 80)}`);
			} else {
				parts.push(`${key}: ${String(value).slice(0, 80)}`);
			}
		}
		return parts.join(", ") || "No observations (context-only)";
	}
}
