#!/usr/bin/env node
/**
 * flake-gate.mjs — CI guard for the flake registry / vitest quarantine sync.
 *
 * Rules enforced:
 *   1. Every quarantined entry in flake-registry.json must appear in
 *      vitest.config.ts test.exclude (drift detection).
 *   2. Every triage entry must have a deadline set.
 *   3. Any triage entry whose deadline has passed exits 1 (stale triage).
 *   4. Every path in vitest.config.ts exclude list must have a registry entry
 *      with status quarantined or watch (no shadow exclusions).
 *   5. An entry can't claim `fixedIn` (a landed commit) while its `note`
 *      still says the fix is pending commit — that's a stale note lying
 *      about the entry's real state (see flake-gate.test.ts for the bug
 *      this caught: flake-005/006/007 kept "(pending-commit)" notes after
 *      fixedIn was populated with the actual commit that landed them).
 *
 * Usage:
 *   node packages/core/scripts/flake-gate.mjs          # normal check
 *   node packages/core/scripts/flake-gate.mjs --json   # machine-readable output
 *
 * Exit codes:
 *   0 — clean (no violations)
 *   1 — violations found (CI should block)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const JSON_FLAG = process.argv.includes("--json");

export function computeViolations(registry, vitestConfig, today) {
	const violations = [];

	// ── Rule 1: quarantine sync ────────────────────────────────────────────
	const quarantined = registry.entries.filter((e) => e.status === "quarantined");
	for (const entry of quarantined) {
		// Extract the path after "packages/core/" so it matches the vitest exclude pattern
		const vitestPath = entry.file.replace(/^packages\/core\//, "");
		if (!vitestConfig.includes(JSON.stringify(vitestPath))) {
			violations.push({
				rule: "quarantine-sync",
				id: entry.id,
				file: entry.file,
				message: `Quarantined test '${vitestPath}' is not in vitest.config.ts exclude list`,
			});
		}
	}

	// ── Rule 4: no shadow exclusions (every excluded path has a registry entry)
	// Parse the exclude array from vitest.config.ts as a simple text scan.
	// This avoids eval while catching the common pattern used in this project.
	// Match specific test file paths (no glob wildcards) to avoid matching coverage exclude globs
	const excludeMatches = vitestConfig.matchAll(/"(src\/[^"*?]+\.test\.ts)"/g);
	const registeredPaths = new Set(
		registry.entries
			.filter((e) => e.status === "quarantined" || e.status === "watch")
			.map((e) => e.file.replace(/^packages\/core\//, "")),
	);
	for (const [, path] of excludeMatches) {
		if (!registeredPaths.has(path)) {
			violations.push({
				rule: "shadow-exclusion",
				id: null,
				file: path,
				message: `vitest excludes '${path}' but it has no quarantined/watch registry entry — add to flake-registry.json`,
			});
		}
	}

	// ── Rule 2: triage entries must have a deadline ───────────────────────
	const triage = registry.entries.filter((e) => e.status === "triage");
	for (const entry of triage) {
		if (!entry.deadline) {
			violations.push({
				rule: "missing-deadline",
				id: entry.id,
				file: entry.file,
				message: `Triage entry '${entry.id}' has no deadline set`,
			});
		}
	}

	// ── Rule 3: stale triage ────────────────────────────────────────────────
	for (const entry of triage) {
		if (entry.deadline && entry.deadline < today) {
			violations.push({
				rule: "stale-triage",
				id: entry.id,
				file: entry.file,
				message: `Triage entry '${entry.id}' deadline ${entry.deadline} has passed — escalate to quarantined or fix`,
			});
		}
	}

	// ── Rule 5: fixedIn set but note still says pending-commit ─────────────
	for (const entry of registry.entries) {
		if (entry.fixedIn && entry.note && /pending-commit/i.test(entry.note)) {
			violations.push({
				rule: "stale-pending-commit-note",
				id: entry.id,
				file: entry.file,
				message: `Entry '${entry.id}' has fixedIn:"${entry.fixedIn}" (already landed) but note still says "pending-commit" — update the note`,
			});
		}
	}

	return violations;
}

function summarize(registry, violations) {
	return {
		total: registry.entries.length,
		quarantined: registry.entries.filter((e) => e.status === "quarantined").length,
		triage: registry.entries.filter((e) => e.status === "triage").length,
		watch: registry.entries.filter((e) => e.status === "watch").length,
		fixed: registry.entries.filter((e) => e.status === "fixed").length,
		violations: violations.length,
	};
}

// Only run the CLI when this file is executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
	runCli();
}

function runCli() {
	// ── Load registry ──────────────────────────────────────────────────────
	const registry = JSON.parse(
		readFileSync(resolve(ROOT, "flake-registry.json"), "utf8"),
	);
	const vitestConfig = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
	const today = new Date().toISOString().slice(0, 10);

	const violations = computeViolations(registry, vitestConfig, today);
	const summary = summarize(registry, violations);

	printReport(summary, violations);
	process.exit(violations.length > 0 ? 1 : 0);
}

function printReport(summary, violations) {
if (JSON_FLAG) {
  console.log(JSON.stringify({ summary, violations }, null, 2));
} else {
  console.log("\n── Flake Registry Gate ──────────────────────────────────");
  console.log(
    `  Total: ${summary.total}  |  Quarantined: ${summary.quarantined}  |  Triage: ${summary.triage}  |  Watch: ${summary.watch}  |  Fixed: ${summary.fixed}`,
  );
  if (violations.length === 0) {
    console.log("  ✓ No violations — registry and vitest config are in sync.\n");
  } else {
    console.log(`\n  ✗ ${violations.length} violation(s):\n`);
    for (const v of violations) {
      console.log(`  [${v.rule}] ${v.id}: ${v.message}`);
    }
    console.log();
  }
}
}
