// src/memory/contact-intelligence.ts
var PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
var EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
var TO_FROM_NAME_RE = /\b(?:to|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g;
function normalizePhoneDisplay(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits.startsWith("+") ? raw.replace(/\s/g, "") : `+${digits}`;
}
function normalizeContactKey(displayName) {
  const t = displayName.trim();
  if (!t) return `name:unknown`;
  const digitsOnly = t.replace(/\D/g, "");
  if (/^\+?[\d\s().-]+$/.test(t) && digitsOnly.length >= 10) {
    return `phone:${digitsOnly}`;
  }
  const em = t.match(EMAIL_RE);
  if (em && em[0] === t) return `email:${t.toLowerCase()}`;
  const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `name:${(slug || "unknown").slice(0, 120)}`;
}
function stripSyntheticIdTags(text) {
  return text.replace(/\[benchmark-[^\]]*\]/gi, " ").replace(/\[task-[^\]]*\]/gi, " ");
}
function extractContactSeedsFromText(text, memoryRef) {
  const seeds = [];
  const seen = /* @__PURE__ */ new Set();
  const cleaned = stripSyntheticIdTags(text);
  const snippet = cleaned.replace(/\s+/g, " ").trim().slice(0, 200);
  const add = (displayName, topicLine) => {
    const key = normalizeContactKey(displayName);
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push({
      normalizedKey: key,
      displayName: displayName.trim(),
      topicLine,
      memoryRef
    });
  };
  for (const m of cleaned.matchAll(PHONE_RE)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    add(normalizePhoneDisplay(raw), snippet || "mentioned in memory");
  }
  for (const m of cleaned.matchAll(EMAIL_RE)) {
    add(m[0], snippet || "mentioned in memory");
  }
  for (const m of cleaned.matchAll(TO_FROM_NAME_RE)) {
    const name = m[1]?.trim();
    if (name && name.split(/\s+/).length >= 2) {
      add(name, snippet || "mentioned in memory");
    }
  }
  return seeds;
}
function seedContactsFromMemories(db, upsert, opts) {
  const limit = opts?.limitPerTier ?? 400;
  const episodic = db.queryEpisodic(limit);
  const semantic = db.querySemantic(limit);
  const procedural = db.queryProcedural(limit);
  let seedsFound = 0;
  let created = 0;
  let updated = 0;
  const applyRows = (rows, tier, contentPick) => {
    for (const row of rows) {
      const content = contentPick(row);
      const seeds = extractContactSeedsFromText(content, { tier, id: row.id });
      for (const s of seeds) {
        seedsFound++;
        const r = upsert({
          displayName: s.displayName,
          normalizedKey: s.normalizedKey,
          topicsToAppend: [s.topicLine],
          sourceMemoryRef: s.memoryRef
        });
        if (r.inserted) created++;
        else updated++;
      }
    }
  };
  applyRows(episodic, "episodic", (r) => r.content);
  applyRows(semantic, "semantic", (r) => r.content);
  for (const row of procedural) {
    const blob = `${row.trigger}
${row.steps}`;
    const seeds = extractContactSeedsFromText(blob, { tier: "procedural", id: row.id });
    for (const s of seeds) {
      seedsFound++;
      const r = upsert({
        displayName: s.displayName,
        normalizedKey: s.normalizedKey,
        topicsToAppend: [s.topicLine],
        sourceMemoryRef: s.memoryRef
      });
      if (r.inserted) created++;
      else updated++;
    }
  }
  return {
    scanned: { episodic: episodic.length, semantic: semantic.length, procedural: procedural.length },
    seedsFound,
    created,
    updated
  };
}

export {
  normalizeContactKey,
  extractContactSeedsFromText,
  seedContactsFromMemories
};
