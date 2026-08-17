import type { AbletonPluginConfig } from "@zaraa/shared";
import { createAbletonHandlers, type AbletonHandlerDeps } from "./handlers.js";
import { manifest } from "./manifest.js";
import { AbletonOscUdpTransport } from "./transport.js";

export type AbletonPluginInstance = {
	manifest: typeof manifest;
	handlers: ReturnType<typeof createAbletonHandlers>;
};

export function createAbletonPlugin(
	config: AbletonPluginConfig | undefined,
	deps: AbletonHandlerDeps = {},
): AbletonPluginInstance | null {
	if (!config?.enabled) return null;
	const handlers = createAbletonHandlers({
		...deps,
		host: deps.host ?? config.host,
		sendPort: deps.sendPort ?? config.sendPort,
		receivePort: deps.receivePort ?? config.receivePort,
		timeoutMs: deps.timeoutMs ?? config.timeoutMs,
	});
	return { manifest, handlers };
}

export { manifest };
export { createAbletonHandlers };
export type { AbletonHandlerDeps, AbletonToolHandlers } from "./handlers.js";
export { AbletonOscUdpTransport };
export type {
	AbletonOscTransport,
	AbletonOscUdpTransportOptions,
	OscReply,
	OscValue,
} from "./transport.js";
