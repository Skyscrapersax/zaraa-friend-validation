#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MIN_VERSION=22

ok() { echo "  [OK]  $1"; }
warn() { echo "  [!!]  $1"; }
fail() { echo "  [ERR] $1"; exit 1; }
step() { echo ""; echo "-- $1 --"; }

if [ "${ZARAA_HOME_DIR+x}" = x ]; then
	RUNTIME_HOME="$(printf '%s' "$ZARAA_HOME_DIR" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
	[ -n "$RUNTIME_HOME" ] || fail "ZARAA_HOME_DIR must be a non-empty absolute path"
else
	RUNTIME_HOME="$HOME"
fi
case "$RUNTIME_HOME" in
	/*) ;;
	*) fail "ZARAA_HOME_DIR must be a non-empty absolute path" ;;
esac

echo ""
echo "  Zaraa Friend Harness Installer"
echo "  Package: zaraa-harness-2026.07.24-rc.6"
echo ""

step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
	fail "Node.js 22+ is required. Install it from https://nodejs.org/ and rerun this installer."
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_VERSION" ]; then
	fail "Node.js 22+ is required, found $(node -v)."
fi
ok "Node.js $(node -v)"

RUNTIME_HOME="$(node -e "process.stdout.write(require('path').resolve(process.argv[1]))" "$RUNTIME_HOME")"
[ "$RUNTIME_HOME" != "/" ] || fail "ZARAA_HOME_DIR cannot be a filesystem root"
ZARAA_DIR="${ZARAA_DIR:-$RUNTIME_HOME/zaraa}"
CONFIG_DIR="$RUNTIME_HOME/.zaraa"
CONFIG_FILE="$CONFIG_DIR/zaraa.config.json"

step "Preparing install directory"
mkdir -p "$ZARAA_DIR"
ok "Install target ready at $ZARAA_DIR"

step "Preparing local gateway key"
# Fail-closed path control BEFORE minting a gateway key: never write secrets through
# a symlink config dir/file (would land the key outside the operator-intended home).
if [ -L "$CONFIG_DIR" ]; then
	fail "Refusing install: config directory is a symlink ($CONFIG_DIR). Replace it with a real directory under $HOME/.zaraa."
fi
if [ -L "$CONFIG_FILE" ]; then
	fail "Refusing install: config file is a symlink ($CONFIG_FILE). Replace it with a regular file under $HOME/.zaraa."
fi
if [ -e "$CONFIG_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
	fail "Refusing install: config path is not a regular file ($CONFIG_FILE)."
fi
# Mode 0700 so other local users cannot list pre-pin backup basenames beside the config.
mkdir -p "$CONFIG_DIR"
# Re-check after mkdir: mkdir -p follows an existing symlink parent rather than replacing it.
if [ -L "$CONFIG_DIR" ]; then
	fail "Refusing install: config directory is a symlink after mkdir ($CONFIG_DIR)."
fi
chmod 700 "$CONFIG_DIR" 2>/dev/null || true
if [ ! -f "$CONFIG_FILE" ]; then
	if [ -L "$CONFIG_FILE" ]; then
		fail "Refusing install: config file is a symlink ($CONFIG_FILE)."
	fi
	ZARAA_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
	# umask 077 so the gateway key never lands world-readable before chmod.
	( umask 077; cat > "$CONFIG_FILE" <<JSON
{
  "gateway": {
    "trusted": false,
    "auth": {
      "apiKey": "$ZARAA_KEY"
    }
  },
  "performance": "minimal",
  "autonomy": {
    "mode": "off",
    "creativeJoy": {
      "enabled": false
    }
  },
  "scheduler": {
    "tasks": [
      {
        "id": "daily-crypto-discipline",
        "enabled": false,
        "schedule": "daily 09:00 UTC",
        "zone": "guarded",
        "prompt": "Daily trading discipline snapshot.",
        "notify": "none",
        "silent": true
      }
    ],
    "overnight": {
      "enabled": false
    }
  },
  "trading": {
    "backgroundAutomation": false,
    "paperMode": true,
    "autoExecuteLive": false
  },
  "predictions": {
    "paperMode": true,
    "autoExecuteLive": false
  },
  "calendar": {
    "enabled": false
  },
  "messaging": {
    "imessage": {
      "enabled": false
    }
  },
  "voice": {
    "provider": "pipeline",
    "enabled": false,
    "facetime": {
      "enabled": false
    }
  }
}
JSON
)
	chmod 600 "$CONFIG_FILE" 2>/dev/null || true
	ok "Created local gateway config at $CONFIG_FILE"
else
	ok "Keeping existing local gateway config"
fi

# Always re-pin paper-only money rails (preserves gateway key; forces paperMode true).
step "Pinning friend paper-only trading rails"
node "$KIT_DIR/scripts/friend-config-safety.mjs" --config "$CONFIG_FILE"

step "Setting up package manager"
# Node 25+ no longer bundles corepack, so bring it in via npm before using it.
if ! command -v corepack >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
	npm install -g corepack >/dev/null 2>&1 || true
fi
if command -v corepack >/dev/null 2>&1; then
	corepack enable >/dev/null 2>&1 || true
	corepack prepare pnpm@9.15.4 --activate >/dev/null 2>&1 || true
fi
# Last resort: npm ships with Node on every supported platform.
if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
	npm install -g pnpm@9.15.4 >/dev/null 2>&1 || true
fi

if ! command -v pnpm >/dev/null 2>&1; then
	fail "pnpm is required. Install it with: npm install -g pnpm@9.15.4"
fi

ok "pnpm $(pnpm -v)"

step "Installing or updating Zaraa"
node "$KIT_DIR/scripts/friend-kit-update.mjs" --source "$KIT_DIR" --target "$ZARAA_DIR" --home-config "$CONFIG_FILE"

echo ""
echo "Install complete."
echo "1. Connect a model provider:"
printf '  cd %q && ZARAA_HOME_DIR=%q pnpm setup
' "$ZARAA_DIR" "$RUNTIME_HOME"
echo ""
echo "2. Verify setup:"
printf '  cd %q && ZARAA_HOME_DIR=%q pnpm doctor
' "$ZARAA_DIR" "$RUNTIME_HOME"
echo ""
echo "3. Start Zaraa:"
printf '  cd %q && ZARAA_HOME_DIR=%q pnpm start
' "$ZARAA_DIR" "$RUNTIME_HOME"
echo ""
echo "4. Open:"
echo "  http://localhost:3927/"
