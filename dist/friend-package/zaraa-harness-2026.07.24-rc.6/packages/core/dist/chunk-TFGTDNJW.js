import {
  formatVoiceEngineProfile,
  resolveVoiceEngineProfile
} from "./chunk-7BA45WXK.js";

// src/voice/voice-readiness-smoke.ts
var DEFAULT_SMOKE_PHRASE = "Voice readiness smoke.";
var DEFAULT_FIRST_BYTE_TIMEOUT_MS = 8e3;
async function measureTtsFirstByteMs(streamTts, options) {
  const phrase = options?.phrase ?? DEFAULT_SMOKE_PHRASE;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const startedAt = Date.now();
  let reader = null;
  let timeout;
  try {
    const measured = await Promise.race([
      (async () => {
        const stream = await streamTts(phrase);
        reader = stream.getReader();
        const first = await reader.read();
        const bytes = first.value?.byteLength ?? 0;
        if (first.done || bytes <= 0) {
          return {
            latencyMs: null,
            bytes: 0,
            error: "TTS stream returned no audio before close"
          };
        }
        return {
          latencyMs: Math.max(0, Date.now() - startedAt),
          bytes,
          error: null
        };
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`TTS first-byte timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
    return measured;
  } catch (err) {
    return {
      latencyMs: null,
      bytes: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await reader?.cancel();
    } catch (cancelErr) {
      console.debug(
        `[voice-readiness-smoke] reader cancel failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`
      );
    }
  }
}
async function runVoiceReadinessSmoke(input) {
  const profile = resolveVoiceEngineProfile(input.config);
  const profileSummary = formatVoiceEngineProfile(profile);
  if (!input.streamTtsPcm) {
    return {
      profile,
      profileSummary,
      openaiApiKeyConfigured: profile.openaiApiKeyConfigured,
      ttsFirstByteMs: null,
      ttsFirstByteOk: false,
      error: "streamTtsPcm not configured"
    };
  }
  const measured = await measureTtsFirstByteMs(input.streamTtsPcm, {
    phrase: input.phrase,
    timeoutMs: input.timeoutMs
  });
  return {
    profile,
    profileSummary,
    openaiApiKeyConfigured: profile.openaiApiKeyConfigured,
    ttsFirstByteMs: measured.latencyMs,
    ttsFirstByteOk: measured.latencyMs != null && measured.bytes > 0,
    error: measured.error
  };
}

export {
  measureTtsFirstByteMs,
  runVoiceReadinessSmoke
};
