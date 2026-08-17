import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Exec } from "./exec.js";
import type { Segment, SttSettings, TranscriptResult } from "./types.js";

function tsToSec(t: string): number {
  // HH:MM:SS.mmm or MM:SS.mmm
  const parts = t.trim().split(":").map(Number);
  let v: number;
  if (parts.length === 3) v = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) v = parts[0] * 60 + parts[1];
  else v = Number(parts[0]) || 0;
  return Number.isFinite(v) ? v : 0;
}

export function parseVtt(vtt: string): Segment[] {
  const out: Segment[] = [];
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const cueIdx = lines.findIndex((l) => l.includes("-->"));
    if (cueIdx === -1) continue;
    const startSec = tsToSec(lines[cueIdx].split("-->")[0]);
    const text = lines.slice(cueIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    if (out.length) {
      const prev = out[out.length - 1];
      const nearPrev = startSec - prev.startSec <= 6;
      if (prev.text === text) continue;
      if (nearPrev && text.includes(prev.text)) {
        out[out.length - 1] = { startSec: prev.startSec, text };
        continue;
      }
      if (nearPrev && prev.text.includes(text)) continue;
    }
    out.push({ startSec, text });
  }
  return out;
}

export function parseSttResponse(j: unknown): Segment[] {
  if (j && typeof j === "object") {
    const obj = j as { segments?: Array<{ start?: number; text?: string }>; text?: string };
    if (Array.isArray(obj.segments)) {
      return obj.segments
        .filter((s) => s.text)
        .map((s) => ({ startSec: Number(s.start) || 0, text: String(s.text).trim() }));
    }
    if (typeof obj.text === "string" && obj.text.trim()) {
      return [{ startSec: 0, text: obj.text.trim() }];
    }
  }
  return [];
}

interface TranscriptInput {
  captionsVttPath: string | null;
  mediaPath: string;
  startSec?: number;
  endSec?: number;
  stt: SttSettings;
  ffmpegPath: string;
  workDir?: string;
}

interface TranscriptDeps {
  exec: Exec;
  fetchFn: typeof fetch;
  readFile?: (p: string) => string;
  /** Injectable binary reader — defaults to readFileSync; override in tests to avoid real disk reads. */
  readBinary?: (p: string) => Buffer;
}

export async function getTranscript(input: TranscriptInput, deps: TranscriptDeps): Promise<TranscriptResult> {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const readBinary = deps.readBinary ?? ((p: string) => readFileSync(p));

  // 1) captions
  if (input.captionsVttPath && (deps.readFile || existsSync(input.captionsVttPath))) {
    try {
      const segs = parseVtt(readFile(input.captionsVttPath));
      if (segs.length) return { segments: clampRange(segs, input), source: "captions" };
    } catch { /* fall through */ }
  }

  // 2) STT fallback — extract mono 16k wav, POST to /transcribe
  try {
    const wav = join(input.workDir ?? "/tmp", "audio.wav");
    const ex = await deps.exec(input.ffmpegPath, [
      "-y", "-i", input.mediaPath, "-ac", "1", "-ar", "16000", "-vn", wav,
    ], { timeoutMs: 120_000 });
    if (ex.code !== 0) return { segments: [], source: "none" };

    const buf = readBinary(wav);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "audio.wav");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.stt.timeoutMs);
    const r = await deps.fetchFn(`${input.stt.baseUrl}/transcribe`, {
      method: "POST", body: fd, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { segments: [], source: "none" };
    const segs = parseSttResponse(await r.json());
    return segs.length ? { segments: clampRange(segs, input), source: "stt" } : { segments: [], source: "none" };
  } catch {
    return { segments: [], source: "none" };
  }
}

function clampRange(segs: Segment[], input: { startSec?: number; endSec?: number }): Segment[] {
  if (input.startSec === undefined && input.endSec === undefined) return segs;
  const s = input.startSec ?? 0;
  const e = input.endSec ?? Number.POSITIVE_INFINITY;
  return segs.filter((seg) => seg.startSec >= s && seg.startSec <= e);
}
