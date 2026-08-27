import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeWindow, formatSegmentPath, renderMediaPlaylist } from "../src/manifest/index.js";
import { hasEndList, makeEvent, parseSegmentIndices, windowInput } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const oraclePath = join(__dirname, "fixtures/shaka-vod.m3u8");

function parseOraclePlaylist(content: string): { segments: string[]; hasEndList: boolean } {
	const segments: string[] = [];
	for (const line of content.split("\n")) {
		if (line && !line.startsWith("#")) segments.push(line.trim());
	}
	return { segments, hasEndList: content.includes("#EXT-X-ENDLIST") };
}

describe("oracle: ENDED vod matches Shaka VOD structure", () => {
	const oracle = parseOraclePlaylist(readFileSync(oraclePath, "utf8"));
	const oracleSegmentCount = oracle.segments.length;

	const event = makeEvent({
		replayMode: "vod",
		totalSegments: oracleSegmentCount,
		durationSeconds: oracleSegmentCount * 4,
		segmentDuration: 4,
		windowSize: 6,
		video: [
			{
				name: "1080p",
				bandwidth: 5_478_000,
				avgBandwidth: 5_128_000,
				codecs: "avc1.640028",
				resolution: "1920x1080",
				frameRate: 24,
				initPath: "video/init.mp4",
				segmentPattern: "video/seg_%05d.m4s",
				audioGroup: "aud",
			},
		],
	});

	it("produces the same segment count, order, and ENDLIST as the oracle VOD playlist", () => {
		const now = event.scheduledStart + event.totalSegments * event.segmentDuration + 60;
		const w = computeWindow(windowInput(event, now));
		expect(w.playlistType).toBe("VOD");

		const workerPlaylist = renderMediaPlaylist({
			event,
			track: event.video[0],
			window: w,
		});

		const workerSegments = parseSegmentIndices(workerPlaylist).map((i) =>
			formatSegmentPath("video/seg_%05d.m4s", i),
		);

		expect(workerSegments.length).toBe(oracle.segments.length);
		expect(workerSegments).toEqual(oracle.segments);
		expect(hasEndList(workerPlaylist)).toBe(oracle.hasEndList);
		expect(workerPlaylist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
		expect(workerPlaylist).toContain("#EXT-X-MEDIA-SEQUENCE:0");
	});
});
