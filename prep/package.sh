#!/usr/bin/env bash
# Package a source file with Shaka Streamer, normalize output for the Worker,
# and write a KV-ready event record. Removes any previous output for the slug.
#
# usage: prep/package.sh <input-video> [slug=demo] [segment_seconds=4]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT=${1:?usage: prep/package.sh <input-video> [slug] [segment_seconds]}
SLUG=${2:-demo}
SEG_DUR=${3:-4}
OUT="$ROOT/prep/out/$SLUG"
SHAKA="$ROOT/.venv/bin/shaka-streamer"

if [ ! -x "$SHAKA" ]; then
  echo "Shaka Streamer venv not found. Run:" >&2
  echo "  python3 -m venv .venv" >&2
  echo "  .venv/bin/pip install --upgrade shaka-streamer shaka-streamer-binaries" >&2
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "input file not found: $INPUT" >&2
  exit 1
fi

# Resolve to an absolute path for Shaka.
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"

echo "Removing previous output: $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# Inject segment duration into a temp pipeline config.
PIPELINE_TMP="$OUT/.pipeline.yaml"
sed "s/^segment_size: .*/segment_size: ${SEG_DUR}/" "$ROOT/prep/shaka/pipeline.yaml" > "$PIPELINE_TMP"

sed "s|INPUT_FILE_PLACEHOLDER|${INPUT_ABS}|g" "$ROOT/prep/shaka/input.yaml" > "$OUT/.input.yaml"

echo "Packaging with Shaka Streamer -> $OUT"
"$SHAKA" -i "$OUT/.input.yaml" -p "$PIPELINE_TMP" -o "$OUT"

node "$ROOT/prep/build-kv-record.mjs" \
  --dir "$OUT" \
  --slug "$SLUG" \
  --segment-duration "$SEG_DUR" \
  --worker-port 8787 \
  --start-in-seconds 10

chmod +x "$ROOT/prep/upload-r2.sh"
echo "Uploading segments to local R2..."
"$ROOT/prep/upload-r2.sh" "$SLUG" --local

echo ""
echo "Done."
echo "  R2 prefix:  $SLUG/ (local simulator)"
echo "  KV record:  prep/out/$SLUG/kv-record.json"
echo ""
echo "Next:"
echo "  npx wrangler kv key put --binding=LIVE_EVENT_RECORDS \"$SLUG\" --path=prep/out/$SLUG/kv-record.json --local"
echo "  pnpm dev"
echo "  open http://localhost:8787/player/$SLUG"
