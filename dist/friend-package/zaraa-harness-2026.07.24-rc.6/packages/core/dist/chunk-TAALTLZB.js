// src/messaging/voice-note-sender.ts
import { mkdir, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
var DEFAULT_MAX_WORDS = 170;
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "voice-note";
}
function trimWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}
function normalizeVoiceNoteScript(text, maxWords = DEFAULT_MAX_WORDS) {
  const flattened = text.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "").replace(/\|/g, " ").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!flattened) {
    throw new Error("Voice note text is empty after normalization");
  }
  return trimWords(flattened, maxWords);
}
var VoiceNoteSender = class {
  synthesizeWav;
  sender;
  tempDir;
  cleanupDelayMs;
  now;
  constructor(config) {
    this.synthesizeWav = config.synthesizeWav;
    this.sender = config.sender;
    this.tempDir = config.tempDir ?? join(tmpdir(), "zaraa-voice-notes");
    this.cleanupDelayMs = config.cleanupDelayMs ?? 10 * 60 * 1e3;
    this.now = config.now ?? (() => /* @__PURE__ */ new Date());
  }
  async send(input) {
    if (!input.recipient.trim()) {
      throw new Error("Voice note recipient is required");
    }
    const normalized = normalizeVoiceNoteScript(input.text);
    await mkdir(this.tempDir, { recursive: true });
    const timestamp = this.now().toISOString().replace(/[:.]/g, "-");
    const fileBase = slugify(input.title ?? input.id);
    const filePath = join(this.tempDir, `${fileBase}-${timestamp}.wav`);
    const wav = await this.synthesizeWav(normalized);
    await writeFile(filePath, wav);
    await this.sender.sendFile(input.recipient, filePath, input.service ?? "iMessage");
    this.scheduleCleanup(filePath);
    return {
      filePath,
      script: normalized
    };
  }
  scheduleCleanup(filePath) {
    const timer = setTimeout(() => {
      void unlink(filePath).catch((err) => {
        console.debug(
          `[voice-note-sender] temp cleanup failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, this.cleanupDelayMs);
    timer.unref?.();
  }
};

export {
  normalizeVoiceNoteScript,
  VoiceNoteSender
};
