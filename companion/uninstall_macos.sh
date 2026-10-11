#!/usr/bin/env bash
# LockIn companion uninstaller for macOS.
#
# Removes the native messaging host manifests for Chrome, Edge, Brave and
# Chromium, the launcher companion/lockin_host.sh and companion/.venv.
# The log folder ~/.lockin is left in place (delete it by hand if you like).
#
# Usage:  bash companion/uninstall_macos.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.lockin.companion"
SUPPORT="$HOME/Library/Application Support"
BROWSER_DIRS=(
  "$SUPPORT/Google/Chrome"
  "$SUPPORT/Microsoft Edge"
  "$SUPPORT/BraveSoftware/Brave-Browser"
  "$SUPPORT/Chromium"
)

for parent in "${BROWSER_DIRS[@]}"; do
  manifest="$parent/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$manifest" ]; then
    rm -f "$manifest"
    echo "Removed: $manifest"
  fi
done

rm -f "$SCRIPT_DIR/lockin_host.sh"
rm -rf "$SCRIPT_DIR/.venv"

echo "LockIn companion uninstalled. Restart your browser if it was open."
