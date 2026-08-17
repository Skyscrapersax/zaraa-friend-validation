/**
 * vitest.e2e.config.ts
 *
 * Vitest configuration for End-to-End (E2E) tests.
 *
 * E2E tests are different from unit tests:
 *   - They boot a REAL HTTP server (on a random port)
 *   - They make REAL HTTP requests with fetch()
 *   - They use REAL in-memory SQLite databases
 *   - They mock only external services (LLM providers, exchanges)
 *
 * Run with:  pnpm test:e2e
 * Or:        npx vitest run --config vitest.e2e.config.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Vite plugin that imports .sql files as string literals (same as tsup's loader). */
function sqlPlugin(): Plugin {
  return {
    name: "sql-loader",
    transform(_code, id) {
      if (id.endsWith(".sql")) {
        const content = readFileSync(id, "utf-8");
        return { code: `export default ${JSON.stringify(content)};`, map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [sqlPlugin()],
  resolve: {
    alias: {
      // Map workspace package names to their TypeScript source files.
      // This lets E2E tests import from packages without needing a build step.
      // Vitest handles the .js → .ts extension substitution automatically.
      "@zaraa/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@zaraa/plugin-trading": resolve(__dirname, "plugins/plugin-trading/src/index.ts"),
    },
  },
  test: {
    // Only pick up files inside tests/e2e/ — don't mix with unit tests
    include: ["tests/e2e/**/*.test.ts"],

    // E2E tests can be slower (server startup, async processing)
    timeout: 30_000,

    // Run E2E test files sequentially so servers don't conflict.
    // Within each file, tests still run in order.
    pool: "forks",
    singleFork: true,

    // Set NODE_ENV so code can skip dev-only features in tests
    env: {
      NODE_ENV: "test",
      // Keep e2e output focused by defaulting to non-debug logs.
      LOG_LEVEL: "warn",
    },
  },
});
