import type { ShellSandbox } from "@zaraa/sandbox";

export interface ShellToolHandlers {
	shell_exec(args: { command: string; args?: string[] }): Promise<string>;
}

export function createShellHandlers(sandbox: ShellSandbox): ShellToolHandlers {
	return {
		async shell_exec({ command, args = [] }) {
			// LLMs often send full command as a single string (e.g., "ls -la /tmp").
			// Split into executable + args when args is empty and command contains spaces.
			let executable = command;
			let execArgs = args;
			if (execArgs.length === 0 && command.includes(" ")) {
				const parts = command.split(/\s+/);
				executable = parts[0];
				execArgs = parts.slice(1);
			}
			const result = await sandbox.execute(executable, execArgs);
			let output = result.stdout;
			if (result.stderr) {
				output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
			}
			if (result.exitCode !== 0) {
				output += `\n[exit code: ${result.exitCode}]`;
			}
			return output || "(no output)";
		},
	};
}
