import {
  canActAtLevel
} from "./chunk-T5UZVN2O.js";
import "./chunk-R5U7XKVJ.js";

// src/learning/trust-act-gate.ts
function classifyToolTrust(input) {
  const name = (input.toolName ?? "").toLowerCase();
  const type = (input.actionType ?? "").toLowerCase();
  const target = (input.target ?? "").toLowerCase();
  const blob = `${name} ${type} ${target} ${input.prompt ?? ""}`.toLowerCase();
  if (/\blive.?trade|autoexecute|withdraw|wire transfer|trade_set_limit.*paper_mode.?false\b/.test(blob)) {
    return { domain: "trading-paper", requiredLevel: 5 };
  }
  if (type.startsWith("trading.") || name.startsWith("trade_") || /\btrade_buy|trade_sell|trade_dex|trade_deploy\b/.test(name)) {
    if (type === "trading.execute" || /trade_buy|trade_sell|trade_dex_swap|trade_deploy_strategy/.test(name)) {
      return { domain: "trading-paper", requiredLevel: 3 };
    }
    return { domain: "trading-paper", requiredLevel: 2 };
  }
  if (type === "shell.exec" || type === "file.write" || type === "file.delete" || /self_edit|shell_|file_write|file_delete|launchctl|sudo|rm\s+-rf/.test(blob)) {
    return { domain: "system-change", requiredLevel: 4 };
  }
  if (/ableton|gui_ableton|mix |tempo|session|band /.test(blob)) {
    return { domain: "music-session", requiredLevel: 3 };
  }
  if (/premiere|final.?cut|davinci|gui_final|rough.?cut|video_/.test(blob)) {
    return { domain: "picture-edit", requiredLevel: 3 };
  }
  if (/pitch|outreach|invoice|sponsor|booking|deal_|offer sketch/.test(blob)) {
    return { domain: "creator-revenue", requiredLevel: 3 };
  }
  if (/poem|poetry|motif|lyric|creative.?joy|art.?direction|imsg_send_file/.test(blob)) {
    return { domain: "creative-craft", requiredLevel: 2 };
  }
  if (name === "imsg_send" || type === "messaging.send") {
    return { domain: "daily-ops", requiredLevel: 2 };
  }
  return { domain: "daily-ops", requiredLevel: 1 };
}
function evaluateTrustGate(state, classification) {
  const check = canActAtLevel(state, classification.domain, classification.requiredLevel);
  if (check.allowed) {
    return {
      decision: "allow",
      domain: classification.domain,
      requiredLevel: classification.requiredLevel,
      current: check.current
    };
  }
  if (classification.requiredLevel >= 5) {
    return {
      decision: "block",
      domain: classification.domain,
      requiredLevel: classification.requiredLevel,
      current: check.current,
      reason: check.reason,
      reasonCode: "trust_never_auto"
    };
  }
  return {
    decision: "review",
    domain: classification.domain,
    requiredLevel: classification.requiredLevel,
    current: check.current,
    reason: check.reason,
    reasonCode: "trust_level_insufficient"
  };
}
function gateActionByTrust(state, input) {
  return evaluateTrustGate(state, classifyToolTrust(input));
}
export {
  classifyToolTrust,
  evaluateTrustGate,
  gateActionByTrust
};
