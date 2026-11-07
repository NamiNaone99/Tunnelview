#!/bin/bash
# Build Tunnelview on this Mac and install it into Applications.
#
#   cd <the Tunnelview folder>
#   bash scripts/mac-install.sh
#
# Needs macOS 13 Ventura or newer, Node.js 22.12+ (https://nodejs.org) and an internet connection
# (npm downloads Electron). Builds only for this Mac's architecture (Apple Silicon or Intel), so no
# cross-architecture native binaries are involved. Written for the bash 3.2 that ships with macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nTunnelview setup stopped: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS."

macos="$(sw_vers -productVersion)"
major="${macos%%.*}"
[ "$major" -ge 13 ] || die "Tunnelview (Electron 45) needs macOS 13 Ventura or newer; this Mac runs macOS $macos."

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install the LTS version from https://nodejs.org (macOS Installer), then run this script again."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
  || die "Node.js 22.12 or newer is needed (found $(node -v)). Install the LTS version from https://nodejs.org."

# npm installs Electron and koffi's native binary for Node's own architecture, so build for that.
arch="$(node -p process.arch)"
case "$arch" in
  arm64|x64) ;;
  *) die "unsupported architecture: $arch" ;;
esac
if [ "$arch" = "x64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  echo "Note: this is an Apple Silicon Mac but Node.js runs under Rosetta (x64), so Tunnelview will be built"
  echo "      for Intel and run under Rosetta too. Install the Apple Silicon (arm64) Node.js for a native build."
fi
echo "macOS $macos, building for $arch."

if [ ! -d /Applications/Tailscale.app ] && ! command -v tailscale >/dev/null 2>&1; then
  echo "Warning: Tailscale was not found. Tunnelview only works over Tailscale: install it from"
  echo "         https://tailscale.com/download/mac and sign in to the same tailnet as your other computer."
fi

say "Installing dependencies (npm ci; this downloads Electron)"
npm ci

say "Running the unit tests"
log="$(mktemp -t tunnelview-tests)"
if npm test >"$log" 2>&1; then
  grep -E '^# (tests|pass|fail)' "$log" || true
else
  grep -E '^# (tests|pass|fail)|^not ok' "$log" || true
  echo "Warning: some unit tests failed on this Mac (full log: $log). Continuing with the build."
fi

say "Building Tunnelview.app"
rm -rf dist/mac dist/mac-arm64 dist/mac-x64
npm run icons
npx electron-builder --mac dir "--$arch" --publish never
if [ "$arch" = "arm64" ]; then app="dist/mac-arm64/Tunnelview.app"; else app="dist/mac/Tunnelview.app"; fi
[ -d "$app" ] || app="$(ls -d dist/mac*/Tunnelview.app 2>/dev/null | head -n 1 || true)"
[ -n "$app" ] && [ -d "$app" ] || die "the build did not produce Tunnelview.app (see the output above)."
node scripts/verify-fuses.js "$app"

say "Installing"
dest="/Applications"
[ -w "$dest" ] || dest="$HOME/Applications"
mkdir -p "$dest"
if pgrep -x Tunnelview >/dev/null 2>&1; then
  osascript -e 'tell application "Tunnelview" to quit' >/dev/null 2>&1 || true
  sleep 2
fi
replaced=0
if [ -d "$dest/Tunnelview.app" ]; then replaced=1; fi
rm -rf "$dest/Tunnelview.app"
ditto "$app" "$dest/Tunnelview.app"
if [ "$replaced" = "1" ]; then
  # A rebuild has a new ad-hoc signature, so macOS no longer honours the old permission entries
  # (they stay switched on but do nothing). Reset them so Tunnelview can ask again cleanly.
  for service in ScreenCapture Accessibility SystemPolicyDownloadsFolder; do
    tccutil reset "$service" io.github.naminaone99.tunnelview >/dev/null 2>&1 || true
  done
  echo "Replaced an existing Tunnelview: its Screen Recording, Accessibility and Downloads permissions were reset."
fi
# Built on this Mac, so normally there is nothing to clear; this only matters if files were copied in
# with a quarantine flag.
xattr -dr com.apple.quarantine "$dest/Tunnelview.app" 2>/dev/null || true

say "Done: $dest/Tunnelview.app"
cat <<'EOF'
Tunnelview is starting now. To let other computers see and control this Mac, open the This Desk view:
  1. Screen Recording: click Grant, switch Tunnelview on in System Settings > Privacy & Security >
     Screen Recording (macOS 15+: Screen & System Audio Recording), then click Quit & Reopen.
  2. Accessibility: click Grant and switch Tunnelview on, so remote mouse and keyboard input works.
  3. Click Allow when macOS asks about the Downloads folder (needed to receive files), and, if the
     macOS firewall is on, allow Tunnelview to accept incoming connections.
To connect from this Mac to another computer, type its Tailscale name or 100.x address in Tunnelview.
EOF
open "$dest/Tunnelview.app"
