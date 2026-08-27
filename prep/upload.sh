#!/usr/bin/env bash
# Upload a segmented asset to R2 under {eventId}/ with the immutable cache
# headers baked into object metadata (used when serving off an R2 custom
# domain). Idempotent: puts overwrite byte-identical objects.
#
# usage: prep/upload.sh <segmented-dir> <eventId> [--local|--remote]
#   --local  writes to wrangler dev's local R2 simulator (default)
#   --remote writes to the real bucket
set -euo pipefail

DIR=${1:?usage: prep/upload.sh <segmented-dir> <eventId> [--local|--remote]}
EVENT_ID=${2:?usage: prep/upload.sh <segmented-dir> <eventId> [--local|--remote]}
LOCATION=${3:---local}
BUCKET=$(sed -n 's/^bucket_name = "\(.*\)"/\1/p' "$(dirname "$0")/../wrangler.toml" | head -1)

IMMUTABLE="public, max-age=31536000, immutable"

put() { # file key content-type cache-control
  npx wrangler r2 object put "$BUCKET/$EVENT_ID/$2" \
    --file "$DIR/$1" --content-type "$3" --cache-control "$4" "$LOCATION" >/dev/null
  echo "put $BUCKET/$EVENT_ID/$2"
}

[ -f "$DIR/manifest.json" ] || { echo "missing $DIR/manifest.json — run build-manifest.mjs first" >&2; exit 1; }

put init.mp4 init.mp4 video/mp4 "$IMMUTABLE"
for f in "$DIR"/seg_*.m4s; do
  put "$(basename "$f")" "$(basename "$f")" video/mp4 "$IMMUTABLE"
done
# Immutable per asset version too — the worker caches the parsed copy in-isolate.
put manifest.json manifest.json application/json "$IMMUTABLE"

echo "done: $(ls "$DIR"/seg_*.m4s | wc -l | tr -d ' ') segments + init + manifest.json -> r2://$BUCKET/$EVENT_ID/ ($LOCATION)"
