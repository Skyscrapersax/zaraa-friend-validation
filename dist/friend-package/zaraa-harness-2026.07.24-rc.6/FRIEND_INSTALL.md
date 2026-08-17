# Zaraa Friend Harness

Package version: 2026.07.24-rc.6

This folder is a friend installer kit for Zaraa (built package `dist` runtime plus plugins, installers, and friend scripts). Monorepo `packages/*/src` trees and test fixtures are omitted on purpose so the kit is not a full source dump. It is the bridge toward native macOS, Windows, and Linux installers while the dashboard shell and update flow stabilize.

Package verification content-scans shipped text surfaces for secret-shaped content and owner-path residue, and fails closed on unreadable or oversized ship files. A positive scan count alone is not enough when coverage is incomplete.

## Install

macOS or Linux:

```bash
./installers/install-macos-linux.sh
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\installers\install-windows.ps1
```

For an isolated install, set `ZARAA_HOME_DIR` to a non-root absolute directory before running installer, setup, doctor, starter, or proof. Do not replace process `HOME`.

## Connect a model provider

Before asking Zaraa to do work, run the setup wizard from the installed folder:

```bash
cd <installed-root>
pnpm setup
```

Choose Anthropic, OpenRouter, or local Ollama. The wizard preserves an existing gateway key and strips live CEX/Solana/Polymarket credentials from the written config (explicit owner `paperMode: false` is still preserved by the wizard; live keys must be re-entered deliberately). When the wizard strips credentials from an existing config, it writes a timestamped mode-0600 `*.pre-setup-wizard.*.json` backup beside the config first, then rewrites the config atomically (temp + rename + chmod 0600). Installer reinstall/update re-pins paper-only trading/predictions, strips live CEX/Solana/Polymarket credentials and liveModeLock from home config (field names only in logs; a timestamped mode-0600 `*.pre-friend-pin.*.json` backup is written beside the config before mutation, with an exact `cp` restore command printed — secret values never logged; keeps the newest 5 pre-pin backups), writes the new config atomically (exclusive O_EXCL temp + rename + chmod 0600 — never writeFileSync through a pre-planted temp symlink), disables autonomous heartbeat/overnight/tasks, turns off calendar/iMessage/voice/creative-joy (friend-beta idle surface), and mints a gateway API key only if one is missing (never rotates a set key). Background autonomy remains off after provider setup; enable it deliberately from Zaraa settings when ready. The home config directory is mode 0700 (macOS/Linux) / restricted ACL (Windows) so other local users cannot list backup basenames. Pin and setup refuse a config path that is a symlink (including dangling), a non-regular file (directory/FIFO), or under a symlink parent directory (fail-closed path control). Installers refuse a symlink/reparse-point config dir or file **before** minting a gateway key so secrets never land outside the intended home. Pre-pin / pre-setup backups and atomic rewrite temps use exclusive create (O_EXCL) so a pre-planted symlink at the timestamped backup or temp name cannot siphon credentials. Doctor fails Config + Trading safety on the same unsafe paths so money rails are never skipped as "invalid JSON". Updater pin compensation metadata is written beside the home config (mode 0600), never under world-writable temp; home-config restore after failed swap uses the same restore path control as pin.

Verify provider access before starting:

```bash
pnpm doctor
```

## Start

```bash
cd <installed-root>
pnpm start
```

Then open http://localhost:3927/.

For release proof, finalize safe config before launch. From the exact installed root, start one daemon and keep its terminal open:

```bash
ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_PORT=<port> ZARAA_DISABLE_IMESSAGE=1 ZARAA_SERVICE_LABEL=com.zaraa.friend-proof pnpm start
```

Verify its numeric PID owns the port. Record visible browser proof with the same runtime home, root, and gateway. Without restart or config change, start the sampler in another terminal and keep every identity unchanged for the full window:

```bash
ZARAA_HOME_DIR=/absolute/isolated/home ZARAA_GATEWAY_BASE=http://127.0.0.1:<port> pnpm proof:24h -- --restart-window --daemon-pid <verified-pid>
```

## Update model

The installer copies this package into the local Zaraa directory, keeps any existing `~/.zaraa/zaraa.config.json`, installs dependencies, and runs `pnpm ship:preflight`.

The generated release manifest records artifact hashes so future native installers and auto-updaters can compare the installed version against Mama Zaraa's master release.

## Docs included in this package

- `docs/RELEASE.md`
- `docs/friend-harness-install-guide.md`
- `docs/friend-package-handoff.md`
- `docs/friend-release-notes-template.md`
- `docs/friend-known-issues.md`
- `docs/friend-platform-validation.md`
- `docs/friend-platform-validation-handoff.md`

## Do not share

Do not copy a personal `~/.zaraa` folder, gateway API key, local config, logs, memories, or private workspace data into this package. Each friend install should use its own local credentials.

## Recovery

If the daemon is flaky or crashed: from the installed folder run `pnpm truth` (needs a live daemon). If MCP is unreachable, run `pnpm doctor` first. Inspect `~/.zaraa/logs/` and restart only when exec activeCount is 0.

If an install breaks, pause updates, move the installed folder aside, reinstall the previous archive, and keep the broken folder until the issue is understood.

The friend-kit updater stages the new release beside the live install, runs install + preflight there, re-pins home config money/idle rails from the staged kit (timestamped mode-0600 backup + atomic write) *before* the live swap, then swaps only on success. A pin or preflight failure leaves the previous live folder and version marker intact (staging is removed). If pin mutates home config and a later swap/marker step fails, the updater restores the pre-pin backup so home config and the install tree stay consistent. After a successful swap the pin is kept (new kit is live). After a successful update, one previous tree is kept at `~/zaraa.zaraa-previous` (or `<target>.zaraa-previous`).

Rollback after a bad successful update:

```bash
rm -rf ~/zaraa && mv ~/zaraa.zaraa-previous ~/zaraa
```

## Update

Unpack a newer friend kit, then run the same installer again. You can also run the updater directly:

```bash
node scripts/friend-kit-update.mjs --source "$PWD" --target "$HOME/zaraa"
```

The updater never overwrites `~/.zaraa/zaraa.config.json` (home config is outside the install tree). Local kit state under `.zaraa-local` is carried across the atomic swap. `node_modules` is carried when present, then refreshed with `pnpm install --frozen-lockfile` in staging before the live swap.
