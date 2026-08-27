#!/usr/bin/env bash
# Bundle relocatable Python + Shaka Streamer for macOS desktop release builds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/desktop/src-tauri/resources"
PYTHON_DIR="$RESOURCES/python"
PY_RELEASE="20241002"
PY_VERSION="3.12.7"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "bundle-shaka-mac.sh: macOS only (use repo .venv on other platforms for dev)" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) PY_ARCH="aarch64" ;;
  x86_64) PY_ARCH="x86_64" ;;
  *)
    echo "unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

PY_TAG="cpython-${PY_VERSION}+${PY_RELEASE}-${PY_ARCH}-apple-darwin-install_only"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_TAG}.tar.gz"

echo "Downloading standalone Python (${PY_ARCH})…"
rm -rf "$PYTHON_DIR"
mkdir -p "$RESOURCES"
curl -fsSL "$URL" | tar xz -C "$RESOURCES"
mv "$RESOURCES/python" "$PYTHON_DIR.tmp"
mv "$PYTHON_DIR.tmp" "$PYTHON_DIR"

echo "Installing Shaka Streamer into bundled Python…"
"$PYTHON_DIR/bin/python3" -m pip install --upgrade pip
"$PYTHON_DIR/bin/python3" -m pip install shaka-streamer shaka-streamer-binaries

echo "Shaka Streamer: $("$PYTHON_DIR/bin/shaka-streamer" --version 2>/dev/null || echo installed)"
echo "Bundled Python + Shaka -> $PYTHON_DIR"
