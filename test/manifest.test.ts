import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	computeCacheMaxAge,
	computePhase,
	computeWindow,
	edgeCacheControl,
	formatCacheControl,
	formatSegmentPath,
	mediaPlaylistCacheBucket,
	renderMediaPlaylist,
} from "../src/manifest/index.js";
import {
	TEST_START,
	S,
	N,
	W,
	hasEndList,
	makeEvent,
	mediaSequence,
	parseSegmentIndices,
	windowInput,
} from "./helpers.js";

const EPS = 0.001;

describe("computePhase", () => {
	const base = { scheduledStart: TEST_START, segmentDuration: S, totalSegments: N, replayMode: "none" as const };

	it("returns pre_start before scheduled start", () => {
		expect(computePhase({ ...base, now: TEST_START - 1 })).toBe("pre_start");
	});

	it("returns live during the event", () => {
		expect(computePhase({ ...base, now: TEST_START })).toBe("live");
		expect(computePhase({ ...base, now: TEST_START + N * S - EPS })).toBe("live");
	});

	it("returns ended after total duration", () => {
		expect(computePhase({ ...base, now: TEST_START + N * S })).toBe("ended");
	});

	it("never ends in loop mode", () => {
		expect(computePhase({ ...base, replayMode: "loop", now: TEST_START + N * S * 3 })).toBe("live");
	});
});

describe("computeWindow — live-edge mode", () => {
	const event = makeEvent({ joinFromStart: false });

	it("PRE_START: holding playlist with zero segments, no ENDLIST", () => {
		const w = computeWindow(windowInput(event, TEST_START - 60));
		expect(w.phase).toBe("pre_start");
		expect(w.windowEnd).toBe(-1);
		expect(w.mediaSequence).toBe(0);

		const playlist = renderMediaPlaylist({
			event,
			track: event.video[0],
			window: w,
		});
		expect(parseSegmentIndices(playlist)).toEqual([]);
		expect(hasEndList(playlist)).toBe(false);
		expect(playlist).toContain("#EXT-X-MEDIA-SEQUENCE:0");
		expect(playlist).toContain("#EXT-X-MAP:");
	});

	it("first segment boundary: elapsed=0 and elapsed=S-ε → liveEdgeIndex=0, window [0..0]", () => {
		for (const now of [TEST_START, TEST_START + S - EPS]) {
			const w = computeWindow(windowInput(event, now));
			expect(w.liveEdgeIndex).toBe(0);
			expect(w.windowStart).toBe(0);
			expect(w.windowEnd).toBe(0);
			expect(w.mediaSequence).toBe(0);
			expect(parseSegmentIndices(renderMediaPlaylist({ event, track: event.video[0], window: w }))).toEqual([0]);
		}
	});

	it("mid-event: window is exactly W segments, MEDIA-SEQUENCE == liveEdgeIndex - W + 1", () => {
		const now = TEST_START + 5 * S; // liveEdgeIndex = 5
		const w = computeWindow(windowInput(event, now));
		expect(w.liveEdgeIndex).toBe(5);
		expect(w.windowStart).toBe(0); // 5 - 6 + 1 = 0
		expect(w.windowEnd - w.windowStart + 1).toBe(6);
		expect(w.mediaSequence).toBe(w.liveEdgeIndex - W + 1);

		const now2 = TEST_START + 7 * S; // liveEdgeIndex = 7
		const w2 = computeWindow(windowInput(event, now2));
		expect(w2.windowEnd - w2.windowStart + 1).toBe(W);
		expect(w2.mediaSequence).toBe(w2.liveEdgeIndex - W + 1);
		expect(mediaSequence(renderMediaPlaylist({ event, track: event.video[0], window: w2 }))).toBe(2);
		expect(renderMediaPlaylist({ event, track: event.video[0], window: w2 })).toContain(
			"#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES",
		);
	});

	it("early event: fewer than W segments aired clamps at 0, length < W", () => {
		const now = TEST_START + 2 * S; // liveEdgeIndex = 2
		const w = computeWindow(windowInput(event, now));
		expect(w.windowStart).toBe(0);
		expect(w.mediaSequence).toBe(0);
		expect(w.windowEnd - w.windowStart + 1).toBe(3);
	});

	it("exact segment boundaries: elapsed=k*S → liveEdgeIndex=k", () => {
		for (let k = 0; k < N; k++) {
			const w = computeWindow(windowInput(event, TEST_START + k * S));
			expect(w.liveEdgeIndex).toBe(k);
		}
	});

	it("final segment: ENDLIST when liveEdgeIndex == N-1, never index >= N", () => {
		const w = computeWindow(windowInput(event, TEST_START + (N - 1) * S));
		expect(w.liveEdgeIndex).toBe(N - 1);
		expect(w.endList).toBe(true);
		const indices = parseSegmentIndices(renderMediaPlaylist({ event, track: event.video[0], window: w }));
		expect(indices.every((i) => i < N)).toBe(true);
		const endedPlaylist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		expect(hasEndList(endedPlaylist)).toBe(true);
		expect(endedPlaylist).not.toContain("#EXT-X-START:");
	});

	it("ENDED/none: empty playlist — stream finished, no replay", () => {
		const w = computeWindow(windowInput(event, TEST_START + N * S + 100));
		expect(w.phase).toBe("ended");
		expect(w.windowEnd).toBe(-1);
		expect(w.endList).toBe(true);
		expect(parseSegmentIndices(renderMediaPlaylist({ event, track: event.video[0], window: w }))).toEqual([]);
	});
});

describe("computeWindow — from-start mode", () => {
	const event = makeEvent({ joinFromStart: true });

	it("PRE_START holding playlist", () => {
		const w = computeWindow(windowInput(event, TEST_START - 1));
		expect(w.phase).toBe("pre_start");
		expect(parseSegmentIndices(renderMediaPlaylist({ event, track: event.video[0], window: w }))).toEqual([]);
	});

	it("grows from segment 0 with EVENT type and MEDIA-SEQUENCE 0", () => {
		const w = computeWindow(windowInput(event, TEST_START + 3 * S));
		expect(w.playlistType).toBe("EVENT");
		expect(w.mediaSequence).toBe(0);
		expect(w.windowStart).toBe(0);
		expect(w.windowEnd).toBe(3);
		const playlist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
		expect(parseSegmentIndices(playlist)).toEqual([0, 1, 2, 3]);
	});

	it("final segment emits ENDLIST", () => {
		const w = computeWindow(windowInput(event, TEST_START + (N - 1) * S));
		expect(hasEndList(renderMediaPlaylist({ event, track: event.video[0], window: w }))).toBe(true);
	});

	it("ENDED/vod: full [0..N-1], VOD type, ENDLIST", () => {
		const vodEvent = makeEvent({ joinFromStart: true, replayMode: "vod" });
		const w = computeWindow(windowInput(vodEvent, TEST_START + N * S));
		expect(w.playlistType).toBe("VOD");
		expect(w.windowStart).toBe(0);
		expect(w.windowEnd).toBe(N - 1);
		const playlist = renderMediaPlaylist({ event: vodEvent, track: vodEvent.video[0], window: w });
		expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
		expect(parseSegmentIndices(playlist).length).toBe(N);
		expect(hasEndList(playlist)).toBe(true);
	});
});

describe("computeWindow — loop mode", () => {
	const event = makeEvent({ replayMode: "loop" });

	it("wraps liveEdgeIndex via modulo but keeps MEDIA-SEQUENCE monotonic", () => {
		const w = computeWindow(windowInput(event, TEST_START + N * S + 2 * S));
		expect(w.liveEdgeIndex).toBe(2);
		expect(w.phase).toBe("live");
		expect(w.windowEnd).toBe(N + 2);
		expect(w.mediaSequence).toBe(N + 2 - W + 1);
	});

	it("never emits ENDLIST", () => {
		const w = computeWindow(windowInput(event, TEST_START + (N - 1) * S));
		expect(w.endList).toBe(false);
		expect(hasEndList(renderMediaPlaylist({ event, track: event.video[0], window: w }))).toBe(false);
	});

	it("crosses the seam with a discontinuity and wrapped file indices", () => {
		// absoluteEdge = 11 → window [6..11] → files 6..9 then 0, 1 after the seam
		const w = computeWindow(windowInput(event, TEST_START + 11 * S));
		expect(w.windowStart).toBe(6);
		expect(w.mediaSequence).toBe(6);
		expect(w.discontinuitySequence).toBe(0);

		const playlist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		expect(parseSegmentIndices(playlist)).toEqual([6, 7, 8, 9, 0, 1]);

		const lines = playlist.split("\n");
		const discIdx = lines.indexOf("#EXT-X-DISCONTINUITY");
		expect(discIdx).toBeGreaterThan(-1);
		// Seam order: DISCONTINUITY, PROGRAM-DATE-TIME, EXTINF, wrapped seg 0.
		expect(lines[discIdx + 1]).toContain("#EXT-X-PROGRAM-DATE-TIME:");
		expect(lines[discIdx + 3]).toContain("seg_00000.m4s");
	});

	it("increments DISCONTINUITY-SEQUENCE once the seam rolls out of the window", () => {
		// absoluteEdge = 15 → window [10..15] → files 0..5, seam fully before window
		const w = computeWindow(windowInput(event, TEST_START + 15 * S));
		expect(w.windowStart).toBe(10);
		expect(w.discontinuitySequence).toBe(1);

		const playlist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		const lines = playlist.split("\n");
		expect(lines).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1");
		expect(lines).not.toContain("#EXT-X-DISCONTINUITY");
		expect(parseSegmentIndices(playlist)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("MEDIA-SEQUENCE never decreases across three full cycles", () => {
		let prev = -1;
		for (let k = 0; k < 3 * N; k++) {
			const w = computeWindow(windowInput(event, TEST_START + k * S));
			expect(w.mediaSequence).toBeGreaterThanOrEqual(prev);
			prev = w.mediaSequence;
		}
	});
});

describe("program date time", () => {
	it("stamps the window start with wall-clock time", () => {
		const event = makeEvent();
		const w = computeWindow(windowInput(event, TEST_START + 7 * S));
		const playlist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		const expected = new Date((TEST_START + w.windowStart * S) * 1000).toISOString();
		expect(playlist).toContain(`#EXT-X-PROGRAM-DATE-TIME:${expected}`);
	});

	it("omits the tag when the playlist has no segments", () => {
		const event = makeEvent();
		const w = computeWindow(windowInput(event, TEST_START - 60));
		expect(renderMediaPlaylist({ event, track: event.video[0], window: w })).not.toContain(
			"#EXT-X-PROGRAM-DATE-TIME",
		);
	});
});

describe("audio/video parity", () => {
	it("identical window indices for video and audio tracks", () => {
		const event = makeEvent();
		const now = TEST_START + 5 * S + 1.5;
		const w = computeWindow(windowInput(event, now));

		const videoPlaylist = renderMediaPlaylist({ event, track: event.video[0], window: w });
		const audioPlaylist = renderMediaPlaylist({ event, track: event.audio[0], window: w });

		expect(mediaSequence(videoPlaylist)).toBe(mediaSequence(audioPlaylist));
		expect(parseSegmentIndices(videoPlaylist)).toEqual(parseSegmentIndices(audioPlaylist));
	});
});

describe("computeCacheMaxAge", () => {
	const base = {
		scheduledStart: TEST_START,
		segmentDuration: S,
		totalSegments: N,
		replayMode: "none" as const,
	};

	it("PRE_START uses no-store", () => {
		expect(formatCacheControl(computeCacheMaxAge({ ...base, now: TEST_START - 10, phase: "pre_start" }))).toBe(
			"no-store",
		);
	});

	it("LIVE uses no-store", () => {
		expect(formatCacheControl(computeCacheMaxAge({ ...base, now: TEST_START + 5, phase: "live" }))).toBe(
			"no-store",
		);
	});

	it("ENDED/vod uses long immutable cache", () => {
		const result = computeCacheMaxAge({
			...base,
			replayMode: "vod",
			now: TEST_START + N * S,
			phase: "ended",
		});
		expect(result.maxAge).toBe(3600);
		expect(result.immutable).toBe(true);
	});
});

describe("mediaPlaylistCacheBucket", () => {
	it("advances per segment boundary while live", () => {
		expect(mediaPlaylistCacheBucket(TEST_START + 0.5 * S, TEST_START, S, N, "none")).toBe(0);
		expect(mediaPlaylistCacheBucket(TEST_START + 5 * S, TEST_START, S, N, "none")).toBe(5);
	});

	it("clamps after the event ends so ENDED playlists share one key", () => {
		expect(mediaPlaylistCacheBucket(TEST_START + 100 * N * S, TEST_START, S, N, "vod")).toBe(N);
	});

	it("keeps advancing in loop mode", () => {
		expect(mediaPlaylistCacheBucket(TEST_START + (N + 3) * S, TEST_START, S, N, "loop")).toBe(N + 3);
	});
});

describe("edgeCacheControl", () => {
	it("gives live manifests a short shared TTL (cache.put rejects no-store)", () => {
		expect(edgeCacheControl("live", "none", 4)).toBe("public, max-age=4");
	});

	it("gives ended vod a long immutable TTL", () => {
		expect(edgeCacheControl("ended", "vod", 4)).toBe("public, max-age=3600, immutable");
	});

	it("stays no-store when there is nothing worth caching", () => {
		expect(edgeCacheControl("ended", "none", 4)).toBe("no-store");
	});
});

describe("formatSegmentPath", () => {
	it("zero-pads segment index", () => {
		expect(formatSegmentPath("video/1080p/seg_%05d.m4s", 42)).toBe("video/1080p/seg_00042.m4s");
	});
});
