#!/usr/bin/env bash
# Pack a source file with Shaka Streamer (ABR fMP4 HLS) for the desktop app.
# Normalizes output under <outdir>/cdn/ via build-kv-record.mjs (called by the app).
#
# usage: prep/pack-shaka.sh <input-video> <outdir> [segment_seconds=4]
# env:   SHAKA_BIN — path to shaka-streamer (optional; auto-detected)
# env:   PACK_* — set by desktop app for source-matched ladder (optional)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREP_ROOT="${PREP_ROOT:-$SCRIPT_DIR}"
TOOL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT=${1:?usage: prep/pack-shaka.sh <input-video> <outdir> [segment_seconds]}
OUTDIR=${2:?usage: prep/pack-shaka.sh <input-video> <outdir> [segment_seconds]}
SEG_DUR=${3:-4}

resolve_shaka() {
  if [ -n "${SHAKA_BIN:-}" ] && [ -x "$SHAKA_BIN" ]; then
    echo "$SHAKA_BIN"
    return
  fi
  for candidate in \
    "$TOOL_ROOT/python/bin/shaka-streamer" \
    "$TOOL_ROOT/shaka-venv/bin/shaka-streamer" \
    "$TOOL_ROOT/.venv/bin/shaka-streamer"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  echo "Shaka Streamer not found. Run: pnpm build:shaka-venv" >&2
  echo "  or set SHAKA_BIN to shaka-streamer executable" >&2
  exit 1
}

write_resolutions() {
  local IFS=','
  for r in $1; do
    echo "  - $r"
  done
}

write_list() {
  local IFS=','
  for item in $1; do
    echo "  - $item"
  done
}

write_pipeline() {
  local pipe="$1"
  if [ -n "${PACK_VIDEO_CODEC:-}" ]; then
    cat > "$pipe" <<EOF
# Generated for source-matched ladder (desktop packer).
streaming_mode: vod

resolutions:
$(write_resolutions "$PACK_RESOLUTIONS")

channel_layouts:
$(write_list "$PACK_AUDIO_LAYOUTS")

audio_codecs:
$(write_list "$PACK_AUDIO_CODECS")

video_codecs:
  - ${PACK_VIDEO_CODEC}

manifest_format:
  - hls

segment_size: ${SEG_DUR}
segment_per_file: true

segment_folder: ""
EOF
    return
  fi

  sed "s/^segment_size: .*/segment_size: ${SEG_DUR}/" "$PREP_ROOT/shaka/pipeline.yaml" > "$pipe"
  if [ "$(uname -s)" = Darwin ]; then
    awk '{ if ($0 == "  - h264") print "  - hw:h264"; else print }' "$pipe" > "$pipe.hw" \
      && mv "$pipe.hw" "$pipe"
  fi
}

SHAKA="$(resolve_shaka)"

if [ ! -f "$INPUT" ]; then
  echo "input file not found: $INPUT" >&2
  exit 1
fi

INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

PIPELINE_TMP="$OUTDIR/.pipeline.yaml"
write_pipeline "$PIPELINE_TMP"
sed "s|INPUT_FILE_PLACEHOLDER|${INPUT_ABS}|g" "$PREP_ROOT/shaka/input.yaml" > "$OUTDIR/.input.yaml"

echo "Packaging with Shaka Streamer ($SHAKA) -> $OUTDIR"
"$SHAKA" -i "$OUTDIR/.input.yaml" -p "$PIPELINE_TMP" -o "$OUTDIR"

echo "Shaka pack complete ($(find "$OUTDIR/cdn" -name '*.m4s' 2>/dev/null | wc -l | tr -d ' ') segments)"
