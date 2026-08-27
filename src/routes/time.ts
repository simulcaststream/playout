import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../env.js";

const TimeSchema = z.object({
	now: z.number().openapi({ example: 1731000000.123 }),
});

const timeRoute = createRoute({
	method: "get",
	path: "/v1/time",
	responses: {
		200: {
			description: "Server wall-clock time (epoch seconds)",
			content: { "application/json": { schema: TimeSchema } },
		},
	},
});

export function registerTimeRoute(app: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
	app.openapi(timeRoute, (c) => {
		return c.json({ now: Date.now() / 1000 }, 200, { "Cache-Control": "no-store" });
	});
}
