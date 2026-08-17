# Release policy

Zaraa uses [Semantic Versioning](https://semver.org/) for published artifacts (`MAJOR.MINOR.PATCH`).

## Version bands

| Band | Meaning |
|------|---------|
| **0.x** | Early adoption. Breaking changes may land in minor releases; patch releases are fixes only. |
| **1.0** | First “stable platform” milestone: documented install path, CI green on `main`, gateway + CLI + web smoke-tested, README claims match behavior. |

## What triggers a version bump

- **PATCH** — Bug fixes, security patches, docs that do not change behavior, dependency updates with no API change.
- **MINOR** — New features, new optional config fields, backward-compatible API additions.
- **MAJOR** (or **0.x minor** while pre-1.0) — Breaking config schema changes, removed CLI flags, incompatible gateway API changes.

## Release checklist (REL-10)

Before tagging a release:

1. `pnpm install --frozen-lockfile`, `pnpm -r run build`, `npx tsc --noEmit`, and `pnpm -r run test` pass locally; same on CI for the release commit.
2. `CHANGELOG.md` updated with a dated section for the new version.
3. Security-sensitive changes noted under a **Security** subsection when applicable.
4. Mobile or affiliate surfaces: only claim parity in release notes if those artifacts were verified for this tag.

### Friend-beta runtime proof

Run proof only after release commit is built and loaded by a governed daemon start. For isolated installed-candidate proof, set `ZARAA_HOME_DIR` to a non-root absolute directory; daemon and sampler then keep config, logs, databases, and proof state beneath that runtime home without changing the process `HOME`. Runtime proof binds to daemon, core, shared, plugin, dashboard, proof-tool, and config content; stale daemon or drift fails closed.

1. Finalize isolated config first: paper-only trading and predictions, guarded zone, trusted gateway, hands-off autonomy, one healthy provider, schedules/overnight/voice disabled. Do not change it after daemon start.
2. From exact installed root, start one isolated daemon and keep its terminal open: `ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_PORT=<port> ZARAA_DISABLE_IMESSAGE=1 ZARAA_SERVICE_LABEL=com.zaraa.friend-proof pnpm start`.
3. Verify one numeric PID owns `127.0.0.1:<port>` and health is green. From release checkout, use that same home, root, PID, and gateway for browser confirmation: `ZARAA_HOME_DIR=/absolute/isolated/home pnpm ship:confirm-browser-smoke -- --runtime-root <installed-root> --gateway-url http://127.0.0.1:<port> --confirm-browser-smoke`.
4. Without restarting or changing config/artifacts, start packaged sampler in a second terminal kept open for full window: `cd <installed-root> && ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_BASE=http://127.0.0.1:<port> pnpm proof:24h -- --restart-window --daemon-pid <verified-pid>`.
5. Freeze runtime artifacts, config, and daemon. Any bad sample, runtime change, daemon restart, or gap over 10 minutes invalidates proof.
6. After 24 hours, keep `ZARAA_HOME_DIR` set to same isolated home when running promotion. Gate requires complete latest proof, `badCount=0`, `continuityBreakCount=0`, and matching installed-runtime identity.

### Friend-package promotion

1. Run `pnpm ship:candidate` to build, manifest, package, and structurally verify one fresh candidate. This invalidates older platform evidence by design.
2. Run `pnpm ship:validate:current-temp`, then generate tester instructions with `pnpm ship:validation-handoff`.
3. Import Windows and Linux reports with `pnpm ship:import-validation-report -- <report.json>`.
4. Run browser smoke on Ship Readiness, Cockpit, Dashboard, and Brain Map, then record it with `ZARAA_HOME_DIR=/absolute/isolated/home pnpm ship:confirm-browser-smoke -- --runtime-root <installed-root> --gateway-url <candidate-url> --confirm-browser-smoke`.
5. Run `ZARAA_HOME_DIR=/absolute/isolated/home pnpm ship:promote:ready -- --runtime-root <installed-root> --gateway-url <candidate-url> --confirm-browser-smoke`. Promotion reruns strict package + 24-hour proof gates; only a `READY` result means package is safe to share.

## Artifacts

Supported release artifacts are **source tags**, `CHANGELOG.md`, and the SBOM below.
Registry packages, binaries, and Docker images are not supported install paths.

### SBOM (dependency bill of materials)

When a [GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) is **published**, workflow [`.github/workflows/release-sbom.yml`](../.github/workflows/release-sbom.yml) runs `pnpm install --frozen-lockfile` and generates **CycloneDX JSON** with [Syft](https://github.com/anchore/syft) (via [`anchore/sbom-action`](https://github.com/anchore/sbom-action)). The file **`zaraa-sbom.cdx.json`** is uploaded as a release asset alongside your notes. The same file is also kept as a workflow artifact for that run.

**Dry run:** In the GitHub UI, open **Actions** → **Release SBOM** → **Run workflow** (choose branch). That produces the same SBOM as a **workflow artifact** only and does not attach anything to a release (`upload-release-assets` is off for `workflow_dispatch`).
