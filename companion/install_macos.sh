#!/usr/bin/env bash
# LockIn companion installer for macOS.
#
# Creates companion/.venv with psutil, writes the launcher
# companion/lockin_host.sh, and registers the native messaging host
# "com.lockin.companion" for Chrome, Edge, Brave and Chromium (only for the
# browsers that are installed for this user).
#
# Usage:  bash companion/install_macos.sh [EXTENSION_ID]
# Without an argument the ID is read from ../extension/EXTENSION_ID.txt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.lockin.companion"
VENV="$SCRIPT_DIR/.venv"
LAUNCHER="$SCRIPT_DIR/lockin_host.sh"

# 1. Extension ID
if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  EXT_ID="$1"
else
  ID_FILE="$SCRIPT_DIR/../extension/EXTENSION_ID.txt"
  if [ ! -f "$ID_FILE" ]; then
    echo "Error: extension ID not found." >&2
    echo "  Expected file: $ID_FILE" >&2
    echo "  Run 'python3 scripts/generate_key.py' first, or pass the ID:" >&2
    echo "  bash companion/install_macos.sh <extension-id>" >&2
    exit 1
  fi
  EXT_ID="$(tr -d '[:space:]' < "$ID_FILE")"
fi
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: '$EXT_ID' does not look like a Chrome extension ID (32 letters a-p)." >&2
  exit 1
fi

# 2. Python 3.9+
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  echo "Error: Python 3.9 or newer is required." >&2
  echo "  Install Apple's Command Line Tools with:  xcode-select --install" >&2
  echo "  then run this script again." >&2
  exit 1
fi

# 3. Virtual environment + requirements
echo "Creating virtual environment in $VENV ..."
python3 -m venv "$VENV"
"$VENV/bin/python3" -m pip install --quiet --disable-pip-version-check -r "$SCRIPT_DIR/requirements.txt"

# 4. Launcher
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$VENV/bin/python3" "$SCRIPT_DIR/lockin_host.py" "\$@"
EOF
chmod +x "$LAUNCHER"

# 5. Host manifests
SUPPORT="$HOME/Library/Application Support"
BROWSER_DIRS=(
  "$SUPPORT/Google/Chrome"
  "$SUPPORT/Microsoft Edge"
  "$SUPPORT/BraveSoftware/Brave-Browser"
  "$SUPPORT/Chromium"
)
installed=0
for parent in "${BROWSER_DIRS[@]}"; do
  if [ -d "$parent" ]; then
    target="$parent/NativeMessagingHosts"
    mkdir -p "$target"
    "$VENV/bin/python3" - "$target/$HOST_NAME.json" "$LAUNCHER" "$EXT_ID" "$HOST_NAME" <<'PY'
import json, sys
out, launcher, ext_id, name = sys.argv[1:5]
manifest = {
    "name": name,
    "description": "LockIn desktop companion",
    "path": launcher,
    "type": "stdio",
    "allowed_origins": ["chrome-extension://%s/" % ext_id],
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY
    echo "Registered for: $parent"
    installed=$((installed + 1))
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "Warning: no Chrome, Edge, Brave or Chromium profile folder was found." >&2
  echo "  Open your browser once, then run this script again." >&2
  exit 1
fi

echo ""
echo "LockIn companion installed (extension ID $EXT_ID)."
echo "Restart Chrome if it was open."
echo "Test it with:  \"$LAUNCHER\" --diagnose"
