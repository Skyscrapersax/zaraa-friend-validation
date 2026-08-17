# Zaraa Friend Release Notes Template

## Version

- Version:
- Channel:
- Date:
- Package archives:

## What changed

- Dashboard:
- Gateway:
- Modes:
- Packaging:
- Updates:

## Validation evidence

- `pnpm --filter @zaraa/web build`:
- `pnpm ship:ready`:
- `pnpm ship:candidate`:
- `pnpm ship:verify-package`:
- `pnpm ship:promote:ready -- --runtime-root <installed-root> --gateway-url <candidate-url> --confirm-browser-smoke`:
- Browser smoke:
- macOS install:
- Windows install:
- Linux install:

## Known issues

- Installer validation is required before sharing beyond the trusted beta circle.

## Rollback

- Previous package:
- Restore steps:
- Update freeze needed:

## Support notes

Ask for visible error text and screenshots only. Do not ask friends to send gateway keys, local config files, logs, memories, private documents, or `~/.zaraa`.
