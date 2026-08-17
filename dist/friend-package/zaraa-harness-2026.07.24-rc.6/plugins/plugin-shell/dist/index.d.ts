import { PluginManifest } from '@zaraa/shared';
import { ShellSandbox } from '@zaraa/sandbox';

interface ShellToolHandlers {
    shell_exec(args: {
        command: string;
        args?: string[];
    }): Promise<string>;
}
declare function createShellHandlers(sandbox: ShellSandbox): ShellToolHandlers;

declare const manifest: PluginManifest;

export { type ShellToolHandlers, createShellHandlers, manifest };
