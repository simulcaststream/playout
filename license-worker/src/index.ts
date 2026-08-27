import { Hono } from "hono";
import type { Env, LicenseClaims } from "./types.js";
import { randomToken, signLicenseJwt, verifyLicenseJwt } from "./jwt.js";
import { markUserPaid } from "./purchase.js";
import {
	createCheckoutSession,
	handleStripeEvent,
	stripeConfigured,
	verifyStripeSignature,
} from "./stripe.js";
import {
	consumePendingLogin,
	deleteSeat,
	getSeat,
	getUser,
	graceSeconds,
	licenseTtlSeconds,
	putPendingLogin,
	putSeat,
	putUser,
	transferCooldownSeconds,
	userIdForEmail,
} from "./store.js";

const app = new Hono<{ Bindings: Env }>();

function jsonError(c: { json: (body: unknown, status?: number) => Response }, status: number, error: string) {
	return c.json({ error }, status);
}

async function requireLicenseJwt(
	c: { req: { header: (name: string) => string | undefined }; env: Env },
): Promise<LicenseClaims | null> {
	const auth = c.req.header("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	return verifyLicenseJwt(auth.slice(7).trim(), c.env.LICENSE_JWT_SECRET);
}

async function issueLicenseToken(env: Env, email: string, deviceId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const claims: LicenseClaims = {
		sub: await userIdForEmail(email),
		email: email.toLowerCase().trim(),
		deviceId,
		iat: now,
		exp: now + licenseTtlSeconds(env),
	};
	return signLicenseJwt(claims, env.LICENSE_JWT_SECRET);
}

app.get("/health", (c) => c.json({ ok: true }));

/** Dev-only: skip email, mark paid, return token. Disabled in production unless ALLOW_DEV_LOGIN=1 */
app.post("/license/dev-login", async (c) => {
	if (c.env.ALLOW_DEV_LOGIN !== "1") {
		return jsonError(c, 403, "dev login disabled");
	}
	const body = await c.req.json<{ email?: string; deviceId?: string }>();
	const email = body.email?.trim().toLowerCase();
	const deviceId = body.deviceId?.trim();
	if (!email || !deviceId) return jsonError(c, 400, "email and deviceId required");

	let user = await getUser(c.env, email);
	if (!user) {
		user = { email, paid: true, purchaseId: "dev", createdAt: Math.floor(Date.now() / 1000) };
		await putUser(c.env, user);
	} else if (!user.paid) {
		user.paid = true;
		await putUser(c.env, user);
	}

	const userId = await userIdForEmail(email);
	const now = Math.floor(Date.now() / 1000);
	await putSeat(c.env, { userId, deviceId, activatedAt: now, lastSeen: now });
	const token = await issueLicenseToken(c.env, email, deviceId);
	return c.json({ token, email });
});

app.post("/license/login", async (c) => {
	const body = await c.req.json<{ email?: string }>();
	const email = body.email?.trim().toLowerCase();
	if (!email || !email.includes("@")) return jsonError(c, 400, "valid email required");

	const user = await getUser(c.env, email);
	if (!user?.paid) return jsonError(c, 402, "purchase required");

	const token = randomToken(24);
	const exp = Math.floor(Date.now() / 1000) + 900;
	await putPendingLogin(c.env, { email, token, exp });

	const magicUrl = `${c.env.APP_URL}?token=${token}`;

	if (c.env.RESEND_API_KEY) {
		await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from: "Playout <login@calculated.live>",
				to: email,
				subject: "Sign in to Playout",
				text: `Open this link to sign in:\n\n${magicUrl}\n\nExpires in 15 minutes.`,
			}),
		});
		return c.json({ ok: true, message: "magic link sent" });
	}

	// No email provider — return token for dev/desktop deep link testing
	return c.json({ ok: true, magicUrl, token });
});

app.post("/license/verify-login", async (c) => {
	const body = await c.req.json<{ token?: string; deviceId?: string }>();
	const loginToken = body.token?.trim();
	const deviceId = body.deviceId?.trim();
	if (!loginToken || !deviceId) return jsonError(c, 400, "token and deviceId required");

	const pending = await consumePendingLogin(c.env, loginToken);
	if (!pending || pending.exp < Math.floor(Date.now() / 1000)) {
		return jsonError(c, 401, "invalid or expired login token");
	}

	const user = await getUser(c.env, pending.email);
	if (!user?.paid) return jsonError(c, 402, "purchase required");

	const userId = await userIdForEmail(pending.email);
	const seat = await getSeat(c.env, userId);
	const now = Math.floor(Date.now() / 1000);
	const grace = graceSeconds(c.env);

	if (seat && seat.deviceId !== deviceId && now - seat.lastSeen < grace) {
		return jsonError(c, 409, "device already active");
	}

	await putSeat(c.env, {
		userId,
		deviceId,
		activatedAt: seat?.deviceId === deviceId ? seat.activatedAt : now,
		lastSeen: now,
		lastTransferAt: seat?.lastTransferAt,
	});

	const licenseToken = await issueLicenseToken(c.env, pending.email, deviceId);
	return c.json({ token: licenseToken, email: pending.email });
});

app.post("/license/activate", async (c) => {
	const claims = await requireLicenseJwt(c);
	if (!claims) return jsonError(c, 401, "invalid license token");

	const body = await c.req.json<{ deviceId?: string }>();
	const deviceId = body.deviceId?.trim() || claims.deviceId;
	if (deviceId !== claims.deviceId) return jsonError(c, 403, "device mismatch");

	const user = await getUser(c.env, claims.email);
	if (!user?.paid) return jsonError(c, 402, "purchase required");

	const userId = await userIdForEmail(claims.email);
	const seat = await getSeat(c.env, userId);
	const now = Math.floor(Date.now() / 1000);
	const grace = graceSeconds(c.env);

	if (seat && seat.deviceId !== deviceId && now - seat.lastSeen < grace) {
		return jsonError(c, 409, "device already active");
	}

	await putSeat(c.env, {
		userId,
		deviceId,
		activatedAt: seat?.deviceId === deviceId ? seat.activatedAt : now,
		lastSeen: now,
		lastTransferAt: seat?.lastTransferAt,
	});

	const token = await issueLicenseToken(c.env, claims.email, deviceId);
	return c.json({ token, email: claims.email });
});

app.post("/license/heartbeat", async (c) => {
	const claims = await requireLicenseJwt(c);
	if (!claims) return jsonError(c, 401, "invalid license token");

	const userId = await userIdForEmail(claims.email);
	const seat = await getSeat(c.env, userId);
	if (!seat || seat.deviceId !== claims.deviceId) {
		return jsonError(c, 403, "device not activated");
	}

	const now = Math.floor(Date.now() / 1000);
	await putSeat(c.env, { ...seat, lastSeen: now });
	const token = await issueLicenseToken(c.env, claims.email, claims.deviceId);
	return c.json({ token, lastSeen: now });
});

app.post("/license/transfer", async (c) => {
	const claims = await requireLicenseJwt(c);
	if (!claims) return jsonError(c, 401, "invalid license token");

	const body = await c.req.json<{ deviceId?: string }>();
	const deviceId = body.deviceId?.trim();
	if (!deviceId) return jsonError(c, 400, "deviceId required");

	const user = await getUser(c.env, claims.email);
	if (!user?.paid) return jsonError(c, 402, "purchase required");

	const userId = await userIdForEmail(claims.email);
	const seat = await getSeat(c.env, userId);
	const now = Math.floor(Date.now() / 1000);
	const cooldown = transferCooldownSeconds(c.env);

	if (seat?.lastTransferAt && now - seat.lastTransferAt < cooldown) {
		const retryAfter = cooldown - (now - seat.lastTransferAt);
		return c.json({ error: "transfer cooldown", retryAfterSeconds: retryAfter }, 429);
	}

	await putSeat(c.env, {
		userId,
		deviceId,
		activatedAt: now,
		lastSeen: now,
		lastTransferAt: now,
	});

	const token = await issueLicenseToken(c.env, claims.email, deviceId);
	return c.json({ token, email: claims.email });
});

app.post("/license/logout", async (c) => {
	const claims = await requireLicenseJwt(c);
	if (!claims) return jsonError(c, 401, "invalid license token");

	const userId = await userIdForEmail(claims.email);
	const seat = await getSeat(c.env, userId);
	if (seat && seat.deviceId === claims.deviceId) {
		await deleteSeat(c.env, userId);
	}
	return c.json({ ok: true });
});

/** Create a Stripe Checkout session for the $49 Playout license */
app.post("/purchase/checkout", async (c) => {
	if (!stripeConfigured(c.env)) {
		return jsonError(c, 503, "Stripe checkout not configured");
	}

	const body = await c.req.json<{ email?: string }>();
	const email = body.email?.trim().toLowerCase();
	if (!email || !email.includes("@")) return jsonError(c, 400, "valid email required");

	const existing = await getUser(c.env, email);
	if (existing?.paid) {
		return jsonError(c, 409, "already purchased — sign in with magic link");
	}

	try {
		const session = await createCheckoutSession(c.env, email);
		return c.json({ url: session.url, sessionId: session.id });
	} catch (e) {
		const message = e instanceof Error ? e.message : "checkout failed";
		return jsonError(c, 502, message);
	}
});

/** Stripe webhook — marks buyer email as paid on checkout.session.completed */
app.post("/webhook/stripe", async (c) => {
	const secret = c.env.STRIPE_WEBHOOK_SECRET;
	if (!secret) return jsonError(c, 503, "Stripe webhook not configured");

	const signature = c.req.header("stripe-signature");
	if (!signature) return jsonError(c, 400, "missing stripe-signature header");

	const payload = await c.req.text();
	const valid = await verifyStripeSignature(payload, signature, secret);
	if (!valid) return jsonError(c, 400, "invalid stripe signature");

	let event: { type: string; data?: { object?: Record<string, unknown> } };
	try {
		event = JSON.parse(payload);
	} catch {
		return jsonError(c, 400, "invalid json");
	}

	try {
		const result = await handleStripeEvent(c.env, event);
		return c.json(result);
	} catch (e) {
		const message = e instanceof Error ? e.message : "webhook handler failed";
		return jsonError(c, 500, message);
	}
});

/** Legacy generic webhook — marks email as paid (dev / manual testing) */
app.post("/webhook/purchase", async (c) => {
	const secret = c.env.WEBHOOK_SECRET;
	if (secret) {
		const sig = c.req.header("x-webhook-secret") ?? c.req.header("x-polar-webhook-secret");
		if (sig !== secret) return jsonError(c, 401, "invalid webhook secret");
	}

	const body = await c.req.json<{
		email?: string;
		customer_email?: string;
		data?: { customer?: { email?: string } };
		purchase_id?: string;
		id?: string;
	}>();

	const email = (
		body.email ??
		body.customer_email ??
		body.data?.customer?.email ??
		""
	)
		.trim()
		.toLowerCase();
	if (!email) return jsonError(c, 400, "email not found in webhook payload");

	const purchaseId = body.purchase_id ?? body.id ?? `purchase_${Date.now()}`;
	await markUserPaid(c.env, email, purchaseId);

	return c.json({ ok: true, email });
});

export default app;
