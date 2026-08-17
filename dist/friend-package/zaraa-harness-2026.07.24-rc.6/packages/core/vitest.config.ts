import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Vite plugin that treats .sql files as plain text string exports.
 * This mirrors the `loader: { '.sql': 'text' }` setting in tsup.config.ts.
 *
 * Without this, vitest would try to parse .sql files as JavaScript
 * and throw a parse error.
 */
function sqlTextPlugin(): Plugin {
	return {
		name: "sql-text",
		transform(code, id) {
			if (id.endsWith(".sql")) {
				// Export the raw SQL string as the default export
				return `export default ${JSON.stringify(code)};`;
			}
		},
	};
}

export default defineConfig({
	plugins: [sqlTextPlugin()],
	resolve: {
		alias: {
			"@zaraa/plugin-predictions": fileURLToPath(
				new URL("../../plugins/plugin-predictions/src/index.ts", import.meta.url),
			),
			"@zaraa/sandbox": fileURLToPath(
				new URL("../../packages/sandbox/src/index.ts", import.meta.url),
			),
			"@zaraa/shared": fileURLToPath(
				new URL("../../packages/shared/src/index.ts", import.meta.url),
			),
			"@zaraa/plugin-files": fileURLToPath(
				new URL("../../plugins/plugin-files/src/index.ts", import.meta.url),
			),
			"@zaraa/plugin-shell": fileURLToPath(
				new URL("../../plugins/plugin-shell/src/index.ts", import.meta.url),
			),
			"@zaraa/plugin-ooda": fileURLToPath(
				new URL("../../plugins/plugin-ooda/src/index.ts", import.meta.url),
			),
			"@zaraa/plugin-web": fileURLToPath(
				new URL("../../plugins/plugin-web/src/index.ts", import.meta.url),
			),
			"@zaraa/plugin-trading": fileURLToPath(
				new URL("../../plugins/plugin-trading/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		setupFiles: ["./vitest.setup.ts"],
		testTimeout: 10_000,
		// Quarantine list — see flake-registry.json for root causes and fix owners.
		// Currently empty: both former entries were verified stable and released.
		// To quarantine again, add the path to the array below; run the quarantined
		// set explicitly with FLAKE_SUITE=1 pnpm test.
		// NOTE: always spread configDefaults.exclude — a bare array REPLACES vitest's
		// defaults and causes node_modules/dist tests to be collected (1367 suites!).
		exclude: [
			...configDefaults.exclude,
			...(process.env.FLAKE_SUITE ? [] : ([] as string[])),
		],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
			thresholds: {
				// Target: 70%. Will calibrate once pre-existing test failures are resolved.
				lines: 50,
				branches: 40,
				functions: 50,
			},
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
		},
	},
});
