import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 10_000,
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__test-setup__.ts", "src/test-setup.ts"],
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/__tests__/**"],
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
