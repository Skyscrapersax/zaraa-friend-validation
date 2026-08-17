import {
  prependWavHeader
} from "./chunk-CLV7MUPM.js";

// src/voice/openai-stt.ts
function resolveOpenAISttConfig({
  model,
  providers = [],
  embedding,
  env = process.env
}) {
  const openaiProvider = providers.find((provider) => provider.type === "openai");
  const envVar = openaiProvider?.envVar || "OPENAI_API_KEY";
  const openAIEmbedding = embedding?.provider === "openai" ? embedding : void 0;
  const providerOrEnvKey = openaiProvider?.apiKey || env[envVar] || env.OPENAI_API_KEY;
  const embeddingApiKey = isLikelyOpenAIApiKey(openAIEmbedding?.apiKey) ? openAIEmbedding?.apiKey : void 0;
  const apiKey = providerOrEnvKey || embeddingApiKey;
  const embeddingBaseUrl = !providerOrEnvKey ? resolveEmbeddingTranscriptionBaseUrl(openAIEmbedding?.baseUrl) : void 0;
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    baseUrl: openaiProvider?.baseUrl || embeddingBaseUrl,
    model
  };
}
function isLikelyOpenAIApiKey(apiKey) {
  return Boolean(apiKey?.startsWith("sk-"));
}
function resolveEmbeddingTranscriptionBaseUrl(baseUrl) {
  if (!baseUrl) {
    return void 0;
  }
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:" && parsed.hostname === "api.openai.com" ? baseUrl : void 0;
  } catch {
    return void 0;
  }
}
function resolveTranscriptionsUrl(baseUrl) {
  const trimmed = (baseUrl || "https://api.openai.com").replace(/\/$/, "");
  const apiRoot = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  return `${apiRoot}/audio/transcriptions`;
}
function isWavAudio(audio) {
  return audio.byteLength >= 12 && audio.subarray(0, 4).toString("ascii") === "RIFF" && audio.subarray(8, 12).toString("ascii") === "WAVE";
}
function createOpenAIStt(config) {
  const transcriptionsUrl = resolveTranscriptionsUrl(config.baseUrl);
  return async (audio) => {
    const formData = new FormData();
    const wavAudio = isWavAudio(audio) ? audio : prependWavHeader(audio);
    const arrayBuffer = wavAudio.buffer.slice(
      wavAudio.byteOffset,
      wavAudio.byteOffset + wavAudio.byteLength
    );
    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", config.model || "whisper-1");
    formData.append("response_format", "json");
    const response = await fetch(transcriptionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(config.timeoutMs ?? 6e4)
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenAI STT failed (${response.status}): ${errorText}`);
    }
    const data = await response.json();
    return typeof data.text === "string" ? data.text : "";
  };
}
var REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";
function extractPcm(audio) {
  if (!isWavAudio(audio)) return audio;
  let off = 12;
  while (off + 8 <= audio.length) {
    const id = audio.toString("ascii", off, off + 4);
    const size = audio.readUInt32LE(off + 4);
    if (id === "data") return audio.subarray(off + 8, off + 8 + size);
    off += 8 + size + size % 2;
  }
  return audio;
}
function createRealtimeStt(deps) {
  const model = deps.model || "gpt-4o-transcribe";
  const timeoutMs = deps.timeoutMs ?? 3e4;
  const openSocket = deps.openSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  return (audio) => new Promise((resolve, reject) => {
    const pcm = extractPcm(audio);
    let settled = false;
    let transcript = "";
    let socket = null;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
      }
    };
    const succeed = (text) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    deps.mintSecret({ type: "transcription", audio: { input: { transcription: { model } } } }).then((secret) => {
      if (settled) return;
      timer = setTimeout(
        () => fail(new Error(`Realtime STT timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      socket = openSocket(REALTIME_WS_URL, [
        "realtime",
        `openai-insecure-api-key.${secret.value}`
      ]);
      socket.onopen = () => {
        socket?.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm.toString("base64")
          })
        );
        socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      };
      socket.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const type = msg.type || "";
        if (type === "error") {
          fail(new Error(msg.error?.message || "Realtime STT error"));
          return;
        }
        if (type.includes("input_audio_transcription")) {
          if (type.endsWith(".delta")) {
            transcript += msg.delta || "";
          } else if (type.endsWith(".completed")) {
            succeed(msg.transcript ?? transcript);
          } else if (type.endsWith(".failed")) {
            fail(
              new Error(
                msg.error?.message || "Realtime STT transcription failed"
              )
            );
          }
        }
      };
      socket.onerror = () => fail(new Error("Realtime STT socket error"));
      socket.onclose = () => fail(new Error("Realtime STT socket closed before transcription"));
    }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

export {
  resolveOpenAISttConfig,
  createOpenAIStt,
  createRealtimeStt
};
