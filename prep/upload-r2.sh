#!/usr/bin/env bash
# Upload normalized cdn/ tree to the SEGMENTS R2 bucket under {slug}/.
#
# usage: prep/upload-r2.sh <slug> [--local|--remote]
#   --local  wrangler dev R2 simulator (default)
#   --remote production bucket (uploads in parallel; override with UPLOAD_JOBS=n)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG=${1:?usage: prep/upload-r2.sh <slug> [--local|--remote]}
LOCATION=${2:---local}
CDN_DIR="$ROOT/prep/out/$SLUG/cdn"
WRANGLER_TOML="$ROOT/wrangler.toml"

if [ ! -d "$CDN_DIR" ]; then
  echo "missing $CDN_DIR — run prep/package.sh first" >&2
  exit 1
fi

BUCKET=$(sed -n 's/^bucket_name = "\(.*\)"/\1/p' "$WRANGLER_TOML" | head -1)
if [ -z "$BUCKET" ]; then
  echo "no [[r2_buckets]] bucket_name in wrangler.toml" >&2
  exit 1
fi

# Local simulator writes to one sqlite db — keep it serial to avoid lock contention.
if [ "$LOCATION" = "--remote" ]; then
  JOBS=${UPLOAD_JOBS:-8}
else
  JOBS=1
fi

export CDN_DIR SLUG BUCKET LOCATION
export IMMUTABLE="public, max-age=31536000, immutable"

upload_one() {
  local file=$1
  local rel="${file#"$CDN_DIR"/}"
  local key="$SLUG/$rel"
  local ct
  case "$file" in
    *.m4s) ct="video/iso.segment" ;;
    *.mp4) ct="video/mp4" ;;
    *) ct="application/octet-stream" ;;
  esac
  npx wrangler r2 object put "$BUCKET/$key" \
    --file "$file" \
    --content-type "$ct" \
    --cache-control "$IMMUTABLE" \
    "$LOCATION" >/dev/null
}
export -f upload_one

TOTAL=$(find "$CDN_DIR" -type f | wc -l | tr -d ' ')
echo "uploading $TOTAL objects with $JOBS job(s)..."

find "$CDN_DIR" -type f -print0 \
  | xargs -0 -P "$JOBS" -I{} bash -c 'upload_one "$1"' _ {}

echo "done: $TOTAL objects -> r2://$BUCKET/$SLUG/ ($LOCATION)"
