import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  errorCode?: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

/** Default Exec — wraps execFile, never rejects; returns code instead. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const errCode = err ? (err as { code?: unknown }).code : undefined;
        const code =
          err && typeof errCode === "number"
            ? errCode
            : err
              ? 1
              : 0;
        const errorCode = typeof errCode === "string" ? errCode : undefined;
        resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code, errorCode });
      },
    );
  });
