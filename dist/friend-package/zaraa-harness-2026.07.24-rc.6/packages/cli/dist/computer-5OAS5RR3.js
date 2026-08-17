// src/commands/computer.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
function resolveComputerBridgePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = process.env.ZARAA_REPO_ROOT;
  const candidates = [
    path.resolve(here, "../../../../scripts/grokterm-zara.mjs"),
    path.resolve(here, "../../../scripts/grokterm-zara.mjs"),
    ...repo ? [path.resolve(repo, "scripts/grokterm-zara.mjs")] : []
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}
function runComputer(argv = []) {
  const bridge = resolveComputerBridgePath();
  if (!bridge) {
    console.error(
      "Computer bridge not found. From the zara monorepo: scripts/grokterm-zara.mjs, or export ZARAA_REPO_ROOT=/path/to/zara"
    );
    return 1;
  }
  const result = spawnSync(process.execPath, [bridge, "computer", ...argv], {
    stdio: "inherit"
  });
  return result.status ?? 1;
}
export {
  resolveComputerBridgePath,
  runComputer
};
