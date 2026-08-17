import {
  normalizeXaiApiOrigin
} from "./chunk-R3OHGVQC.js";

// src/voice/xai-tts.ts
var DEFAULT_VOICE = "eve";
var DEFAULT_LANGUAGE = "en";
var DEFAULT_SAMPLE_RATE = 24e3;
function clampSpeed(speed) {
  if (speed == null || Number.isNaN(speed)) return void 0;
  return Math.min(1.5, Math.max(0.7, speed));
}
function buildXaiTtsBody(config, text) {
  const body = {
    text,
    voice_id: config.voice?.trim() || DEFAULT_VOICE,
    language: config.language?.trim() || DEFAULT_LANGUAGE,
    output_format: {
      codec: "pcm",
      sample_rate: DEFAULT_SAMPLE_RATE
    }
  };
  const speed = clampSpeed(config.speed);
  if (speed != null) {
    body.speed = speed;
  }
  return body;
}
function buildXaiTtsRequest(config, text, apiKey) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildXaiTtsBody(config, text)),
    signal: AbortSignal.timeout(config.timeoutMs ?? 3e4)
  };
}
function resolveTtsUrl(baseUrl) {
  const origin = normalizeXaiApiOrigin(baseUrl);
  return `${origin}/v1/tts`;
}
function createXaiTts(config) {
  const url = resolveTtsUrl(config.baseUrl);
  return async (text) => {
    const providedKey = config.apiKeyProvider ? await config.apiKeyProvider() : void 0;
    const apiKey = (providedKey ?? config.apiKey)?.trim() ?? "";
    if (!apiKey) throw new Error("xAI TTS credential unavailable");
    const res = await fetch(url, buildXaiTtsRequest(config, text, apiKey));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`xAI TTS failed (${res.status}): ${errText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };
}
function createXaiTtsStream(config) {
  const url = resolveTtsUrl(config.baseUrl);
  return async (text) => {
    const providedKey = config.apiKeyProvider ? await config.apiKeyProvider() : void 0;
    const apiKey = (providedKey ?? config.apiKey)?.trim() ?? "";
    if (!apiKey) throw new Error("xAI TTS credential unavailable");
    const res = await fetch(url, buildXaiTtsRequest(config, text, apiKey));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`xAI TTS failed (${res.status}): ${errText}`);
    }
    if (!res.body) {
      throw new Error("xAI TTS failed: response body stream is missing");
    }
    return res.body;
  };
}

export {
  createXaiTts,
  createXaiTtsStream
};
