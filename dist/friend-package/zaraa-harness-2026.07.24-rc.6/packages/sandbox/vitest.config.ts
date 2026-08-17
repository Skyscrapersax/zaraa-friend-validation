import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      playwright: "/dev/null",
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      // Non-regression floor set a few points below measured actual (lines 92.6%,
      // branches 82.2%, functions 87.2% on 2026-06-15). This package is the
      // security-relevant FS/shell/browser sandbox and was previously ungated;
      // the floor locks in its existing coverage. Ratchet upward as it improves.
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 85,
      },
    },
  },
});
