#!/bin/bash
# Zaraa Remote Access Setup
# Sets up secure remote access to your Zaraa server for the iOS app.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}  Zaraa Remote Access Setup${NC}"
echo "  ========================="
echo ""
echo "  Choose a method to securely access Zaraa from your phone:"
echo ""
echo "  1) Tailscale              - Private VPN mesh (recommended for LAN-equivalent)"
echo "  2) Cloudflare (temporary) - Quick trycloudflare URL (rotates each run)"
echo "  3) Cloudflare (persistent)- Named tunnel + launchd + config persistence"
echo "  4) Show current connection info"
echo ""
read -p "  Select [1/2/3/4]: " choice

case $choice in
  1)
    echo ""
    echo -e "${GREEN}Setting up Tailscale...${NC}"
    echo ""

    # Check if Tailscale is installed
    if command -v tailscale &> /dev/null; then
      echo -e "  ${GREEN}✓${NC} Tailscale is installed"
    else
      echo -e "  ${YELLOW}Installing Tailscale via Homebrew...${NC}"
      if command -v brew &> /dev/null; then
        brew install tailscale
      else
        echo -e "  ${RED}✗ Homebrew not found. Install Tailscale manually:${NC}"
        echo "    https://tailscale.com/download/mac"
        exit 1
      fi
    fi

    # Check if Tailscale is running
    if tailscale status &> /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Tailscale is connected"
    else
      echo -e "  ${YELLOW}Starting Tailscale...${NC}"
      echo "  Run: sudo tailscale up"
      echo "  Then re-run this script."
      exit 1
    fi

    # Get Tailscale IP
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TS_IP" ]; then
      echo -e "  ${GREEN}✓${NC} Your Tailscale IP: ${GREEN}${TS_IP}${NC}"
      echo ""
      echo -e "  ${BLUE}In the Zaraa iOS app:${NC}"
      echo "  1. Go to Settings > Connection"
      echo "  2. Select 'Tailscale VPN' mode"
      echo "  3. Enter host: ${TS_IP}"
      echo "  4. Port: 3927 (default)"
      echo "  5. Enter your Zaraa API key"
      echo "  6. Tap 'Test Connection'"
      echo ""
      echo -e "  ${YELLOW}On your iPhone:${NC}"
      echo "  - Install Tailscale from the App Store"
      echo "  - Sign in with the same account"
      echo "  - Both devices join the same private network"
      echo ""
      echo -e "  ${GREEN}✓ No ports exposed. WireGuard encrypted. Works from anywhere.${NC}"
    else
      echo -e "  ${RED}✗ Could not determine Tailscale IP${NC}"
      echo "  Run: tailscale ip -4"
    fi
    ;;

  2)
    echo ""
    echo -e "${GREEN}Setting up Cloudflare Tunnel...${NC}"
    echo ""

    if command -v cloudflared &> /dev/null; then
      echo -e "  ${GREEN}✓${NC} cloudflared is installed"
    else
      echo -e "  ${YELLOW}Installing cloudflared via Homebrew...${NC}"
      if command -v brew &> /dev/null; then
        brew install cloudflared
      else
        echo -e "  ${RED}✗ Homebrew not found. Install cloudflared manually:${NC}"
        echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        exit 1
      fi
    fi

    echo ""
    echo -e "  ${BLUE}Quick setup (no domain needed):${NC}"
    echo ""
    echo "  Run this in another terminal to start a temporary tunnel:"
    echo ""
    echo -e "    ${GREEN}cloudflared tunnel --url http://localhost:3927${NC}"
    echo ""
    echo "  It will print a URL like: https://xxxxx.trycloudflare.com"
    echo "  Enter that URL in the iOS app under 'Cloudflare Tunnel' mode."
    echo ""
    echo -e "  ${YELLOW}Note:${NC} The temporary URL changes each time. For a permanent setup:"
    echo ""
    echo "  1. cloudflared tunnel login"
    echo "  2. cloudflared tunnel create zaraa"
    echo "  3. cloudflared tunnel route dns zaraa zaraa.yourdomain.com"
    echo "  4. Create ~/.cloudflared/config.yml:"
    echo ""
    echo "     tunnel: <your-tunnel-id>"
    echo "     credentials-file: ~/.cloudflared/<tunnel-id>.json"
    echo "     ingress:"
    echo "       - hostname: zaraa.yourdomain.com"
    echo "         service: http://localhost:3927"
    echo "       - service: http_status:404"
    echo ""
    echo "  5. cloudflared tunnel run zaraa"
    echo ""
    echo -e "  ${GREEN}✓ No ports exposed. Automatic HTTPS. Zero-trust access.${NC}"
    ;;

  3)
    echo ""
    echo -e "${GREEN}Setting up persistent Cloudflare Tunnel...${NC}"
    echo ""

    if ! command -v cloudflared &> /dev/null; then
      echo -e "  ${YELLOW}Installing cloudflared via Homebrew...${NC}"
      if command -v brew &> /dev/null; then
        brew install cloudflared
      else
        echo -e "  ${RED}✗ Homebrew not found. Install cloudflared manually:${NC}"
        echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        exit 1
      fi
    fi
    CLOUDFLARED=$(command -v cloudflared)
    echo -e "  ${GREEN}✓${NC} cloudflared at ${CLOUDFLARED}"

    # Auth
    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
      echo ""
      echo -e "  ${YELLOW}You need a Cloudflare account and a domain managed by Cloudflare DNS.${NC}"
      echo "  Running: cloudflared tunnel login"
      cloudflared tunnel login
    else
      echo -e "  ${GREEN}✓${NC} cloudflared is already authenticated"
    fi

    # Create tunnel if missing
    TUNNEL_NAME="zaraa"
    if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
      echo -e "  ${GREEN}✓${NC} Tunnel '${TUNNEL_NAME}' already exists"
    else
      echo -e "  ${YELLOW}Creating tunnel '${TUNNEL_NAME}'...${NC}"
      cloudflared tunnel create "$TUNNEL_NAME"
    fi

    TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v name="$TUNNEL_NAME" '$2 == name {print $1}')
    if [ -z "$TUNNEL_ID" ]; then
      echo -e "  ${RED}✗ Could not resolve tunnel id for '${TUNNEL_NAME}'${NC}"
      exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Tunnel id: ${TUNNEL_ID}"

    # Hostname
    read -p "  Enter the public hostname for Zaraa (e.g. zaraa.yourdomain.com): " HOSTNAME
    if [ -z "$HOSTNAME" ]; then
      echo -e "  ${RED}✗ Hostname required${NC}"
      exit 1
    fi

    # DNS route
    echo -e "  ${YELLOW}Routing DNS ${HOSTNAME} → ${TUNNEL_NAME}...${NC}"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || echo -e "  ${YELLOW}(DNS route may already exist; continuing)${NC}"

    # Write ~/.cloudflared/config.yml
    mkdir -p "$HOME/.cloudflared"
    cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: ${HOSTNAME}
    service: http://localhost:3927
  - service: http_status:404
EOF
    echo -e "  ${GREEN}✓${NC} Wrote ~/.cloudflared/config.yml"

    # Install launchd plist
    ZARA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
    PLIST_SRC="${ZARA_DIR}/scripts/com.zaraa.cloudflared.plist"
    PLIST_DST="${HOME}/Library/LaunchAgents/com.zaraa.cloudflared.plist"
    if [ ! -f "$PLIST_SRC" ]; then
      echo -e "  ${RED}✗ Plist template missing: ${PLIST_SRC}${NC}"
      exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s|__HOME__|${HOME}|g" -e "s|__CLOUDFLARED__|${CLOUDFLARED}|g" \
      "$PLIST_SRC" > "$PLIST_DST"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    echo -e "  ${GREEN}✓${NC} Installed launchd service com.zaraa.cloudflared"

    # Persist publicUrl into ~/.zaraa/zaraa.config.json
    CONFIG_FILE="$HOME/.zaraa/zaraa.config.json"
    PUBLIC_URL="https://${HOSTNAME}"
    if [ -f "$CONFIG_FILE" ]; then
      if command -v jq &> /dev/null; then
        tmp=$(mktemp)
        jq --arg url "$PUBLIC_URL" '.gateway = (.gateway // {}) | .gateway.publicUrl = $url' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
        echo -e "  ${GREEN}✓${NC} Persisted gateway.publicUrl=${PUBLIC_URL} in ${CONFIG_FILE}"
      else
        echo -e "  ${YELLOW}jq not installed — add this to ${CONFIG_FILE} manually:${NC}"
        echo "    \"gateway\": { \"publicUrl\": \"${PUBLIC_URL}\" }"
      fi
    else
      echo -e "  ${YELLOW}${CONFIG_FILE} not found — create it and add gateway.publicUrl when ready.${NC}"
    fi

    echo ""
    echo -e "  ${GREEN}✓ Persistent tunnel is now running.${NC}"
    echo ""
    echo -e "  ${BLUE}Verify:${NC}"
    echo "    curl -I ${PUBLIC_URL}/api/health"
    echo ""
    echo -e "  ${BLUE}iOS app setup:${NC}"
    echo "    Settings → Connection → Cloudflare Tunnel → URL: ${PUBLIC_URL}"
    echo ""
    echo -e "  ${BLUE}Browser:${NC}"
    echo "    Open ${PUBLIC_URL}/ (once packages/web/dist is built, the dashboard is served)"
    ;;

  4)
    echo ""
    echo -e "${BLUE}Current Connection Info${NC}"
    echo ""

    # Local IP
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "unknown")
    echo -e "  Local IP (Wi-Fi):  ${GREEN}${LOCAL_IP}${NC}"

    # Tailscale IP
    if command -v tailscale &> /dev/null; then
      TS_IP=$(tailscale ip -4 2>/dev/null || echo "not connected")
      echo -e "  Tailscale IP:      ${GREEN}${TS_IP}${NC}"
    else
      echo -e "  Tailscale:         ${YELLOW}not installed${NC}"
    fi

    # Port
    echo -e "  Zaraa Port:        ${GREEN}3927${NC}"

    # Check if Zaraa is running
    if curl -s http://localhost:3927/api/health > /dev/null 2>&1; then
      echo -e "  Zaraa Server:      ${GREEN}running${NC}"
    else
      echo -e "  Zaraa Server:      ${RED}not running${NC}"
    fi

    echo ""
    echo -e "  ${BLUE}For local network access:${NC}"
    echo "  Host: ${LOCAL_IP}, Port: 3927"
    echo ""
    ;;

  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
