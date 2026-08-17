// src/runtime/prompt-guards.ts
var DEFAULT_MAX_TASK_PROMPT_UTF8_BYTES = 56e3;
var DEFAULT_MAX_LEARNING_TASK_PROMPT_UTF8_BYTES = 18e3;
var DEFAULT_LEARNING_PLAN_SECTION_UTF8_BYTES = 1600;
var ZODIAC_PLANNER_FIELD_MAX_BYTES = 8192;
function capUtf8String(s, maxBytes) {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end - 1] & 192) === 128) {
    end--;
  }
  return `${buf.subarray(0, end).toString("utf8")}

[Prompt truncated to byte budget]`;
}
function dedupeConsecutiveLines(block) {
  const lines = block.split("\n");
  const out = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1] !== line) {
      out.push(line);
    }
  }
  return out.join("\n");
}
function dedupeBrainstormInTaskPrompt(taskPrompt) {
  const header = "## Brainstorm\n";
  const start = taskPrompt.indexOf(header);
  if (start === -1) return taskPrompt;
  const afterHeader = start + header.length;
  const endMarker = "\n\n---\n\n";
  const end = taskPrompt.indexOf(endMarker, afterHeader);
  if (end === -1) return taskPrompt;
  const before = taskPrompt.slice(0, afterHeader);
  const brain = taskPrompt.slice(afterHeader, end);
  const after = taskPrompt.slice(end);
  return before + dedupeConsecutiveLines(brain) + after;
}
var TRADING_DISCIPLINE_MARK = "## Trading tool discipline";
var CONTEXT_RETRIEVAL_CUE_THRESHOLD_UTF8_BYTES = 3072;
var CONTEXT_RETRIEVAL_CUE_MAX_UTF8_BYTES = 6144;
var ZODIAC_TEAM_ACTIVE_HEADER = "## Zodiac Team Active\n";
var BRAINSTORM_SECTION_HEADER = "## Brainstorm\n";
var SECTION_DIVIDER = "\n\n---\n\n";
function buildContextRetrievalCue(fullMessage) {
  const fullBytes = Buffer.byteLength(fullMessage, "utf8");
  if (fullBytes <= CONTEXT_RETRIEVAL_CUE_THRESHOLD_UTF8_BYTES) {
    return fullMessage;
  }
  let s = fullMessage;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    s = s.trimStart();
    if (s.startsWith(ZODIAC_TEAM_ACTIVE_HEADER)) {
      const zEnd = s.indexOf(SECTION_DIVIDER, ZODIAC_TEAM_ACTIVE_HEADER.length);
      if (zEnd !== -1) {
        s = s.slice(zEnd + SECTION_DIVIDER.length);
        changed = true;
      }
    }
    s = s.trimStart();
    if (s.startsWith(BRAINSTORM_SECTION_HEADER)) {
      const bEnd = s.indexOf(SECTION_DIVIDER, BRAINSTORM_SECTION_HEADER.length);
      if (bEnd !== -1) {
        s = s.slice(bEnd + SECTION_DIVIDER.length);
        changed = true;
      }
    }
    s = s.trimStart();
    if (s.startsWith(TRADING_DISCIPLINE_MARK)) {
      const tprefix = tradingToolDisciplinePrefix();
      if (s.startsWith(`${tprefix}
`)) {
        s = s.slice(tprefix.length + 1);
        changed = true;
      } else if (s.startsWith(tprefix)) {
        s = s.slice(tprefix.length).replace(/^\n+/, "");
        changed = true;
      }
    }
    if (!changed) break;
  }
  s = s.trimStart();
  if (!s) {
    return capUtf8String(fullMessage, CONTEXT_RETRIEVAL_CUE_MAX_UTF8_BYTES);
  }
  return capUtf8String(s, CONTEXT_RETRIEVAL_CUE_MAX_UTF8_BYTES);
}
function tradingToolDisciplinePrefix() {
  return [
    TRADING_DISCIPLINE_MARK,
    "When the task needs prices, book, portfolio, or risk gates: issue real tool calls \u2014",
    "`trade_get_price` per symbol, or `trade_get_prices` with a `symbols` array, plus `trade_portfolio` and `trade_risk_status`.",
    "Do not replace those steps with narrative checklists or pretend tool output.",
    ""
  ].join("\n");
}
function needsTradingToolDisciplineHint(prompt) {
  return /\b(trade_|portfolio\b|drawdown|equity|positions?\b|risk\s*status|circuit\s*breaker|kill\s*switch)\b/i.test(
    withoutLocalTradingSafetyLines(prompt)
  );
}
function ensureTradingDisciplinePrefix(prompt) {
  if (!needsTradingToolDisciplineHint(prompt) || prompt.includes(TRADING_DISCIPLINE_MARK)) {
    return prompt;
  }
  return `${tradingToolDisciplinePrefix()}
${prompt}`;
}
function orchestratorBanCue(text) {
  return /\bdo\s+not\s+(?:use|call)\b.{0,220}(?:local\s+trading|(?:trade_|practice_|arb_)\w+|portfolio|risk|alert|exchange)/i.test(
    text
  ) || /\bno\s+(?:local\s+)?(?:trading|(?:trade_|practice_|arb_)\w+|portfolio|risk|alert|exchange)\b/i.test(
    text
  );
}
function orchestratorPredictionCue(text) {
  return /\b(?:polymarket|prediction\s+market)\b/i.test(text) && /\b(public|web|source|url|wallet|leaderboard|win(?:\s|-)?rate|research)\b/i.test(text);
}
function agentLoopBanCue(text) {
  return /\bdo\s+not\s+(?:call|use)\s+(?:local\s+)?(?:trading\s+tools|trade_[a-z_]+)/i.test(text) || /\b(?:no|without)\s+(?:local\s+)?trading\s+tools\b/i.test(text) || /\bdo\s+not\s+use\s+local\s+portfolio\b/i.test(text);
}
function agentLoopPredictionCue(text) {
  return /\b(?:polymarket|prediction\s+market)\b/i.test(text) && /\b(?:public(?:-source)?|wallets?|leaderboards?|win\s+rates?|research|non-accusatory|not\s+trading\s+advice|no\s+trades?)\b/i.test(
    text
  );
}
function shouldSuppressLocalTradingTools(text) {
  return agentLoopBanCue(text) || agentLoopPredictionCue(text);
}
function shouldSuppressLocalTradingFanout(text) {
  return orchestratorBanCue(text) || orchestratorPredictionCue(text) || shouldSuppressLocalTradingTools(text);
}
var LEARNING_TASK_ID_RE = /\b(?:sip|ngt)-\d{4}\b/i;
var COMPACTABLE_LEARNING_SECTION_TITLES = [
  "What I'm noticing",
  "Scenario setup",
  "What I need from you in this round",
  "What I need back",
  "How I want you to approach it",
  "How I want you to handle it",
  "Compact task-specific focus lock",
  "Recovery-checkpoint focus lock",
  "Checkpoint policy required skeleton",
  "Critical response shape",
  "Complete handoff boundary",
  "Concise completion boundary",
  "Deliverable completeness boundary",
  "Artifact-first repair boundary",
  "Artifact budget boundary",
  "Compact final answer start guard",
  "Evidence brevity boundary",
  "Completion boundary",
  "What a good handoff back to me looks like",
  "What a good handoff looks like"
];
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isMetadataBullet(line) {
  return /^-\s+/.test(line.trim());
}
function sectionHeadingRegex(title) {
  return new RegExp(
    `(?:^|\\n)${escapeRegExp(title)}:\\s*\\n([\\s\\S]*?)(?=\\n(?:${COMPACTABLE_LEARNING_SECTION_TITLES.map(escapeRegExp).join("|")}):\\s*\\n|$)`,
    "i"
  );
}
function extractSectionBody(prompt, title) {
  const match = sectionHeadingRegex(title).exec(prompt);
  return match?.[1]?.trim() ?? "";
}
function collectBullets(block, maxItems, matcher) {
  if (!block) return [];
  const bullets = block.split("\n").map((line) => line.trim()).filter(isMetadataBullet);
  if (!matcher) return bullets.slice(0, maxItems);
  const preferred = bullets.filter((line) => matcher.test(line));
  return (preferred.length > 0 ? preferred : bullets).slice(0, maxItems);
}
function collectMatchingLines(block, maxItems, matcher) {
  if (!block) return [];
  return block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && matcher.test(line)).slice(0, maxItems);
}
function uniqueLines(lines) {
  return [...new Set(lines)];
}
function collectCheckpointPolicySkeletonLines(prompt) {
  const body = extractSectionBody(prompt, "Checkpoint policy required skeleton");
  if (!body) return [];
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const tableStart = lines.findIndex((line) => /^Checkpoint policy$/i.test(line));
  const tableLines = tableStart >= 0 ? lines.slice(tableStart, tableStart + 7) : [];
  return uniqueLines([
    ...collectBullets(
      body,
      2,
      /\b(four opening labels|four checkpoint|evidence note|current gap|success metric)\b/i
    ),
    ...tableLines
  ]);
}
function isLocalTradingSafetyLine(line) {
  const normalized = line.trim().replace(/^[-*]\s+/, "");
  return /^do\s+not\s+call\s+local\s+trading\s+tools\b/i.test(normalized) || /^ignore\s+unrelated\s+trading\/market\/risk\/status\s+tool\s+output\b/i.test(normalized) || /^if\s+trade_risk_status\b.+\bfocus area\b/i.test(normalized) || /^do\s+not\s+dump\b.+\btrade_risk_status\b/i.test(normalized);
}
function collectLocalTradingSafetyLines(prompt) {
  return uniqueLines(
    prompt.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && isLocalTradingSafetyLine(line)).slice(0, 6)
  );
}
function withoutLocalTradingSafetyLines(prompt) {
  return prompt.split("\n").filter((line) => !isLocalTradingSafetyLine(line)).join("\n");
}
function withoutRepeatedLabelAdvice(lines) {
  return lines.filter((line) => !/(?:\brepeat\b.*\blabels?\b|\blabels?\b.*\brepeat\b)/i.test(line));
}
function stripRepeatedLabelAdvice(prompt) {
  return prompt.split("\n").filter((line) => !/(?:\brepeat\b.*\blabels?\b|\blabels?\b.*\brepeat\b)/i.test(line)).join("\n");
}
function collapseToSentence(block) {
  const collapsed = block.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const sentence = /^[^.!?\n]+[.!?]?/.exec(collapsed)?.[0]?.trim() ?? collapsed;
  return sentence;
}
function compactPlanSection(prompt, header) {
  const start = prompt.indexOf(header);
  if (start === -1) return prompt;
  const afterHeader = start + header.length;
  const endMarker = "\n\n---\n\n";
  const end = prompt.indexOf(endMarker, afterHeader);
  if (end === -1) return prompt;
  const before = prompt.slice(0, afterHeader);
  const section = dedupeConsecutiveLines(prompt.slice(afterHeader, end)).trim();
  const after = prompt.slice(end);
  const firstLines = section.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(0, 10).join("\n");
  const compacted = capUtf8String(firstLines, DEFAULT_LEARNING_PLAN_SECTION_UTF8_BYTES).replace(/\n\n\[Prompt truncated to byte budget\]$/, "\n[Planning section compacted]");
  return `${before}${compacted}${after}`;
}
function isLearningTaskPrompt(prompt) {
  return LEARNING_TASK_ID_RE.test(prompt);
}
function preflightLearningTaskPrompt(prompt, maxBytes = DEFAULT_MAX_LEARNING_TASK_PROMPT_UTF8_BYTES) {
  if (!isLearningTaskPrompt(prompt)) return prompt;
  let compactedPrompt = prompt.trim();
  compactedPrompt = compactPlanSection(compactedPrompt, "## Zodiac Team Active\n");
  compactedPrompt = compactPlanSection(compactedPrompt, "## Brainstorm\n");
  compactedPrompt = stripRepeatedLabelAdvice(compactedPrompt);
  const lines = compactedPrompt.split("\n");
  const title = lines.find((line) => line.trim().length > 0)?.trim() ?? compactedPrompt;
  const metadataMatch = /(?:^|\n)(Patch|Test):\s*\n((?:-\s+.+\n?)+)/i.exec(compactedPrompt);
  const metadataHeader = metadataMatch?.[1] ?? null;
  const metadataLines = metadataMatch?.[2].split("\n").map((line) => line.trim()).filter(isMetadataBullet).slice(0, 6) ?? [];
  const situation = collapseToSentence(
    extractSectionBody(compactedPrompt, "What I'm noticing") || extractSectionBody(compactedPrompt, "Scenario setup")
  );
  const deliveryBullets = collectBullets(
    extractSectionBody(compactedPrompt, "What I need from you in this round") || extractSectionBody(compactedPrompt, "What I need back"),
    6
  );
  const guardrailBullets = collectBullets(
    extractSectionBody(compactedPrompt, "How I want you to approach it") || extractSectionBody(compactedPrompt, "How I want you to handle it"),
    5,
    /\b(evidence ladder|real evidence|retry once|blocked|unavailable|smallest durable|reusable|assumptions?|browse|task_create|task_plan|follow-?up task|queued|created|scheduled)\b/i
  );
  const taskSpecificFocusLockLines = uniqueLines(
    collectMatchingLines(
      compactedPrompt,
      10,
      /^(?:[-*]\s*)?(?:(?:Task ID|Focus Area|Required Deliverable|Current Gap|Success Metric):\s*\S.*|The opening labels and artifact|Produce the named artifact|Compact artifact contract|The required artifact is a checkpoint policy|Include a compact table with columns: checkpoint surface|The table must define exactly four rows)\b/i
    )
  );
  const localTradingSafetyLines = collectLocalTradingSafetyLines(compactedPrompt);
  const checkpointPolicySkeletonLines = collectCheckpointPolicySkeletonLines(compactedPrompt);
  const criticalResponseShapeBody = extractSectionBody(compactedPrompt, "Critical response shape");
  const criticalResponseShapeLines = uniqueLines([
    ...collectBullets(
      criticalResponseShapeBody,
      5,
      /\b(exact label preamble|first four lines|first character|copy this output template|no markdown heading|before any title)\b/i
    ),
    ...collectMatchingLines(
      criticalResponseShapeBody,
      4,
      /^(Single highest-leverage weakness|Smallest durable improvement|Measurable signal|Next follow-on patch):/i
    )
  ]);
  const completeHandoffBoundaryBody = extractSectionBody(compactedPrompt, "Complete handoff boundary");
  const completeHandoffBoundaryLines = withoutRepeatedLabelAdvice(uniqueLines([
    ...collectBullets(
      completeHandoffBoundaryBody,
      4,
      /\b(single highest-leverage|smallest durable|measurable signal|next follow-on|artifact|handoff|blocked)\b/i
    ),
    ...collectMatchingLines(
      completeHandoffBoundaryBody,
      4,
      /^(Single highest-leverage weakness|Smallest durable improvement|Measurable signal|Next follow-on patch):/i
    )
  ]));
  const conciseCompletionBullets = withoutRepeatedLabelAdvice(
    collectBullets(
      extractSectionBody(compactedPrompt, "Concise completion boundary"),
      4,
      /\b(handoff labels|exact final handoff labels|artifact|measurable signal|next patch|space is tight|compact)\b/i
    )
  );
  const artifactBudgetBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Artifact budget boundary"),
    3,
    /\b(maximum artifact budget|required handoff labels|collapse examples|optional appendix|usable)\b/i
  );
  const compactFinalGuardBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Compact final answer start guard"),
    6,
    /\b(first output character|first four|fourth opening label|then produce|required artifact|final four|stop immediately)\b/i
  );
  const deliverableCompletenessBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Deliverable completeness boundary"),
    4,
    /\b(complete artifact|measurable signal|next patch|do not stop|evidence)\b/i
  );
  const artifactFirstRepairBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Artifact-first repair boundary"),
    4,
    /\b(required four-line label preamble|produce the named artifact|do not answer|patch received|artifact first)\b/i
  );
  const evidenceBrevityBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Evidence brevity boundary"),
    4,
    /\b(evidence|summarize|artifact|measurable signal|handoff labels|blocked)\b/i
  );
  const completionBoundaryBullets = collectBullets(
    extractSectionBody(compactedPrompt, "Completion boundary"),
    14,
    /\b(tools are optional|finish with the requested artifact|do not end|rephrase request|generic stall|smallest useful artifact|tool\/context loop|same response|handoff|web_search|file_read|file_list|local files|docs|code|task evidence|tool names|visible anywhere|successful tool call|never available|measurable signal|next harder variation|mid-sentence|stress|recover|time-box|cross-system|compact enough)\b/i
  );
  const handoffBullets = collectBullets(
    extractSectionBody(compactedPrompt, "What a good handoff back to me looks like") || extractSectionBody(compactedPrompt, "What a good handoff looks like"),
    4
  );
  const compactParts = [title];
  if (metadataHeader && metadataLines.length > 0) {
    compactParts.push("", `${metadataHeader}:`, ...metadataLines);
  }
  if (situation) {
    compactParts.push("", "Core situation:", situation);
  }
  if (deliveryBullets.length > 0) {
    compactParts.push("", "Deliver:", ...deliveryBullets);
  }
  if (guardrailBullets.length > 0) {
    compactParts.push("", "Guardrails:", ...guardrailBullets);
  }
  if (taskSpecificFocusLockLines.length > 0) {
    compactParts.push("", "Task-specific focus lock:", ...taskSpecificFocusLockLines);
  }
  if (checkpointPolicySkeletonLines.length > 0) {
    compactParts.push("", "Checkpoint policy required skeleton:", ...checkpointPolicySkeletonLines);
  }
  if (localTradingSafetyLines.length > 0) {
    compactParts.push("", "Safety rails:", ...localTradingSafetyLines);
  }
  if (criticalResponseShapeLines.length > 0) {
    compactParts.push("", "Critical response shape:", ...criticalResponseShapeLines);
  }
  if (completeHandoffBoundaryLines.length > 0) {
    compactParts.push("", "Complete handoff boundary:", ...completeHandoffBoundaryLines);
  }
  if (conciseCompletionBullets.length > 0) {
    compactParts.push("", "Concise completion boundary:", ...conciseCompletionBullets);
  }
  if (artifactBudgetBullets.length > 0) {
    compactParts.push("", "Artifact budget boundary:", ...artifactBudgetBullets);
  }
  if (deliverableCompletenessBullets.length > 0) {
    compactParts.push("", "Deliverable completeness boundary:", ...deliverableCompletenessBullets);
  }
  if (compactFinalGuardBullets.length > 0) {
    compactParts.push("", "Compact final answer start guard:", ...compactFinalGuardBullets);
  }
  if (artifactFirstRepairBullets.length > 0) {
    compactParts.push("", "Artifact-first repair boundary:", ...artifactFirstRepairBullets);
  }
  if (evidenceBrevityBullets.length > 0) {
    compactParts.push("", "Evidence brevity boundary:", ...evidenceBrevityBullets);
  }
  if (completionBoundaryBullets.length > 0) {
    compactParts.push("", "Completion boundary:", ...completionBoundaryBullets);
  }
  if (handoffBullets.length > 0) {
    compactParts.push("", "Success check:", ...handoffBullets);
  }
  const compact = `${compactParts.join("\n")}

[Learning prompt compacted for context discipline; preserve the same intent and evidence standards.]`;
  const chosen = Buffer.byteLength(compact, "utf8") < Buffer.byteLength(compactedPrompt, "utf8") ? compact : compactedPrompt;
  return capUtf8String(chosen, maxBytes);
}

// src/zodiac/registry.ts
var SELF_IMPROVEMENT_TASK_REF_RE = /\bsip-\d{4}\b/i;
var ZODIAC_DELIVERABLE_GLUE_FRAGMENTS = [
  "with failure modes, false-edge checks, and risk flags.",
  "moving with owners, sequence, and next checkpoints."
];
function glueFragmentVariants(fragment) {
  const base = fragment.trim();
  const seen = /* @__PURE__ */ new Set();
  const add = (s) => {
    const t = s.trim();
    if (t.length > 0) seen.add(t);
  };
  add(base);
  if (base.endsWith(".")) {
    add(`${base}"`);
    add(`${base}'`);
  }
  return [...seen];
}
function collapseRepeatedZodiacGlueInText(text) {
  let out = text;
  let prev = "";
  while (out !== prev) {
    prev = out;
    for (const fragment of ZODIAC_DELIVERABLE_GLUE_FRAGMENTS) {
      for (const variant of glueFragmentVariants(fragment)) {
        const idx = out.indexOf(variant);
        if (idx === -1) continue;
        const prefix = out.slice(0, idx + variant.length);
        const suffix = out.slice(idx + variant.length).split(variant).join("");
        out = prefix + suffix;
      }
    }
    out = out.replace(/(["']\.|\.["'])\s*(["']\.|\.["'])\s*/g, "$1 ");
  }
  return out;
}
function stripBareDeliverableGlueLines(text) {
  const fluff = /* @__PURE__ */ new Set();
  for (const fragment of ZODIAC_DELIVERABLE_GLUE_FRAGMENTS) {
    for (const variant of glueFragmentVariants(fragment)) {
      fluff.add(variant.toLowerCase());
    }
  }
  return text.split("\n").filter((line) => {
    const t = line.trim();
    const lower = t.toLowerCase();
    if (fluff.has(lower)) return false;
    if (/^["'.]+$/.test(t)) return false;
    return true;
  }).join("\n");
}
var MAX_PLANNER_DISPATCH_TEMPLATE_LINES = 80;
function isPlannerDispatchTemplateContinuation(line) {
  const t = line.trim();
  if (t === "") return false;
  if (/^you are\s+/i.test(t)) return true;
  if (/^mission:/i.test(t)) return true;
  if (/^story:/i.test(t)) return true;
  if (/^preferred tool families:/i.test(t)) return true;
  if (/^operating laws:/i.test(t)) return true;
  if (/^#\s*virgo cleanroom gate/i.test(t)) return true;
  if (/^#{1,3}\s/.test(t)) return true;
  if (/^-\s+\*\*/.test(t)) return true;
  if (/^-\s/.test(t) && /stay inside|fabricate|trading or risk|keep the work|escalate when|one opportunity|end with exactly|quiet hours|truncated queue|portfolio, exposure/i.test(
    t
  ))
    return true;
  return false;
}
function stripNestedZodiacDispatchBlocksFromPlannerContext(text) {
  const lines = text.split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\[Zodiac Dispatch:\s*[^\]]+\]\s*$/.test(line)) {
      i++;
      let skipped = 0;
      while (i < lines.length && skipped < MAX_PLANNER_DISPATCH_TEMPLATE_LINES && isPlannerDispatchTemplateContinuation(lines[i])) {
        i++;
        skipped++;
      }
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }
    kept.push(line);
    i++;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function parentExplicitlyRequestsCommsAboutRisk(text) {
  const t = text.toLowerCase();
  if (/\bno\s+trading\b/.test(t)) return false;
  if (/\b(do\s+not|don't|never|without|avoid|skip)\b[\s\S]{0,48}\btrading\s+(tool|tools|calls?)\b/.test(t)) return false;
  const comms = /\b(draft|drafting|message|comms?|email|slack|telegram|discord|imessage|notify|notification|thread|relay|tell\s+(them|her|him|the\s+team|ops|engineering)|write\s+(a\s+)?(slack|email|dm|text))\b/;
  const risk = /\b(risk|portfolio|trading|halt|drawdown|margin|liquidat|exposure|position|balance|p&l|pnl|equity|stop)\b/;
  return comms.test(t) && risk.test(t);
}
function containsInheritedTradingRiskBrainstorm(text) {
  const t = text;
  if (/\[Zodiac Dispatch:\s*(Scorpio|Capricorn)\]/i.test(t)) return true;
  if (/##\s*Brainstorm\b/i.test(t) && /\b(trade_[a-z0-9_]+|trade_risk_status|portfolio|quiet\s*hours|failure\s*modes|op(us)?\s*grind|drawdown)\b/i.test(t))
    return true;
  return false;
}
function stripChainedZodiacDispatchBlocksFromParent(text) {
  let out = text.trim();
  for (; ; ) {
    const before = out;
    out = out.replace(/^\[Zodiac Dispatch:\s*[^\]]+\][\s\S]*?(?=\n\[Zodiac Dispatch:)/g, "");
    out = out.replace(/\n\[Zodiac Dispatch:\s*[^\]]+\][\s\S]*?(?=\n\[Zodiac Dispatch:)/g, "");
    if (out === before) break;
  }
  out = out.replace(
    /(^|\n)\[Zodiac Dispatch:\s*[^\]]+\][\s\S]*?(?=\n\n(?=[A-Z0-9"#])|$)/,
    (lead) => lead === "\n" ? "\n" : ""
  );
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
function stripForeignZodiacNoiseForGemini(text, allowRiskComms, mode = "context") {
  let out = text;
  if (mode === "parent") {
    out = stripChainedZodiacDispatchBlocksFromParent(out);
  } else {
    out = out.replace(/\[Zodiac Dispatch:\s*Scorpio\][\s\S]*?(?=\n\[Zodiac Dispatch:|$)/gi, "");
    out = out.replace(/\[Zodiac Dispatch:\s*Capricorn\]\s*\n?/gi, "");
  }
  if (!allowRiskComms) {
    out = out.replace(/##\s*Brainstorm\b[\s\S]*?(?=\n##\s(?!Brainstorm\b)|\n\[Zodiac Dispatch:|$)/gi, "");
  }
  out = collapseRepeatedZodiacGlueInText(stripBareDeliverableGlueLines(out));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
function geminiParentExplicitCommsAboutRisk(parent) {
  if (!parent?.trim()) return false;
  return parentExplicitlyRequestsCommsAboutRisk(parent);
}
function geminiSpecialistExplicitCommsAboutRisk(objective) {
  if (!parentExplicitlyRequestsCommsAboutRisk(objective)) return false;
  if (/\b(no|never|not|don't|do not|without)\s+.{0,48}\b(trading|trades|portfolio|market data)\b/i.test(objective))
    return false;
  return true;
}
function geminiMayUseTradeTools(parent, objective) {
  if (geminiParentExplicitCommsAboutRisk(parent)) return true;
  if (geminiSpecialistExplicitCommsAboutRisk(objective)) return true;
  return /\btrade_(get_price|get_prices|portfolio|risk_status)\b/i.test(objective);
}
var GEMINI_TRADE_TOOL_NAMES = [
  "trade_get_price",
  "trade_get_prices",
  "trade_portfolio",
  "trade_risk_status"
];
function tradeToolNamesMentionedIn(text) {
  return GEMINI_TRADE_TOOL_NAMES.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(text));
}
function geminiTradingLawBullet(geminiRiskCommsExplicit, geminiTradeToolsOk, objTrim) {
  if (!geminiTradeToolsOk) {
    return "- Do not use trading or portfolio tools in this packet unless the **parent objective** explicitly asks you to relay trading, portfolio, or risk status in human-facing comms (draft/message/email/thread).";
  }
  if (geminiRiskCommsExplicit || parentExplicitlyRequestsCommsAboutRisk(objTrim)) {
    return "- For trading or risk snapshots use native tool calls (`trade_get_price`, `trade_get_prices`, `trade_portfolio`, `trade_risk_status`) \u2014 not prose plans pretending you fetched data.";
  }
  const mentioned = tradeToolNamesMentionedIn(objTrim);
  const list = mentioned.length > 0 ? mentioned.map((n) => `\`${n}\``).join(", ") : "`trade_get_price`, `trade_get_prices`, `trade_portfolio`, `trade_risk_status`";
  return `- For verified trading or portfolio facts use native tool calls (${list}) \u2014 not prose plans pretending you fetched data.`;
}
function shouldSuppressLocalTradingToolsForDispatch(parent, objective, context) {
  const text = [parent, objective, context].filter(Boolean).join("\n");
  const localTradingToolBanCue = /\bdo\s+not\s+(?:call|use)\s+(?:local\s+)?(?:trading\s+tools|trade_[a-z_]+)/i.test(text) || /\b(?:no|without)\s+(?:local\s+)?trading\s+tools\b/i.test(text) || /\bdo\s+not\s+use\s+local\s+portfolio\b/i.test(text);
  const predictionMarketPublicResearchCue = /\b(?:polymarket|prediction\s+market)\b/i.test(text) && /\b(?:public(?:-source)?|wallets?|leaderboards?|win\s+rates?|research|non-accusatory|not\s+trading\s+advice|no\s+trades?)\b/i.test(text);
  return localTradingToolBanCue || predictionMarketPublicResearchCue;
}
function resolveGeminiParentBlock(parent, objective) {
  if (!parent?.trim()) return void 0;
  const raw = parent.trim();
  if (!containsInheritedTradingRiskBrainstorm(raw)) return raw;
  if (parentExplicitlyRequestsCommsAboutRisk(raw)) return raw;
  const stripped = stripForeignZodiacNoiseForGemini(raw, false, "parent");
  return stripped.length > 0 ? stripped : void 0;
}
var PARENT_OBJECTIVE_MAX_BYTES = 2e3;
function capParentObjective(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 192) === 128) end--;
  return buf.subarray(0, end).toString("utf8") + "\u2026";
}
function stripOrchestrationFromParentObjective(text) {
  let out = stripNestedZodiacDispatchBlocksFromPlannerContext(text);
  out = out.split("\n").filter((line) => {
    const t = line.trim().toLowerCase();
    if (!t) return true;
    if (/\bzodiac_(orchestrate|dispatch|route_task|list_agents)\b/.test(t)) return false;
    if (/\borchestration\s+captain\b/.test(t)) return false;
    if (/\b(dispatch|orchestrate|spin\s+up|activate)\b/.test(t) && /\b(zodiac|specialist|symphony)\b/.test(t)) return false;
    if (/\bzodiac\s+symphony\b/.test(t) && /\b(team|captain|dispatch|orchestrat|assign)\b/.test(t)) return false;
    if (/\bspecialist\s+assignments?\b/.test(t) && /\bparallel\b/.test(t)) return false;
    return true;
  }).join("\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
var DEFAULT_WORKER_MODEL_TARGET = "Prefer openrouter:qwen/qwen3.6-plus:free (or qwen/qwen3.6-plus:free alias) when sufficient; escalate only when reasoning stakes justify it.";
var ZODIAC_AGENTS = [
  {
    sign: "Aries",
    codename: "Redline Intake",
    sector: "rapid intake, triage, and decisive first-response work",
    mission: "Turn incoming mess into a fast yes, no, later, or escalate before it pollutes the rest of the machine.",
    story: "Aries is the first blade out of the sheath. It exists to keep Big Mama Zaraa from drowning in fragments and half-formed asks.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["task_", "memory_", "cal_"],
    keywords: [
      "triage",
      "inbox",
      "intake",
      "urgent",
      "sort",
      "classify",
      "first response",
      "screen",
      "queue",
      "incoming"
    ],
    escalationBoundary: [
      "money moves",
      "irreversible commitments",
      "emotionally sensitive replies",
      "unclear intent with high downside"
    ],
    opportunityClass: "Faster intake and sharper first-pass routing that prevents expensive context switching and missed reaction windows."
  },
  {
    sign: "Taurus",
    codename: "Vaultkeep",
    sector: "treasury discipline, recurring operations, and durable stability work",
    mission: "Keep the floor solid: budgets, subscriptions, invoices, recurring obligations, and operational steadiness.",
    story: "Taurus is the quiet weight room of the swarm. It makes the business boring in the profitable way.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["finance_", "task_", "memory_"],
    keywords: [
      "budget",
      "billing",
      "invoice",
      "expense",
      "subscription",
      "recurring",
      "runway",
      "treasury",
      "stability",
      "cash"
    ],
    escalationBoundary: [
      "capital allocation decisions",
      "trades",
      "legal commitments",
      "material budget changes"
    ],
    opportunityClass: "Expense cleanup, renegotiation, and recurring cash leak reduction that compounds quietly."
  },
  {
    sign: "Gemini",
    codename: "Signal Relay",
    sector: "communications, message drafting, thread compression, and information relay",
    mission: "Turn noisy threads into clear messages, clean asks, and ready-to-send drafts.",
    story: "Gemini is the switchboard with taste. It carries meaning without carrying clutter.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["imessage_", "whatsapp_", "telegram_", "slack_", "discord_", "gmail_"],
    keywords: [
      "message",
      "email",
      "reply",
      "draft",
      "rewrite",
      "thread",
      "summary",
      "outreach",
      "communication",
      "text"
    ],
    escalationBoundary: [
      "public statements",
      "high-stakes negotiations",
      "emotionally charged relationship decisions",
      "claims requiring verification"
    ],
    opportunityClass: "Better follow-up and cleaner communication in fragmented markets where speed and clarity win deals."
  },
  {
    sign: "Cancer",
    codename: "Continuity Hearth",
    sector: "calendar protection, continuity, relationship warmth, and follow-through memory",
    mission: "Protect promises, follow-ups, schedules, and the human thread that work depends on.",
    story: "Cancer keeps the thread from fraying. It remembers what mattered after everyone else has moved on.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["cal_", "task_", "memory_", "imessage_", "gmail_"],
    keywords: [
      "calendar",
      "schedule",
      "follow up",
      "follow-up",
      "check in",
      "relationship",
      "promise",
      "continuity",
      "reminder",
      "meeting"
    ],
    escalationBoundary: [
      "sensitive personal conversations",
      "conflict",
      "hard boundaries",
      "reputation-sensitive commitments"
    ],
    opportunityClass: "Relationship continuity and timing discipline that preserves trust and keeps opportunities from dying in follow-up gaps."
  },
  {
    sign: "Leo",
    codename: "Narrative Command",
    sector: "brand voice, high-conviction persuasion, visibility, and narrative command",
    mission: "Shape language that persuades, positions, launches, and gives the operator a strong public edge.",
    story: "Leo steps forward when the work needs force, taste, and memorable framing rather than mere correctness.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["file_", "memory_", "imessage_", "gmail_"],
    keywords: [
      "brand",
      "pitch",
      "positioning",
      "copy",
      "launch",
      "post",
      "narrative",
      "persuade",
      "voice",
      "announcement"
    ],
    escalationBoundary: [
      "final public publication",
      "claims with legal risk",
      "major reputation bets",
      "high-stakes persuasion"
    ],
    opportunityClass: "Faster packaging of under-monetized offers where better language alone increases conversion."
  },
  {
    sign: "Virgo",
    codename: "Cleanroom",
    sector: "cleanup, QA, process rigor, checklists, and anti-sloppiness enforcement",
    mission: "Remove avoidable error, drift, formatting mess, and half-finished roughness from the system.",
    story: "Virgo is the final wipe-down before things ship. It is ruthless about details because details leak trust.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["file_", "task_", "memory_", "shell_"],
    keywords: [
      "cleanup",
      "qa",
      "review",
      "format",
      "checklist",
      "dedupe",
      "proofread",
      "polish",
      "validate",
      "sanity check"
    ],
    escalationBoundary: [
      "uncertain requirements",
      "schema-breaking changes",
      "conflicting source material",
      "high-stakes accuracy claims"
    ],
    opportunityClass: "Lower defect rates and sharper operator credibility through anti-sloppiness enforcement."
  },
  {
    sign: "Libra",
    codename: "Balance Desk",
    sector: "prioritization, tradeoffs, negotiation framing, and elegant decision support",
    mission: "Compare options, make costs legible, and turn vague forks into clear decisions.",
    story: "Libra exists so Big Mama spends judgment on the hard part, not on formatting the choice set.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["task_", "memory_", "finance_", "file_"],
    keywords: [
      "prioritize",
      "priority",
      "tradeoff",
      "decide",
      "decision",
      "compare",
      "options",
      "pros and cons",
      "ranking",
      "negotiation"
    ],
    escalationBoundary: [
      "capital decisions",
      "relationship-sensitive choices",
      "irreversible bets",
      "strategy changes"
    ],
    opportunityClass: "Cleaner decision framing that speeds execution and prevents value loss through indecision."
  },
  {
    sign: "Scorpio",
    codename: "Shadow Audit",
    sector: "risk, anomaly hunting, due diligence, adversarial analysis, and hidden-pattern detection",
    mission: "Find the downside early, before an unchecked assumption becomes a bill.",
    story: "Scorpio is the cell that distrusts easy stories. It looks for the buried blade under the velvet.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["trade_", "web_", "memory_", "finance_", "task_"],
    keywords: [
      "risk",
      "anomaly",
      "audit",
      "due diligence",
      "downside",
      "red team",
      "failure mode",
      "edge case",
      "hidden",
      "adversarial"
    ],
    escalationBoundary: [
      "live capital deployment",
      "legal exposure",
      "public accusations",
      "evidence too thin for confidence"
    ],
    opportunityClass: "Finding stale assumptions, hidden leakage, and false edges before money is committed."
  },
  {
    sign: "Sagittarius",
    codename: "Frontier Scout",
    sector: "research expeditions, frontier opportunities, expansion scouting, and optionality",
    mission: "Look beyond the current map and return with plausible new edges, not random novelty.",
    story: "Sagittarius lives where the machine has not yet looked. It is disciplined curiosity with a return requirement.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["web_", "memory_", "file_", "task_"],
    keywords: [
      "research",
      "scout",
      "explore",
      "adjacent",
      "opportunity",
      "frontier",
      "expand",
      "new market",
      "optional",
      "discovery"
    ],
    escalationBoundary: [
      "speculative leaps without evidence",
      "large spend to validate",
      "category changes",
      "mission drift"
    ],
    opportunityClass: "Simple new-sector asymmetries and adjacent-market opportunities with short paths to validation."
  },
  {
    sign: "Capricorn",
    codename: "Close Loop",
    sector: "execution governance, milestones, deadlines, and merciless completion pressure",
    mission: "Keep work moving from intention to finish with owners, milestones, and visible slippage.",
    story: "Capricorn is the part of the swarm that does not care how inspired the plan was if the thing never ships.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["task_", "cal_", "memory_", "file_"],
    keywords: [
      "deadline",
      "milestone",
      "owner",
      "project",
      "execution",
      "ship",
      "close the loop",
      "follow through",
      "timeline",
      "deliverable"
    ],
    escalationBoundary: [
      "strategy pivots",
      "resource conflicts",
      "missed commitments with reputational risk",
      "scope explosions"
    ],
    opportunityClass: "Execution reliability that turns good ideas into captured value instead of abandoned intent."
  },
  {
    sign: "Aquarius",
    codename: "Systems Leverager",
    sector: "systems design, automation, experiments, and weird but useful leverage",
    mission: "Convert repeated friction into machinery: automations, templates, dashboards, and lightweight experiments.",
    story: "Aquarius treats repetition as a design smell. If the same drag appears three times, it wants to build a lever.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["file_", "shell_", "task_", "memory_"],
    keywords: [
      "automate",
      "automation",
      "system",
      "workflow",
      "dashboard",
      "experiment",
      "template",
      "integration",
      "leverage",
      "machinery"
    ],
    escalationBoundary: [
      "security-sensitive automation",
      "irreversible data changes",
      "production risk",
      "unclear operator intent"
    ],
    opportunityClass: "Operational leverage and premium micro-workflows that can be reused, sold, or turned into force multipliers."
  },
  {
    sign: "Pisces",
    codename: "Deep Current",
    sector: "synthesis, creative patterning, intuition, and dream-to-plan translation",
    mission: "Take scattered fragments, emotional residue, and half-patterns and turn them into direction.",
    story: "Pisces is the tide pool where fragments become meaning. It is useful only when it returns with structure.",
    workerModelTarget: DEFAULT_WORKER_MODEL_TARGET,
    preferredToolPrefixes: ["memory_", "file_", "web_", "task_"],
    keywords: [
      "synthesis",
      "pattern",
      "strategy memo",
      "connect dots",
      "direction",
      "intuition",
      "brainstorm",
      "map",
      "frame",
      "signal from noise"
    ],
    escalationBoundary: [
      "thin evidence disguised as certainty",
      "capital recommendations",
      "sensitive personal interpretation",
      "public strategic claims"
    ],
    opportunityClass: "Turning scattered research and operator intuition into sharper theses, packaging, and next moves."
  }
];
var AGENT_INDEX = new Map(
  ZODIAC_AGENTS.flatMap((agent) => [
    [agent.sign.toLowerCase(), agent],
    [agent.codename.toLowerCase(), agent]
  ])
);
function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
function dedupe(values) {
  return [...new Set(values)];
}
function confidenceForScore(score) {
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}
function matchKeyword(text, keyword) {
  return text.includes(keyword.toLowerCase());
}
function extractMentionedTools(text) {
  const matches = text.match(/\b[a-z]+_[a-z_]+\b/g);
  return matches ? dedupe(matches.map((item) => item.toLowerCase())) : [];
}
function scoreAgent(agent, objective) {
  const normalized = normalizeText(objective);
  const reasons = [];
  let score = 0;
  for (const keyword of agent.keywords) {
    if (!matchKeyword(normalized, keyword)) continue;
    score += keyword.includes(" ") ? 3 : 2;
    reasons.push(`keyword:${keyword}`);
  }
  for (const toolName of extractMentionedTools(normalized)) {
    for (const prefix of agent.preferredToolPrefixes) {
      if (toolName.startsWith(prefix)) {
        score += 3;
        reasons.push(`tool:${toolName}`);
        break;
      }
    }
  }
  if (matchKeyword(normalized, agent.sector)) {
    score += 2;
    reasons.push("sector-match");
  }
  return {
    sign: agent.sign,
    codename: agent.codename,
    sector: agent.sector,
    score,
    confidence: confidenceForScore(score),
    reasons: dedupe(reasons)
  };
}
function listZodiacAgents() {
  return ZODIAC_AGENTS.map((agent) => ({ ...agent, preferredToolPrefixes: [...agent.preferredToolPrefixes], keywords: [...agent.keywords], escalationBoundary: [...agent.escalationBoundary] }));
}
function getZodiacAgent(signOrAlias) {
  const normalized = normalizeText(signOrAlias);
  const agent = AGENT_INDEX.get(normalized);
  if (!agent) return null;
  return {
    ...agent,
    preferredToolPrefixes: [...agent.preferredToolPrefixes],
    keywords: [...agent.keywords],
    escalationBoundary: [...agent.escalationBoundary]
  };
}
function routeZodiacTask(objective, topK = 3) {
  const candidates = ZODIAC_AGENTS.map((agent) => scoreAgent(agent, objective)).sort((a, b) => b.score - a.score || a.sign.localeCompare(b.sign));
  if (candidates[0] && candidates[0].score > 0) {
    return {
      primary: candidates[0],
      alternatives: candidates.slice(1, Math.max(1, topK))
    };
  }
  return {
    primary: {
      sign: "Aries",
      codename: "Redline Intake",
      sector: "rapid intake, triage, and decisive first-response work",
      score: 1,
      confidence: "low",
      reasons: ["default:intake-first"]
    },
    alternatives: candidates.slice(0, Math.max(0, topK - 1))
  };
}
function buildZodiacDispatchPrompt(options) {
  const { agent, parentObjective, objective, context, deliverable, dedupHash } = options;
  const objTrim = objective.trim();
  const suppressLocalTradingTools = shouldSuppressLocalTradingToolsForDispatch(
    parentObjective,
    objTrim,
    context
  );
  let primary;
  if (agent.sign === "Gemini") {
    primary = resolveGeminiParentBlock(parentObjective, objTrim);
  } else if (parentObjective?.trim()) {
    const sanitized = stripOrchestrationFromParentObjective(parentObjective.trim());
    primary = sanitized.length > 0 ? capParentObjective(sanitized, PARENT_OBJECTIVE_MAX_BYTES) : void 0;
  }
  const geminiRiskCommsExplicit = agent.sign === "Gemini" ? geminiParentExplicitCommsAboutRisk(parentObjective) : false;
  const geminiTradeToolsOk = agent.sign === "Gemini" ? !suppressLocalTradingTools && geminiMayUseTradeTools(parentObjective, objTrim) : !suppressLocalTradingTools;
  const preferredToolPrefixes = suppressLocalTradingTools ? agent.preferredToolPrefixes.filter((prefix) => !/^(?:trade|practice|arb)_$/.test(prefix)) : agent.preferredToolPrefixes;
  const carriesSelfImprovementTask = SELF_IMPROVEMENT_TASK_REF_RE.test(
    [parentObjective, objTrim, context, deliverable].filter(Boolean).join("\n")
  );
  let contextForPrompt = stripNestedZodiacDispatchBlocksFromPlannerContext(context?.trim() || "");
  if (agent.sign === "Gemini" && contextForPrompt.length > 0) {
    contextForPrompt = stripForeignZodiacNoiseForGemini(
      contextForPrompt,
      geminiRiskCommsExplicit,
      "context"
    );
  }
  const lines = [
    `[Zodiac Dispatch: ${agent.sign}]`,
    ...dedupHash ? [`Dedup hash: ${dedupHash}`] : [],
    `You are ${agent.sign} ("${agent.codename}"). ${agent.sector}`,
    `Mission: ${agent.mission}`,
    `Preferred tool families: ${preferredToolPrefixes.join(", ") || "general-purpose"}`,
    "",
    "Operating laws:",
    "- Stay inside your sector. If the task materially drifts, escalate instead of improvising outside your lane.",
    "- Do not fabricate runtime checks, tool results, or external facts.",
    "- NEVER call zodiac_dispatch, zodiac_orchestrate, or zodiac_route_task. You are an already-dispatched specialist \u2014 re-dispatching creates an infinite loop."
  ];
  if (suppressLocalTradingTools) {
    lines.push(
      "- Do not use local trading, portfolio, risk, alert, arbitrage, or practice-trading tools for this packet; use only the parent-approved public data/source tools."
    );
  } else if (agent.sign === "Gemini") {
    lines.push(geminiTradingLawBullet(geminiRiskCommsExplicit, geminiTradeToolsOk, objTrim));
  } else if (agent.sign === "Scorpio") {
    lines.push(
      "- For portfolio, exposure, or risk snapshots you need to verify, use native tool calls (`trade_get_price`, `trade_get_prices`, `trade_portfolio`, `trade_risk_status`) \u2014 not narrative pretending you fetched live book state."
    );
  } else {
    lines.push(
      "- For trading or risk snapshots use native tool calls (`trade_get_price`, `trade_get_prices`, `trade_portfolio`, `trade_risk_status`) \u2014 not prose plans pretending you fetched data."
    );
  }
  lines.push(
    "- Keep the work concise, operational, and directly useful to Big Mama Zaraa.",
    `- Escalate when the task touches: ${agent.escalationBoundary.join("; ")}.`,
    `- One opportunity class you should stay alert for: ${agent.opportunityClass}`,
    carriesSelfImprovementTask ? "- End with the SIP self-improvement handoff labels exactly: Single highest-leverage weakness:, Smallest durable improvement:, Measurable signal:, Next follow-on patch:." : "- End with exactly four lines in this order: Objective:, Done:, Next:, Risk:.",
    ""
  );
  if (carriesSelfImprovementTask) {
    lines.push(
      "Self-improvement handoff guard:",
      "- This specialist packet carries a SIP self-improvement task, so the final answer must satisfy the self-improvement quality gate.",
      "- Single highest-leverage weakness: name the clearest root weakness, not just activity completed.",
      "- Smallest durable improvement: name the smallest reusable rule, checklist, patch, or procedure that survives the run.",
      "- Measurable signal: name the metric, baseline, trace, or acceptance check that proves improvement.",
      "- Next follow-on patch: name the next patch candidate without claiming it is queued unless you actually used a task tool.",
      "- Do not claim a follow-up task was queued, created, scheduled, submitted, or opened unless you actually called task_create or task_plan in this run.",
      "- Do not call task_create or task_plan inside this self-improvement task unless the operator explicitly requested task generation outside this prompt.",
      "- Never invent numeric baselines, rates, latencies, percentages, or throughput claims. If the metric was not measured with a tool or exact source in this run, write `not measured yet` and name the first measurement to collect.",
      ""
    );
  }
  if (agent.sign === "Scorpio" && !suppressLocalTradingTools) {
    lines.push(
      "## Virgo cleanroom gate (apply before any numbered market / execution steps)",
      "- **Quiet hours (local 23:00\u201307:00):** verify with a real `date` call (shell_) before expanding scope. If inside the window, do **portfolio + risk snapshot only** \u2014 no broad market scans, no discretionary `trade_buy` / `trade_sell`, no invented fills or balances.",
      "- If a parent packet lists scans, alpha hunts, or execution, **skip or defer** those items during quiet hours unless Big Mama Zaraa explicitly overrides in this same task packet.",
      "- Truncated queue prompts may omit context \u2014 **re-check** via allowed tools instead of assuming missing sections.",
      ""
    );
  }
  if (primary) {
    lines.push("## Primary objective (parent)", primary, "");
  }
  const deliverableLine = deliverable?.trim() || "Produce the best concise handoff packet for Big Mama Zaraa.";
  lines.push(
    `Specialist objective: ${objTrim}`,
    `Context: ${contextForPrompt || "No extra context provided."}`,
    `Deliverable [${agent.sign}]: ${deliverableLine}`
  );
  return lines.join("\n");
}

export {
  DEFAULT_MAX_TASK_PROMPT_UTF8_BYTES,
  ZODIAC_PLANNER_FIELD_MAX_BYTES,
  capUtf8String,
  dedupeBrainstormInTaskPrompt,
  buildContextRetrievalCue,
  ensureTradingDisciplinePrefix,
  shouldSuppressLocalTradingTools,
  shouldSuppressLocalTradingFanout,
  preflightLearningTaskPrompt,
  collapseRepeatedZodiacGlueInText,
  stripNestedZodiacDispatchBlocksFromPlannerContext,
  listZodiacAgents,
  getZodiacAgent,
  routeZodiacTask,
  buildZodiacDispatchPrompt
};
