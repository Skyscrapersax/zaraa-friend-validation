// src/voice/openai-realtime.ts
import { EventEmitter } from "events";
var REALTIME_URL = "wss://api.openai.com/v1/realtime";
var DEFAULT_MODEL = "gpt-realtime";
var REALTIME_VOICES = /* @__PURE__ */ new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "cedar",
  "marin"
]);
function normalizeRealtimeVoice(voice) {
  return voice && REALTIME_VOICES.has(voice) ? voice : "alloy";
}
var OpenAIRealtimeSession = class extends EventEmitter {
  ws;
  boundOnMessage;
  boundOnError;
  boundOnClose;
  constructor(ws) {
    super();
    this.ws = ws;
    this.boundOnMessage = () => {
    };
    this.boundOnError = () => {
    };
    this.boundOnClose = () => {
    };
    this.wireEvents();
  }
  sendAudio(chunk) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      })
    );
  }
  commitAudio() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }
  close() {
    this.ws.removeEventListener("message", this.boundOnMessage);
    this.ws.removeEventListener("error", this.boundOnError);
    this.ws.removeEventListener("close", this.boundOnClose);
    this.ws.close();
    this.removeAllListeners();
  }
  wireEvents() {
    this.boundOnMessage = (event) => {
      let data;
      try {
        data = JSON.parse(
          typeof event.data === "string" ? event.data : String(event.data)
        );
      } catch {
        return;
      }
      switch (data.type) {
        // GA event names (the beta response.audio* shape is disabled).
        case "response.output_audio_transcript.delta":
          this.emit("transcript", data.delta || "", false);
          break;
        case "response.output_audio_transcript.done":
          this.emit("transcript", data.transcript || "", true);
          break;
        case "response.output_audio.delta":
          if (data.delta) {
            this.emit(
              "audio",
              Buffer.from(data.delta, "base64")
            );
          }
          break;
        case "response.done":
          this.emit("done");
          break;
        case "error": {
          const err = data.error;
          this.emit(
            "error",
            err?.message || "Unknown Realtime API error"
          );
          break;
        }
      }
    };
    this.boundOnError = () => {
      this.emit("error", "WebSocket connection error");
    };
    this.boundOnClose = () => {
      this.emit("done");
    };
    this.ws.addEventListener("message", this.boundOnMessage);
    this.ws.addEventListener("error", this.boundOnError);
    this.ws.addEventListener("close", this.boundOnClose);
  }
};
var OpenAIRealtimeVoice = class {
  name = "openai-realtime";
  isAvailable() {
    return typeof WebSocket !== "undefined";
  }
  async connect(config) {
    const model = config.model || DEFAULT_MODEL;
    let credential = config.apiKey;
    if (config.mintSecret) {
      const secret = await config.mintSecret({ type: "realtime", model });
      credential = secret.value;
    }
    if (!credential) {
      throw new Error(
        "OpenAI Realtime requires either mintSecret (OAuth) or an apiKey"
      );
    }
    const url = config.mintSecret ? REALTIME_URL : `${REALTIME_URL}?model=${model}`;
    const ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${credential}`]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("OpenAI Realtime connection timeout"));
      }, 1e4);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24e3 },
                  turn_detection: { type: "server_vad" }
                },
                output: {
                  format: { type: "audio/pcm", rate: 24e3 },
                  voice: normalizeRealtimeVoice(config.voice)
                }
              }
            }
          })
        );
        resolve(new OpenAIRealtimeSession(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(
          new Error("Failed to connect to OpenAI Realtime API")
        );
      });
    });
  }
};

export {
  OpenAIRealtimeVoice
};
