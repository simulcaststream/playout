#!/usr/bin/env bash
# Segment a source video into CMAF/fMP4 HLS with fixed GOPs aligned to segment
# boundaries. Idempotent: re-running fully regenerates the output directory.
#
# usage: prep/segment.sh <input> <outdir> [segment_seconds=6]
set -euo pipefail

INPUT=${1:?usage: prep/segment.sh <input> <outdir> [segment_seconds]}
OUTDIR=${2:?usage: prep/segment.sh <input> <outdir> [segment_seconds]}
SEGDUR=${3:-6}

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

# Keyframes forced on exact segment boundaries and scene-cut keyframes disabled:
# every segment starts on an IDR frame and is independently decodable.
# Misaligned GOPs break seeking — non-negotiable.
ffmpeg -y -hide_banner -loglevel warning -i "$INPUT" \
  -map 0:v:0 -map '0:a:0?' \
  -c:v libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p \
  -force_key_frames "expr:gte(t,n_forced*${SEGDUR})" -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls \
  -hls_time "$SEGDUR" \
  -hls_playlist_type vod \
  -hls_segment_type fmp4 \
  -hls_flags independent_segments \
  -hls_list_size 0 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$OUTDIR/seg_%05d.m4s" \
  "$OUTDIR/source.m3u8"

echo "segmented -> $OUTDIR ($(ls "$OUTDIR" | grep -c '\.m4s$') segments)"
echo "next: node prep/build-manifest.mjs $OUTDIR $SEGDUR"
