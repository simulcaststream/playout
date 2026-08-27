import type { Env } from "./types.js";
import { markUserPaid } from "./purchase.js";

type StripeEvent = {
	type: string;
	data?: { object?: Record<string, unknown> };
};

function formBody(params: Record<string, string>): string {
	return new URLSearchParams(params).toString();
}

function nestedFormBody(prefix: string, value: string): Record<string, string> {
	return { [prefix]: value };
}

export function stripeConfigured(env: Env): boolean {
	return Boolean(env.STRIPE_SECRET_KEY);
}

export async function createCheckoutSession(
	env: Env,
	email: string,
): Promise<{ url: string; id: string }> {
	const secret = env.STRIPE_SECRET_KEY;
	if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");

	const normalized = email.trim().toLowerCase();
	const successUrl =
		env.STRIPE_SUCCESS_URL ??
		"https://simulcast.stream/playout/thanks?session_id={CHECKOUT_SESSION_ID}";
	const cancelUrl = env.STRIPE_CANCEL_URL ?? "https://simulcast.stream/playout/cancel";

	const params: Record<string, string> = {
		mode: "payment",
		customer_email: normalized,
		success_url: successUrl,
		cancel_url: cancelUrl,
		"metadata[email]": normalized,
		"metadata[product]": "playout",
		...nestedFormBody("line_items[0][quantity]", "1"),
	};

	if (env.STRIPE_PRICE_ID) {
		params["line_items[0][price]"] = env.STRIPE_PRICE_ID;
	} else {
		const amount = env.STRIPE_AMOUNT_CENTS ?? "4900";
		const currency = env.STRIPE_CURRENCY ?? "usd";
		Object.assign(params, {
			"line_items[0][price_data][currency]": currency,
			"line_items[0][price_data][product_data][name]": "Playout",
			"line_items[0][price_data][product_data][description]":
				"One-time license — pack and deploy live HLS on your Cloudflare account",
			"line_items[0][price_data][unit_amount]": amount,
		});
	}

	const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: formBody(params),
	});

	const body = (await res.json()) as {
		error?: { message?: string };
		url?: string;
		id?: string;
	};
	if (!res.ok) {
		throw new Error(body.error?.message ?? "Stripe checkout failed");
	}
	if (!body.url || !body.id) throw new Error("Stripe checkout missing url");

	return { url: body.url, id: body.id };
}

export function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
	const signatures: string[] = [];
	let ts = "";
	for (const part of header.split(",")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq);
		const value = part.slice(eq + 1);
		if (key === "t") ts = value;
		if (key === "v1") signatures.push(value);
	}
	return { timestamp: ts, signatures };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

export async function verifyStripeSignature(
	payload: string,
	signatureHeader: string,
	secret: string,
	toleranceSec = 300,
): Promise<boolean> {
	const { timestamp, signatures } = parseStripeSignature(signatureHeader);
	if (!timestamp || signatures.length === 0) return false;

	const age = Math.floor(Date.now() / 1000) - Number(timestamp);
	if (!Number.isFinite(age) || Math.abs(age) > toleranceSec) return false;

	const signedPayload = `${timestamp}.${payload}`;
	const expected = await hmacSha256Hex(secret, signedPayload);
	return signatures.some((sig) => timingSafeEqual(expected, sig));
}

function emailFromCheckoutSession(session: Record<string, unknown>): string {
	const metadata = session.metadata as Record<string, string> | undefined;
	const customerDetails = session.customer_details as { email?: string } | undefined;
	return (
		metadata?.email ??
		(session.customer_email as string | undefined) ??
		customerDetails?.email ??
		""
	)
		.trim()
		.toLowerCase();
}

export async function handleStripeEvent(env: Env, event: StripeEvent): Promise<{ ok: true; email?: string }> {
	switch (event.type) {
		case "checkout.session.completed": {
			const session = event.data?.object;
			if (!session) throw new Error("missing checkout session");
			if (session.payment_status !== "paid") {
				return { ok: true };
			}
			const email = emailFromCheckoutSession(session);
			if (!email) throw new Error("checkout session missing email");
			const purchaseId = String(session.id ?? `checkout_${Date.now()}`);
			await markUserPaid(env, email, purchaseId);
			return { ok: true, email };
		}
		default:
			return { ok: true };
	}
}
