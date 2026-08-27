import { describe, expect, it } from "vitest";
import { signLicenseJwt, verifyLicenseJwt } from "../src/jwt.js";

const SECRET = "test-secret-key-for-license-worker";

describe("license JWT", () => {
	it("round-trips valid claims", async () => {
		const now = Math.floor(Date.now() / 1000);
		const claims = {
			sub: "user123",
			email: "buyer@example.com",
			deviceId: "device-abc",
			iat: now,
			exp: now + 3600,
		};
		const token = await signLicenseJwt(claims, SECRET);
		const verified = await verifyLicenseJwt(token, SECRET);
		expect(verified?.email).toBe("buyer@example.com");
		expect(verified?.deviceId).toBe("device-abc");
	});

	it("rejects expired token", async () => {
		const now = Math.floor(Date.now() / 1000);
		const claims = {
			sub: "user123",
			email: "buyer@example.com",
			deviceId: "device-abc",
			iat: now - 7200,
			exp: now - 3600,
		};
		const token = await signLicenseJwt(claims, SECRET);
		expect(await verifyLicenseJwt(token, SECRET)).toBeNull();
	});
});
