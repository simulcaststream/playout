import type { Context, Next } from "hono";
import { MalformedEventError, loadEvent } from "../lib/events.js";
import type { AppVariables } from "../env.js";

type EnvContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/** Slugs double as KV keys, R2 prefixes, and cache-key components. */
export const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function eventLoaderMiddleware() {
	return async (c: EnvContext, next: Next) => {
		const slug = c.req.param("slug");
		if (!slug) return next();
		if (!SLUG_PATTERN.test(slug)) return c.text("Event not found", 404);

		try {
			const event = await loadEvent(c.env, slug);
			if (!event) return c.text("Event not found", 404);
			c.set("event", event);
		} catch (err) {
			if (err instanceof MalformedEventError) {
				return c.text(err.message, 502);
			}
			throw err;
		}

		return next();
	};
}
