import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
      thresholds: {
        // Non-regression floor ~2-3pts below measured actual (gate established
        // 2026-06-16; was report-only). Measured: 87.17% lines, 74.26% branches,
        // 80.95% functions (80 tests).
        lines: 85,
        branches: 72,
        functions: 78,
      },
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
