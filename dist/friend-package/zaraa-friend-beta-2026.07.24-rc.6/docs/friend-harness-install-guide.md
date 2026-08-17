# Zaraa Friend Harness Install Guide

This guide is for the first friend-safe Zaraa harness package. It assumes the package has already been generated locally and appears in `dist/friend-package`.

## Current package

- Version: read `dist/friend-package/latest.json`
- Archive: `dist/friend-package/zaraa-harness-<version>.zip`
- Archive: `dist/friend-package/zaraa-harness-<version>.tar.gz`
- Index: `dist/friend-package/latest.json`
- macOS/Linux installer: `installers/install-macos-linux.sh`
- Windows installer: `installers/install-windows.ps1`

## Before sharing

1. Install into a clean temporary folder on macOS.
2. Confirm the dashboard opens.
3. Confirm the browser can unlock with the local gateway key.
4. Confirm `#ship-readiness`, `#cockpit`, `#dashboard`, and `#brain-map` scroll.
5. Confirm the command palette opens and can find `Ship Readiness`.
6. Repeat the install path on Windows or a Windows VM.
7. Repeat the install path on Linux or a Linux VM.

## Handoff summary

Share this bundle only after installer validation is complete:

- `dist/friend-package/zaraa-harness-<version>.zip`
- `dist/friend-package/zaraa-harness-<version>.tar.gz`
- `dist/friend-package/latest.json`
- `installers/install-macos-linux.sh`
- `installers/install-windows.ps1`
- `docs/friend-harness-install-guide.md`
- `docs/friend-package-handoff.md`

Tell the recipient to open Ship Readiness first after install. That page is the source of truth for release status, recovery notes, and update rules.

Do not share your own `~/.zaraa` folder, gateway API key, local config, logs, or secrets. Each friend install should generate or receive its own local credentials.

## Friend install flow

1. Send the archive and the matching installer for their operating system.
2. For an isolated install, export `ZARAA_HOME_DIR=/absolute/isolated/home` before running the installer; do not replace process `HOME`.
3. Have them extract the archive into a dedicated Zaraa folder.
4. Have them run the installer from that folder with the same `ZARAA_HOME_DIR`.
5. From the installed folder, have them run `pnpm setup` and choose Anthropic, OpenRouter, or local Ollama.
6. Have them run `pnpm doctor`; resolve any `[FAIL]` before continuing.
7. From `$ZARAA_HOME_DIR/zaraa` (or the installer-reported default root), have them start Zaraa with the same `ZARAA_HOME_DIR` and open the printed dashboard URL.
8. Have them unlock the local browser session with their own generated gateway key.
9. Have them open Ship Readiness first so they know where recovery instructions live.

## First-run friend flow

1. Run `pnpm setup` from the installed Zaraa folder.
2. Run `pnpm doctor`; resolve any `[FAIL]`.
3. Start Zaraa with the matching starter script.
4. Open the local dashboard URL printed by the starter script.
5. If the browser says the session is locked, enter the local gateway key created for that install.
6. Open Ship Readiness first.
7. Open Cockpit, Dashboard, and Brain Map.
8. Confirm each page scrolls.
9. Open the command palette and search for Ship Readiness.

For a 24-hour proof, finalize safe config before launch. From exact installed root, start one daemon and keep its terminal open: `ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_PORT=<port> ZARAA_DISABLE_IMESSAGE=1 ZARAA_SERVICE_LABEL=com.zaraa.friend-proof pnpm start`. Verify its numeric PID owns the port, then record visible browser proof with the same home/root/gateway. Without restart or config change, start the sampler in another terminal: `ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_BASE=http://127.0.0.1:<port> pnpm proof:24h -- --restart-window --daemon-pid <verified-pid>`.

Until setup completes, the friend config stays in minimal mode with overnight work and background trading disabled. Trading and prediction execution start in paper mode. Calendar, iMessage, and voice/FaceTime probes stay off until explicitly enabled, avoiding surprise permission prompts. Setup preserves those safety settings and the generated gateway key; background trading remains opt-in through `trading.backgroundAutomation`.

## Gateway key guidance

Each friend install needs its own local gateway key. Do not share Zaraa's `~/.zaraa/zaraa.config.json`, gateway API key, logs, memories, or local config. If a key is lost, create or provide a new local key for that install rather than copying a personal config folder.

## Recovery flow

1. Soft reset: reload the dashboard, check the local gateway, and unlock the browser again.
2. Clean reinstall: move the installed harness folder aside and reinstall from the latest package.
3. Rollback: use `latest.json` and the prior archive to restore the previous known-good package.
4. Freeze updates: pause friend updates until the issue is understood and a new package is staged.
5. Keep the broken folder until the issue is understood.

## Troubleshooting

### Locked browser session

Reload the page, confirm the gateway is running, and enter the local gateway key for that install. Do not paste another person's key.

### Gateway offline

Run the starter script again. If the dashboard still cannot connect, check whether another process is using the gateway port.

### Wrong Node or pnpm version

Run the installer again so it can check the runtime and package manager. If it still fails, capture only the visible error text.

### Port conflict

Stop the conflicting local service or configure a different local gateway port before retrying.

### Stale dashboard assets

Reload the dashboard. If a hashed asset fails, reinstall from the latest package and preserve the previous install folder for debugging.

## Rollback checklist

1. Pause updates.
2. Read `dist/friend-package/latest.json` to identify the current package.
3. Restore the previous archive from the same release folder.
4. Run the matching starter script.
5. Confirm Ship Readiness opens and scrolls.
6. Record which package failed and which package restored successfully.

## Update rules

- Master can move quickly while Mama Zaraa optimizes.
- Beta receives promoted master snapshots after build, preflight, package, and browser smoke checks.
- Friends receives only validated beta packages with install and rollback notes.
- Stable comes later, after friend packages survive normal use.
