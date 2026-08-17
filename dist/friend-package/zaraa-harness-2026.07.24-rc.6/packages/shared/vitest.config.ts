import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
			thresholds: {
				// Ratchet (non-regression floor ~2-3pts below measured actual, never above).
				// Measured 2026-06-15: 89.76% lines, 86.72% branches, 94.73% functions
				// (257 tests). The 80% target is met; these floors lock in the gains.
				lines: 87,
				branches: 84,
				functions: 92,
			},
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
		},
	},
});
