import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareArchiveToStage, matchesMirrorIdentity } from "../scripts/friend-package-verify.mjs";
import { assertPackageStructureValid, platformValidationExitCode, createValidationEnvironment } from "../scripts/friend-package-validation-runner.mjs";
import { runFriendRuntimeSmoke } from "../scripts/friend-package-runtime-smoke.mjs";

test("mirror identity accepts only a clean HEAD mismatch with complete byte/build pins", () => {
	const revision = "a".repeat(40), hash = "c".repeat(64);
	const input = {
		issues: [`source HEAD ${"b".repeat(40)} differs from staged manifest revision ${revision}`],
		marker: { canonicalRevision: revision, packageGeneratedAt: "2026-08-16T22:45:04.290Z", manifestSha256: hash },
		stagedRevision: revision, currentRevision: null,
		latest: { source: { revision, clean: true }, generatedAt: "2026-08-16T22:45:04.290Z" },
		manifestSha256: hash,
	};
	assert.equal(matchesMirrorIdentity(input), true);
	for (const change of [
		{ issues: [] },
		{ issues: [...input.issues, "Refusing friend release from dirty source: installer.ps1"] },
		{ issues: ["staged release manifest lacks schema-2 clean Git identity"] },
		{ marker: null }, { marker: { ...input.marker, canonicalRevision: "d".repeat(40) } },
		{ currentRevision: "e".repeat(40) }, { manifestSha256: "f".repeat(64) },
		{ latest: { ...input.latest, generatedAt: "different build" } },
		{ latest: { ...input.latest, source: { revision, clean: false } } },
	]) assert.equal(matchesMirrorIdentity({ ...input, ...change }), false);
});

test("missing checks or a failed install cannot yield a successful platform exit", () => {
	for (const bad of [undefined, {}, { checks: [] }, { checks: [{ status: "unknown" }] }]) {
		assert.throws(() => assertPackageStructureValid(bad), /missing or malformed/);
		assert.equal(platformValidationExitCode({ evidence: { status: "pass", exitCode: 0 }, verification: bad, platform: "Windows" }), 1);
	}
	const verification = { checks: [{ status: "PASS" }], report: { platformMatrix: [{ platform: "Windows", status: "pass" }] } };
	assert.equal(platformValidationExitCode({ evidence: { status: "fail", exitCode: 0 }, verification, platform: "Windows" }), 1);
	assert.equal(platformValidationExitCode({ evidence: { status: "pass", exitCode: 0 }, verification, platform: "Windows" }), 0);
});

test("Git's omitted empty directories do not hide missing or modified runtime files", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "friend-archive-test."));
	try {
		const fixture = path.join(root, "fixture"), stage = path.join(root, "stage"), archive = path.join(root, "fixture.tar.gz");
		await mkdir(path.join(fixture, "empty/nested"), { recursive: true });
		await mkdir(stage);
		await writeFile(path.join(fixture, "runtime.js"), "original\n");
		await writeFile(path.join(stage, "runtime.js"), "original\n");
		const pack = () => execFileSync("tar", ["-czf", archive, "-C", root, "fixture"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		pack();
		assert.ok(compareArchiveToStage(stage, archive, "fixture").differences.length > 0);
		assert.deepEqual(compareArchiveToStage(stage, archive, "fixture", true).differences, []);
		await writeFile(path.join(stage, "runtime.js"), "modified\n");
		assert.ok(compareArchiveToStage(stage, archive, "fixture", true).differences.some(d => d.includes("file bytes differ")));
		await writeFile(path.join(fixture, "empty/required.js"), "required\n");
		pack();
		assert.ok(compareArchiveToStage(stage, archive, "fixture", true).differences.some(d => d.includes("empty/required.js: extra in archive")));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime smoke rejects HTTP200 with not_ready, accepts ready plus all dashboard routes", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "friend-smoke-test."));
	try {
		await mkdir(path.join(root, "scripts"));
		for (const status of ["not_ready", "ready"]) {
			await writeFile(path.join(root, "scripts/zaraa-daemon.mjs"), `
import { createServer } from 'node:http';
createServer((req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.end(req.url === '/ready' ? JSON.stringify({status:${JSON.stringify(status)}}) : '<html>Fixture dashboard</html>');
}).listen(Number(process.env.ZARAA_GATEWAY_PORT),'127.0.0.1');
`);
			const result = await runFriendRuntimeSmoke({ installDir: root, tempBase: root, env: createValidationEnvironment(), timeoutMs: 1500 });
			assert.equal(result.status, status === "ready" ? "pass" : "fail");
			assert.equal(result.routesPassed, status === "ready");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
