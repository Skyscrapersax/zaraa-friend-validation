import { ChildProcess } from 'node:child_process';

/**
 * Optional callback for audit logging. The sandbox package stays
 * decoupled from core's AuditLogger — the caller wires the two together.
 */
type BrowserAuditFn = (entry: {
    action: string;
    zone: string;
    result: "allowed" | "denied";
    reason?: string;
    scriptPreview?: string;
    ts: string;
}) => void;
interface BrowserSandboxConfig {
    allowedDomains: string[];
    idleTimeout: number;
    headless?: boolean;
    /** Current zone — required for evaluate(). Accepts "sandbox" | "guarded" | "trusted". */
    zone?: string;
    /** Optional audit callback; called synchronously for every evaluate() attempt. */
    onAudit?: BrowserAuditFn;
}
declare class BrowserSandbox {
    private browser;
    private page;
    private idleTimer;
    private config;
    private domainMatcher;
    private readonly zone;
    private readonly onAudit;
    constructor(config: BrowserSandboxConfig);
    /**
     * Lazy-load Playwright and launch the browser only on first use.
     * This avoids requiring Playwright as a hard dependency — it is
     * loaded dynamically so the rest of the sandbox package works
     * without it installed.
     */
    private ensureBrowser;
    /**
     * Reset the idle timer. Called after every browser action so the
     * browser auto-disposes only after a period of inactivity.
     */
    private resetIdleTimer;
    /**
     * Check whether a URL's hostname matches the configured domain
     * allowlist. Throws before any browser interaction if the domain
     * is not permitted.
     */
    private isDomainAllowed;
    /**
     * Navigate to the given URL.
     * The URL's domain must match the allowlist or an error is thrown
     * (without launching the browser).
     */
    navigate(url: string): Promise<void>;
    /**
     * Get the text content of the first element matching the selector.
     */
    getText(selector: string): Promise<string>;
    /**
     * Click the first element matching the selector.
     */
    click(selector: string): Promise<void>;
    /**
     * Take a screenshot of the current page.
     */
    screenshot(): Promise<Buffer>;
    /**
     * Evaluate a JavaScript expression in the page context.
     *
     * **Zone gate (S2 fix):** Requires at least "guarded" zone. The sandbox
     * zone is read-only and must never execute arbitrary JS. Every call —
     * whether allowed or denied — produces an audit entry.
     *
     * The script preview in the audit log is truncated to avoid leaking
     * secrets that might appear in the JS source.
     */
    evaluate(script: string): Promise<unknown>;
    /**
     * Close the browser and clean up all resources.
     */
    dispose(): Promise<void>;
}

/**
 * Camofox anti-detection browser adapter — Playwright-compatible.
 *
 * Camofox is launched as a subprocess with --remote-debugging-port and
 * controlled via Playwright's chromium.connectOverCDP(). The subprocess
 * lifecycle and CDP attachment are both injectable so tests run without
 * launching the real binary.
 *
 * Integration policy: Camofox should only be used when a tool explicitly
 * requests stealth (tool.metadata.stealth === true) AND the operator has
 * configured `sandbox.browser.provider = "camofox"` in zaraa.config.json.
 * Otherwise the default Playwright/Chromium path is used.
 */

interface CamofoxAdapterConfig {
    /** Absolute path to the camofox executable. */
    binaryPath: string;
    /** Optional extra args; --remote-debugging-port is injected automatically. */
    args?: string[];
    /** CDP port to use. 0 → choose ephemeral via env var instead. Default: 9222. */
    cdpPort?: number;
    /** Max ms to wait for CDP endpoint readiness after spawn. Default: 10000. */
    startupTimeoutMs?: number;
    /** Override spawn (tests). Defaults to child_process.spawn. */
    spawn?: (cmd: string, args: string[]) => ChildProcess;
    /** Override Playwright import (tests). Defaults to dynamic `import('playwright')`. */
    playwrightLoader?: () => Promise<{
        chromium: {
            connectOverCDP: (endpoint: string) => Promise<unknown>;
        };
    }>;
    /** Sleep helper override (tests). Defaults to setTimeout. */
    sleep?: (ms: number) => Promise<void>;
    /** Probe override (tests). Defaults to fetching /json/version on the CDP port. */
    probe?: (endpoint: string) => Promise<boolean>;
}
interface CamofoxSession {
    browser: {
        newPage(): Promise<CamofoxPage>;
        close(): Promise<void>;
    };
    cdpEndpoint: string;
    dispose: () => Promise<void>;
}
interface CamofoxPage {
    goto(url: string, opts?: {
        waitUntil?: string;
        timeout?: number;
    }): Promise<unknown>;
    content(): Promise<string>;
    screenshot(opts?: {
        type?: "png" | "jpeg";
    }): Promise<Buffer>;
    close(): Promise<void>;
}
declare class CamofoxAdapter {
    private readonly binaryPath;
    private readonly args;
    private readonly cdpPort;
    private readonly startupTimeoutMs;
    private readonly spawnFn;
    private readonly loadPlaywright;
    private readonly sleep;
    private readonly probe;
    private process;
    private session;
    constructor(config: CamofoxAdapterConfig);
    get cdpEndpoint(): string;
    launch(): Promise<CamofoxSession>;
    dispose(): Promise<void>;
    private waitForCdpReady;
}
type BrowserProviderName = "playwright" | "camofox";
/**
 * Pick the browser provider based on tool intent + operator config.
 * Routes a stealth-tagged tool through Camofox when it's the configured
 * provider; otherwise falls back to "playwright".
 */
declare function pickBrowserProvider(input: {
    toolWantsStealth?: boolean;
    configuredProvider?: BrowserProviderName;
}): BrowserProviderName;

declare class FsSandbox {
    private allowPatterns;
    private matcher;
    private allowedRoots;
    private allowedRealRoots;
    constructor(allowPatterns: string[]);
    /**
     * If a path is a symlink, resolve it and verify the real target is also allowed.
     * This prevents symlink traversal attacks (e.g., ~/notes/link -> /etc/passwd).
     */
    private assertNotSymlinkEscape;
    /**
     * Assert that `filePath` is readable under the current sandbox policy —
     * identical checks to `read()` but without actually reading the file.
     * Used by plugin hosts that must gate access before delegating I/O to an
     * untrusted handler (e.g. plugin-vision readFileSync call).
     * Throws with an "Access denied" message if the path is disallowed.
     */
    assertReadAllowed(filePath: string): Promise<void>;
    read(filePath: string): Promise<string>;
    write(filePath: string, content: string): Promise<void>;
    delete(filePath: string): Promise<void>;
    list(dirPath: string): Promise<string[]>;
    exists(filePath: string): Promise<boolean>;
    private resolvePath;
    private assertAllowed;
    private assertRealPathAllowed;
    private isAllowedRealPath;
    private patternRoot;
    private safeRealpath;
    private expandPatterns;
}

/**
 * Environment variable sanitizer for sandboxed subprocesses.
 *
 * Uses an ALLOWLIST approach: only explicitly permitted variables are
 * forwarded to child processes. This prevents API keys, tokens, secrets,
 * and other sensitive values from leaking into sandboxed execution contexts.
 *
 * New sensitive vars added to the parent environment are blocked by default
 * — no blocklist maintenance required.
 */
/**
 * Return a copy of `process.env` containing only allowlisted keys.
 *
 * @param extra - Additional variables to merge on top (e.g. from config).
 *                These are always included regardless of the allowlist,
 *                since the caller explicitly opted in to them.
 */
declare function sanitizeEnv(extra?: Record<string, string>): Record<string, string | undefined>;

interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
interface ShellSandboxConfig {
    allowedCommands: string[];
    timeout: number;
    shell?: string;
    env?: Record<string, string>;
}
interface ShellExecuteOptions {
    cwd?: string;
}
declare class ShellSandbox {
    private commandMatcher;
    private timeout;
    private shell;
    private extraEnv;
    constructor(config: ShellSandboxConfig);
    /**
     * Execute a command in the sandbox.
     *
     * Uses execFile (NOT exec) to prevent shell injection attacks.
     * The command must match one of the allowed glob patterns.
     *
     * @param command - The executable name (e.g., "git", "ls", "echo")
     * @param args - Arguments to pass to the command
     */
    execute(command: string, args?: string[], options?: ShellExecuteOptions): Promise<ShellResult>;
}

export { type BrowserAuditFn, type BrowserProviderName, BrowserSandbox, type BrowserSandboxConfig, CamofoxAdapter, type CamofoxAdapterConfig, type CamofoxPage, type CamofoxSession, FsSandbox, type ShellExecuteOptions, type ShellResult, ShellSandbox, type ShellSandboxConfig, pickBrowserProvider, sanitizeEnv };
