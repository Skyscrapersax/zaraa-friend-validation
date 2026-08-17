import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	target: "node22",
	// Treat .sql files as plain text strings so migration SQL can be imported.
	loader: {
		".sql": "text",
	},
});
