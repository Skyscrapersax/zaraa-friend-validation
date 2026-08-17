// src/voice/whisperflow-client.ts
var WhisperFlowClient = class {
  baseUrl;
  timeout;
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || "http://localhost:8765").replace(/\/$/, "");
    this.timeout = config.timeout ?? 6e4;
  }
  /**
   * Check if the WhisperFlow server is available and ready.
   */
  async getStatus() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5e3);
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        signal: controller.signal
      });
      if (!response.ok) {
        return { status: "unavailable" };
      }
      const data = await response.json();
      return {
        status: data.status === "ready" ? "ready" : "loading",
        model: data.model,
        device: data.device
      };
    } catch {
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Check if the server is available.
   */
  async isAvailable() {
    const status = await this.getStatus();
    return status.status === "ready";
  }
  /**
   * Transcribe an audio file by path.
   */
  async transcribeFile(filePath) {
    const { readFileSync } = await import("fs");
    const { basename, extname } = await import("path");
    const audioBytes = readFileSync(filePath);
    const fileName = basename(filePath);
    const format = extname(filePath).slice(1) || "wav";
    return this.transcribeBuffer(audioBytes, fileName, format);
  }
  /**
   * Transcribe audio from a Buffer/Uint8Array.
   */
  async transcribeBuffer(audio, fileName = "audio.wav", format = "wav") {
    const formData = new FormData();
    const arrayBuffer = audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength
    );
    const blob = new Blob([arrayBuffer], { type: `audio/${format}` });
    formData.append("file", blob, fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}/transcribe`, {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`Transcription failed (${response.status}): ${errorText}`);
      }
      const data = await response.json();
      return {
        text: data.text || "",
        language: data.language || "en",
        segments: Array.isArray(data.segments) ? data.segments : [],
        duration: data.duration || 0
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Transcription timed out after ${this.timeout}ms`);
      }
      throw err;
    }
  }
};

export {
  WhisperFlowClient
};
