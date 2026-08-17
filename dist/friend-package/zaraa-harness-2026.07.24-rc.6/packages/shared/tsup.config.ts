import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/designer-artifacts.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	target: "node22",
});
