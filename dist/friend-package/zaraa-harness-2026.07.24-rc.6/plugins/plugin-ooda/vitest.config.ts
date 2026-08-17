import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
      thresholds: {
        // Non-regression floor ~2-3pts below measured actual (gate established
        // 2026-06-16; was ungated/report-only). Measured: 90.47% lines,
        // 64.55% branches, 100% functions (14 tests). Functions floor leaves
        // room for 1 of 20 functions so a single uncovered helper won't flake CI.
        lines: 88,
        branches: 62,
        functions: 95,
      },
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
