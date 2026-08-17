// src/earner/earn-cycle.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync } from "fs";
import { join as join2 } from "path";

// src/earner/first-ten-store.ts
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

// src/earner/micro-product.ts
var FIRST_TEN_TARGET_USD = 10;
var OPERATOR_CLEANUP_10 = {
  sku: "operator-cleanup-10",
  title: "Operator Cleanup Audit",
  priceUsd: 10,
  pitch: "One read-only pass over your operator stack (repo, shell, automations, AI-agent setup). You get 3 real leaks + 1 next action within 24h.",
  deliverableDescription: "Markdown report: 3 highest-impact leaks (time/tokens/money/risk), 1 next action, and a quick-wins list.",
  turnaroundHours: 24,
  financeProject: "operator-cleanup-10"
};
var MICRO_PRODUCTS = {
  "operator-cleanup-10": OPERATOR_CLEANUP_10
};
function getMicroProduct(sku) {
  const product = MICRO_PRODUCTS[sku];
  if (!product) throw new Error(`unknown micro-product sku: ${sku}`);
  return product;
}
function buildCleanupDeliverable(input) {
  if (input.findings.length !== 3) {
    throw new Error(
      `operator-cleanup-10 requires exactly 3 findings, got ${input.findings.length}`
    );
  }
  const when = input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const wins = input.quickWins?.length ? input.quickWins : [
    "Delete or archive dead scripts that have not been run in 90+ days",
    "Add a single morning brief that surfaces stale deals only",
    "Pin max-token / daily budget hard stops for agent runs"
  ];
  const findingBlocks = input.findings.map(
    (f, i) => `### ${i + 1}. ${f.title}

**Why it matters:** ${f.whyItMatters}

**Fix:** ${f.fix}
`
  ).join("\n");
  return [
    `# Operator Cleanup Audit`,
    ``,
    `**Subject:** ${input.subject}`,
    `**Generated:** ${when}`,
    `**SKU:** operator-cleanup-10 \xB7 **Price:** $10`,
    ``,
    `## 3 Leaks`,
    ``,
    findingBlocks,
    `## 1 Next Action`,
    ``,
    input.nextAction,
    ``,
    `## Quick wins`,
    ``,
    ...wins.map((w) => `- ${w}`),
    ``,
    `---`,
    `*Delivered by Zaraa \xB7 operator-cleanup-10*`,
    ``
  ].join("\n");
}

// src/earner/first-ten-store.ts
var FirstTenStore = class {
  db;
  constructor(config) {
    this.db = new Database(config.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 8000");
    this.db.prepare(
      `
			CREATE TABLE IF NOT EXISTS first_ten_sales (
				id TEXT PRIMARY KEY,
				sku TEXT NOT NULL,
				amountUsd REAL NOT NULL,
				mode TEXT NOT NULL,
				externalRef TEXT,
				evidencePath TEXT,
				description TEXT NOT NULL,
				createdAt TEXT NOT NULL
			)
		`
    ).run();
    this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_first_ten_mode ON first_ten_sales(mode, createdAt)"
    ).run();
    this.db.prepare(
      `
			CREATE UNIQUE INDEX IF NOT EXISTS idx_first_ten_live_ref
			ON first_ten_sales(externalRef)
			WHERE mode = 'live' AND externalRef IS NOT NULL AND externalRef != ''
		`
    ).run();
  }
  /**
   * Record a paid sale toward the first-$10 goal.
   * Live mode rejects missing externalRef; rejects non-positive amounts.
   */
  recordSale(input) {
    if (!(input.amountUsd > 0) || Number.isNaN(input.amountUsd)) {
      throw new Error(`amountUsd must be positive, got ${input.amountUsd}`);
    }
    if (input.mode !== "live" && input.mode !== "paper") {
      throw new Error(`invalid sale mode: ${input.mode}`);
    }
    const externalRef = input.externalRef?.trim() || null;
    if (input.mode === "live" && !externalRef) {
      throw new Error("live sales require a non-empty externalRef");
    }
    const id = `sale-${randomUUID()}`;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const sale = {
      id,
      sku: input.sku,
      amountUsd: input.amountUsd,
      mode: input.mode,
      externalRef,
      evidencePath: input.evidencePath ?? null,
      description: input.description ?? `${input.mode} sale ${input.sku} $${input.amountUsd.toFixed(2)}`,
      createdAt: now
    };
    try {
      this.db.prepare(
        `
				INSERT INTO first_ten_sales
					(id, sku, amountUsd, mode, externalRef, evidencePath, description, createdAt)
				VALUES
					(@id, @sku, @amountUsd, @mode, @externalRef, @evidencePath, @description, @createdAt)
			`
      ).run(sale);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("unique")) {
        throw new Error(
          `duplicate live externalRef: ${externalRef} (already recorded)`
        );
      }
      throw err;
    }
    return sale;
  }
  getSale(id) {
    const row = this.db.prepare("SELECT * FROM first_ten_sales WHERE id = ?").get(id);
    return row;
  }
  listSales(mode) {
    if (mode) {
      return this.db.prepare(
        "SELECT * FROM first_ten_sales WHERE mode = ? ORDER BY createdAt ASC"
      ).all(mode);
    }
    return this.db.prepare("SELECT * FROM first_ten_sales ORDER BY createdAt ASC").all();
  }
  getProgress() {
    const live = this.db.prepare(
      "SELECT COALESCE(SUM(amountUsd), 0) AS total FROM first_ten_sales WHERE mode = 'live'"
    ).get();
    const paper = this.db.prepare(
      "SELECT COALESCE(SUM(amountUsd), 0) AS total FROM first_ten_sales WHERE mode = 'paper'"
    ).get();
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM first_ten_sales").get();
    const livePaidUsd = Number(live.total) || 0;
    const paperPaidUsd = Number(paper.total) || 0;
    return {
      targetUsd: FIRST_TEN_TARGET_USD,
      livePaidUsd,
      paperPaidUsd,
      liveGoalMet: livePaidUsd >= FIRST_TEN_TARGET_USD,
      paperGoalMet: paperPaidUsd >= FIRST_TEN_TARGET_USD,
      saleCount: Number(count.n) || 0
    };
  }
  /** Live path: real dollars received. */
  isLiveGoalMet() {
    return this.getProgress().liveGoalMet;
  }
  /** Paper path: proves the earn machinery without external payment. */
  isPaperGoalMet() {
    return this.getProgress().paperGoalMet;
  }
  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
};

// src/earner/payment-receipt.ts
import { readdirSync, readFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
function parsePaymentReceipt(raw, sourcePath = "<memory>") {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, error: "receipt must be a JSON object", sourcePath };
  }
  const obj = raw;
  const sku = obj.sku;
  if (typeof sku !== "string" || !(sku in MICRO_PRODUCTS)) {
    return {
      ok: false,
      error: `invalid or unknown sku: ${String(sku)}`,
      sourcePath
    };
  }
  const amountUsd = Number(obj.amountUsd);
  if (!(amountUsd > 0) || Number.isNaN(amountUsd)) {
    return {
      ok: false,
      error: `amountUsd must be positive, got ${String(obj.amountUsd)}`,
      sourcePath
    };
  }
  const externalRef = typeof obj.externalRef === "string" ? obj.externalRef.trim() : "";
  if (!externalRef) {
    return {
      ok: false,
      error: "externalRef is required for live receipts",
      sourcePath
    };
  }
  const product = MICRO_PRODUCTS[sku];
  if (amountUsd + 1e-9 < product.priceUsd) {
    return {
      ok: false,
      error: `amountUsd ${amountUsd} is below product price ${product.priceUsd}`,
      sourcePath
    };
  }
  return {
    ok: true,
    receipt: {
      sku,
      amountUsd,
      externalRef,
      subject: typeof obj.subject === "string" ? obj.subject : void 0,
      paidAt: typeof obj.paidAt === "string" ? obj.paidAt : void 0,
      sourcePath
    }
  };
}
function loadPaymentReceiptFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    const raw = JSON.parse(text);
    return parsePaymentReceipt(raw, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, sourcePath: filePath };
  }
}
function scanReceiptDirectory(dir) {
  const valid = [];
  const invalid = [];
  if (!existsSync(dir)) {
    return { valid, invalid };
  }
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  for (const name of names) {
    const path = join(dir, name);
    const result = loadPaymentReceiptFile(path);
    if (result.ok) valid.push(result.receipt);
    else invalid.push(result);
  }
  return { valid, invalid };
}
function archiveReceipt(sourcePath, processedDir) {
  if (!existsSync(processedDir)) {
    mkdirSync(processedDir, { recursive: true });
  }
  const dest = join(processedDir, basename(sourcePath));
  renameSync(sourcePath, dest);
  return dest;
}

// src/earner/earn-cycle.ts
function firstTenDbPath(dataDir) {
  if (dataDir === ":memory:" || dataDir.endsWith(".db")) return dataDir;
  return join2(dataDir, "first-ten.db");
}
function defaultSelfAuditFindings() {
  return [
    {
      title: "Revenue offers die of non-send (motion without a move)",
      whyItMatters: "Three complete earner assets sat 35+ days at stage lead then were killed as lost with zero external sends. Drafts and checkpoints are not income.",
      fix: "Hard SLA: assets-ready \u2192 first external move within 3 days, or explicit kill. Wire TTFEM into morning brief; stop re-drafting nudges as a substitute for a send decision."
    },
    {
      title: "Affiliate site live but Associates tag is still a placeholder",
      whyItMatters: "The configured affiliate deployment is public with real reviews, yet NEXT_PUBLIC_AMZN_TAG remains REPLACE-WITH-YOUR-TAG-20 so every Amazon click earns $0.",
      fix: "Create/approve Amazon Associates, set the real tag in Vercel + .env.local, redeploy production, then measure first tagged click within 7 days."
    },
    {
      title: "Trading earner has no proven edge while still consuming cycles",
      whyItMatters: "Honest GATE-1 returned 0/4284 configs. Continuing directional edge-search burns operator attention and autonomy budget without a path to $10.",
      fix: "Park directional live ambitions behind GATE-1 VALIDATED only. Reallocate autonomy budget to micro-product delivery + receipt intake until first $10 live is booked."
    }
  ];
}
function writeDeliverable(dir, saleId, markdown) {
  if (!existsSync2(dir)) mkdirSync2(dir, { recursive: true });
  const path = join2(dir, `${saleId}.md`);
  writeFileSync(path, markdown, "utf8");
  return path;
}
function runFirstTenCycle(config) {
  const actions = [];
  const errors = [];
  const deliverablePaths = [];
  let salesRecorded = 0;
  const dbPath = firstTenDbPath(config.dataDir);
  if (config.dataDir !== ":memory:" && !config.dataDir.endsWith(".db")) {
    if (!existsSync2(config.dataDir)) mkdirSync2(config.dataDir, { recursive: true });
  }
  const store = new FirstTenStore({ path: dbPath });
  const product = OPERATOR_CLEANUP_10;
  const deliverableDir = config.deliverableDir ?? (config.dataDir === ":memory:" ? join2("/tmp", "zaraa-first-ten-deliverables") : join2(config.dataDir, "first-ten-deliverables"));
  const receiptDir = config.receiptDir ?? (config.dataDir === ":memory:" ? join2("/tmp", "zaraa-first-ten-receipts") : join2(config.dataDir, "first-ten-receipts"));
  try {
    if (config.dealStore) {
      const active = config.dealStore.list({ activeOnly: true, limit: 50 });
      const existing = active.find(
        (d) => d.title.toLowerCase().includes("operator cleanup") || (d.notes ?? "").includes(product.sku)
      );
      if (!existing) {
        const deal = config.dealStore.create({
          title: `${product.title} \u2014 $${product.priceUsd}`,
          source: "first-ten-cycle",
          valueUsd: product.priceUsd,
          probability: 0.3,
          nextAction: "Publish offer + arm receipt intake; first paid receipt completes live goal",
          notes: `sku=${product.sku}; auto-seeded by runFirstTenCycle`
        });
        actions.push(`seeded_deal:${deal.id}`);
      } else {
        actions.push(`deal_exists:${existing.id}`);
      }
    }
    if (config.mode === "paper") {
      const before = store.getProgress();
      if (!before.paperGoalMet) {
        const remaining = Math.max(
          0,
          FIRST_TEN_TARGET_USD - before.paperPaidUsd
        );
        const amount = remaining > 0 ? remaining : product.priceUsd;
        const subject = config.paperSubject ?? "Zaraa operator stack (self-audit paper sale)";
        const markdown = buildCleanupDeliverable({
          subject,
          findings: defaultSelfAuditFindings(),
          nextAction: "Send or kill every assets-ready offer within 3 days; set a real Amazon Associates tag before any more affiliate content ships."
        });
        const sale = store.recordSale({
          sku: product.sku,
          amountUsd: amount,
          mode: "paper",
          externalRef: null,
          description: `[paper] ${product.title} $${amount.toFixed(2)}`
        });
        salesRecorded += 1;
        const path = writeDeliverable(deliverableDir, sale.id, markdown);
        deliverablePaths.push(path);
        actions.push(`paper_sale:${sale.id}:$${amount}`);
        actions.push(`deliverable:${path}`);
        if (config.financeStore) {
          config.financeStore.logRevenue({
            project: product.financeProject,
            amount,
            description: `[paper] ${product.title} sale ${sale.id}`,
            status: "paid"
          });
          actions.push("finance_logged:paper");
        }
      } else {
        actions.push("paper_goal_already_met");
      }
    }
    if (config.mode === "live") {
      if (!existsSync2(receiptDir)) {
        mkdirSync2(receiptDir, { recursive: true });
        actions.push(`receipt_dir_ready:${receiptDir}`);
      }
      const { valid, invalid } = scanReceiptDirectory(receiptDir);
      for (const bad of invalid) {
        errors.push(`invalid_receipt:${bad.sourcePath}:${bad.error}`);
      }
      const processedDir = join2(receiptDir, "processed");
      for (const receipt of valid) {
        try {
          const subject = receipt.subject ?? "live buyer";
          const markdown = buildCleanupDeliverable({
            subject,
            findings: defaultSelfAuditFindings(),
            nextAction: "Confirm delivery with buyer; log any follow-up as a new deal only if they request more work.",
            generatedAt: receipt.paidAt
          });
          const sale = store.recordSale({
            sku: receipt.sku,
            amountUsd: receipt.amountUsd,
            mode: "live",
            externalRef: receipt.externalRef,
            evidencePath: receipt.sourcePath,
            description: `[live] ${product.title} ref=${receipt.externalRef}`
          });
          salesRecorded += 1;
          const path = writeDeliverable(deliverableDir, sale.id, markdown);
          deliverablePaths.push(path);
          const archived = archiveReceipt(receipt.sourcePath, processedDir);
          actions.push(`live_sale:${sale.id}:$${receipt.amountUsd}`);
          actions.push(`deliverable:${path}`);
          actions.push(`archived_receipt:${archived}`);
          if (config.financeStore) {
            config.financeStore.logRevenue({
              project: product.financeProject,
              amount: receipt.amountUsd,
              description: `[live] ${product.title} ref=${receipt.externalRef} sale=${sale.id}`,
              status: "paid"
            });
            actions.push("finance_logged:live");
          }
          if (config.invoiceStore) {
            const inv = config.invoiceStore.markPaid(receipt.externalRef);
            if (inv) actions.push(`invoice_paid:${inv.externalRef}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`live_sale_error:${receipt.externalRef}:${msg}`);
        }
      }
      if (valid.length === 0) {
        actions.push("no_live_receipts");
      }
    }
    const progress = store.getProgress();
    actions.push(
      `progress:live=$${progress.livePaidUsd}/$${progress.targetUsd} paper=$${progress.paperPaidUsd}`
    );
    return {
      mode: config.mode,
      progress,
      actions,
      salesRecorded,
      deliverablePaths,
      errors
    };
  } finally {
    store.close();
  }
}

export {
  FIRST_TEN_TARGET_USD,
  OPERATOR_CLEANUP_10,
  MICRO_PRODUCTS,
  getMicroProduct,
  buildCleanupDeliverable,
  FirstTenStore,
  parsePaymentReceipt,
  loadPaymentReceiptFile,
  scanReceiptDirectory,
  archiveReceipt,
  defaultSelfAuditFindings,
  runFirstTenCycle
};
