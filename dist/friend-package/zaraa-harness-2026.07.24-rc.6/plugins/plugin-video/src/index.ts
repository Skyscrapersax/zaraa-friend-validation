import type { VideoPluginConfig } from "@zaraa/shared";
import { VIDEO_MANIFEST } from "./manifest.js";
import { createVideoHandlers } from "./handlers.js";
import { defaultExec } from "./exec.js";

export const PLUGIN_NAME = "video";

export type VideoPluginInstance = {
	manifest: typeof VIDEO_MANIFEST;
	handlers: ReturnType<typeof createVideoHandlers>;
};

export function createVideoPlugin(config: VideoPluginConfig | undefined): VideoPluginInstance | null {
	if (!config?.enabled) return null;

	const handlers = createVideoHandlers({
		exec: defaultExec,
		fetchFn: fetch,
		vlm: {
			host: config.vlm?.host ?? "http://127.0.0.1:11434",
			model: config.vlm?.model ?? "qwen3-vl:8b",
			escalateModel: config.vlm?.escalateModel,
			keepAlive: config.vlm?.keepAlive ?? "10m",
			timeoutMs: config.vlm?.timeoutMs ?? 45_000,
		},
		stt: {
			baseUrl: config.stt?.baseUrl ?? "http://127.0.0.1:8765",
			timeoutMs: config.stt?.timeout ?? 120_000,
		},
		frameBudget: config.frameBudget ?? 24,
		resolution: config.resolution ?? 512,
		batchSize: config.batchSize ?? 6,
		ytDlpPath: config.ytDlpPath ?? "yt-dlp",
		ffmpegPath: config.ffmpegPath ?? "ffmpeg",
	});

	return { manifest: VIDEO_MANIFEST, handlers };
}

export { VIDEO_MANIFEST } from "./manifest.js";
export { createVideoHandlers, type VideoHandlerDeps } from "./handlers.js";
