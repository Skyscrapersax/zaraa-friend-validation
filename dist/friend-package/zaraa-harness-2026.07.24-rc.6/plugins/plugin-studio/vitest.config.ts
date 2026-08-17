import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

process.env.ZARAA_STUDIO_RENDER_LOAD_THRESHOLD ??= "64";

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
		fileParallelism: false,
		maxWorkers: 1,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
			thresholds: {
				// Ratchet (non-regression floor ~2-3pts below measured actual, never above).
				// Measured 2026-06-16: 93.98% lines, 69.76% branches, 84.78% functions
				// (53 tests, all passing — the old "pre-existing failures" note is stale).
				lines: 91,
				branches: 67,
				functions: 82,
			},
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
		},
	},
});
