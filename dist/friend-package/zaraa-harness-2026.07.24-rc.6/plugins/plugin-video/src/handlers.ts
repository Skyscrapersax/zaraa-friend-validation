import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import type { Degradation, Frame, SttSettings, VlmSettings } from "./types.js";
import { acquireVideo } from "./acquire.js";
import { extractFrames, type ListFrames } from "./frames.js";
import { getTranscript } from "./transcript.js";
import { describeFrames } from "./vision.js";
import { buildReport } from "./report.js";

type Handler = (args: Record<string, unknown>, context?: unknown) => Promise<unknown>;
const LONG_VIDEO_TRANSCRIPT_ONLY_THRESHOLD_SEC = 30 * 60;

export interface VideoHandlerDeps {
  exec: Exec;
  fetchFn: typeof fetch;
  vlm: VlmSettings;
  stt: SttSettings;
  frameBudget: number;
  resolution: number;
  batchSize: number;
  ytDlpPath: string;
  ffmpegPath: string;
  makeWorkDir?: () => string;
  cleanup?: (dir: string) => void;
  // test seams (optional)
  _listFrames?: ListFrames;
  _readImageB64?: (p: string) => string;
  _readFile?: (p: string) => string;
  _readBinary?: (p: string) => Buffer;
}

export function createVideoHandlers(deps: VideoHandlerDeps): Record<string, Handler> {
  const makeWorkDir = deps.makeWorkDir ?? (() => mkdtempSync(join(tmpdir(), "zaraa-video-")));
  const cleanup = deps.cleanup ?? ((dir: string) => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  return {
    watch_video: async (args) => {
      const source = String((args as { source?: unknown }).source ?? "").trim();
      if (!source) return { error: "watch_video requires a 'source' (URL or local path)." };

      // Preflight: check required binaries before creating a workDir
      const isUrl = /^https?:\/\//i.test(source);
      const ffmpegCheck = await deps.exec(deps.ffmpegPath, ["-version"]);
      if (ffmpegCheck.errorCode === "ENOENT") {
        return { error: `ffmpeg not found on PATH — install with: brew install ffmpeg` };
      }
      if (isUrl) {
        const ytDlpCheck = await deps.exec(deps.ytDlpPath, ["--version"]);
        if (ytDlpCheck.errorCode === "ENOENT") {
          return { error: `yt-dlp not found on PATH — install with: brew install yt-dlp` };
        }
      }

      const question = (args as { question?: string }).question;
      const startSec = (args as { start?: number }).start;
      const endSec = (args as { end?: number }).end;
      const maxFrames = Math.min(100, Number((args as { maxFrames?: number }).maxFrames ?? deps.frameBudget));
      const resolution = ((args as { resolution?: number }).resolution ?? deps.resolution) as 512 | 1024;

      const workDir = makeWorkDir();
      const degradations: Degradation[] = [];

      try {
        // 1) acquire
        const focused = startSec !== undefined || endSec !== undefined;
        const acq = await acquireVideo(
          source,
          { workDir, ytDlpPath: deps.ytDlpPath, ffmpegPath: deps.ffmpegPath },
          deps.exec,
          {
            focused,
            longVideoTranscriptOnlyThresholdSec: LONG_VIDEO_TRANSCRIPT_ONLY_THRESHOLD_SEC,
          },
        );

        // no_captions when URL source had no subtitles
        if (!acq.isLocal && !acq.captionsVttPath) {
          degradations.push("no_captions");
        }
        if (acq.mediaSkippedReason === "long_captioned_video") {
          degradations.push("visual_skipped_long_video");
        }

        // 2) frames
        let frames: Frame[] = [];
        if (acq.mediaPath) {
          frames = await extractFrames(
            { mediaPath: acq.mediaPath, workDir, maxFrames, resolution, startSec, endSec, ffmpegPath: deps.ffmpegPath, durationSec: acq.meta.durationSec },
            deps.exec,
            deps._listFrames,
          );
        }

        // 3) transcript
        const transcript = await getTranscript(
          { captionsVttPath: acq.captionsVttPath, mediaPath: acq.mediaPath ?? "", startSec, endSec, stt: deps.stt, ffmpegPath: deps.ffmpegPath, workDir },
          { exec: deps.exec, fetchFn: deps.fetchFn, readFile: deps._readFile, readBinary: deps._readBinary },
        );
        if (transcript.source === "none") degradations.push("stt_offline");

        // 4) vision
        const { scenes, visionOffline } = await describeFrames(
          { frames, segments: transcript.segments, question, vlm: deps.vlm, batchSize: deps.batchSize },
          { fetchFn: deps.fetchFn, readImageB64: deps._readImageB64 },
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
    },
  };
}
