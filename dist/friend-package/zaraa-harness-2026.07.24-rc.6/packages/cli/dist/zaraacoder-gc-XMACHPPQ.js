// src/commands/zaraacoder-gc.ts
import { execFile } from "child_process";
import { resolve, sep } from "path";
import { promisify } from "util";
import {
  findZaraacoderWorktreeGcCandidates,
  removeZaraacoderWorktreeGcCandidate
} from "@zaraa/core";
var execFileAsync = promisify(execFile);
var DEFAULT_DRY_RUN_LIMIT = 20;
function visibleGcCandidates(candidates, apply) {
  return apply ? candidates : candidates.slice(0, DEFAULT_DRY_RUN_LIMIT);
}
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
async function protectedRepositoryPaths(worktreeRoot) {
  const paths = [];
  const cwd = resolve(process.cwd());
  const root = resolve(worktreeRoot);
  if (cwd === root || cwd.startsWith(`${root}${sep}`)) paths.push(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd()
    });
    if (stdout.trim()) paths.push(stdout.trim());
  } catch {
  }
  return paths;
}
async function runWorktreeGc(input) {
  const protectedPaths = await protectedRepositoryPaths(input.args.worktreeRoot);
  const candidates = await findZaraacoderWorktreeGcCandidates({
    worktreeRoot: input.args.worktreeRoot,
    sessions: await input.listSessions(),
    protectedPaths,
    ...input.nowMs === void 0 ? {} : { nowMs: input.nowMs }
  });
  const candidateBytes = candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0);
  const mode = input.args.apply ? "apply" : "dry-run";
  input.io.log(
    candidates.length === 0 ? `GC \xB7 ${mode} \xB7 clean` : `GC \xB7 ${mode} \xB7 ${candidates.length} worktree(s) \xB7 ${formatBytes(candidateBytes)}`
  );
  const visibleCandidates = visibleGcCandidates(candidates, input.args.apply);
  if (visibleCandidates.length) {
    input.io.log(
      input.args.apply ? "  removing:" : `  candidates (${visibleCandidates.length} shown):`
    );
  }
  for (const candidate of visibleCandidates) {
    const phase = candidate.phase ?? "\u2014";
    const reason = candidate.reason ?? "stale";
    const id = candidate.sessionId ? candidate.sessionId.slice(0, 8) : "no-session";
    input.io.log(
      `  \xB7 ${formatBytes(candidate.sizeBytes).padStart(7)}  ${phase}  ${id}  ${reason}`
    );
    input.io.log(`    ${candidate.path}`);
  }
  if (visibleCandidates.length < candidates.length) {
    input.io.log(
      `  \u2026 +${candidates.length - visibleCandidates.length} more (use --apply only when policy is clear)`
    );
  }
  if (!input.args.apply) {
    if (candidates.length === 0) {
      input.io.log("Next: zaraacoder list");
    } else {
      input.io.log("  nothing deleted (dry-run)");
      input.io.log("Next: zaraacoder gc --apply   # deletes all candidates above");
    }
    return 0;
  }
  let removed = 0;
  let removedBytes = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await removeZaraacoderWorktreeGcCandidate({
        worktreeRoot: input.args.worktreeRoot,
        worktreePath: candidate.path,
        sessions: await input.listSessions(),
        protectedPaths,
        ...input.nowMs === void 0 ? {} : { nowMs: input.nowMs }
      });
      if (!result.removed) {
        failed += 1;
        input.io.error(`  \xD7 skip ${candidate.path} \xB7 ${result.reason}`);
        continue;
      }
      removed += 1;
      removedBytes += candidate.sizeBytes;
      input.io.log(`  \u2713 removed ${formatBytes(candidate.sizeBytes)} \xB7 ${candidate.path}`);
    } catch (error) {
      failed += 1;
      input.io.error(
        `  \xD7 fail ${candidate.path} \xB7 ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  input.io.log(`GC \xB7 done \xB7 removed ${removed} \xB7 ${formatBytes(removedBytes)}${failed ? ` \xB7 ${failed} failed` : ""}`);
  input.io.log("Next: zaraacoder list");
  return failed === 0 ? 0 : 1;
}
export {
  runWorktreeGc,
  visibleGcCandidates
};
