/**
 * @zaraa/plugin-studio — public surface.
 *
 * The core registration layer does `await import("@zaraa/plugin-studio")` and
 * wires these pieces together (director LLM, brand judge, store path, export
 * root). Everything a caller needs lives here; deep imports are not supported.
 */

// Scene spec (Zod schema + types)
export { SceneSpecSchema } from "./scene/scene-spec.js";
export type { SceneSpec, SceneSpecInput } from "./scene/scene-spec.js";

// Render learning-log store
export { StudioStore } from "./store/studio-store.js";
export type { RecordRenderInput, RenderRow } from "./store/studio-store.js";

// Renderer + host-load guard
export { renderShort, HostBusyError } from "./render/renderer.js";
export { isHostBusy } from "./render/host-load.js";

// Director (brief → SceneSpec)
export { direct, stripMarkdownFences } from "./director/director.js";
export type { DirectorBrief, DirectorDeps } from "./director/director.js";

// Brand judge (LLM-backed GateDeps.brandJudge factory)
export { createBrandJudge } from "./gate/brand-judge.js";

// Quality gate + perceptual hashing
export { evaluate } from "./gate/quality-gate.js";
export type { GateInput, GateDeps, GateVerdict } from "./gate/quality-gate.js";
export { phash, hamming, phashFromPng } from "./gate/phash.js";
export { extractKeyFrameHashes } from "./gate/key-frames.js";

// Exporter + orchestrator
export { exportRender } from "./export/exporter.js";
export { runStudioBrief } from "./orchestrator/orchestrator.js";
export type { OrchestratorDeps, OrchestratorResult } from "./orchestrator/orchestrator.js";
