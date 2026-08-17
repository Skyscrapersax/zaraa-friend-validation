#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { HelperClient, OllamaProvider } from "../dist/index.js";

const binPath = process.env.ZARAA_GUI_HELPER_BIN ?? join(homedir(), ".zaraa", "bin", "zaraa-gui-helper");
const model = process.env.ZARAA_GUI_VLM_MODEL ?? "qwen2.5vl:7b";
const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const goal = process.argv[2] ?? "describe what is on screen and propose a single screenshot action";

const client = new HelperClient(binPath);
const vlm = new OllamaProvider({ model, host });

await client.start();
try {
  const ss = await client.capture();
  console.log(`captured ${ss.width}x${ss.height}, asking ${vlm.name} -> ${host}`);
  const plans = await vlm.plan(
    {
      screenshotBase64: ss.pngBase64,
      width: ss.width,
      height: ss.height,
      goal,
    },
    [],
  );
  if (plans.length === 0) {
    console.log("[plan] model returned [] (task already complete or no actions proposed)");
  } else {
    for (const [i, p] of plans.entries()) {
      console.log(`[plan ${i + 1}] ${p.thought ? p.thought + " — " : ""}${JSON.stringify(p.action)}`);
    }
  }
} finally {
  await client.stop();
}
