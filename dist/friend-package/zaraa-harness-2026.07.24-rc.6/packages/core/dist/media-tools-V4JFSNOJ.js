import "./chunk-R5U7XKVJ.js";

// src/media/media-tools.ts
function normalizePrompt(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  return prompt;
}
function normalizeRequiredCreativeText(args, key) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) {
    throw new Error(`${key} is required for source-before-remix media generation.`);
  }
  return value;
}
function buildCreativeBrief(args) {
  return {
    humanSource: normalizeRequiredCreativeText(args, "human_source"),
    qualityGate: normalizeRequiredCreativeText(args, "quality_gate"),
    provenanceNotes: normalizeRequiredCreativeText(args, "provenance_notes")
  };
}
function buildCreativePrompt(prompt, creativeContext) {
  return [
    `Human source: ${creativeContext.humanSource}`,
    `Creative prompt: ${prompt}`,
    `Quality gate: ${creativeContext.qualityGate}`,
    `Provenance notes: ${creativeContext.provenanceNotes}`
  ].join("\n");
}
function getRequestedZone(context) {
  return context?.zone;
}
function normalizeVideoMode(args) {
  const mode = typeof args.mode === "string" ? args.mode.trim() : "";
  if (!mode) return "generate";
  if (mode === "generate" || mode === "imageToVideo" || mode === "videoToVideo") {
    return mode;
  }
  throw new Error(`Unsupported video mode "${mode}".`);
}
function extractTaskId(args) {
  const candidates = [args.task_id, args.taskId, args.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  throw new Error("task_id is required.");
}
var manifest = {
  name: "media",
  version: "1.0.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["media"],
  trust: "core",
  tools: [
    {
      name: "image_generate",
      description: "Queue an image generation job and return its task_id immediately.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt for image generation" },
          human_source: {
            type: "string",
            description: "Human source, lived intent, or point of view driving the image."
          },
          quality_gate: {
            type: "string",
            description: "Creative QA gates to apply before accepting output."
          },
          provenance_notes: {
            type: "string",
            description: "Source, rights, reference, and human-edit provenance notes."
          },
          model: { type: "string", description: "Optional fal model override" },
          image_size: { type: ["string", "object"], description: "Optional fal image size" },
          output_format: { type: "string", enum: ["jpeg", "png"] },
          num_images: { type: "number" },
          seed: { type: "number" }
        },
        required: ["prompt", "human_source", "quality_gate", "provenance_notes"]
      }
    },
    {
      name: "video_generate",
      description: "Queue a video generation or transformation job and return its task_id immediately.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt for video generation" },
          human_source: {
            type: "string",
            description: "Human source, lived intent, or point of view driving the video."
          },
          quality_gate: {
            type: "string",
            description: "Creative QA gates to apply before accepting output."
          },
          provenance_notes: {
            type: "string",
            description: "Source, rights, reference, and human-edit provenance notes."
          },
          mode: {
            type: "string",
            enum: ["generate", "imageToVideo", "videoToVideo"],
            description: "Video mode: text-to-video, image-to-video, or video-to-video"
          },
          model: { type: "string", description: "Optional fal model override" },
          image_url: {
            type: "string",
            description: "Input image URL for imageToVideo or edit guidance"
          },
          end_image_url: {
            type: "string",
            description: "Optional end-frame image URL for imageToVideo"
          },
          video_url: { type: "string", description: "Input video URL for videoToVideo" },
          audio_url: { type: "string", description: "Optional driving audio URL for imageToVideo" },
          aspect_ratio: { type: "string" },
          resolution: { type: "string" },
          duration: { type: "number" },
          negative_prompt: { type: "string" },
          enable_prompt_expansion: { type: "boolean" },
          enable_safety_checker: { type: "boolean" },
          seed: { type: "number" }
        },
        required: ["prompt", "human_source", "quality_gate", "provenance_notes"]
      }
    },
    {
      name: "music_generate",
      description: "Queue a music generation job and return its task_id immediately.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt for music generation" },
          human_source: {
            type: "string",
            description: "Human source, lived intent, or point of view driving the music."
          },
          quality_gate: {
            type: "string",
            description: "Creative QA gates to apply before accepting output."
          },
          provenance_notes: {
            type: "string",
            description: "Source, rights, sample, collaborator, and human-edit provenance notes."
          },
          model: { type: "string", description: "Optional fal model override" }
        },
        required: ["prompt", "human_source", "quality_gate", "provenance_notes"]
      }
    },
    {
      name: "media_task_get",
      description: "Get status and outputs for a queued media generation task.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Queued media task id" },
          id: { type: "string", description: "Alias for task_id" }
        }
      }
    },
    {
      name: "media_task_cancel",
      description: "Cancel a queued media generation task before provider execution begins.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Queued media task id" },
          id: { type: "string", description: "Alias for task_id" }
        }
      }
    }
  ]
};
function createMediaHandlers(manager) {
  return {
    image_generate: async (args, context) => {
      const prompt = normalizePrompt(args);
      const creativeContext = buildCreativeBrief(args);
      return manager.queueGenerate({
        kind: "image",
        mode: "generate",
        prompt: buildCreativePrompt(prompt, creativeContext),
        creativeContext,
        model: typeof args.model === "string" ? args.model : void 0,
        zone: getRequestedZone(context),
        image_size: args.image_size ?? void 0,
        output_format: args.output_format ?? void 0,
        num_images: typeof args.num_images === "number" ? args.num_images : void 0,
        seed: typeof args.seed === "number" ? args.seed : void 0
      });
    },
    video_generate: async (args, context) => {
      const prompt = normalizePrompt(args);
      const creativeContext = buildCreativeBrief(args);
      return manager.queueGenerate({
        kind: "video",
        mode: normalizeVideoMode(args),
        prompt: buildCreativePrompt(prompt, creativeContext),
        creativeContext,
        model: typeof args.model === "string" ? args.model : void 0,
        zone: getRequestedZone(context),
        image_url: typeof args.image_url === "string" ? args.image_url : void 0,
        end_image_url: typeof args.end_image_url === "string" ? args.end_image_url : void 0,
        video_url: typeof args.video_url === "string" ? args.video_url : void 0,
        audio_url: typeof args.audio_url === "string" ? args.audio_url : void 0,
        aspect_ratio: args.aspect_ratio ?? void 0,
        resolution: args.resolution ?? void 0,
        duration: args.duration ?? void 0,
        negative_prompt: typeof args.negative_prompt === "string" ? args.negative_prompt : void 0,
        enable_prompt_expansion: typeof args.enable_prompt_expansion === "boolean" ? args.enable_prompt_expansion : void 0,
        enable_safety_checker: typeof args.enable_safety_checker === "boolean" ? args.enable_safety_checker : void 0,
        seed: typeof args.seed === "number" ? args.seed : void 0
      });
    },
    music_generate: async (args, context) => {
      const prompt = normalizePrompt(args);
      const creativeContext = buildCreativeBrief(args);
      return manager.queueGenerate({
        kind: "music",
        mode: "generate",
        prompt: buildCreativePrompt(prompt, creativeContext),
        creativeContext,
        model: typeof args.model === "string" ? args.model : void 0,
        zone: getRequestedZone(context)
      });
    },
    media_task_get: async (args) => {
      const taskId = extractTaskId(args);
      return manager.getTask(taskId) ?? { task_id: taskId, found: false };
    },
    media_task_cancel: async (args) => {
      const taskId = extractTaskId(args);
      return manager.cancelTask(taskId);
    }
  };
}
function registerMediaPlugin(toolRegistry, manager) {
  toolRegistry.registerPlugin(manifest, createMediaHandlers(manager));
}
export {
  createMediaHandlers,
  manifest,
  registerMediaPlugin
};
