import type { Context, Next } from "hono";
import type { AppVariables } from "../env.js";
import { verifySignedAssetPath } from "../lib/asset-sign.js";
import { getSessionJwtFromCookie } from "../lib/session-cookie.js";
import { verifyJwt, type SessionClaims } from "../lib/session-jwt.js";
import type { EventRecord } from "../manifest/types.js";

type GateContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export type { SessionClaims };
export { verifyJwt };

function extractBearerToken(c: GateContext): string | null {
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	return auth.slice("Bearer ".length).trim() || null;
}

/** Cookie first (web), then Bearer (mobile), then ?token= (dev / legacy). */
function resolveSessionToken(c: GateContext): string | null {
	return getSessionJwtFromCookie(c.req.header("Cookie")) ?? extractBearerToken(c) ?? c.req.query("token") ?? null;
}

function slugMismatch(claims: SessionClaims, event: EventRecord): boolean {
	return claims.slug !== undefined && claims.slug !== event.slug;
}

export function gateMiddleware() {
	return async (c: GateContext, next: Next) => {
		const event = c.get("event") as EventRecord | undefined;
		if (!event) return next();

		c.set("gate", event.gate);

		if (event.gate === "open") {
			return next();
		}

		const secret = c.env.SESSION_JWT_SECRET;
		if (!secret) {
			return c.json({ error: "SESSION_JWT_SECRET is not configured for gated events" }, 503);
		}

		// Segment/init requests carry a short-lived HMAC signature stamped into
		// the playlist by createUrlSigner instead of the session JWT.
		const url = new URL(c.req.url);
		if (url.pathname.startsWith("/v1/assets/")) {
			const se = url.searchParams.get("se");
			const sg = url.searchParams.get("sg");
			if (se && sg) {
				const valid = await verifySignedAssetPath(url.pathname, Number(se), sg, secret, Date.now() / 1000);
				if (valid) return next();
				return c.json({ error: "Invalid or expired segment signature" }, 401);
			}
		}

		const token = resolveSessionToken(c);
		if (!token) {
			return c.json({ error: "Authentication required" }, 401);
		}

		const claims = await verifyJwt(token, secret);
		if (!claims) {
			return c.json({ error: "Invalid or expired session token" }, 401);
		}

		// Event-scoped tokens: a leaked token opens one event, not the catalog.
		if (slugMismatch(claims, event)) {
			return c.json({ error: "Token is not valid for this event" }, 403);
		}

		return next();
	};
}
