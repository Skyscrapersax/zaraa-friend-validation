# Zaraa Friend Beta Bundle: 2026.07.24-rc.6

This folder is the share-safe bundle for trusted-friends validation.

## Status

- Channel: friends
- Verification status: watch
- Safe to share as ready: no

## Not ready because

- macOS validation is fail.
- Windows validation is untested.
- Linux validation is blocked.

## Archives

- zaraa-harness-2026.07.24-rc.6.tar.gz (5331496 bytes)
  SHA256: 1e5e969d21f55bef257c35abe8bd34271745893c9d8e33f172f3890c77eb1c52

- zaraa-harness-2026.07.24-rc.6.zip (5712321 bytes)
  SHA256: 3eeabe5d128eea0dc7151223326a598225086cedeaff184f7745c9d7fb7d3215

## What to send

For macOS, Windows, or Linux validation, send:

- The matching archive from `archives/` (`.tar.gz` for macOS/Linux, `.zip` for Windows when both exist)
- `VALIDATION_HANDOFF.md`
- The files in `docs/`

Do not send local configs, gateway keys, temp install folders, full logs, shell history, browser cookies, or personal files.

## What comes back

Ask the tester to return only:

- `macos-clean-install-validation-2026.07.24-rc.6.json`, `windows-clean-install-validation-2026.07.24-rc.6.json`, or `linux-clean-install-validation-2026.07.24-rc.6.json`
- Final terminal summary lines
- OS, CPU architecture, Node version, pnpm version
- Whether the dashboard opened
