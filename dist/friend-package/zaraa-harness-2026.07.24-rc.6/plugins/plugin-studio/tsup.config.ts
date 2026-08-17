import { cp, mkdir } from "node:fs/promises";
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
	// The renderer loads the scene engine HTML at runtime (dist/scene/ next to
	// the bundle); ship it with the build or dist renders cannot find it.
	onSuccess: async () => {
		await mkdir("dist/scene", { recursive: true });
		await cp("src/scene/bleepybot-scene.html", "dist/scene/bleepybot-scene.html");
	},
});
