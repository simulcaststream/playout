import {
	audioTrackPathSegment,
	cdnUrlExpiry,
	computeCacheMaxAge,
	computeWindow,
	edgeCacheControl,
	formatCacheControl,
	mediaPlaylistCacheBucket,
	renderMasterPlaylist,
	renderMediaPlaylistAsync,
	signCdnUrl,
	type EventRecord,
	type MasterPlaylistUrls,
	type WindowResult,
} from "../manifest/index.js";
import { signAssetUrl } from "./asset-sign.js";

const HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const CACHE_ORIGIN = "https://manifest-cache.internal";

export function workerBaseUrl(requestUrl: string): string {
	const url = new URL(requestUrl);
	return `${url.protocol}//${url.host}`;
}

export function preserveAuthQuery(requestUrl: string): string {
	const url = new URL(requestUrl);
	const params = new URLSearchParams();
	const token = url.searchParams.get("token");
	if (token) params.set("token", token);
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

export function buildMasterUrls(event: EventRecord, base: string, authQuery: string): MasterPlaylistUrls {
	const video: Record<string, string> = {};
	for (const rendition of event.video) {
		video[rendition.name] = `${base}/v1/events/${event.slug}/v/${encodeURIComponent(rendition.name)}.m3u8${authQuery}`;
	}

	const audio: Record<string, string> = {};
	for (const track of event.audio) {
		audio[track.name] =
			`${base}/v1/events/${event.slug}/a/${encodeURIComponent(track.group)}/${audioTrackPathSegment(track.name)}.m3u8${authQuery}`;
	}

	return { video, audio };
}

export interface PlaylistContext {
	now: number;
	event: EventRecord;
	window: WindowResult;
}

/**
 * How long segment-URL signatures stay valid.
 * - Sliding live windows: short — the player re-fetches the manifest every few
 *   seconds and always holds fresh signatures, so a *copied* manifest dies fast.
 * - Seekable playlists (EVENT / VOD / anything with ENDLIST): long — players
 *   hold these without refreshing (VOD is browser-cached up to 1h) and must be
 *   able to seek anywhere for a full watch afterwards.
 */
export function assetSignatureTtl(ctx: PlaylistContext): number {
	const seekable = ctx.window.endList || ctx.window.playlistType !== undefined;
	if (!seekable) {
		return Math.max(300, ctx.event.windowSize * ctx.event.segmentDuration + 120);
	}
	return 3600 + ctx.event.durationSeconds + 3600;
}

export interface UrlSignerOptions {
	bunnyTokenKey?: string;
	sessionSecret?: string;
	assetSignatureTtl: number;
}

/**
 * Segment/init URL signer.
 * - Worker-hosted assets (`/v1/assets/…`) on gated events: short-lived HMAC
 *   signature (`?se=&sg=`) verified by the gate middleware — the session JWT
 *   itself never appears in segment URLs.
 * - External CDN (Bunny) + paid gate: Bunny Token Authentication.
 */
export function createUrlSigner(
	event: EventRecord,
	now: number,
	options: UrlSignerOptions,
): (absoluteUrl: string) => string | Promise<string> {
	const bunnyExpiresAt = cdnUrlExpiry(now, event.windowSize * event.segmentDuration);
	const assetExpiresAt = Math.ceil(now + options.assetSignatureTtl);

	return (absoluteUrl: string) => {
		const url = new URL(absoluteUrl);
		if (url.pathname.startsWith("/v1/assets/")) {
			if (event.gate !== "open" && options.sessionSecret) {
				return signAssetUrl(absoluteUrl, assetExpiresAt, options.sessionSecret);
			}
			return absoluteUrl;
		}
		if (event.gate === "paid" && options.bunnyTokenKey) {
			return signCdnUrl(absoluteUrl, bunnyExpiresAt, options.bunnyTokenKey);
		}
		return absoluteUrl;
	};
}

export async function renderSignedMediaPlaylist(
	ctx: PlaylistContext,
	track: { initPath: string; segmentPattern: string },
	signUrl: (url: string) => string | Promise<string>,
): Promise<string> {
	return renderMediaPlaylistAsync({
		event: ctx.event,
		track,
		window: ctx.window,
		signUrl,
	});
}

/**
 * One shared entry per slug/rendition/segment-boundary — safe across viewers
 * because the gate runs before the cache lookup and rendered manifests contain
 * no per-viewer data (segment signatures derive from path + expiry, not the JWT).
 */
export function playlistCacheKey(
	slug: string,
	scheduledStart: number,
	kind: "video" | "audio",
	id: string,
	bucket: number,
): Request {
	return new Request(`${CACHE_ORIGIN}/${slug}/${scheduledStart}/${kind}/${encodeURIComponent(id)}/${bucket}`);
}

export interface PlaylistResponsePair {
	/** Response for the viewer (client Cache-Control, usually no-store). */
	response: Response;
	/** Copy for cache.put, or undefined on hit / when the edge policy is no-store. */
	stored?: Response;
}

/**
 * The client copy carries `no-store` (browsers must re-fetch live manifests),
 * but the edge copy needs a real TTL — `cache.put` silently drops `no-store`
 * responses, which would disable edge caching entirely.
 */
export async function cachedPlaylistResponse(
	cache: Cache,
	cacheKey: Request,
	body: string,
	clientCacheControl: string,
	edgeCacheControl: string,
	phase: string,
): Promise<PlaylistResponsePair> {
	const hit = await cache.match(cacheKey);
	if (hit) {
		const res = new Response(hit.body, hit);
		res.headers.set("Content-Type", HLS_CONTENT_TYPE);
		res.headers.set("Cache-Control", clientCacheControl);
		res.headers.set("X-Manifest-Cache", "HIT");
		res.headers.set("X-Playback-Phase", phase);
		return { response: res };
	}

	const response = new Response(body, {
		headers: {
			"Content-Type": HLS_CONTENT_TYPE,
			"Cache-Control": clientCacheControl,
			"X-Manifest-Cache": "MISS",
			"X-Playback-Phase": phase,
		},
	});

	if (edgeCacheControl.includes("no-store")) {
		return { response };
	}

	const stored = new Response(body, {
		headers: {
			"Content-Type": HLS_CONTENT_TYPE,
			"Cache-Control": edgeCacheControl,
			"X-Playback-Phase": phase,
		},
	});
	return { response, stored };
}

export function shortCacheControl(): string {
	return "no-store";
}

export function mediaCacheControl(ctx: PlaylistContext): string {
	return formatCacheControl(
		computeCacheMaxAge({
			now: ctx.now,
			scheduledStart: ctx.event.scheduledStart,
			segmentDuration: ctx.event.segmentDuration,
			totalSegments: ctx.event.totalSegments,
			replayMode: ctx.event.replayMode,
			phase: ctx.window.phase,
		}),
	);
}

export function mediaEdgeCacheControl(ctx: PlaylistContext): string {
	return edgeCacheControl(ctx.window.phase, ctx.event.replayMode, ctx.event.segmentDuration);
}

export function buildPlaylistContext(event: EventRecord, now: number): PlaylistContext {
	return {
		now,
		event,
		window: computeWindow({
			now,
			scheduledStart: event.scheduledStart,
			segmentDuration: event.segmentDuration,
			totalSegments: event.totalSegments,
			windowSize: event.windowSize,
			joinFromStart: event.joinFromStart,
			replayMode: event.replayMode,
		}),
	};
}

export function renderMasterForEvent(event: EventRecord, requestUrl: string): string {
	const base = workerBaseUrl(requestUrl);
	const authQuery = preserveAuthQuery(requestUrl);
	return renderMasterPlaylist({
		event,
		workerUrls: buildMasterUrls(event, base, authQuery),
	});
}

export { mediaPlaylistCacheBucket, computeWindow, renderMediaPlaylistAsync, renderMasterPlaylist };
