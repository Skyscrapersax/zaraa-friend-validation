import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/trust.ts
import { join } from "path";
import { loadTrustLadder, TaskStore, TrustLedger } from "@zaraa/core";
function renderTrustTable(statuses) {
  const lines = [
    "LANE                TIER  SCORE    EVENTS  LIMIT",
    "\u2500".repeat(72)
  ];
  for (const s of statuses) {
    const clamp = s.earnedTier > s.ceiling ? `  (earned T${s.earnedTier}, ceiling T${s.ceiling})` : "";
    lines.push(
      `${s.lane.padEnd(20)}T${s.tier}    ${s.score.toFixed(1).padEnd(9)}${String(s.eventCount).padEnd(8)}${s.limit}${clamp}`
    );
  }
  return lines.join("\n");
}
function openStore(argv) {
  let dataDir;
  const flagIndex = argv.indexOf("--data-dir");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    dataDir = argv[flagIndex + 1];
  }
  const dir = dataDir ?? join(resolveRuntimeHomeDir(), ".zaraa", "data");
  return new TaskStore({ path: join(dir, "tasks.db") });
}
async function runTrust(argv) {
  const store = openStore(argv);
  try {
    const ledger = new TrustLedger(store.getDatabase(), loadTrustLadder());
    const appended = ledger.refresh();
    console.log(renderTrustTable(ledger.laneStatus()));
    console.log(`
${appended} new outcome event(s) derived this run.`);
  } finally {
    store.close();
  }
}
export {
  renderTrustTable,
  runTrust
};
