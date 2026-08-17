# Zaraa Friend Platform Validation Handoff

Use this template when a trusted friend or VM tester validates a package on macOS, Windows, or Linux.

For the exact current package version, archive names, hashes, and record-back commands, generate the live handoff:

```bash
pnpm ship:validation-handoff
```

The generated file is written to `dist/friend-package/platform-validation-handoff-<version>.md`.

## Package under test

- Package version:
- Archive used:
- SHA256 checked: yes/no
- Platform:
- Machine type: real machine / VM
- Node version:
- pnpm version:

## Command to run

From a matching full repo checkout. The extracted friend package does not include validator scripts:

Validators set a temporary `ZARAA_HOME_DIR` for runtime state and do not replace process `HOME`.

```bash
pnpm ship:validate:current-temp
pnpm ship:verify-package
```

If `ship:validate:current-temp` is unavailable, run only the platform-specific command for your OS:

```bash
pnpm ship:validate:macos-temp
pnpm ship:validate:linux-temp
pnpm ship:validate:windows-temp
```

## What to send back

Send only:

- The validation report file named `*-clean-install-validation-<version>.json`
- The final terminal summary lines from the validation command
- The OS, CPU architecture, Node version, and pnpm version
- A short note saying whether the dashboard opened

Do not send:

- Gateway API keys
- `~/.zaraa` or `.zaraa` config contents
- Browser cookies or session data
- Full logs that may contain local paths or private machine details
- Personal files, screenshots with private data, or shell history

## Manual dashboard smoke

After the temp install passes:

1. Start Zaraa using the command printed by the validator.
2. Open `http://localhost:3927/`.
3. Unlock with the gateway key generated for that temp install only.
4. Confirm Ship Readiness opens and scrolls.
5. Confirm Cockpit opens.
6. Confirm Dashboard opens.
7. Confirm Brain Map opens and scrolls.

## Result summary

- Validation command result: pass/fail/blocked
- Dashboard smoke result: pass/fail/blocked
- Main issue if blocked:
- Report file attached: yes/no
- Temp folder retained for debugging: yes/no
