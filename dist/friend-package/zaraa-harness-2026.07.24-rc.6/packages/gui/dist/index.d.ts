import { z } from 'zod';

declare const BboxSchema: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    w: z.ZodNumber;
    h: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
    w: number;
    h: number;
}, {
    x: number;
    y: number;
    w: number;
    h: number;
}>;
type Bbox = z.infer<typeof BboxSchema>;
declare const ScreenshotSchema: z.ZodObject<{
    pngBase64: z.ZodString;
    width: z.ZodNumber;
    height: z.ZodNumber;
    capturedAt: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    pngBase64: string;
    width: number;
    height: number;
    capturedAt: number;
}, {
    pngBase64: string;
    width: number;
    height: number;
    capturedAt: number;
}>;
type Screenshot = z.infer<typeof ScreenshotSchema>;
declare const ActionSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"click">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    button: z.ZodEnum<["left", "right", "middle"]>;
    clicks: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
    type: "click";
    button: "left" | "right" | "middle";
    clicks: 1 | 2;
}, {
    x: number;
    y: number;
    type: "click";
    button: "left" | "right" | "middle";
    clicks: 1 | 2;
}>, z.ZodObject<{
    type: z.ZodLiteral<"type">;
    text: z.ZodString;
    redact: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: "type";
    text: string;
    redact?: boolean | undefined;
}, {
    type: "type";
    text: string;
    redact?: boolean | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"key">;
    keys: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    keys: string[];
    type: "key";
}, {
    keys: string[];
    type: "key";
}>, z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    dx: z.ZodNumber;
    dy: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
    type: "scroll";
    dx: number;
    dy: number;
}, {
    x: number;
    y: number;
    type: "scroll";
    dx: number;
    dy: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"drag">;
    fromX: z.ZodNumber;
    fromY: z.ZodNumber;
    toX: z.ZodNumber;
    toY: z.ZodNumber;
    button: z.ZodDefault<z.ZodEnum<["left", "right", "middle"]>>;
}, "strip", z.ZodTypeAny, {
    type: "drag";
    button: "left" | "right" | "middle";
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
}, {
    type: "drag";
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    button?: "left" | "right" | "middle" | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"wait">;
    ms: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "wait";
    ms: number;
}, {
    type: "wait";
    ms: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"screenshot">;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        w: z.ZodNumber;
        h: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
        w: number;
        h: number;
    }, {
        x: number;
        y: number;
        w: number;
        h: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "screenshot";
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | undefined;
}, {
    type: "screenshot";
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | undefined;
}>]>;
type Action = z.infer<typeof ActionSchema>;

type CaptureCmd = {
    id: string;
    cmd: "capture";
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
};
type ClickCmd = {
    id: string;
    cmd: "click";
    x: number;
    y: number;
    button: "left" | "right" | "middle";
    clicks: 1 | 2;
};
type TypeCmd = {
    id: string;
    cmd: "type";
    text: string;
};
type KeyCmd = {
    id: string;
    cmd: "key";
    keys: string[];
};
type DragCmd = {
    id: string;
    cmd: "drag";
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    button: "left" | "right" | "middle";
};
type ScrollCmd = {
    id: string;
    cmd: "scroll";
    x: number;
    y: number;
    dx: number;
    dy: number;
};
type FrontmostAppCmd = {
    id: string;
    cmd: "frontmost_app";
};
type HelperCommand = CaptureCmd | ClickCmd | TypeCmd | KeyCmd | DragCmd | ScrollCmd | FrontmostAppCmd;
type HelperResponse = {
    kind: "response";
    id: string;
    ok: true;
    data: Record<string, unknown>;
} | {
    kind: "response";
    id: string;
    ok: false;
    error: string;
};
type HelperEvent = {
    kind: "event";
    event: string;
    name: string;
};
declare function encodeCommand(cmd: HelperCommand): string;
declare function decodeResponse(line: string): HelperResponse | null;
declare function decodeEvent(line: string): {
    event: string;
    name: string;
} | null;

declare class HelperClient {
    private readonly binPath;
    private proc;
    private pending;
    private buf;
    private starting;
    private hotkeyListeners;
    constructor(binPath: string);
    onHotkey(listener: (name: string) => void): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    capture(region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    }): Promise<Screenshot>;
    click(args: {
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        clicks: 1 | 2;
    }): Promise<void>;
    key(keys: string[]): Promise<void>;
    type(text: string): Promise<void>;
    drag(args: {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        button?: "left" | "right" | "middle";
    }): Promise<void>;
    scroll(args: {
        x: number;
        y: number;
        dx: number;
        dy: number;
    }): Promise<void>;
    frontmostApp(): Promise<string | undefined>;
    private send;
    private onStdout;
    private onExit;
}

/** Recent actions the agent has taken — sliding window for prompt context. */
type ActionHistory = ReadonlyArray<{
    action: Action;
    outcome: "ok" | "error";
    at: number;
}>;
/** Input the VLM sees when planning the next step. */
type VlmInput = {
    /** Base64 PNG of the current screen (or region). */
    screenshotBase64: string;
    /** Pixel dimensions of the screenshot — needed by some providers' coordinate space. */
    width: number;
    height: number;
    /** Natural-language goal the agent is trying to accomplish. */
    goal: string;
    /** Optional: regions blacked out before send (sensitive-app guard, Phase 4). */
    redactedRegions?: ReadonlyArray<Bbox>;
};
/**
 * One concrete next-step action the model is proposing, plus an optional reasoning trace.
 * The action has already been validated against ActionSchema by the parser before
 * the provider returns it.
 */
type PlannedAction = {
    action: Action;
    /** Short natural-language thought from the model, if it emitted one. */
    thought?: string;
};
/**
 * A pluggable VLM adapter. Implementations live in this directory:
 * - ollama.ts (Phase 2 — local, default)
 * - anthropic.ts, openai.ts (Phase 5)
 */
interface VlmProvider {
    /** Stable name for logging / config (e.g. "ollama:qwen2.5vl:7b"). */
    readonly name: string;
    /** True iff this provider runs entirely on-host (screenshots never leave the machine). */
    readonly isLocal: boolean;
    /**
     * Given a screenshot + goal + history, return one or more planned actions.
     * Returns an empty array if the model thinks the task is complete.
     * Throws on transport / parse failures so the agent loop can decide whether to retry.
     */
    plan(input: VlmInput, history: ActionHistory): Promise<PlannedAction[]>;
}

type OllamaProviderConfig = {
    model: string;
    host: string;
    /** How long Ollama keeps the model resident after a call (default "30m"). */
    keepAlive?: string;
    /** Inject for testing. Defaults to globalThis.fetch. */
    fetch?: typeof fetch;
};
declare class OllamaProvider implements VlmProvider {
    readonly name: string;
    readonly isLocal = true;
    private readonly model;
    private readonly host;
    private readonly keepAlive;
    private readonly fetchFn;
    constructor(cfg: OllamaProviderConfig);
    plan(input: VlmInput, history: ActionHistory): Promise<PlannedAction[]>;
}

type AnthropicProviderConfig = {
    /** Model id, e.g. "claude-opus-4-7" or "claude-sonnet-4-6". */
    model: string;
    /** Anthropic API key. Read from env if not provided. */
    apiKey?: string;
    /** Override the API base. Default: https://api.anthropic.com */
    baseUrl?: string;
    /** Max output tokens. Default: 1024. */
    maxTokens?: number;
    /** Inject for testing. */
    fetch?: typeof fetch;
};
declare class AnthropicProvider implements VlmProvider {
    readonly name: string;
    readonly isLocal = false;
    private readonly model;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly maxTokens;
    private readonly fetchFn;
    constructor(cfg: AnthropicProviderConfig);
    plan(input: VlmInput, history: ActionHistory): Promise<PlannedAction[]>;
}

type OpenAIProviderConfig = {
    /** Model id, e.g. "gpt-4o" or "gpt-4o-mini". */
    model: string;
    /** OpenAI API key. Read from env if not provided. */
    apiKey?: string;
    /** Override the API base. Default: https://api.openai.com */
    baseUrl?: string;
    /** Inject for testing. */
    fetch?: typeof fetch;
};
declare class OpenAIProvider implements VlmProvider {
    readonly name: string;
    readonly isLocal = false;
    private readonly model;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(cfg: OpenAIProviderConfig);
    plan(input: VlmInput, history: ActionHistory): Promise<PlannedAction[]>;
}

type ChatGptAuth = {
    accessToken: string;
    accountId: string;
};
/**
 * Load the ChatGPT subscription OAuth token from the first readable path.
 * Reads `tokens.access_token` + `tokens.account_id` (the codex auth.json shape).
 * Throws a clear, actionable error if no usable credential is found.
 */
declare function loadChatGptAuth(opts?: {
    paths?: string[];
    readFile?: (p: string) => string;
}): ChatGptAuth;
type ReasoningEffort = "minimal" | "low" | "medium" | "high";
type ChatGptSubscriptionConfig = {
    /** Model id; ChatGPT accounts accept the plain family ids (default "gpt-5.5"). */
    model?: string;
    /** Reasoning depth. "low" keeps the game loop responsive (default). */
    reasoningEffort?: ReasoningEffort;
    /** Override the responses endpoint. */
    endpoint?: string;
    /** Override the auth file search paths. */
    authPaths?: string[];
    /** Inject the credential loader (defaults to reading the codex auth file). */
    loadAuth?: () => Promise<ChatGptAuth> | ChatGptAuth;
    /** Abort the request after this many ms so a hung connection can't stall the loop (default 45000). */
    timeoutMs?: number;
    /** Inject for testing. */
    fetch?: typeof fetch;
    /** Inject for testing (session id header). */
    randomUUID?: () => string;
};
/**
 * Parse a Codex /responses SSE body into the final assistant text. Concatenates
 * `response.output_text.delta` events; if none were streamed, falls back to the
 * text carried on the terminal `response.completed` event.
 */
declare function parseResponsesSse(body: string): string;
/**
 * Text-only reasoner backed by the ChatGPT Pro subscription. `respond` sends a
 * system + user prompt and returns the assistant's raw text.
 */
declare class ChatGptSubscriptionClient {
    readonly name: string;
    readonly isLocal = false;
    private readonly model;
    private readonly effort;
    private readonly endpoint;
    private readonly loadAuthFn;
    private readonly fetchFn;
    private readonly uuid;
    private readonly timeoutMs;
    constructor(cfg?: ChatGptSubscriptionConfig);
    respond(system: string, user: string): Promise<string>;
}

type SceneTarget = {
    label: string;
    x: number;
    y: number;
};
type Scene = {
    objective?: string;
    dialogue?: string;
    targets: SceneTarget[];
    notes?: string;
};
/**
 * Parse the local model's scene description. Throws when no JSON is present so
 * the hybrid loop can fall back to the local model's direct action plan.
 */
declare function parseScene(raw: string): Scene;
declare function buildObservePrompt(goal: string, width: number, height: number): {
    system: string;
    user: string;
};
type OllamaGrounderConfig = {
    model: string;
    host: string;
    /** Cap scene-description tokens to keep grounding fast/bounded (default 512). */
    numPredict?: number;
    /**
     * How long Ollama keeps the model resident after a call. During a play loop we
     * want it to stay warm across frames so each grounding isn't a cold load
     * (default "30m"). Pass "0" to unload immediately, or "-1" to pin forever.
     */
    keepAlive?: string;
    fetch?: typeof fetch;
};
/**
 * Build the gemma grounding function: send the screenshot to ollama and parse
 * the model's reply into a Scene.
 */
declare function createOllamaGrounder(cfg: OllamaGrounderConfig): (input: VlmInput) => Promise<Scene>;

type HybridLogEvent = {
    kind: "grounded";
    targets: number;
} | {
    kind: "grounder-error";
    detail: string;
} | {
    kind: "strategist-error";
    detail: string;
} | {
    kind: "fallback-error";
    detail: string;
} | {
    kind: "idle";
};
type HybridDeps = {
    /** Local vision/grounding (gemma): screenshot -> structured scene. */
    observe: (input: VlmInput) => Promise<Scene>;
    /** Cloud reasoning (GPT): (system, user) -> raw action JSON text. */
    strategize: (system: string, user: string) => Promise<string>;
    /** Local solo planner used when the cloud path is unavailable. */
    fallbackPlan: (input: VlmInput, history: ActionHistory) => Promise<PlannedAction[]>;
    /** Display name for logging. */
    name?: string;
    log?: (e: HybridLogEvent) => void;
};
declare function buildStrategistPrompt(scene: Scene, input: VlmInput, history: ActionHistory): {
    system: string;
    user: string;
};
declare class HybridVlmProvider implements VlmProvider {
    readonly name: string;
    readonly isLocal = false;
    private readonly deps;
    constructor(deps: HybridDeps);
    plan(input: VlmInput, history: ActionHistory): Promise<PlannedAction[]>;
    /**
     * Run the local fallback planner; if IT also fails (e.g. the local model is
     * down too), return [] (idle) rather than throwing — the loop must never crash.
     */
    private safeFallback;
}

declare const DEFAULT_GUI_TOOLS: readonly ["gui_screenshot", "gui_describe", "gui_plan", "gui_wait", "gui_scroll", "gui_click", "gui_key", "gui_type", "gui_drag"];
type GuiToolName = (typeof DEFAULT_GUI_TOOLS)[number];
declare class GuiAllowlist {
    private readonly set;
    constructor(names?: ReadonlyArray<string>);
    allows(name: string): boolean;
    names(): string[];
}

type RateLimitConfig = {
    windowMs: number;
    maxEvents: number;
    name?: string;
};
declare class RateLimitError extends Error {
    readonly bucket: string;
    readonly limit: number;
    readonly windowMs: number;
    constructor(bucket: string, limit: number, windowMs: number);
}
declare class RateLimiter {
    readonly name: string;
    private readonly windowMs;
    private readonly maxEvents;
    private readonly times;
    private readonly nowFn;
    constructor(cfg: RateLimitConfig, nowFn?: () => number);
    consume(): void;
    available(): number;
}

declare const DEFAULT_SENSITIVE_BUNDLES: readonly ["com.agilebits.onepassword7", "com.agilebits.onepassword4", "com.1password.1password", "com.apple.keychainaccess", "com.apple.systempreferences", "com.apple.SecurityAgent"];
type SensitiveAppGuardConfig = {
    extra?: ReadonlyArray<string>;
    baseList?: ReadonlyArray<string>;
};
declare class SensitiveAppGuard {
    private readonly set;
    constructor(cfg?: SensitiveAppGuardConfig);
    isBlocked(bundleId: string | undefined): boolean;
    reasonFor(bundleId: string | undefined): string | null;
}

declare function redactPng(pngBuffer: Buffer, regions: ReadonlyArray<Bbox>): Promise<Buffer>;
declare function redactBase64(pngBase64: string, regions: ReadonlyArray<Bbox>): Promise<string>;

/**
 * Process-wide kill switch for GUI agent actions.
 *
 * Once `trip(reason)` is called the `aborted` flag latches to `true` until
 * `reset()` is called. Subscribers registered via `onTrip()` are notified
 * exactly once per tripped period with the first reason string. Subscribers registered via
 * `onReset()` are notified exactly once per reset (only when the switch was
 * actually tripped).
 *
 * `attachHelper(helper)` wires a HelperClient-like object's hotkey stream
 * into the switch so the user-facing "kill" hotkey trips the switch. Other
 * hotkey names (e.g. future "pause") are ignored — only `name === "kill"`
 * triggers an abort.
 */
interface HelperLike {
    onHotkey(listener: (name: string) => void): () => void;
}
declare class KillSwitch {
    private _aborted;
    private tripListeners;
    private resetListeners;
    get aborted(): boolean;
    trip(reason: string): void;
    onTrip(listener: (reason: string) => void): () => void;
    reset(reason?: string): void;
    onReset(listener: (reason: string) => void): () => void;
    attachHelper(helper: HelperLike): () => void;
}

/** A rectangular region of the frame to scan (screen-space pixels). */
type HighlightRegion = {
    x: number;
    y: number;
    w: number;
    h: number;
};
/** A detected highlight: the click target plus blob diagnostics. */
type Highlight = {
    /** Centroid of the locked glow blob — the click target (frame-space). */
    x: number;
    y: number;
    /** Number of pixels in the locked blob. */
    blobSize: number;
    /** Total glow pixels found across the whole scanned region. */
    glowPixels: number;
    /** Bounding box of the locked blob (frame-space). */
    bbox: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        w: number;
        h: number;
    };
};
type DetectHighlightOptions = {
    /** Limit the scan to this region. Defaults to the whole frame. */
    region?: HighlightRegion;
    /**
     * Rectangles to ignore (frame-space). Glow pixels inside any of these are
     * skipped. Use it to mask UI that glows the same yellow — chiefly the OSRS
     * MINIMAP, whose yellow NPC dots otherwise form a dense blob that the fast
     * path would "click", walking the player onto a map dot.
     */
    exclude?: HighlightRegion[];
    /**
     * Minimum total glow pixels required before a detection is reported. Below
     * this, the frame is treated as having no highlight (returns null). MEASURED
     * floor is 25 (scattered noise from torches / the player's pants stays under).
     */
    minBlob?: number;
    /**
     * Pixel predicate that decides what counts as a "highlight" pixel. Defaults to
     * `isGlow` (the vanilla client's yellow hint glow). Pass a `colorMatcher(...)`
     * to lock onto a UNIQUE colour instead — e.g. RuneLite's NPC Indicators
     * painting a target's clickbox pure magenta. A unique colour is unambiguous
     * (no player-glow / occlusion confusion) and, when it's the clickbox fill, its
     * centroid is a GUARANTEED-clickable point on the NPC.
     */
    match?: (r: number, g: number, b: number) => boolean;
};
/** A decoded RGBA frame the tracker can scan directly (skips PNG decode). */
type RgbaFrame = {
    width: number;
    height: number;
    data: Uint8Array | Buffer;
};
/**
 * True iff (r,g,b) is an OSRS tutorial highlight glow pixel.
 *
 * MEASURED on the live client:
 *  - The hint glow / down-arrow is bright yellow: R≈G≈250, B in ~30..127.
 *  - The player's olive pants are the main confuser — they peak at G~160 with
 *    R-G~50, so requiring g>=212 AND (r-g)<=35 (R≈G) rejects them.
 *  - (g-b)>=80 rejects near-white UI chrome; b<=140 still admits the gate glow
 *    (whose blue channel runs up to ~127).
 */
declare function isGlow(r: number, g: number, b: number): boolean;
/**
 * Build a pixel predicate that matches a single UNIQUE colour within a per-channel
 * tolerance. Use it with `detectHighlight({ match: colorMatcher({ r, g, b }) })`
 * when RuneLite's NPC Indicators paints a target a colour nothing else in the
 * scene uses (e.g. pure magenta {255,0,255}). The default tolerance of 60 absorbs
 * the client's anti-aliasing / lighting on the indicator edge while still
 * rejecting unrelated scenery, since OSRS has no naturally pure magenta/cyan.
 */
declare function colorMatcher(target: {
    r: number;
    g: number;
    b: number;
}, tol?: number): (r: number, g: number, b: number) => boolean;
/**
 * Detect the brightest OSRS highlight glow in a captured frame and return its
 * centroid as the click target, or null when no highlight is present.
 *
 * Accepts either a base64-encoded PNG (as captured by the helper) or an already
 * decoded RGBA frame (cheaper — no decode). The returned coordinates are in the
 * frame's own pixel space; the caller maps them to absolute screen space.
 *
 * Algorithm (ported from the validated controllers):
 *  1. Collect every glow pixel (see `isGlow`) within the region.
 *  2. Bin them into CELL-sized cells; take the densest cell (histogram peak) so
 *     scattered noise can't drag the target off the real highlight.
 *  3. Gather glow pixels within LOCK_RADIUS of the peak — the locked blob.
 *  4. Return the blob CENTROID (not a lower-biased point: lower-biasing landed
 *     the click on the ground -> "I can't reach that!").
 */
declare function detectHighlight(source: string | RgbaFrame, opts?: DetectHighlightOptions): Highlight | null;

/** Minimap circle in frame-space pixels. */
type Minimap = {
    cx: number;
    cy: number;
    r: number;
};
/** A detected minimap hint arrow. bearingDeg: 0=top/ahead, +90=right, ±180=behind, -90=left. */
type MinimapArrow = {
    x: number;
    y: number;
    bearingDeg: number;
    dist: number;
    pixels: number;
};
/**
 * A camera-rotation plan as a horizontal MIDDLE-DRAG (the only thing that
 * rotates this OSRS client — arrow keys are tap-only and don't turn the camera).
 * Drag from (fromX,fromY) to (toX,toY) with the middle button to bring the
 * objective toward the top of the view. `turnDeg` is the intended yaw.
 */
type CameraDrag = {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    turnDeg: number;
};
type DetectArrowOptions = {
    /** Min glow pixels in the rim annulus before reporting an arrow. Default 8. */
    minPixels?: number;
    /**
     * Inner radius (fraction of r) of the annulus to scan. The hint arrow rides
     * the rim; NPC dots cluster near the centre (the player), so scanning only the
     * outer annulus isolates the arrow. Default 0.55.
     */
    edgeFrac?: number;
};
/**
 * Find the yellow hint arrow on the minimap rim and return its bearing from the
 * minimap centre (0=top/ahead, clockwise positive), or null if no arrow.
 */
declare function detectMinimapArrow(source: string | RgbaFrame, minimap: Minimap, opts?: DetectArrowOptions): MinimapArrow | null;
type PlanCameraDragOptions = {
    /** Viewport centre (region-relative px) to drag from — the drag is horizontal. */
    center: {
        x: number;
        y: number;
    };
    /**
     * Horizontal drag pixels per degree of camera yaw. LIVE-CALIBRATED ≈3 (a
     * 400px drag spun ~150°); default biases low so the compass under-rotates and
     * converges over a few steps rather than overshooting.
     */
    pxPerDeg?: number;
    /**
     * Sign that makes a positive turn drag the correct way. With dragSign=+1, a
     * turn that needs the view rotated "left" drags the cursor right. CALIBRATE
     * LIVE (capture→drag→capture, check the minimap arrow moved toward the top);
     * flip to -1 if it rotates the wrong way. Default +1.
     */
    dragSign?: 1 | -1;
    /** Don't turn if the arrow is already within this many degrees of ahead. Default 10. */
    deadzoneDeg?: number;
    /** Cap one drag's horizontal pixels; bigger turns split across loop steps. Default 500. */
    maxDragPx?: number;
};
/**
 * Given the arrow's bearing, return a horizontal MIDDLE-DRAG that rotates the
 * camera toward the objective (top of view), or null if already ahead (deadzone).
 *
 * To move an arrow at bearing θ to the top, rotate by -θ; the drag distance is
 * |θ|·pxPerDeg (capped), and the drag direction is sign(-θ)·dragSign — both the
 * magnitude scale and the direction sign are LIVE-CALIBRATED constants.
 */
declare function planCameraDrag(bearingDeg: number, opts: PlanCameraDragOptions): CameraDrag | null;

/** The slice of HelperClient the loop drives. */
interface PlayHelper {
    capture(region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    }): Promise<{
        pngBase64: string;
        width: number;
        height: number;
        capturedAt: number;
    }>;
    click(args: {
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        clicks: 1 | 2;
    }): Promise<void>;
    key(keys: string[]): Promise<void>;
    type(text: string): Promise<void>;
    drag(args: {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        button?: "left" | "right" | "middle";
    }): Promise<void>;
    scroll(args: {
        x: number;
        y: number;
        dx: number;
        dy: number;
    }): Promise<void>;
    frontmostApp(): Promise<string | undefined>;
}
interface PlayRateLimiter {
    /** Throws when the per-window action budget is exhausted. */
    consume(): void;
    available(): number;
}
interface PlayKillSwitch {
    readonly aborted: boolean;
}
type PlayLoopEvent = {
    kind: "step";
    step: number;
    frontmost: string | undefined;
} | {
    kind: "fast-path";
    step: number;
    x: number;
    y: number;
    blobSize: number;
} | {
    kind: "compass";
    step: number;
    bearingDeg: number;
    turnDeg: number;
    dragPx: number;
} | {
    kind: "dialogue";
    step: number;
    advances: number;
} | {
    kind: "plan";
    step: number;
    actions: number;
} | {
    kind: "plan-error";
    step: number;
    detail: string;
} | {
    kind: "action";
    action: Action;
    outcome: "ok" | "error";
    detail?: string;
} | {
    kind: "refused-secret";
    preview: string;
} | {
    kind: "throttled";
} | {
    kind: "not-frontmost";
    frontmost: string | undefined;
    consecutive: number;
} | {
    kind: "stuck";
    step: number;
    recovery: "camera-rotate" | "walk";
} | {
    kind: "region-refresh";
    region: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
} | {
    kind: "stop";
    reason: PlayStopReason;
};
type PlayLoopDeps = {
    helper: PlayHelper;
    vlm: VlmProvider;
    killSwitch: PlayKillSwitch;
    rateLimiter: PlayRateLimiter;
    log?: (event: PlayLoopEvent) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Override the secret detector (defaults to looksLikeSecret). */
    isSecretText?: (text: string) => boolean;
    /** Override the image downscaler (defaults to downscalePngNearest). */
    downscale?: (pngBase64: string, targetWidth: number) => {
        pngBase64: string;
        width: number;
        height: number;
    };
    /**
     * Override the highlight detector (defaults to detectHighlight). Only consulted
     * when opts.useHighlightFastPath is set. Receives the full-res region capture
     * (base64 PNG) so the returned centroid is in region-relative pixel space.
     */
    detectHighlight?: (pngBase64: string, opts?: {
        minBlob?: number;
        exclude?: HighlightRegion[];
        match?: (r: number, g: number, b: number) => boolean;
    }) => Highlight | null;
    /** Override the minimap arrow detector (defaults to detectMinimapArrow). */
    detectMinimapArrow?: (pngBase64: string, minimap: Minimap) => {
        bearingDeg: number;
    } | null;
    /** Override the camera-drag planner (defaults to planCameraDrag). */
    planCameraDrag?: (bearingDeg: number, opts: {
        center: {
            x: number;
            y: number;
        };
        pxPerDeg?: number;
        dragSign?: 1 | -1;
        maxDragPx?: number;
    }) => CameraDrag | null;
    /** Override the dialogue detector (defaults to detectDialogue). */
    detectDialogue?: (pngBase64: string) => {
        open: boolean;
    };
    /**
     * Override the frame-signature fn (defaults to frameSignature). Used by the
     * opt-in stuck detector to tell a frozen scene from a changing one.
     */
    frameSignature?: (source: string, opts?: {
        excludeHud?: {
            x: number;
            y: number;
            w: number;
            h: number;
        };
    }) => number;
    /**
     * Re-detect the game window region. Called on focus-regain and on a stuck
     * verdict (the window may have moved/resized). Returning undefined keeps the
     * current region. A throw is swallowed and the current region is kept.
     */
    refreshRegion?: () => Promise<{
        x: number;
        y: number;
        w: number;
        h: number;
    } | undefined>;
};
type PlayLoopOptions = {
    /** Natural-language objective handed to the VLM each step. */
    goal: string;
    /** Bundle id of the game window; the loop only acts while this app is frontmost. */
    targetBundleId: string;
    /**
     * Capture only this screen region (the game window) instead of the full desktop.
     * Smaller image = faster inference + better coordinate grounding. The VLM sees
     * region-relative coordinates; the loop translates them back to absolute screen
     * coordinates (offset by region.x/region.y) before issuing input.
     */
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    /**
     * Downscale the captured image to this width before sending it to the VLM.
     * Far fewer vision tokens = much faster local inference; coordinates are
     * scaled back up before input is issued.
     */
    downscaleWidth?: number;
    maxSteps?: number;
    maxMs?: number;
    /** Pause between steps (human-like cadence). */
    stepDelayMs?: number;
    /** Consecutive empty plans before declaring the goal idle/complete. */
    maxConsecutiveEmptyPlans?: number;
    /** Consecutive non-frontmost checks before giving up (lost focus). */
    maxConsecutiveNotFrontmost?: number;
    /** Cap on actions executed per planning step. */
    maxActionsPerStep?: number;
    /** Consecutive VLM plan() failures before giving up (graceful degradation, not a crash). */
    maxConsecutivePlanErrors?: number;
    /**
     * OPT-IN fast path (default false): before each VLM call, run the in-process
     * highlight tracker on the capture. If the game is drawing a bright tutorial
     * highlight, left-click its centroid and skip the VLM for that step — a
     * detect->act gap of milliseconds instead of a per-frame model call. When no
     * highlight is present the loop falls back to the existing VLM path.
     */
    useHighlightFastPath?: boolean;
    /**
     * Minimum glow-blob pixel count required for the fast path to fire. Below this
     * the loop falls through to the VLM. Defaults to the tracker's own floor (25).
     */
    highlightMinBlob?: number;
    /**
     * Frame-space rectangles the fast-path detector must ignore (passed straight
     * to detectHighlight's `exclude`). Use it to mask the MINIMAP — its yellow NPC
     * dots glow the same colour and would otherwise be clicked. Coordinates are
     * relative to the capture (i.e. the region, when one is set).
     */
    highlightExclude?: HighlightRegion[];
    /**
     * Optional pixel predicate the fast path uses to decide what counts as a
     * "highlight" pixel (passed straight to detectHighlight's `match`). Leave it
     * unset to keep the DEFAULT vanilla-yellow `isGlow` behaviour. Pass a
     * `colorMatcher({ r, g, b }, tol)` to lock onto a UNIQUE colour instead — e.g.
     * RuneLite's NPC Indicators painting a target's clickbox pure magenta. A unique
     * colour is unambiguous (no player-glow / minimap-dot confusion) and, when it's
     * the clickbox fill, its centroid is a guaranteed-clickable point on the NPC.
     */
    highlightMatch?: (r: number, g: number, b: number) => boolean;
    /**
     * OPT-IN navigation (default false): when the fast path finds no on-screen
     * highlight, read the minimap's yellow hint-arrow and rotate the camera toward
     * the objective (tapping arrow keys) instead of calling the VLM, so the next
     * step can see and click the target. Requires `minimap`. Rotation is a
     * horizontal MIDDLE-DRAG (arrow keys don't turn this client). Needs live
     * calibration of `minimap`, `compassPxPerDeg`, and `compassDragSign`.
     */
    useMinimapCompass?: boolean;
    /** Minimap circle in capture (region-relative) pixels — required for the compass. */
    minimap?: Minimap;
    /** Horizontal drag px per degree of camera yaw (calibrate live; default 6). */
    compassPxPerDeg?: number;
    /** Drag-direction sign (+1/-1) — flip if the camera turns the wrong way (calibrate live). */
    compassDragSign?: 1 | -1;
    /** Viewport centre (region-relative) to drag from. Defaults to the capture centre. */
    compassCenter?: {
        x: number;
        y: number;
    };
    /** Cap one compass drag's horizontal px (big turns split across steps, re-look). Default 500. */
    compassMaxDragPx?: number;
    /** Consecutive compass-only steps before forcing a VLM step (anti-spin). Default 8. */
    compassMaxTurns?: number;
    /**
     * OPT-IN (default false): when no on-screen highlight, detect an open OSRS
     * dialogue/chat panel and press space to advance it instead of calling the
     * VLM — autonomously clicks through the tutorial's many message screens.
     */
    useDialogueAdvance?: boolean;
    /**
     * Consecutive space-presses before handing the dialogue to the VLM (anti-spin
     * for option screens where space does nothing). Default 12.
     */
    maxDialogueAdvances?: number;
    /**
     * OPT-IN stuck recovery (default false): track the fast-path target + a frame
     * brightness fingerprint across steps. When the fast path keeps clicking the
     * SAME point on a FROZEN scene (e.g. re-clicking an occluded NPC whose click
     * only ever returns "Walk here"), the fast-path branch would otherwise loop
     * forever (it has no self-cap). Instead, ROTATE THE CAMERA one notch to change
     * the view so the next step can reach the target from a clear angle. Requires a
     * region (the rotate is a viewport middle-drag).
     */
    useStuckRecovery?: boolean;
    /** Consecutive frozen+same-target fast-path steps before declaring stuck. Default 3. */
    stuckThreshold?: number;
    /** Frame history window for stuck detection. Default 5. */
    stuckHistorySize?: number;
    /** Max brightness-fingerprint delta still counted as "same scene". Default 600. */
    stuckSignatureEpsilon?: number;
    /** Max pixel distance still counted as "same target". Default 12. */
    stuckTargetEpsilon?: number;
    /** Horizontal middle-drag px for one stuck camera rotate. Default 380. */
    stuckCameraRotatePx?: number;
    /**
     * What to do on a stuck verdict. "camera-rotate" (default) spins the view to
     * de-occlude a target. "walk" instead WALKS the character a few tiles toward a
     * rotating viewport edge — relocating it out of a dead cluster (e.g. re-clicking
     * the same trees) so it can explore/path onward. Use "walk" for navigation.
     */
    stuckRecovery?: "camera-rotate" | "walk";
};
type PlayStopReason = "killed" | "max-steps" | "max-time" | "idle" | "lost-focus" | "error";
type PlayLoopResult = {
    stopReason: PlayStopReason;
    steps: number;
    actionsExecuted: number;
    refusedSecrets: number;
    history: ActionHistory;
};
/**
 * Conservative guard: flags text that plausibly carries a credential so the
 * loop never types it into a live window. Deliberately narrow — pure numbers
 * (e.g. Grand Exchange quantities) and ordinary chat are NOT flagged.
 */
declare function looksLikeSecret(text: string): boolean;
/**
 * Offset an action's screen coordinates by (dx, dy). Used to map region-relative
 * VLM coordinates back to absolute screen space. Non-positional actions (type,
 * key, wait, screenshot) are returned unchanged.
 */
declare function translateAction(action: Action, dx: number, dy: number): Action;
/**
 * Map an action's coordinates from (downscaled, region-relative) VLM space back
 * to absolute screen space: multiply by the scale factor, then add the region
 * origin offset. Non-positional actions are returned unchanged.
 */
declare function mapActionToScreen(action: Action, scaleX: number, scaleY: number, offX: number, offY: number): Action;
declare function runPlayLoop(deps: PlayLoopDeps, opts: PlayLoopOptions): Promise<PlayLoopResult>;

/**
 * Nearest-neighbour downscale of a base64 PNG to a target width (preserving
 * aspect ratio). Smaller images mean far fewer vision tokens, so local VLM
 * inference is dramatically faster. Returns the image unchanged when it is
 * already at or below the target width.
 */
declare function downscalePngNearest(pngBase64: string, targetWidth: number): {
    pngBase64: string;
    width: number;
    height: number;
};

/** Press this key to advance / continue an open OSRS dialogue. */
declare const DIALOGUE_ADVANCE_KEY = "space";
/** A detected (or absent) bottom dialogue panel. */
type DialogueDetection = {
    /** True when the parchment fill of the scanned band meets `minFill`. */
    open: boolean;
    /** Fraction (0..1) of scanned-region pixels that are parchment-coloured. */
    fill: number;
    /** Bounding box of the parchment pixels (frame-space). Zero-size when none. */
    box: HighlightRegion;
};
type DetectDialogueOptions = {
    /**
     * Region to scan for the dialogue band. Defaults to the bottom ~28% of the
     * frame, full width — where OSRS draws the chat/dialogue box. A parchment
     * band drawn OUTSIDE this region is ignored.
     */
    region?: HighlightRegion;
    /**
     * Minimum parchment fill fraction of the scanned region before the panel is
     * reported open. MEASURED floor ~0.35: a real dialogue box fills most of the
     * band, while incidental warm pixels (sand, light walls) stay well under.
     */
    minFill?: number;
};
/**
 * True iff (r,g,b) is an OSRS dialogue-box PARCHMENT pixel.
 *
 * The dialogue chrome is a warm light beige / tan. MEASURED ranges on the live
 * client: R ~200..238, G ~188..222, B ~150..196. It is distinctly warm (R>G>B)
 * yet not the bright saturated yellow of the hint glow, and never the dark game
 * background — so a simple per-channel band plus a warmth ordering isolates it.
 */
declare function isParchment(r: number, g: number, b: number): boolean;
/**
 * Detect the OSRS bottom dialogue panel in a captured frame.
 *
 * Accepts either a base64-encoded PNG or an already-decoded RGBA frame (cheaper
 * — no decode). Scans `region` (default: the bottom band), counts parchment
 * pixels (see `isParchment`), and reports:
 *  - `open`  — parchment fill fraction >= `minFill`
 *  - `fill`  — that fraction (always computed, even when closed)
 *  - `box`   — the parchment bounding box in frame-space (zero-size when none)
 *
 * When the panel is open, the caller should advance it rather than hunt for a
 * click target: e.g. when `detectDialogue().open` and the highlight fast-path
 * finds no on-screen glow, emit a `key: [DIALOGUE_ADVANCE_KEY]` action.
 */
declare function detectDialogue(source: string | RgbaFrame, opts?: DetectDialogueOptions): DialogueDetection;

/** A detected highlighted inventory slot: a click point plus blob diagnostics. */
type HighlightedSlot = {
    /** Centroid of the highlight box — the click target (frame-space). */
    x: number;
    y: number;
    /** Number of glow pixels in this box. */
    blobSize: number;
    /** Bounding box of the highlight (frame-space, inclusive). */
    bbox: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
};
type DetectHighlightedSlotsOptions = {
    /** Limit the scan to this region. Defaults to the whole frame. */
    region?: HighlightRegion;
    /**
     * Minimum glow pixels a connected component must have to count as a real
     * highlighted slot. Below this it's treated as noise (a stray glint, an
     * anti-aliased speck) and dropped. MEASURED-ish floor ~20.
     */
    minBox?: number;
};
/**
 * Detect every highlighted inventory slot in a captured frame and return one
 * click point per slot, sorted in reading order (smaller y first, then smaller
 * x — i.e. top row left-to-right, then the next row down).
 *
 * Accepts either a base64-encoded PNG (as captured by the helper) or an
 * already-decoded RGBA frame (cheaper — no decode). Coordinates are in the
 * frame's own pixel space; the caller maps them to absolute screen space.
 *
 * Each yellow highlight box is found via 8-connected flood-fill so two
 * highlighted slots separated by the inventory grid's dark gutter are returned
 * SEPARATELY, never merged.
 */
declare function detectHighlightedSlots(source: string | RgbaFrame, opts?: DetectHighlightedSlotsOptions): HighlightedSlot[];

/** The top-level UI mode the play loop routes on. */
type ScreenMode = "dialogue" | "dark" | "play";
/** Cheap region-average-color signals behind the classification. */
type ScreenSignals = {
    /** Fraction (0..1) of warm-parchment pixels within the bottom band. */
    bottomParchmentFrac: number;
    /** Mean luma over the whole frame (0..255). */
    overallBrightness: number;
};
/** A classified screen: the routed mode plus the numeric signals it came from. */
type ScreenState = {
    mode: ScreenMode;
    signals: ScreenSignals;
};
type ClassifyScreenOptions = {
    /**
     * The band scanned for parchment, in frame-space pixels. Defaults to the
     * bottom ~28% of the frame (where OSRS pins its dialogue/interface panels).
     */
    bottomBand?: HighlightRegion;
    /**
     * Below this overall brightness the frame is "dark" (loading / login / death
     * screen) regardless of any parchment. MEASURED default ~30.
     */
    darkThreshold?: number;
    /**
     * At/above this parchment fraction in the bottom band the frame is "dialogue".
     * Default ~0.3 — a real dialogue panel fills most of the band; stray warm
     * scenery stays well below it.
     */
    parchmentFracThreshold?: number;
};
/**
 * Classify the top-level UI mode of a captured frame from cheap region-average
 * colour only. Accepts a base64-encoded PNG (as captured by the helper) or an
 * already-decoded RGBA frame (cheaper — no decode).
 *
 * Rule (in order):
 *  1. overallBrightness < darkThreshold        -> "dark"
 *  2. bottomParchmentFrac >= parchmentFracThr   -> "dialogue"
 *  3. otherwise                                 -> "play"
 *
 * Both numeric signals are ALWAYS returned so the caller can log, threshold, or
 * recalibrate without re-scanning.
 */
declare function classifyScreen(source: string | RgbaFrame, opts?: ClassifyScreenOptions): ScreenState;

declare const VERSION = "0.0.1";

export { type Action, type ActionHistory, ActionSchema, AnthropicProvider, type AnthropicProviderConfig, type Bbox, BboxSchema, type CameraDrag, type CaptureCmd, type ChatGptAuth, ChatGptSubscriptionClient, type ChatGptSubscriptionConfig, type ClassifyScreenOptions, type ClickCmd, DEFAULT_GUI_TOOLS, DEFAULT_SENSITIVE_BUNDLES, DIALOGUE_ADVANCE_KEY, type DetectArrowOptions, type DetectDialogueOptions, type DetectHighlightOptions, type DetectHighlightedSlotsOptions, type DialogueDetection, type DragCmd, type FrontmostAppCmd, GuiAllowlist, type GuiToolName, HelperClient, type HelperCommand, type HelperEvent, type HelperResponse, type Highlight, type HighlightRegion, type HighlightedSlot, type HybridDeps, type HybridLogEvent, HybridVlmProvider, type KeyCmd, KillSwitch, type Minimap, type MinimapArrow, type OllamaGrounderConfig, OllamaProvider, type OllamaProviderConfig, OpenAIProvider, type OpenAIProviderConfig, type PlanCameraDragOptions, type PlannedAction, type PlayHelper, type PlayKillSwitch, type PlayLoopDeps, type PlayLoopEvent, type PlayLoopOptions, type PlayLoopResult, type PlayRateLimiter, type PlayStopReason, type RateLimitConfig, RateLimitError, RateLimiter, type ReasoningEffort, type RgbaFrame, type Scene, type SceneTarget, type ScreenMode, type ScreenSignals, type ScreenState, type Screenshot, ScreenshotSchema, type ScrollCmd, SensitiveAppGuard, type SensitiveAppGuardConfig, type TypeCmd, VERSION, type VlmInput, type VlmProvider, buildObservePrompt, buildStrategistPrompt, classifyScreen, colorMatcher, createOllamaGrounder, decodeEvent, decodeResponse, detectDialogue, detectHighlight, detectHighlightedSlots, detectMinimapArrow, downscalePngNearest, encodeCommand, isGlow, isParchment, loadChatGptAuth, looksLikeSecret, mapActionToScreen, parseResponsesSse, parseScene, planCameraDrag, redactBase64, redactPng, runPlayLoop, translateAction };
