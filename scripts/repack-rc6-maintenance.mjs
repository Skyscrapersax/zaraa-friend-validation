#!/usr/bin/env node
// Reuse RC6's compiled payload: this source revision changes only its updater.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(process.argv[2] ?? ".");
const base = "712573417878de150a598e58195f6784cfc113e6";
const revision = "cbbb0ac087e6c639af1f71b011384adf5975fc63";
const updater = "scripts/friend-kit-update.mjs";
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
assert.equal(git("diff", "--name-only", base, revision), updater, "Maintenance must change only the updater source");
const read = file => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const packageRoot = join(root, "dist/friend-package");
const latestPath = join(packageRoot, "latest.json");
const latest = read(latestPath);
assert.ok([base, revision].includes(latest.source.revision), "Unexpected input release");
const stage = join(packageRoot, latest.package.directory);
writeFileSync(join(stage, updater), execFileSync("git", ["show", `${revision}:${updater}`], { cwd: source }));
const manifestPath = join(stage, latest.manifest.file);
const manifest = read(manifestPath);
const generatedAt = new Date().toISOString();
const identity = { vcs: "git", revision, clean: true };
manifest.source = identity;
manifest.generatedAt = generatedAt;
manifest.artifacts = manifest.artifacts.filter(entry => entry.path !== updater);
manifest.artifacts.push({ path: updater, role: "installer-updater", bytes: readFileSync(join(stage, updater)).length, sha256: hash(join(stage, updater)) });
write(manifestPath, manifest);
const temp = join(root, ".validation/repack");
mkdirSync(temp, { recursive: true });
for (const archive of latest.package.archives) {
  const target = join(temp, archive.file);
  // zip updates existing archives, so write a unique fresh output each run.
  const fresh = `${target}.${Date.now()}${archive.file.endsWith(".zip") ? ".zip" : ".tar.gz"}`;
  if (archive.file.endsWith(".zip")) execFileSync("zip", ["-q", "-r", "-y", fresh, latest.package.directory], { cwd: packageRoot });
  else execFileSync("tar", ["-czf", fresh, "-C", packageRoot, latest.package.directory], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  archive.bytes = readFileSync(fresh).length;
  archive.sha256 = hash(fresh);
  renameSync(fresh, join(packageRoot, archive.file));
}
latest.generatedAt = generatedAt;
latest.source = identity;
latest.manifest = { ...latest.manifest, generatedAt, artifacts: manifest.artifacts.length };
latest.package.totalArchiveBytes = latest.package.archives.reduce((sum, entry) => sum + entry.bytes, 0);
latest.maintenance = { baseRevision: base, changedSource: [updater], note: "RC6 installer repair; compiled runtime and embedded historical release catalog retained. Not the September platform release." };
delete latest.betaBundle;
latest.validation = { status: "blocked", safeToShare: false, blockers: ["Fresh macOS, Linux and Windows evidence required for this maintenance build."] };
latest.release.knownIssues = [...latest.validation.blockers];
write(latestPath, latest);
write(join(root, "packages/web/public/release/latest.json"), latest);
write(join(root, ".mirror-provenance.json"), { canonicalRevision: revision, packageGeneratedAt: generatedAt, manifestSha256: hash(manifestPath) });
console.log(JSON.stringify({ revision, generatedAt, archives: latest.package.archives }));
