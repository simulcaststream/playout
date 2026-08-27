import { describe, expect, it } from "vitest";
import {
	createCheckoutSession,
	handleStripeEvent,
	parseStripeSignature,
	verifyStripeSignature,
} from "../src/stripe.js";
import type { Env } from "../src/types.js";

async function signPayload(secret: string, timestamp: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${timestamp}.${payload}`),
	);
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("parseStripeSignature", () => {
	it("extracts timestamp and v1 signatures", () => {
		const parsed = parseStripeSignature("t=1710000000,v1=abc123,v1=def456");
		expect(parsed.timestamp).toBe("1710000000");
		expect(parsed.signatures).toEqual(["abc123", "def456"]);
	});
});

describe("verifyStripeSignature", () => {
	it("accepts a valid signature", async () => {
		const secret = "whsec_test_secret";
		const payload = '{"id":"evt_test","type":"checkout.session.completed"}';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await signPayload(secret, timestamp, payload);
		const header = `t=${timestamp},v1=${signature}`;

		const ok = await verifyStripeSignature(payload, header, secret);
		expect(ok).toBe(true);
	});

	it("rejects tampered payload", async () => {
		const secret = "whsec_test_secret";
		const payload = '{"id":"evt_test"}';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await signPayload(secret, timestamp, payload);
		const header = `t=${timestamp},v1=${signature}`;

		const ok = await verifyStripeSignature(`${payload}x`, header, secret);
		expect(ok).toBe(false);
	});
});

describe("handleStripeEvent", () => {
	it("marks user paid on checkout.session.completed", async () => {
		const writes = new Map<string, string>();
		const env = {
			LICENSE_DATA: {
				get: async (key: string) => writes.get(key) ?? null,
				put: async (key: string, value: string) => {
					writes.set(key, value);
				},
				delete: async () => {},
			},
		} as unknown as Env;

		const result = await handleStripeEvent(env, {
			type: "checkout.session.completed",
			data: {
				object: {
					id: "cs_test_123",
					payment_status: "paid",
					customer_email: "buyer@example.com",
				},
			},
		});

		expect(result.email).toBe("buyer@example.com");
		expect([...writes.values()].some((v) => v.includes('"paid":true'))).toBe(true);
	});
});

describe("createCheckoutSession", () => {
	it("requires STRIPE_SECRET_KEY", async () => {
		await expect(createCheckoutSession({} as Env, "buyer@example.com")).rejects.toThrow(
			"STRIPE_SECRET_KEY",
		);
	});
});
