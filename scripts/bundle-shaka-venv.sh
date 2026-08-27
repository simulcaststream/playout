#!/usr/bin/env bash
# Bundle Shaka Streamer + binaries into the Tauri app resources for release builds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/desktop/src-tauri/resources/shaka-venv"

echo "Creating Shaka venv at $VENV"
rm -rf "$VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install shaka-streamer shaka-streamer-binaries

echo "Shaka Streamer: $("$VENV/bin/shaka-streamer" --version 2>/dev/null || echo installed)"
echo "Done. Bundled for Tauri resources."
