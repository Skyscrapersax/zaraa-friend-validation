import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
      thresholds: {
        // Non-regression floor ~2-3pts below measured actual (gate activated
        // 2026-06-17; was report-only — coverage block existed but no thresholds,
        // so CI ran it without enforcing). Measured: 95.8% lines, 85.71% branches,
        // 90.24% functions (48 tests). Functions floor leaves room for ~1 of 41 fns.
        lines: 93,
        branches: 83,
        functions: 87,
      },
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
