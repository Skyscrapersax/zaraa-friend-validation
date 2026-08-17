#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HelperClient } from "../dist/index.js";

const binPath = process.env.ZARAA_GUI_HELPER_BIN ?? join(homedir(), ".zaraa", "bin", "zaraa-gui-helper");
const outPath = process.argv[2] ?? "/tmp/zaraa-gui-capture.png";

const client = new HelperClient(binPath);
await client.start();
try {
  const ss = await client.capture();
  const png = Buffer.from(ss.pngBase64, "base64");
  writeFileSync(outPath, png);
  console.log(`captured ${ss.width}x${ss.height} -> ${outPath} (${png.length} bytes)`);
} finally {
  await client.stop();
}
