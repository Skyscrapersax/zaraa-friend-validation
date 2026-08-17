import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Portable ffmpeg/ffprobe resolution. Order: env override → well-known
 * install locations (Homebrew arm64/x64, Linux) → bare name on PATH.
 * Studio was born on a Homebrew Mac; CI runs on Ubuntu — never hardcode.
 */
function resolveBinary(name: string, envVar: string): string {
	const fromEnv = process.env[envVar];
	if (fromEnv) return fromEnv;
	for (const candidate of [
		`/opt/homebrew/bin/${name}`,
		`/usr/local/bin/${name}`,
		`/usr/bin/${name}`,
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return name;
}

export const FFMPEG = resolveBinary("ffmpeg", "ZARAA_FFMPEG_PATH");
export const FFPROBE = resolveBinary("ffprobe", "ZARAA_FFPROBE_PATH");

/** True when the resolved ffmpeg actually runs (used by tests to self-skip). */
export function ffmpegAvailable(): boolean {
	try {
		execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** True when playwright's bundled chromium is installed on this host. */
export async function chromiumAvailable(): Promise<boolean> {
	try {
		// Availability probe must degrade when Playwright or its browser is absent.
		const mod = (await import("playwright")) as unknown as {
			chromium?: { executablePath?: () => string };
		};
		const executable = mod.chromium?.executablePath?.();
		return typeof executable === "string" && existsSync(executable);
	} catch {
		return false;
	}
}
