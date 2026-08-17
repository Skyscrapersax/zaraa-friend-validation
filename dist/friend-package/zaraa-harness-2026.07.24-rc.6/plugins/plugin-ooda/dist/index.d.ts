import { PluginManifest } from '@zaraa/shared';
import Database from 'better-sqlite3';

interface StoredCycle {
    id: string;
    preset: string;
    context: string | null;
    phases: {
        observe: {
            data: Record<string, unknown>;
            summary: string;
            durationMs: number;
        };
        orient: {
            analysis: string;
            patterns: string[];
            durationMs: number;
        };
        decide: {
            decision: string;
            confidence: number;
            risk: "low" | "medium" | "high";
            alternatives: string[];
            durationMs: number;
        };
        act: {
            action: string;
            executed: boolean;
            result: string | null;
            durationMs: number;
        };
    };
    outcome: "success" | "partial" | "failed" | "pending" | null;
    totalDurationMs: number;
    createdAt?: string;
}
declare class OODAStore {
    private db;
    constructor(db: Database.Database);
    private initSchema;
    saveCycle(cycle: StoredCycle): void;
    getCycle(id: string): StoredCycle | null;
    getRecentCycles(preset?: string, limit?: number): StoredCycle[];
    updateOutcome(id: string, outcome: "success" | "partial" | "failed" | "pending"): void;
    private rowToCycle;
}

interface OODACycleConfig {
    preset: "trading" | "agent" | "problem-solving" | "custom";
    context?: string;
    urgency?: "low" | "normal" | "high";
    customObservers?: Array<{
        key: string;
        tool: string;
        args: Record<string, unknown>;
    }>;
}
interface ObserveResult {
    data: Record<string, unknown>;
    summary: string;
    durationMs: number;
}
interface LLMDecision {
    orient: {
        analysis: string;
        patterns: string[];
    };
    decide: {
        decision: string;
        confidence: number;
        risk: "low" | "medium" | "high";
        alternatives: string[];
    };
    act: {
        action: string;
        shouldExecute: boolean;
    };
}
interface OODAEngineConfig {
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    llmCall: (observeData: Record<string, unknown>, context: string | undefined, preset: string, recentCycles: StoredCycle[]) => Promise<LLMDecision>;
    store: OODAStore;
    onEvent?: (event: {
        type: string;
        data: Record<string, unknown>;
    }) => void;
}
declare class OODACycleEngine {
    private config;
    constructor(config: OODAEngineConfig);
    observe(opts: Pick<OODACycleConfig, "preset" | "context" | "customObservers">): Promise<ObserveResult>;
    runCycle(opts: OODACycleConfig): Promise<StoredCycle>;
    formatSummary(cycle: StoredCycle): string;
    private summarizeObservations;
}

interface Observer {
    key: string;
    tool: string;
    args: Record<string, unknown>;
}
interface OODAPreset {
    name: string;
    description: string;
    observers: Observer[];
    orientGuidance: string;
    decideGuidance: string;
}
declare const PRESETS: Record<string, OODAPreset>;
type PresetName = keyof typeof PRESETS | "custom";
declare function getPreset(name: string): OODAPreset | null;

declare const manifest: PluginManifest;
interface OODAHandlerDeps {
    store: OODAStore;
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    llmCall: (observeData: Record<string, unknown>, context: string | undefined, preset: string, recentCycles: StoredCycle[]) => Promise<any>;
    onEvent?: (event: {
        type: string;
        data: Record<string, unknown>;
    }) => void;
}
declare function createOODAHandlers(deps: OODAHandlerDeps): {
    ooda_cycle: (args: Record<string, unknown>) => Promise<string>;
    ooda_observe: (args: Record<string, unknown>) => Promise<string>;
    ooda_get_cycles: (args: Record<string, unknown>) => Promise<string>;
};

export { type OODACycleConfig, OODACycleEngine, type OODAEngineConfig, type OODAHandlerDeps, type OODAPreset, OODAStore, type ObserveResult, type Observer, PRESETS, type PresetName, type StoredCycle, createOODAHandlers, getPreset, manifest };
