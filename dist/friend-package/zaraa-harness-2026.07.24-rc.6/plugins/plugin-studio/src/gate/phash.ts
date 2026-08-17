import { execFileSync } from "node:child_process";

/**
 * Perceptual hash (average-hash / aHash) over an 8x8 grayscale thumbnail.
 *
 * Pure by design: `phash` takes a 64-byte grayscale buffer so the hash is
 * unit-testable without any image-decoding dependency. `phashFromPng` is the
 * impure adapter that shells out to ffmpeg to downscale/grayscale a PNG into
 * that 8x8 buffer (covered by the gate e2e, not unit tests).
 */

import { FFMPEG } from "../util/media-bins.js";

/**
 * Average-hash a 64-byte (8x8) grayscale buffer into a 64-bit hex string.
 * Bit i = 1 when byte i >= mean. (All-equal buffers hash to all-ones — fine;
 * identical inputs still collide, which is the property the gate needs.)
 */
export function phash(gray64: Buffer): string {
	if (gray64.length !== 64) {
		throw new Error(`phash expects exactly 64 grayscale bytes, got ${gray64.length}`);
	}
	let sum = 0;
	for (const byte of gray64) sum += byte;
	const mean = sum / 64;
	let bits = 0n;
	for (let i = 0; i < 64; i++) {
		bits <<= 1n;
		if (gray64[i] >= mean) bits |= 1n;
	}
	return bits.toString(16).padStart(16, "0");
}

/** Hamming distance between two 64-bit phash hex strings (0..64). */
export function hamming(a: string, b: string): number {
	let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let count = 0;
	while (x > 0n) {
		count += Number(x & 1n);
		x >>= 1n;
	}
	return count;
}

/** Downscale+grayscale a PNG to 8x8 via ffmpeg and average-hash it. */
export function phashFromPng(pngPath: string): string {
	const raw = execFileSync(FFMPEG, [
		"-v",
		"error",
		"-i",
		pngPath,
		"-vf",
		"scale=8:8",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		"-",
	]);
	return phash(raw.subarray(0, 64));
}
