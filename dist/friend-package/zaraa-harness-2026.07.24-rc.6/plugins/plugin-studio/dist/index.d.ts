import { z } from 'zod';

/**
 * SceneSpec — the JSON contract between the Director (LLM) that designs a
 * bleepybot animated short and the scene engine that renders it.
 *
 * This is the data contract every later unit relies on; field names/types are
 * load-bearing. Defaults are applied on parse so the Director can emit a minimal
 * spec and rely on sane fills.
 */
declare const SceneSpecSchema: z.ZodObject<{
    seed: z.ZodNumber;
    durationSec: z.ZodNumber;
    fps: z.ZodDefault<z.ZodNumber>;
    aspectRatios: z.ZodDefault<z.ZodArray<z.ZodEnum<["1080x1920", "1080x1350"]>, "atleastone">>;
    palette: z.ZodDefault<z.ZodObject<{
        bg: z.ZodDefault<z.ZodString>;
        primary: z.ZodDefault<z.ZodString>;
        accent: z.ZodDefault<z.ZodString>;
        text: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        bg: string;
        primary: string;
        accent: string;
        text: string;
    }, {
        bg?: string | undefined;
        primary?: string | undefined;
        accent?: string | undefined;
        text?: string | undefined;
    }>>;
    character: z.ZodDefault<z.ZodObject<{
        mood: z.ZodDefault<z.ZodEnum<["idle", "charged", "sweep", "blink", "glitch"]>>;
        intensity: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        mood: "idle" | "charged" | "sweep" | "blink" | "glitch";
        intensity: number;
    }, {
        mood?: "idle" | "charged" | "sweep" | "blink" | "glitch" | undefined;
        intensity?: number | undefined;
    }>>;
    message: z.ZodObject<{
        lines: z.ZodArray<z.ZodString, "many">;
        style: z.ZodDefault<z.ZodString>;
        timingSec: z.ZodDefault<z.ZodArray<z.ZodNumber, "many">>;
    }, "strip", z.ZodTypeAny, {
        lines: string[];
        style: string;
        timingSec: number[];
    }, {
        lines: string[];
        style?: string | undefined;
        timingSec?: number[] | undefined;
    }>;
    audio: z.ZodDefault<z.ZodObject<{
        source: z.ZodDefault<z.ZodEnum<["track", "bleeps"]>>;
        trackClip: z.ZodOptional<z.ZodObject<{
            file: z.ZodString;
            startSec: z.ZodNumber;
            endSec: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            file: string;
            startSec: number;
            endSec: number;
        }, {
            file: string;
            startSec: number;
            endSec: number;
        }>>;
        reactive: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        source: "track" | "bleeps";
        reactive: boolean;
        trackClip?: {
            file: string;
            startSec: number;
            endSec: number;
        } | undefined;
    }, {
        source?: "track" | "bleeps" | undefined;
        trackClip?: {
            file: string;
            startSec: number;
            endSec: number;
        } | undefined;
        reactive?: boolean | undefined;
    }>>;
    caption: z.ZodOptional<z.ZodObject<{
        text: z.ZodString;
        hashtags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        text: string;
        hashtags: string[];
    }, {
        text: string;
        hashtags?: string[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    seed: number;
    durationSec: number;
    fps: number;
    message: {
        lines: string[];
        style: string;
        timingSec: number[];
    };
    aspectRatios: ["1080x1920" | "1080x1350", ...("1080x1920" | "1080x1350")[]];
    palette: {
        bg: string;
        primary: string;
        accent: string;
        text: string;
    };
    character: {
        mood: "idle" | "charged" | "sweep" | "blink" | "glitch";
        intensity: number;
    };
    audio: {
        source: "track" | "bleeps";
        reactive: boolean;
        trackClip?: {
            file: string;
            startSec: number;
            endSec: number;
        } | undefined;
    };
    caption?: {
        text: string;
        hashtags: string[];
    } | undefined;
}, {
    seed: number;
    durationSec: number;
    message: {
        lines: string[];
        style?: string | undefined;
        timingSec?: number[] | undefined;
    };
    fps?: number | undefined;
    aspectRatios?: ["1080x1920" | "1080x1350", ...("1080x1920" | "1080x1350")[]] | undefined;
    palette?: {
        bg?: string | undefined;
        primary?: string | undefined;
        accent?: string | undefined;
        text?: string | undefined;
    } | undefined;
    character?: {
        mood?: "idle" | "charged" | "sweep" | "blink" | "glitch" | undefined;
        intensity?: number | undefined;
    } | undefined;
    audio?: {
        source?: "track" | "bleeps" | undefined;
        trackClip?: {
            file: string;
            startSec: number;
            endSec: number;
        } | undefined;
        reactive?: boolean | undefined;
    } | undefined;
    caption?: {
        text: string;
        hashtags?: string[] | undefined;
    } | undefined;
}>;
type SceneSpec = z.infer<typeof SceneSpecSchema>;
type SceneSpecInput = z.input<typeof SceneSpecSchema>;

/** Input for recording a single render into the learning log. */
interface RecordRenderInput {
    /** Serialized render spec (JSON string). */
    specJson: string;
    /** Quality-gate verdict, e.g. "pass" | "escalate". */
    verdict: string;
    /** Confidence score in [0, 1]. */
    confidence: number;
    /** Output file paths produced by the render. */
    files: string[];
    /** pHash hex strings of the render's key frames (novelty history). */
    keyHashes?: string[];
}
/** A render row as returned by the store, with `files` parsed back to an array. */
interface RenderRow {
    id: string;
    specJson: string;
    verdict: string;
    confidence: number;
    files: string[];
    createdAt: number;
    /** Performance feedback (JSON string), populated later; null until then. */
    performance: string | null;
    /** Key-frame pHashes recorded with the render; [] when none were stored. */
    keyHashes: string[];
}
/**
 * Learning-log store for Studio renders. Records every render Zaraa produces so
 * performance can later be fed back. Backed by a single `renders` table in
 * `studio.db` (or `:memory:` for tests).
 */
declare class StudioStore {
    private db;
    constructor(dbPath: string);
    /** Record a render and return its generated id. */
    recordRender(input: RecordRenderInput): string;
    /** List the most recent renders, newest first. */
    listRenders(limit: number): RenderRow[];
    /**
     * Flattened key-frame hashes from the most recent `limit` renders (same
     * ordering as listRenders), newest first — the novelty history the quality
     * gate compares fresh renders against, durable across daemon restarts.
     */
    listRecentKeyHashes(limit: number): string[];
}

/** Thrown when the host stays too loaded to safely launch a render. */
declare class HostBusyError extends Error {
    constructor(message?: string);
}
/**
 * Render a SceneSpec into export-ready MP4 shorts (one per aspect ratio) under
 * `outDir`. Only one render runs at a time (module-level mutex). Returns the
 * absolute paths of the produced MP4 files.
 */
declare function renderShort(spec: SceneSpec, outDir: string): Promise<string[]>;

/**
 * True when the host's 1-min load average is at or above `threshold`.
 * `read` is injectable for testing. Default threshold 8 suits this 16GB
 * host that also runs the daemon + local models.
 */
declare function isHostBusy(threshold?: number, read?: () => number): boolean;

/**
 * Director — turns a BRIEF (content-calendar slot, track to promote, or a
 * free-form message) into a Zod-validated SceneSpec + caption via an LLM.
 *
 * The LLM designs the creative (message, mood, palette, caption); audio is
 * decided IN CODE from the brief, never trusted from the model.
 */
interface DirectorBrief {
    message: string;
    availableTracks: Array<{
        file: string;
        suggestedStartSec?: number;
        suggestedEndSec?: number;
    }>;
}
interface DirectorDeps {
    llm: (systemPrompt: string, userPrompt: string) => Promise<string>;
}
/** Strip a single ```/```json fence wrapper from LLM output (shared by director + brand judge). */
declare function stripMarkdownFences(raw: string): string;
declare function direct(brief: DirectorBrief, deps: DirectorDeps): Promise<SceneSpec>;

/**
 * Create a brand judge over an injected LLM. The SceneSpec JSON is the user
 * prompt; the verdict must be `{"score": <0..1>, "reason": "<one sentence>"}`.
 * Retries once on bad output, then throws (see module jsdoc for containment).
 */
declare function createBrandJudge(llm: (systemPrompt: string, userPrompt: string) => Promise<string>): (spec: SceneSpec) => Promise<{
    score: number;
    reason: string;
}>;

/**
 * Quality + novelty gate — the keystone that prevents autonomous slop in the
 * video lane. Hard-checks (novelty vs recent renders, text legibility) run
 * first and fail outright; only then does the injected brand judge score the
 * spec, and the verdict falls out of thresholds: pass / escalate-to-operator /
 * fail. Pure logic + injected judge — no LLM call here (the real brandJudge is
 * wired by the orchestrator at registration).
 */
interface GateInput {
    /** pHash hex strings of key frames sampled from the render. */
    keyFrameHashes: string[];
    spec: SceneSpec;
    /** pHash hex strings of recently shipped renders. */
    historyHashes: string[];
}
interface GateDeps {
    brandJudge: (spec: SceneSpec) => Promise<{
        score: number;
        reason: string;
    }>;
}
interface GateVerdict {
    verdict: "pass" | "escalate" | "fail";
    reason: string;
    confidence: number;
    /**
     * For "fail" verdicts: whether a re-render with a varied seed could plausibly
     * change the outcome. Novelty fails are seed-dependent (retryable); legibility
     * and brand-judge fails are properties of the creative itself (not retryable —
     * re-rendering burns chromium+ffmpeg cycles for an identical verdict).
     * Undefined is treated as retryable for backward compatibility.
     */
    retryable?: boolean;
}
declare function evaluate(input: GateInput, deps: GateDeps): Promise<GateVerdict>;

/**
 * Average-hash a 64-byte (8x8) grayscale buffer into a 64-bit hex string.
 * Bit i = 1 when byte i >= mean. (All-equal buffers hash to all-ones — fine;
 * identical inputs still collide, which is the property the gate needs.)
 */
declare function phash(gray64: Buffer): string;
/** Hamming distance between two 64-bit phash hex strings (0..64). */
declare function hamming(a: string, b: string): number;
/** Downscale+grayscale a PNG to 8x8 via ffmpeg and average-hash it. */
declare function phashFromPng(pngPath: string): string;

/**
 * Extract key frames from an MP4 and perceptually hash them — the real-world
 * input to the quality gate's novelty check.
 *
 * One PNG is dumped per timestamp (seconds) via ffmpeg, pHashed, and the temp
 * PNGs are always cleaned up. Timestamps default to `[0, 1.0]` (first frame +
 * one second in); callers that know the clip duration should pass
 * `{ timestamps: [0, durationSec / 2] }` — first + middle frame, matching the
 * e2e contract. Timestamp 0 reads the literal first frame (no seek); nonzero
 * timestamps fast-seek (`-ss` before `-i`) to the nearest frame.
 *
 * Throws when ffmpeg cannot read the file or a timestamp lies beyond the clip.
 */
declare function extractKeyFrameHashes(mp4Path: string, opts?: {
    timestamps?: number[];
}): Promise<string[]>;

/**
 * Export a render. Returns the created directory:
 * `{exportRoot}/{YYYY-MM-DD}/{first-message-line-slug}-{seed}/`.
 */
declare function exportRender(spec: SceneSpec, caption: string, mp4Files: string[], exportRoot: string): string;

/**
 * Orchestrator — the autonomy contract for the shorts pipeline:
 * brief → director → render → gate; pass = export + log; fail = bounded
 * retries with spec VARIATION, then ESCALATE to the operator.
 *
 * It must never loop unboundedly — bounded-retry-then-escalate is the fix for
 * the system's known "churn-as-completion" failure mode. Pure routing over
 * injected deps; no LLM/ffmpeg/sqlite knowledge lives here.
 */
interface OrchestratorDeps {
    /** Retry budget AFTER the initial attempt (total attempts = maxRetries + 1). */
    maxRetries: number;
    director: (brief: DirectorBrief) => Promise<SceneSpec>;
    render: (spec: SceneSpec) => Promise<string[]>;
    keyFrameHashes: (mp4OrFrames: string[]) => Promise<string[]>;
    gate: (input: GateInput) => Promise<GateVerdict>;
    store: StudioStore;
    /** Bound by the caller over an export root; returns the export dir. */
    exportRender: (spec: SceneSpec, caption: string, files: string[]) => string;
}
interface OrchestratorResult {
    verdict: "pass" | "escalate";
    exportDir?: string;
    reason: string;
    attempts: number;
    bestConfidence: number;
}
declare function runStudioBrief(brief: DirectorBrief, deps: OrchestratorDeps): Promise<OrchestratorResult>;

export { type DirectorBrief, type DirectorDeps, type GateDeps, type GateInput, type GateVerdict, HostBusyError, type OrchestratorDeps, type OrchestratorResult, type RecordRenderInput, type RenderRow, type SceneSpec, type SceneSpecInput, SceneSpecSchema, StudioStore, createBrandJudge, direct, evaluate, exportRender, extractKeyFrameHashes, hamming, isHostBusy, phash, phashFromPng, renderShort, runStudioBrief, stripMarkdownFences };
