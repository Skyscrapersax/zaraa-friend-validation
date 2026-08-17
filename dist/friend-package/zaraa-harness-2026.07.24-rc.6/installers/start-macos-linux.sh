#!/usr/bin/env bash
set -euo pipefail

fail() { echo "  [ERR] $1"; exit 1; }

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
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required"
RUNTIME_HOME="$(node -e "process.stdout.write(require('path').resolve(process.argv[1]))" "$RUNTIME_HOME")"
[ "$RUNTIME_HOME" != "/" ] || fail "ZARAA_HOME_DIR cannot be a filesystem root"
ZARAA_DIR="${ZARAA_DIR:-$RUNTIME_HOME/zaraa}"

if [ ! -d "$ZARAA_DIR" ]; then
	echo "Zaraa is not installed at $ZARAA_DIR yet."
	echo "Run ./installers/install-macos-linux.sh first."
	exit 1
fi

cd "$ZARAA_DIR"
echo "Starting Zaraa from $ZARAA_DIR"
echo "Open http://localhost:3927/ after the gateway is ready."
ZARAA_HOME_DIR="$RUNTIME_HOME" pnpm start
