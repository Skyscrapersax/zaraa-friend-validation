import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/launcher.ts", "src/zaraacoder/configured-executor-worker.ts"],
	format: ["esm"],
	tsconfig: "./tsconfig.build.json",
	dts: false,
	clean: true,
	target: "node22",
	// Treat .sql files as plain text strings so migration SQL can be imported.
	// When TypeScript code does `import sql from './migrations/001.sql'`,
	// tsup inlines the file contents as a string in the bundle.
	loader: {
		".sql": "text",
	},
	external: [
		"@anthropic-ai/sdk",
		"@cursor/sdk",
		"@hono/node-server",
		"better-sqlite3",
		"hono",
		"picomatch",
		"playwright",
	],
});
