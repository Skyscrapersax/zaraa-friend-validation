// src/voice/call-manager.ts
var CallManager = class _CallManager {
  deps;
  /** Active call sessions keyed by callSid */
  activeCalls = /* @__PURE__ */ new Map();
  /** Call history (most recent first) */
  callLog = [];
  static MAX_LOG_SIZE = 200;
  constructor(deps) {
    this.deps = deps;
  }
  /**
   * Initiate an outbound call. Returns the call SID.
   */
  async dial(to) {
    if (this.activeCalls.size >= 1) {
      throw new Error("A call is already active. Hang up first.");
    }
    const session = await this.deps.provider.initiateCall(to);
    session.configure({
      sttFn: this.deps.sttFn,
      ttsFn: this.deps.ttsFn,
      chatFn: this.deps.chatFn,
      sendToTwilio: () => {
      }
      // Placeholder — replaced when Twilio stream connects
    });
    this.activeCalls.set(session.callInfo.callSid, session);
    this.addToLog(session.callInfo);
    session.on("done", () => this.onCallEnded(session));
    return session.callInfo;
  }
  /**
   * Hang up an active call.
   */
  async hangup(callSid) {
    const sid = callSid || this.getActiveCallSid();
    if (!sid) throw new Error("No active call to hang up.");
    const session = this.activeCalls.get(sid);
    if (!session) throw new Error(`No active call with SID: ${sid}`);
    await this.deps.provider.hangup(sid);
    session.close();
    this.onCallEnded(session);
  }
  /**
   * Get the active call session for a given callSid.
   * Used by the Twilio stream handler to wire up the WebSocket.
   */
  getSession(callSid) {
    return this.activeCalls.get(callSid);
  }
  /**
   * Get any active session (for matching incoming Twilio streams
   * when we only have one concurrent call).
   */
  getAnyActiveSession() {
    const first = this.activeCalls.values().next();
    return first.done ? void 0 : first.value;
  }
  /** Get the SID of the currently active call (if any) */
  getActiveCallSid() {
    const first = this.activeCalls.keys().next();
    return first.done ? null : first.value;
  }
  /** Get info about the active call */
  getActiveCallInfo() {
    const session = this.getAnyActiveSession();
    return session?.callInfo ?? null;
  }
  /** Update call state from Twilio status callback */
  updateCallState(callSid, state) {
    const session = this.activeCalls.get(callSid);
    if (session) {
      session.callInfo.state = state;
      if (state === "completed" || state === "failed" || state === "no-answer" || state === "busy" || state === "canceled") {
        session.close();
        this.onCallEnded(session);
      }
    }
    const logEntry = this.callLog.find((e) => e.callSid === callSid);
    if (logEntry) logEntry.state = state;
  }
  /** Get call history */
  getHistory(limit = 20) {
    return this.callLog.slice(0, limit);
  }
  /** Get the greeting message (spoken when call connects) */
  getGreeting() {
    return this.deps.greeting;
  }
  /** Get the STT function (for creating inbound sessions) */
  getSttFn() {
    return this.deps.sttFn;
  }
  /** Get the TTS function (for creating inbound sessions) */
  getTtsFn() {
    return this.deps.ttsFn;
  }
  /** Get the chat function (for creating inbound sessions) */
  getChatFn() {
    return this.deps.chatFn;
  }
  /**
   * Register an inbound call session that was created externally
   * (e.g. by the twilio-stream-handler when no session exists).
   */
  registerInboundSession(session) {
    this.activeCalls.set(session.callInfo.callSid, session);
    this.callLog.unshift({
      callSid: session.callInfo.callSid,
      to: session.callInfo.to,
      from: session.callInfo.from,
      direction: "inbound",
      state: session.callInfo.state,
      startedAt: session.callInfo.startedAt
    });
    if (this.callLog.length > _CallManager.MAX_LOG_SIZE) {
      this.callLog.pop();
    }
    session.on("done", () => this.onCallEnded(session));
  }
  /** Get the from number (our Twilio number) */
  getFromNumber() {
    return this.deps.provider.getConfig().fromNumber;
  }
  // ── Internal ───────────────────────────────────────────────────
  onCallEnded(session) {
    const sid = session.callInfo.callSid;
    this.activeCalls.delete(sid);
    const entry = this.callLog.find((e) => e.callSid === sid);
    if (entry) {
      entry.state = session.callInfo.state;
      entry.endedAt = session.callInfo.endedAt;
      entry.duration = session.callInfo.duration;
    }
  }
  addToLog(info) {
    this.callLog.unshift({
      callSid: info.callSid,
      to: info.to,
      from: info.from,
      direction: "outbound",
      state: info.state,
      startedAt: info.startedAt
    });
    if (this.callLog.length > _CallManager.MAX_LOG_SIZE) {
      this.callLog.pop();
    }
  }
};

export {
  CallManager
};
