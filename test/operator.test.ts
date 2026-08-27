import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../src/env.js";
import { registerOperatorRoutes } from "../src/routes/operator.js";

function appWithSecrets(secrets: Partial<Env>) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();
	registerOperatorRoutes(app);
	return { app, env: secrets as Env };
}

describe("operator mint route (PPV V2)", () => {
	it("mints a viewer token when operator secret matches", async () => {
		const { app, env } = appWithSecrets({
			OPERATOR_SECRET: "op-secret",
			SESSION_JWT_SECRET: "session-secret",
		});
		const res = await app.request(
			"/v1/operator/mint",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer op-secret",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ slug: "demo", ttl: 120 }),
			},
			env,
		);
		expect(res.status).toBe(200);
		const body = await res.json<{ token: string; slug: string }>();
		expect(body.slug).toBe("demo");
		expect(body.token.split(".")).toHaveLength(3);
	});

	it("rejects missing operator auth", async () => {
		const { app, env } = appWithSecrets({
			OPERATOR_SECRET: "op-secret",
			SESSION_JWT_SECRET: "session-secret",
		});
		const res = await app.request(
			"/v1/operator/mint",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug: "demo" }),
			},
			env,
		);
		expect(res.status).toBe(401);
	});
});
