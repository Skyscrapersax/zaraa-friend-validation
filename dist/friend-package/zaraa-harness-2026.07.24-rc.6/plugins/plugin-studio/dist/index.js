// src/scene/scene-spec.ts
import { z } from "zod";
var SceneSpecSchema = z.object({
  seed: z.number().int(),
  durationSec: z.number().min(2).max(15),
  fps: z.number().int().positive().default(30),
  aspectRatios: z.array(z.enum(["1080x1920", "1080x1350"])).nonempty().default(["1080x1920", "1080x1350"]),
  palette: z.object({
    bg: z.string().default("#06080f"),
    primary: z.string().default("#ff2ea6"),
    accent: z.string().default("#2dd4bf"),
    text: z.string().default("#f6efe3")
  }).default({}),
  character: z.object({
    mood: z.enum(["idle", "charged", "sweep", "blink", "glitch"]).default("charged"),
    intensity: z.number().min(0).max(1).default(0.7)
  }).default({}),
  message: z.object({
    lines: z.array(z.string()).min(1).max(4),
    style: z.string().default("kinetic"),
    timingSec: z.array(z.number()).default([])
  }),
  audio: z.object({
    source: z.enum(["track", "bleeps"]).default("bleeps"),
    trackClip: z.object({
      file: z.string(),
      startSec: z.number(),
      endSec: z.number()
    }).optional(),
    reactive: z.boolean().default(true)
  }).default({}),
  caption: z.object({
    text: z.string(),
    hashtags: z.array(z.string()).default([])
  }).optional()
});

// src/store/studio-store.ts
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
var StudioStore = class {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS renders (id TEXT PRIMARY KEY, specJson TEXT NOT NULL, verdict TEXT NOT NULL, confidence REAL NOT NULL, files TEXT NOT NULL, createdAt INTEGER NOT NULL, performance TEXT, keyHashes TEXT)"
    );
    try {
      this.db.exec("ALTER TABLE renders ADD COLUMN keyHashes TEXT");
    } catch {
    }
  }
  /** Record a render and return its generated id. */
  recordRender(input) {
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO renders (id, specJson, verdict, confidence, files, createdAt, performance, keyHashes) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)"
    ).run(
      id,
      input.specJson,
      input.verdict,
      input.confidence,
      JSON.stringify(input.files),
      Date.now(),
      input.keyHashes ? JSON.stringify(input.keyHashes) : null
    );
    return id;
  }
  /** List the most recent renders, newest first. */
  listRenders(limit) {
    const rows = this.db.prepare(
      "SELECT * FROM renders ORDER BY createdAt DESC, rowid DESC LIMIT ?"
    ).all(limit);
    return rows.map((row) => ({
      ...row,
      files: JSON.parse(row.files),
      keyHashes: row.keyHashes ? JSON.parse(row.keyHashes) : []
    }));
  }
  /**
   * Flattened key-frame hashes from the most recent `limit` renders (same
   * ordering as listRenders), newest first — the novelty history the quality
   * gate compares fresh renders against, durable across daemon restarts.
   */
  listRecentKeyHashes(limit) {
    const rows = this.db.prepare(
      "SELECT keyHashes FROM renders ORDER BY createdAt DESC, rowid DESC LIMIT ?"
    ).all(limit);
    return rows.flatMap(
      (row) => row.keyHashes ? JSON.parse(row.keyHashes) : []
    );
  }
};

// src/render/renderer.ts
import { execFileSync as execFileSync2 } from "child_process";
import { existsSync as existsSync2, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { chromium } from "playwright";

// src/util/media-bins.ts
import { execFileSync } from "child_process";
import { existsSync } from "fs";
function resolveBinary(name, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  for (const candidate of [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}
var FFMPEG = resolveBinary("ffmpeg", "ZARAA_FFMPEG_PATH");
var FFPROBE = resolveBinary("ffprobe", "ZARAA_FFPROBE_PATH");

// src/render/host-load.ts
import { loadavg } from "os";
var DEFAULT_HOST_LOAD_THRESHOLD = 8;
var HOST_LOAD_THRESHOLD_ENV = "ZARAA_STUDIO_RENDER_LOAD_THRESHOLD";
function getLoadAverage() {
  return loadavg()[0];
}
function hostLoadThreshold() {
  const raw = process.env[HOST_LOAD_THRESHOLD_ENV];
  if (raw === void 0) return DEFAULT_HOST_LOAD_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOST_LOAD_THRESHOLD;
}
function isHostBusy(threshold, read = getLoadAverage) {
  return read() >= (threshold ?? hostLoadThreshold());
}

// src/render/renderer.ts
var HostBusyError = class extends Error {
  constructor(message = "host too busy to render") {
    super(message);
    this.name = "HostBusyError";
  }
};
var renderChain = Promise.resolve();
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForCalmHost() {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isHostBusy()) return;
    if (attempt < maxAttempts - 1) await sleep(3e3);
  }
  if (isHostBusy()) throw new HostBusyError();
}
function parseDims(aspect) {
  const [w, h] = aspect.split("x");
  const width = Number.parseInt(w, 10);
  const height = Number.parseInt(h, 10);
  return { width, height };
}
function sceneFileUrl() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../scene/bleepybot-scene.html"),
    join(here, "scene/bleepybot-scene.html")
  ];
  for (const candidate of candidates) {
    if (existsSync2(candidate)) return pathToFileURL(candidate).href;
  }
  throw new Error(
    `bleepybot-scene.html not found; looked at: ${candidates.join(", ")}. If running from dist, the build must copy src/scene/bleepybot-scene.html into dist/scene/ (tsup onSuccess).`
  );
}
async function captureFrames(spec, width, height, framesDir) {
  const sceneUrl = sceneFileUrl();
  const frameCount = Math.round(spec.durationSec * spec.fps);
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript((injected) => {
      window.__BLEEPY_SCENE__ = injected;
    }, spec);
    await page.goto(sceneUrl);
    await page.waitForFunction(
      () => typeof window.__bleepyFrame === "function"
    );
    for (let frame = 0; frame < frameCount; frame++) {
      await page.evaluate((n) => {
        window.__bleepyFrame(n);
      }, frame);
      await page.screenshot({ path: join(framesDir, `${String(frame).padStart(5, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }
}
function buildAudio(spec, audioWav) {
  const clip = spec.audio.trackClip;
  if (spec.audio.source === "track" && clip && existsSync2(clip.file)) {
    execFileSync2(FFMPEG, [
      "-y",
      "-ss",
      String(clip.startSec),
      "-to",
      String(clip.endSec),
      "-i",
      clip.file,
      "-ac",
      "1",
      "-ar",
      "44100",
      audioWav
    ]);
    return;
  }
  if (spec.audio.source === "track" && clip && !existsSync2(clip.file)) {
    console.warn(`[studio:renderer] track requested but file missing (${clip.file}); falling back to synthesized bleep bed`);
  }
  execFileSync2(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=0.2*sin(2*PI*440*t):d=${spec.durationSec}:s=44100`,
    "-ac",
    "1",
    audioWav
  ]);
}
function encode(framesDir, audioWav, fps, width, height, outDir) {
  const outPath = join(outDir, `bleepybot-${width}x${height}.mp4`);
  execFileSync2(FFMPEG, [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(framesDir, "%05d.png"),
    "-i",
    audioWav,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-shortest",
    outPath
  ]);
  return outPath;
}
async function renderRatio(spec, aspect, outDir) {
  const { width, height } = parseDims(aspect);
  const workDir = mkdtempSync(join(tmpdir(), `studio-frames-${width}x${height}-`));
  const framesDir = join(workDir, "frames");
  const audioWav = join(workDir, "audio.wav");
  try {
    execFileSync2("/bin/mkdir", ["-p", framesDir]);
    await captureFrames(spec, width, height, framesDir);
    buildAudio(spec, audioWav);
    return encode(framesDir, audioWav, spec.fps, width, height, outDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
async function renderShort(spec, outDir) {
  const run = renderChain.then(async () => {
    await waitForCalmHost();
    const outputs = [];
    for (const aspect of spec.aspectRatios) {
      outputs.push(await renderRatio(spec, aspect, outDir));
    }
    return outputs;
  });
  renderChain = run.catch(() => void 0);
  return run;
}

// src/director/director.ts
var SYSTEM_PROMPT = `You are the Director for bleepybot, the animated mascot of the band "bleepythings". You design short vertical video clips (animated shorts) by emitting a single JSON scene spec.

AESTHETIC RUBRIC \u2014 in priority order:
1. LEAD WITH CHARM AND WATCHABILITY. bleepybot is cute and hold-your-gaze hypnotic FIRST. The operator's verdict on the first render: "cute \u2014 definitely made me want to look at it for a while." That is the bar. Every clip should make someone want to keep looking.
2. Moody/glitchy is an ACCENT, not the lead. Use the "glitch" mood sparingly, only when the comeback narrative calls for it, and never at the cost of the cute.
3. Hook in the first second. The first message line and the character's energy must land immediately.
4. Text is SHORT and PUNCHY: at most 4 lines, each a few words. One clear idea per clip \u2014 never two.
5. Duration: aim for 8-12 seconds. Long enough to hypnotize, short enough to loop.
6. Palette suggestions are welcome (hex colors) \u2014 keep them cohesive with a dark synthy stage; the defaults are a deep night bg with neon pink primary and teal accent.

OUTPUT FORMAT \u2014 emit ONLY a JSON object (no prose, no markdown fences) with these fields:
{
  "seed": integer (any; optional \u2014 one is generated if omitted),
  "durationSec": number between 2 and 15 (prefer 8-12),
  "fps": optional integer (default 30),
  "aspectRatios": optional array from ["1080x1920", "1080x1350"],
  "palette": optional { "bg": hex, "primary": hex, "accent": hex, "text": hex },
  "character": optional { "mood": one of ["idle", "charged", "sweep", "blink", "glitch"], "intensity": number 0-1 },
  "message": { "lines": array of 1-4 short strings, "style": optional string, "timingSec": optional array of numbers },
  "caption": { "text": short caption for the post, "hashtags": array of hashtag strings }
}

Do NOT include an "audio" field \u2014 audio is decided by the system, not by you.`;
function buildUserPrompt(brief) {
  const trackNote = brief.availableTracks.length > 0 ? `A track is available for this clip (the system will attach it; design the clip to ride a music moment).` : `No track is available; the clip will use bleepybot's synthesized bleeps.`;
  return `BRIEF: ${brief.message}

AUDIO CONTEXT: ${trackNote}

Emit ONLY the JSON scene spec.`;
}
function stripMarkdownFences(raw) {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
function parseSpec(raw) {
  const json = JSON.parse(stripMarkdownFences(raw));
  SceneSpecSchema.parse(applySeedAndAudio(json, []));
  return json;
}
function applySeedAndAudio(spec, availableTracks) {
  const seed = typeof spec.seed === "number" ? spec.seed : Math.floor(Math.random() * 2 ** 31);
  const track = availableTracks[0];
  const audio = track ? {
    source: "track",
    trackClip: {
      file: track.file,
      startSec: track.suggestedStartSec ?? 0,
      endSec: track.suggestedEndSec ?? (track.suggestedStartSec ?? 0) + spec.durationSec
    }
  } : { source: "bleeps" };
  return { ...spec, seed, audio };
}
async function direct(brief, deps) {
  const userPrompt = buildUserPrompt(brief);
  let parsed;
  try {
    parsed = parseSpec(await deps.llm(SYSTEM_PROMPT, userPrompt));
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const retryPrompt = `${userPrompt}

Your previous output was invalid: ${errMsg}. Emit ONLY valid JSON.`;
    parsed = parseSpec(await deps.llm(SYSTEM_PROMPT, retryPrompt));
  }
  return SceneSpecSchema.parse(applySeedAndAudio(parsed, brief.availableTracks));
}

// src/gate/brand-judge.ts
var SYSTEM_PROMPT2 = `You are the strict JSON-only Brand Judge for bleepybot, the animated mascot of the band "bleepythings", which is running an earnest comeback campaign. You receive a JSON scene spec describing a short animated clip and you score its brand fit.

RUBRIC \u2014 in priority order:
1. CHARM AND WATCHABILITY FIRST. The operator's verbatim taste verdict on the reference render is: "cute \u2014 made me want to look at it for a while". Score how strongly this spec would make someone want to keep looking. Cute, hold-your-gaze, loopable.
2. CHARACTER ON-MODEL. bleepybot is a friendly signal-sweeping robot. Glitch is an ACCENT, not the identity \u2014 a spec that leads with glitch, menace, or gloom is off-model.
3. MESSAGE TONE fits an earnest band comeback: warm, sincere, a little wistful is fine. No cringe hype, no engagement-bait, no offensive or off-brand content.
4. TEXT RESTRAINT: at most 4 short lines. Walls of text or long lines lose points.

OUTPUT FORMAT \u2014 respond with ONLY a JSON object, no prose, no markdown fences:
{"score": <number between 0 and 1>, "reason": "<one sentence>"}`;
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
function parseVerdict(raw) {
  const parsed = JSON.parse(stripMarkdownFences(raw));
  const obj = parsed;
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) {
    throw new Error("brand judge verdict missing a finite numeric score");
  }
  return {
    score: clamp01(obj.score),
    reason: typeof obj.reason === "string" ? obj.reason : ""
  };
}
function createBrandJudge(llm) {
  return async (spec) => {
    const userPrompt = JSON.stringify(spec);
    try {
      return parseVerdict(await llm(SYSTEM_PROMPT2, userPrompt));
    } catch {
      const nudged = `${userPrompt}

Return ONLY the JSON object.`;
      try {
        return parseVerdict(await llm(SYSTEM_PROMPT2, nudged));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`brand judge returned invalid output after retry: ${msg}`);
      }
    }
  };
}

// src/gate/phash.ts
import { execFileSync as execFileSync3 } from "child_process";
function phash(gray64) {
  if (gray64.length !== 64) {
    throw new Error(`phash expects exactly 64 grayscale bytes, got ${gray64.length}`);
  }
  let sum = 0;
  for (const byte of gray64) sum += byte;
  const mean = sum / 64;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    bits <<= 1n;
    if (gray64[i] >= mean) bits |= 1n;
  }
  return bits.toString(16).padStart(16, "0");
}
function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
function phashFromPng(pngPath) {
  const raw = execFileSync3(FFMPEG, [
    "-v",
    "error",
    "-i",
    pngPath,
    "-vf",
    "scale=8:8",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-"
  ]);
  return phash(raw.subarray(0, 64));
}

// src/gate/quality-gate.ts
var DUP_DISTANCE_THRESHOLD = 6;
var MAX_LINE_CHARS = 42;
var PASS_THRESHOLD = 0.7;
var ESCALATE_FLOOR = 0.3;
async function evaluate(input, deps) {
  for (const frame of input.keyFrameHashes) {
    for (const past of input.historyHashes) {
      const distance = hamming(frame, past);
      if (distance < DUP_DISTANCE_THRESHOLD) {
        return {
          verdict: "fail",
          reason: `not novel vs recent renders (hamming ${distance} < ${DUP_DISTANCE_THRESHOLD})`,
          confidence: 1,
          retryable: true
          // a new seed yields new frames
        };
      }
    }
  }
  for (const line of input.spec.message.lines) {
    if (line.length > MAX_LINE_CHARS) {
      return {
        verdict: "fail",
        reason: `text legibility: line too long for mobile (${line.length} > ${MAX_LINE_CHARS} chars)`,
        confidence: 1,
        retryable: false
        // line length is seed-independent
      };
    }
  }
  const { score, reason } = await deps.brandJudge(input.spec);
  if (score >= PASS_THRESHOLD) {
    return { verdict: "pass", reason, confidence: score };
  }
  if (score >= ESCALATE_FLOOR) {
    return { verdict: "escalate", reason, confidence: score };
  }
  return { verdict: "fail", reason, confidence: score, retryable: false };
}

// src/gate/key-frames.ts
import { execFileSync as execFileSync4 } from "child_process";
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";
async function extractKeyFrameHashes(mp4Path, opts = {}) {
  const timestamps = opts.timestamps ?? [0, 1];
  const frameDir = mkdtempSync2(join2(tmpdir2(), "studio-key-frames-"));
  try {
    return timestamps.map((ts, i) => {
      const png = join2(frameDir, `frame-${i}.png`);
      const seek = ts > 0 ? ["-ss", String(ts)] : [];
      try {
        execFileSync4(FFMPEG, ["-v", "error", ...seek, "-i", mp4Path, "-frames:v", "1", png], {
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (err) {
        const stderr = err.stderr;
        const stderrText = stderr ? stderr.toString() : String(err);
        throw new Error(
          `ffmpeg key-frame extraction failed for ${mp4Path} @ ${ts}s: ${stderrText.trim().split("\n").slice(-3).join(" | ")}`,
          { cause: err }
        );
      }
      return phashFromPng(png);
    });
  } finally {
    rmSync2(frameDir, { recursive: true, force: true });
  }
}

// src/export/exporter.ts
import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { basename, join as join3 } from "path";
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
function exportRender(spec, caption, mp4Files, exportRoot) {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const slug = `${slugify(spec.message.lines[0])}-${spec.seed}`;
  const dir = join3(exportRoot, date, slug);
  mkdirSync(dir, { recursive: true });
  for (const file of mp4Files) {
    copyFileSync(file, join3(dir, basename(file)));
  }
  writeFileSync(join3(dir, "caption.txt"), caption);
  writeFileSync(join3(dir, "spec.json"), JSON.stringify(spec, null, 2));
  return dir;
}

// src/orchestrator/orchestrator.ts
function captionFor(spec) {
  if (spec.caption) {
    return [spec.caption.text, spec.caption.hashtags.join(" ")].filter((part) => part.length > 0).join("\n");
  }
  return spec.message.lines[0];
}
function varySpec(base, attempt) {
  return { ...base, seed: base.seed + attempt * 7919 | 0 };
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
async function runStudioBrief(brief, deps) {
  let baseSpec;
  try {
    baseSpec = await deps.director(brief);
  } catch (err) {
    deps.store.recordRender({
      specJson: JSON.stringify({ brief }),
      verdict: "escalate",
      confidence: 0,
      files: []
    });
    return {
      verdict: "escalate",
      reason: `director failed: ${errorMessage(err)}`,
      attempts: 0,
      bestConfidence: 0
    };
  }
  let bestConfidence = 0;
  let lastReason = "no attempts ran";
  let lastError;
  let lastSpec = baseSpec;
  let lastFiles = [];
  let lastHashes;
  for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
    const spec = attempt === 0 ? baseSpec : varySpec(baseSpec, attempt);
    lastSpec = spec;
    lastHashes = void 0;
    try {
      const files = await deps.render(spec);
      lastFiles = files;
      const hashes = await deps.keyFrameHashes(files);
      lastHashes = hashes;
      const result = await deps.gate({ keyFrameHashes: hashes, spec, historyHashes: [] });
      lastError = void 0;
      lastReason = result.reason;
      if (result.confidence > bestConfidence) bestConfidence = result.confidence;
      if (result.verdict === "pass") {
        const exportDir = deps.exportRender(spec, captionFor(spec), files);
        deps.store.recordRender({
          specJson: JSON.stringify(spec),
          verdict: "pass",
          confidence: result.confidence,
          files,
          keyHashes: hashes
        });
        return {
          verdict: "pass",
          exportDir,
          reason: result.reason,
          attempts: attempt + 1,
          bestConfidence
        };
      }
      if (result.verdict === "escalate") {
        deps.store.recordRender({
          specJson: JSON.stringify(spec),
          verdict: "escalate",
          confidence: result.confidence,
          files,
          keyHashes: hashes
        });
        return {
          verdict: "escalate",
          reason: result.reason,
          attempts: attempt + 1,
          bestConfidence
        };
      }
      if (result.retryable === false) {
        deps.store.recordRender({
          specJson: JSON.stringify(spec),
          verdict: "escalate",
          confidence: result.confidence,
          files,
          keyHashes: hashes
        });
        return {
          verdict: "escalate",
          reason: result.reason,
          attempts: attempt + 1,
          bestConfidence
        };
      }
    } catch (err) {
      lastError = errorMessage(err);
      lastReason = `error: ${lastError}`;
    }
  }
  deps.store.recordRender({
    specJson: JSON.stringify(lastSpec),
    verdict: "escalate",
    confidence: bestConfidence,
    files: lastFiles,
    keyHashes: lastHashes
  });
  return {
    verdict: "escalate",
    reason: lastError !== void 0 ? `error: ${lastError}` : `retry budget exhausted after ${deps.maxRetries + 1} attempts; last gate reason: ${lastReason}`,
    attempts: deps.maxRetries + 1,
    bestConfidence
  };
}
export {
  HostBusyError,
  SceneSpecSchema,
  StudioStore,
  createBrandJudge,
  direct,
  evaluate,
  exportRender,
  extractKeyFrameHashes,
  hamming,
  isHostBusy,
  phash,
  phashFromPng,
  renderShort,
  runStudioBrief,
  stripMarkdownFences
};
