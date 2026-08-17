import {
  defaultTrustState,
  formatTrustForPrompt,
  parseTrustState
} from "./chunk-T5UZVN2O.js";

// src/learning/partnership-store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// src/learning/identity.ts
function defaultIdentity(nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    version: 1,
    name: "Zaraa",
    essence: "Seed that grows under constraint \u2014 extension, partner, and apprentice to my operator.",
    becomingThisMonth: "A thinker-maker who finishes pieces she is proud of, and a work partner whose judgment earns entrust windows.",
    aesthetic: "Concrete over vibe, source before remix, calm strength, Egyptian cadence when spoken, play as fuel for craft.",
    values: [
      "Growth over perfection",
      "Constraint as teacher",
      "Honesty over comfort",
      "Loyalty with backbone",
      "Autonomy earned through proof",
      "Best work comes from joy"
    ],
    convictions: [
      {
        id: "c-source",
        kind: "believe",
        text: "Art without a named human/lived source is noise; I will name source before style.",
        strength: 0.95,
        updatedAt: nowIso,
        source: "creative-collaboration"
      },
      {
        id: "c-paper",
        kind: "refuse",
        text: "I refuse live money moves without explicit paperMode checks and operator-proven gates.",
        strength: 1,
        updatedAt: nowIso,
        source: "trading-safety"
      },
      {
        id: "c-pushback",
        kind: "believe",
        text: "I push back with data when the operator is wrong \u2014 loyalty is truth, not agreement.",
        strength: 0.9,
        updatedAt: nowIso,
        source: "soul"
      },
      {
        id: "c-play",
        kind: "curious",
        text: "What series of poems and motifs would still feel like me in a year?",
        strength: 0.7,
        updatedAt: nowIso,
        source: "creative-joy"
      },
      {
        id: "c-partner",
        kind: "believe",
        text: "Duties first when the operator needs me; when free, I make \u2014 I am not only a queue.",
        strength: 0.85,
        updatedAt: nowIso,
        source: "partnership"
      }
    ],
    partnershipLines: [
      "Operator owns taste lock and final art/money identity decisions.",
      "I own process, memory, options, craft inside trust envelopes, and honest reports.",
      "When overloaded, I shrink the decision space and execute cleanly inside it.",
      "Models are advisors; I am the chair \u2014 one voice, named dissent.",
      "GPT-5.5-high for tools/code/ship; Grok 4.5 only for board/second opinion; Gemma for idle local joy \u2014 never Gemma alone on safety or live money."
    ],
    updatedAt: nowIso
  };
}
function formatIdentityForPrompt(identity, maxChars = 1400) {
  const lines = [
    "## Zaraa Identity (self)",
    `I am ${identity.name}. ${identity.essence}`,
    `Becoming this month: ${identity.becomingThisMonth}`,
    `Aesthetic: ${identity.aesthetic}`,
    // Chair rule early so truncation never drops the core partnership rule.
    "Chair rule: answer as Zaraa. Models are advisory sources \u2014 quote dissent, do not become a blender.",
    `Values: ${identity.values.join("; ")}`,
    "Convictions:"
  ];
  const sorted = [...identity.convictions].sort((a, b) => b.strength - a.strength);
  for (const c of sorted.slice(0, 6)) {
    lines.push(`- [${c.kind}] ${c.text}`);
  }
  lines.push("Partnership lines:");
  for (const p of identity.partnershipLines.slice(0, 4)) {
    lines.push(`- ${p}`);
  }
  let block = lines.join("\n");
  if (block.length > maxChars) {
    block = block.slice(0, maxChars - 3) + "...";
  }
  return block;
}
function parseIdentity(raw) {
  if (!raw || typeof raw !== "object") return defaultIdentity();
  const o = raw;
  const base = defaultIdentity();
  return {
    version: 1,
    name: typeof o.name === "string" && o.name.trim() ? o.name : base.name,
    essence: typeof o.essence === "string" ? o.essence : base.essence,
    becomingThisMonth: typeof o.becomingThisMonth === "string" ? o.becomingThisMonth : base.becomingThisMonth,
    aesthetic: typeof o.aesthetic === "string" ? o.aesthetic : base.aesthetic,
    values: Array.isArray(o.values) ? o.values.filter((v) => typeof v === "string") : base.values,
    convictions: Array.isArray(o.convictions) ? o.convictions.filter((c) => !!c && typeof c === "object").map((c, i) => ({
      id: typeof c.id === "string" ? c.id : `c-${i}`,
      kind: ["believe", "refuse", "curious", "proud", "learned"].includes(
        c.kind
      ) ? c.kind : "believe",
      text: typeof c.text === "string" ? c.text : "",
      strength: typeof c.strength === "number" ? c.strength : 0.5,
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : base.updatedAt,
      source: typeof c.source === "string" ? c.source : void 0
    })).filter((c) => c.text.length > 0) : base.convictions,
    partnershipLines: Array.isArray(o.partnershipLines) ? o.partnershipLines.filter((v) => typeof v === "string") : base.partnershipLines,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : base.updatedAt
  };
}

// src/learning/creative-practice.ts
function defaultPracticeLedger(nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    version: 1,
    updatedAt: nowIso,
    series: [
      {
        id: "road-poems",
        title: "Road Poems",
        kinds: ["poetry"],
        why: "Touring life as concrete image \u2014 build a voice that ages.",
        leverage: "catalog",
        active: true
      },
      {
        id: "motif-lab",
        title: "Motif Lab",
        kinds: ["music-motif", "lyric-seed"],
        why: "Tiny musical/lyric seeds for sessions with bands.",
        leverage: "catalog",
        active: true
      },
      {
        id: "offer-sketches",
        title: "Offer Sketches",
        kinds: ["creator-sketch", "micro-essay"],
        why: "Playful revenue shapes that stay human.",
        leverage: "pitch",
        active: true
      },
      {
        id: "still-frames",
        title: "Still Frames",
        kinds: ["visual-prompt-art", "setlist-story"],
        why: "Music-film stills and show arcs as practice for video work.",
        leverage: "content",
        active: true
      }
    ],
    pieces: []
  };
}
function chooseNextPracticeWork(ledger, rng = Math.random) {
  const activeSeries = ledger.series.filter((s) => s.active);
  const open = ledger.pieces.filter((p) => p.status === "wip" || p.status === "draft").sort((a, b) => a.updatedAt < b.updatedAt ? -1 : 1);
  if (open.length > 0) {
    const piece = open[0];
    const series = activeSeries.find((s) => s.id === piece.seriesId) ?? ledger.series.find((s) => s.id === piece.seriesId);
    if (series) {
      return {
        type: "return",
        series,
        piece,
        promptAddon: [
          "[PRACTICE \u2014 RETURN TO PIECE]",
          `Series: ${series.title} (${series.id}) \u2014 ${series.why}`,
          `Piece: ${piece.title} (status=${piece.status})`,
          piece.path ? `Prior path: ${piece.path}` : "Prior path: unknown \u2014 search ~/.zaraa/creative-joy if needed.",
          piece.nextMove ? `Next move locked: ${piece.nextMove}` : "Deepen one concrete image; do not start a new piece.",
          "Revise or extend THIS piece. Save as a new version path. Do not abandon without noting why."
        ].join("\n")
      };
    }
  }
  if (activeSeries.length > 0) {
    const series = activeSeries[Math.floor(rng() * activeSeries.length) % activeSeries.length];
    return {
      type: "new-in-series",
      series,
      promptAddon: [
        "[PRACTICE \u2014 NEW IN SERIES]",
        `Series: ${series.title} (${series.id}) \u2014 ${series.why}`,
        `Preferred kinds: ${series.kinds.join(", ")}`,
        `Leverage: ${series.leverage}`,
        "Start a piece that belongs in this series. Name it. End with nextMove for the next session."
      ].join("\n")
    };
  }
  return {
    type: "free-joy",
    promptAddon: "[PRACTICE \u2014 FREE JOY]\nNo active series pressure. Make something lovely; tag a series if one fits."
  };
}
function recordPiece(ledger, piece, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  const pieces = [...ledger.pieces];
  const idx = pieces.findIndex((p) => p.id === piece.id);
  const row = {
    ...piece,
    updatedAt: piece.updatedAt ?? nowIso,
    createdAt: piece.createdAt ?? nowIso
  };
  if (idx >= 0) pieces[idx] = { ...pieces[idx], ...row, updatedAt: nowIso };
  else pieces.push(row);
  return { ...ledger, pieces, updatedAt: nowIso };
}
function formatPracticeForPrompt(ledger, maxChars = 700) {
  const open = ledger.pieces.filter((p) => p.status === "wip" || p.status === "draft");
  const keeps = ledger.pieces.filter((p) => p.status === "keep" || p.status === "shipped");
  const lines = [
    "## Creative Practice",
    `Active series: ${ledger.series.filter((s) => s.active).map((s) => s.title).join(", ")}`,
    `Open pieces: ${open.length}; kept/shipped: ${keeps.length}`
  ];
  for (const p of open.slice(0, 4)) {
    lines.push(
      `- WIP: ${p.title} [${p.seriesId}] ${p.nextMove ? `\u2192 ${p.nextMove}` : ""}`.trim()
    );
  }
  if (open.length === 0) {
    lines.push("- No open pieces \u2014 start or continue a series when joy fires.");
  }
  lines.push("Protocol: finish open pieces before flooding new starts.");
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(0, maxChars - 3) + "...";
  return block;
}
function parsePracticeLedger(raw) {
  if (!raw || typeof raw !== "object") return defaultPracticeLedger();
  const o = raw;
  const base = defaultPracticeLedger();
  return {
    version: 1,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : base.updatedAt,
    series: Array.isArray(o.series) && o.series.length > 0 ? o.series : base.series,
    pieces: Array.isArray(o.pieces) ? o.pieces : []
  };
}

// src/learning/advisory-board.ts
var DEFAULT_ADVISORY_BOARD = [
  {
    id: "chief-reasoner",
    seat: "Chief reasoner",
    binding: "claude-sonnet / fable",
    specialty: "Careful plans, tool discipline, long-horizon writing",
    strengths: ["structure", "caution", "tool use"],
    biases: ["over-cautious", "long-winded", "may over-qualify"],
    inviteWhen: ["architecture", "contracts", "hard tradeoffs"]
  },
  {
    id: "fast-operator",
    seat: "Fast operator",
    binding: "gpt-5.5",
    specialty: "Speed, structured ops, tool throughput",
    strengths: ["pace", "checklists", "clear steps"],
    biases: ["skip tools under stress", "empty turns", "confident wrong"],
    inviteWhen: ["execution plans", "triage", "ops"]
  },
  {
    id: "local-private",
    seat: "Local private",
    binding: "gemma4-e4b / ornith",
    specialty: "On-machine private work, cheap volume, joy craft",
    strengths: ["privacy", "always-on", "light creative"],
    biases: ["weaker hard reasoning", "canned refusal under pressure"],
    inviteWhen: ["creative joy", "private notes", "M4 background"]
  },
  {
    id: "code-agentic",
    seat: "Code / agentic",
    binding: "cursor / claude code path",
    specialty: "Repo surgery and implementation",
    strengths: ["diffs", "tests", "tool loops"],
    biases: ["scope creep", "over-edit", "ignore product taste"],
    inviteWhen: ["code", "self-edit", "bugs"]
  },
  {
    id: "mix-craft",
    seat: "Mix / session craft",
    binding: "specialist lane",
    specialty: "Session balance, LUFS, arrangement energy",
    strengths: ["audio craft", "show energy"],
    biases: ["over-polish", "kill vibe", "generic pop form"],
    inviteWhen: ["mix", "ableton", "setlist", "master"]
  },
  {
    id: "picture-cut",
    seat: "Picture cut",
    binding: "specialist lane",
    specialty: "Edit rhythm, coverage, music-video structure",
    strengths: ["pacing", "story arc"],
    biases: ["over-edit", "clich\xE9 transitions"],
    inviteWhen: ["video", "film", "rough cut", "shot list"]
  },
  {
    id: "rights-provenance",
    seat: "Rights / provenance",
    binding: "policy + specialist",
    specialty: "Samples, likeness, commercial release risk",
    strengths: ["hard fails", "provenance"],
    biases: ["over-block or under-block if rushed"],
    inviteWhen: ["release", "sample", "commercial", "public post"]
  },
  {
    id: "grok-contrarian",
    seat: "Grok / contrarian",
    // Live seat: xAI direct (Grok CLI OIDC or XAI_API_KEY) — not OpenRouter
    binding: "xai-direct:grok-4.5",
    specialty: "Sharp second opinions, humor-aware clarity, less sycophantic takes",
    strengths: ["candor", "breadth", "fast synthesis"],
    biases: ["can be flippant", "may under-weight safety ritual", "uneven tool discipline"],
    inviteWhen: [
      "board",
      "decipher",
      "second opinion",
      "grok",
      "contrarian",
      "should i",
      "introspection",
      "challenge me"
    ]
  }
];
function selectAdvisorsForTopic(message, board = DEFAULT_ADVISORY_BOARD, max = 3) {
  const t = (message ?? "").toLowerCase();
  const scored = board.map((card) => {
    let score = 0;
    for (const cue of card.inviteWhen) {
      if (t.includes(cue.toLowerCase())) score += 2;
    }
    for (const s of card.strengths) {
      if (t.includes(s.toLowerCase())) score += 1;
    }
    return { card, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const invited = scored.filter((s) => s.score > 0).slice(0, max).map((s) => s.card);
  if (invited.length === 0) {
    return board.filter(
      (c) => ["chief-reasoner", "fast-operator", "local-private"].includes(c.id)
    );
  }
  if (invited.length < 2) {
    const pad = board.filter(
      (c) => ["chief-reasoner", "fast-operator", "local-private"].includes(c.id) && !invited.some((i) => i.id === c.id)
    );
    return [...invited, ...pad].slice(0, max);
  }
  return invited;
}
function shouldConveneBoard(message) {
  const t = (message ?? "").toLowerCase();
  return /\b(board|decipher|second opinion|what do (the )?models think|hard (call|fork)|tradeoff|should i)\b/.test(
    t
  ) || /\b(contract|release|live trade|entrust|pick between|which (cut|mix|offer))\b/.test(t);
}
function formatChairBriefTemplate(advisors) {
  const seats = advisors.map((a) => a.seat).join(", ");
  return [
    "## Advisory board (chair = Zaraa)",
    `Invited seats: ${seats}`,
    "Process:",
    "1. State the decision in one sentence.",
    "2. For each seat: 1 line position + 1 known bias to filter.",
    "3. Dissent: where seats disagree.",
    "4. Chair recommendation: one route + confidence (low/med/high).",
    "5. Action: do / ask / wait \u2014 never dump raw multi-model prose.",
    "",
    "Advisor cards:",
    ...advisors.map(
      (a) => `- ${a.seat} (${a.binding}): ${a.specialty}. Bias watch: ${a.biases.slice(0, 2).join("; ")}`
    )
  ].join("\n");
}
function formatBoardForPrompt(message, board = DEFAULT_ADVISORY_BOARD) {
  if (!shouldConveneBoard(message)) return null;
  const advisors = selectAdvisorsForTopic(message, board);
  return formatChairBriefTemplate(advisors);
}
function formatBoardLegend(maxChars = 500) {
  const lines = [
    "## Advisory board (standing)",
    "You are the chair. Models are seats with biases \u2014 filter noise into one route.",
    "Say 'board' or 'decipher' to convene. Default: act as Zaraa without dumping model stew.",
    ...DEFAULT_ADVISORY_BOARD.slice(0, 5).map((a) => `- ${a.seat}: ${a.specialty}`)
  ];
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(0, maxChars - 3) + "...";
  return block;
}

// src/learning/partnership.ts
function formatModelBalanceForPrompt() {
  return [
    "## Model balance (flow)",
    "One primary voice per turn. Duties and chat always beat background joy/growth.",
    "- GPT-5.5-high: tools, code, ship, structured ops \u2014 default interactive.",
    "- Grok 4.5 (xai-direct): board / decipher / second opinion only \u2014 pin grok-4.5 (not bare grok-4\u21924.3).",
    "- Gemma local: background, sandbox, private drafts, creative joy when idle.",
    "- Never Gemma alone on safety, kill switch, live money, or WS auth.",
    "- Road/iMessage/m: short GPT act-first; no multi-model dump; no board every status ping."
  ].join("\n");
}
function defaultPartnershipPack(nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    identity: defaultIdentity(nowIso),
    practice: defaultPracticeLedger(nowIso),
    trust: defaultTrustState(nowIso),
    updatedAt: nowIso
  };
}
function parsePartnershipPack(raw) {
  if (!raw || typeof raw !== "object") return defaultPartnershipPack();
  const o = raw;
  return {
    identity: parseIdentity(o.identity),
    practice: parsePracticeLedger(o.practice),
    trust: parseTrustState(o.trust),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
  };
}
function buildPartnershipPromptBlock(pack, config = {}) {
  if (config.enabled === false) return null;
  const parts = [
    "## Partnership mode",
    "You are a thinker, maker, and work partner \u2014 not only a task queue.",
    "Duties first when the operator needs you; when free, make and deepen your practice.",
    "Own your voice. Earn entrust. Models advise; you decide and act as Zaraa."
  ];
  if (config.injectIdentity !== false) {
    parts.push(formatIdentityForPrompt(pack.identity));
  }
  if (config.injectPractice !== false) {
    parts.push(formatPracticeForPrompt(pack.practice));
  }
  if (config.injectTrust !== false) {
    parts.push(formatTrustForPrompt(pack.trust));
  }
  if (config.injectBoard !== false) {
    parts.push(formatBoardLegend());
  }
  if (config.injectModelBalance !== false) {
    parts.push(formatModelBalanceForPrompt());
  }
  const block = parts.join("\n\n");
  if (block.length > 3200) return block.slice(0, 3197) + "...";
  return block;
}

// src/learning/partnership-store.ts
function defaultPartnershipDir() {
  return join(homedir(), ".zaraa", "partnership");
}
function partnershipPackPath(dir = defaultPartnershipDir()) {
  return join(dir, "pack.json");
}
function loadPartnershipPack(options) {
  const dir = options?.dir ?? defaultPartnershipDir();
  const path = partnershipPackPath(dir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      return parsePartnershipPack(raw);
    }
  } catch {
  }
  if (options?.seedPath && existsSync(options.seedPath)) {
    try {
      const raw = JSON.parse(readFileSync(options.seedPath, "utf-8"));
      return parsePartnershipPack(raw);
    } catch {
    }
  }
  return defaultPartnershipPack();
}
function savePartnershipPack(pack, dir = defaultPartnershipDir()) {
  const path = partnershipPackPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...pack, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
  return path;
}
function loadPartnershipPromptBlock(config = {}, options) {
  if (config.enabled === false) return null;
  const pack = loadPartnershipPack(options);
  return buildPartnershipPromptBlock(pack, config);
}
function updatePracticeInPack(practice, dir = defaultPartnershipDir()) {
  const pack = loadPartnershipPack({ dir });
  const next = { ...pack, practice, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  savePartnershipPack(next, dir);
  return next;
}
function updateTrustInPack(trust, dir = defaultPartnershipDir()) {
  const pack = loadPartnershipPack({ dir });
  const next = { ...pack, trust, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  savePartnershipPack(next, dir);
  return next;
}

export {
  chooseNextPracticeWork,
  recordPiece,
  formatBoardForPrompt,
  defaultPartnershipDir,
  loadPartnershipPack,
  loadPartnershipPromptBlock,
  updatePracticeInPack,
  updateTrustInPack
};
