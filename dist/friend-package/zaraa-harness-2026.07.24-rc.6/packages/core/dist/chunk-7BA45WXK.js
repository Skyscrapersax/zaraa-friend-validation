import {
  resolveOpenAISttConfig
} from "./chunk-GL7JOAJ2.js";

// src/voice/voice-engine-profile.ts
function resolveVoiceEngineProfile(input) {
  const voice = input.voice;
  const sttConfiguredEngine = voice?.stt?.engine?.trim() || "whisper";
  const ttsConfiguredEngine = voice?.tts?.engine?.trim() || "openai-tts";
  const openai = resolveOpenAISttConfig(input);
  let openaiApiKeySource = null;
  if (openai?.apiKey) {
    const env = input.env ?? process.env;
    const providers = input.providers ?? [];
    const openaiProvider = providers.find((provider) => provider.type === "openai");
    const envVar = openaiProvider?.envVar || "OPENAI_API_KEY";
    if (openaiProvider?.apiKey) {
      openaiApiKeySource = "provider";
    } else if (env[envVar] || env.OPENAI_API_KEY) {
      openaiApiKeySource = "env";
    } else {
      openaiApiKeySource = "embedding";
    }
  }
  return {
    voiceProvider: voice?.provider?.trim() || null,
    sttConfiguredEngine,
    ttsConfiguredEngine,
    openaiApiKeyConfigured: Boolean(openai?.apiKey),
    openaiApiKeySource
  };
}
function formatVoiceEngineProfile(profile) {
  return [
    `provider=${profile.voiceProvider ?? "none"}`,
    `stt=${profile.sttConfiguredEngine}`,
    `tts=${profile.ttsConfiguredEngine}`,
    `openaiKey=${profile.openaiApiKeyConfigured ? profile.openaiApiKeySource ?? "yes" : "no"}`
  ].join(", ");
}

export {
  resolveVoiceEngineProfile,
  formatVoiceEngineProfile
};
