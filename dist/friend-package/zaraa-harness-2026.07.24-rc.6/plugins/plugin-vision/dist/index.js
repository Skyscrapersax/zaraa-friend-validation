// src/handlers.ts
import { readFileSync, statSync, existsSync } from "fs";
import { basename, extname } from "path";

// src/types.ts
import { z } from "zod";
var visionAnalyzeSchema = z.object({
  imagePath: z.string().min(1, "imagePath is required"),
  question: z.string().optional()
});
var VISION_DEFAULTS = {
  model: "qwen2.5vl:7b",
  baseUrl: "http://127.0.0.1:11434",
  timeoutMs: 6e4,
  maxImageBytes: 8 * 1024 * 1024
};
var SUPPORTED_IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// src/handlers.ts
var DEFAULT_QUESTION = "Describe this image precisely: visible text, UI elements, numbers, charts, and anything unusual.";
var EVIDENCE_SUFFIX = " Include the exact numbers, counts, and verbatim text visible in the image \u2014 specifics, not summaries.";
function createVisionHandlers(deps) {
  return {
    async vision_analyze(args) {
      const parsed = visionAnalyzeSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new Error(`invalid arguments \u2014 ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      const { imagePath, question } = parsed.data;
      const cfg = { ...VISION_DEFAULTS, ...deps.getConfig() ?? {} };
      const ext = extname(imagePath).toLowerCase();
      if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`unsupported image extension "${ext}" \u2014 use png/jpg/jpeg/webp/gif`);
      }
      if (!existsSync(imagePath)) {
        throw new Error(`image not found at ${imagePath}`);
      }
      if (deps.assertReadable) {
        await deps.assertReadable(imagePath);
      }
      const size = statSync(imagePath).size;
      if (size > cfg.maxImageBytes) {
        throw new Error(`image too large (${size} bytes > ${cfg.maxImageBytes} max)`);
      }
      let base64;
      try {
        base64 = readFileSync(imagePath).toString("base64");
      } catch (err) {
        throw new Error(`failed to read image \u2014 ${err instanceof Error ? err.message : String(err)}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const resp = await fetch(`${cfg.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cfg.model,
            stream: false,
            // Vision answers must be direct evidence, not deliberation:
            // thinking-mode VLMs (gemma-4 QAT) burn their token budget in
            // the reasoning channel and return empty/truncated content.
            // No-op for non-thinking models (qwen2.5vl).
            think: false,
            // Unload promptly: this host is RAM-constrained and the VLM must
            // not squat memory between calls.
            keep_alive: "2m",
            messages: [
              {
                role: "user",
                content: question?.trim() ? `${question.trim()}${EVIDENCE_SUFFIX}` : DEFAULT_QUESTION,
                images: [base64]
              }
            ]
          }),
          signal: controller.signal
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          throw new Error(`ollama returned ${resp.status}${detail ? ` \u2014 ${detail.slice(0, 200)}` : ""}`);
        }
        const data = await resp.json();
        const answer = data.message?.content?.trim();
        if (!answer || answer.length === 0) {
          throw new Error("vision model returned empty content");
        }
        return `Visual evidence (${basename(imagePath)}) \u2014 quote the exact numbers/strings below when confirming or refuting claims:
${answer}`;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`timed out after ${cfg.timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

// src/index.ts
var manifest = {
  name: "vision",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["vision.analyze"],
  trust: "core",
  tools: [
    {
      name: "vision_analyze",
      description: "Analyze an image file (screenshot, chart, error dialog, document photo) with the local vision model and return a grounded text answer. Use whenever a question concerns something visual on disk.",
      parameters: {
        type: "object",
        properties: {
          imagePath: {
            type: "string",
            description: "Absolute path to the image file (png/jpg/jpeg/webp/gif, \u22648MB)"
          },
          question: {
            type: "string",
            description: "What to determine from the image (default: precise full description)"
          }
        },
        required: ["imagePath"]
      }
    }
  ]
};
export {
  VISION_DEFAULTS,
  createVisionHandlers,
  manifest,
  visionAnalyzeSchema
};
