import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "./env.js";
import { corsMiddleware } from "./middleware/cors.js";
import { eventLoaderMiddleware } from "./middleware/event-loader.js";
import { gateMiddleware } from "./middleware/gate.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerOperatorRoutes } from "./routes/operator.js";
import { registerPlayerRoute } from "./routes/player.js";
import { registerTimeRoute } from "./routes/time.js";

const app = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", corsMiddleware());
app.use("/v1/events/:slug/*", eventLoaderMiddleware());
app.use("/v1/events/:slug/*", gateMiddleware());
// Segment bytes enforce the same gate as playlists; gated playlists stamp short-lived
// HMAC signatures on Worker asset URLs (see createUrlSigner).
app.use("/v1/assets/:slug/*", eventLoaderMiddleware());
app.use("/v1/assets/:slug/*", gateMiddleware());

registerTimeRoute(app);
registerAssetRoutes(app);
registerEventRoutes(app);
registerOperatorRoutes(app);
registerPlayerRoute(app);

app.doc("/openapi.json", {
	openapi: "3.0.0",
	info: {
		title: "Calculated-Live HLS Manifest Worker",
		version: "1.0.0",
		description:
			"Stateless Cloudflare Worker that serves HLS playlists making pre-recorded video behave like a live stream.",
	},
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
