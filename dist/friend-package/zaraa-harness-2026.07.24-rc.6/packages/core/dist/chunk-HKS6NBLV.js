// src/voice/macos-say-tts.ts
import { execFile } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
function extractPcmFromWav(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("macOS say TTS: output is not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkSize;
    if (bodyEnd > wav.length) {
      throw new Error("macOS say TTS: truncated WAV chunk");
    }
    if (chunkId === "data") {
      return wav.subarray(bodyStart, bodyEnd);
    }
    offset = bodyEnd + (chunkSize & 1);
  }
  throw new Error("macOS say TTS: WAV missing data chunk");
}
function createMacOSSayTts(config = {}) {
  return async (text) => {
    const tmpFile = join(tmpdir(), `zaraa-tts-${Date.now()}.wav`);
    try {
      await new Promise((resolve, reject) => {
        const args = ["-o", tmpFile, "--file-format=WAVE", "--data-format=LEI16@24000"];
        if (config.voice) args.push("-v", config.voice);
        if (config.rate) args.push("-r", String(config.rate));
        args.push(text);
        const timeoutMs = typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 12e3;
        execFile("say", args, { timeout: timeoutMs }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const wavData = readFileSync(tmpFile);
      return extractPcmFromWav(wavData);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
      }
    }
  };
}

export {
  extractPcmFromWav,
  createMacOSSayTts
};
