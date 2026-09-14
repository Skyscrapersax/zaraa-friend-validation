# Zaraa friend-pilot validation

Validates a sanitized Zaraa release on a fresh Windows runner: installer bootstrap, safe initial config, gateway readiness and dashboard routes. It is the Windows acceptance lane for the shared Zaraa product.

The artifact currently stored here is **2026.07.24-rc.6**, with a **2026-09-14 installer maintenance build** from canonical revision [`cbbb0ac087e6c639af1f71b011384adf5975fc63`](https://github.com/Skyscrapersax/zaraa/commit/cbbb0ac087e6c639af1f71b011384adf5975fc63). That revision backports the existing Windows cross-drive containment fix onto original RC6 source `712573417878de150a598e58195f6784cfc113e6`; no other source changed. The compiled runtime and embedded historical release catalog remain August RC6. It does not contain the newer September Quant/platform changes. A Windows pass proves only this recorded package; publishing a current friend release still requires a newly built, sanitized canonical package and matching fresh macOS/Linux/Windows reports.

## Run

```sh
node --test tests/*.test.mjs
# Windows only; creates its own temporary child folder.
node scripts/friend-package-validate-windows-temp.mjs --cleanup
node scripts/friend-package-verify.mjs
```

The final verifier exits nonzero until every platform passes for the same package build. The Windows job can pass its own platform while overall sharing remains blocked. Reports go into ignored `.validation/`; the verifier never rewrites the pinned package metadata or published release files in this mirror. `--temp-base PATH` chooses a parent for a new isolated folder; cleanup removes only that new child.

CI runs on pull requests, main pushes and manual dispatch. It uses [Node24 LTS](https://nodejs.org/en/about/previous-releases), asserts no preinstalled pnpm, and uploads `.validation/*.json` on success or failure. No provider keys, model calls or live trading are required.

## Source and byte identity

`.gitattributes` preserves archive-matching bytes on Windows. `.mirror-provenance.json` pins canonical revision, package build timestamp and staged manifest SHA256. The verifier permits only the expected difference between mirror Git HEAD and canonical revision. Dirty inputs, missing identity, changed manifest, mixed revisions, archive mismatches and content-scan failures still block installation. There is no environment-variable identity bypass.

Git omits empty directories and preserves executable bits rather than exact read/write modes. A verified mirror compares those Git-representable properties; missing or modified files, executable bits, symlink targets and nonempty directories still fail. Archive hashes remain mandatory.

The original checkout's unfinished edits are preserved; changes were developed in an isolated Git worktree. Only the shipped updater and release manifest changed inside the archives. Archive hashes, build timestamp and manifest pin were regenerated; historical platform reports cannot validate this build. The old beta-bundle pointer was removed because that bundle was not rebuilt.

To repeat this specific maintenance repack with the canonical source commit available locally:

```sh
node scripts/repack-rc6-maintenance.mjs /path/to/canonical-zaraa-checkout
```

This is a repair for the archived RC6 package, not a replacement for the canonical current-release pipeline.
