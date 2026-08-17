import { PluginManifest } from '@zaraa/shared';
import { FsSandbox } from '@zaraa/sandbox';

interface FileToolHandlers {
    file_read(args: {
        path: string;
        numbered?: boolean;
    }): Promise<string>;
    file_write(args: {
        path: string;
        content: string;
    }): Promise<string>;
    file_list(args: {
        path: string;
    }): Promise<string>;
}
declare function createFileHandlers(sandbox: FsSandbox): FileToolHandlers;

declare const manifest: PluginManifest;

export { type FileToolHandlers, createFileHandlers, manifest };
