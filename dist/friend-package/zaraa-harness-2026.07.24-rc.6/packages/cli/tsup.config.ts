import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/zaraa.ts", "bin/zaraacoder.ts"],
  format: ["esm"],
  clean: true,
  target: "node22",
  // shebang already in source file
  external: [
    "ink",
    "ink-text-input",
    "react",
    "better-sqlite3",
    "hono",
    "picomatch",
    "playwright",
  ],
});
