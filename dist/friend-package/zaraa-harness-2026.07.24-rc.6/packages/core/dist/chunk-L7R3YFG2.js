// src/voice/mlx-audio-local-tts.ts
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";
var DEFAULT_BASE_URL = "http://127.0.0.1:8769/v1";
var DEFAULT_MODEL = "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit";
var DEFAULT_VOICE = "casual_female";
var DEFAULT_LANG_CODE = "en";
function buildSpeechRequest(config, text, stream, signal) {
  const basePayload = {
    model: config.model || DEFAULT_MODEL,
    input: text,
    voice: config.voice || DEFAULT_VOICE,
    speed: config.speed ?? 1,
    lang_code: config.langCode || DEFAULT_LANG_CODE,
    response_format: "pcm",
    verbose: false
  };
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      stream ? {
        ...basePayload,
        stream: true,
        streaming_interval: config.streamingInterval ?? 0.35
      } : basePayload
    ),
    signal: signal ?? AbortSignal.timeout(12e4)
  };
}
function createMLXAudioLocalTts(config = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  return async (text) => {
    const res = await fetch(`${baseUrl}/audio/speech`, buildSpeechRequest(config, text, false));
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`MLX Audio TTS failed (${res.status}): ${errText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };
}
function postPcmStream(url, bodyJson, timeoutMs) {
  const u = new URL(url);
  const requestFn = u.protocol === "https:" ? httpsRequest : httpRequest;
  const port = u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyJson).toString()
        }
      },
      (res) => {
        req.setTimeout(0);
        resolve({ statusCode: res.statusCode ?? 0, res });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`MLX Audio TTS request timed out after ${timeoutMs}ms`));
    });
    req.write(bodyJson);
    req.end();
  });
}
function toUint8Array(chunk) {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
function incomingMessageToPcmStream(res, firstChunk) {
  let cleanup = () => {
  };
  return new ReadableStream({
    start(controller) {
      const onData = (chunk) => {
        try {
          controller.enqueue(toUint8Array(chunk));
        } catch (err) {
          cleanup();
          res.destroy(err instanceof Error ? err : void 0);
        }
      };
      const onEnd = () => {
        cleanup();
        try {
          controller.close();
        } catch {
        }
      };
      const onError = (err) => {
        cleanup();
        try {
          controller.error(err);
        } catch {
        }
      };
      const onAborted = () => {
        onError(new Error("MLX Audio TTS stream aborted"));
      };
      cleanup = () => {
        res.off("data", onData);
        res.off("end", onEnd);
        res.off("error", onError);
        res.off("aborted", onAborted);
      };
      controller.enqueue(toUint8Array(firstChunk));
      res.on("data", onData);
      res.once("end", onEnd);
      res.once("error", onError);
      res.once("aborted", onAborted);
      res.resume();
    },
    cancel() {
      cleanup();
      res.destroy();
    }
  });
}
function resolvePcmStreamAfterFirstChunk(res, firstChunkTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`MLX Audio TTS first chunk timed out after ${firstChunkTimeoutMs}ms`));
      res.destroy(new Error(`MLX Audio TTS first chunk timed out after ${firstChunkTimeoutMs}ms`));
    }, firstChunkTimeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      res.off("data", onFirstData);
      res.off("end", onEndBeforeAudio);
      res.off("error", onErrorBeforeAudio);
      res.off("aborted", onAbortedBeforeAudio);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onFirstData = (chunk) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.pause();
      resolve(incomingMessageToPcmStream(res, Buffer.from(chunk)));
    };
    const onEndBeforeAudio = () => {
      fail(new Error("MLX Audio TTS stream ended before audio"));
    };
    const onErrorBeforeAudio = (err) => {
      fail(err);
    };
    const onAbortedBeforeAudio = () => {
      fail(new Error("MLX Audio TTS stream aborted before audio"));
    };
    res.once("data", onFirstData);
    res.once("end", onEndBeforeAudio);
    res.once("error", onErrorBeforeAudio);
    res.once("aborted", onAbortedBeforeAudio);
  });
}
function createMLXAudioLocalTtsStream(config = {}) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  return async (text) => {
    const firstChunkTimeoutMs = Math.max(1, config.firstChunkTimeoutMs ?? 25e3);
    const basePayload = {
      model: config.model || DEFAULT_MODEL,
      input: text,
      voice: config.voice || DEFAULT_VOICE,
      speed: config.speed ?? 1,
      lang_code: config.langCode || DEFAULT_LANG_CODE,
      response_format: "pcm",
      verbose: false,
      stream: true,
      streaming_interval: config.streamingInterval ?? 0.35
    };
    const bodyJson = JSON.stringify(basePayload);
    const postStream = config.postPcmStream ?? postPcmStream;
    const { statusCode, res } = await postStream(
      `${baseUrl}/audio/speech`,
      bodyJson,
      firstChunkTimeoutMs
    );
    if (statusCode < 200 || statusCode >= 300) {
      const errText = await new Promise((resolve) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve("Unknown error"));
      });
      throw new Error(`MLX Audio TTS failed (${statusCode}): ${errText}`);
    }
    return resolvePcmStreamAfterFirstChunk(res, firstChunkTimeoutMs);
  };
}

export {
  createMLXAudioLocalTts,
  createMLXAudioLocalTtsStream
};
