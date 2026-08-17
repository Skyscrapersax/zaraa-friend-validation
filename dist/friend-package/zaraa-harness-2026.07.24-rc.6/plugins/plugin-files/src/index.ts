import type { PluginManifest } from "@zaraa/shared";

export { createFileHandlers } from "./handlers.js";
export type { FileToolHandlers } from "./handlers.js";

export const manifest: PluginManifest = {
	name: "files",
	version: "0.1.0",
	type: "tool",
	minZone: "sandbox",
	capabilities: ["file.read"],
	trust: "core",
	tools: [
		{
			name: "file_read",
			description:
				"Read the contents of a file. Set numbered=true when you need to cite path:line locations — each line is prefixed with its line number.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					numbered: {
						type: "boolean",
						description:
							"Prefix each line with its 1-based line number (use when citing file:line locations)",
					},
				},
				required: ["path"],
			},
		},
		{
			name: "file_write",
			description: "Write content to a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
			requiresApproval: true,
		},
		{
			name: "file_list",
			description: "List files in a directory",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	],
};
