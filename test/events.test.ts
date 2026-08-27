import { describe, expect, it, beforeAll } from "vitest";
import app from "../src/index.js";
import { makeEvent } from "./helpers.js";

beforeAll(() => {
	const memory = new Map<string, Response>();
	globalThis.caches = {
		default: {
			match: async (key) => {
				const url = typeof key === "string" ? key : key.url;
				const hit = memory.get(url);
				return hit?.clone();
			},
			put: async (key, value) => {
				const url = typeof key === "string" ? key : key.url;
				memory.set(url, value.clone());
			},
		},
	} as CacheStorage;
});

function kvEnv(record: unknown) {
	return {
		LIVE_EVENT_RECORDS: {
			get: async () => (record == null ? null : JSON.stringify(record)),
		},
	} as unknown as Env;
}

describe("playlist availability", () => {
	it("returns a holding master playlist before start so players keep polling", async () => {
		const event = makeEvent({
			slug: "ypsigrock",
			scheduledStart: Math.floor(Date.now() / 1000) + 3600,
		});
		const res = await app.request("/v1/events/ypsigrock/master.m3u8", {}, kvEnv(event));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("mpegurl");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.text();
		expect(body).toContain("#EXTM3U");
		expect(body).toContain("/v1/events/ypsigrock/v/");
		expect(body).not.toContain("#EXT-X-ENDLIST");
	});

	it("returns a holding media playlist with MAP, no segments, no ENDLIST", async () => {
		const event = makeEvent({
			slug: "ypsigrock",
			scheduledStart: Math.floor(Date.now() / 1000) + 3600,
		});
		const res = await app.request("/v1/events/ypsigrock/v/1080p.m3u8", {}, kvEnv(event));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-playback-phase")).toBe("pre_start");
		const body = await res.text();
		expect(body).toContain("#EXT-X-MAP:");
		expect(body).not.toContain("#EXTINF:");
		expect(body).not.toContain("#EXT-X-ENDLIST");
	});

	it("returns 410 JSON when the event has ended without replay", async () => {
		const event = makeEvent({
			slug: "ypsigrock",
			scheduledStart: Math.floor(Date.now() / 1000) - 3600,
			durationSeconds: 40,
			replayMode: "none",
		});
		const res = await app.request("/v1/events/ypsigrock/master.m3u8", {}, kvEnv(event));
		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({
			error: { messages: ["Live stream has ended"], type: "failed_request" },
		});
	});

	it("returns 404 for an unknown slug", async () => {
		const res = await app.request("/v1/events/missing/master.m3u8", {}, kvEnv(null));
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Event not found");
	});

	it("allows Range on CORS preflight so Safari can fetch CMAF segments", async () => {
		const res = await app.request("/v1/events/ypsigrock/v/1080p.m3u8", {
			method: "OPTIONS",
			headers: {
				Origin: "https://example.com",
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "range",
			},
		}, kvEnv(null));
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("range");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});
