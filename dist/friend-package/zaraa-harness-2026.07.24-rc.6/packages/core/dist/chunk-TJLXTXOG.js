// src/voice/voxtral-local-tts.ts
var DEFAULT_BASE_URL = "http://127.0.0.1:8769";
var DEFAULT_VOICE = "casual_female";
function createVoxtralLocalTts(config = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const voice = config.voice || DEFAULT_VOICE;
  return async (text) => {
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(12e4)
      // 2 min timeout for long text
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Voxtral Local TTS failed (${res.status}): ${errText}`);
    }
    const wavBytes = Buffer.from(await res.arrayBuffer());
    if (wavBytes.length < 44 || wavBytes.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("Voxtral Local TTS: response is not a valid WAV file");
    }
    return pcmFromWav(wavBytes);
  };
}
function createVoxtralLocalTtsWav(config = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const voice = config.voice || DEFAULT_VOICE;
  return async (text) => {
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(12e4)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Voxtral Local TTS failed (${res.status}): ${errText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  };
}
function createVoxtralLocalTtsStream(config = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const voice = config.voice || DEFAULT_VOICE;
  return async (text) => {
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(12e4)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Voxtral Local TTS failed (${res.status}): ${errText}`);
    }
    if (!res.body) {
      throw new Error("Voxtral Local TTS failed: response body stream is missing");
    }
    return wavBodyToPcmStream(res.body);
  };
}
function pcmFromWav(wav) {
  let offset = 12;
  let dataStart = 0;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    offset = bodyStart + chunkSize + (chunkSize & 1);
    if (chunkId === "data") {
      dataStart = bodyStart;
      dataSize = chunkSize;
      break;
    }
  }
  if (!dataStart || !dataSize) {
    throw new Error("Voxtral Local TTS: WAV missing data chunk");
  }
  return wav.subarray(dataStart, dataStart + dataSize);
}
function wavBodyToPcmStream(body) {
  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      let headerParsed = false;
      let pending = Buffer.alloc(0);
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          if (!headerParsed) {
            pending = Buffer.concat([pending, Buffer.from(value)]);
            const dataStart = findWavDataChunkStart(pending);
            if (dataStart === null) {
              continue;
            }
            headerParsed = true;
            if (pending.length > dataStart) {
              controller.enqueue(new Uint8Array(pending.subarray(dataStart)));
            }
            pending = Buffer.alloc(0);
            continue;
          }
          controller.enqueue(value);
        }
        if (!headerParsed) {
          throw new Error("Voxtral Local TTS: WAV missing data chunk");
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    }
  });
}
function findWavDataChunkStart(wav) {
  if (wav.length < 12) {
    return null;
  }
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Voxtral Local TTS: response is not a valid WAV file");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const nextOffset = bodyStart + chunkSize + (chunkSize & 1);
    if (chunkId === "data") {
      return bodyStart;
    }
    if (nextOffset > wav.length) {
      return null;
    }
    offset = nextOffset;
  }
  return null;
}

export {
  createVoxtralLocalTts,
  createVoxtralLocalTtsWav,
  createVoxtralLocalTtsStream
};
