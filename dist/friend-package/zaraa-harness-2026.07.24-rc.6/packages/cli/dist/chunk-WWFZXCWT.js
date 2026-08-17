// src/commands/reminders-tcc.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
function classifyRemindersTccDoctorCheck(report = {}) {
  if (report.platform && report.platform !== "darwin") {
    return {
      status: "warn",
      detail: "Reminders TCC is macOS-only \u2014 Apple provider skipped on this host.",
      critical: false
    };
  }
  if (report.granted === true && report.calendar?.status === "granted" && report.reminders?.status === "granted") {
    return {
      status: "pass",
      detail: report.doctorLine ?? "Calendar + Reminders Automation granted for this binary",
      critical: false
    };
  }
  return {
    status: "warn",
    detail: report.doctorLine ?? "Calendar/Reminders TCC not granted. Human: System Settings \u2192 Privacy & Security \u2192 Automation / Calendars / Reminders, then restart the daemon.",
    critical: false
  };
}
function remindersTccDoctorProbeArgs() {
  return ["--json", "--no-launch"];
}
function resolveRemindersTccProbePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = process.env.ZARAA_REPO_ROOT;
  const candidates = [
    path.resolve(here, "../../../../scripts/zaraa-reminders-tcc-probe.mjs"),
    path.resolve(here, "../../../scripts/zaraa-reminders-tcc-probe.mjs"),
    ...repo ? [path.resolve(repo, "scripts/zaraa-reminders-tcc-probe.mjs")] : []
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}
function runRemindersTcc(argv = []) {
  const probe = resolveRemindersTccProbePath();
  if (!probe) {
    console.error(
      "Reminders TCC probe not found. From the zara monorepo run: pnpm -s zaraa:reminders-tcc, or export ZARAA_REPO_ROOT=/path/to/zara"
    );
    return 1;
  }
  const result = spawnSync(process.execPath, [probe, ...argv], { stdio: "inherit" });
  return result.status ?? 1;
}

export {
  classifyRemindersTccDoctorCheck,
  remindersTccDoctorProbeArgs,
  resolveRemindersTccProbePath,
  runRemindersTcc
};
