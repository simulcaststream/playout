import { z } from "zod";

export const ReplayModeSchema = z.enum(["none", "vod", "loop"]);
export const GateSchema = z.enum(["open", "email", "paid"]);

export const VideoRenditionSchema = z.object({
	name: z.string(),
	bandwidth: z.number().int().positive(),
	avgBandwidth: z.number().int().positive(),
	codecs: z.string(),
	resolution: z.string(),
	frameRate: z.number(),
	initPath: z.string(),
	segmentPattern: z.string(),
	audioGroup: z.string(),
});

export const AudioTrackSchema = z.object({
	group: z.string(),
	name: z.string(),
	language: z.string(),
	codecs: z.string(),
	channels: z.number().int().positive(),
	default: z.boolean(),
	bandwidth: z.number().int().positive(),
	initPath: z.string(),
	segmentPattern: z.string(),
});

export const EventRecordSchema = z.object({
	eventId: z.string(),
	slug: z.string(),
	scheduledStart: z.number(), // epoch seconds, UTC
	segmentDuration: z.number().positive(),
	totalSegments: z.number().int().positive(),
	durationSeconds: z.number().positive(),
	windowSize: z.number().int().positive(),
	joinFromStart: z.boolean(),
	replayMode: ReplayModeSchema,
	gate: GateSchema,
	storageBaseUrl: z.string().url().refine((u) => !u.endsWith("/"), {
		message: "storageBaseUrl must not have a trailing slash",
	}),
	video: z.array(VideoRenditionSchema).min(1),
	audio: z.array(AudioTrackSchema).min(1),
});

export type ReplayMode = z.infer<typeof ReplayModeSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type VideoRendition = z.infer<typeof VideoRenditionSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;

export type Phase = "pre_start" | "live" | "ended";

export interface WindowResult {
	phase: Phase;
	/**
	 * Inclusive first segment index in the playlist, or 0 when empty.
	 * In loop mode indices are absolute (monotonic across cycles); the renderer
	 * maps them onto segment files via `wrapEvery`.
	 */
	windowStart: number;
	/** Inclusive last segment index, or -1 when the playlist has zero segments. */
	windowEnd: number;
	/** Value for #EXT-X-MEDIA-SEQUENCE. */
	mediaSequence: number;
	/** Newest segment currently available (-1 during PRE_START). Always a file index (< totalSegments). */
	liveEdgeIndex: number;
	playlistType?: "EVENT" | "VOD";
	endList: boolean;
	/** Loop mode: map absolute index → file index via `index % wrapEvery`. */
	wrapEvery?: number;
	/** Loop mode: #EXT-X-DISCONTINUITY-SEQUENCE (count of seams rolled out of the window). */
	discontinuitySequence?: number;
}

export interface MediaTrack {
	initPath: string;
	segmentPattern: string;
}

export interface MasterPlaylistUrls {
	video: Record<string, string>;
	audio: Record<string, string>;
}

export interface RenderMediaPlaylistOptions {
	event: Pick<EventRecord, "segmentDuration" | "storageBaseUrl" | "scheduledStart">;
	track: MediaTrack;
	window: WindowResult;
	signUrl?: (absoluteUrl: string) => string | Promise<string>;
}

export interface RenderMasterPlaylistOptions {
	event: EventRecord;
	workerUrls: MasterPlaylistUrls;
}
