# Zaraa Friend Package Known Issues

## Current known issues

- `safeToShare` stays **false** until Windows validation exists for the **same** `generatedAt` as the friend candidate, and macOS/Linux reports are re-run against that same candidate.
- The last structurally verified friend candidate is `c776ff0` (`2026.07.24-rc.6`, generatedAt `2026-08-16T07:14:56.892Z`). Later commits on `feat/ship-rc6-hardening` are **not** covered by that candidate. Do not treat `c776ff0` as proof for current HEAD.
- macOS and Linux clean-folder reports dated **2026-08-11** (`macos-clean-install-validation-2026.07.24-rc.6.json` / `linux-clean-install-validation-2026.07.24-rc.6.json`) are **stale**. Regenerating the candidate invalidated them. They are not proof for `c776ff0` or current HEAD. Re-run `pnpm ship:validate:macos-temp` / `linux-temp` against a frozen SHA before calling those platforms passed.
- Windows installer validation is **untested** on this Mac. A real Windows machine or VM is required.
- Native signed installers are not ready yet; this is still a source-based friend harness.
- Friends should not reuse Zaraa's local gateway key or config.
- Mechanical friend promotion also requires a clean git tree and a passing 24h runtime proof. Dirty source or a stale `badCount` proof will keep `safeToShare: false`.

## Reporting format

Ask friends for:

1. Operating system and version.
2. Which installer they ran.
3. The visible error text.
4. Whether the dashboard URL opened.
5. Whether Ship Readiness loaded and scrolled.

Do not ask for:

1. Gateway API keys.
2. Local config files.
3. Full logs with secrets.
4. Private workspace files.
5. `~/.zaraa`.
