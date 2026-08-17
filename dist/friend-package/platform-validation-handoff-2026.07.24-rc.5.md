# Zaraa Platform Validation Handoff: 2026.07.24-rc.5

This is the exact handoff for validating the current trusted-friends package on macOS, Windows, and Linux.

## Current readiness

- Package: `2026.07.24-rc.5`
- Channel: `friends`
- Status: `watch`
- Safe to share: `no`

## Package files

Staged package folder:

```text
dist/friend-package/zaraa-harness-2026.07.24-rc.5
```

Archives:

- `zaraa-harness-2026.07.24-rc.5.tar.gz` (5158048 bytes)
  SHA256: `c6d448329419e22e0cf8e19810eff6b6b0c4d2196e91b748da1bc10dfdb7ecd3`
- `zaraa-harness-2026.07.24-rc.5.zip` (5517629 bytes)
  SHA256: `bdfbfea217bf10b5a08b1ec6c8788ae17a4498c2f8c395580dfeef3338a78935`

## Platform matrix

- macOS: pass. macOS clean-folder install passed at 2026-07-24T09:13:04.775Z. Report: `dist/friend-package/macos-clean-install-validation-2026.07.24-rc.5.json`.
- Windows: untested. PowerShell installer validation needs a real Windows machine or VM.
- Linux: pass. Linux clean-folder install passed at 2026-07-24T09:16:48.649Z. Report: `dist/friend-package/linux-clean-install-validation-2026.07.24-rc.5.json`.

## Not ready because

- Windows validation is untested.

## What the tester should run

From a matching full repo checkout (the extracted friend package does not include validator scripts):

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

- The generated report file: `macos-clean-install-validation-2026.07.24-rc.5.json`, `windows-clean-install-validation-2026.07.24-rc.5.json`, or `linux-clean-install-validation-2026.07.24-rc.5.json` (matching the platform you validated)
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
pnpm ship:import-validation-report -- dist/friend-package/macos-clean-install-validation-2026.07.24-rc.5.json
pnpm ship:import-validation-report -- dist/friend-package/windows-clean-install-validation-2026.07.24-rc.5.json
pnpm ship:import-validation-report -- dist/friend-package/linux-clean-install-validation-2026.07.24-rc.5.json
pnpm ship:verify-package
pnpm ship:promote:ready
```

The promotion command must remain blocked until macOS, Windows, and Linux all have passing validation reports for `2026.07.24-rc.5`.
