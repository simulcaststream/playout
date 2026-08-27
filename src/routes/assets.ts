import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../env.js";

type App = OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function contentTypeForPath(path: string): string {
	if (path.endsWith(".m4s")) return "video/iso.segment";
	if (path.endsWith(".mp4")) return "video/mp4";
	return "application/octet-stream";
}

function assetKey(slug: string, relPath: string): string {
	const normalized = relPath.replace(/^\/+/, "");
	return `${slug}/${normalized}`;
}

export function relativeAssetPath(url: URL, slug: string): string | null {
	const prefix = `/v1/assets/${slug}/`;
	if (!url.pathname.startsWith(prefix)) return null;
	const encoded = url.pathname.slice(prefix.length);
	if (!encoded) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(encoded);
	} catch {
		return null;
	}
	if (decoded.includes("..") || decoded.includes("\0")) return null;
	return decoded;
}

/** Content-Range values from an R2 ranged read. */
function resolveRange(
	range: R2Range,
	size: number,
): { offset: number; length: number } {
	if ("suffix" in range && range.suffix !== undefined) {
		const length = Math.min(range.suffix, size);
		return { offset: size - length, length };
	}
	const offset = "offset" in range ? (range.offset ?? 0) : 0;
	const length = "length" in range && range.length !== undefined ? range.length : size - offset;
	return { offset, length };
}

export function registerAssetRoutes(app: App): void {
	app.get("/v1/assets/:slug/*", async (c) => {
		const slug = c.req.param("slug");
		const relPath = relativeAssetPath(new URL(c.req.url), slug);
		if (!relPath) return c.text("Bad Request", 400);

		const rangeHeader = c.req.header("range");
		const cache = caches.default;

		// Segments are immutable; share one edge entry per object regardless of
		// auth query. Safe because the gate middleware already ran for this request.
		const cacheUrl = new URL(c.req.url);
		cacheUrl.search = "";
		const cacheKey = new Request(cacheUrl.toString());

		if (!rangeHeader) {
			const hit = await cache.match(cacheKey);
			if (hit) {
				// cache.match ignores conditional headers — revalidate manually.
				const ifNoneMatch = c.req.header("if-none-match");
				const etag = hit.headers.get("etag");
				if (ifNoneMatch && etag && ifNoneMatch.includes(etag)) {
					const headers = new Headers(hit.headers);
					headers.set("X-Asset-Cache", "HIT");
					return new Response(null, { status: 304, headers });
				}
				const res = new Response(hit.body, hit);
				res.headers.set("X-Asset-Cache", "HIT");
				return res;
			}
		}

		let object: R2Object | R2ObjectBody | null;
		try {
			object = await c.env.SEGMENTS.get(assetKey(slug, relPath), {
				range: rangeHeader ? c.req.raw.headers : undefined,
				onlyIf: c.req.raw.headers,
			});
		} catch {
			// R2 throws on unsatisfiable/invalid Range headers.
			return c.text("Range Not Satisfiable", 416);
		}
		if (!object) return c.text("Not Found", 404);

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("etag", object.httpEtag);
		headers.set("accept-ranges", "bytes");
		if (!headers.has("cache-control")) {
			headers.set("cache-control", IMMUTABLE_CACHE);
		}
		if (!headers.has("content-type")) {
			headers.set("content-type", contentTypeForPath(relPath));
		}

		// onlyIf precondition (If-None-Match) failed — body omitted by R2.
		if (!("body" in object) || !object.body) {
			return new Response(null, { status: 304, headers });
		}

		if (rangeHeader && object.range) {
			const { offset, length } = resolveRange(object.range, object.size);
			headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
			headers.set("content-length", String(length));
			return new Response(object.body, { status: 206, headers });
		}

		headers.set("content-length", String(object.size));
		const response = new Response(object.body, { headers });
		const forCache = response.clone();
		c.executionCtx.waitUntil(cache.put(cacheKey, forCache));
		return response;
	});
}
