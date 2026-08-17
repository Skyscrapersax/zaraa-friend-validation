import "./chunk-R5U7XKVJ.js";

// src/plugins/codex-agent/index.ts
import { spawn } from "child_process";
import { relative, resolve as pathResolve, sep } from "path";
import { z } from "zod";
var TIMEOUT_MS = 3e5;
var DEFAULT_MODEL = "gpt-5.4";
var DEFAULT_CODEX_CLI = process.env.CODEX_CLI_PATH?.trim() || "codex";
function codexCliEnv() {
  return {
    ...process.env,
    ...process.env.OMP_NUM_THREADS ? {} : {
      OMP_NUM_THREADS: "1"
    },
    ...process.env.MKL_NUM_THREADS ? {} : {
      MKL_NUM_THREADS: "1"
    },
    ...process.env.OPENBLAS_NUM_THREADS ? {} : {
      OPENBLAS_NUM_THREADS: "1"
    }
  };
}
var ArgsSchema = z.object({
  task: z.string().min(1).max(32e3),
  workingDir: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional()
});
function createHandlers(tokenManager) {
  return {
    codex_agent: async (args) => {
      const parsed = ArgsSchema.parse(args);
      const { task, model: modelArg, reasoningEffort } = parsed;
      let cwd;
      if (parsed.workingDir) {
        const resolved = pathResolve(parsed.workingDir);
        const projectRoot = pathResolve(".");
        const rel = relative(projectRoot, resolved);
        const outOfRoot = rel === ".." || rel.startsWith(`..${sep}`);
        if (outOfRoot) {
          throw new Error(`workingDir must be within project root: ${parsed.workingDir}`);
        }
        cwd = resolved;
      }
      await tokenManager.getAccessToken();
      const model = modelArg || DEFAULT_MODEL;
      const cliArgs = [
        "exec",
        "--sandbox",
        "workspace-write",
        "--model",
        model
      ];
      if (reasoningEffort) {
        cliArgs.push("--config", `model_reasoning_effort="${reasoningEffort}"`);
      }
      if (cwd) {
        cliArgs.push("--cd", cwd);
      }
      cliArgs.push("--", task);
      return new Promise((resolve, reject) => {
        const proc = spawn(DEFAULT_CODEX_CLI, cliArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: codexCliEnv()
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => {
          stdout += d.toString();
        });
        proc.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error(
            `Codex CLI timed out after ${Math.round(TIMEOUT_MS / 6e4)} minutes`
          ));
        }, TIMEOUT_MS);
        proc.on("error", (err) => {
          clearTimeout(timer);
          if (err.message.includes("ENOENT")) {
            reject(new Error(
              "Codex CLI not available. Install with: npm install -g @anthropic-ai/codex"
            ));
          } else {
            reject(err);
          }
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(
              `Codex CLI exited with code ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`
            ));
          }
          resolve(stdout.trim());
        });
      });
    }
  };
}
export {
  createHandlers
};
