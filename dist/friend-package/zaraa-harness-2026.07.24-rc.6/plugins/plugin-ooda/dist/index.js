// src/presets.ts
var PRESETS = {
  trading: {
    name: "trading",
    description: "Market analysis and trade decisions",
    observers: [
      { key: "btcPrice", tool: "trade_get_price", args: { symbol: "BTC_USDT" } },
      { key: "ethPrice", tool: "trade_get_price", args: { symbol: "ETH_USDT" } },
      { key: "solPrice", tool: "trade_get_price", args: { symbol: "SOL_USDT" } },
      { key: "portfolio", tool: "trade_portfolio", args: {} },
      { key: "signals", tool: "trade_scan_signals", args: {} },
      { key: "marketNews", tool: "web_search", args: { query: "crypto market news today", count: 3 } }
    ],
    orientGuidance: "Compare against historical patterns, assess regime (trending/ranging/volatile), evaluate risk exposure and position sizing. Factor in recent market news sentiment \u2014 bullish or bearish headlines may indicate near-term momentum shifts.",
    decideGuidance: "Recommend entry/exit/hold. Include confidence 0-1, risk level, position sizing rationale, and alternatives."
  },
  agent: {
    name: "agent",
    description: "System health and self-improvement decisions",
    observers: [
      { key: "health", tool: "memory_search", args: { query: "system health status" } }
    ],
    orientGuidance: "Compare metrics against baselines. Identify anomalies, degradation trends, or underperforming models.",
    decideGuidance: "Recommend: fix, escalate, or ignore. Rate risk."
  },
  "problem-solving": {
    name: "problem-solving",
    description: "Structured problem decomposition and solution planning",
    observers: [],
    orientGuidance: "Decompose into sub-problems. Identify constraints. Recall similar past solutions.",
    decideGuidance: "Pick the best approach with rationale. Estimate effort and risk. List alternatives."
  }
};
function getPreset(name) {
  return PRESETS[name] ?? null;
}

// src/ooda-engine.ts
var OODACycleEngine = class {
  config;
  constructor(config) {
    this.config = config;
  }
  async observe(opts) {
    const start = Date.now();
    const preset = getPreset(opts.preset);
    const observers = opts.preset === "custom" ? opts.customObservers ?? [] : preset?.observers ?? [];
    const data = {};
    for (const obs of observers) {
      try {
        data[obs.key] = await this.config.toolExecutor(obs.tool, obs.args);
      } catch {
        data[obs.key] = null;
      }
    }
    return { data, summary: this.summarizeObservations(data), durationMs: Date.now() - start };
  }
  async runCycle(opts) {
    const id = `ooda-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cycleStart = Date.now();
    this.config.onEvent?.({ type: "ooda.cycle.started", data: { id, preset: opts.preset, context: opts.context } });
    const observeResult = await this.observe(opts);
    const recentCycles = this.config.store.getRecentCycles(opts.preset, 3);
    const orientStart = Date.now();
    let llmResult;
    try {
      llmResult = await this.config.llmCall(observeResult.data, opts.context, opts.preset, recentCycles);
    } catch (err) {
      const failedCycle = {
        id,
        preset: opts.preset,
        context: opts.context ?? null,
        phases: {
          observe: observeResult,
          orient: { analysis: "LLM call failed", patterns: [], durationMs: Date.now() - orientStart },
          decide: { decision: "Unable to decide", confidence: 0, risk: "high", alternatives: [], durationMs: 0 },
          act: { action: "No action", executed: false, result: err instanceof Error ? err.message : String(err), durationMs: 0 }
        },
        outcome: "failed",
        totalDurationMs: Date.now() - cycleStart
      };
      this.config.store.saveCycle(failedCycle);
      return failedCycle;
    }
    const orientDurationMs = Date.now() - orientStart;
    const actStart = Date.now();
    const shouldExecute = llmResult.act.shouldExecute && llmResult.decide.risk === "low";
    const cycle = {
      id,
      preset: opts.preset,
      context: opts.context ?? null,
      phases: {
        observe: observeResult,
        orient: { analysis: llmResult.orient.analysis, patterns: llmResult.orient.patterns, durationMs: orientDurationMs },
        decide: { ...llmResult.decide, durationMs: orientDurationMs },
        act: { action: llmResult.act.action, executed: shouldExecute, result: shouldExecute ? "Approved for execution" : null, durationMs: Date.now() - actStart }
      },
      outcome: shouldExecute ? "pending" : null,
      totalDurationMs: Date.now() - cycleStart
    };
    this.config.store.saveCycle(cycle);
    this.config.onEvent?.({ type: "ooda.cycle.completed", data: { id, preset: opts.preset, decision: llmResult.decide.decision, risk: llmResult.decide.risk, confidence: llmResult.decide.confidence, durationMs: cycle.totalDurationMs } });
    return cycle;
  }
  formatSummary(cycle) {
    const p = cycle.phases;
    const conf = (p.decide.confidence * 100).toFixed(0);
    const actionLine = p.act.executed ? `Action: ${p.act.action} (executed)` : p.decide.risk === "low" ? `Action: ${p.act.action}` : `Action: ${p.act.action} \u2014 awaiting approval`;
    return [
      `OODA [${cycle.preset}] complete (${(cycle.totalDurationMs / 1e3).toFixed(1)}s):`,
      `  Observe: ${p.observe.summary}`,
      `  Orient: ${p.orient.analysis}`,
      `  Decide: ${p.decide.decision} (confidence: ${conf}%, risk: ${p.decide.risk})`,
      `  ${actionLine}`
    ].join("\n");
  }
  summarizeObservations(data) {
    const parts = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === null) {
        parts.push(`${key}: unavailable`);
        continue;
      }
      if (typeof value === "object") {
        const v = value;
        if (v.price !== void 0) parts.push(`${key}: $${v.price}`);
        else if (v.positions !== void 0) parts.push(`${key}: ${v.positions.length} positions`);
        else if (v.signals !== void 0) parts.push(`${key}: ${v.signals.length} signals`);
        else parts.push(`${key}: ${JSON.stringify(value).slice(0, 80)}`);
      } else {
        parts.push(`${key}: ${String(value).slice(0, 80)}`);
      }
    }
    return parts.join(", ") || "No observations (context-only)";
  }
};

// src/ooda-store.ts
var OODAStore = class {
  db;
  constructor(db) {
    this.db = db;
    db.pragma("journal_mode = WAL");
    this.initSchema();
  }
  initSchema() {
    const createTable = `
			CREATE TABLE IF NOT EXISTS ooda_cycles (
				id TEXT PRIMARY KEY,
				preset TEXT NOT NULL,
				context TEXT,
				phases TEXT NOT NULL,
				decision TEXT,
				confidence REAL,
				risk TEXT,
				action TEXT,
				executed INTEGER DEFAULT 0,
				outcome TEXT,
				totalDurationMs INTEGER,
				createdAt TEXT NOT NULL
			)
		`;
    const createPresetIdx = `CREATE INDEX IF NOT EXISTS idx_ooda_preset ON ooda_cycles(preset)`;
    const createCreatedIdx = `CREATE INDEX IF NOT EXISTS idx_ooda_created ON ooda_cycles(createdAt)`;
    this.db.prepare(createTable).run();
    this.db.prepare(createPresetIdx).run();
    this.db.prepare(createCreatedIdx).run();
  }
  saveCycle(cycle) {
    const decide = cycle.phases?.decide;
    const act = cycle.phases?.act;
    this.db.prepare(`
			INSERT OR REPLACE INTO ooda_cycles (id, preset, context, phases, decision, confidence, risk, action, executed, outcome, totalDurationMs, createdAt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
      cycle.id,
      cycle.preset,
      cycle.context ?? null,
      JSON.stringify(cycle.phases),
      decide?.decision ?? null,
      decide?.confidence ?? null,
      decide?.risk ?? null,
      act?.action ?? null,
      act?.executed ? 1 : 0,
      cycle.outcome ?? null,
      cycle.totalDurationMs,
      cycle.createdAt ?? (/* @__PURE__ */ new Date()).toISOString()
    );
  }
  getCycle(id) {
    const row = this.db.prepare("SELECT * FROM ooda_cycles WHERE id = ?").get(id);
    return row ? this.rowToCycle(row) : null;
  }
  getRecentCycles(preset, limit = 5) {
    const sql = preset ? "SELECT * FROM ooda_cycles WHERE preset = ? ORDER BY createdAt DESC LIMIT ?" : "SELECT * FROM ooda_cycles ORDER BY createdAt DESC LIMIT ?";
    const rows = preset ? this.db.prepare(sql).all(preset, limit) : this.db.prepare(sql).all(limit);
    return rows.map((r) => this.rowToCycle(r));
  }
  updateOutcome(id, outcome) {
    this.db.prepare("UPDATE ooda_cycles SET outcome = ? WHERE id = ?").run(outcome, id);
  }
  rowToCycle(row) {
    return {
      id: row.id,
      preset: row.preset,
      context: row.context,
      phases: JSON.parse(row.phases),
      outcome: row.outcome,
      totalDurationMs: row.totalDurationMs,
      createdAt: row.createdAt
    };
  }
};

// src/index.ts
var manifest = {
  name: "ooda",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["reasoning.ooda"],
  trust: "core",
  tools: [
    {
      name: "ooda_cycle",
      description: "Run a structured OODA (Observe-Orient-Decide-Act) cycle. Use for complex decisions: trading signals, system problems, multi-step tasks. Returns a compact summary with observation, analysis, decision (with confidence and risk level), and recommended action.",
      parameters: {
        type: "object",
        properties: {
          preset: { type: "string", enum: ["trading", "agent", "problem-solving", "custom"], description: 'MUST be exactly one of: "trading", "agent", "problem-solving", "custom"' },
          context: { type: "string", description: "Situation description or question" },
          urgency: { type: "string", description: '"low", "normal", or "high"' }
        },
        required: ["preset"]
      },
      requiresApproval: false
    },
    {
      name: "ooda_observe",
      description: "Run only the Observe phase \u2014 gather data without analyzing or deciding. For situational awareness.",
      parameters: {
        type: "object",
        properties: {
          preset: { type: "string", description: "Domain preset" },
          context: { type: "string", description: "Optional context" }
        },
        required: ["preset"]
      },
      requiresApproval: false
    },
    {
      name: "ooda_get_cycles",
      description: "Retrieve past OODA cycles for review \u2014 shows decisions, outcomes, and patterns.",
      parameters: {
        type: "object",
        properties: {
          preset: { type: "string", description: "Filter by preset" },
          limit: { type: "number", description: "Max cycles (default: 5)" }
        },
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createOODAHandlers(deps) {
  const engine = new OODACycleEngine({
    toolExecutor: deps.toolExecutor,
    llmCall: deps.llmCall,
    store: deps.store,
    onEvent: deps.onEvent
  });
  const VALID_PRESETS = /* @__PURE__ */ new Set(["trading", "agent", "problem-solving", "custom"]);
  const normalizePreset = (raw) => {
    const s = String(raw ?? "").toLowerCase();
    if (VALID_PRESETS.has(s)) return s;
    for (const p of VALID_PRESETS) {
      if (s.includes(p)) return p;
    }
    return "problem-solving";
  };
  return {
    ooda_cycle: async (args) => {
      const cycle = await engine.runCycle({
        preset: normalizePreset(args.preset),
        context: args.context,
        urgency: args.urgency
      });
      return engine.formatSummary(cycle);
    },
    ooda_observe: async (args) => {
      const result = await engine.observe({
        preset: normalizePreset(args.preset),
        context: args.context
      });
      return `Observations (${args.preset}):
${result.summary}

Raw data:
${JSON.stringify(result.data, null, 2).slice(0, 2e3)}`;
    },
    ooda_get_cycles: async (args) => {
      const cycles = deps.store.getRecentCycles(args.preset, args.limit || 5);
      if (cycles.length === 0) return `No OODA cycles found${args.preset ? ` for "${args.preset}"` : ""}.`;
      const summaries = cycles.map((c) => {
        const d = c.phases?.decide;
        return `[${c.createdAt?.slice(0, 19)}] ${c.preset}: ${d?.decision ?? "?"} (conf=${d?.confidence ?? "?"}, risk=${d?.risk ?? "?"}, outcome=${c.outcome ?? "pending"})`;
      });
      return `${cycles.length} cycles:
${summaries.join("\n")}`;
    }
  };
}
export {
  OODACycleEngine,
  OODAStore,
  PRESETS,
  createOODAHandlers,
  getPreset,
  manifest
};
