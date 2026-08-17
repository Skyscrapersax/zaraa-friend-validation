import "./chunk-R5U7XKVJ.js";

// src/messaging/imessage-poller.ts
var IMessagePoller = class _IMessagePoller {
  reader;
  sender;
  contact;
  baseIntervalMs;
  sessionId;
  maxRetries;
  onMessage;
  claimStore;
  claimLeaseMs;
  claimOwnerId;
  static RETRY_DELAYS = [5e3, 15e3, 3e4];
  static MAX_RETRY_QUEUE = 20;
  static DEFAULT_CLAIM_LEASE_MS = 4 * 6e4;
  timer = null;
  lastSeenId = 0;
  consecutiveFailures = 0;
  lastError = null;
  messagesProcessed = 0;
  processing = false;
  /** Resolves when the current poll() completes. Allows callers to await completion
   *  without re-entering the critical section (prevents double-processing). */
  pollPromise = null;
  retryQueue = [];
  lastMessageAt = 0;
  // Timestamp of last received message
  static FAST_POLL_MS = 2e3;
  // 2s when actively chatting
  static ACTIVE_WINDOW_MS = 6e4;
  // Consider "active" for 60s after last message
  constructor(reader, sender, config) {
    this.reader = reader;
    this.sender = sender;
    this.contact = config.contact;
    this.baseIntervalMs = config.intervalMs ?? 5e3;
    this.sessionId = config.sessionId ?? `imessage-${config.contact.replace(/[^a-zA-Z0-9]/g, "")}`;
    this.maxRetries = config.maxRetries ?? 3;
    this.onMessage = config.onMessage;
    this.claimStore = config.claimStore ?? null;
    this.claimLeaseMs = Math.max(3e4, config.claimLeaseMs ?? _IMessagePoller.DEFAULT_CLAIM_LEASE_MS);
    this.claimOwnerId = `imessage-poller:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }
  /**
   * Initialize lastSeenId to the most recent message so we don't
   * process historical messages on first start.
   */
  initialize() {
    try {
      const recent = this.reader.readRecent({ contact: this.contact, limit: 1 });
      if (recent.length > 0) {
        this.lastSeenId = recent[0].id;
      }
    } catch (err) {
      this.lastSeenId = Number.MAX_SAFE_INTEGER;
      console.warn("[imessage-poller] Could not read recent messages \u2014 will only process new messages from now:", err instanceof Error ? err.message : err);
    }
  }
  /**
   * Attempt to process a single message through the onMessage handler.
   * Returns true on success, false on failure (message queued for retry).
   */
  async processMessage(msg, attempt) {
    const label = attempt > 0 ? `[retry ${attempt}/${this.maxRetries}]` : "";
    console.log(`[imessage-poller] ${label} Processing message ${msg.id} from ${this.contact}: "${msg.text.slice(0, 80)}"`);
    if (!this.tryClaimMessage(msg.id)) {
      console.log(`[imessage-poller] Message ${msg.id} already claimed by another instance \u2014 skipping`);
      return true;
    }
    try {
      const reply = await this.withTimeout(
        this.onMessage(msg, this.sessionId),
        18e4,
        "Response timeout (180s)"
      );
      if (reply && reply.trim() !== "") {
        await this.sender.send(this.contact, reply, { retryOnFailure: true });
        console.log(`[imessage-poller] Replied: "${reply.slice(0, 80)}..."`);
      } else {
        console.log(`[imessage-poller] Message ${msg.id} handled by gateway`);
      }
      this.markMessageHandled(msg.id);
      this.messagesProcessed++;
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[imessage-poller] Failed message ${msg.id} (attempt ${attempt + 1}):`, errorMsg);
      if (attempt + 1 < this.maxRetries) {
        if (this.retryQueue.length >= _IMessagePoller.MAX_RETRY_QUEUE) {
          const dropped = this.retryQueue.shift();
          console.warn(`[imessage-poller] Retry queue full, dropping oldest message ${dropped?.msg.id}`);
        }
        const delay = _IMessagePoller.RETRY_DELAYS[attempt] ?? 3e4;
        const nextRetryAt = Date.now() + delay;
        this.retryQueue.push({
          msg,
          attempts: attempt + 1,
          nextRetryAt,
          lastError: errorMsg
        });
        this.markMessageRetryScheduled(msg.id, nextRetryAt, errorMsg);
        console.log(`[imessage-poller] Queued message ${msg.id} for retry in ${delay / 1e3}s (attempt ${attempt + 2}/${this.maxRetries})`);
        if (attempt === 0) {
          try {
            await this.sender.send(this.contact, "Working on your message \u2014 give me a moment...");
          } catch (err2) {
            console.debug("[imessage-poller] ack send failed:", err2 instanceof Error ? err2.message : err2);
          }
        }
      } else {
        console.error(`[imessage-poller] Exhausted ${this.maxRetries} retries for message ${msg.id}`);
        this.markMessageFailed(msg.id, errorMsg);
        try {
          await this.sender.send(
            this.contact,
            `Sorry, I wasn't able to process that after ${this.maxRetries} attempts. Last error: ${errorMsg.slice(0, 100)}. Please try rephrasing.`,
            { retryOnFailure: true }
          );
        } catch (err2) {
          console.debug("[imessage-poller] exhaustion notice send failed:", err2 instanceof Error ? err2.message : err2);
        }
      }
      return false;
    }
  }
  /**
   * Process any messages in the retry queue whose delay has elapsed.
   */
  async processRetryQueue() {
    if (this.retryQueue.length === 0) return;
    const now = Date.now();
    const ready = this.retryQueue.filter((e) => e.nextRetryAt <= now);
    this.retryQueue = this.retryQueue.filter((e) => e.nextRetryAt > now);
    for (const entry of ready) {
      await this.processMessage(entry.msg, entry.attempts);
    }
  }
  async poll() {
    if (this.processing) return 0;
    this.processing = true;
    const run = async () => {
      try {
        await this.processRetryQueue();
        const messages = this.reader.readRecent({ contact: this.contact, limit: 20 });
        const newMessages = messages.filter((m) => !m.isFromMe && m.id > this.lastSeenId).sort((a, b) => a.id - b.id);
        if (newMessages.length === 0) {
          this.consecutiveFailures = 0;
          this.lastError = null;
          return 0;
        }
        for (const msg of newMessages) {
          this.lastSeenId = msg.id;
          const hasText = msg.text && msg.text.trim() !== "";
          const hasAttachments = msg.attachments && msg.attachments.length > 0;
          if (!hasText && !hasAttachments) continue;
          this.lastMessageAt = Date.now();
          await this.processMessage(msg, 0);
        }
        this.consecutiveFailures = 0;
        this.lastError = null;
        return newMessages.length;
      } catch (err) {
        this.consecutiveFailures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[imessage-poller] poll failed (attempt ${this.consecutiveFailures}): ${this.lastError}`
        );
        return 0;
      } finally {
        this.processing = false;
        this.pollPromise = null;
      }
    };
    this.pollPromise = run();
    return this.pollPromise;
  }
  getStatus() {
    return {
      healthy: this.consecutiveFailures === 0,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      messagesProcessed: this.messagesProcessed,
      retryQueueSize: this.retryQueue.length
    };
  }
  tryClaimMessage(messageId) {
    if (!this.claimStore) return true;
    try {
      return this.claimStore.tryClaim(messageId, this.claimOwnerId, this.claimLeaseMs);
    } catch (err) {
      console.warn(
        `[imessage-poller] Claim store failed for message ${messageId}; continuing without cross-process dedupe:`,
        err instanceof Error ? err.message : String(err)
      );
      return true;
    }
  }
  markMessageHandled(messageId) {
    if (!this.claimStore) return;
    try {
      this.claimStore.markHandled(messageId, this.claimOwnerId);
    } catch (err) {
      console.warn(
        `[imessage-poller] Failed to mark message ${messageId} handled:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  markMessageRetryScheduled(messageId, nextRetryAt, lastError) {
    if (!this.claimStore) return;
    try {
      this.claimStore.markRetryScheduled(messageId, this.claimOwnerId, nextRetryAt, lastError);
    } catch (err) {
      console.warn(
        `[imessage-poller] Failed to extend retry claim for message ${messageId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  markMessageFailed(messageId, lastError) {
    if (!this.claimStore) return;
    try {
      this.claimStore.markFailed(messageId, this.claimOwnerId, lastError);
    } catch (err) {
      console.warn(
        `[imessage-poller] Failed to record terminal failure for message ${messageId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  getBackoffInterval() {
    if (this.consecutiveFailures > 0) {
      const multiplier = Math.pow(2, Math.min(this.consecutiveFailures, 5));
      return this.baseIntervalMs * multiplier;
    }
    const timeSinceLastMsg = Date.now() - this.lastMessageAt;
    if (this.lastMessageAt > 0 && timeSinceLastMsg < _IMessagePoller.ACTIVE_WINDOW_MS) {
      return _IMessagePoller.FAST_POLL_MS;
    }
    return this.baseIntervalMs;
  }
  /**
   * Race a promise against a timeout, ensuring no dangling rejection.
   * Uses AbortController pattern instead of Promise.race to avoid
   * unhandled rejections from the losing promise.
   */
  withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      }, ms);
      promise.then(
        (value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      );
    });
  }
  start() {
    if (this.timer) return;
    this.initialize();
    console.log(`[imessage-poller] Watching for messages from ${this.contact} (every ${this.baseIntervalMs}ms)`);
    const tick = async () => {
      try {
        await this.poll();
      } catch (err) {
        console.error(`[imessage-poller] Unhandled poll error:`, err instanceof Error ? err.message : err);
      }
      if (this.timer !== null) {
        this.timer = setTimeout(tick, this.getBackoffInterval());
      }
    };
    this.timer = setTimeout(tick, this.baseIntervalMs);
  }
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.reader.close();
    } catch {
    }
    if (this.retryQueue.length > 0) {
      console.warn(`[imessage-poller] Stopped with ${this.retryQueue.length} messages still in retry queue`);
    }
    console.log(`[imessage-poller] Stopped. Processed ${this.messagesProcessed} messages total.`);
  }
};
export {
  IMessagePoller
};
