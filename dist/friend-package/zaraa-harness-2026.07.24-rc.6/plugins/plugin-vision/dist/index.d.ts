import { PluginManifest } from '@zaraa/shared';
import { z } from 'zod';

declare const visionAnalyzeSchema: z.ZodObject<{
    imagePath: z.ZodString;
    question: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    imagePath: string;
    question?: string | undefined;
}, {
    imagePath: string;
    question?: string | undefined;
}>;
interface VisionPluginConfig {
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxImageBytes?: number;
}
declare const VISION_DEFAULTS: {
    readonly model: "qwen2.5vl:7b";
    readonly baseUrl: "http://127.0.0.1:11434";
    readonly timeoutMs: 60000;
    readonly maxImageBytes: number;
};

interface VisionHandlerDeps {
    /** Lazily reads the live vision config block so config edits apply without restart. */
    getConfig: () => VisionPluginConfig | undefined;
    /** Optional path gate — wired by the host to the same sandbox checks file_read uses.
     *  Throws when the path is not readable under the current zone policy. */
    assertReadable?: (path: string) => void | Promise<void>;
}
interface VisionToolHandlers {
    vision_analyze(args: unknown): Promise<string>;
}
declare function createVisionHandlers(deps: VisionHandlerDeps): VisionToolHandlers;

/**
 * Local VLM vision plugin. Zone `guarded`: reads image files from disk,
 * sends base64 to the local ollama vision model via native /api/chat,
 * and returns a grounded text answer. Tool name `vision_analyze`.
 */
declare const manifest: PluginManifest;

export { VISION_DEFAULTS, type VisionHandlerDeps, type VisionPluginConfig, type VisionToolHandlers, createVisionHandlers, manifest, visionAnalyzeSchema };
