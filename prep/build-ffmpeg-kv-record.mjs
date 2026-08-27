#!/usr/bin/env node
/**
 * Build KV EventRecord from prep/pack-ffmpeg.sh output.
 *
 * usage:
 *   node prep/build-ffmpeg-kv-record.mjs --dir prep/out/my-slug --slug my-slug \
 *     --storage-base-url https://worker.example/v1/assets/my-slug \
 *     [--segment-duration 4] [--replay-mode loop] [--start-now]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
	const opts = {
		dir: "",
		slug: "",
		segmentDuration: 4,
		storageBaseUrl: "",
		windowSize: 6,
		replayMode: "loop",
		startNow: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dir") opts.dir = argv[++i];
		else if (arg === "--slug") opts.slug = argv[++i];
		else if (arg === "--segment-duration") opts.segmentDuration = Number(argv[++i]);
		else if (arg === "--storage-base-url") opts.storageBaseUrl = argv[++i];
		else if (arg === "--window-size") opts.windowSize = Number(argv[++i]);
		else if (arg === "--replay-mode") opts.replayMode = argv[++i];
		else if (arg === "--start-now") opts.startNow = true;
	}
	if (!opts.dir || !opts.slug || !opts.storageBaseUrl) {
		console.error("usage: --dir <outdir> --slug <slug> --storage-base-url <url> [--start-now]");
		process.exit(1);
	}
	return opts;
}

function countSegments(dir) {
	const files = readFileSync(join(dir, "source.m3u8"), "utf8");
	return (files.match(/\.m4s/g) ?? []).length;
}

const opts = parseArgs(process.argv);
const videoDir = join(opts.dir, "cdn/video/720p");
const audioDir = join(opts.dir, "cdn/audio/aac");
const totalSegments = countSegments(videoDir);
const scheduledStart = opts.startNow
	? Math.floor(Date.now() / 1000) - 60
	: Math.floor(Date.now() / 1000);

const record = {
	eventId: `evt_${opts.slug}`,
	slug: opts.slug,
	scheduledStart,
	segmentDuration: opts.segmentDuration,
	totalSegments,
	durationSeconds: totalSegments * opts.segmentDuration,
	windowSize: opts.windowSize,
	joinFromStart: false,
	replayMode: opts.replayMode,
	gate: "open",
	storageBaseUrl: opts.storageBaseUrl.replace(/\/$/, ""),
	video: [
		{
			name: "720p",
			bandwidth: 2_800_000,
			avgBandwidth: 2_500_000,
			codecs: "avc1.64001f",
			resolution: "1280x720",
			frameRate: 24,
			initPath: "video/720p/init.mp4",
			segmentPattern: "video/720p/seg_%05d.m4s",
			audioGroup: "aud",
		},
	],
	audio: [
		{
			group: "aud",
			name: "English Stereo",
			language: "en",
			codecs: "mp4a.40.2",
			channels: 2,
			default: true,
			bandwidth: 128_000,
			initPath: "audio/aac/init.mp4",
			segmentPattern: "audio/aac/seg_%05d.m4s",
		},
	],
};

const outPath = join(opts.dir, "kv-record.json");
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify({ outPath, totalSegments, scheduledStart, durationSeconds: record.durationSeconds }));
