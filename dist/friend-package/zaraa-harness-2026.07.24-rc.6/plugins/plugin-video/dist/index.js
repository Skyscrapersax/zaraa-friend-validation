// src/manifest.ts
var tools = [
  {
    name: "watch_video",
    description: "Watch a video (URL or local path) and return a grounded text report (scene descriptions + transcript) you can answer from. Runs fully locally. Optionally focus a time range with start/end or zoom by re-calling.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1, description: "Video URL (yt-dlp supported) or local file path" },
        question: { type: "string", description: "Optional question to steer the description" },
        start: { type: "number", minimum: 0, description: "Focus start time (seconds)" },
        end: { type: "number", minimum: 0, description: "Focus end time (seconds)" },
        maxFrames: { type: "integer", minimum: 1, maximum: 100, description: "Override frame budget" },
        resolution: { type: "integer", enum: [512, 1024], description: "Frame width px (1024 for on-screen text)" }
      },
      required: ["source"]
    },
    minZone: "sandbox",
    requiresApproval: false
  }
];
var VIDEO_MANIFEST = {
  name: "video",
  version: "0.1.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["media.video"],
  trust: "verified",
  tools
};

// src/handlers.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join as join4 } from "path";

// src/acquire.ts
import { existsSync, readdirSync } from "fs";
import { join } from "path";
function isUrl(s) {
  return /^https?:\/\//i.test(s);
}
async function probeLocal(path, ffmpegPath, exec) {
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const res = await exec(ffprobe, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_entries",
    "format=duration:stream=width,height",
    path
  ]);
  let durationSec = 0, width, height;
  try {
    const j = JSON.parse(res.stdout || "{}");
    durationSec = Number(j.format?.duration) || 0;
    const vs = (j.streams || []).find((s) => s.width);
    width = vs?.width;
    height = vs?.height;
  } catch {
  }
  return { source: path, durationSec, width, height };
}
async function acquireVideo(source, opts, exec, policy = {}) {
  if (!isUrl(source)) {
    if (!existsSync(source)) {
      throw new Error(`video source not found: ${source}`);
    }
    const meta2 = await probeLocal(source, opts.ffmpegPath, exec);
    return { mediaPath: source, meta: meta2, captionsVttPath: null, isLocal: true };
  }
  const info = await exec(opts.ytDlpPath, ["--dump-json", "--no-warnings", source]);
  if (info.code !== 0) throw new Error(`yt-dlp metadata failed: ${info.stderr.slice(0, 300)}`);
  let meta = { source, durationSec: 0 };
  let hasCaptions = false;
  try {
    const j = JSON.parse(info.stdout || "{}");
    meta = {
      source,
      title: j.title,
      uploader: j.uploader,
      durationSec: Number(j.duration) || 0,
      width: j.width,
      height: j.height
    };
    hasCaptions = Boolean(
      j.subtitles && Object.keys(j.subtitles).length || j.automatic_captions && Object.keys(j.automatic_captions).length
    );
  } catch {
  }
  let captionsVttPath = null;
  if (hasCaptions) {
    const vttBase = join(opts.workDir, "subs");
    const sub = await exec(opts.ytDlpPath, [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en.*",
      "--convert-subs",
      "vtt",
      "-o",
      vttBase,
      "--no-warnings",
      source
    ]);
    if (sub.code === 0) {
      const candidate = `${vttBase}.en.vtt`;
      if (existsSync(candidate)) {
        captionsVttPath = candidate;
      } else {
        captionsVttPath = firstVttIn(opts.workDir) ?? candidate;
      }
    }
  }
  const skipLongMedia = !policy.focused && captionsVttPath && policy.longVideoTranscriptOnlyThresholdSec !== void 0 && meta.durationSec >= policy.longVideoTranscriptOnlyThresholdSec;
  if (skipLongMedia) {
    return {
      mediaPath: null,
      meta,
      captionsVttPath,
      isLocal: false,
      mediaSkippedReason: "long_captioned_video"
    };
  }
  const mediaPath = join(opts.workDir, "media.mp4");
  const dl = await exec(opts.ytDlpPath, [
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    mediaPath,
    "--no-warnings",
    source
  ]);
  if (dl.code !== 0) {
    throw new Error(`yt-dlp download failed: ${dl.stderr.slice(0, 300)}`);
  }
  return { mediaPath, meta, captionsVttPath, isLocal: false };
}
function firstVttIn(dir) {
  try {
    const f = readdirSync(dir).find((n) => n.endsWith(".vtt"));
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

// src/frames.ts
import { join as join2 } from "path";
import { readdirSync as readdirSync2 } from "fs";

// src/frame-budget.ts
function computeFrameBudget(durationSec, maxFrames) {
  const d = Math.max(durationSec, 0);
  let target;
  if (d <= 30) target = 30;
  else if (d <= 60) target = 40;
  else if (d <= 180) target = 60;
  else if (d <= 600) target = 80;
  else target = 100;
  target = Math.max(1, Math.min(target, maxFrames));
  const fps = Math.min(2, target / Math.max(d, 1));
  return { targetFrames: target, fps };
}

// src/frames.ts
var defaultList = (dir) => readdirSync2(dir).filter((n) => /^frame-\d+\.jpg$/.test(n)).sort();
async function extractFrames(input, exec, listFrames = defaultList) {
  const focused = input.startSec !== void 0 || input.endSec !== void 0;
  const start = Math.max(0, input.startSec ?? 0);
  const end = Math.min(input.endSec ?? input.durationSec, input.durationSec);
  const window = focused ? Math.max(1, end - start) : Math.max(1, input.durationSec);
  const { fps } = computeFrameBudget(window, input.maxFrames);
  const pattern = join2(input.workDir, "frame-%04d.jpg");
  const args = [
    "-y",
    ...focused ? ["-ss", String(start), "-to", String(end)] : [],
    "-i",
    input.mediaPath,
    "-vf",
    `fps=${fps},scale=${input.resolution}:-1`,
    "-frames:v",
    String(input.maxFrames),
    "-qscale:v",
    "3",
    pattern
  ];
  const res = await exec(input.ffmpegPath, args, { timeoutMs: 3e5 });
  if (res.code !== 0) return [];
  const names = listFrames(input.workDir);
  return names.map((name, i) => ({
    path: join2(input.workDir, name),
    timestampSec: start + i / fps
  }));
}

// src/transcript.ts
import { join as join3 } from "path";
import { existsSync as existsSync2, readFileSync } from "fs";
function tsToSec(t) {
  const parts = t.trim().split(":").map(Number);
  let v;
  if (parts.length === 3) v = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) v = parts[0] * 60 + parts[1];
  else v = Number(parts[0]) || 0;
  return Number.isFinite(v) ? v : 0;
}
function parseVtt(vtt) {
  const out = [];
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
function parseSttResponse(j) {
  if (j && typeof j === "object") {
    const obj = j;
    if (Array.isArray(obj.segments)) {
      return obj.segments.filter((s) => s.text).map((s) => ({ startSec: Number(s.start) || 0, text: String(s.text).trim() }));
    }
    if (typeof obj.text === "string" && obj.text.trim()) {
      return [{ startSec: 0, text: obj.text.trim() }];
    }
  }
  return [];
}
async function getTranscript(input, deps) {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const readBinary = deps.readBinary ?? ((p) => readFileSync(p));
  if (input.captionsVttPath && (deps.readFile || existsSync2(input.captionsVttPath))) {
    try {
      const segs = parseVtt(readFile(input.captionsVttPath));
      if (segs.length) return { segments: clampRange(segs, input), source: "captions" };
    } catch {
    }
  }
  try {
    const wav = join3(input.workDir ?? "/tmp", "audio.wav");
    const ex = await deps.exec(input.ffmpegPath, [
      "-y",
      "-i",
      input.mediaPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-vn",
      wav
    ], { timeoutMs: 12e4 });
    if (ex.code !== 0) return { segments: [], source: "none" };
    const buf = readBinary(wav);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "audio.wav");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.stt.timeoutMs);
    const r = await deps.fetchFn(`${input.stt.baseUrl}/transcribe`, {
      method: "POST",
      body: fd,
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return { segments: [], source: "none" };
    const segs = parseSttResponse(await r.json());
    return segs.length ? { segments: clampRange(segs, input), source: "stt" } : { segments: [], source: "none" };
  } catch {
    return { segments: [], source: "none" };
  }
}
function clampRange(segs, input) {
  if (input.startSec === void 0 && input.endSec === void 0) return segs;
  const s = input.startSec ?? 0;
  const e = input.endSec ?? Number.POSITIVE_INFINITY;
  return segs.filter((seg) => seg.startSec >= s && seg.startSec <= e);
}

// src/vision.ts
import { readFileSync as readFileSync2 } from "fs";
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
async function describeFrames(input, deps) {
  const readImageB64 = deps.readImageB64 ?? ((p) => readFileSync2(p).toString("base64"));
  if (!input.frames.length) return { scenes: [], visionOffline: false };
  const batches = chunk(input.frames, Math.max(1, input.batchSize));
  const scenes = [];
  for (const batch of batches) {
    const startSec = batch[0].timestampSec;
    const endSec = batch[batch.length - 1].timestampSec;
    const transcriptWindow = input.segments.filter((s) => s.startSec >= startSec - 2 && s.startSec <= endSec + 2).map((s) => `[${fmtTime(s.startSec)}] ${s.text}`).join("\n");
    const prompt = `These are sequential frames from a video, ${fmtTime(startSec)}\u2013${fmtTime(endSec)}.` + (transcriptWindow ? `
Transcript in this window:
${transcriptWindow}` : "") + (input.question ? `

The user asked: "${input.question}". ` : "\n\n") + `Describe what happens on screen in 2-4 sentences, including any readable on-screen text.`;
    try {
      const images = batch.map((f) => readImageB64(f.path));
      const timeoutMs = input.vlm.timeoutMs;
      const ctrl = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let r;
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
            messages: [{ role: "user", content: prompt, images }]
          })
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!r.ok) return { scenes, visionOffline: true };
      const j = await r.json();
      scenes.push({ startSec, endSec, description: (j.message?.content ?? "").trim() });
    } catch {
      return { scenes, visionOffline: true };
    }
  }
  return { scenes, visionOffline: false };
}

// src/report.ts
var MAX_TRANSCRIPT_CUES_IN_REPORT = 48;
var LONG_TRANSCRIPT_HEAD_CUES = 12;
function fmtTime2(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
var DEGRADE_NOTE = {
  no_captions: "No native captions were available.",
  stt_offline: "Transcript unavailable (local STT offline).",
  vision_offline: "Visual scene descriptions unavailable (Ollama offline).",
  frames_only: "Answered from frames only.",
  visual_skipped_long_video: "Visual frame analysis skipped for a long captioned video; report is transcript-first."
};
function selectTranscriptCues(segments) {
  if (segments.length <= MAX_TRANSCRIPT_CUES_IN_REPORT) {
    return { cues: segments, compactedFrom: null };
  }
  const picked = /* @__PURE__ */ new Map();
  for (let i = 0; i < Math.min(LONG_TRANSCRIPT_HEAD_CUES, segments.length); i++) {
    picked.set(i, segments[i]);
  }
  const remainingSlots = MAX_TRANSCRIPT_CUES_IN_REPORT - picked.size;
  const start = Math.min(LONG_TRANSCRIPT_HEAD_CUES, segments.length - 1);
  const span = Math.max(1, segments.length - 1 - start);
  for (let i = 0; i < remainingSlots; i++) {
    const idx = Math.min(segments.length - 1, Math.round(start + span * i / Math.max(1, remainingSlots - 1)));
    picked.set(idx, segments[idx]);
  }
  return {
    cues: Array.from(picked.entries()).sort((a, b) => a[0] - b[0]).map(([, cue]) => cue),
    compactedFrom: segments.length
  };
}
function buildReport(input) {
  const { meta, transcript, scenes, degradations } = input;
  const lines = [];
  lines.push("# Video report");
  if (meta.title) lines.push(`- Title: ${meta.title}`);
  if (meta.uploader) lines.push(`- Uploader: ${meta.uploader}`);
  lines.push(`- Source: ${meta.source}`);
  lines.push(`- Duration: ${fmtTime2(meta.durationSec)}`);
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
        `- Transcript compacted from ${selected.compactedFrom} cues to ${selected.cues.length} sampled excerpts. Re-run with start/end for dense detail.`
      );
    }
    for (const seg of selected.cues) lines.push(`- [${fmtTime2(seg.startSec)}] ${seg.text}`);
  } else {
    lines.push("- (none available)");
  }
  lines.push("", "## What is on screen");
  if (scenes.length) {
    for (const s of scenes) lines.push(`- [${fmtTime2(s.startSec)}\u2013${fmtTime2(s.endSec)}] ${s.description}`);
  } else {
    lines.push("- (no visual descriptions available)");
  }
  return lines.join("\n");
}

// src/handlers.ts
var LONG_VIDEO_TRANSCRIPT_ONLY_THRESHOLD_SEC = 30 * 60;
function createVideoHandlers(deps) {
  const makeWorkDir = deps.makeWorkDir ?? (() => mkdtempSync(join4(tmpdir(), "zaraa-video-")));
  const cleanup = deps.cleanup ?? ((dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
  return {
    watch_video: async (args) => {
      const source = String(args.source ?? "").trim();
      if (!source) return { error: "watch_video requires a 'source' (URL or local path)." };
      const isUrl2 = /^https?:\/\//i.test(source);
      const ffmpegCheck = await deps.exec(deps.ffmpegPath, ["-version"]);
      if (ffmpegCheck.errorCode === "ENOENT") {
        return { error: `ffmpeg not found on PATH \u2014 install with: brew install ffmpeg` };
      }
      if (isUrl2) {
        const ytDlpCheck = await deps.exec(deps.ytDlpPath, ["--version"]);
        if (ytDlpCheck.errorCode === "ENOENT") {
          return { error: `yt-dlp not found on PATH \u2014 install with: brew install yt-dlp` };
        }
      }
      const question = args.question;
      const startSec = args.start;
      const endSec = args.end;
      const maxFrames = Math.min(100, Number(args.maxFrames ?? deps.frameBudget));
      const resolution = args.resolution ?? deps.resolution;
      const workDir = makeWorkDir();
      const degradations = [];
      try {
        const focused = startSec !== void 0 || endSec !== void 0;
        const acq = await acquireVideo(
          source,
          { workDir, ytDlpPath: deps.ytDlpPath, ffmpegPath: deps.ffmpegPath },
          deps.exec,
          {
            focused,
            longVideoTranscriptOnlyThresholdSec: LONG_VIDEO_TRANSCRIPT_ONLY_THRESHOLD_SEC
          }
        );
        if (!acq.isLocal && !acq.captionsVttPath) {
          degradations.push("no_captions");
        }
        if (acq.mediaSkippedReason === "long_captioned_video") {
          degradations.push("visual_skipped_long_video");
        }
        let frames = [];
        if (acq.mediaPath) {
          frames = await extractFrames(
            { mediaPath: acq.mediaPath, workDir, maxFrames, resolution, startSec, endSec, ffmpegPath: deps.ffmpegPath, durationSec: acq.meta.durationSec },
            deps.exec,
            deps._listFrames
          );
        }
        const transcript = await getTranscript(
          { captionsVttPath: acq.captionsVttPath, mediaPath: acq.mediaPath ?? "", startSec, endSec, stt: deps.stt, ffmpegPath: deps.ffmpegPath, workDir },
          { exec: deps.exec, fetchFn: deps.fetchFn, readFile: deps._readFile, readBinary: deps._readBinary }
        );
        if (transcript.source === "none") degradations.push("stt_offline");
        const { scenes, visionOffline } = await describeFrames(
          { frames, segments: transcript.segments, question, vlm: deps.vlm, batchSize: deps.batchSize },
          { fetchFn: deps.fetchFn, readImageB64: deps._readImageB64 }
        );
        if (visionOffline) degradations.push("vision_offline");
        if (visionOffline && transcript.segments.length) degradations.push("frames_only");
        const report = buildReport({ meta: acq.meta, transcript, scenes, degradations, question });
        return { report, degradations };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        cleanup(workDir);
      }
    }
  };
}

// src/exec.ts
import { execFile } from "child_process";
var defaultExec = (cmd, args, opts) => new Promise((resolve) => {
  execFile(
    cmd,
    args,
    { timeout: opts?.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const errCode = err ? err.code : void 0;
      const code = err && typeof errCode === "number" ? errCode : err ? 1 : 0;
      const errorCode = typeof errCode === "string" ? errCode : void 0;
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code, errorCode });
    }
  );
});

// src/index.ts
var PLUGIN_NAME = "video";
function createVideoPlugin(config) {
  if (!config?.enabled) return null;
  const handlers = createVideoHandlers({
    exec: defaultExec,
    fetchFn: fetch,
    vlm: {
      host: config.vlm?.host ?? "http://127.0.0.1:11434",
      model: config.vlm?.model ?? "qwen3-vl:8b",
      escalateModel: config.vlm?.escalateModel,
      keepAlive: config.vlm?.keepAlive ?? "10m",
      timeoutMs: config.vlm?.timeoutMs ?? 45e3
    },
    stt: {
      baseUrl: config.stt?.baseUrl ?? "http://127.0.0.1:8765",
      timeoutMs: config.stt?.timeout ?? 12e4
    },
    frameBudget: config.frameBudget ?? 24,
    resolution: config.resolution ?? 512,
    batchSize: config.batchSize ?? 6,
    ytDlpPath: config.ytDlpPath ?? "yt-dlp",
    ffmpegPath: config.ffmpegPath ?? "ffmpeg"
  });
  return { manifest: VIDEO_MANIFEST, handlers };
}
export {
  PLUGIN_NAME,
  VIDEO_MANIFEST,
  createVideoHandlers,
  createVideoPlugin
};
