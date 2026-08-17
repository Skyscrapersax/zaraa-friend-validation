import { PluginManifest, VideoPluginConfig } from '@zaraa/shared';

declare const VIDEO_MANIFEST: PluginManifest;

interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
    errorCode?: string;
}
type Exec = (cmd: string, args: string[], opts?: {
    timeoutMs?: number;
}) => Promise<ExecResult>;

interface VlmSettings {
    host: string;
    model: string;
    escalateModel?: string;
    keepAlive: string;
    timeoutMs?: number;
}
interface SttSettings {
    baseUrl: string;
    timeoutMs: number;
}

/** Injectable lister so tests don't touch the filesystem. */
type ListFrames = (dir: string) => string[];

type Handler = (args: Record<string, unknown>, context?: unknown) => Promise<unknown>;
interface VideoHandlerDeps {
    exec: Exec;
    fetchFn: typeof fetch;
    vlm: VlmSettings;
    stt: SttSettings;
    frameBudget: number;
    resolution: number;
    batchSize: number;
    ytDlpPath: string;
    ffmpegPath: string;
    makeWorkDir?: () => string;
    cleanup?: (dir: string) => void;
    _listFrames?: ListFrames;
    _readImageB64?: (p: string) => string;
    _readFile?: (p: string) => string;
    _readBinary?: (p: string) => Buffer;
}
declare function createVideoHandlers(deps: VideoHandlerDeps): Record<string, Handler>;

declare const PLUGIN_NAME = "video";
type VideoPluginInstance = {
    manifest: typeof VIDEO_MANIFEST;
    handlers: ReturnType<typeof createVideoHandlers>;
};
declare function createVideoPlugin(config: VideoPluginConfig | undefined): VideoPluginInstance | null;

export { PLUGIN_NAME, VIDEO_MANIFEST, type VideoHandlerDeps, type VideoPluginInstance, createVideoHandlers, createVideoPlugin };
