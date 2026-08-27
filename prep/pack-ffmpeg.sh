#!/usr/bin/env bash
# Pack a single 720p CMAF HLS ladder for the desktop app (no Shaka).
#
# usage: prep/pack-ffmpeg.sh <input.mp4> <outdir> [segment_seconds=4]
set -euo pipefail

INPUT=${1:?usage: prep/pack-ffmpeg.sh <input.mp4> <outdir> [segment_seconds]}
OUTDIR=${2:?usage: prep/pack-ffmpeg.sh <input.mp4> <outdir> [segment_seconds]}
SEGDUR=${3:-4}

VIDEO_DIR="$OUTDIR/cdn/video/720p"
AUDIO_DIR="$OUTDIR/cdn/audio/aac"
rm -rf "$OUTDIR"
mkdir -p "$VIDEO_DIR" "$AUDIO_DIR"

# Video ladder
ffmpeg -y -hide_banner -loglevel warning -i "$INPUT" \
  -map 0:v:0 \
  -c:v libx264 -preset medium -crf 22 -profile:v high -pix_fmt yuv420p \
  -vf "scale=-2:720" \
  -force_key_frames "expr:gte(t,n_forced*${SEGDUR})" -sc_threshold 0 \
  -f hls \
  -hls_time "$SEGDUR" \
  -hls_playlist_type vod \
  -hls_segment_type fmp4 \
  -hls_flags independent_segments \
  -hls_list_size 0 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$VIDEO_DIR/seg_%05d.m4s" \
  "$VIDEO_DIR/source.m3u8"

# Audio track (same segment count as video)
ffmpeg -y -hide_banner -loglevel warning -i "$INPUT" \
  -map '0:a:0?' \
  -c:a aac -b:a 128k -ac 2 \
  -f hls \
  -hls_time "$SEGDUR" \
  -hls_playlist_type vod \
  -hls_segment_type fmp4 \
  -hls_flags independent_segments \
  -hls_list_size 0 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$AUDIO_DIR/seg_%05d.m4s" \
  "$AUDIO_DIR/source.m3u8"

SEG_COUNT=$(ls "$VIDEO_DIR"/*.m4s 2>/dev/null | wc -l | tr -d ' ')
echo "packed -> $OUTDIR ($SEG_COUNT segments x ${SEGDUR}s)"
