import type { PluginManifest } from "@zaraa/shared";

export { createShellHandlers } from "./handlers.js";
export type { ShellToolHandlers } from "./handlers.js";

export const manifest: PluginManifest = {
	name: "shell",
	version: "0.1.0",
	type: "tool",
	minZone: "guarded",
	capabilities: ["shell.exec"],
	trust: "core",
	tools: [
		{
			name: "shell_exec",
			description: "Execute a shell command. Pass the full command as a string (e.g., 'ls -la /tmp'). Pipes are not supported — use separate calls instead.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "The command to run (e.g., 'git status', 'ls -la /tmp')" },
					args: { type: "array", items: { type: "string" }, description: "Optional separate args array. If omitted, command string is auto-split." },
				},
				required: ["command"],
			},
			requiresApproval: true,
		},
	],
};
