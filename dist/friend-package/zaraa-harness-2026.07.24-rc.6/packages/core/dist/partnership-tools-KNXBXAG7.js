import {
  defaultPartnershipDir,
  loadPartnershipPack,
  updateTrustInPack
} from "./chunk-O5EKXMNS.js";
import {
  applyTrustOutcome
} from "./chunk-T5UZVN2O.js";
import "./chunk-R5U7XKVJ.js";

// src/learning/partnership-tools.ts
var TRUST_DOMAINS = [
  "daily-ops",
  "creative-craft",
  "music-session",
  "picture-edit",
  "creator-revenue",
  "trading-paper",
  "system-change"
];
var TRUST_OUTCOMES = ["kept", "modified", "regretted", "blocked"];
var manifest = {
  name: "partnership",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["assistant.partnership"],
  trust: "core",
  tools: [
    {
      name: "trust_record_outcome",
      description: "Close out a trust/entrust decision: kept (she got it right), modified (operator changed it), regretted (wrong call), or blocked. Updates the trust ladder so agency is earned.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: TRUST_DOMAINS,
            description: "Trust domain the decision belonged to"
          },
          outcome: {
            type: "string",
            enum: TRUST_OUTCOMES,
            description: "How the decision turned out"
          },
          note: {
            type: "string",
            description: "Optional short note for the pack (what happened)"
          }
        },
        required: ["domain", "outcome"]
      },
      requiresApproval: false
    },
    {
      name: "trust_status",
      description: "Show current trust ladder levels and keep/modify/regret counts per domain.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    }
  ]
};
function parseDomain(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (TRUST_DOMAINS.includes(v)) return v;
  throw new Error(`domain must be one of: ${TRUST_DOMAINS.join(", ")}`);
}
function parseOutcome(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (TRUST_OUTCOMES.includes(v)) return v;
  throw new Error(`outcome must be one of: ${TRUST_OUTCOMES.join(", ")}`);
}
function createHandlers(deps = {}) {
  const dir = deps.dir ?? defaultPartnershipDir();
  return {
    trust_record_outcome: async (args) => {
      const domain = parseDomain(args.domain);
      const outcome = parseOutcome(args.outcome);
      const note = typeof args.note === "string" ? args.note.trim() : "";
      const pack = loadPartnershipPack({ dir, seedPath: deps.seedPath });
      let next = applyTrustOutcome(pack.trust, domain, outcome);
      if (note) {
        const domains = next.domains.map(
          (d) => d.domain === domain ? { ...d, notes: note.slice(0, 240) } : d
        );
        next = { ...next, domains };
      }
      updateTrustInPack(next, dir);
      const row = next.domains.find((d) => d.domain === domain);
      return JSON.stringify({
        ok: true,
        domain,
        outcome,
        level: row?.level ?? null,
        keeps: row?.keeps ?? 0,
        modifies: row?.modifies ?? 0,
        regrets: row?.regrets ?? 0,
        notes: row?.notes ?? null
      });
    },
    trust_status: async (_args) => {
      const pack = loadPartnershipPack({ dir, seedPath: deps.seedPath });
      return JSON.stringify({
        updatedAt: pack.trust.updatedAt,
        domains: pack.trust.domains.map((d) => ({
          domain: d.domain,
          level: d.level,
          keeps: d.keeps,
          modifies: d.modifies,
          regrets: d.regrets,
          lastOutcome: d.lastOutcome ?? null,
          notes: d.notes ?? null
        }))
      });
    }
  };
}
export {
  createHandlers,
  manifest
};
