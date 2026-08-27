import { describe, expect, it } from "vitest";
import { signAssetPath, signAssetUrl, verifySignedAssetPath } from "../src/lib/asset-sign.js";
import { assetSignatureTtl, buildPlaylistContext, createUrlSigner, preserveAuthQuery } from "../src/lib/playlist.js";
import { computeWindow, renderMediaPlaylistAsync } from "../src/manifest/index.js";
import { N, S, TEST_START, makeEvent, parseSegmentIndices, windowInput } from "./helpers.js";

const WORKER_ASSETS = "http://localhost:8787/v1/assets/demo";
const SECRET = "test-secret";

describe("asset signing", () => {
	it("round-trips a valid signature", async () => {
		const path = "/v1/assets/demo/video/720p/seg_00001.m4s";
		const sig = await signAssetPath(path, TEST_START + 300, SECRET);
		expect(await verifySignedAssetPath(path, TEST_START + 300, sig, SECRET, TEST_START)).toBe(true);
	});

	it("rejects expired, tampered, and wrong-path signatures", async () => {
		const path = "/v1/assets/demo/video/720p/seg_00001.m4s";
		const exp = TEST_START + 300;
		const sig = await signAssetPath(path, exp, SECRET);
		expect(await verifySignedAssetPath(path, exp, sig, SECRET, exp + 1)).toBe(false);
		expect(await verifySignedAssetPath(path, exp + 60, sig, SECRET, TEST_START)).toBe(false);
		expect(await verifySignedAssetPath("/v1/assets/demo/video/720p/seg_00002.m4s", exp, sig, SECRET, TEST_START)).toBe(false);
		expect(await verifySignedAssetPath(path, exp, "AAAA", SECRET, TEST_START)).toBe(false);
	});

	it("appends se/sg params to the URL", async () => {
		const url = new URL(await signAssetUrl(`${WORKER_ASSETS}/video/720p/init.mp4`, TEST_START + 300, SECRET));
		expect(url.searchParams.get("se")).toBe(String(TEST_START + 300));
		expect(url.searchParams.get("sg")).toBeTruthy();
	});
});

describe("createUrlSigner", () => {
	const opts = { sessionSecret: SECRET, assetSignatureTtl: 300 };

	it("signs worker asset URLs for gated events", async () => {
		const event = makeEvent({ gate: "email", storageBaseUrl: WORKER_ASSETS });
		const sign = createUrlSigner(event, TEST_START, opts);
		const url = new URL(await sign(`${WORKER_ASSETS}/video/1080p/seg_00001.m4s`));
		expect(Number(url.searchParams.get("se"))).toBe(TEST_START + 300);
		expect(url.searchParams.get("sg")).toBeTruthy();
	});

	it("leaves worker asset URLs untouched for open events", async () => {
		const event = makeEvent({ storageBaseUrl: WORKER_ASSETS });
		const sign = createUrlSigner(event, TEST_START, opts);
		expect(await sign(`${WORKER_ASSETS}/video/1080p/init.mp4`)).toBe(`${WORKER_ASSETS}/video/1080p/init.mp4`);
	});

	it("Bunny-signs external CDN URLs for paid events", async () => {
		const event = makeEvent({ gate: "paid" });
		const sign = createUrlSigner(event, TEST_START, { ...opts, bunnyTokenKey: "bunny-secret" });
		const url = new URL(await sign("https://cdn.example.b-cdn.net/assets/abc123/video/1080p/seg_00001.m4s"));
		expect(url.searchParams.get("token")).toBeTruthy();
		expect(Number(url.searchParams.get("expires"))).toBeGreaterThan(TEST_START);
	});

	it("does not Bunny-sign for email gate", async () => {
		const event = makeEvent({ gate: "email" });
		const sign = createUrlSigner(event, TEST_START, { ...opts, bunnyTokenKey: "bunny-secret" });
		const url = await sign("https://cdn.example.b-cdn.net/assets/abc123/video/1080p/seg_00001.m4s");
		expect(url).not.toContain("token=");
	});
});

describe("assetSignatureTtl", () => {
	it("is short for sliding live windows", () => {
		const event = makeEvent({ gate: "email" });
		const ctx = buildPlaylistContext(event, TEST_START + 5 * S);
		expect(assetSignatureTtl(ctx)).toBe(Math.max(300, event.windowSize * S + 120));
	});

	it("is long for seekable VOD playlists", () => {
		const event = makeEvent({ gate: "email", replayMode: "vod" });
		const ctx = buildPlaylistContext(event, TEST_START + N * S + 10);
		expect(assetSignatureTtl(ctx)).toBe(3600 + event.durationSeconds + 3600);
	});

	it("is long for joinFromStart EVENT playlists", () => {
		const event = makeEvent({ gate: "email", joinFromStart: true });
		const ctx = buildPlaylistContext(event, TEST_START + 5 * S);
		expect(assetSignatureTtl(ctx)).toBe(3600 + event.durationSeconds + 3600);
	});
});

describe("renderMediaPlaylistAsync with gated signer", () => {
	it("stamps every asset URL with a verifiable signature", async () => {
		const event = makeEvent({ gate: "email", storageBaseUrl: WORKER_ASSETS });
		const window = computeWindow(windowInput(event, TEST_START + 7 * S));
		const sign = createUrlSigner(event, TEST_START + 7 * S, { sessionSecret: SECRET, assetSignatureTtl: 300 });
		const playlist = await renderMediaPlaylistAsync({ event, track: event.video[0], window, signUrl: sign });

		expect(parseSegmentIndices(playlist).length).toBe(window.windowEnd - window.windowStart + 1);
		for (const line of playlist.split("\n")) {
			if (line.includes("/v1/assets/") && !line.startsWith("#")) {
				const url = new URL(line);
				const ok = await verifySignedAssetPath(
					url.pathname,
					Number(url.searchParams.get("se")),
					url.searchParams.get("sg") ?? "",
					SECRET,
					TEST_START + 7 * S,
				);
				expect(ok).toBe(true);
			}
		}
	});
});

describe("preserveAuthQuery", () => {
	it("keeps only the token param", () => {
		expect(preserveAuthQuery("http://x/v1/events/demo/master.m3u8?token=abc&foo=1")).toBe("?token=abc");
		expect(preserveAuthQuery("http://x/v1/events/demo/master.m3u8")).toBe("");
	});
});
