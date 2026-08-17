// src/browser/browser-sandbox.ts
import picomatch from "picomatch";
var ZONE_LEVELS = {
  sandbox: 0,
  guarded: 1,
  trusted: 2
};
var EVALUATE_MIN_ZONE = "guarded";
var AUDIT_SCRIPT_PREVIEW_LENGTH = 80;
var BrowserSandbox = class {
  browser = null;
  page = null;
  idleTimer = null;
  config;
  domainMatcher;
  zone;
  onAudit;
  constructor(config) {
    this.config = {
      headless: true,
      ...config,
      idleTimeout: config.idleTimeout || 18e4
    };
    this.zone = config.zone ?? "sandbox";
    this.onAudit = config.onAudit;
    this.domainMatcher = picomatch(config.allowedDomains);
  }
  /**
   * Lazy-load Playwright and launch the browser only on first use.
   * This avoids requiring Playwright as a hard dependency — it is
   * loaded dynamically so the rest of the sandbox package works
   * without it installed.
   */
  async ensureBrowser() {
    if (this.browser && this.page) {
      return;
    }
    const packageName = "playwright";
    const pw = await import(packageName);
    this.browser = await pw.chromium.launch({
      headless: this.config.headless
    });
    this.page = await this.browser.newPage();
    this.resetIdleTimer();
  }
  /**
   * Reset the idle timer. Called after every browser action so the
   * browser auto-disposes only after a period of inactivity.
   */
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, this.config.idleTimeout);
  }
  /**
   * Check whether a URL's hostname matches the configured domain
   * allowlist. Throws before any browser interaction if the domain
   * is not permitted.
   */
  isDomainAllowed(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return this.domainMatcher(parsed.hostname);
    } catch {
      return false;
    }
  }
  /**
   * Navigate to the given URL.
   * The URL's domain must match the allowlist or an error is thrown
   * (without launching the browser).
   */
  async navigate(url) {
    if (!this.isDomainAllowed(url)) {
      throw new Error(
        `Domain not allowed: "${url}". The URL does not match any pattern in the domain allowlist.`
      );
    }
    await this.ensureBrowser();
    await this.page.goto(url);
    this.resetIdleTimer();
  }
  /**
   * Get the text content of the first element matching the selector.
   */
  async getText(selector) {
    await this.ensureBrowser();
    const text = await this.page.textContent(selector);
    this.resetIdleTimer();
    return text ?? "";
  }
  /**
   * Click the first element matching the selector.
   */
  async click(selector) {
    await this.ensureBrowser();
    await this.page.click(selector);
    this.resetIdleTimer();
  }
  /**
   * Take a screenshot of the current page.
   */
  async screenshot() {
    await this.ensureBrowser();
    const buffer = await this.page.screenshot();
    this.resetIdleTimer();
    return buffer;
  }
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
  async evaluate(script) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const scriptPreview = script.length > AUDIT_SCRIPT_PREVIEW_LENGTH ? script.slice(0, AUDIT_SCRIPT_PREVIEW_LENGTH) + "\u2026" : script;
    const callerLevel = ZONE_LEVELS[this.zone];
    const requiredLevel = ZONE_LEVELS[EVALUATE_MIN_ZONE];
    if (callerLevel === void 0 || callerLevel < requiredLevel) {
      this.onAudit?.({
        action: "browser.evaluate",
        zone: this.zone,
        result: "denied",
        reason: `Zone "${this.zone}" is below minimum "${EVALUATE_MIN_ZONE}"`,
        scriptPreview,
        ts
      });
      throw new Error(
        "BrowserSandbox.evaluate requires at least guarded zone"
      );
    }
    this.onAudit?.({
      action: "browser.evaluate",
      zone: this.zone,
      result: "allowed",
      scriptPreview,
      ts
    });
    await this.ensureBrowser();
    const result = await this.page.evaluate(script);
    this.resetIdleTimer();
    return result;
  }
  /**
   * Close the browser and clean up all resources.
   */
  async dispose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
};

// src/browser/camofox.ts
var DEFAULT_PORT = 9222;
var DEFAULT_TIMEOUT_MS = 1e4;
var CamofoxAdapter = class {
  binaryPath;
  args;
  cdpPort;
  startupTimeoutMs;
  spawnFn;
  loadPlaywright;
  sleep;
  probe;
  process = null;
  session = null;
  constructor(config) {
    this.binaryPath = config.binaryPath;
    this.args = config.args ?? [];
    this.cdpPort = config.cdpPort ?? DEFAULT_PORT;
    this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn = config.spawn ?? (() => {
      throw new Error("CamofoxAdapter requires a spawn fn (none provided)");
    });
    this.loadPlaywright = config.playwrightLoader ?? (async () => {
      const packageName = "playwright";
      const pw = await import(packageName);
      return pw;
    });
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.probe = config.probe ?? defaultProbe;
  }
  get cdpEndpoint() {
    return `http://127.0.0.1:${this.cdpPort}`;
  }
  async launch() {
    if (this.session) return this.session;
    const spawnArgs = [...this.args, `--remote-debugging-port=${this.cdpPort}`];
    this.process = this.spawnFn(this.binaryPath, spawnArgs);
    await this.waitForCdpReady();
    const pw = await this.loadPlaywright();
    const browser = await pw.chromium.connectOverCDP(this.cdpEndpoint);
    const session = {
      browser,
      cdpEndpoint: this.cdpEndpoint,
      dispose: async () => this.dispose()
    };
    this.session = session;
    return session;
  }
  async dispose() {
    try {
      await this.session?.browser?.close?.();
    } catch {
    }
    this.session = null;
    const proc = this.process;
    this.process = null;
    if (proc && proc.exitCode === null) {
      proc.kill?.("SIGTERM");
    }
  }
  async waitForCdpReady() {
    const deadline = Date.now() + this.startupTimeoutMs;
    const endpoint = this.cdpEndpoint;
    while (Date.now() < deadline) {
      if (await this.probe(endpoint)) return;
      await this.sleep(100);
    }
    throw new Error(
      `Camofox CDP endpoint ${endpoint} not ready after ${this.startupTimeoutMs}ms`
    );
  }
};
async function defaultProbe(endpoint) {
  try {
    const res = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(500)
    });
    return res.ok;
  } catch {
    return false;
  }
}
function pickBrowserProvider(input) {
  if (input.toolWantsStealth && input.configuredProvider === "camofox") return "camofox";
  return "playwright";
}

// src/filesystem/fs-sandbox.ts
import { readFile, writeFile, unlink, readdir, stat, mkdir, realpath, lstat } from "fs/promises";
import { realpathSync } from "fs";
import { resolve, normalize, dirname, sep } from "path";
import picomatch2 from "picomatch";
var FsSandbox = class {
  constructor(allowPatterns) {
    this.allowPatterns = allowPatterns;
    const expandedPatterns = this.expandPatterns(allowPatterns);
    this.matcher = picomatch2(expandedPatterns, { dot: true });
    this.allowedRoots = expandedPatterns.map((pattern) => this.patternRoot(pattern));
    this.allowedRealRoots = this.allowedRoots.map((root) => this.safeRealpath(root));
  }
  allowPatterns;
  matcher;
  allowedRoots;
  allowedRealRoots;
  /**
   * If a path is a symlink, resolve it and verify the real target is also allowed.
   * This prevents symlink traversal attacks (e.g., ~/notes/link -> /etc/passwd).
   */
  async assertNotSymlinkEscape(resolved) {
    await this.assertRealPathAllowed(resolved);
    try {
      const stats = await lstat(resolved);
      if (stats.isSymbolicLink()) {
        const real = await realpath(resolved);
        if (!this.isAllowedRealPath(real)) {
          throw new Error(`Access denied: symlink "${resolved}" points to "${real}" which is outside allowed directories`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Access denied")) throw err;
    }
  }
  /**
   * Assert that `filePath` is readable under the current sandbox policy —
   * identical checks to `read()` but without actually reading the file.
   * Used by plugin hosts that must gate access before delegating I/O to an
   * untrusted handler (e.g. plugin-vision readFileSync call).
   * Throws with an "Access denied" message if the path is disallowed.
   */
  async assertReadAllowed(filePath) {
    const resolved = this.resolvePath(filePath);
    this.assertAllowed(resolved);
    await this.assertNotSymlinkEscape(resolved);
  }
  async read(filePath) {
    const resolved = this.resolvePath(filePath);
    this.assertAllowed(resolved);
    await this.assertNotSymlinkEscape(resolved);
    return readFile(resolved, "utf-8");
  }
  async write(filePath, content) {
    const resolved = this.resolvePath(filePath);
    this.assertAllowed(resolved);
    await this.assertNotSymlinkEscape(resolved);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
  }
  async delete(filePath) {
    const resolved = this.resolvePath(filePath);
    this.assertAllowed(resolved);
    await this.assertNotSymlinkEscape(resolved);
    await unlink(resolved);
  }
  async list(dirPath) {
    const resolved = this.resolvePath(dirPath);
    this.assertAllowed(resolved);
    await this.assertNotSymlinkEscape(resolved);
    return readdir(resolved);
  }
  async exists(filePath) {
    const resolved = this.resolvePath(filePath);
    this.assertAllowed(resolved);
    try {
      await this.assertNotSymlinkEscape(resolved);
      await stat(resolved);
      return true;
    } catch {
      return false;
    }
  }
  resolvePath(filePath) {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const expanded = filePath.replace(/^~(?=\/|$)/, home);
    const absolute = resolve(expanded);
    const normalized = normalize(absolute);
    return normalized;
  }
  assertAllowed(resolvedPath) {
    if (!this.matcher(resolvedPath)) {
      throw new Error(`Access denied: "${resolvedPath}" is outside allowed directories`);
    }
  }
  async assertRealPathAllowed(resolvedPath) {
    const allowedRoot = this.allowedRoots.find((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`));
    if (!allowedRoot) {
      throw new Error(`Access denied: "${resolvedPath}" is outside allowed directories`);
    }
    let current = resolvedPath;
    while (current === allowedRoot || current.startsWith(`${allowedRoot}${sep}`)) {
      try {
        const real = await realpath(current);
        if (!this.isAllowedRealPath(real)) {
          throw new Error(`Access denied: "${resolvedPath}" resolves through "${real}" which is outside allowed directories`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Access denied")) throw err;
      }
      if (current === allowedRoot) break;
      current = dirname(current);
    }
  }
  isAllowedRealPath(realPath) {
    if (this.matcher(realPath)) return true;
    return this.allowedRealRoots.some((root) => realPath === root || realPath.startsWith(`${root}${sep}`));
  }
  patternRoot(pattern) {
    const globIndex = pattern.search(/[*?[\]{}()+@!]/);
    if (globIndex === -1) return normalize(resolve(pattern));
    const staticPart = pattern.slice(0, globIndex);
    const root = staticPart.endsWith(sep) ? staticPart.slice(0, -1) : dirname(staticPart);
    return normalize(resolve(root || sep));
  }
  safeRealpath(path) {
    try {
      return normalize(realpathSync(path));
    } catch {
      return path;
    }
  }
  expandPatterns(patterns) {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return patterns.map((p) => p.replace(/^~(?=\/|$)/, home));
  }
};

// src/shell/sanitize-env.ts
var ENV_ALLOWLIST = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "NODE_ENV"
]);
function sanitizeEnv(extra = {}) {
  const clean = {};
  for (const key of ENV_ALLOWLIST) {
    if (key in process.env) {
      clean[key] = process.env[key];
    }
  }
  return { ...clean, ...extra };
}

// src/shell/shell-sandbox.ts
import { execFile } from "child_process";
import { promisify } from "util";
import picomatch3 from "picomatch";
var execFileAsync = promisify(execFile);
var ShellSandbox = class {
  commandMatcher;
  timeout;
  shell;
  extraEnv;
  constructor(config) {
    this.commandMatcher = picomatch3(config.allowedCommands, { bash: true });
    this.timeout = config.timeout || 3e4;
    this.shell = config.shell;
    this.extraEnv = config.env || {};
  }
  /**
   * Execute a command in the sandbox.
   *
   * Uses execFile (NOT exec) to prevent shell injection attacks.
   * The command must match one of the allowed glob patterns.
   *
   * @param command - The executable name (e.g., "git", "ls", "echo")
   * @param args - Arguments to pass to the command
   */
  async execute(command, args = [], options = {}) {
    const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;
    const isAllowed = args.length > 0 ? this.commandMatcher(fullCommand) : this.commandMatcher(command);
    if (!isAllowed) {
      throw new Error(
        `Command not allowed: "${fullCommand}". The command does not match any pattern in the allowlist.`
      );
    }
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
        // 10MB
        ...this.shell && { shell: this.shell },
        ...options.cwd && { cwd: options.cwd },
        env: sanitizeEnv({
          ...this.extraEnv,
          ...options.cwd && { PWD: options.cwd }
        })
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      if (error instanceof Error && "killed" in error && error.killed) {
        throw new Error(`Command timed out after ${this.timeout}ms: "${fullCommand}"`);
      }
      if (error instanceof Error && "code" in error && typeof error.code === "number") {
        const execError = error;
        return {
          stdout: execError.stdout || "",
          stderr: execError.stderr || "",
          exitCode: execError.code
        };
      }
      throw error;
    }
  }
};
export {
  BrowserSandbox,
  CamofoxAdapter,
  FsSandbox,
  ShellSandbox,
  pickBrowserProvider,
  sanitizeEnv
};
