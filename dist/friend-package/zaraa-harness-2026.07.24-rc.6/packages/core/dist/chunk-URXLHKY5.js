// src/voice/twilio-voice.ts
import { EventEmitter } from "events";
var MULAW_BIAS = 132;
var MULAW_CLIP = 32635;
function linearToMulaw(sample) {
  const sign = sample < 0 ? 128 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 16384; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) ;
  const mantissa = sample >> exponent + 3 & 15;
  return ~(sign | exponent << 4 | mantissa) & 255;
}
function mulawToLinear(mulaw) {
  mulaw = ~mulaw & 255;
  const sign = mulaw & 128;
  const exponent = mulaw >> 4 & 7;
  const mantissa = mulaw & 15;
  let sample = (mantissa << 3) + MULAW_BIAS << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}
function mulawTopcm24k(mulaw) {
  const ratio = 3;
  const out = Buffer.alloc(mulaw.length * ratio * 2);
  let prev = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const curr = mulawToLinear(mulaw[i]);
    for (let j = 0; j < ratio; j++) {
      const t = j / ratio;
      const interpolated = Math.round(prev + (curr - prev) * t);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), (i * ratio + j) * 2);
    }
    prev = curr;
  }
  return out;
}
function pcm24kToMulaw(pcm) {
  const ratio = 3;
  const numSamples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(numSamples / ratio);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const sample = pcm.readInt16LE(i * ratio * 2);
    out[i] = linearToMulaw(sample);
  }
  return out;
}
var TwilioCallSession = class _TwilioCallSession extends EventEmitter {
  streamSid = null;
  closed = false;
  sendToTwilio = null;
  /** Pipeline functions injected after construction */
  sttFn = null;
  ttsFn = null;
  chatFn = null;
  audioBuffer = [];
  static MAX_BUFFER_CHUNKS = 2e3;
  /** Unique call info */
  callInfo;
  constructor(callInfo) {
    super();
    this.callInfo = callInfo;
  }
  /** Wire up the pipeline functions and Twilio WebSocket sender */
  configure(opts) {
    this.sttFn = opts.sttFn;
    this.ttsFn = opts.ttsFn;
    this.chatFn = opts.chatFn;
    if (opts.sendToTwilio) this.sendToTwilio = opts.sendToTwilio;
  }
  /** Wire only the WebSocket sender (called when Twilio stream connects) */
  setSendFn(fn) {
    this.sendToTwilio = fn;
  }
  /** Get the TTS function (used by stream handler for greeting) */
  getTtsFn() {
    return this.ttsFn;
  }
  /** Receive audio from Twilio (mulaw 8kHz base64) */
  handleTwilioMedia(payload) {
    if (this.closed) return;
    const mulaw = Buffer.from(payload, "base64");
    const pcm = mulawTopcm24k(mulaw);
    this.sendAudio(pcm);
  }
  /** Set the Twilio stream SID (received in the "start" message) */
  setStreamSid(sid) {
    this.streamSid = sid;
  }
  /** Mark the Twilio media stream as connected — send a greeting */
  markConnected() {
    this.callInfo.state = "in-progress";
    this.emit("connected");
  }
  // ── VoiceSession interface ─────────────────────────────────────
  sendAudio(chunk) {
    if (this.closed) return;
    if (this.audioBuffer.length >= _TwilioCallSession.MAX_BUFFER_CHUNKS) {
      this.audioBuffer.shift();
    }
    this.audioBuffer.push(chunk);
  }
  commitAudio() {
    if (this.closed || !this.sttFn || !this.ttsFn || !this.chatFn) return;
    const fullAudio = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    if (fullAudio.length > 0) {
      this.processAudio(fullAudio);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.audioBuffer = [];
    this.callInfo.state = "completed";
    this.callInfo.endedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (this.callInfo.startedAt) {
      this.callInfo.duration = Math.round(
        (Date.now() - new Date(this.callInfo.startedAt).getTime()) / 1e3
      );
    }
    this.removeAllListeners();
  }
  // ── Silence-based VAD (voice activity detection) ───────────────
  vadTimer = null;
  static VAD_SILENCE_MS = 1500;
  /** Call this when audio comes in to reset the silence timer */
  resetVadTimer() {
    if (this.vadTimer) clearTimeout(this.vadTimer);
    this.vadTimer = setTimeout(() => {
      this.commitAudio();
    }, _TwilioCallSession.VAD_SILENCE_MS);
  }
  // ── Internal pipeline ──────────────────────────────────────────
  async processAudio(audio) {
    if (!this.sttFn || !this.ttsFn || !this.chatFn) return;
    try {
      const text = await this.sttFn(audio);
      if (!text.trim()) return;
      this.emit("transcript", text, true);
      let responseText = "";
      for await (const event of this.chatFn(text)) {
        if (this.closed) break;
        this.emit("agent_event", event);
        if (event.type === "response" && "content" in event) {
          responseText += event.content;
        }
      }
      if (responseText && !this.closed) {
        const pcmAudio = await this.ttsFn(responseText);
        this.emit("audio", pcmAudio);
        this.playToTwilio(pcmAudio);
      }
      if (!this.closed) {
        this.emit("done");
      }
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("error", message);
      }
    }
  }
  /** Convert PCM 24kHz to mulaw 8kHz and stream to Twilio */
  playToTwilio(pcm) {
    if (!this.sendToTwilio || !this.streamSid) return;
    const mulaw = pcm24kToMulaw(pcm);
    const chunkSize = 8e3;
    for (let offset = 0; offset < mulaw.length; offset += chunkSize) {
      const slice = mulaw.subarray(offset, offset + chunkSize);
      this.sendToTwilio(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: slice.toString("base64") }
      }));
    }
  }
};
var TwilioVoiceProvider = class {
  name = "twilio-voice";
  config;
  constructor(config) {
    this.config = config;
  }
  isAvailable() {
    return !!(this.config.accountSid && this.config.authToken && this.config.fromNumber);
  }
  /**
   * Initiate an outbound call via Twilio REST API.
   * Returns a TwilioCallSession that will be connected when Twilio
   * establishes the Media Stream WebSocket back to us.
   */
  async initiateCall(to) {
    const callInfo = {
      callSid: "",
      to,
      from: this.config.fromNumber,
      state: "initiating",
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const session = new TwilioCallSession(callInfo);
    const streamUrl = `${this.config.publicUrl.replace(/^http/, "ws")}/ws/twilio-stream`;
    const statusUrl = `${this.config.publicUrl}/api/twilio/call-status`;
    const twiml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      `  <Start>`,
      `    <Stream url="${streamUrl}" />`,
      `  </Start>`,
      `  <Pause length="3600"/>`,
      "</Response>"
    ].join("\n");
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
    const body = new URLSearchParams({
      To: to,
      From: this.config.fromNumber,
      Twiml: twiml,
      StatusCallback: statusUrl,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST"
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15e3)
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      session.callInfo.state = "failed";
      throw new Error(`Twilio call failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    session.callInfo.callSid = data.sid;
    session.callInfo.state = "ringing";
    return session;
  }
  /**
   * Hang up an active call via Twilio REST API.
   */
  async hangup(callSid) {
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
    const body = new URLSearchParams({ Status: "completed" });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString(),
        signal: AbortSignal.timeout(1e4)
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Twilio hangup failed (${res.status}): ${errText}`);
    }
  }
  /** VoiceProvider.connect — not used for Twilio (use initiateCall instead) */
  async connect(_config) {
    throw new Error("Use TwilioVoiceProvider.initiateCall() for outbound calls");
  }
  getConfig() {
    return this.config;
  }
};

export {
  mulawTopcm24k,
  pcm24kToMulaw,
  TwilioCallSession,
  TwilioVoiceProvider
};
