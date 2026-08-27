#!/usr/bin/env bash
# Stage everything the Playout desktop app needs at runtime (Mac release focus).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREP_DST="$ROOT/desktop/src-tauri/resources/prep"

echo "Copying prep scripts into Tauri resources…"
rm -rf "$PREP_DST"
mkdir -p "$PREP_DST/shaka"
cp "$ROOT/prep/pack-shaka.sh" "$PREP_DST/"
cp "$ROOT/prep/shaka/"*.yaml "$PREP_DST/shaka/"
chmod +x "$PREP_DST/pack-shaka.sh"
echo "  -> $PREP_DST"

if [ "$(uname -s)" = "Darwin" ]; then
  bash "$ROOT/scripts/bundle-shaka-mac.sh"
else
  echo "Skipping standalone Python bundle (not macOS). Release builds on Mac only for now."
  bash "$ROOT/scripts/bundle-shaka-venv.sh"
fi

echo "Desktop resources ready under desktop/src-tauri/resources/"
