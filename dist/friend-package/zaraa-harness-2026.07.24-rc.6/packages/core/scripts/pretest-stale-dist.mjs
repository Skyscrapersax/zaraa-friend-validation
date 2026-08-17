#!/usr/bin/env node
/**
 * pretest-stale-dist.mjs (ngt-0742)
 *
 * Guards against the build-before-test trap: when dist/index.js exists but
 * TypeScript source files in src/runtime/ are newer, vitest may resolve
 * cross-package imports through the stale compiled bundle rather than the
 * live TypeScript source, producing ghost test results.
 *
 * Exits 0 when dist is absent (vitest uses TypeScript source directly) or
 * when dist is up to date. Exits 1 with a clear message when stale source
 * is detected — blocking vitest from running on a stale build.
 *
 * Measurable signal: count of times this script exits 1 per week.
 * Target: 0 (guard never fires = edits always followed by a build).
 * Non-zero: guard is earning its keep; consider a PostToolUse hook at IDE layer.
 */
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

const DIST = 'dist/index.js';
const SRC_DIRS = ['src/runtime', 'src/memory', 'src/policy'];

if (!existsSync(DIST)) {
  // No dist built yet — vitest transforms TypeScript source directly.
  process.exit(0);
}

const distMtime = statSync(DIST).mtimeMs;
const stale = [];

for (const dir of SRC_DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
    const fp = join(dir, f);
    if (statSync(fp).mtimeMs > distMtime) {
      stale.push(fp);
    }
  }
}

if (stale.length > 0) {
  console.error('\n[pretest] ⚠ stale dist detected — the following source files are newer than dist/index.js:');
  for (const f of stale) console.error(`  ${f}`);
  console.error('[pretest] Fix: pnpm --filter @zaraa/core build\n');
  process.exit(1);
}
