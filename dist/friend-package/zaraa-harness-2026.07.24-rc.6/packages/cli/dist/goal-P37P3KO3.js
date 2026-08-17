import {
  compactHomePath
} from "./chunk-XSCLDVMG.js";
import "./chunk-F4ZXZMER.js";
import "./chunk-5Q7ELQ3Z.js";
import "./chunk-WWFZXCWT.js";
import {
  resolveCliConfigDir
} from "./chunk-DI2OPTT7.js";

// src/commands/goal.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
function readConfig(configDir) {
  const file = join(configDir, "zaraa.config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function slug(intent) {
  return intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "goal";
}
function formatGoalDisarmed(configFile, home) {
  return `Goal compiler is disarmed \u2014 set autonomy.goalCompiler (and autonomy.sustainment) to true
in ${compactHomePath(configFile, home)} and restart the daemon. Drop not written.`;
}
function formatGoalDropped(file, home) {
  return `Goal dropped: ${compactHomePath(file, home)}`;
}
function runGoalCommand(positionals, opts = {}) {
  const intent = positionals.join(" ").trim();
  if (!intent) {
    console.log(
      'Usage: zaraa goal "<one sentence goal>" [--check "<what proves it> :: <command>"] \u2026'
    );
    return 1;
  }
  const checks = (opts.checks ?? []).map((c) => c.trim()).filter(Boolean);
  if (checks.length === 0) {
    console.error(
      'No --check given: the goal cannot verify itself and will land in needs-clarification.\nAdd at least one, e.g. --check "gateway tests pass :: pnpm --filter @zaraa/core test"'
    );
    return 1;
  }
  const configDir = resolveCliConfigDir();
  if (readConfig(configDir).autonomy?.goalCompiler !== true) {
    console.error(formatGoalDisarmed(join(configDir, "zaraa.config.json")));
    return 1;
  }
  const dataDir = opts.dataDir ?? join(configDir, "data");
  const inbox = join(dataDir, "goals", "inbox");
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, `${opts.now ?? Date.now()}-${slug(intent)}.md`);
  const body = `${intent}

## Acceptance
${checks.map((c) => `- [ ] ${c}`).join("\n")}
`;
  writeFileSync(file, body, "utf8");
  console.log(formatGoalDropped(file));
  return 0;
}
export {
  formatGoalDisarmed,
  formatGoalDropped,
  runGoalCommand
};
