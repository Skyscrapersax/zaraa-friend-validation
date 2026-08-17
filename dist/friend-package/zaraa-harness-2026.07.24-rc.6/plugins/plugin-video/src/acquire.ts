import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import type { AcquireResult, VideoMeta } from "./types.js";

interface AcquireOpts {
  workDir: string;
  ytDlpPath: string;
  ffmpegPath: string;
}

interface AcquirePolicy {
  focused?: boolean;
  longVideoTranscriptOnlyThresholdSec?: number;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Read duration + dimensions from a local media file via ffprobe (ships with ffmpeg). */
async function probeLocal(path: string, ffmpegPath: string, exec: Exec): Promise<VideoMeta> {
  // ffprobe is installed alongside ffmpeg; derive its path from ffmpegPath.
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const res = await exec(ffprobe, [
    "-v", "quiet", "-print_format", "json",
    "-show_entries", "format=duration:stream=width,height",
    path,
  ]);
  let durationSec = 0, width: number | undefined, height: number | undefined;
  try {
    const j = JSON.parse(res.stdout || "{}");
    durationSec = Number(j.format?.duration) || 0;
    const vs = (j.streams || []).find((s: { width?: number }) => s.width);
    width = vs?.width; height = vs?.height;
  } catch { /* leave defaults */ }
  return { source: path, durationSec, width, height };
}

export async function acquireVideo(
  source: string,
  opts: AcquireOpts,
  exec: Exec,
  policy: AcquirePolicy = {},
): Promise<AcquireResult> {
  if (!isUrl(source)) {
    if (!existsSync(source)) {
      throw new Error(`video source not found: ${source}`);
    }
    const meta = await probeLocal(source, opts.ffmpegPath, exec);
    return { mediaPath: source, meta, captionsVttPath: null, isLocal: true };
  }

  // 1) metadata + caption availability
  const info = await exec(opts.ytDlpPath, ["--dump-json", "--no-warnings", source]);
  if (info.code !== 0) throw new Error(`yt-dlp metadata failed: ${info.stderr.slice(0, 300)}`);
  let meta: VideoMeta = { source, durationSec: 0 };
  let hasCaptions = false;
  try {
    const j = JSON.parse(info.stdout || "{}");
    meta = {
      source,
      title: j.title,
      uploader: j.uploader,
      durationSec: Number(j.duration) || 0,
      width: j.width,
      height: j.height,
    };
    hasCaptions = Boolean(
      (j.subtitles && Object.keys(j.subtitles).length) ||
      (j.automatic_captions && Object.keys(j.automatic_captions).length),
    );
  } catch { /* keep defaults */ }

  // 2) captions → vtt (best-effort; ignore failures). Do this before media
  // download so long captioned videos can still produce a useful transcript.
  let captionsVttPath: string | null = null;
  if (hasCaptions) {
    const vttBase = join(opts.workDir, "subs");
    const sub = await exec(opts.ytDlpPath, [
      "--skip-download", "--write-subs", "--write-auto-subs",
      "--sub-langs", "en.*", "--convert-subs", "vtt",
      "-o", vttBase, "--no-warnings", source,
    ]);
    if (sub.code === 0) {
      const candidate = `${vttBase}.en.vtt`;
      if (existsSync(candidate)) {
        captionsVttPath = candidate;
      } else {
        // yt-dlp may name the file differently; scan workDir for any .vtt
        captionsVttPath = firstVttIn(opts.workDir) ?? candidate;
      }
    }
  }

  const skipLongMedia =
    !policy.focused &&
    captionsVttPath &&
    policy.longVideoTranscriptOnlyThresholdSec !== undefined &&
    meta.durationSec >= policy.longVideoTranscriptOnlyThresholdSec;
  if (skipLongMedia) {
    return {
      mediaPath: null,
      meta,
      captionsVttPath,
      isLocal: false,
      mediaSkippedReason: "long_captioned_video",
    };
  }

  // 3) download media (cap resolution to keep it light)
  const mediaPath = join(opts.workDir, "media.mp4");
  const dl = await exec(opts.ytDlpPath, [
    "-f", "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format", "mp4",
    "-o", mediaPath,
    "--no-warnings", source,
  ]);
  if (dl.code !== 0) {
    throw new Error(`yt-dlp download failed: ${dl.stderr.slice(0, 300)}`);
  }

  return { mediaPath, meta, captionsVttPath, isLocal: false };
}

function firstVttIn(dir: string): string | null {
  try {
    const f = readdirSync(dir).find((n) => n.endsWith(".vtt"));
    return f ? join(dir, f) : null;
  } catch { return null; }
}
