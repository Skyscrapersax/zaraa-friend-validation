import {
  logVoicePathMetric
} from "./chunk-3NTESROK.js";

// src/voice/pipeline-voice.ts
import { EventEmitter } from "events";
var DEFAULT_CHAT_TIMEOUT_MS = 6e4;
var DEFAULT_CHAT_TIMEOUT_RESPONSE = "I heard you, but the reply took too long. Please try again.";
var NO_SPEECH_RESPONSE = "I didn't catch that. Please try again.";
var SILENT_MIC_RESPONSE = "I'm only getting silence from your microphone \u2014 it may be a virtual device (like BlackHole), muted, or missing permission. Pick a real mic in settings and try again.";
var SILENT_CAPTURE_PEAK = 1e-3;
var MIN_SHORT_SPEECH_AUDIO_BYTES = 8e3;
var FULL_SPEECH_AUDIO_BYTES = 24e3;
var MIN_SHORT_SPEECH_RMS = 0.01;
var MIN_SHORT_SPEECH_PEAK = 0.05;
var MIN_SPEECH_RMS = 25e-4;
var MIN_SPEECH_PEAK = 0.015;
function hasSpeechLikeSignal(audio) {
  if (audio.byteLength < MIN_SHORT_SPEECH_AUDIO_BYTES) return false;
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < audio.byteLength; offset += 2) {
    const normalized = audio.readInt16LE(offset) / 32768;
    const abs = Math.abs(normalized);
    sumSquares += normalized * normalized;
    peak = Math.max(peak, abs);
    samples++;
  }
  if (samples === 0) return false;
  const rms = Math.sqrt(sumSquares / samples);
  if (audio.byteLength < FULL_SPEECH_AUDIO_BYTES) {
    return rms >= MIN_SHORT_SPEECH_RMS && peak >= MIN_SHORT_SPEECH_PEAK;
  }
  return rms >= MIN_SPEECH_RMS && peak >= MIN_SPEECH_PEAK;
}
function sanitizeVoiceResponseText(text) {
  const original = text.trim();
  const sanitized = original.replace(/^\s*(?:sorry[,.]?\s*)?i\s+(?:missed|lost|didn'?t catch)\s+the\s+tool\s+call\.?\s*/i, "").replace(/\btool calls?\b/gi, "action").replace(/\bruntime evidence\b/gi, "result").replace(/\n{3,}/g, "\n\n").trim();
  return sanitized || original;
}
var VoiceChatTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`Voice chat timed out after ${timeoutMs}ms`);
    this.name = "VoiceChatTimeoutError";
  }
};
var PipelineSession = class _PipelineSession extends EventEmitter {
  sttFn;
  ttsFn;
  ttsStreamFn;
  chatFn;
  chatTimeoutMs;
  chatTimeoutResponse;
  audioBuffer = [];
  closed = false;
  processing = false;
  // Bumped by interrupt(); TTS paths capture it at turn start and stop
  // emitting once stale (grokterm "VOICE_GEN invalidate" pattern).
  ttsGeneration = 0;
  constructor(sttFn, ttsFn, ttsStreamFn, chatFn, chatTimeoutMs, chatTimeoutResponse) {
    super();
    this.sttFn = sttFn;
    this.ttsFn = ttsFn;
    this.ttsStreamFn = ttsStreamFn;
    this.chatFn = chatFn;
    this.chatTimeoutMs = Math.max(1, chatTimeoutMs);
    this.chatTimeoutResponse = chatTimeoutResponse;
  }
  static MAX_BUFFER_CHUNKS = 1e3;
  sendAudio(chunk) {
    if (this.closed) return;
    if (this.audioBuffer.length >= _PipelineSession.MAX_BUFFER_CHUNKS) {
      this.audioBuffer.shift();
    }
    this.audioBuffer.push(chunk);
  }
  commitAudio() {
    if (this.closed) return;
    if (this.processing) return;
    const fullAudio = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.processing = true;
    void this.processAudio(fullAudio).finally(() => {
      this.processing = false;
    });
  }
  interrupt() {
    if (this.closed) return;
    this.ttsGeneration++;
    this.audioBuffer = [];
  }
  announce(text) {
    if (this.closed || this.processing || !text.trim()) return false;
    this.processing = true;
    void (async () => {
      try {
        this.emit("agent_event", { type: "response", content: text });
        await this.speakResponse(text);
        if (!this.closed) this.emit("done");
      } catch (err) {
        if (!this.closed) this.emit("error", err instanceof Error ? err.message : String(err));
      } finally {
        this.processing = false;
      }
    })();
    return true;
  }
  close() {
    this.closed = true;
    this.audioBuffer = [];
    this.removeAllListeners();
  }
  async processAudio(audio) {
    try {
      let sumSquares = 0;
      let peak = 0;
      let samples = 0;
      for (let off = 0; off + 1 < audio.byteLength; off += 2) {
        const v = audio.readInt16LE(off) / 32768;
        sumSquares += v * v;
        peak = Math.max(peak, Math.abs(v));
        samples++;
      }
      const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
      if (audio.byteLength >= MIN_SHORT_SPEECH_AUDIO_BYTES && peak < SILENT_CAPTURE_PEAK) {
        logVoicePathMetric("stt_silent_capture", {
          scope: "server",
          bytes: audio.byteLength
        });
        console.warn(
          `[voice] silent capture: ${audio.byteLength} bytes, rms=${rms.toFixed(5)}, peak=${peak.toFixed(5)} \u2014 microphone is delivering digital silence`
        );
        this.emit("agent_event", { type: "response", content: SILENT_MIC_RESPONSE });
        await this.speakResponse(SILENT_MIC_RESPONSE);
        if (!this.closed) this.emit("done");
        return;
      }
      if (!hasSpeechLikeSignal(audio)) {
        this.emit("agent_event", {
          type: "response",
          content: NO_SPEECH_RESPONSE
        });
        await this.speakResponse(NO_SPEECH_RESPONSE);
        if (!this.closed) this.emit("done");
        return;
      }
      const sttStartedAt = Date.now();
      logVoicePathMetric("stt_start", {
        scope: "server",
        bytes: audio.byteLength
      });
      const text = await this.sttFn(audio);
      logVoicePathMetric("stt_end", {
        scope: "server",
        durationMs: Date.now() - sttStartedAt,
        transcriptChars: text.trim().length
      });
      this.emit("transcript", text, true);
      const responseText = await this.collectChatResponse(text);
      await this.speakResponse(responseText);
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
  async speakResponse(responseText) {
    if (!responseText || this.closed) return;
    const gen = this.ttsGeneration;
    if (this.ttsStreamFn) {
      const streamed = await this.streamTtsToAudio(responseText, gen);
      if (!streamed && !this.closed && gen === this.ttsGeneration) {
        const audioOut = await this.ttsFn(responseText);
        if (!this.closed && gen === this.ttsGeneration) this.emit("audio", audioOut);
      }
    } else {
      const audioOut = await this.ttsFn(responseText);
      if (!this.closed && gen === this.ttsGeneration) this.emit("audio", audioOut);
    }
  }
  async streamTtsToAudio(text, gen) {
    if (!this.ttsStreamFn) return false;
    let stream;
    try {
      stream = await this.ttsStreamFn(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline-voice] streaming TTS unavailable (${message}); using blocking ttsFn`);
      return false;
    }
    const reader = stream.getReader();
    let emitted = 0;
    const ttsStartedAt = Date.now();
    try {
      while (!this.closed && gen === this.ttsGeneration) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.ttsGeneration) break;
        if (value && value.byteLength > 0) {
          if (emitted === 0) {
            logVoicePathMetric("tts_first_byte", {
              scope: "server",
              durationMs: Date.now() - ttsStartedAt,
              bytes: value.byteLength,
              source: "pipeline_stream"
            });
          }
          this.emit("audio", Buffer.from(value));
          emitted++;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await reader.cancel(err);
      } catch (cancelErr) {
        console.debug(
          `[pipeline-voice] reader.cancel during error teardown failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
        );
      }
      if (emitted > 0) {
        console.warn(
          `[pipeline-voice] streaming TTS read failed after partial audio (${message}); ending voice turn with error`
        );
        throw err;
      }
      console.warn(`[pipeline-voice] streaming TTS read failed (${message}); using blocking ttsFn`);
      return false;
    }
    try {
      await reader.cancel();
    } catch (cancelErr) {
      console.debug(
        `[pipeline-voice] reader.cancel on completion failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
      );
    }
    return emitted > 0;
  }
  async collectChatResponse(text) {
    const iterator = this.chatFn(text)[Symbol.asyncIterator]();
    const startedAt = Date.now();
    let responseText = "";
    let streamedText = "";
    try {
      while (!this.closed) {
        const remainingMs = this.chatTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          throw new VoiceChatTimeoutError(this.chatTimeoutMs);
        }
        const result = await this.nextChatEvent(iterator, remainingMs);
        if (result.done) break;
        const event = result.value;
        if (event.type === "text-delta") {
          this.emit("agent_event", event);
          streamedText += event.content;
        } else if (event.type === "response") {
          const content = sanitizeVoiceResponseText(event.content);
          this.emit("agent_event", { ...event, content });
          responseText += content;
        } else if (event.type === "error") {
          this.emit("agent_event", event);
          throw new Error(event.error);
        } else {
          this.emit("agent_event", event);
        }
      }
    } catch (err) {
      this.stopChatIterator(iterator);
      if (err instanceof VoiceChatTimeoutError) {
        this.emit("agent_event", {
          type: "error",
          error: err.message,
          errorClass: "recoverable"
        });
        return (responseText || streamedText || this.chatTimeoutResponse).trim();
      }
      throw err;
    }
    return (responseText || streamedText).trim();
  }
  async nextChatEvent(iterator, timeoutMs) {
    let timeout;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new VoiceChatTimeoutError(this.chatTimeoutMs)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  stopChatIterator(iterator) {
    void iterator.return(void 0).catch(() => void 0);
  }
};
var PipelineVoice = class {
  name = "pipeline";
  sttFn;
  ttsFn;
  ttsStreamFn;
  chatTimeoutMs;
  chatTimeoutResponse;
  constructor(config) {
    this.sttFn = config.sttFn;
    this.ttsFn = config.ttsFn;
    this.ttsStreamFn = config.ttsStreamFn;
    this.chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    this.chatTimeoutResponse = config.chatTimeoutResponse ?? DEFAULT_CHAT_TIMEOUT_RESPONSE;
  }
  isAvailable() {
    return true;
  }
  async connect(config) {
    const chatFn = config.chatFn || async function* () {
      yield {
        type: "error",
        error: "No chat function configured"
      };
    };
    return new PipelineSession(
      this.sttFn,
      this.ttsFn,
      this.ttsStreamFn,
      chatFn,
      this.chatTimeoutMs,
      this.chatTimeoutResponse
    );
  }
};

export {
  PipelineVoice
};
