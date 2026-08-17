// src/voice/openai-tts.ts
function buildOpenAITtsRequest(config, text) {
  const voice = config.voice || "alloy";
  const model = config.model || "tts-1";
  const speed = config.speed ?? 1;
  return {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "pcm",
      // raw 24kHz 16-bit mono PCM
      speed
    }),
    signal: AbortSignal.timeout(3e4)
  };
}
function createOpenAITts(config) {
  const baseUrl = (config.baseUrl || "https://api.openai.com").replace(/\/$/, "");
  return async (text) => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, buildOpenAITtsRequest(config, text));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`OpenAI TTS failed (${res.status}): ${errText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };
}
function createOpenAITtsStream(config) {
  const baseUrl = (config.baseUrl || "https://api.openai.com").replace(/\/$/, "");
  return async (text) => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, buildOpenAITtsRequest(config, text));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`OpenAI TTS failed (${res.status}): ${errText}`);
    }
    if (!res.body) {
      throw new Error("OpenAI TTS failed: response body stream is missing");
    }
    return res.body;
  };
}

export {
  createOpenAITts,
  createOpenAITtsStream
};
