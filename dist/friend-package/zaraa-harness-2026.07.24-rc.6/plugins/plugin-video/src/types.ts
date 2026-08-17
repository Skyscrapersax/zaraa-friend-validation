export interface VideoMeta {
  source: string;
  title?: string;
  uploader?: string;
  durationSec: number;
  width?: number;
  height?: number;
}

export interface AcquireResult {
  mediaPath: string | null;
  meta: VideoMeta;
  captionsVttPath: string | null;
  isLocal: boolean;
  mediaSkippedReason?: "long_captioned_video";
}

export interface Frame {
  path: string;
  timestampSec: number;
}

export interface Segment {
  startSec: number;
  text: string;
}

export interface TranscriptResult {
  segments: Segment[];
  source: "captions" | "stt" | "none";
}

export interface Scene {
  startSec: number;
  endSec: number;
  description: string;
}

export type Degradation =
  | "no_captions"
  | "stt_offline"
  | "vision_offline"
  | "frames_only"
  | "visual_skipped_long_video";

export interface VlmSettings {
  host: string;       // e.g. http://127.0.0.1:11434
  model: string;      // e.g. qwen2.5vl:7b
  escalateModel?: string;
  keepAlive: string;  // e.g. "10m"
  timeoutMs?: number;
}

export interface SttSettings {
  baseUrl: string;    // e.g. http://127.0.0.1:8765
  timeoutMs: number;
}
