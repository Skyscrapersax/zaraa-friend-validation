// src/voice/voxtral-tts.ts
async function createMistralVoice(config) {
  const baseUrl = (config.baseUrl || "https://api.mistral.ai").replace(/\/$/, "");
  const body = {
    name: config.name,
    sample_audio: config.sampleAudio
  };
  if (config.sampleFilename) body.sample_filename = config.sampleFilename;
  if (config.languages) body.languages = config.languages;
  if (config.gender) body.gender = config.gender;
  if (config.age) body.age = config.age;
  if (config.tags) body.tags = config.tags;
  const res = await fetch(`${baseUrl}/v1/audio/voices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3e4)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Mistral voice creation failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    languages: data.languages,
    gender: data.gender,
    createdAt: data.created_at
  };
}
async function listMistralVoices(apiKey, baseUrl) {
  const base = (baseUrl || "https://api.mistral.ai").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/audio/voices`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Mistral list voices failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return (data.data || []).map((v) => ({
    id: v.id,
    name: v.name,
    languages: v.languages,
    gender: v.gender,
    createdAt: v.created_at
  }));
}
var DEFAULT_MODEL = "voxtral-mini-tts-2603";
function pcmFromMistralWav(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Voxtral TTS: response is not a RIFF/WAVE audio buffer");
  }
  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = 0;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    offset = bodyStart + chunkSize + (chunkSize & 1);
    if (chunkId === "fmt ") {
      audioFormat = wav.readUInt16LE(bodyStart);
      numChannels = wav.readUInt16LE(bodyStart + 2);
      sampleRate = wav.readUInt32LE(bodyStart + 4);
      bitsPerSample = wav.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataSize = chunkSize;
      break;
    }
  }
  if (!dataStart || !dataSize) {
    throw new Error("Voxtral TTS: WAV missing data chunk");
  }
  let body = wav.subarray(dataStart, dataStart + dataSize);
  if (audioFormat === 3 && bitsPerSample === 32) {
    const bytesPerFrame = 4 * numChannels;
    const frames = Math.floor(body.length / bytesPerFrame);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        sum += body.readFloatLE(i * bytesPerFrame + c * 4);
      }
      const f = Math.max(-1, Math.min(1, sum / numChannels));
      out.writeInt16LE(Math.round(f * 32767), i * 2);
    }
    body = out;
    numChannels = 1;
    bitsPerSample = 16;
    audioFormat = 1;
  }
  if (audioFormat !== 1) {
    throw new Error(`Voxtral TTS: unsupported WAV format (audioFormat=${audioFormat})`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Voxtral TTS: expected 16-bit PCM in WAV, got ${bitsPerSample}-bit`);
  }
  if (numChannels === 2) {
    const samples = Math.floor(body.length / 4);
    const out = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const l = body.readInt16LE(i * 4);
      const r = body.readInt16LE(i * 4 + 2);
      out.writeInt16LE(Math.round((l + r) / 2), i * 2);
    }
    body = out;
    numChannels = 1;
  }
  if (numChannels !== 1) {
    throw new Error(`Voxtral TTS: expected mono or stereo WAV, got ${numChannels} channels`);
  }
  if (sampleRate !== 24e3) {
    body = resampleS16Linear(body, sampleRate, 24e3);
  }
  return body;
}
function resampleS16Linear(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length / 2;
  const outSamples = Math.max(1, Math.round(inSamples * (toRate / fromRate)));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * fromRate / toRate;
    const i0 = Math.min(Math.floor(srcPos), inSamples - 1);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const t = srcPos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const s = Math.round(s0 + (s1 - s0) * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}
function createVoxtralTts(config) {
  const baseUrl = (config.baseUrl || "https://api.mistral.ai").replace(/\/$/, "");
  const model = config.model || DEFAULT_MODEL;
  const responseFormat = config.responseFormat || "wav";
  if (!config.voiceId && !config.refAudio) {
    throw new Error("VoxtralTtsConfig requires either voiceId (saved voice) or refAudio (one-off clone)");
  }
  return async (text) => {
    const body = {
      model,
      input: text,
      response_format: responseFormat
    };
    if (config.voiceId) body.voice_id = config.voiceId;
    if (config.refAudio) body.ref_audio = config.refAudio;
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6e4)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Voxtral TTS failed (${res.status}): ${errText}`);
    }
    const json = await res.json();
    if (!json.audio_data) {
      throw new Error("Voxtral TTS: missing audio_data in response");
    }
    const wavBytes = Buffer.from(json.audio_data, "base64");
    return pcmFromMistralWav(wavBytes);
  };
}

export {
  createMistralVoice,
  listMistralVoices,
  pcmFromMistralWav,
  createVoxtralTts
};
