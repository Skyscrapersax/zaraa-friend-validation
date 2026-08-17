/**
 * Duration-aware frame budget, ported from bradautomates/claude-video.
 * Hard ceilings: fps ≤ 2, frames ≤ maxFrames.
 */
export function computeFrameBudget(
  durationSec: number,
  maxFrames: number,
): { targetFrames: number; fps: number } {
  const d = Math.max(durationSec, 0);
  let target: number;
  if (d <= 30) target = 30;
  else if (d <= 60) target = 40;
  else if (d <= 180) target = 60;
  else if (d <= 600) target = 80;
  else target = 100;

  target = Math.max(1, Math.min(target, maxFrames));
  const fps = Math.min(2, target / Math.max(d, 1));
  return { targetFrames: target, fps };
}
