#!/usr/bin/env node
/**
 * Normalize Shaka Streamer HLS output into the Worker's CDN layout (0-based
 * seg_%05d.m4s names) and emit a KV event record (kv-record.json).
 *
 * usage:
 *   node prep/build-kv-record.mjs --dir prep/out/demo --slug demo \
 *     --segment-duration 4 [--worker-port 8787] [--start-in-seconds 0]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const opts = {
		dir: "",
		slug: "demo",
		segmentDuration: 4,
		workerPort: 8787,
		storageBaseUrl: "",
		startInSeconds: 0,
		scheduledStart: 0,
		windowSize: 6,
		replayMode: "none",
		joinFromStart: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dir") opts.dir = argv[++i];
		else if (arg === "--slug") opts.slug = argv[++i];
		else if (arg === "--segment-duration") opts.segmentDuration = Number(argv[++i]);
		else if (arg === "--worker-port") opts.workerPort = Number(argv[++i]);
		else if (arg === "--storage-base-url") opts.storageBaseUrl = argv[++i];
		else if (arg === "--cdn-port") opts.workerPort = Number(argv[++i]);
		else if (arg === "--start-in-seconds") opts.startInSeconds = Number(argv[++i]);
		else if (arg === "--scheduled-start") opts.scheduledStart = Number(argv[++i]);
		else if (arg === "--window-size") opts.windowSize = Number(argv[++i]);
		else if (arg === "--replay-mode") opts.replayMode = argv[++i];
		else if (arg === "--join-from-start") opts.joinFromStart = true;
		else if (arg === "--start-now") opts.startInSeconds = -60;
	}
	if (!opts.dir) {
		console.error("missing --dir");
		process.exit(1);
	}
	return opts;
}

function parseMaster(masterPath) {
	const text = readFileSync(masterPath, "utf8");
	const lines = text.split("\n").map((l) => l.trim());

	const audio = [];
	const video = [];
	let pendingStreamInf = null;

	for (const line of lines) {
		if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
			const uri = line.match(/URI="([^"]+)"/)?.[1];
			const group = line.match(/GROUP-ID="([^"]+)"/)?.[1] ?? "aud";
			const name = line.match(/NAME="([^"]+)"/)?.[1] ?? "Audio";
			const channels = Number(line.match(/CHANNELS="(\d+)"/)?.[1] ?? 2);
			const isDefault = /DEFAULT=YES/.test(line);
			if (uri) audio.push({ playlist: uri, group, name, channels, default: isDefault });
		} else if (line.startsWith("#EXT-X-STREAM-INF:")) {
			pendingStreamInf = {
				bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0),
				avgBandwidth: Number(line.match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1] ?? 0),
				codecs: line.match(/CODECS="([^"]+)"/)?.[1]?.split(",")[0] ?? "avc1.64001f",
				resolution: line.match(/RESOLUTION=(\d+x\d+)/)?.[1] ?? "1280x720",
				frameRate: Number(line.match(/FRAME-RATE=([\d.]+)/)?.[1] ?? 24),
				audioGroup: line.match(/AUDIO="([^"]+)"/)?.[1] ?? "aac",
			};
		} else if (pendingStreamInf && line && !line.startsWith("#")) {
			video.push({ ...pendingStreamInf, playlist: line });
			pendingStreamInf = null;
		}
	}

	return { audio, video };
}

function parseMediaPlaylist(path) {
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n").map((l) => l.trim());
	let initPath = "";
	const segments = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("#EXT-X-MAP:")) {
			initPath = line.match(/URI="([^"]+)"/)?.[1] ?? "";
		} else if (line.startsWith("#EXTINF:") && i + 1 < lines.length) {
			const uri = lines[i + 1];
			if (uri && !uri.startsWith("#")) segments.push(uri);
		}
	}
	return { initPath, segments };
}

function renditionHeight(resolution) {
	return Number(resolution.split("x")[1] ?? 0);
}

function renditionLabel(resolution) {
	const h = renditionHeight(resolution);
	if (h >= 2160) return "2160p";
	if (h >= 1440) return "1440p";
	if (h >= 1080) return "1080p";
	if (h >= 720) return "720p";
	if (h >= 480) return "480p";
	if (h >= 360) return "360p";
	return "240p";
}

function audioTrackName(baseName, channels) {
	if (channels >= 6) return `${baseName} 5.1`;
	if (channels === 1) return `${baseName} Mono`;
	return `${baseName} Stereo`;
}

function audioCdnLabel(group) {
	if (group === "aac" || group === "stereo" || group === "mono") return "aac";
	if (group === "eac3" || group === "surround") return "eac3";
	return group;
}

function uniqueRenditionName(resolution, used) {
	const base = renditionLabel(resolution);
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	const fallback = `${base}_${resolution}`;
	used.add(fallback);
	return fallback;
}

function sortVideoByHeightDesc(tracks) {
	return [...tracks].sort((a, b) => renditionHeight(b.resolution) - renditionHeight(a.resolution));
}

function normalizeTrack(opts) {
	const { shakaDir, cdnDir, kind, label, initSrc, segmentSrcs } = opts;
	const base = kind === "video" ? `video/${label}` : `audio/${label}`;
	const outBase = join(cdnDir, base);
	mkdirSync(outBase, { recursive: true });

	copyFileSync(join(shakaDir, initSrc), join(outBase, "init.mp4"));
	const segmentPattern = `${base}/seg_%05d.m4s`;
	for (let i = 0; i < segmentSrcs.length; i++) {
		const src = segmentSrcs[i];
		const dest = join(outBase, `seg_${String(i).padStart(5, "0")}.m4s`);
		copyFileSync(join(shakaDir, src), dest);
	}
	return {
		initPath: `${base}/init.mp4`,
		segmentPattern,
		segmentCount: segmentSrcs.length,
	};
}

const opts = parseArgs(process.argv);
const shakaDir = opts.dir;
const masterPath = join(shakaDir, "hls.m3u8");
const cdnDir = join(shakaDir, "cdn");
mkdirSync(cdnDir, { recursive: true });

const master = parseMaster(masterPath);
if (master.video.length === 0) {
	console.error(`no video renditions found in ${masterPath}`);
	process.exit(1);
}

const videoRenditions = sortVideoByHeightDesc(master.video);
console.log(
	`video renditions: ${videoRenditions.map((v) => `${renditionLabel(v.resolution)} (${v.resolution})`).join(", ")}`,
);

// Highest resolution is the segment-count source of truth (all rungs must match).
const primaryVideo = videoRenditions[0];
const videoMedia = parseMediaPlaylist(join(shakaDir, primaryVideo.playlist));
const primaryLabel = renditionLabel(primaryVideo.resolution);
const videoNormByLabel = new Map();

function normalizeVideoRendition(track, label) {
	const media = parseMediaPlaylist(join(shakaDir, track.playlist));
	const segments = media.segments;
	if (segments.length !== videoMedia.segments.length) {
		console.warn(
			`warning: ${label} has ${segments.length} segments; expected ${videoMedia.segments.length} (using min length)`,
		);
	}
	const norm = normalizeTrack({
		shakaDir,
		cdnDir,
		kind: "video",
		label,
		initSrc: media.initPath,
		segmentSrcs: segments.slice(0, videoMedia.segments.length),
	});
	videoNormByLabel.set(label, norm);
	return norm;
}

const primaryNorm = normalizeVideoRendition(primaryVideo, primaryLabel);
const totalSegments = primaryNorm.segmentCount;
const scheduledStart = Number.isFinite(opts.scheduledStart) && opts.scheduledStart > 0
	? Math.floor(opts.scheduledStart)
	: Math.floor(Date.now() / 1000) + opts.startInSeconds;

const audioOut = [];
const seenAudioPlaylists = new Set();
for (const track of master.audio) {
	if (seenAudioPlaylists.has(track.playlist)) continue;
	seenAudioPlaylists.add(track.playlist);

	const media = parseMediaPlaylist(join(shakaDir, track.playlist));
	const label = audioCdnLabel(track.group);
	const segments = media.segments.slice(0, totalSegments);
	if (segments.length < totalSegments) {
		console.warn(
			`warning: audio track "${track.name}" has ${media.segments.length} segments; truncating/padding to ${totalSegments} using video count`,
		);
	}
	const norm = normalizeTrack({
		shakaDir,
		cdnDir,
		kind: "audio",
		label,
		initSrc: media.initPath,
		segmentSrcs: segments,
	});
	const audioCodec = label === "aac" ? "mp4a.40.2" : "ec-3";
	const baseName = track.name === "und" ? "English" : track.name;
	const uniqueName = audioTrackName(baseName, track.channels);
	audioOut.push({
		group: "aud",
		name: uniqueName,
		language: "en",
		codecs: audioCodec,
		channels: track.channels,
		default: track.default && track.channels <= 2,
		bandwidth: label === "aac" ? 128_000 : 384_000,
		initPath: norm.initPath,
		segmentPattern: norm.segmentPattern,
	});
}

if (audioOut.length === 0) {
	console.error("no audio tracks found — source must include an audio track");
	process.exit(1);
}
if (!audioOut.some((a) => a.default)) {
	const stereo = audioOut.find((a) => a.channels <= 2) ?? audioOut[0];
	stereo.default = true;
}

const storageBaseUrl =
	opts.storageBaseUrl || `http://localhost:${opts.workerPort}/v1/assets/${opts.slug}`;
const defaultAudio = audioOut.find((a) => a.default) ?? audioOut[0];

const usedVideoNames = new Set();
const videoOut = videoRenditions.map((track) => {
	const name = uniqueRenditionName(track.resolution, usedVideoNames);
	if (!videoNormByLabel.has(name)) {
		normalizeVideoRendition(track, name);
	}
	const norm = videoNormByLabel.get(name);
	return {
		name,
		bandwidth: track.bandwidth + defaultAudio.bandwidth,
		avgBandwidth: track.avgBandwidth + defaultAudio.bandwidth,
		codecs: track.codecs,
		resolution: track.resolution,
		frameRate: track.frameRate,
		initPath: norm.initPath,
		segmentPattern: norm.segmentPattern,
		audioGroup: "aud",
	};
});

const record = {
	eventId: `evt_${opts.slug}`,
	slug: opts.slug,
	scheduledStart,
	segmentDuration: opts.segmentDuration,
	totalSegments,
	durationSeconds: totalSegments * opts.segmentDuration,
	windowSize: opts.windowSize,
	joinFromStart: opts.joinFromStart,
	replayMode: opts.replayMode,
	gate: "open",
	storageBaseUrl,
	video: videoOut,
	audio: audioOut,
};

const outPath = join(shakaDir, "kv-record.json");
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`normalized CDN assets -> ${cdnDir}`);
console.log(`segments: ${totalSegments} x ${opts.segmentDuration}s`);
console.log(`scheduledStart: ${scheduledStart} (${opts.startInSeconds >= 0 ? "starts in " + opts.startInSeconds + "s" : "already live"})`);
