import {
  normalizeXaiApiOrigin
} from "./chunk-R3OHGVQC.js";
import {
  prependWavHeader
} from "./chunk-CLV7MUPM.js";

// src/voice/xai-stt.ts
function isWavAudio(audio) {
  return audio.byteLength >= 12 && audio.subarray(0, 4).toString("ascii") === "RIFF" && audio.subarray(8, 12).toString("ascii") === "WAVE";
}
function resolveSttUrl(baseUrl) {
  const origin = normalizeXaiApiOrigin(baseUrl);
  return `${origin}/v1/stt`;
}
function createXaiStt(config) {
  const sttUrl = resolveSttUrl(config.baseUrl);
  return async (audio) => {
    const resolvedApiKey = config.apiKeyProvider ? await config.apiKeyProvider() : config.apiKey;
    const apiKey = resolvedApiKey?.trim() ?? "";
    if (!apiKey) throw new Error("xAI STT credential unavailable");
    const formData = new FormData();
    const wavAudio = isWavAudio(audio) ? audio : prependWavHeader(audio);
    const arrayBuffer = wavAudio.buffer.slice(
      wavAudio.byteOffset,
      wavAudio.byteOffset + wavAudio.byteLength
    );
    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    if (config.language?.trim()) {
      formData.append("language", config.language.trim());
    }
    const response = await fetch(sttUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(config.timeoutMs ?? 6e4)
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`xAI STT failed (${response.status}): ${errorText}`);
    }
    const data = await response.json();
    return typeof data.text === "string" ? data.text : "";
  };
}

export {
  createXaiStt
};
