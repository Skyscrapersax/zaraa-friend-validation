# Zaraa Friend Platform Validation

## Platform matrix

| Platform | Status | Required proof |
| --- | --- | --- |
| macOS | Run per package | `pnpm ship:validate:macos-temp`, dashboard launch, Ship Readiness scroll, rollback notes |
| Windows | Run in VM or Windows machine | `pnpm ship:validate:windows-temp`, dashboard launch, Ship Readiness scroll |
| Linux | Run in VM or Linux machine | `pnpm ship:validate:linux-temp`, dashboard launch, Ship Readiness scroll |

## One-command validation

From a matching full repo checkout (not the extracted friend package), run:

```bash
pnpm ship:validate:current-temp
```

This picks the correct validator for the current OS:

| Current OS | Validator |
| --- | --- |
| macOS | `pnpm ship:validate:macos-temp` |
| Windows | `pnpm ship:validate:windows-temp` |
| Linux | `pnpm ship:validate:linux-temp` |

Each validator sets `ZARAA_HOME_DIR` to a temporary runtime home without replacing process `HOME`, redirects caches, and writes a platform report to `dist/friend-package/*-clean-install-validation-<version>.json`. Then `pnpm ship:verify-package` consumes matching reports into `dist/friend-package/validation-report.json`.

When someone else runs validation for you, send them `docs/friend-platform-validation-handoff.md`. It tells them what command to run, what report file to send back, and what sensitive data not to share.

## macOS clean-folder plan

1. Run `pnpm ship:validate:macos-temp`.
2. Confirm the command exits with `macOS temp install validation: pass`.
3. Start the temp install using the command printed by the validator.
4. Open the dashboard URL.
5. Unlock with the local gateway key generated for that temp install.
6. Confirm Ship Readiness, Cockpit, Dashboard, and Brain Map scroll.
7. Keep the temporary install folder until the result is recorded and understood.

## Windows VM plan

1. Extract the ZIP archive or check out the same package version.
2. Run `pnpm ship:validate:windows-temp`.
3. Confirm the command exits with `Windows temp install validation: pass`.
4. Start the temp install using the command printed by the validator.
5. Confirm dashboard launch, unlock, command palette, and Ship Readiness scroll.

## Linux VM plan

1. Extract the tarball or check out the same package version.
2. Run `pnpm ship:validate:linux-temp`.
3. Confirm the command exits with `Linux temp install validation: pass`.
4. Start the temp install using the command printed by the validator.
5. Confirm dashboard launch, unlock, command palette, and Ship Readiness scroll.

## Cleanup

Do not delete a failed install immediately. Move it aside, reinstall from the previous archive, and keep the failed folder until the issue is understood.
