// src/learning/trust-ladder.ts
var DEFAULT_LEVELS = {
  "daily-ops": 2,
  "creative-craft": 2,
  "music-session": 1,
  "picture-edit": 1,
  "creator-revenue": 1,
  "trading-paper": 2,
  "system-change": 1
};
var HARD_CAP = {
  "system-change": 2,
  "trading-paper": 3
};
function defaultTrustState(nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  const domains = Object.keys(DEFAULT_LEVELS).map((domain) => ({
    domain,
    level: DEFAULT_LEVELS[domain],
    keeps: 0,
    modifies: 0,
    regrets: 0
  }));
  return { version: 1, domains, updatedAt: nowIso };
}
function getDomainTrust(state, domain) {
  return state.domains.find((d) => d.domain === domain) ?? {
    domain,
    level: DEFAULT_LEVELS[domain] ?? 1,
    keeps: 0,
    modifies: 0,
    regrets: 0
  };
}
function canActAtLevel(state, domain, requiredLevel) {
  if (requiredLevel >= 5) {
    return {
      allowed: false,
      reason: "L5 never-auto \u2014 human required",
      current: getDomainTrust(state, domain).level
    };
  }
  const current = getDomainTrust(state, domain).level;
  if (current >= requiredLevel) {
    return { allowed: true, reason: `trusted at L${current} \u2265 L${requiredLevel}`, current };
  }
  return {
    allowed: false,
    reason: `need L${requiredLevel}, have L${current} in ${domain}`,
    current
  };
}
function applyTrustOutcome(state, domain, outcome, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  const domains = state.domains.map((d) => ({ ...d }));
  let row = domains.find((d) => d.domain === domain);
  if (!row) {
    row = {
      domain,
      level: DEFAULT_LEVELS[domain] ?? 1,
      keeps: 0,
      modifies: 0,
      regrets: 0
    };
    domains.push(row);
  }
  row.lastOutcome = outcome;
  row.lastOutcomeAt = nowIso;
  if (outcome === "kept") {
    row.keeps += 1;
    const cap = HARD_CAP[domain] ?? 4;
    if (row.keeps >= 5 && row.regrets === 0 && row.level < cap && row.level < 4) {
      row.level = row.level + 1;
      row.keeps = 0;
      row.notes = `Auto-rose to L${row.level} after sustained keeps`;
    }
  } else if (outcome === "modified") {
    row.modifies += 1;
  } else if (outcome === "regretted") {
    row.regrets += 1;
    if (row.level > 0) {
      row.level = row.level - 1;
      row.notes = `Dropped to L${row.level} after regret`;
    }
    row.keeps = 0;
  }
  return { version: 1, domains, updatedAt: nowIso };
}
function formatTrustForPrompt(state, maxChars = 600) {
  const lines = ["## Trust ladder (earned agency)", "Act only within level; L5 domains need human."];
  for (const d of state.domains) {
    lines.push(
      `- ${d.domain}: L${d.level} (kept ${d.keeps}/mod ${d.modifies}/regret ${d.regrets})`
    );
  }
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(0, maxChars - 3) + "...";
  return block;
}
function parseTrustState(raw) {
  if (!raw || typeof raw !== "object") return defaultTrustState();
  const o = raw;
  const base = defaultTrustState();
  if (!Array.isArray(o.domains)) return base;
  return {
    version: 1,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : base.updatedAt,
    domains: o.domains
  };
}

export {
  defaultTrustState,
  canActAtLevel,
  applyTrustOutcome,
  formatTrustForPrompt,
  parseTrustState
};
