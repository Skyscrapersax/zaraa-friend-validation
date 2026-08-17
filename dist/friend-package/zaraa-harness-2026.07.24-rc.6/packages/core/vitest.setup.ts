import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const testHome = mkdtempSync(join(tmpdir(), "zaraa-core-test-home-"));

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

afterAll(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	rmSync(testHome, { recursive: true, force: true });
});
