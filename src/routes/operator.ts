/**
 * Mint viewer session JWTs for PPV / gated streams (V2).
 * Protected by OPERATOR_SECRET — set via wrangler secret put OPERATOR_SECRET.
 *
 * POST /v1/operator/mint
 * Authorization: Bearer <OPERATOR_SECRET>
 * Body: { "slug": "my-event", "ttl": 3600, "sub": "viewer-123" }
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../env.js";

type App = OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>;

function b64uEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintSessionJwt(
	secret: string,
	payload: { sub: string; exp: number; slug?: string },
): Promise<string> {
	const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const body = b64uEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const data = new TextEncoder().encode(`${header}.${body}`);
	const sig = await crypto.subtle.sign("HMAC", key, data);
	return `${header}.${body}.${b64uEncode(new Uint8Array(sig))}`;
}

export function registerOperatorRoutes(app: App) {
	app.post("/v1/operator/mint", async (c) => {
		const operatorSecret = c.env.OPERATOR_SECRET;
		const sessionSecret = c.env.SESSION_JWT_SECRET;
		if (!operatorSecret || !sessionSecret) {
			return c.json({ error: "OPERATOR_SECRET and SESSION_JWT_SECRET must be configured" }, 503);
		}

		const auth = c.req.header("Authorization");
		if (auth !== `Bearer ${operatorSecret}`) {
			return c.json({ error: "unauthorized" }, 401);
		}

		let body: { slug?: string; ttl?: number; sub?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		const slug = body.slug?.trim();
		if (!slug) return c.json({ error: "slug required" }, 400);

		const ttl = Math.min(Math.max(Number(body.ttl ?? 3600), 60), 86_400);
		const now = Math.floor(Date.now() / 1000);
		const token = await mintSessionJwt(sessionSecret, {
			sub: body.sub ?? "viewer",
			exp: now + ttl,
			slug,
		});

		return c.json({ token, exp: now + ttl, slug });
	});
}
