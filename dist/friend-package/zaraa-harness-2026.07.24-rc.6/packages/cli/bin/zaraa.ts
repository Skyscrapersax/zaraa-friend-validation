#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".zaraa");
const CONFIG_FILE = join(CONFIG_DIR, "zaraa.config.json");

async function detectOllama(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function main() {
	// Friend `pnpm setup` / `pnpm doctor` / other subcommands must reach the main CLI.
	// Only bare `zaraa` (no subcommand) auto-scaffolds a paper-only config.
	const args = process.argv.slice(2);
	const positional = args.filter((a) => a !== "--skip-setup" && !a.startsWith("-"));
	const hasSubcommand = positional.length > 0;
	const hasInformationalFlag = args.some((arg) =>
		["--help", "-h", "--version", "-v"].includes(arg),
	);
	if (hasSubcommand || hasInformationalFlag || args.includes("--skip-setup")) {
		await import("../src/index.js");
		return;
	}

	// First-run detection must use lstat: existsSync is false for dangling symlinks, which
	// would otherwise look like "no config" and scaffold through a link-shaped path.
	const { lstatSync: lstatForFirstRun } = await import("node:fs");
	let isFirstRun = true;
	try {
		const cfgStats = lstatForFirstRun(CONFIG_FILE);
		isFirstRun = false;
		// Bare `zaraa` refuses unsafe paths; doctor/setup report via their own path control.
		if (!hasSubcommand && (cfgStats.isSymbolicLink() || !cfgStats.isFile())) {
			throw new Error(
				cfgStats.isSymbolicLink()
					? `Refusing to use config path that is a symlink: ${CONFIG_FILE}. ` +
						"Replace the symlink with a regular file under the intended home config path."
					: `Refusing to use config path that is not a regular file: ${CONFIG_FILE}.`,
			);
		}
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code: string }).code : null;
		if (code === "ENOENT") {
			isFirstRun = true;
		} else {
			throw error;
		}
	}

	if (isFirstRun) {
		const {
			mkdirSync,
			chmodSync,
			lstatSync,
			renameSync,
			unlinkSync,
			openSync,
			writeFileSync,
			closeSync,
			constants: fsConstants,
		} = await import("node:fs");
		const { randomBytes } = await import("node:crypto");
		// Dynamic import keeps first-run money rails testable as plain ESM.
		const { buildFirstRunConfig } = await import("../src/setup-wizard/first-run-config.mjs");

		// Fail-closed path control: never scaffold under a symlink parent (credentials escape).
		if (existsSync(CONFIG_DIR)) {
			let dirStats: ReturnType<typeof lstatSync>;
			try {
				dirStats = lstatSync(CONFIG_DIR);
			} catch {
				throw new Error(`Cannot lstat config dir ${CONFIG_DIR}`);
			}
			if (dirStats.isSymbolicLink()) {
				throw new Error(
					`Refusing first-run scaffold under symlink config dir: ${CONFIG_DIR}. ` +
						"Replace the symlink with a real directory under the intended home path.",
				);
			}
			if (!dirStats.isDirectory()) {
				throw new Error(`Config path parent is not a directory: ${CONFIG_DIR}`);
			}
		} else {
			// Owner-only home dir for config (best-effort on platforms that honor mode).
			mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
		}
		try {
			chmodSync(CONFIG_DIR, 0o700);
		} catch {
			// best-effort
		}

		const ollamaDetected = await detectOllama();
		const home = homedir();
		const config = buildFirstRunConfig({ home, ollama: ollamaDetected });

		// Exclusive temp (O_EXCL) + rename mode 0600 — never writeFileSync through a
		// pre-planted first-run-tmp symlink (gateway key siphon).
		const body = `${JSON.stringify(config, null, 2)}\n`;
		const tmp = join(
			CONFIG_DIR,
			`.zaraa.config.json.first-run-tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
		);
		try {
			const fd = openSync(
				tmp,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
				0o600,
			);
			try {
				writeFileSync(fd, body);
			} finally {
				closeSync(fd);
			}
			try {
				chmodSync(tmp, 0o600);
			} catch {
				// best-effort
			}
			renameSync(tmp, CONFIG_FILE);
			try {
				chmodSync(CONFIG_FILE, 0o600);
			} catch {
				// best-effort
			}
		} catch (error) {
			try {
				unlinkSync(tmp);
			} catch {
				// ignore cleanup
			}
			throw error;
		}

		if (ollamaDetected) {
			console.log("Found Ollama at localhost:11434 -- wrote a paper-only first-run config.\n");
			console.log("From the installed folder: run `pnpm doctor` then `pnpm start`.\n");
			return;
		}

		console.log("\n\u{1F31F} Welcome to Zaraa!\n");
		console.log("This looks like your first time running Zaraa.");
		console.log(`\u2705 Paper-only config scaffold created at ${CONFIG_FILE}`);
		console.log("\u{1F4DD} Complete setup from the installed folder:\n");
		console.log("  pnpm setup     # interactive provider + trust wizard");
		console.log("  pnpm doctor    # verify rails + provider readiness");
		console.log("  pnpm start     # start the local gateway\n");
		return;
	}

	// Subcommands (setup/doctor/…) or not-first-run — delegate to the main CLI
	await import("../src/index.js");
}

main().catch((error) => {
	console.error("Fatal error:", error.message || error);
	process.exit(1);
});
