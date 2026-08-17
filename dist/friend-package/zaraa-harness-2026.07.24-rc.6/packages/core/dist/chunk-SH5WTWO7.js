// src/voice/whisperflow-tools.ts
var manifest = {
  name: "whisperflow",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["voice.transcribe"],
  tools: [
    {
      name: "voice_transcribe",
      description: "Transcribe an audio file to text using the local WhisperFlow (Whisper) server. Supports wav, mp3, webm, mp4, m4a, ogg, flac formats.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the audio file to transcribe"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "voice_status",
      description: "Check the status of the local WhisperFlow voice transcription server.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  ],
  trust: "core"
};
function createHandlers(client) {
  return {
    voice_transcribe: async (args) => {
      const path = args.path;
      if (!path) throw new Error("path is required");
      const result = await client.transcribeFile(path);
      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        segmentCount: result.segments.length
      };
    },
    voice_status: async () => {
      const status = await client.getStatus();
      return status;
    }
  };
}

export {
  manifest,
  createHandlers
};
