# Zaraa Friend Package Handoff

Use this before sending the Zaraa harness to a trusted friend. This file is for the operator preparing the package, not a replacement for the install guide.

## Current share candidate

- Version: read `dist/friend-package/latest.json`
- ZIP: `dist/friend-package/zaraa-harness-<version>.zip`
- tar.gz: `dist/friend-package/zaraa-harness-<version>.tar.gz`
- Release index: `dist/friend-package/latest.json`
- Install guide: `docs/friend-harness-install-guide.md`
- Release notes template: `docs/friend-release-notes-template.md`
- Known issues: `docs/friend-known-issues.md`
- Platform validation: `docs/friend-platform-validation.md`
- Platform validation handoff: `docs/friend-platform-validation-handoff.md`

## Do not share

- Your `~/.zaraa` folder.
- Your gateway API key.
- Your local config files.
- Local logs, memory exports, private documents, or personal workspace data.
- Any archive you have not installed from at least once in a clean temporary location.
- A dirty tree whose `package.json` version does not match `dist/friend-package/latest.json` (mutual-stale archives are not proof of current source).

## What the friend kit contains

- Built package `dist` runtimes, plugins, installers, and friend scripts — not a full monorepo source dump.
- `packages/*/src` and test trees are omitted on purpose; package verification fails if monorepo package source trees reappear.
- Content secret + owner-path scans run on shipped text and fail closed on unreadable or oversized ship files (and on staged symlinks).

## Pre-share checklist

1. Run `pnpm ship:ready` for release-bound runtime proof. This does not approve sharing.
2. Run `pnpm ship:candidate`. This creates a fresh package and invalidates older platform evidence.
3. Run `pnpm ship:validate:current-temp` on the current platform.
4. Start the temporary install using the command printed by the validator.
5. Confirm Ship Readiness opens.
6. Confirm `#ship-readiness`, `#cockpit`, `#dashboard`, and `#brain-map` scroll.
7. Confirm command palette can find `Ship Readiness`.
8. Confirm rollback notes are included beside the package.
9. Confirm `pnpm ship:verify-package` reports all three platforms passed.
10. Run `pnpm ship:promote:ready -- --runtime-root <installed-root> --gateway-url <candidate-url> --confirm-browser-smoke`; it reruns strict package + 24-hour proof gates, and only its READY result approves sharing.
11. Confirm the platform matrix is visible in Ship Readiness.

## Suggested message

```text
I made you a first Zaraa friend harness build.

Start with docs/friend-harness-install-guide.md, then open Ship Readiness inside the dashboard after install. That page has the current release status, recovery flow, and update rules.

Please do not reuse my local keys or config. Your install should use its own local gateway key.

If anything feels weird, stop and send me the visible error text, not private config or secret values.
```

## First support questions

1. Did the installer finish without an error?
2. Did the local dashboard URL open?
3. Did the browser unlock screen appear?
4. Did Ship Readiness open after unlock?
5. Can the page scroll?
6. Does the command palette open?

## Rollback posture

If a friend install breaks, pause updates first. Then move the installed folder aside, reinstall the previous archive, and keep the broken folder until the issue is understood.

## Beta to friends promotion

1. Master changes are promoted to beta only after build and preflight pass.
2. Beta becomes a friend package only after packaging and package verification pass.
3. Friend sharing stays paused until macOS, Windows, and Linux validation evidence is recorded.
4. Stable remains future work until friend packages survive normal use.
