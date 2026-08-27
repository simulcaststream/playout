import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
	assetSignatureTtl,
	buildPlaylistContext,
	cachedPlaylistResponse,
	createUrlSigner,
	mediaCacheControl,
	mediaEdgeCacheControl,
	mediaPlaylistCacheBucket,
	playlistCacheKey,
	renderMasterForEvent,
	renderSignedMediaPlaylist,
	shortCacheControl,
} from "../lib/playlist.js";
import type { AppVariables } from "../env.js";
import type { EventRecord } from "../manifest/types.js";

type App = OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>;

const slugParam = z.object({
	slug: z.string().openapi({ param: { name: "slug", in: "path" }, example: "jamie-premiere" }),
});

const masterRoute = createRoute({
	method: "get",
	path: "/v1/events/{slug}/master.m3u8",
	request: { params: slugParam },
	responses: {
		200: { description: "HLS master playlist" },
		404: { description: "Unknown event slug" },
		410: { description: "Event has ended and replay is disabled" },
		502: { description: "Malformed KV record" },
	},
});

const videoRoute = createRoute({
	method: "get",
	path: "/v1/events/{slug}/v/{rendition.m3u8}",
	request: {
		params: slugParam.extend({
			// Hono names the param "rendition.m3u8" when the route is :rendition.m3u8
			"rendition.m3u8": z.string().openapi({
				param: { name: "rendition.m3u8", in: "path" },
				example: "720p.m3u8",
			}),
		}),
	},
	responses: {
		200: { description: "HLS video media playlist" },
		400: { description: "Unknown rendition" },
		404: { description: "Unknown event slug" },
		410: { description: "Event has ended and replay is disabled" },
		502: { description: "Malformed KV record" },
	},
});

const audioRoute = createRoute({
	method: "get",
	path: "/v1/events/{slug}/a/{group}/{name.m3u8}",
	request: {
		params: slugParam.extend({
			group: z.string().openapi({ param: { name: "group", in: "path" }, example: "aud" }),
			"name.m3u8": z.string().openapi({
				param: { name: "name.m3u8", in: "path" },
				example: "English%20Stereo.m3u8",
			}),
		}),
	},
	responses: {
		200: { description: "HLS audio media playlist" },
		400: { description: "Unknown audio track" },
		404: { description: "Unknown event slug" },
		410: { description: "Event has ended and replay is disabled" },
		502: { description: "Malformed KV record" },
	},
});

function stripM3u8Param(value: string): string {
	return decodeURIComponent(value.replace(/\.m3u8$/i, ""));
}

function requireEvent(c: { get: (key: "event") => EventRecord | undefined }): EventRecord {
	const event = c.get("event");
	if (!event) throw new Error("event not loaded");
	return event;
}

function playlistsUnavailable(phase: string, replayMode: EventRecord["replayMode"]): boolean {
	// Pre-start serves a holding playlist (MAP, no segments, no ENDLIST) so
	// native HLS / JW / hls.js keep polling instead of dying on 412 JSON.
	return phase === "ended" && replayMode === "none";
}

function unavailablePlaylist(
	c: Context<{ Bindings: Env; Variables: AppVariables }>,
	phase: string,
) {
	return c.json(
		{
			error: {
				messages: ["Live stream has ended"],
				type: "failed_request",
			},
		},
		410,
		{
			"Cache-Control": "no-store",
			"X-Playback-Phase": phase,
		},
	);
}

export function registerEventRoutes(app: App) {
	app.openapi(masterRoute, async (c) => {
		const event = requireEvent(c);
		const now = Date.now() / 1000;
		const ctx = buildPlaylistContext(event, now);

		if (playlistsUnavailable(ctx.window.phase, event.replayMode)) {
			return unavailablePlaylist(c, ctx.window.phase);
		}

		const body = renderMasterForEvent(event, c.req.url);
		return c.body(body, 200, {
			"Content-Type": "application/vnd.apple.mpegurl",
			"Cache-Control": shortCacheControl(),
		});
	});

	app.openapi(videoRoute, async (c) => {
		const event = requireEvent(c);
		const { "rendition.m3u8": renditionFile } = c.req.valid("param");
		const renditionName = stripM3u8Param(renditionFile);
		const rendition = event.video.find((v) => v.name === renditionName);
		if (!rendition) return c.text("Unknown rendition", 400);

		return serveMediaPlaylist(c, event, rendition, "video", renditionName);
	});

	app.openapi(audioRoute, async (c) => {
		const event = requireEvent(c);
		const { group, "name.m3u8": nameFile } = c.req.valid("param");
		const trackName = stripM3u8Param(nameFile);
		const track = event.audio.find((a) => a.group === group && a.name === trackName);
		if (!track) return c.text("Unknown audio track", 400);

		return serveMediaPlaylist(c, event, track, "audio", `${group}/${trackName}`);
	});
}

async function serveMediaPlaylist(
	c: Context<{ Bindings: Env; Variables: AppVariables }>,
	event: EventRecord,
	track: { initPath: string; segmentPattern: string },
	kind: "video" | "audio",
	cacheId: string,
): Promise<Response> {
	const now = Date.now() / 1000;
	const ctx = buildPlaylistContext(event, now);

	if (playlistsUnavailable(ctx.window.phase, event.replayMode)) {
		return unavailablePlaylist(c, ctx.window.phase);
	}

	const bucket = mediaPlaylistCacheBucket(
		now,
		event.scheduledStart,
		event.segmentDuration,
		event.totalSegments,
		event.replayMode,
	);
	const cacheKey = playlistCacheKey(event.slug, event.scheduledStart, kind, cacheId, bucket);
	const cache = caches.default;
	const hit = await cache.match(cacheKey);
	if (hit) {
		const res = new Response(hit.body, hit);
		res.headers.set("Content-Type", "application/vnd.apple.mpegurl");
		res.headers.set("Cache-Control", mediaCacheControl(ctx));
		res.headers.set("X-Manifest-Cache", "HIT");
		res.headers.set("X-Playback-Phase", ctx.window.phase);
		return res;
	}

	const signUrl = createUrlSigner(event, now, {
		bunnyTokenKey: c.env.BUNNY_TOKEN_KEY,
		sessionSecret: c.env.SESSION_JWT_SECRET,
		assetSignatureTtl: assetSignatureTtl(ctx),
	});
	const body = await renderSignedMediaPlaylist(ctx, track, signUrl);

	const { response, stored } = await cachedPlaylistResponse(
		cache,
		cacheKey,
		body,
		mediaCacheControl(ctx),
		mediaEdgeCacheControl(ctx),
		ctx.window.phase,
	);
	if (stored) {
		c.executionCtx.waitUntil(cache.put(cacheKey, stored));
	}
	return response;
}
