import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/** Vite plugin that treats .sql files as plain text string exports (mirrors tsup loader). */
function sqlTextPlugin(): Plugin {
	return {
		name: "sql-text",
		transform(code, id) {
			if (id.endsWith(".sql")) {
				return `export default ${JSON.stringify(code)};`;
			}
		},
	};
}

export default defineConfig({
	plugins: [sqlTextPlugin()],
	test: {
		// Live Execution and other suites share `let store` / mocks per file; concurrent
		// tests within the same file can race and flake (e.g. idempotency vs RiskManager).
		maxConcurrency: 1,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
			thresholds: {
				// Ratchet (non-regression floor ~2-3pts below measured actual, never above).
				// Measured 2026-06-15: 64.35% lines, 54.91% branches, 61.92% functions
				// (2400 tests). Climbing toward the 75% target; these floors lock in the gains.
				lines: 62,
				branches: 52,
				functions: 59,
			},
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
		},
	},
});
