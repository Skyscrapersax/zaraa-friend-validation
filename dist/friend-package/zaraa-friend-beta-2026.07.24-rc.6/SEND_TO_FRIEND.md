# Send Zaraa 2026.07.24-rc.6 to a trusted tester

Use this note when sending the beta bundle to a macOS, Windows, or Linux tester.

## Short message

Hey! This is a trusted-friends beta validation package for Zaraa.

Extract this beta bundle and read `VALIDATION_HANDOFF.md`. From a matching full repo checkout
(not the extracted friend harness), run:

```bash
pnpm ship:validate:current-temp
pnpm ship:verify-package
```

If that command is unavailable, run only the explicit command for your OS:

```bash
pnpm ship:validate:macos-temp
pnpm ship:validate:windows-temp
pnpm ship:validate:linux-temp
```

## Send them

- `archives/zaraa-harness-2026.07.24-rc.6.tar.gz` for macOS or Linux
- `archives/zaraa-harness-2026.07.24-rc.6.zip` for Windows
- `VALIDATION_HANDOFF.md`
- `SHA256SUMS.txt`
- The `docs/` folder

## Ask them to return only

- `macos-clean-install-validation-2026.07.24-rc.6.json`, `windows-clean-install-validation-2026.07.24-rc.6.json`, or `linux-clean-install-validation-2026.07.24-rc.6.json`
- Final terminal summary lines
- OS name/version, CPU architecture, Node version, and pnpm version
- Whether the dashboard opened

## Do not ask for

- Gateway API keys
- `~/.zaraa` or `.zaraa` config contents
- Browser cookies
- Full logs
- Shell history
- Personal files
- Screenshots with private data

## Current status

- Package: `2026.07.24-rc.6`
- Status: `watch`
- Safe as ready: `no`

Current blockers:

- macOS validation is fail.
- Windows validation is untested.
- Linux validation is blocked.
