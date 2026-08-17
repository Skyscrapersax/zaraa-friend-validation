# Zaraa Platform Validation Handoff: 2026.07.24-rc.6

This is the exact handoff for validating the current trusted-friends package on macOS, Windows, and Linux.

## Current readiness

- Package: `2026.07.24-rc.6`
- Channel: `friends`
- Status: `blocked`
- Safe to share: `no`
- Source revision: `712573417878de150a598e58195f6784cfc113e6`
- Package generated at: `2026-08-16T22:45:04.290Z`

## Package files

Staged package folder:

```text
dist/friend-package/zaraa-harness-2026.07.24-rc.6
```

Archives:

- `zaraa-harness-2026.07.24-rc.6.tar.gz` (5331496 bytes)
  SHA256: `1e5e969d21f55bef257c35abe8bd34271745893c9d8e33f172f3890c77eb1c52`
- `zaraa-harness-2026.07.24-rc.6.zip` (5712321 bytes)
  SHA256: `3eeabe5d128eea0dc7151223326a598225086cedeaff184f7745c9d7fb7d3215`

## Platform matrix

- macOS: pass. macOS clean-folder install passed at 2026-08-16T22:46:00.609Z. Report: `dist/friend-package/macos-clean-install-validation-2026.07.24-rc.6.json`.
- Windows: untested. PowerShell installer validation needs a real Windows machine or VM.
- Linux: blocked. linux-clean-install-validation-2026.07.24-rc.6.json was generated for a different package build. Report: `dist/friend-package/linux-clean-install-validation-2026.07.24-rc.6.json`.

## Not ready because

- Release source identity: Release source Git check failed: fatal: not a git repository (or any of the parent directories): .git
- Windows validation is untested.
- Linux validation is blocked.

## What the tester should run

From a matching full repo checkout at exact source revision `712573417878de150a598e58195f6784cfc113e6` (the extracted friend package does not include validator scripts):

1. Verify transferred archive SHA256 against list above (`Get-FileHash` on Windows).
2. Put sender's unchanged `latest.json` and archives under `dist/friend-package/`.
3. Extract archive there so `dist/friend-package/zaraa-harness-2026.07.24-rc.6` exists.
4. Run validator:

Validators use a temporary `ZARAA_HOME_DIR` for runtime state and leave process `HOME` unchanged.

```bash
pnpm ship:validate:current-temp
pnpm ship:verify-package
```

If the current-platform command is unavailable, use the explicit platform command for your OS:

```bash
pnpm ship:validate:macos-temp
pnpm ship:validate:windows-temp
pnpm ship:validate:linux-temp
```

## What the tester should send back

Send only:

- The generated report file: `macos-clean-install-validation-2026.07.24-rc.6.json`, `windows-clean-install-validation-2026.07.24-rc.6.json`, or `linux-clean-install-validation-2026.07.24-rc.6.json` (matching the platform you validated)
- The final terminal summary lines from the validation command
- OS name/version, CPU architecture, Node version, and pnpm version
- A short note saying whether the dashboard opened

Do not send:

- Gateway API keys
- `~/.zaraa` or `.zaraa` config contents
- Browser cookies, full logs, shell history, personal files, or screenshots with private data

## How Mama Zaraa records the returned report

Place the returned report in:

```text
dist/friend-package/
```

Then run:

```bash
pnpm ship:import-validation-report -- dist/friend-package/macos-clean-install-validation-2026.07.24-rc.6.json
pnpm ship:import-validation-report -- dist/friend-package/windows-clean-install-validation-2026.07.24-rc.6.json
pnpm ship:import-validation-report -- dist/friend-package/linux-clean-install-validation-2026.07.24-rc.6.json
pnpm ship:verify-package
ZARAA_HOME_DIR=/absolute/isolated/home pnpm ship:promote:ready -- --runtime-root /path/to/installed/zaraa --gateway-url http://127.0.0.1:<candidate-port> --confirm-browser-smoke
```

The promotion command must remain blocked until macOS, Windows, and Linux all have passing validation reports for `2026.07.24-rc.6`.
