import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { signAssetPath } from "../src/lib/asset-sign.js";
import {
	SESSION_COOKIE_NAME,
	getSessionJwtFromCookie,
	verifySessionCookie,
} from "../src/lib/session-cookie.js";
import { verifyJwt } from "../src/lib/session-jwt.js";
import { gateMiddleware } from "../src/middleware/gate.js";
import type { AppVariables } from "../src/env.js";
import type { EventRecord } from "../src/manifest/types.js";
import { makeEvent } from "./helpers.js";

const SECRET = "test-secret";

function mintJwt(payload: Record<string, unknown>, secret = SECRET, alg = "HS256"): string {
	const b64u = (value: string) => Buffer.from(value).toString("base64url");
	const header = b64u(JSON.stringify({ alg, typ: "JWT" }));
	const body = b64u(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${sig}`;
}

const future = Math.floor(Date.now() / 1000) + 3600;

describe("verifyJwt", () => {
	it("accepts a valid HS256 token and returns its claims", async () => {
		const claims = await verifyJwt(mintJwt({ exp: future, slug: "demo" }), SECRET);
		expect(claims).not.toBeNull();
		expect(claims?.slug).toBe("demo");
	});

	it("rejects expired tokens", async () => {
		expect(await verifyJwt(mintJwt({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET)).toBeNull();
	});

	it("rejects wrong-secret signatures", async () => {
		expect(await verifyJwt(mintJwt({ exp: future }, "other-secret"), SECRET)).toBeNull();
	});

	it("rejects non-HS256 algorithms even with a matching HMAC", async () => {
		expect(await verifyJwt(mintJwt({ exp: future }, SECRET, "none"), SECRET)).toBeNull();
	});

	it("rejects tokens without exp", async () => {
		expect(await verifyJwt(mintJwt({ slug: "demo" }), SECRET)).toBeNull();
	});
});

describe("session cookie", () => {
	it("extracts cl_session from Cookie header", () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		expect(getSessionJwtFromCookie(`other=1; ${SESSION_COOKIE_NAME}=${jwt}; foo=bar`)).toBe(jwt);
	});

	it("returns null when cookie is missing", () => {
		expect(getSessionJwtFromCookie("other=1")).toBeNull();
		expect(getSessionJwtFromCookie(undefined)).toBeNull();
	});

	it("verifies a valid session cookie", async () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		const claims = await verifySessionCookie(`${SESSION_COOKIE_NAME}=${jwt}`, SECRET);
		expect(claims?.slug).toBe("demo");
	});
});

function gatedApp(event: EventRecord) {
	const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
	app.use("*", async (c, next) => {
		c.set("event", event);
		c.set("gate", event.gate);
		await next();
	});
	app.use("*", gateMiddleware());
	app.get("/v1/events/:slug/master.m3u8", (c) => c.text("playlist"));
	app.get("/v1/assets/:slug/*", (c) => c.text("segment"));
	return app;
}

describe("gateMiddleware", () => {
	const env = { SESSION_JWT_SECRET: SECRET } as Env;
	const event = makeEvent({ gate: "email", slug: "demo" });

	it("allows gated playlist with session cookie", async () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		const res = await gatedApp(event).request("/v1/events/demo/master.m3u8", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
		}, env);
		expect(res.status).toBe(200);
	});

	it("allows gated playlist with Bearer token", async () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		const res = await gatedApp(event).request("/v1/events/demo/master.m3u8", {
			headers: { Authorization: `Bearer ${jwt}` },
		}, env);
		expect(res.status).toBe(200);
	});

	it("rejects gated playlist without auth", async () => {
		const res = await gatedApp(event).request("/v1/events/demo/master.m3u8", {}, env);
		expect(res.status).toBe(401);
	});

	it("rejects cookie bound to a different slug", async () => {
		const jwt = mintJwt({ exp: future, slug: "other-event" });
		const res = await gatedApp(event).request("/v1/events/demo/master.m3u8", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
		}, env);
		expect(res.status).toBe(403);
	});

	it("allows segment with se/sg only (no cookie)", async () => {
		const pathname = "/v1/assets/demo/video/720p/seg_00001.m4s";
		const expiresAt = future;
		const sg = await signAssetPath(pathname, expiresAt, SECRET);
		const res = await gatedApp(event).request(`${pathname}?se=${expiresAt}&sg=${sg}`, {}, env);
		expect(res.status).toBe(200);
	});

	it("rejects segment with invalid se/sg even when cookie is present", async () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		const pathname = "/v1/assets/demo/video/720p/seg_00001.m4s";
		const res = await gatedApp(event).request(`${pathname}?se=${future}&sg=bad`, {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
		}, env);
		expect(res.status).toBe(401);
	});

	it("allows segment with valid cookie when se/sg absent", async () => {
		const jwt = mintJwt({ exp: future, slug: "demo" });
		const res = await gatedApp(event).request("/v1/assets/demo/video/720p/seg_00001.m4s", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${jwt}` },
		}, env);
		expect(res.status).toBe(200);
	});
});
