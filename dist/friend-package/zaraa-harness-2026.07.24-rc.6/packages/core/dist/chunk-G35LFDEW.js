import {
  escapeAppleScript
} from "./chunk-ZLPP35NN.js";

// src/messaging/imessage-sender.ts
import { spawn } from "child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { homedir } from "os";
var IMESSAGE_OUTBOUND_STAGE_DIR = join(homedir(), "Pictures", "ZaraaOutbound");
function stageFileForIMessageSend(filePath) {
  const resolved = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  if (!existsSync(resolved)) {
    throw new Error(`Attachment not found: ${resolved}`);
  }
  const st = statSync(resolved);
  if (!st.isFile() || st.size < 32) {
    throw new Error(`Attachment empty or too small (${st.size} bytes): ${resolved}`);
  }
  const stageDir = process.env.ZARAA_IMESSAGE_OUTBOUND_STAGE_DIR || IMESSAGE_OUTBOUND_STAGE_DIR;
  mkdirSync(stageDir, { recursive: true });
  const ext = extname(resolved) || ".bin";
  const base = basename(resolved, ext).replace(/[^\w.-]+/g, "_").slice(0, 80) || "attach";
  const staged = join(stageDir, `${base}-${Date.now()}${ext}`);
  copyFileSync(resolved, staged);
  const stagedStat = statSync(staged);
  if (stagedStat.size < 32) {
    throw new Error(`Staged attachment still empty: ${staged}`);
  }
  return staged;
}
function operatorSessionId(operatorContact) {
  return `imessage-${operatorContact.replace(/[^a-zA-Z0-9]/g, "")}`;
}
function normalizeContact(contact) {
  return contact.trim().toLowerCase();
}
var SHORTCUT_NAME = "Zaraa Send iMessage";
function validateRecipient(recipient) {
  const trimmed = recipient.trim();
  if (!/^[+]?[0-9a-zA-Z@._\-]+$/.test(trimmed) || trimmed.length > 128) {
    throw new Error("Invalid recipient format");
  }
}
var IMessageSender = class {
  osa;
  sessionRecorder = null;
  sendMethod;
  // --- Bounded send retry queue (additive, opt-in) ---
  retryEnabled;
  maxQueueSize;
  maxRetries;
  baseBackoffMs;
  maxBackoffMs;
  tickMs;
  now;
  setIntervalFn;
  clearIntervalFn;
  retryQueue = [];
  retryTimer = null;
  draining = false;
  constructor(osa, sendMethod = "auto", retryConfig = {}) {
    this.osa = osa;
    this.sendMethod = sendMethod;
    this.retryEnabled = retryConfig.enabled ?? false;
    this.maxQueueSize = Math.max(1, retryConfig.maxQueueSize ?? 20);
    this.maxRetries = Math.max(1, retryConfig.maxRetries ?? 4);
    this.baseBackoffMs = Math.max(100, retryConfig.baseBackoffMs ?? 5e3);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, retryConfig.maxBackoffMs ?? 12e4);
    this.tickMs = Math.max(250, retryConfig.tickMs ?? 5e3);
    this.now = retryConfig.now ?? Date.now;
    this.setIntervalFn = retryConfig.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = retryConfig.clearIntervalFn ?? ((h) => clearInterval(h));
  }
  /**
   * Attach (or detach with null) a session recorder. All future sends to
   * the configured operator contact will be written to the operator's
   * iMessage session so inbound replies retain conversational context.
   */
  setSessionRecorder(config) {
    this.sessionRecorder = config;
  }
  /**
   * Send a message to the given recipient via Messages.app.
   * Note: Callers (e.g., IMessagePoller) are responsible for retry logic.
   *
   * Third arg may be a legacy service string ("iMessage"/"SMS") or a full
   * options object — existing call sites stay backwards-compatible.
   *
   * @param recipient - Phone number or email address
   * @param message - The text message to send
   * @param serviceOrOptions - Legacy service string or full options bag
   */
  async send(recipient, message, serviceOrOptions = "iMessage") {
    const options = typeof serviceOrOptions === "string" ? { service: serviceOrOptions } : serviceOrOptions;
    validateRecipient(recipient);
    try {
      await this.attemptSend(recipient, message, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.retryOnFailure && this.retryEnabled) {
        this.enqueueRetry(recipient, message, options, err.message);
      }
      throw err;
    }
  }
  /**
   * Single send attempt: AppleScript primary, Shortcuts fallback (auto mode),
   * plus operator session recording on success. Throws a descriptive error if
   * no send path succeeds. This is the unit the retry queue replays.
   */
  async attemptSend(recipient, message, options) {
    const service = options.service ?? "iMessage";
    let sent = false;
    let lastError = null;
    if (this.sendMethod === "auto" || this.sendMethod === "applescript") {
      try {
        await this.sendViaAppleScript(recipient, message, service);
        sent = true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.sendMethod === "applescript") {
          throw new Error(
            `Failed to send ${service} to "${recipient}": ${lastError.message}`
          );
        }
        console.debug(
          `[imessage-sender] AppleScript send failed, trying Shortcuts fallback: ${lastError.message.slice(0, 120)}`
        );
      }
    }
    const shortcutsAllowed = (this.sendMethod === "auto" || this.sendMethod === "shortcuts") && service !== "SMS";
    if (!sent && shortcutsAllowed) {
      try {
        await this.sendViaShortcuts(recipient, message);
        sent = true;
      } catch (error) {
        const scErr = error instanceof Error ? error : new Error(String(error));
        const combined = lastError ? `AppleScript: ${lastError.message.slice(0, 120)} | Shortcuts: ${scErr.message.slice(0, 120)}` : scErr.message;
        throw new Error(
          `Failed to send ${service} to "${recipient}": ${combined}`
        );
      }
    }
    if (!sent) {
      if (service === "SMS" && lastError) {
        throw new Error(
          `Failed to send ${service} to "${recipient}": ${lastError.message}`
        );
      }
      throw new Error(
        `Failed to send ${service} to "${recipient}": no send method succeeded`
      );
    }
    if (!options.skipSessionRecord && this.sessionRecorder && normalizeContact(recipient) === normalizeContact(this.sessionRecorder.operatorContact)) {
      try {
        const sessionId = operatorSessionId(this.sessionRecorder.operatorContact);
        this.sessionRecorder.sessionManager.create?.(sessionId);
        this.sessionRecorder.sessionManager.addMessage(sessionId, "assistant", message);
      } catch (err) {
        console.debug(
          "[imessage-sender] session record failed (non-fatal):",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  // ── Bounded send retry queue ──────────────────────────────────────────
  /**
   * Compute backoff delay for the next attempt: baseBackoffMs * 2^(attempt-1),
   * capped at maxBackoffMs. `attempt` is the number of attempts already made.
   */
  backoffDelay(attempt) {
    const raw = this.baseBackoffMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(raw, this.maxBackoffMs);
  }
  /**
   * Enqueue a failed send for background retry. Bounded: when the queue is
   * full the oldest pending send is dropped (with a log) so memory can't grow
   * without bound. Lazily starts the drain timer on first enqueue.
   */
  enqueueRetry(recipient, message, options, lastError) {
    if (this.retryQueue.length >= this.maxQueueSize) {
      const dropped = this.retryQueue.shift();
      console.warn(
        `[imessage-sender] retry queue full (${this.maxQueueSize}); dropping oldest pending send to "${dropped?.recipient}"`
      );
    }
    this.retryQueue.push({
      recipient,
      message,
      // Strip retryOnFailure on the replay so a re-failure during drain
      // doesn't re-enqueue (drainRetryQueue handles re-scheduling).
      options: { ...options, retryOnFailure: false },
      attempts: 1,
      nextAttemptAt: this.now() + this.backoffDelay(1),
      lastError
    });
    console.warn(
      `[imessage-sender] queued send to "${recipient}" for retry (1/${this.maxRetries}): ${lastError.slice(0, 120)}`
    );
    this.ensureRetryTimer();
  }
  /** Start the drain timer if it isn't already running. */
  ensureRetryTimer() {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.setIntervalFn(() => {
      void this.drainRetryQueue();
    }, this.tickMs);
  }
  /**
   * Replay any due pending sends. On success the entry is removed; on failure
   * it is re-scheduled with a longer backoff until maxRetries is reached, at
   * which point it is dropped with a clear log. Stops the timer once the queue
   * is empty so an idle sender holds no handles.
   *
   * Public for tests/operators to force a drain without waiting for the timer.
   */
  async drainRetryQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = this.now();
      const due = this.retryQueue.filter((e) => e.nextAttemptAt <= now);
      this.retryQueue = this.retryQueue.filter((e) => e.nextAttemptAt > now);
      for (const entry of due) {
        try {
          await this.attemptSend(entry.recipient, entry.message, entry.options);
          console.log(
            `[imessage-sender] retry succeeded for "${entry.recipient}" after ${entry.attempts} attempt(s)`
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const nextAttempts = entry.attempts + 1;
          if (nextAttempts > this.maxRetries) {
            console.error(
              `[imessage-sender] giving up on send to "${entry.recipient}" after ${entry.attempts} attempts; dropping message. Last error: ${errMsg.slice(0, 160)}`
            );
            continue;
          }
          if (this.retryQueue.length >= this.maxQueueSize) {
            const dropped = this.retryQueue.shift();
            console.warn(
              `[imessage-sender] retry queue full (${this.maxQueueSize}); dropping oldest pending send to "${dropped?.recipient}"`
            );
          }
          this.retryQueue.push({
            ...entry,
            attempts: nextAttempts,
            nextAttemptAt: this.now() + this.backoffDelay(nextAttempts),
            lastError: errMsg
          });
          console.warn(
            `[imessage-sender] retry ${nextAttempts}/${this.maxRetries} failed for "${entry.recipient}": ${errMsg.slice(0, 120)}`
          );
        }
      }
    } finally {
      this.draining = false;
      if (this.retryQueue.length === 0 && this.retryTimer !== null) {
        this.clearIntervalFn(this.retryTimer);
        this.retryTimer = null;
      }
    }
  }
  /** Number of sends currently awaiting retry. */
  getRetryQueueSize() {
    return this.retryQueue.length;
  }
  /**
   * Stop the retry drain timer and clear any pending sends. Idempotent. Call
   * on shutdown so the sender holds no timers across daemon restarts.
   */
  stop() {
    if (this.retryTimer !== null) {
      this.clearIntervalFn(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryQueue.length > 0) {
      console.warn(
        `[imessage-sender] stopped with ${this.retryQueue.length} send(s) still pending retry`
      );
    }
    this.retryQueue = [];
  }
  /**
   * Original AppleScript send via OsaBridge → Messages.app.
   * Requires macOS Automation permission for the calling process.
   */
  async sendViaAppleScript(recipient, message, service) {
    await this.osa.ensureAppRunning("Messages");
    const escapedRecipient = escapeAppleScript(recipient);
    const escapedMessage = escapeAppleScript(message);
    const serviceType = service === "SMS" ? "SMS" : "iMessage";
    const script = `tell application "Messages"
	set targetService to 1st service whose service type = ${serviceType}
	set targetBuddy to buddy "${escapedRecipient}" of targetService
	send "${escapedMessage}" to targetBuddy
end tell`;
    await this.osa.run(script);
  }
  /**
   * Fallback send via the macOS `shortcuts` CLI.
   *
   * Requires a Shortcut named "Zaraa Send iMessage" that:
   *  1. Receives text input
   *  2. Splits on "|||" delimiter
   *  3. Sends item 2 (message) to item 1 (recipient) via Messages
   *
   * Uses `spawn` with stdin (not shell) to avoid injection risks.
   * The shortcuts CLI has its own permission model that is granted at the
   * Shortcut level, not per-process, so it bypasses the Automation
   * permission issue that blocks direct osascript→Messages.app calls.
   */
  async sendViaShortcuts(recipient, message) {
    validateRecipient(recipient);
    const payload = `${recipient.trim()}|||${message}`;
    return new Promise((resolve, reject) => {
      const proc = spawn("shortcuts", ["run", SHORTCUT_NAME], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(
          new Error(
            `Shortcuts send timed out after 15s. Ensure "${SHORTCUT_NAME}" shortcut exists.`
          )
        );
      }, 15e3);
      let stderr = "";
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Shortcuts CLI exited ${code}: ${stderr.trim().slice(0, 200) || "(no stderr)"}`
            )
          );
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.stdin.write(payload);
      proc.stdin.end();
    });
  }
  /**
   * Send a file attachment to the given recipient via Messages.app.
   *
   * Messages.app's AppleScript dictionary accepts a direct parameter of type
   * `file` for the `send` command, so we can deliver local audio attachments
   * such as TTS-generated voice-note summaries.
   *
   * Note: file sending currently only works via AppleScript (no Shortcuts
   * fallback yet). If AppleScript is blocked by Automation permissions, this
   * will throw.
   */
  async sendFile(recipient, filePath, service = "iMessage") {
    validateRecipient(recipient);
    const stagedPath = stageFileForIMessageSend(filePath);
    const escapedRecipient = escapeAppleScript(recipient);
    const escapedPath = escapeAppleScript(stagedPath);
    const serviceType = service === "SMS" ? "SMS" : "iMessage";
    const script = `tell application "Messages"
	set targetService to 1st service whose service type = ${serviceType}
	set targetBuddy to buddy "${escapedRecipient}" of targetService
	set theAttachment to POSIX file "${escapedPath}" as alias
	send theAttachment to targetBuddy
end tell`;
    try {
      await this.osa.run(script);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to send file via ${serviceType} to "${recipient}": ${msg}`
      );
    }
  }
};

export {
  IMESSAGE_OUTBOUND_STAGE_DIR,
  stageFileForIMessageSend,
  IMessageSender
};
