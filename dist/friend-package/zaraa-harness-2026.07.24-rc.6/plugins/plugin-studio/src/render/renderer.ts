import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { SceneSpec } from "../scene/scene-spec.js";
import { FFMPEG } from "../util/media-bins.js";
import { isHostBusy } from "./host-load.js";

/** Thrown when the host stays too loaded to safely launch a render. */
export class HostBusyError extends Error {
	constructor(message = "host too busy to render") {
		super(message);
		this.name = "HostBusyError";
	}
}

/**
 * Module-level single-render mutex. Every render chains onto the previous one so
 * only ONE chromium + ffmpeg pipeline runs at a time on this 16GB host. The
 * try/finally inside the chained task ensures a failed render does not wedge the
 * chain for subsequent callers.
 */
let renderChain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Block until the host is calm enough to render, or give up with HostBusyError. */
async function waitForCalmHost(): Promise<void> {
	const maxAttempts = 5;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (!isHostBusy()) return;
		if (attempt < maxAttempts - 1) await sleep(3000);
	}
	if (isHostBusy()) throw new HostBusyError();
}

/** Resolve "WxH" → numeric width/height. */
function parseDims(aspect: string): { width: number; height: number } {
	const [w, h] = aspect.split("x");
	const width = Number.parseInt(w, 10);
	const height = Number.parseInt(h, 10);
	return { width, height };
}

/**
 * Absolute file URL of the deterministic scene engine, relative to this module.
 * Two layouts exist: src (this file lives in src/render → ../scene/) and the
 * tsup bundle (everything flattened into dist/index.js → dist/scene/, copied
 * there by the build's onSuccess hook).
 */
function sceneFileUrl(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "../scene/bleepybot-scene.html"),
		join(here, "scene/bleepybot-scene.html"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
	}
	throw new Error(
		`bleepybot-scene.html not found; looked at: ${candidates.join(", ")}. ` +
			"If running from dist, the build must copy src/scene/bleepybot-scene.html into dist/scene/ (tsup onSuccess).",
	);
}

/**
 * Screenshot every frame of the scene at the given dimensions into `framesDir`.
 * Launches exactly one chromium with software compositing (--use-gl=swiftshader),
 * which the scene HTML documents as REQUIRED for deterministic canvas capture.
 */
async function captureFrames(
	spec: SceneSpec,
	width: number,
	height: number,
	framesDir: string,
): Promise<void> {
	const sceneUrl = sceneFileUrl();
	const frameCount = Math.round(spec.durationSec * spec.fps);
	const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
	try {
		const page = await browser.newPage({ viewport: { width, height } });
		await page.addInitScript((injected) => {
			(window as unknown as { __BLEEPY_SCENE__: SceneSpec }).__BLEEPY_SCENE__ = injected;
		}, spec);
		await page.goto(sceneUrl);
		await page.waitForFunction(
			() => typeof (window as unknown as { __bleepyFrame?: unknown }).__bleepyFrame === "function",
		);
		for (let frame = 0; frame < frameCount; frame++) {
			await page.evaluate((n) => {
				(window as unknown as { __bleepyFrame: (n: number) => void }).__bleepyFrame(n);
			}, frame);
			await page.screenshot({ path: join(framesDir, `${String(frame).padStart(5, "0")}.png`) });
		}
	} finally {
		await browser.close();
	}
}

/**
 * Build a single mono 44.1kHz audio file for the short.
 * - track: trim the requested clip from the source file.
 * - bleeps / missing track: synthesize a soft 440Hz sine bed for the duration.
 */
function buildAudio(spec: SceneSpec, audioWav: string): void {
	const clip = spec.audio.trackClip;
	if (spec.audio.source === "track" && clip && existsSync(clip.file)) {
		execFileSync(FFMPEG, [
			"-y",
			"-ss", String(clip.startSec),
			"-to", String(clip.endSec),
			"-i", clip.file,
			"-ac", "1",
			"-ar", "44100",
			audioWav,
		]);
		return;
	}
	if (spec.audio.source === "track" && clip && !existsSync(clip.file)) {
		console.warn(`[studio:renderer] track requested but file missing (${clip.file}); falling back to synthesized bleep bed`);
	}
	execFileSync(FFMPEG, [
		"-y",
		"-f", "lavfi",
		"-i", `aevalsrc=0.2*sin(2*PI*440*t):d=${spec.durationSec}:s=44100`,
		"-ac", "1",
		audioWav,
	]);
}

/** Encode captured frames + audio into an MP4. Returns the output path. */
function encode(framesDir: string, audioWav: string, fps: number, width: number, height: number, outDir: string): string {
	const outPath = join(outDir, `bleepybot-${width}x${height}.mp4`);
	execFileSync(FFMPEG, [
		"-y",
		"-framerate", String(fps),
		"-i", join(framesDir, "%05d.png"),
		"-i", audioWav,
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-r", String(fps),
		"-shortest",
		outPath,
	]);
	return outPath;
}

/** Render one aspect ratio end-to-end (frames → audio → encode). */
async function renderRatio(spec: SceneSpec, aspect: string, outDir: string): Promise<string> {
	const { width, height } = parseDims(aspect);
	const workDir = mkdtempSync(join(tmpdir(), `studio-frames-${width}x${height}-`));
	const framesDir = join(workDir, "frames");
	const audioWav = join(workDir, "audio.wav");
	try {
		execFileSync("/bin/mkdir", ["-p", framesDir]);
		await captureFrames(spec, width, height, framesDir);
		buildAudio(spec, audioWav);
		return encode(framesDir, audioWav, spec.fps, width, height, outDir);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Render a SceneSpec into export-ready MP4 shorts (one per aspect ratio) under
 * `outDir`. Only one render runs at a time (module-level mutex). Returns the
 * absolute paths of the produced MP4 files.
 */
export async function renderShort(spec: SceneSpec, outDir: string): Promise<string[]> {
	const run = renderChain.then(async () => {
		await waitForCalmHost();
		const outputs: string[] = [];
		for (const aspect of spec.aspectRatios) {
			outputs.push(await renderRatio(spec, aspect, outDir));
		}
		return outputs;
	});
	// Keep the chain alive even if this render rejects, so the next one still runs.
	renderChain = run.catch(() => undefined);
	return run;
}
