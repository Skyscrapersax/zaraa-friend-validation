import type { Degradation, Scene, TranscriptResult, VideoMeta } from "./types.js";

const MAX_TRANSCRIPT_CUES_IN_REPORT = 48;
const LONG_TRANSCRIPT_HEAD_CUES = 12;

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const DEGRADE_NOTE: Record<Degradation, string> = {
  no_captions: "No native captions were available.",
  stt_offline: "Transcript unavailable (local STT offline).",
  vision_offline: "Visual scene descriptions unavailable (Ollama offline).",
  frames_only: "Answered from frames only.",
  visual_skipped_long_video: "Visual frame analysis skipped for a long captioned video; report is transcript-first.",
};

function selectTranscriptCues(segments: TranscriptResult["segments"]): {
  cues: TranscriptResult["segments"];
  compactedFrom: number | null;
} {
  if (segments.length <= MAX_TRANSCRIPT_CUES_IN_REPORT) {
    return { cues: segments, compactedFrom: null };
  }

  const picked = new Map<number, TranscriptResult["segments"][number]>();
  for (let i = 0; i < Math.min(LONG_TRANSCRIPT_HEAD_CUES, segments.length); i++) {
    picked.set(i, segments[i]);
  }

  const remainingSlots = MAX_TRANSCRIPT_CUES_IN_REPORT - picked.size;
  const start = Math.min(LONG_TRANSCRIPT_HEAD_CUES, segments.length - 1);
  const span = Math.max(1, segments.length - 1 - start);
  for (let i = 0; i < remainingSlots; i++) {
    const idx = Math.min(segments.length - 1, Math.round(start + (span * i) / Math.max(1, remainingSlots - 1)));
    picked.set(idx, segments[idx]);
  }

  return {
    cues: Array.from(picked.entries()).sort((a, b) => a[0] - b[0]).map(([, cue]) => cue),
    compactedFrom: segments.length,
  };
}

export function buildReport(input: {
  meta: VideoMeta;
  transcript: TranscriptResult;
  scenes: Scene[];
  degradations: Degradation[];
  question?: string;
}): string {
  const { meta, transcript, scenes, degradations } = input;
  const lines: string[] = [];

  lines.push("# Video report");
  if (meta.title) lines.push(`- Title: ${meta.title}`);
  if (meta.uploader) lines.push(`- Uploader: ${meta.uploader}`);
  lines.push(`- Source: ${meta.source}`);
  lines.push(`- Duration: ${fmtTime(meta.durationSec)}`);
  if (degradations.length) {
    lines.push("", "## Notes");
    for (const d of degradations) lines.push(`- ${DEGRADE_NOTE[d]}`);
  }

  lines.push("", `## Transcript (${transcript.source})`);
  if (transcript.segments.length) {
    lines.push(`- Transcript available from ${transcript.source} (${transcript.segments.length} cues).`);
    const selected = selectTranscriptCues(transcript.segments);
    if (selected.compactedFrom !== null) {
      lines.push(
        `- Transcript compacted from ${selected.compactedFrom} cues to ${selected.cues.length} sampled excerpts. Re-run with start/end for dense detail.`,
      );
    }
    for (const seg of selected.cues) lines.push(`- [${fmtTime(seg.startSec)}] ${seg.text}`);
  } else {
    lines.push("- (none available)");
  }

  lines.push("", "## What is on screen");
  if (scenes.length) {
    for (const s of scenes) lines.push(`- [${fmtTime(s.startSec)}–${fmtTime(s.endSec)}] ${s.description}`);
  } else {
    lines.push("- (no visual descriptions available)");
  }

  return lines.join("\n");
}
