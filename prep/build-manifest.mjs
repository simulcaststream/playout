#!/usr/bin/env node
// Parse the ffmpeg-generated VOD playlist into the worker's manifest.json:
// exact EXTINF durations, init segment, targetDuration (ceil of max), total.
//
// usage: node prep/build-manifest.mjs <segmented-dir> [nominal_segment_seconds=6]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const segmentDuration = Number(process.argv[3] ?? 6);
if (!dir) {
  console.error("usage: node prep/build-manifest.mjs <segmented-dir> [nominal_segment_seconds]");
  process.exit(1);
}

const playlist = readFileSync(join(dir, "source.m3u8"), "utf8");
const lines = playlist.split("\n").map((l) => l.trim());

let initSegment = "init.mp4";
const segments = [];
let pendingDuration = null;
for (const line of lines) {
  if (line.startsWith("#EXT-X-MAP:")) {
    const m = line.match(/URI="([^"]+)"/);
    if (m) initSegment = m[1];
  } else if (line.startsWith("#EXTINF:")) {
    pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]);
  } else if (line && !line.startsWith("#") && pendingDuration !== null) {
    segments.push({ uri: line, duration: pendingDuration });
    pendingDuration = null;
  }
}

if (segments.length === 0) {
  console.error(`no segments found in ${dir}/source.m3u8`);
  process.exit(1);
}

const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
const maxDuration = Math.max(...segments.map((s) => s.duration));

const manifest = {
  initSegment,
  segmentDuration,
  targetDuration: Math.ceil(maxDuration),
  totalDuration: Math.round(totalDuration * 1e6) / 1e6,
  segments,
};

const out = join(dir, "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `wrote ${out}: ${segments.length} segments, total ${totalDuration.toFixed(3)}s, targetDuration ${manifest.targetDuration}`
);
