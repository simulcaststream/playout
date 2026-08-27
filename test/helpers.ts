import type { EventRecord } from "../src/manifest/types.js";

/** Shared test event: 10 segments × 4s = 40s total, W=6. */
export const TEST_START = 1_000_000;
export const S = 4;
export const N = 10;
export const W = 6;

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
	return {
		eventId: "evt_test",
		slug: "test-event",
		scheduledStart: TEST_START,
		segmentDuration: S,
		totalSegments: N,
		durationSeconds: N * S,
		windowSize: W,
		joinFromStart: false,
		replayMode: "none",
		gate: "open",
		storageBaseUrl: "https://cdn.example.b-cdn.net/assets/abc123",
		video: [
			{
				name: "1080p",
				bandwidth: 5_478_000,
				avgBandwidth: 5_128_000,
				codecs: "avc1.640028",
				resolution: "1920x1080",
				frameRate: 24,
				initPath: "video/1080p/init.mp4",
				segmentPattern: "video/1080p/seg_%05d.m4s",
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
			{
				group: "aud",
				name: "English 5.1",
				language: "en",
				codecs: "ec-3",
				channels: 6,
				default: false,
				bandwidth: 384_000,
				initPath: "audio/eac3/init.mp4",
				segmentPattern: "audio/eac3/seg_%05d.m4s",
			},
		],
		...overrides,
	};
}

export function windowInput(event: EventRecord, now: number) {
	return {
		now,
		scheduledStart: event.scheduledStart,
		segmentDuration: event.segmentDuration,
		totalSegments: event.totalSegments,
		windowSize: event.windowSize,
		joinFromStart: event.joinFromStart,
		replayMode: event.replayMode,
	};
}

export function parseSegmentIndices(playlist: string): number[] {
	const indices: number[] = [];
	const lines = playlist.split("\n");
	for (const line of lines) {
		const match = line.match(/seg_(\d+)\.m4s/);
		if (match) indices.push(Number(match[1]));
	}
	return indices;
}

export function hasEndList(playlist: string): boolean {
	return playlist.includes("#EXT-X-ENDLIST");
}

export function mediaSequence(playlist: string): number {
	const match = playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
	return match ? Number(match[1]) : -1;
}
