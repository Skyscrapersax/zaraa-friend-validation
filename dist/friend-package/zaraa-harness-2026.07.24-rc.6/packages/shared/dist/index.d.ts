export { DesignerArtifactKind, DesignerArtifactLintIssue, DesignerArtifactLintStatus, DesignerArtifactLintSummary, ParsedDesignerArtifact, extractDesignerArtifacts, inferDesignerArtifactKind, lintDesignerHtmlArtifact, normalizeDesignerArtifactType } from './designer-artifacts.js';

/**
 * Ordered tuple of all valid zone names — the single source of truth.
 * Derive the Zone type from this tuple so adding a zone only requires
 * one change here, not separate edits to the type and any runtime arrays.
 */
declare const ZONES: readonly ["sandbox", "guarded", "trusted"];
/**
 * Capability zone for an agent action or task.
 *
 * Zones gate what file paths, network hosts, and shell commands the agent
 * may touch.  Ordered from most-restricted to fully-trusted:
 *
 * - **sandbox** — read-only observer.  File writes, outbound network calls,
 *   and shell execution are all denied.  Safe for untrusted or unknown tasks.
 *
 * - **guarded** — scoped operator.  Writes are restricted to an allowed-path
 *   list, network is limited to approved hosts, and shell commands must be
 *   individually approved.  The default zone for agent-generated work.
 *
 * - **trusted** — full access with audit.  All file, network, and shell
 *   operations are permitted.  Every action is logged to the audit trail.
 *   Requires explicit operator elevation; auto-downgrades on anomaly.
 */
type Zone = (typeof ZONES)[number];
interface ZoneCapabilities {
    files: {
        allow: string[];
        deny?: string[];
    };
    network: {
        allow: string[];
        deny?: string[];
    };
    shell: {
        allow: string[];
        approve: string[];
        deny?: string[];
    };
}
interface TrustedZoneConfig {
    enabled: boolean;
    requireAuth: boolean;
    autoDowngrade: {
        afterMinutes: number;
        onAnomaly: boolean;
    };
}

type ActionType = "file.read" | "file.write" | "file.delete" | "shell.exec" | "network.request" | "browser.navigate" | "browser.interact" | "memory.read" | "memory.write" | "memory.delete" | "calendar.read" | "calendar.write" | "messaging.read" | "messaging.send" | "trading.read" | "trading.execute" | "mcp.call";
interface Action {
    id: string;
    type: ActionType;
    target: string;
    params: Record<string, unknown>;
    zone: Zone;
    timestamp: string;
}
type ActionResult = {
    status: "approved";
    result: unknown;
} | {
    status: "denied";
    reason: string;
} | {
    status: "queued";
    approvalId: string;
} | {
    status: "error";
    error: string;
};

type ControlActionType = "runtime.mode.set" | "task-generation.set" | "zone.set" | "kill-switch.set" | "policy.update";
type ControlRiskLevel = "low" | "medium" | "high" | "critical";
type ControlActionStatus = "accepted" | "rejected" | "blocked" | "unsupported" | "error";
type ControlKillSwitchLevel = "off" | "soft" | "hard";
interface ControlActionDefinition {
    action: ControlActionType;
    description: string;
    risk: ControlRiskLevel;
    requiresConfirmation: boolean;
    requiresApproval: boolean;
    scope: string[];
}
interface ControlActionEnvelope {
    action: ControlActionType;
    params: Record<string, unknown>;
    reason?: string;
    confirm?: boolean;
    requestId?: string;
}
interface ControlActionResult {
    actionId: string;
    action: ControlActionType;
    status: ControlActionStatus;
    message: string;
    details?: Record<string, unknown>;
}
interface ControlActionEvent {
    id: string;
    action: ControlActionType;
    status: ControlActionStatus;
    actor: string | null;
    reason: string;
    createdAt: string;
    details: Record<string, unknown>;
}
interface ControlPolicyShell {
    enabled: boolean;
    commandAllowlist: string[];
    commandDenylist: string[];
    maxCommandLength: number;
    requireApprovalForWrites: boolean;
}
interface ControlPolicyFile {
    enabled: boolean;
    allowedRoots: string[];
    blockedPaths: string[];
    maxPayloadBytes: number;
    requireApprovalForWrites: boolean;
}
interface ControlPolicyNetwork {
    enabled: boolean;
    allowedHosts: string[];
    blockedHosts: string[];
    requireApprovalForWrites: boolean;
}
interface ControlPolicyApprovals {
    enabled: boolean;
    requireManualForCritical: boolean;
}
interface ControlPolicy {
    shell: ControlPolicyShell;
    file: ControlPolicyFile;
    network: ControlPolicyNetwork;
    approvals: ControlPolicyApprovals;
}
type ControlPolicyPatch = {
    shell?: Partial<ControlPolicyShell>;
    file?: Partial<ControlPolicyFile>;
    network?: Partial<ControlPolicyNetwork>;
    approvals?: Partial<ControlPolicyApprovals>;
};
interface ControlKillSwitchState {
    active: boolean;
    level: ControlKillSwitchLevel;
    reason?: string | null;
    updatedBy?: string | null;
    updatedAt: string;
}
interface ControlActionStats {
    total: number;
    accepted: number;
    rejected: number;
    blocked: number;
    unsupported: number;
    error: number;
}
interface ControlStatusSnapshot {
    zone: string;
    runtimeMode: string;
    runtimePaused: boolean;
    taskGenerationPaused: boolean;
    killSwitch: ControlKillSwitchState;
    policy: ControlPolicy;
    actionStats: ControlActionStats;
    recentActions: ControlActionEvent[];
}
interface ControlEventsResponse {
    events: ControlActionEvent[];
    total: number;
    limit: number;
}

type MemoryTier = "episodic" | "semantic" | "procedural";
interface MemoryEntry {
    id: string;
    tier: MemoryTier;
    content: string;
    embedding?: number[];
    metadata: Record<string, unknown>;
    relevanceWeight: number;
    createdAt: string;
    updatedAt: string;
    decayRate: number;
    /**
     * Vec cosine relevance (0–1, higher = closer) from the last embedding recall.
     * Present only when retrieved via vector search; fused into multi-signal recall
     * ranking. Undefined for keyword/procedural recall (ranking falls back to the
     * prior tier-weighted behavior).
     */
    relevance?: number;
    /**
     * Set only when the recall query carried literal identifiers (coded IDs,
     * quoted strings, long numbers): "exact" when this entry contains one of
     * them at a token boundary, "fuzzy" otherwise. Undefined for plain
     * natural-language queries. Lets callers distinguish a pinned hit from a
     * near-identical decoy (G400 memory-weave failure shape).
     */
    matchKind?: "exact" | "fuzzy";
    /**
     * Freshness tier ("live" | "recent" | "stale" | "unverified") computed at
     * read time from updatedAt vs. a tier-appropriate expected refresh
     * interval — see classifyFreshnessTier in recency-gate.ts. Attached by
     * search()/searchFast() so callers don't have to compute staleness
     * themselves (Retrieval Staleness Disclosure Rate signal,
     * ~/.zaraa/knowledge/archival-freshness-policy.md).
     */
    freshnessTier?: "live" | "recent" | "stale" | "unverified";
}

interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: LLMToolCall[];
}
interface LLMToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
interface LLMResponse {
    content: string;
    toolCalls: LLMToolCall[];
    usage: {
        promptTokens: number;
        completionTokens: number;
        /** Anthropic prompt caching: tokens written to a new cache entry this request (~1.25× cost). */
        cacheCreationInputTokens?: number;
        /** Anthropic prompt caching: tokens served from cache this request (~0.1× cost). */
        cacheReadInputTokens?: number;
    };
    model: string;
}
type ProviderTimeoutReason = "spawn" | "stream" | "overall";
interface ProviderWarmupResult {
    ok: boolean;
    ms: number;
    latencyMs?: number;
}
interface ProviderMetrics {
    avgLatencyMs?: number;
    avgResponseMs?: number;
    totalCalls?: number;
    errorRate?: number;
    totalRequests?: number;
    totalTokens?: number;
    lastResponseMs?: number;
    errors?: number;
    totalDurationMs?: number;
    totalCostUsd?: number;
    timeoutCount?: number;
    spawnTimeoutCount?: number;
    streamTimeoutCount?: number;
    lastTimeoutReason?: ProviderTimeoutReason | null;
    lastTimeoutMs?: number;
    lastTimeoutAt?: number | null;
}
type BillingMode = "local" | "free" | "subscription" | "metered";
interface ProviderCapabilities {
    /** Whether the provider can issue Zaraa-native structured tool/function calls. */
    supportsNativeTools?: boolean;
    /** Whether the provider supports incremental streaming responses. */
    supportsStreaming?: boolean;
    /**
     * Whether streaming remains reliable when tools are supplied.
     * Some providers can stream text but need the non-streaming path for tool calls.
     */
    supportsStreamingTools?: boolean;
    /** Whether the provider has a large-enough context window for long prompts. */
    supportsLongContext?: boolean;
}
interface ProviderPricing {
    /** Estimated input-token price in USD per 1M tokens. */
    promptPerMillionUsd?: number;
    /** Estimated output-token price in USD per 1M tokens. */
    completionPerMillionUsd?: number;
    /** Optional provenance marker for dashboards/debugging. */
    source?: string;
}
/** Per-call options threaded into a provider's chat()/chatStream(). */
interface ProviderCallOptions {
    /** Abort signal to cancel the in-flight request. Network providers (OpenAI/
     *  OpenRouter, Ollama) honor it; others ignore it (best-effort cancellation). */
    signal?: AbortSignal;
}
interface LLMProvider {
    name: string;
    /** Routing key used by the model router (e.g., "anthropic/claude-sonnet"). Set by provider factory. */
    modelKey?: string;
    /** Capability tier for exploration constraints */
    tier?: "local" | "mid" | "frontier";
    /** Provider economics classification used for budget-aware routing. */
    billingMode?: BillingMode;
    /** Explicit provider behavior/capability metadata used by routing. */
    capabilities?: ProviderCapabilities;
    /** Estimated metered pricing used for budget-aware routing and cost accounting. */
    pricing?: ProviderPricing;
    /** Context window size in tokens (set by OllamaProvider) */
    contextSize?: number;
    chat(messages: LLMMessage[], tools?: LLMToolDefinition[], opts?: ProviderCallOptions): Promise<LLMResponse>;
    chatStream?(messages: LLMMessage[], tools?: LLMToolDefinition[], opts?: ProviderCallOptions): AsyncGenerator<LLMStreamChunk>;
    embed?(text: string): Promise<number[]>;
    /** Pre-load model into memory (OllamaProvider) */
    warmup?(): Promise<ProviderWarmupResult>;
    /** Provider performance metrics */
    getMetrics?(): ProviderMetrics;
}
interface LLMToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
interface LLMStreamChunk {
    type: "text_delta" | "tool_call_delta" | "done" | "stream_retry";
    content?: string;
    toolCall?: {
        index?: number;
        id?: string;
        name?: string;
        arguments?: string;
    };
    finishReason?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        /** Anthropic prompt-cache hits served at ~0.1x input price. */
        cacheReadInputTokens?: number;
        /** Anthropic prompt-cache writes billed at ~1.25x input price. */
        cacheCreationInputTokens?: number;
    };
    model?: string;
}

type PluginTrust = "core" | "verified" | "community" | "local";
interface PluginManifest {
    name: string;
    version: string;
    type: "tool";
    minZone: Zone;
    capabilities: string[];
    tools: PluginToolDefinition[];
    trust: PluginTrust;
}
interface PluginToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    requiresApproval?: boolean;
    /**
     * Minimum zone for this tool. Defaults to the plugin manifest `minZone` when omitted.
     * Use stricter per-tool zones so read-only tools can stay `guarded` while execution
     * and risk mutation require `trusted`.
     */
    minZone?: Zone;
    /** Loading tier: "catalog" (name only), "active" (full def), "extended" (with hints) */
    toolTier?: "catalog" | "active" | "extended";
}

type ProactivityLevel = "silent" | "notify" | "agent";
interface ProactivityConfig {
    level: ProactivityLevel;
    categories?: {
        calendar?: ProactivityLevel;
        tasks?: ProactivityLevel;
        budget?: ProactivityLevel;
    };
}
type CommandCycleMode = "dry-run" | "queue-safe" | "guarded";
type CommandCycleRiskLevel = "low" | "medium" | "high" | "critical";
interface CommandCycleConfig {
    enabled: boolean;
    mode: CommandCycleMode;
    morningLocalTime: string;
    eveningLocalTime: string;
    autoQueueRisk: CommandCycleRiskLevel[];
    approvalRisk: CommandCycleRiskLevel[];
    maxDailyActions: number;
}
/**
 * Goal-bias weights for autonomy task selection.
 *
 * The autonomy loop emits tasks across four pillars: HELPER (operator UX),
 * EARNER (trading edge, revenue), RELIABILITY (daemon/routing health), and
 * SELF (memory, codebase hygiene, learning goals). When the loop's task pool
 * exceeds available capacity, a `selectBiased` helper draws from the pool
 * weighted by these values. Higher = more likely to be chosen.
 *
 * Defaults preserve the currently observed distribution (no behavior change
 * on merge). Operator flips weights manually when they want to push the
 * loop toward earner-pillar focus (e.g. raise `earnerWeight` to 0.5 during
 * a profit sprint).
 */
interface AutonomyGoalBiasConfig {
    helperWeight?: number;
    earnerWeight?: number;
    reliabilityWeight?: number;
    selfWeight?: number;
    /**
     * Weight for CREATIVE pillar (poetry, art, joyful idle work).
     * Default 0 when unset so legacy pools are unchanged until enabled.
     */
    creativeJoyWeight?: number;
}
/** Hardware profile for RAM-aware routing and creative-joy caps. */
type HardwareProfileId = "m4-16gb" | "workstation-32gb" | "workstation-64gb-plus" | "auto";
/**
 * When the operator is busy, Zaraa can still make lovely things (poetry, art)
 * on a local model instead of sitting idle. Duties always outrank joy.
 */
interface CreativeJoyConfig {
    /** Master switch. Default true in DEFAULT_CONFIG; set false to disable. */
    enabled?: boolean;
    /** Max joy tasks per UTC day (profile default if omitted). */
    maxPerDay?: number;
    /** Min idle ms before joy may fire (profile default if omitted). */
    minIdleMs?: number;
    /** Allow joy while operator is actively chatting. Default false. */
    allowWhenUserBusy?: boolean;
    /** Force local-only joy (recommended on 16GB). Default follows hardware profile. */
    localOnly?: boolean;
    /** Where joy artifacts land. Default ~/.zaraa/creative-joy */
    outputDir?: string;
    /** Hardware profile for caps/concurrency hints. */
    hardwareProfile?: HardwareProfileId;
    /**
     * Skip joy while operator was interactive within this many ms (chat priority).
     * Default 20 minutes in DEFAULT_CONFIG. Set 0 to disable this gate.
     */
    chatPriorityMs?: number;
}
/** Daily assistant duty prioritization (duties > revenue > joy). */
interface DailyAssistantConfig {
    /** When true (default), duties always outrank joy in soft ranking. */
    prioritizeDuties?: boolean;
    /** Soft weight for creator-revenue class (0–1). */
    creatorRevenueWeight?: number;
    /** Soft weight for creative-joy class (0–1). */
    creativeJoyWeight?: number;
}
type AutonomyMode = "off" | "assisted" | "handsOff";
/**
 * Routes autonomy-curriculum tasks to a stronger/different model when enabled.
 * Default-off (enabled: false) — flip via zaraa.config.json to activate.
 * 0 = unlimited (same convention as budget-tracker maxTasksPerDay).
 */
interface CurriculumRoutingConfig {
    /** Master switch — no routing change unless true. Default: false. */
    enabled: boolean;
    /** Target model identifier, e.g. "openai:gpt-5.5-low". null = no override. */
    model: string | null;
    /** Max curriculum tasks to route per UTC day. 0 = unlimited. Default: 0. */
    maxTasksPerDay: number;
}
/**
 * Top-level `studio` block — the creative studio plugin (@zaraa/plugin-studio).
 * Default-off (enabled: false) so the whole studio stays inert until activated
 * via zaraa.config.json. Sibling of `autonomy`/`trading`, NOT nested under them.
 */
interface StudioConfig {
    /** Master switch — no studio behavior unless true. Default false. */
    enabled: boolean;
    /** Where export-ready files land. Default ~/.zaraa/studio/exports. */
    exportDir?: string;
    /** Folder the operator drops band track audio into. Default ~/.zaraa/studio/tracks. */
    tracksDir?: string;
    /** Max gate-fail retries before escalating. Default 2. */
    maxRetries?: number;
}
interface AutonomyConfig {
    mode?: AutonomyMode;
    commandCycle?: Partial<CommandCycleConfig>;
    goalBias?: AutonomyGoalBiasConfig;
    /**
     * When true, the growth-assessment loop hard-rejects trading-classified new
     * goals (a backstop to the advisory prompt) and seeds a baseline
     * self-improvement goal when no active self-improvement goal remains, so
     * autonomy re-aims at improving its own codebase instead of trading.
     * Default false → no behavior change.
     */
    selfImprovementOnly?: boolean;
    /**
     * Arms the autonomy kernel (journal, trust ladder, sustainment governor,
     * phase3 admission) by setting ZARAA_SUSTAINMENT_ENABLED=1 at startup.
     * Default absent/false → flags-off runtime, byte-identical to today.
     */
    sustainment?: boolean;
    /**
     * Arms the goal compiler (M2): goal intake, phase compilation, and the
     * advance loop that turns a completed replan node into the next phase.
     * Sets ZARAA_GOAL_COMPILER_ENABLED=1 at startup. Requires `sustainment`
     * — the compiler's verdicts come from the kernel journal, so arming it
     * alone would be a half-armed state. Default absent/false → no behavior
     * change.
     */
    goalCompiler?: boolean;
    /** Route autonomy-curriculum tasks to a stronger model. Default-off. */
    curriculumRouting?: Partial<CurriculumRoutingConfig>;
    /**
     * Idle creative joy — poetry, lyric seeds, art cards so Zaraa is not
     * bored while the operator is busy. Default-on with local-only on m4-16gb.
     */
    creativeJoy?: CreativeJoyConfig;
    /** Daily assistant duty ranking (duties before joy). */
    dailyAssistant?: DailyAssistantConfig;
    /**
     * Hardware profile for RAM-aware background work. Default "m4-16gb" on
     * this home rig; set "auto" to infer from total RAM at runtime.
     */
    hardwareProfile?: HardwareProfileId;
    /**
     * Thinker / maker / work-partner pack — identity, practice series,
     * trust ladder, advisory board injection.
     */
    partnership?: PartnershipConfig;
}
/** Partnership mode — identity, practice, trust, board. */
interface PartnershipConfig {
    /** Inject partnership context into system prompt. Default true. */
    enabled?: boolean;
    injectIdentity?: boolean;
    injectPractice?: boolean;
    injectTrust?: boolean;
    injectBoard?: boolean;
    /** Directory for pack.json (default ~/.zaraa/partnership). */
    dir?: string;
}
interface WhisperFlowConfig {
    baseUrl?: string;
    timeout?: number;
}
interface VoiceConfig {
    /** Master switch for optional voice probes/providers. Default true. */
    enabled?: boolean;
    provider: "openai-realtime" | "openai-realtime-hybrid" | "pipeline";
    stt?: {
        engine: "whisper" | "vosk" | "deepgram" | "xai-stt";
        model?: string;
        baseUrl?: string;
        /** BCP-47 language hint for xai-stt */
        language?: string;
        apiKey?: string;
    };
    tts?: {
        engine: "openai-tts" | "macos-say" | "piper" | "elevenlabs" | "voxtral" | "voxtral-local" | "mlx-audio-local" | "xai-tts";
        /**
         * Voice id/name:
         * - xai-tts: Grok voice_id (eve, ara, leo, rex, sal, or custom clone)
         * - voxtral: Mistral voice_id
         * - voxtral-local / mlx-audio-local / elevenlabs: preset or voice id
         * - openai-tts: platform voice name
         */
        voice?: string;
        model?: string;
        speed?: number;
        apiKey?: string;
        /** Base URL for local TTS servers (voxtral-local) or xAI origin (default https://api.x.ai) */
        baseUrl?: string;
        /** BCP-47 language for xai-tts (default en). */
        language?: string;
    };
    whisperflow?: WhisperFlowConfig;
    /** Twilio integration for real phone calls */
    twilio?: TwilioVoiceCallConfig;
    /** FaceTime Audio integration on macOS. Default true. */
    facetime?: {
        enabled?: boolean;
    };
    /** "Zaraa" wake-word listener (Porcupine). Default-off and inert until an
     *  operator supplies a Picovoice access key and installs the native deps. */
    wakeWord?: WakeWordConfig;
}
interface WakeWordConfig {
    /** Master switch — listener is a no-op unless `true` AND `accessKey` is set. */
    enabled?: boolean;
    /** Picovoice access key (https://console.picovoice.ai). Required to arm.
     *  Falls back to env `PICOVOICE_ACCESS_KEY` when omitted. */
    accessKey?: string;
    /** Absolute path (or `~/…`) to a custom "Zaraa" `.ppn` from Picovoice Console.
     *  When omitted, auto-discovers `~/.zaraa/keywords/zaraa_mac.ppn` (and siblings).
     *  There is no built-in "Zaraa" — train one at https://console.picovoice.ai.
     *  Explicit built-in names (e.g. "jarvis") only if you set them on purpose. */
    keyword?: string;
    /** Detection sensitivity 0..1 (higher = more detections, more false positives). Default 0.5. */
    sensitivity?: number;
    /** Max listen time per utterance after wake (ms). Default 8000. Ends earlier on silence. */
    listenMs?: number;
    /** End utterance after this much silence following speech (ms). Default 700. */
    silenceMs?: number;
    /** Minimum speech before silence can end the utterance (ms). Default 300. */
    minSpeechMs?: number;
    /** After a reply, accept follow-ups without re-wake (ms). 0 disables. Default 8000. */
    hotWindowMs?: number;
}
interface TwilioVoiceCallConfig {
    /** Master switch for inbound phone-call voice. When false (or absent), the
     * public-ingress readiness check is skipped — a dead/disabled tunnel never
     * degrades browser/app voice, which does not use it. */
    enabled?: boolean;
    /** Twilio Account SID */
    accountSid: string;
    /** Twilio Auth Token */
    authToken: string;
    /** Your Twilio phone number in E.164 format — auto-provisioned if omitted */
    fromNumber?: string;
    /** Public URL where Twilio webhooks can reach Zaraa — auto-tunneled via ngrok/cloudflared if omitted */
    publicUrl?: string;
    /** Greeting spoken when the call connects (default: "Hey, it's Zaraa.") */
    greeting?: string;
    /** Country for auto-provisioning phone numbers (default: "US") */
    country?: string;
    /**
     * Local-dev only: skip X-Twilio-Signature validation on /api/twilio/* webhooks.
     * Production must leave this unset/false — missing auth token fails closed (403).
     */
    skipSignatureValidation?: boolean;
}
interface EmbeddingConfig {
    provider: "ollama" | "openai";
    model?: string;
    apiKey?: string;
    baseUrl?: string;
}
/** Local vision-language model used by the vision_analyze tool ("eyes as a tool"). */
interface VisionConfig {
    /** Ollama model tag serving vision requests (default: qwen2.5vl:7b). */
    model?: string;
    /** Native ollama API base URL (default: http://127.0.0.1:11434). */
    baseUrl?: string;
    /** Per-request timeout in ms (default: 60000). */
    timeoutMs?: number;
    /** Maximum accepted image size in bytes (default: 8 MiB). */
    maxImageBytes?: number;
}
interface GatewayAuthConfig {
    apiKey: string;
    enabled?: boolean;
    rateLimit?: {
        maxRequests: number;
        windowMs: number;
    };
}
type NotificationTransport = "os" | "websocket" | "webhook" | "console" | "imessage" | "ntfy";
interface CompletionNotificationConfig {
    enabled?: boolean;
    optInOnly?: boolean;
    channels?: NotificationTransport[];
    longTaskMinMs?: number;
    throttleMs?: number;
    notifyOn?: Array<"completed" | "backgrounded" | "manual_review">;
}
interface ProviderRouteHint {
    model?: string;
    provider?: string;
    alias?: string;
    /**
     * When true, the model resolved from this hint bypasses health-aware
     * rerouting and is attempted even while in backoff. Defaults to false:
     * route hints behave as preferences, and an unhealthy hinted model still
     * yields a reroute to a healthy alternative. Set this only when the
     * caller has business-critical reasons to pin the exact model
     * (e.g. policy-mandated routing for a specific zone).
     */
    force?: boolean;
}
interface TaskNotificationPreference {
    completion?: boolean;
    channels?: NotificationTransport[];
    /** Optional session correlation: notifications fan out only to subscribers of this session. */
    sessionId?: string;
}
interface WebhookConfig {
    url: string;
    headers?: Record<string, string>;
    secret?: string;
}
interface CalendarGoogleConfig {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
}
interface WhatsAppConfig {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    pollIntervalMs?: number;
}
interface TelegramConfig {
    botToken: string;
    allowedChatIds?: number[];
    pollIntervalMs?: number;
    /** Enable two-way chat gateway — routes inbound messages to the agent loop and streams responses back. */
    enableGateway?: boolean;
}
interface SlackConfig {
    botToken: string;
    appToken: string;
    signingSecret: string;
}
interface NotionConfig {
    apiKey: string;
}
interface GmailConfig {
    credentialsPath: string;
    tokenPath: string;
}
interface DiscordConfig {
    botToken: string;
}
interface GitHubConfig {
    token: string;
}
interface SpotifyConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
}
interface ObsidianConfig {
    vaultPath: string;
}
/** Optional `trading` block in `zaraa.config.json` (CEX + Solana DEX). */
interface TradingConfig {
    /**
     * Starts recurring scanners, monitors, market fetches, and scheduled paper-trading work.
     * Manual trading tools remain available when false. Defaults to true for existing installs.
     */
    backgroundAutomation?: boolean;
    paperMode?: boolean | string;
    autoExecuteLive?: boolean | string;
    /**
     * Required when paperMode is false (live trading). Must equal
     * "I-CONFIRM-LIVE-TRADING-YYYY-MM-DD" using today's UTC date.
     * Acts as a daily-rotating explicit confirmation that real money is at risk.
     * Any live trade attempted without a matching lock is rejected before execution.
     */
    liveModeLock?: string;
    /** When true, run signals through full pre-trade pipeline but never submit real orders. */
    shadowMode?: boolean | string;
    apiKey?: string;
    apiSecret?: string;
    /** Solana JSON-RPC URL for Jupiter live swaps (overrides `SOLANA_RPC_URL`). */
    solanaRpcUrl?: string;
    /**
     * Base58-encoded secret key for live Solana DEX swaps.
     * Prefer `SOLANA_DEX_SECRET_KEY` in production instead of storing in config.
     */
    solanaDexSecretKey?: string;
    /** Per-venue fee schedule for realistic paper P&L. */
    feeSchedule?: Array<{
        venue: string;
        makerRate: number;
        takerRate: number;
    }>;
    /** Simulated slippage in basis points for paper trades (default: 5). */
    paperSlippageBps?: number;
    /** Webhook URL to POST critical trading alerts (stop hit, circuit break, flash crash). */
    alertWebhookUrl?: string;
    /**
     * Minimum interval (ms) between equity snapshots written to the circuit
     * breaker history. Throttles StopScheduler-driven tick bursts; trade
     * entries/exits bypass the throttle. Default: 5 * 60_000 (5 minutes).
     */
    equitySnapshotMinIntervalMs?: number;
    /** Hard cap on USD notional per shadow trade. Defaults to 25. */
    shadowMaxTradeUsd?: number;
    /**
     * Per-session entry gates. Each session ("asian"/"european"/"us"/"off_hours")
     * can override `minConfidence` so unfavorable sessions require a higher
     * bar, or set `enabled: false` to block entries during that window.
     * Audit (May 2026): European session ran 40% WR / -$0.27 P&L → defaults
     * raise the European min confidence to 0.7. Other sessions inherit the
     * engine-wide minConfidence.
     */
    sessionGates?: Partial<Record<"asian" | "european" | "us" | "off_hours", {
        minConfidence?: number;
        enabled?: boolean;
    }>>;
    /**
     * Per-symbol rolling-performance gate. Symbols whose last `rollingWindow`
     * trades have a win rate below `minWinRate` require unanimous ensemble
     * + confirmed edge to enter. Symbols with fewer than `minTrades` closed
     * positions are not gated.
     */
    symbolGate?: {
        enabled?: boolean;
        rollingWindow?: number;
        minWinRate?: number;
        minTrades?: number;
    };
    /**
     * Correlation guard — limits stacked exposure across correlated symbols.
     * `staticCorrelations` falls back when live price history is below
     * `minDataPoints`; the tracker normalises identifiers to the base asset.
     */
    correlationGuard?: {
        enabled?: boolean;
        correlationThreshold?: number;
        correlationScaleThreshold?: number;
        maxCorrelatedExposureMultiplier?: number;
        minDataPoints?: number;
        staticCorrelations?: Array<[string, string, number]>;
    };
    /**
     * Regime-detector thresholds. ADX above `adxTrendMin` is treated as a
     * trend; ADX below `adxRangeMax` as a range. `patternConfidenceMin` is
     * the floor below which learned patterns are dropped from regime
     * weighting.
     */
    regimeThresholds?: {
        adxTrendMin?: number;
        adxRangeMax?: number;
        patternConfidenceMin?: number;
    };
    /**
     * Names of registered strategies that should be skipped at activation
     * time. Strategies stay registered (so `trade_list_strategies` still
     * surfaces them) but `StrategyRegistry.activate()` becomes a no-op and
     * `getActive()` will not return them, so the signal engine, ensemble,
     * and shadow executor never see entries from these names. Empty/omitted
     * means all strategies are eligible — backward-compatible.
     *
     * To re-enable a strategy, remove it from this list and restart the
     * daemon (activations are wired during trading-subsystem init).
     */
    disabledStrategies?: string[];
}
/** Optional `predictions` block in `zaraa.config.json` (prediction-market venues). */
interface PredictionsConfig {
    paperMode?: boolean | string;
    autoExecuteLive?: boolean | string;
    polymarket?: PolymarketPredictionConfig;
    /** Read-only smart-money consensus watcher (records shadow signals; no execution). */
    smartMoney?: PredictionSmartMoneyConfig;
}
/** Settings for the read-only smart-money consensus watcher (default off; inert until enabled). */
interface PredictionSmartMoneyConfig {
    /** Master switch. Default false. */
    enabled?: boolean;
    /** Min distinct wallets buying the same outcome to flag a consensus. Default 4. */
    minWallets?: number;
    /** Only count fills >= this USD notional. Default 250. */
    minFillUsd?: number;
    /** Firehose pages to scan (500 trades each). Default 4. */
    pages?: number;
    /** Poll interval in ms. Default 900000 (15 min). */
    pollIntervalMs?: number;
    /** Drop live sports props (high adverse selection). Default true. */
    excludeSports?: boolean;
    /** Max % of an outcome's USD from one wallet before it's flagged non-independent (wash/Sybil guard). Default 60. */
    maxTopWalletPct?: number;
    /** data-api base URL override. */
    dataApiBaseUrl?: string;
}
/** Polymarket venue settings used by the prediction-market plugin. */
interface PolymarketPredictionConfig {
    /** Gamma API base URL. */
    gammaBaseUrl?: string;
    /** CLOB API base URL. */
    clobBaseUrl?: string;
    /** Maximum markets to fetch per request. */
    pageSize?: number;
    /** Maximum total markets to fetch. */
    maxMarkets?: number;
    /** Whether to fetch orderbook data by default. */
    fetchOrderBooks?: boolean;
    /** Maximum concurrent orderbook fetches. */
    maxConcurrentBookFetches?: number;
    /** Request timeout in ms. */
    timeoutMs?: number;
    /** Cached CLOB API key for authenticated writes. */
    apiKey?: string;
    /** Cached CLOB API secret for authenticated writes. */
    apiSecret?: string;
    /** Cached CLOB API passphrase for authenticated writes. */
    apiPassphrase?: string;
    /** Private key used for L1 auth and EIP-712 order signing. */
    privateKey?: string;
    /** Signature type for the trading wallet (0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE). */
    signatureType?: 0 | 1 | 2;
    /** Polygon mainnet or Amoy testnet. */
    chainId?: 137 | 80002;
    /** Funder address override required for proxy/safe signatures. */
    funder?: string;
    /** Whether to sync timestamps against the Polymarket server for authenticated writes. */
    useServerTime?: boolean;
    /** Hard maximum shares for one manual live prediction order. */
    maxLiveOrderSize?: number;
    /** Hard maximum USD notional for one manual live prediction order. */
    maxLiveOrderNotionalUsd?: number;
}
interface TimersConfig {
    /** Tool execution timeout in ms for normal tools (default: 30000) */
    toolTimeoutMs?: number;
    /** Tool execution timeout in ms for forge/long-running tools (default: 120000) */
    forgeToolTimeoutMs?: number;
    /** Equity snapshot interval in ms (default: 3600000 — 1 hour) */
    equitySnapshotIntervalMs?: number;
    /** Calendar context refresh interval in ms (default: 300000 — 5 minutes) */
    calendarRefreshIntervalMs?: number;
    /** Ollama health check interval in ms (default: 30000) */
    ollamaHealthCheckIntervalMs?: number;
    /** Memory maintenance interval in ms (default: 3600000 — 1 hour) */
    maintenanceIntervalMs?: number;
}
/**
 * Tunables for the proactive AlertManager (rate limit, quiet hours, dedup).
 * Persisted state — delivery timestamps, last-fired-by-type — lives in
 * `~/.zaraa/data/alerts.db` so rate limits survive daemon restarts.
 *
 * Day-cap rollover is calendar-day in `timeZone`, not a 24h sliding window:
 * the daily counter resets at local midnight in `timeZone`.
 */
interface AlertManagerConfigBlock {
    /** Master switch. When false, AlertManager is not constructed and no alerts fire. */
    enabled?: boolean;
    /** Max delivered alerts in a rolling 60-minute window. */
    maxPerHour?: number;
    /** Max delivered alerts in the current calendar day (in `timeZone`). */
    maxPerDay?: number;
    /** Quiet-hours start hour (0-23). Same value as `quietHoursEnd` disables quiet hours. */
    quietHoursStart?: number;
    /** Quiet-hours end hour (0-23). */
    quietHoursEnd?: number;
    /** IANA time zone used for quiet hours and day-cap rollover. */
    timeZone?: string;
    /** Per-type dedup window — same alert type within this window is dropped. CRITICAL bypasses. */
    dedupWindowMs?: number;
    /** Max in-memory alert records returned by `/api/alerts`. */
    historySize?: number;
    /** When true (default), LOW-severity alerts are dropped silently. */
    skipLowSeverity?: boolean;
}
interface MonitoringConfig {
    /** Proactive iMessage alert delivery (rate-limited, quiet-hours-aware). */
    alerts?: AlertManagerConfigBlock;
}
interface ZaraacoderExecutorConfig {
    /** Enables model-backed Zaraacoder full-run execution. Default false. */
    enabled?: boolean;
    /** Routing role such as "coding" or a concrete registered model key/alias. Default "coding". */
    model?: string;
    /** Maximum total edits plus verification commands a planner may return. Default 20. */
    maxToolCalls?: number;
    /** Allow executor plans that request network access. Default false. */
    allowNetwork?: boolean;
    /** Allow executor plans that request package installation. Default false. */
    allowPackageInstall?: boolean;
    /** Preferred CLI backend tier ordering. Default "codex" (unchanged until Zero burn-in passes). */
    backend?: "codex" | "zero" | "configured";
    /**
     * Gate the Zero CLI tier to greenfield (new-file) tasks only. Burn-in
     * (2026-07-06-zero-burnin-report.md) showed local models pass single-file
     * greenfield 8/9 but existing-file tasks 0/10, so the tier reroutes tasks
     * referencing existing files before spending a run. Defaults to TRUE in the
     * consuming code; set false to let Zero attempt existing-file work.
     */
    greenfieldOnly?: boolean;
    /** Disarmed-by-default Zero subscription budget (spec 2026-07-06-zero-integration-design.md). */
    subscriptionBudget?: ZaraacoderSubscriptionBudgetConfig;
    /**
     * Per-lane model overrides for explicit agent-lane sessions. Defaults in the
     * consuming code: grok "grok-4.5", local "gemma4-e4b-qat-zaraa",
     * claude "claude-sonnet-4-6", codex "gpt-5.6-sol".
     */
    laneModels?: {
        grok?: string;
        local?: string;
        claude?: string;
        codex?: string;
    };
}
/**
 * Daily budget for subscription-backed Zero CLI runs. Ships disarmed
 * (`enabled: false`); arming is a config-only flip. When the task cap is
 * exhausted for the UTC day, zaraacoder reroutes to the fallback backend.
 */
interface ZaraacoderSubscriptionBudgetConfig {
    /** Master switch. Default false. */
    enabled?: boolean;
    /** Max Zero CLI runs per UTC day. Null/omitted = no cap. */
    maxTasksPerDay?: number | null;
    /** USD/day cap; recorded now, enforced via the daily `zero usage` scrape. */
    maxUsdPerDay?: number | null;
}
/** Global model availability toggles — applies platform-wide unless zaraacoder overrides. */
interface ModelControlsConfig {
    /** Provider name → enabled (default true when omitted). */
    providers?: Record<string, boolean>;
    /** Model key → enabled (default true when omitted). */
    models?: Record<string, boolean>;
}
/** Tool-suggestion hints injected into agent turns (flag-gated). */
interface ToolSuggestionConfig {
    /** Master switch. Default false. */
    enabled?: boolean;
    /** Max suggested tools per turn. Default 3. */
    maxSuggestions?: number;
}
/** Continuation nudge for local models that narrate a mutating action
 *  ("I am now executing the write...") without firing the tool call.
 *  Gated off by default; only consulted on local-model turns. */
interface LocalContinuationNudgeConfig {
    /** Master switch. Default false. */
    enabled?: boolean;
    /** Max nudge injections per turn. Default 1. */
    maxNudges?: number;
}
/** Model-routing experiments. All knobs gated off by default. */
interface RoutingConfig {
    /**
     * Sampled LLM-graded quality reward for the bandit router. When `sample` > 0,
     * that fraction of recorded interaction traces are re-scored by an async judge
     * that rates response CORRECTNESS (0-1), blended 50/50 into the trace score the
     * bandit consumes — so the bandit can stop preferring a fast WRONG model.
     * Off the hot path (detached + sampled). Default `sample` 0 (disabled): the
     * heuristic composite score is left unchanged.
     */
    gradedReward?: {
        /** Fraction of successful interaction traces to grade, 0-1. Default 0 (off). */
        sample?: number;
        /** Optional judge model override. Defaults to the lightweight local classifier model. */
        model?: string;
    };
    /**
     * Apply a first-chunk SLA to the NON-stream failover path (the stream path
     * already has one). When true, a slow/stalling arm that falls to the
     * non-stream path fails over at the first-chunk SLA instead of hanging to the
     * full response timeout — but only when a fallback candidate exists, so the
     * last arm is never prematurely failed over. Default OFF (undefined): the
     * non-stream path keeps the full response timeout. Held spec Item A
     * (docs/runbooks/zaraa-failover-latency-followup-spec-20260607.md); flip on
     * only if `:free` non-stream stalls are observed in production.
     */
    nonStreamFirstChunkSla?: boolean;
}
/** Zaraacoder-scoped model pool with optional overrides of global toggles. */
interface ZaraacoderModelPoolConfig {
    /** When true (default), inherit global enabled set then apply zaraacoder overrides. */
    inheritGlobal?: boolean;
    providers?: Record<string, boolean>;
    models?: Record<string, boolean>;
    /** Optional pin — overrides executor.model for next session(s). */
    primaryModel?: string;
}
interface ZaraacoderConfigBlock {
    executor?: ZaraacoderExecutorConfig;
    modelPool?: ZaraacoderModelPoolConfig;
}
interface CursorAgentTimeoutConfig {
    /** Timeout to spawn cursor-agent and receive initial process activity. */
    spawnMs?: number;
    /** Timeout for stream inactivity after cursor-agent starts producing output. */
    streamMs?: number;
    /** Total wall-clock timeout for one cursor-agent request. */
    overallMs?: number;
}
/**
 * Optional `gui` block — controls the GUI agent plugin (Phase 3).
 *
 * Defaults to disabled. The plugin is only registered with the
 * tool registry when `enabled === true`. When omitted, no GUI tools
 * are exposed to the agent loop.
 */
/**
 * In-process safety layer (Phase 4). Every gui_* tool call is gated by
 * allowlist + rate limits + sensitive-app guard + kill-switch in addition
 * to the policy engine. These knobs tune the layer; defaults are
 * conservative.
 */
interface GuiSafetyConfig {
    /** Max input actions (click/key/type/drag/scroll) per minute. Default: 60. */
    actionsPerMinute?: number;
    /** Max screenshots per minute. Default: 10. */
    screenshotsPerMinute?: number;
    /** Additional bundle ids to refuse capture/input against. Merged with the built-in deny-list. */
    sensitiveApps?: string[];
    /** Reserved for future per-zone provider gating. */
    remoteProvidersAllowedInZone?: ("trusted" | "guarded" | "sandbox")[];
}
interface GuiConfig {
    /** When true, register the GUI plugin and its tools. Default: false. */
    enabled?: boolean;
    /** Override path to the zaraa-gui-helper binary. Default: ~/.zaraa/bin/zaraa-gui-helper. */
    helperBinPath?: string;
    /** Vision-language-model provider settings used to interpret screenshots. */
    vlm?: {
        /** Currently only the local Ollama provider is supported. */
        provider?: "ollama";
        /** Model identifier (e.g. "qwen2.5vl:7b"). */
        model?: string;
        /** Provider host URL (e.g. "http://127.0.0.1:11434"). */
        host?: string;
    };
    /** Phase-4 in-process safety layer settings. */
    safety?: GuiSafetyConfig;
}
/** Machine-wide Continuation Ack Rule (chronology slice injection). Default on. */
interface ContinuityConfig {
    /** When false, skip chronology injection. Default true. */
    enabled?: boolean;
}
/** Video-watching plugin (@zaraa/plugin-video). Default-off until enabled. */
interface VideoPluginConfig {
    /** When true, register the video plugin and `watch_video`. Default: false. */
    enabled?: boolean;
    vlm?: {
        /** Ollama host. Default http://127.0.0.1:11434. */
        host?: string;
        /** Vision model. Default "qwen2.5vl:7b". */
        model?: string;
        /** Optional second-pass model for hard frames, e.g. "gemma4-12b-qat-zaraa:latest". */
        escalateModel?: string;
        /** Ollama keep_alive. Default "10m". */
        keepAlive?: string;
        /** Per-batch vision request timeout ms. Default 45000. */
        timeoutMs?: number;
    };
    stt?: {
        /** Local STT base URL. Default http://127.0.0.1:8765. */
        baseUrl?: string;
        /** STT request timeout ms. Default 120000. */
        timeout?: number;
    };
    /** Max frames captioned per video. Default 24. */
    frameBudget?: number;
    /** Frame width px. Default 512 (use 1024 for on-screen-text-heavy video). */
    resolution?: number;
    /** Frames per vision call. Default 6. */
    batchSize?: number;
    /** Temp working dir. Default OS tmp. */
    workDir?: string;
    /** yt-dlp binary. Default "yt-dlp". */
    ytDlpPath?: string;
    /** ffmpeg binary. Default "ffmpeg". */
    ffmpegPath?: string;
}
/** Ableton Live OSC plugin (@zaraa/plugin-ableton). Default-off until enabled. */
interface AbletonPluginConfig {
    /** When true, register AbletonOSC tools. Default: false. */
    enabled?: boolean;
    /** AbletonOSC host. Default 127.0.0.1. */
    host?: string;
    /** AbletonOSC listen port for incoming commands. Default 11000. */
    sendPort?: number;
    /** Local reply port used by Zaraa to receive AbletonOSC replies. Default 11001. */
    receivePort?: number;
    /** Per-request OSC read-back timeout in ms. Default 1500. */
    timeoutMs?: number;
}
/**
 * Computer-control master block (Zero Phase 3, spec 2026-07-06).
 *
 * Registration-gated: when `enabled !== true` (the default), no
 * computer-control tools are registered anywhere — not present in tool
 * lists, not callable, zero surface. The desktop backend is additionally
 * gated by its own toggle and an explicit app allowlist (empty allowlist =
 * nothing controllable even when enabled). Credential, payment, and
 * system-settings surfaces are hard-blocked regardless of toggle state.
 */
interface ComputerControlSessionCap {
    /** Max gated actions per session window. Default: 50. */
    maxActions?: number;
    /** Session window length in minutes; the window resets after this. Default: 15. */
    maxMinutes?: number;
}
interface ComputerControlDesktopBackendConfig {
    /** When true (and the master toggle is on), desktop-control tools register. Default: false. */
    enabled?: boolean;
    /** Backend implementation. Only "accessibility" (macOS Accessibility/AppleScript) is supported. */
    backend?: "accessibility";
    /**
     * Application names controllable via desktop tools (e.g. "Logic Pro",
     * "Ableton Live"). Empty (default) = nothing controllable.
     */
    allowedApps?: string[];
}
interface ComputerControlConfig {
    /** Master toggle. When not true (default), zero computer-control surface is registered. */
    enabled?: boolean;
    backends?: {
        /** Browser backend (Claude-in-Chrome MCP). Default: enabled (still master-gated). */
        browser?: {
            enabled?: boolean;
        };
        /** Desktop backend (macOS Accessibility/AppleScript). Default: disabled. */
        desktop?: ComputerControlDesktopBackendConfig;
    };
    /** Minimum zone required to invoke computer-control tools. Default: "guarded" (strictest existing). */
    minZone?: Zone;
    /** Force per-action approval through the policy engine. Default: true. */
    requiresApproval?: boolean;
    /** Per-session action/time caps. */
    sessionCap?: ComputerControlSessionCap;
    /** JSONL audit log path. Default: "~/.zaraa/logs/computer-control.jsonl". */
    auditLog?: string;
}
/** Runtime disposition/behavior tuning for the agent's cloud system prompt. */
interface BehaviorConfig {
    /**
     * Disposition governor (Fable-mode): when not explicitly false, the cloud system prompt
     * gains a settled, committed "Disposition" section (terser, result-first, bounded
     * self-audit). Default: enabled. Does not affect the local/compact prompt.
     */
    dispositionGovernor?: boolean;
}
interface ZaraaConfig {
    defaultZone: Zone;
    zones: {
        guarded: ZoneCapabilities;
        trusted: TrustedZoneConfig;
    };
    providers: ProviderConfig[];
    models: ModelRoutingConfig;
    privacy: PrivacyConfig;
    scheduler: SchedulerConfig;
    performance: "minimal" | "balanced" | "performance" | "unleashed" | "auto";
    voice?: VoiceConfig;
    calendar?: {
        enabled?: boolean;
        google?: CalendarGoogleConfig;
    };
    messaging?: {
        imessage?: {
            /**
             * Reply style for iMessage (and road). Default "road": short, act-first.
             * "detailed" = longer friend-text essays.
             */
            roadStyle?: "road" | "detailed";
            enabled: boolean;
            autoRespond?: boolean;
            contact?: string;
            pollIntervalMs?: number;
            /**
             * How to send iMessages:
             * - "auto" (default): try AppleScript first, fall back to Shortcuts CLI
             * - "applescript": AppleScript only (requires Automation permission)
             * - "shortcuts": Shortcuts CLI only (requires "Zaraa Send iMessage" shortcut)
             */
            sendMethod?: "auto" | "applescript" | "shortcuts";
            /**
             * Bounded background retry of failed outbound sends. Optional; when
             * omitted the sender defaults to enabled (daily-use reliability) with
             * conservative bounds. The queue is bounded and self-limiting — it can
             * never grow without bound or retry forever.
             */
            retry?: {
                /** Enable background retry of failed sends. Default: true. */
                enabled?: boolean;
                /** Max messages held pending retry; oldest dropped when full. Default: 50. */
                maxQueueSize?: number;
                /** Max retry attempts before giving up and dropping with a log. Default: 3. */
                maxRetries?: number;
                /** Base backoff in ms; delay = baseBackoffMs * 2^(attempt-1), capped. Default: 5000. */
                baseBackoffMs?: number;
                /** Upper bound on a single backoff delay in ms. Default: 60000. */
                maxBackoffMs?: number;
            };
        };
        whatsapp?: WhatsAppConfig;
        telegram?: TelegramConfig;
        slack?: SlackConfig;
        discord?: DiscordConfig;
    };
    integrations?: {
        notion?: NotionConfig;
        gmail?: GmailConfig;
        github?: GitHubConfig;
        spotify?: SpotifyConfig;
        obsidian?: ObsidianConfig;
    };
    embedding?: EmbeddingConfig;
    vision?: VisionConfig;
    /** Computer control (Zero Phase 3) — opt-in, default OFF, registration-gated. */
    computerControl?: ComputerControlConfig;
    memory?: {
        maxContextTokens?: number;
    };
    gateway?: {
        auth?: GatewayAuthConfig;
        /**
         * When not `false`, Zaraa auto-approves policy-queued tool actions and runs the AutonomyLoop.
         * Set to `false` to require manual approvals and pause autonomous cycles (until set true again).
         */
        trusted?: boolean;
        /**
         * Public URL at which the gateway is reachable from the open internet
         * (e.g. "https://zaraa.example.com"). Set by `setup-remote-access.sh`
         * when provisioning a named Cloudflare tunnel. Consumed by the
         * extended health endpoint, the iOS app's default connection, and the
         * Twilio voice callback when `voice.twilio.publicUrl` is absent.
         */
        publicUrl?: string;
        /** Optional HMAC secret used to verify inbound webhook dispatch payloads. */
        webhooks?: {
            dispatchSecret?: string;
            replayStorePath?: string;
        };
    };
    /** Security-monitor tunables (anomaly detection / attack-chain heuristics). */
    security?: {
        /**
         * Domains the AttackChainDetector treats as expected research targets
         * for web_search/web_fetch bursts. Overrides its built-in default
         * allowlist when set.
         */
        researchDomainAllowlist?: string[];
        /**
         * Absolute directories where bulk file activity is expected (e.g. a
         * pack runner's artifact work root). File actions under a declared
         * root skip the per-target novelty anomaly signals (unusual_target,
         * type_shift); volume_spike telemetry and sensitive_access detection
         * stay fully active. Opt-in — empty/absent means behavior unchanged.
         * Roots that are relative, shallower than 3 path segments, or match
         * credential patterns are ignored by the detector.
         */
        declaredWorkRoots?: string[];
    };
    notifications?: {
        webhook?: WebhookConfig;
        quietHours?: {
            start: string;
            end: string;
        };
        minPriority?: "low" | "normal" | "high" | "urgent";
        /**
         * External dead-man's-switch URL (e.g. healthchecks.io check URL).
         * Daemon POSTs to this every ~60s while alive; if pings stop, the
         * service emails/texts the operator. Complements the local launchd
         * auto-restart so you're alerted when the daemon is *not* coming
         * back up on its own.
         */
        healthchecksUrl?: string;
        /** How often to ping the heartbeat URL, in ms. Default 60_000. */
        healthchecksIntervalMs?: number;
        /**
         * ntfy.sh (or self-hosted ntfy) topic URL for proactive push. Free
         * alternative to APNs — install ntfy on your phone, subscribe to
         * the topic, and Zaraa pushes alerts (approvals, trade alerts,
         * task failures) through this channel.
         */
        ntfyTopicUrl?: string;
        /** Optional Bearer token for private/self-hosted ntfy servers. */
        ntfyAccessToken?: string;
        completion?: CompletionNotificationConfig;
    };
    persona?: {
        name?: string;
        preferences?: string[];
    };
    plugins?: {
        dir?: string;
        enabled?: string[];
    };
    personality?: "adaptive" | "warm" | "minimal" | "casual";
    proactivity?: ProactivityConfig;
    autonomy?: AutonomyConfig;
    /** Configurable intervals and timeouts for background timers */
    timers?: TimersConfig;
    /** Monitoring & proactive alert delivery (rate limits, quiet hours). */
    monitoring?: MonitoringConfig;
    /** Crypto.com CEX + optional Solana Jupiter settings */
    trading?: TradingConfig;
    /** Creative studio plugin (@zaraa/plugin-studio). Default-off until enabled. */
    studio?: Partial<StudioConfig>;
    /** Runtime disposition/behavior tuning for the agent's cloud system prompt. */
    behavior?: BehaviorConfig;
    /** GUI agent plugin (screenshots, click/type/scroll, VLM). Defaults to disabled. */
    gui?: GuiConfig;
    /** Video-watching plugin (@zaraa/plugin-video). Defaults to disabled. */
    video?: VideoPluginConfig;
    /** Ableton Live OSC plugin (@zaraa/plugin-ableton). Defaults to disabled. */
    ableton?: AbletonPluginConfig;
    /** Prediction-market venue settings */
    predictions?: PredictionsConfig;
    /** Claude CLI tool settings */
    claudeCli?: {
        /** Require user approval before claude_ask runs (default: false) */
        approveAsk?: boolean;
        /** Require user approval before claude_code runs (default: true) */
        approveCode?: boolean;
    };
    /** CLI-Anything integration — control GUI apps (GIMP, Blender, etc.) via generated CLI harnesses */
    cliAnything?: CliAnythingConfig;
    /** Experimental features (behind feature flags) */
    experimental?: {
        /** Enable sub-agent coordination for complex tasks (default: true). */
        subAgents?: boolean;
        /** Enable automatic zodiac specialist orchestration for complex parent tasks (default: true). */
        zodiacOrchestration?: boolean;
        /** Enable distinct-model fan-out for sub-agent coordination (default: false).
         *  When true (and subAgents is enabled), parallel sub-agents are assigned distinct
         *  provider families so synthesis becomes a cross-model council instead of a same-model merge. */
        subAgentCouncil?: boolean;
        /** Global provider speed tier. Controls per-family concurrency budgets AND paid-provider
         *  eligibility. Unset = current behavior (no change). "slow" disables paid families
         *  (subscription/metered are never routed); "medium"/"fast" enable paid families with
         *  progressively larger free/paid concurrency budgets. An explicit `providerConcurrency`
         *  entry overrides the tier-derived budget per family. */
        providerTier?: "slow" | "medium" | "fast";
        /** Max concurrent turns per provider family. 0 disables the cap for that family. */
        providerConcurrency?: Partial<Record<BillingMode, number>>;
        /** Route oversized tool results through an FTS5 scratch index instead of truncating.
         *  When enabled, tool results over thresholdBytes are stored under a run_id and replaced
         *  inline with preview + auto-retrieved chunks; the model can call ctx_search(run_id, query)
         *  to refine. Default: disabled (opt-in for Phase 1 of the context-mode port). */
        scratchIndex?: {
            enabled?: boolean;
            thresholdBytes?: number;
            topK?: number;
            maxTotalBytes?: number;
        };
        /** Enable native Anthropic prompt caching on the canonical Anthropic provider
         *  (default: true). Caches the tools+system prefix and the rolling conversation so
         *  multi-iteration tasks re-read the prefix at ~0.1× cost. Lossless; set false to disable. */
        anthropicPromptCaching?: boolean;
    };
    /**
     * Continuation Ack Rule — inject `~/.continuity/CONTINUATION_CHRONOLOGY.md`
     * into system context on session start, every 3rd assistant turn, or when
     * the previous assistant message is more than 15 minutes stale. Default on.
     */
    continuity?: ContinuityConfig;
    /** Context paging — save overflow conversation history to disk for later recall */
    contextPaging?: {
        /** Enable context paging (default: false) */
        enabled?: boolean;
        /** Max pages per session before oldest is evicted (default: 20) */
        maxPagesPerSession?: number;
        /** Max total disk usage in MB across all sessions (default: 50) */
        maxTotalSizeMB?: number;
        /** Delete pages older than this many milliseconds (default: 86400000 = 24h) */
        cleanupAfterMs?: number;
    };
    /** Per-service rate limit overrides for the budget dashboard */
    serviceLimits?: Record<string, {
        tokensPerDay?: number;
        requestsPerMinute?: number;
        requestsPerDay?: number;
        requestsPerMonth?: number;
        minutesPerDay?: number;
    }>;
    /** Upgrade profile — principles, hierarchy, risk tiers, response envelope, bootstrap charter files. */
    profile?: ZaraaProfileConfig;
    /** Global LLM provider/model enable toggles for runtime routing. */
    modelControls?: ModelControlsConfig;
    /** Tool-suggestion hints for agent turns. Gated off by default. */
    toolSuggestion?: ToolSuggestionConfig;
    /** Local-model continuation nudge. Gated off by default. */
    localContinuationNudge?: LocalContinuationNudgeConfig;
    /** Model-routing experiments (graded reward, …). Gated off by default. */
    routing?: RoutingConfig;
    /** Zaraacoder task-to-worktree coding operator settings. */
    zaraacoder?: ZaraacoderConfigBlock;
    /**
     * Self-edit guard + (future) workflow config. When `repoRoot` is set, the
     * policy engine denies file.write/file.delete targeting that tree in every
     * zone — including trusted — unless routed through a future self-edit
     * workflow. When omitted, Zaraa falls back to `process.cwd()` at daemon
     * startup so the guard is always on.
     */
    selfEdit?: {
        repoRoot?: string;
        /**
         * Git ref used as the base for self-edit worktrees. Defaults to the
         * worktree manager default ("main") when omitted; operators can set "HEAD"
         * when local main is stale or unavailable.
         */
        baseBranch?: string;
        /** When true, the self-edit workflow is active. Default false. */
        enabled?: boolean;
        /**
         * When true, executors validate proposals but do not modify files/open PRs.
         * Used for Phase A (Shadow) rollout. Default false.
         */
        dryRun?: boolean;
        /**
         * Per-tier daily proposal budgets. Excess proposals queue to next day.
         * Defaults: tier1=10, tier2=3, tier3=2.
         */
        tierBudgets?: {
            tier1?: number;
            tier2?: number;
            tier3?: number;
        };
        /**
         * Tier-1 rollback window before snapshot ages out. Default 24h.
         */
        rollbackWindowHours?: number;
        /**
         * Tier-2 auto-merge delay after PR opens. Default 4h.
         */
        autoMergeWindowHours?: number;
        /**
         * Master "autonomous landing" switch. When true, Zaraa lands self-edits
         * WITHOUT operator approval: Tier-1 proposals write the live checkout
         * directly, and Tier-2 PRs auto-merge after the window + canary.
         * Default false = "PR-for-approval": Tier-1 only validates (no write),
         * Tier-2 opens PRs that the operator merges on GitHub, and the
         * ApprovalResolver reconciles the merge/close back into the outcome loop.
         * Fail-safe: only an explicit `true` enables any autonomous landing.
         */
        autoMerge?: boolean;
        /**
         * Canary watch windows post-merge, in hours. Defaults: tier2=48, tier3=72.
         */
        canaryWindowHours?: {
            tier2?: number;
            tier3?: number;
        };
        /**
         * Hard-kill: pause executor when this many rollbacks happen in 24h. Default 3.
         */
        hardKillRollbackThreshold?: number;
        /**
         * Cap on self-edit tasks the autonomy loop will enqueue per rolling 24h.
         * Independent of tierBudgets which apply at the executor layer. Default 2.
         */
        maxAutoDispatchPerDay?: number;
        /**
         * ProposalOutcomeJudge — schedules 6h+24h checkpoints on merged self-edit
         * proposals and emits verdicts (helpful/neutral/harmful/uncertain) from
         * three signals: gap-closure recurrence, canary metric delta, LLM judge.
         * AutonomyLoop reads verdicts per gap-class fingerprint to reweight
         * dispatchSelfEditFromRecurringGaps. Inert when enabled=false.
         */
        outcomeJudge?: {
            /** Master gate. Default false. */
            enabled?: boolean;
            /** 6h checkpoint delay in ms. Default 21_600_000. */
            checkpoint6hMs?: number;
            /** 24h checkpoint delay in ms. Default 86_400_000. */
            checkpoint24hMs?: number;
            /** Daily LLM-judge spend cap. Default 0.50. */
            dailyLlmBudgetUsd?: number;
            /** Lookback window for findRecentByGapClass weighting. Default 30. */
            weightDecayDays?: number;
        };
    };
    /**
     * Model Context Protocol (MCP) client/host runtime. When enabled, Zaraa
     * connects to the configured external MCP servers, discovers their tools,
     * and registers them in the tool registry. Every MCP tool call routes
     * through the policy engine as a `"mcp.call"` action (network/external
     * boundary — blocked in sandbox, approval/allow in guarded, allowed in
     * trusted). Inert when omitted or `enabled !== true`.
     */
    mcp?: MCPConfig;
}
/** Transport used to reach an MCP server. */
type MCPTransport = "stdio" | "http" | "sse";
/**
 * Configuration for a single external MCP server. A `stdio` server is spawned
 * as a child process (`command` + `args`); an `http`/`sse` server is reached
 * over `url`. Discovered tools are exposed as `mcp_${name}_${tool}` and gated
 * at `minZone` (default "guarded"), requiring approval by default for external
 * servers.
 */
interface MCPServerConfig {
    /** Stable, unique server identifier. Used as the `mcp_${name}_*` tool prefix. */
    name: string;
    /** Transport mechanism. */
    transport: MCPTransport;
    /** Executable to spawn for `stdio` transport (e.g. "npx", "node"). */
    command?: string;
    /** Arguments passed to `command` for `stdio` transport. */
    args?: string[];
    /** Extra environment variables for the spawned `stdio` child. */
    env?: Record<string, string>;
    /** Endpoint URL for `http`/`sse` transport. */
    url?: string;
    /** Extra HTTP headers (e.g. auth) for `http`/`sse` transport. */
    headers?: Record<string, string>;
    /** Minimum trust zone required to use this server's tools. Default "guarded". */
    minZone?: Zone;
    /** Whether tool calls require human approval. Default true (external). */
    requiresApproval?: boolean;
    /** When false, this server is skipped at startup. Default true. */
    enabled?: boolean;
}
/** MCP runtime config block. */
interface MCPConfig {
    /** Master gate. When not `true`, the MCP runtime does not start. Default false. */
    enabled?: boolean;
    /** External MCP servers to connect to. */
    servers: MCPServerConfig[];
}
/** Risk tier derived from action reversibility; used by policy hard-stop gate. */
type RiskTier = "low" | "medium" | "high" | "irreversible";
/** Which turns should render the structured response envelope in the system prompt. */
type ResponseEnvelopeMode = "off" | "high-stakes" | "always";
/**
 * Formalization of the "Zaraa Opus 4.7 Compact Hybrid" upgrade profile:
 * principles, instruction hierarchy, auto-loaded bootstrap files, response
 * envelope policy, risk-tier overrides, and model-alignment metadata.
 * Optional — when absent, `DEFAULT_PROFILE` applies.
 */
interface ZaraaProfileConfig {
    name: string;
    version: string;
    /** ISO date the profile took effect (e.g. "2026-04-16"). */
    effectiveDate: string;
    /** Symbolic model-alignment identifier (e.g. "opus-4.7-via-escalation"). */
    modelAlignment: string;
    /** Charter files to auto-load from the project root when present. */
    bootstrapFiles: string[];
    /** When to inject the structured response envelope guidance. */
    responseEnvelope: {
        mode: ResponseEnvelopeMode;
    };
    /** Override the derived risk tier for specific action types. */
    riskTierOverrides?: Record<string, RiskTier>;
}
/** Built-in default profile — active when `ZaraaConfig.profile` is omitted. */
declare const DEFAULT_PROFILE: ZaraaProfileConfig;
interface CliAnythingConfig {
    /** Enable CLI-Anything integration (default: false) */
    enabled?: boolean;
    /** Only allow these software names (e.g. ["gimp", "blender"]). Empty = allow all discovered. */
    allowlist?: string[];
    /** Block these software names. Takes precedence over allowlist. */
    blocklist?: string[];
    /** Timeout per command in ms (default: 120000) */
    timeoutMs?: number;
    /** Max concurrent CLI-Anything commands (default: 3) */
    maxConcurrent?: number;
}
/**
 * How the provider authenticates.
 *
 * - "keychain" — look up `providers/{name}` in the OS keychain
 * - "env"      — read from an environment variable
 * - "config"   — use the plaintext `apiKey` in this config (least secure)
 * - "api-key"  — legacy-compatible alias for "config"
 * - "none"     — no auth needed (e.g. local Ollama)
 *
 * When omitted the resolver tries: keychain → env → config → error.
 */
type ProviderAuthType = "keychain" | "env" | "config" | "api-key" | "api_key" | "apiKey" | "none" | "oauth";
interface ProviderConfig {
    /** When false, provider is skipped at registration and routing. Default true. */
    enabled?: boolean;
    name: string;
    type: "anthropic" | "openai" | "ollama" | "openrouter" | "openai-compatible"
    /** xAI Grok — OpenAI-compatible API at api.x.ai/v1 (or via OpenRouter model ids). */
     | "xai" | "gemini" | "claude-cli" | "codex" | "cursor" | "cursor-agent" | "cursor-sdk" | "custom";
    apiKey?: string;
    baseUrl?: string;
    models: string[];
    auth?: ProviderAuthType;
    envVar?: string;
    /** Multiple API keys for rotation (takes precedence over apiKey) */
    keys?: string[];
    /** Stable provider aliases. Registered as `<alias>:<model>` keys for routing and task hints. */
    aliases?: string[];
    /** Stable aliases for individual models. */
    modelAliases?: Record<string, string[]>;
    /** Provider-specific: max agent turns (claude-cli, cursor-agent) */
    maxTurns?: number;
    /** Provider-specific: request timeout in ms */
    timeoutMs?: number;
    /** Provider-specific: cursor-agent timeout tiers (spawn / stream / overall). */
    cliTimeouts?: CursorAgentTimeoutConfig;
    /** Provider-specific: cap completion length for local providers */
    maxOutputTokens?: number;
    /** Provider-specific: Ollama keep_alive duration */
    keepAlive?: string;
    /** Provider-specific: permission mode (claude-cli) */
    permissionMode?: string;
    /** Provider-specific: force flag (cursor-agent) */
    force?: boolean;
    /** Provider-specific: trust flag (cursor-agent) */
    trust?: boolean;
    /** Provider-specific: workspace path (cursor-agent, cursor-sdk) */
    workspace?: string;
    /** Provider-specific: binary path override (cursor-agent) */
    binaryPath?: string;
    /** Provider-specific: opt into legacy Cursor REST auth via local Cursor storage. */
    allowLegacyLocalStorageAuth?: boolean;
    /** Provider-specific: fallback model name (ollama) */
    fallbackModel?: string;
    /** Provider-specific: prepend caveman preset to cut prompt tokens ~75% (ollama). */
    caveman?: boolean;
    /**
     * Default `reasoning_effort` sent with every request from this provider
     * (model-suffix aliases like gpt-5.5-low still take precedence). Set "none"
     * for thinking-mode local models (e.g. gemma-4 QAT) served via
     * OpenAI-compatible APIs — without it they burn the whole token budget in
     * the reasoning channel and return empty content.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
}
interface ModelRoutingConfig {
    sandbox?: string;
    guarded?: string;
    trusted?: string;
    default: string;
    /** Stable alias -> model key mappings. */
    aliases?: Record<string, string>;
    /** Local model for simple lookups, tool calls, quick answers */
    chat?: string;
    /** Lighter model for background autonomy tasks (reflection, memory review) */
    background?: string;
    /** Code-optimized model for Plugin Forge code generation */
    coding?: string;
    /** Powerful cloud model for complex reasoning, analysis, and writing */
    deep?: string;
    /** Maximum reasoning — beyond deep, for the hardest analytical tasks */
    deeper?: string;
    /** Most capable model for hardest reasoning, strategy, and synthesis */
    opus?: string;
    /** Free/cheap model for autonomous agent work (scheduled tasks, proactive ops) */
    agent?: string;
    /** Specialized debug model for deep investigation and root-cause analysis */
    superdebug?: string;
    /** Ultra-fast code model for quick edits, completions, and generation */
    fast?: string;
    /** Local model optimized for tool calling and structured output */
    toolcaller?: string;
    /** Code review model — review PRs, audit code, find bugs */
    codereview?: string;
    /** Self-reflection, operational audits, growth exercises, introspection */
    introspection?: string;
    /**
     * Ordered fallback chain for the "opus" pinned tier. If the primary `opus`
     * model is unavailable (Ollama down, circuit-breaker backoff) the bandit
     * router walks this list in order before falling back to generic candidates.
     * Example: ["openai/gpt-5.4", "anthropic/claude-opus-4-7"]
     */
    opusEscalationChain?: string[];
    /**
     * Ordered cross-tier fallback chain. When a pinned tier model is
     * unavailable (backoff, quota, stall) the routers walk this list first —
     * before free-model pools, task fallbacks, and generic candidates.
     * Entries that resolve to no registered provider are skipped.
     * Example: ["gpt-5.5-low", "gpt-5.5", "mlx-community/Qwen3.5-9B-4bit"]
     */
    fallbackChain?: string[];
}
interface PrivacyConfig {
    confidential: string[];
    neverSendPatterns: string[];
    onConfidentialAccess: "block" | "summarize-locally" | "ask";
    promptInspection: "off" | "log" | "approve";
    networkMode: "open" | "selective" | "local-only";
}
interface SchedulerConfig {
    tasks: ScheduledTask[];
    watchdogs: Watchdog[];
    overnight?: {
        /** Enable/disable the overnight autonomous protocol. */
        enabled?: boolean;
        /** Local hour when overnight work begins (0-23). */
        startHour?: number;
        /** Local hour when the overnight handoff should be ready (0-23). */
        endHour?: number;
    };
    memoryConsolidation?: {
        /** Enable/disable automated memory consolidation scheduling. Default: true. */
        enabled?: boolean;
        /** Local hour (0-23) when consolidation runs. Default: 2 (2am). */
        hour?: number;
        /** Maximum age in days for episodic entries before auto-pruning. Default: 30. */
        maxAgeDays?: number;
        /** Quiet hours window start (inclusive, 0-23). Default: 1. */
        quietStart?: number;
        /** Quiet hours window end (exclusive, 0-23). Default: 5. */
        quietEnd?: number;
    };
    limits: {
        maxTokensPerDay: number;
        maxTasksPerHour: number;
        maxCostPerDay: string;
        pauseOnBudgetExhaust: boolean;
        providerFamilyQuotas?: Partial<Record<BillingMode, ProviderFamilyQuotaConfig>>;
    };
}
interface ProviderFamilyQuotaConfig {
    maxTokensPerDay?: number;
    maxTokensPerWeek?: number;
    maxCostPerDay?: string;
    maxCostPerWeek?: string;
    enforcement?: "soft" | "hard";
}
interface ScheduledTask {
    id: string;
    schedule: string;
    zone: Zone;
    prompt: string;
    notify: "web" | "os" | "none";
    /** Disabled tasks stay visible in scheduler config but do not execute. Defaults to enabled. */
    enabled?: boolean;
    /** Specialized scheduler path. Omitted tasks use the standard tool/agent paths. */
    kind?: "command-cycle";
    commandCyclePhase?: "morning" | "midday" | "evening";
    /**
     * When true, the completed task result is synthesized with local TTS and
     * delivered as an iMessage audio attachment to the configured contact.
     */
    voiceNote?: boolean;
    silent?: boolean;
    /**
     * When true, the scheduled task still dispatches through the agent loop even if
     * the local Ollama health flag is false. Use for diagnostics (e.g. 4h health probe)
     * so a down Ollama does not prevent the check from running.
     */
    skipOllamaGate?: boolean;
    /** Execute a tool directly without the LLM agent loop. Eliminates LLM latency and timeouts for simple tool invocations. */
    tool?: string;
    /** JSON arguments passed to `tool` (e.g. `{ "log_path": "/var/log/daily_crypto_check.log" }` for `trade_daily_crypto_discipline`). */
    toolArgs?: Record<string, unknown>;
    /**
     * Per-task hang detector. If `onExecute` does not resolve within this many ms, the run is
     * counted as a failure and the scheduler reschedules — the original promise is detached
     * so a permanently-hung tool cannot freeze the scheduler entry (May 7 incident). Falls
     * back to `CronSchedulerConfig.taskTimeoutMs` (default 5 min) when omitted.
     */
    timeoutMs?: number;
}
interface Watchdog {
    id: string;
    watch: string;
    zone: Zone;
    condition: string;
    action: string;
}

type NodeCapability = "camera" | "photo_library" | "location" | "notifications" | "clipboard" | "haptics" | "shortcuts" | "screen_capture" | "microphone" | "health_data" | "contacts" | "calendar_native";
type NodePlatform = "ios" | "macos" | "web" | "cli";
type NodeConnectionState = "connected" | "healthy" | "stale" | "disconnected";
interface NodeRegistration {
    nodeId: string;
    platform: NodePlatform;
    name: string;
    capabilities: NodeCapability[];
    permissions: string[];
    pairingToken?: string;
    metadata?: Record<string, unknown>;
}
interface NodeInvocation {
    invocationId: string;
    capability: NodeCapability;
    action: string;
    params: Record<string, unknown>;
    timeoutMs: number;
    metadata?: Record<string, unknown>;
}
interface NodeResult {
    invocationId: string;
    success: boolean;
    data?: unknown;
    metadata?: Record<string, unknown>;
    error?: string;
}
interface NodeHealthSnapshot {
    state: NodeConnectionState;
    lastSeenAt: string;
    lastHeartbeatAt: string;
    heartbeatAgeMs: number;
    latencyMs?: number;
}
interface NodeSnapshot {
    nodeId: string;
    connectionId: string;
    platform: NodePlatform;
    name: string;
    capabilities: NodeCapability[];
    permissions: string[];
    connectedAt: string;
    lastSeenAt: string;
    lastHeartbeatAt: string;
    disconnectedAt: string | null;
    state: NodeConnectionState;
    authMode: "anonymous" | "api_key";
    pairingTokenPresent: boolean;
    lastError: string | null;
    lastInvocationAt: string | null;
    health: NodeHealthSnapshot;
}

type SessionStatus = "active" | "waiting_approval" | "handoff_requested" | "escalated" | "archived" | "closed";
type SessionToolTier = "catalog" | "active" | "extended";
type SessionPrimarySurface = "ios-chat" | "ios-voice" | "imessage-fallback" | "meta-glasses-relay" | "web";
type SessionInteractionMode = "chat" | "voice" | "fallback" | "approval";
type SessionEventType = "created" | "message" | "compact" | "yield" | "handoff" | "branch" | "archive" | "handoff" | "branch" | "escalate" | "tool_call" | "tool_result" | "approval" | "rollback" | "closed";
interface SessionHistoryMessage {
    role: string;
    content: string;
}
interface SessionMetadata {
    title: string | null;
    status: SessionStatus;
    ownerId: string | null;
    summary: string | null;
    trustZone: Zone | null;
    toolTier: SessionToolTier | null;
    budgetCents: number;
    lastRoute: string | null;
    lastCompactedAt: string | null;
    primarySurface: SessionPrimarySurface | null;
    interactionMode: SessionInteractionMode | null;
    fallbackEligible: boolean;
    fallbackSentAt: string | null;
    fallbackReason: string | null;
    updatedAt: string;
}
interface SessionMetadataPatch {
    title?: string | null;
    status?: SessionStatus;
    ownerId?: string | null;
    summary?: string | null;
    trustZone?: Zone | null;
    toolTier?: SessionToolTier | null;
    budgetCents?: number;
    lastRoute?: string | null;
    lastCompactedAt?: string | null;
    primarySurface?: SessionPrimarySurface | null;
    interactionMode?: SessionInteractionMode | null;
    fallbackEligible?: boolean;
    fallbackSentAt?: string | null;
    fallbackReason?: string | null;
}
interface SessionEvent {
    id: number;
    sessionId: string;
    type: SessionEventType;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
}
interface SessionSummary {
    id: string;
    createdAt: string;
    lastActiveAt: string;
    metadata: SessionMetadata;
}
interface SessionDetail extends SessionSummary {
    history: SessionHistoryMessage[];
    events: SessionEvent[];
}

/** Row returned by decision_log_search / DecisionJournal API */
type DecisionJournalOutcomeStatus = "pending" | "succeeded" | "failed" | "superseded" | "abandoned";
type DecisionJournalTriggerType = "trade_notional" | "architecture" | "scheduling_conflict" | "contract_change" | "manual" | "other";
interface DecisionJournalEntry {
    id: string;
    createdAt: string;
    domain: string;
    triggerType: DecisionJournalTriggerType;
    triggerDetail: string | null;
    decision: string;
    reasoning: string;
    confidence: number;
    alternatives: string[];
    contextRefs: string[];
    outcomeStatus: DecisionJournalOutcomeStatus;
    outcomeLink: string | null;
    reviewedAt: string | null;
    taskId: string | null;
}

declare const VOICE_READINESS_CAUSES: readonly ["daemon_offline", "auth_failed", "ws_unavailable", "mic_permission_denied", "stt_unavailable", "assistant_unavailable", "tts_unavailable", "audio_playback_failed", "repair_failed", "alert_message_unavailable", "ingress_unreachable"];
type VoiceReadinessCause = (typeof VOICE_READINESS_CAUSES)[number];
type VoiceReadinessStatus = "ready" | "degraded" | "repairing" | "offline";
type VoiceReadinessCheckName = "daemon" | "auth" | "websocket" | "stt" | "assistant" | "tts" | "playback" | "ingress";
interface VoiceReadinessCheckResult {
    name: VoiceReadinessCheckName;
    ok: boolean;
    durationMs: number;
    cause: VoiceReadinessCause | null;
    message: string;
    checkedAt: string;
}
type VoiceRepairStepId = "restart_daemon" | "reload_launch_agent" | "build_shared_core" | "hydrate_dependencies" | "rotate_logs" | "clear_stale_runtime_state";
interface VoiceRepairStepState {
    id: VoiceRepairStepId;
    label: string;
    status: "pending" | "running" | "succeeded" | "failed" | "blocked";
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    message: string;
}
interface VoiceReadinessState {
    status: VoiceReadinessStatus;
    cause: VoiceReadinessCause | null;
    message: string;
    lastCheckedAt: string;
    lastSuccessfulVoiceAt: string | null;
    checks: VoiceReadinessCheckResult[];
    repair: {
        active: boolean;
        startedAt: string;
        finishedAt: string | null;
        steps: VoiceRepairStepState[];
    } | null;
}
interface VoiceReadinessResponse {
    readiness: VoiceReadinessState;
}
declare const VOICE_READINESS_MESSAGES: Record<VoiceReadinessCause, string>;
declare function voiceReadinessMessage(cause: VoiceReadinessCause): string;

type RamPressureStatus = "green" | "yellow" | "red";
interface SystemRamPressure {
    status: RamPressureStatus;
    reason: string;
    recommendation: string;
    raw?: string;
}
interface SystemRamMemorySnapshot {
    totalBytes: number;
    freeBytes: number | null;
    availableBytes: number | null;
    usedBytes: number;
    swapUsedBytes: number | null;
    pressure: SystemRamPressure;
}
interface SystemRamDaemonSnapshot {
    pid?: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
}
interface SystemRamProcessSnapshot {
    pid?: number;
    command: string;
    rssBytes: number;
    memoryPercent: number | null;
}
interface SystemRamOllamaModel {
    name: string;
    sizeBytes: number | null;
    processor: string | null;
    until: string | null;
}
interface SystemRamOllamaSnapshot {
    source: "ollama ps" | "unavailable";
    loadedModels: SystemRamOllamaModel[];
    error?: string;
}
interface SystemRamSnapshot {
    timestamp: string;
    platform: string;
    memory: SystemRamMemorySnapshot;
    daemon: SystemRamDaemonSnapshot;
    topProcesses: SystemRamProcessSnapshot[];
    ollama: SystemRamOllamaSnapshot;
    warnings: string[];
}

/**
 * Single source of truth for the per-family provider concurrency budget on
 * the M4 16GB baseline: one local model at a time, modest free fan-out.
 * Consumed by `DEFAULT_CONFIG.experimental.providerConcurrency` below AND by
 * core's tier-mode "explicit override" detection — always import this rather
 * than copying the numbers, so the two sites can never drift apart again.
 */
declare const DEFAULT_PROVIDER_CONCURRENCY: Record<BillingMode, number>;
declare const DEFAULT_CONFIG: ZaraaConfig;
/**
 * Standalone defaults for the proactive AlertManager — re-exported so the
 * monitoring subsystem can construct itself with safe defaults when the
 * `monitoring.alerts` block is absent from `zaraa.config.json`.
 */
declare const DEFAULT_ALERT_MANAGER_CONFIG: Required<AlertManagerConfigBlock>;
/**
 * Standalone defaults for the `trading` block — re-exported so callers that
 * construct trading subsystems independently of the full ZaraaConfig (e.g.
 * unit tests, plugin bootstrap) can share the same baseline.
 */
declare const DEFAULT_TRADING_CONFIG: NonNullable<TradingConfig>;

declare const WEEKLY_REVIEW_MACRO_PROMPT: string;
/**
 * Periodic ops probe: gateway, memory footprint, trading risk/breaker, Ollama tags, round-trip latency.
 * Final line must be exactly `HEALTH_CHECK_STATUS=PASS` or `HEALTH_CHECK_STATUS=FAIL` for automation.
 */
declare const HEALTH_CHECK_4H_MACRO_PROMPT: string;
declare const AUTONOMY_PULSE_MACRO_PROMPT: string;
/**
 * Targeted research cadence: strengthen decision quality and feed the task queue
 * with evidence-backed next steps.
 */
declare const RESEARCH_SPRINT_MACRO_PROMPT: string;
/**
 * Reflection-for-improvement cadence: convert repeated friction into procedure.
 */
declare const SELF_IMPROVEMENT_MACRO_PROMPT: string;
/**
 * Queue/self-repair cadence: retry only recoverable issues and surface what still
 * needs attention without human babysitting.
 */
declare const SELF_HEALING_MACRO_PROMPT: string;
/**
 * Weekly review that turns repeated task failures and weak delegation packets
 * into concrete repair work and better routing rules.
 */
declare const WEEKLY_FAILURE_DEBT_SWARM_REVIEW_MACRO_PROMPT: string;
/**
 * Voice-note briefings: these prompts intentionally produce a single spoken
 * script rather than markdown so the scheduler can synthesize and send the
 * result as an audio attachment.
 */
declare const MORNING_VOICE_BRIEF_MACRO_PROMPT: string;
declare const AFTERNOON_VOICE_BRIEF_MACRO_PROMPT: string;
declare const NIGHT_VOICE_BRIEF_MACRO_PROMPT: string;

interface ValidationResult {
    warnings: string[];
    errors: string[];
}
declare function validateConfig(config: Partial<ZaraaConfig>): ValidationResult;

/**
 * Loads the Zaraa configuration from a directory.
 *
 * 1. Tries to read `zaraa.config.json` from `configDir`, then `config.json`.
 * 2. If neither file exists, falls back to an empty object.
 * 3. Deep-merges: DEFAULT_CONFIG <- fileConfig <- overrides.
 * 4. Validates the merged result.
 * 5. Returns the final config.
 */
declare function loadConfig(configDir: string, overrides?: Partial<ZaraaConfig>): Promise<ZaraaConfig>;

export { AFTERNOON_VOICE_BRIEF_MACRO_PROMPT, AUTONOMY_PULSE_MACRO_PROMPT, type AbletonPluginConfig, type Action, type ActionResult, type ActionType, type AlertManagerConfigBlock, type AutonomyConfig, type AutonomyGoalBiasConfig, type AutonomyMode, type BehaviorConfig, type BillingMode, type CalendarGoogleConfig, type CliAnythingConfig, type CommandCycleConfig, type CommandCycleMode, type CommandCycleRiskLevel, type CompletionNotificationConfig, type ComputerControlConfig, type ComputerControlDesktopBackendConfig, type ComputerControlSessionCap, type ContinuityConfig, type ControlActionDefinition, type ControlActionEnvelope, type ControlActionEvent, type ControlActionResult, type ControlActionStats, type ControlActionStatus, type ControlActionType, type ControlEventsResponse, type ControlKillSwitchLevel, type ControlKillSwitchState, type ControlPolicy, type ControlPolicyApprovals, type ControlPolicyFile, type ControlPolicyNetwork, type ControlPolicyPatch, type ControlPolicyShell, type ControlRiskLevel, type ControlStatusSnapshot, type CreativeJoyConfig, type CurriculumRoutingConfig, type CursorAgentTimeoutConfig, DEFAULT_ALERT_MANAGER_CONFIG, DEFAULT_CONFIG, DEFAULT_PROFILE, DEFAULT_PROVIDER_CONCURRENCY, DEFAULT_TRADING_CONFIG, type DailyAssistantConfig, type DecisionJournalEntry, type DecisionJournalOutcomeStatus, type DecisionJournalTriggerType, type DiscordConfig, type EmbeddingConfig, type GatewayAuthConfig, type GitHubConfig, type GmailConfig, type GuiConfig, type GuiSafetyConfig, HEALTH_CHECK_4H_MACRO_PROMPT, type HardwareProfileId, type LLMMessage, type LLMProvider, type LLMResponse, type LLMStreamChunk, type LLMToolCall, type LLMToolDefinition, type LocalContinuationNudgeConfig, type MCPConfig, type MCPServerConfig, type MCPTransport, MORNING_VOICE_BRIEF_MACRO_PROMPT, type MemoryEntry, type MemoryTier, type ModelControlsConfig, type ModelRoutingConfig, type MonitoringConfig, NIGHT_VOICE_BRIEF_MACRO_PROMPT, type NodeCapability, type NodeConnectionState, type NodeHealthSnapshot, type NodeInvocation, type NodePlatform, type NodeRegistration, type NodeResult, type NodeSnapshot, type NotificationTransport, type NotionConfig, type ObsidianConfig, type PartnershipConfig, type PluginManifest, type PluginToolDefinition, type PluginTrust, type PolymarketPredictionConfig, type PredictionSmartMoneyConfig, type PredictionsConfig, type PrivacyConfig, type ProactivityConfig, type ProactivityLevel, type ProviderAuthType, type ProviderCallOptions, type ProviderCapabilities, type ProviderConfig, type ProviderFamilyQuotaConfig, type ProviderMetrics, type ProviderPricing, type ProviderRouteHint, type ProviderTimeoutReason, type ProviderWarmupResult, RESEARCH_SPRINT_MACRO_PROMPT, type RamPressureStatus, type ResponseEnvelopeMode, type RiskTier, type RoutingConfig, SELF_HEALING_MACRO_PROMPT, SELF_IMPROVEMENT_MACRO_PROMPT, type ScheduledTask, type SchedulerConfig, type SessionDetail, type SessionEvent, type SessionEventType, type SessionHistoryMessage, type SessionInteractionMode, type SessionMetadata, type SessionMetadataPatch, type SessionPrimarySurface, type SessionStatus, type SessionSummary, type SessionToolTier, type SlackConfig, type SpotifyConfig, type StudioConfig, type SystemRamDaemonSnapshot, type SystemRamMemorySnapshot, type SystemRamOllamaModel, type SystemRamOllamaSnapshot, type SystemRamPressure, type SystemRamProcessSnapshot, type SystemRamSnapshot, type TaskNotificationPreference, type TelegramConfig, type TimersConfig, type ToolSuggestionConfig, type TradingConfig, type TrustedZoneConfig, type TwilioVoiceCallConfig, VOICE_READINESS_CAUSES, VOICE_READINESS_MESSAGES, type ValidationResult, type VideoPluginConfig, type VisionConfig, type VoiceConfig, type VoiceReadinessCause, type VoiceReadinessCheckName, type VoiceReadinessCheckResult, type VoiceReadinessResponse, type VoiceReadinessState, type VoiceReadinessStatus, type VoiceRepairStepId, type VoiceRepairStepState, WEEKLY_FAILURE_DEBT_SWARM_REVIEW_MACRO_PROMPT, WEEKLY_REVIEW_MACRO_PROMPT, type WakeWordConfig, type Watchdog, type WebhookConfig, type WhatsAppConfig, type WhisperFlowConfig, ZONES, type ZaraaConfig, type ZaraaProfileConfig, type ZaraacoderConfigBlock, type ZaraacoderExecutorConfig, type ZaraacoderModelPoolConfig, type ZaraacoderSubscriptionBudgetConfig, type Zone, type ZoneCapabilities, loadConfig, validateConfig, voiceReadinessMessage };
