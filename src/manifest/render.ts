import type {
	AudioTrack,
	EventRecord,
	MasterPlaylistUrls,
	RenderMasterPlaylistOptions,
	RenderMediaPlaylistOptions,
	VideoRendition,
} from "./types.js";

const HLS_VERSION = 7;

/** Replace %05d with a zero-padded 0-based segment index. */
export function formatSegmentPath(pattern: string, index: number): string {
	return pattern.replace("%05d", String(index).padStart(5, "0"));
}

export function buildStorageUrl(storageBaseUrl: string, relativePath: string): string {
	return `${storageBaseUrl}/${relativePath}`;
}

/** Map an absolute window index to a segment file index (loop mode wraps). */
function fileIndex(index: number, wrapEvery: number | undefined): number {
	return wrapEvery ? index % wrapEvery : index;
}

function programDateTime(scheduledStart: number, absoluteIndex: number, segmentDuration: number): string {
	return `#EXT-X-PROGRAM-DATE-TIME:${new Date((scheduledStart + absoluteIndex * segmentDuration) * 1000).toISOString()}`;
}

/** Every storage URL the playlist references, in order (init first). */
function collectPlaylistUrls(options: RenderMediaPlaylistOptions): string[] {
	const { event, track, window } = options;
	const urls = [buildStorageUrl(event.storageBaseUrl, track.initPath)];
	for (let i = window.windowStart; i <= window.windowEnd; i++) {
		urls.push(buildStorageUrl(event.storageBaseUrl, formatSegmentPath(track.segmentPattern, fileIndex(i, window.wrapEvery))));
	}
	return urls;
}

export function renderMediaPlaylist(options: RenderMediaPlaylistOptions): string {
	const { event, track, window, signUrl = (u) => u } = options;
	const sign = (url: string): string => {
		const signed = signUrl(url);
		if (typeof signed !== "string") {
			throw new Error("renderMediaPlaylist requires a synchronous signUrl; use renderMediaPlaylistAsync");
		}
		return signed;
	};

	const targetDuration = Math.ceil(event.segmentDuration);
	const lines: string[] = [
		"#EXTM3U",
		`#EXT-X-VERSION:${HLS_VERSION}`,
		`#EXT-X-TARGETDURATION:${targetDuration}`,
		`#EXT-X-MEDIA-SEQUENCE:${window.mediaSequence}`,
	];

	if (window.discontinuitySequence) {
		lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${window.discontinuitySequence}`);
	}

	if (window.playlistType) {
		lines.push(`#EXT-X-PLAYLIST-TYPE:${window.playlistType}`);
	}

	// Negative offset = start this many seconds before the live edge. JW Player
	// only paints the LIVE badge red when it believes it is at that edge.
	if (!window.endList && window.windowEnd >= window.windowStart) {
		lines.push("#EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES");
	}

	lines.push(`#EXT-X-MAP:URI="${sign(buildStorageUrl(event.storageBaseUrl, track.initPath))}"`);

	for (let i = window.windowStart; i <= window.windowEnd; i++) {
		// Loop seam: segment file timestamps jump back to 0, so declare a discontinuity.
		if (window.wrapEvery && i > window.windowStart && i % window.wrapEvery === 0) {
			lines.push("#EXT-X-DISCONTINUITY");
		}
		if (i === window.windowStart || (window.wrapEvery && i % window.wrapEvery === 0)) {
			lines.push(programDateTime(event.scheduledStart, i, event.segmentDuration));
		}
		lines.push(`#EXTINF:${event.segmentDuration.toFixed(3)},`);
		const segmentPath = formatSegmentPath(track.segmentPattern, fileIndex(i, window.wrapEvery));
		lines.push(sign(buildStorageUrl(event.storageBaseUrl, segmentPath)));
	}

	if (window.endList) {
		lines.push("#EXT-X-ENDLIST");
	}

	return lines.join("\n") + "\n";
}

/** Pre-signs all URLs in parallel, then renders synchronously (paid gate uses async signing). */
export async function renderMediaPlaylistAsync(options: RenderMediaPlaylistOptions): Promise<string> {
	const { signUrl = (u) => u } = options;
	const urls = [...new Set(collectPlaylistUrls(options))];
	const signed = new Map(await Promise.all(urls.map(async (u) => [u, await signUrl(u)] as const)));
	return renderMediaPlaylist({ ...options, signUrl: (u) => signed.get(u) ?? u });
}

function defaultAudioForGroup(event: EventRecord, groupId: string): AudioTrack | undefined {
	return event.audio.find((a) => a.group === groupId && a.default) ?? event.audio.find((a) => a.group === groupId);
}

function yesNo(value: boolean): string {
	return value ? "YES" : "NO";
}

function streamInfCodecs(video: VideoRendition, event: EventRecord): string {
	const audio = defaultAudioForGroup(event, video.audioGroup);
	const audioCodec = audio?.codecs ?? "";
	return audioCodec ? `${video.codecs},${audioCodec}` : video.codecs;
}

function uniqueMediaName(track: AudioTrack, tracks: AudioTrack[]): string {
	const same = tracks.filter((t) => t.group === track.group && t.name === track.name);
	if (same.length <= 1) return track.name;
	return `${track.name} (${track.channels}ch)`;
}

/** Same bytes => one EXT-X-MEDIA; duplicate NAME/URI pairs break hls.js. */
function dedupeAudioTracks(tracks: AudioTrack[]): AudioTrack[] {
	const byKey = new Map<string, AudioTrack>();
	for (const track of tracks) {
		const key = `${track.group}\0${track.initPath}\0${track.segmentPattern}`;
		const existing = byKey.get(key);
		if (!existing || track.default) byKey.set(key, track);
	}
	return [...byKey.values()];
}

export function renderMasterPlaylist(options: RenderMasterPlaylistOptions): string {
	const { event, workerUrls } = options;
	const lines: string[] = ["#EXTM3U", `#EXT-X-VERSION:${HLS_VERSION}`, "#EXT-X-INDEPENDENT-SEGMENTS"];
	const audioTracks = dedupeAudioTracks(event.audio);

	for (const track of audioTracks) {
		const uri = workerUrls.audio[track.name];
		if (!uri) continue;
		const name = uniqueMediaName(track, audioTracks);
		lines.push(
			[
				"#EXT-X-MEDIA:TYPE=AUDIO",
				`GROUP-ID="${track.group}"`,
				`NAME="${name}"`,
				`LANGUAGE="${track.language}"`,
				`DEFAULT=${yesNo(track.default)}`,
				"AUTOSELECT=YES",
				`CHANNELS="${track.channels}"`,
				`URI="${uri}"`,
			].join(","),
		);
	}

	for (const video of event.video) {
		const uri = workerUrls.video[video.name];
		if (!uri) continue;
		lines.push(
			[
				`#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth}`,
				`AVERAGE-BANDWIDTH=${video.avgBandwidth}`,
				`CODECS="${streamInfCodecs(video, event)}"`,
				`RESOLUTION=${video.resolution}`,
				`FRAME-RATE=${video.frameRate}`,
				`AUDIO="${video.audioGroup}"`,
			].join(","),
		);
		lines.push(uri);
	}

	return lines.join("\n") + "\n";
}

/** URL-safe path segment for an audio track name. */
export function audioTrackPathSegment(name: string): string {
	return encodeURIComponent(name);
}
