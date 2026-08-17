import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { Exec } from "./exec.js";
import type { Frame } from "./types.js";
import { computeFrameBudget } from "./frame-budget.js";

interface FramesInput {
  mediaPath: string;
  durationSec: number;
  startSec?: number;
  endSec?: number;
  maxFrames: number;
  resolution: number;
  workDir: string;
  ffmpegPath: string;
}

/** Injectable lister so tests don't touch the filesystem. */
export type ListFrames = (dir: string) => string[];
const defaultList: ListFrames = (dir) =>
  readdirSync(dir).filter((n) => /^frame-\d+\.jpg$/.test(n)).sort();

export async function extractFrames(
  input: FramesInput,
  exec: Exec,
  listFrames: ListFrames = defaultList,
): Promise<Frame[]> {
  const focused = input.startSec !== undefined || input.endSec !== undefined;
  const start = Math.max(0, input.startSec ?? 0);
  const end = Math.min(input.endSec ?? input.durationSec, input.durationSec);
  const window = focused ? Math.max(1, end - start) : Math.max(1, input.durationSec);
  const { fps } = computeFrameBudget(window, input.maxFrames);

  const pattern = join(input.workDir, "frame-%04d.jpg");
  const args = [
    "-y",
    ...(focused ? ["-ss", String(start), "-to", String(end)] : []),
    "-i", input.mediaPath,
    "-vf", `fps=${fps},scale=${input.resolution}:-1`,
    "-frames:v", String(input.maxFrames),
    "-qscale:v", "3",
    pattern,
  ];
  const res = await exec(input.ffmpegPath, args, { timeoutMs: 300_000 });
  if (res.code !== 0) return [];

  const names = listFrames(input.workDir);
  return names.map((name, i) => ({
    path: join(input.workDir, name),
    timestampSec: start + i / fps,
  }));
}
