#!/usr/bin/env bash
# Serve normalized packaged segments (legacy — prefer R2 via prep/upload-r2.sh).
#
# usage: prep/serve-cdn.sh [slug=demo] [port=9090]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG=${1:-demo}
PORT=${2:-9090}
CDN_DIR="$ROOT/prep/out/$SLUG/cdn"

if [ ! -d "$CDN_DIR" ]; then
  echo "missing $CDN_DIR — run prep/package.sh first" >&2
  exit 1
fi

echo "Serving local CDN: http://localhost:$PORT"
echo "  root: $CDN_DIR"
echo "  (Ctrl+C to stop)"
exec npx --yes serve "$CDN_DIR" -l "$PORT" --cors
