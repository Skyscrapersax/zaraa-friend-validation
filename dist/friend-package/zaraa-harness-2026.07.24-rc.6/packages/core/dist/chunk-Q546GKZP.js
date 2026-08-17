// src/voice/elevenlabs-tts.ts
var ZARAA_VOICE_DEFAULTS = {
  // "Rachel" — warm, feminine, clear. Good base for multilingual model accent shaping.
  // Can be overridden with a custom cloned voice for authentic Egyptian accent.
  voiceId: "21m00Tcm4TlvDq8ikWAM",
  model: "eleven_multilingual_v2",
  stability: 0.55,
  similarityBoost: 0.78,
  style: 0.35,
  useSpeakerBoost: true,
  speed: 0.92
};
var BASE_URL = "https://api.elevenlabs.io";
function createElevenLabsTts(config) {
  const voiceId = config.voiceId || ZARAA_VOICE_DEFAULTS.voiceId;
  const model = config.model || ZARAA_VOICE_DEFAULTS.model;
  const stability = config.stability ?? ZARAA_VOICE_DEFAULTS.stability;
  const similarityBoost = config.similarityBoost ?? ZARAA_VOICE_DEFAULTS.similarityBoost;
  const style = config.style ?? ZARAA_VOICE_DEFAULTS.style;
  const useSpeakerBoost = config.useSpeakerBoost ?? ZARAA_VOICE_DEFAULTS.useSpeakerBoost;
  return async (text) => {
    const res = await fetch(
      `${BASE_URL}/v1/text-to-speech/${voiceId}?output_format=pcm_24000`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            style,
            use_speaker_boost: useSpeakerBoost
          }
        }),
        signal: AbortSignal.timeout(3e4)
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };
}
async function listElevenLabsVoices(apiKey) {
  const res = await fetch(`${BASE_URL}/v1/voices`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs voices list failed (${res.status})`);
  }
  const data = await res.json();
  return data.voices;
}
async function designVoice(apiKey, description, name = "Zaraa") {
  const previewRes = await fetch(`${BASE_URL}/v1/text-to-voice/create-previews`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      voice_description: description,
      text: "Welcome. I am here to help you with whatever you need. My name is Zaraa."
    }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!previewRes.ok) {
    const errText = await previewRes.text().catch(() => "Unknown");
    throw new Error(`Voice design preview failed (${previewRes.status}): ${errText}`);
  }
  const previewData = await previewRes.json();
  if (!previewData.previews?.length) {
    throw new Error("No voice previews generated");
  }
  const preview = previewData.previews[0];
  const saveRes = await fetch(`${BASE_URL}/v1/text-to-voice/create-voice-from-preview`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      voice_name: name,
      voice_description: description,
      generated_voice_id: preview.generated_voice_id
    }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!saveRes.ok) {
    const errText = await saveRes.text().catch(() => "Unknown");
    throw new Error(`Voice save failed (${saveRes.status}): ${errText}`);
  }
  const saveData = await saveRes.json();
  return {
    voiceId: saveData.voice_id,
    previewUrl: preview.audio_base_url
  };
}

export {
  createElevenLabsTts,
  listElevenLabsVoices,
  designVoice
};
