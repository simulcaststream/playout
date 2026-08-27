import type { Context, Next } from "hono";
import type { AppVariables } from "../env.js";

type CorsContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const CORS_HEADERS = {
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers":
		"Authorization, Content-Type, Range, If-None-Match, If-Range, If-Modified-Since",
	"Access-Control-Max-Age": "86400",
} as const;

const EXPOSE_HEADERS =
	"X-Playback-Phase, X-Manifest-Cache, X-Asset-Cache, Content-Range, Accept-Ranges, ETag";

export function corsMiddleware() {
	return async (c: CorsContext, next: Next) => {
		if (c.req.method === "OPTIONS") {
			setCorsOrigin(c);
			for (const [key, value] of Object.entries(CORS_HEADERS)) {
				c.header(key, value);
			}
			return c.body(null, 204);
		}

		await next();

		setCorsOrigin(c);
		c.header("Access-Control-Allow-Methods", CORS_HEADERS["Access-Control-Allow-Methods"]);
		c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
	};
}

function setCorsOrigin(c: CorsContext): void {
	const configured = c.env.CORS_ORIGINS?.split(",").map((o: string) => o.trim()).filter(Boolean);
	const origin = c.req.header("Origin");

	// Allowlisted browser origins get credentialed CORS (HttpOnly session cookies).
	if (configured?.length && origin && configured.includes(origin)) {
		c.header("Access-Control-Allow-Origin", origin);
		c.header("Access-Control-Allow-Credentials", "true");
		return;
	}

	// Chromecast and other clients without a browser Origin: wildcard, no credentials.
	c.header("Access-Control-Allow-Origin", "*");
}
