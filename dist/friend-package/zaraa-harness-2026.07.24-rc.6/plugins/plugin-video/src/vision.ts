import { readFileSync } from "node:fs";
import type { Frame, Scene, Segment, VlmSettings } from "./types.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

interface VisionInput {
  frames: Frame[];
  segments: Segment[];
  question?: string;
  vlm: VlmSettings;
  batchSize: number;
}

interface VisionDeps {
  fetchFn: typeof fetch;
  readImageB64?: (path: string) => string;
}

export async function describeFrames(
  input: VisionInput,
  deps: VisionDeps,
): Promise<{ scenes: Scene[]; visionOffline: boolean }> {
  const readImageB64 = deps.readImageB64 ?? ((p: string) => readFileSync(p).toString("base64"));
  if (!input.frames.length) return { scenes: [], visionOffline: false };

  const batches = chunk(input.frames, Math.max(1, input.batchSize));
  const scenes: Scene[] = [];

  for (const batch of batches) {
    const startSec = batch[0].timestampSec;
    const endSec = batch[batch.length - 1].timestampSec;
    const transcriptWindow = input.segments
      .filter((s) => s.startSec >= startSec - 2 && s.startSec <= endSec + 2)
      .map((s) => `[${fmtTime(s.startSec)}] ${s.text}`)
      .join("\n");

    const prompt =
      `These are sequential frames from a video, ${fmtTime(startSec)}–${fmtTime(endSec)}.` +
      (transcriptWindow ? `\nTranscript in this window:\n${transcriptWindow}` : "") +
      (input.question ? `\n\nThe user asked: "${input.question}". ` : "\n\n") +
      `Describe what happens on screen in 2-4 sentences, including any readable on-screen text.`;

    try {
      const images = batch.map((f) => readImageB64(f.path));
      const timeoutMs = input.vlm.timeoutMs;
      const ctrl = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let r: Response;
      try {
        r = await deps.fetchFn(`${input.vlm.host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl?.signal,
          body: JSON.stringify({
            model: input.vlm.model,
            keep_alive: input.vlm.keepAlive,
            stream: false,
            options: { temperature: 0 },
            messages: [{ role: "user", content: prompt, images }],
          }),
        }) as Response;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!(r as Response).ok) return { scenes, visionOffline: true };
      const j = (await (r as Response).json()) as { message?: { content?: string } };
      scenes.push({ startSec, endSec, description: (j.message?.content ?? "").trim() });
    } catch {
      return { scenes, visionOffline: true };
    }
  }

  return { scenes, visionOffline: false };
}
