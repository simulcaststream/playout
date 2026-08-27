# Calculated-Live HLS Manifest Worker

Stateless **TypeScript** Cloudflare Worker (Hono) that serves HLS playlists making
pre-recorded, CDN-hosted fMP4/CMAF video behave like a live stream. "Live" is pure
wall-clock arithmetic over cached event metadata — no transcoding, no Durable Objects,
no WebAssembly. Manifest rendering is string assembly over a small sliding window;
latency is dominated by KV/R2 and optional URL signing, not CPU.

## Layout

- `src/index.ts` — Hono app entry, OpenAPI spec at `/openapi.json`
- `src/manifest/` — pure TypeScript functions (`computePhase`, `computeWindow`, `renderMediaPlaylist`, …)
- `src/routes/` — HTTP handlers (fetch KV, call manifest functions, set cache headers)
- `src/middleware/` — CORS, event loader, access gate (open / email / paid)
- `prep/` — Shaka Streamer packaging, R2 upload, KV record generation
- `desktop/` — **Tauri 2 desktop app** (Shaka pack → deploy to buyer's Cloudflare)
- `license-worker/` — app license service (magic link, one-device seat, purchase webhook)
- `test/` — Vitest suite for §4 arithmetic edge cases
- `docs/local-testing.md` — run and test locally (open + gated auth)
- `docs/desktop-shipping.md` — desktop build, Polar/Lemon webhook, PPV V2

## Desktop app ($49)

Licensed Tauri app: Shaka Streamer packs locally (ABR CMAF), deploy the Worker + R2 + KV to **your** Cloudflare account.

```sh
pnpm install && pnpm --dir desktop install
pnpm build:worker-bundle
LICENSE_API_URL=http://localhost:8788 pnpm desktop:dev   # dev
pnpm desktop:build                                        # release .dmg
```

See [docs/desktop-shipping.md](docs/desktop-shipping.md) for purchase webhooks and PPV V2 (`POST /v1/operator/mint`).


## API

| Route | Description |
|---|---|
| `GET /v1/time` | Server clock `{ now }` (epoch seconds) — optional, not used by HLS players |
| `GET /v1/events/:slug/master.m3u8` | Master playlist (static per asset) |
| `GET /v1/events/:slug/v/:rendition.m3u8` | Video media playlist (computed) |
| `GET /v1/events/:slug/a/:group/:name.m3u8` | Audio media playlist (computed) |
| `GET /v1/assets/:slug/*` | Segment/init bytes from R2 |

## KV event record

Key = event **slug**. Value = JSON (validated with Zod on read). Stored in the
**`LIVE_EVENT_RECORDS`** KV namespace (Worker binding of the same name). The control plane
writes these in production; for local dev, `prep/package.sh` generates `kv-record.json`.

- `scheduledStart` — epoch **seconds** (UTC)

Always use `--binding=LIVE_EVENT_RECORDS` with Wrangler KV commands (not `EVENTS`).

## Segment storage (R2)

Segment and init bytes live in the **SEGMENTS** R2 bucket (`calculated-live-segments`).
Object keys are `{slug}/video/720p/seg_00000.m4s`, etc. The Worker serves them at
`/v1/assets/{slug}/…` with immutable cache headers, `Range`/`If-None-Match` support, and an
edge cache (Cache API) in front of R2. Playlists get a per-segment-boundary edge cache too:
clients always see `Cache-Control: no-store` while live, but the Worker shares one rendered
copy per slug/rendition/segment-boundary (`X-Manifest-Cache: HIT|MISS`).

`storageBaseUrl` in the KV record points at that prefix, e.g.
`http://localhost:8787/v1/assets/demo` for local dev. Override at package time with
`--storage-base-url` (e.g. a Bunny pull zone URL in production).

- `segmentPattern` — 0-based index via `%05d` (e.g. `video/720p/seg_%05d.m4s`)

---

## Local development (full stack)

**Step-by-step guide (open + gated auth, curls, unit tests):** [docs/local-testing.md](docs/local-testing.md).

Two steps: **package** (once per asset — encodes, uploads to local R2, writes KV JSON), then **Worker** (`pnpm dev`).

```
┌─────────────┐   playlists + segments   ┌──────────────────┐
│   Player    │ ───────────────────────► │ Worker :8787     │
│  (browser)  │                          │  (wrangler dev)  │
└─────────────┘                          └────────┬─────────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                             ┌──────────────┐          ┌──────────────┐
                             │  KV (local)  │          │  R2 (local)  │
                             │  event meta  │          │  segment bytes│
                             └──────────────┘          └──────────────┘
```

### 1. Install dependencies

```sh
pnpm install
python3 -m venv .venv
.venv/bin/pip install --upgrade pip shaka-streamer shaka-streamer-binaries
```

### 2. Create R2 bucket + KV namespace (first time only)

```sh
npx wrangler r2 bucket create calculated-live-segments
npx wrangler kv namespace create LIVE_EVENT_RECORDS
```

Paste the KV id into `wrangler.toml` under `[[kv_namespaces]]` where
`binding = "LIVE_EVENT_RECORDS"`.

### 3. Package a video with Shaka Streamer

`prep/package.sh` **deletes any previous output** for the slug, runs Shaka, normalizes
segments to 0-based `seg_%05d.m4s`, **uploads to local R2**, and writes `kv-record.json`.

```sh
# usage: prep/package.sh <input-video> [slug] [segment_seconds]
prep/package.sh /path/to/movie.mp4 demo 4
```

Output:

```
prep/out/demo/
  cdn/                    # local copy (source for R2 upload)
    video/360p/ ...
    video/480p/ ...
    video/720p/ ...
    audio/aac/ ...
  kv-record.json          # storageBaseUrl -> Worker /v1/assets/demo
  hls.m3u8                # Shaka reference master (not used by the Worker)
```

Re-packaging the same slug overwrites `prep/out/<slug>/` and re-uploads R2 objects under `{slug}/`.

To upload an existing `cdn/` tree without re-encoding:

```sh
prep/upload-r2.sh demo --local
```

Shaka configs live in `prep/shaka/` (`input.yaml`, `pipeline.yaml`). Defaults: VOD mode,
**360p / 480p / 720p / 1080p** H.264 ladder (Shaka skips rungs above source resolution),
mono AAC, 4-second segments, fMP4 per-file (`segment_per_file: true`).

Edit `resolutions` in `prep/shaka/pipeline.yaml` to change the ladder, then re-run `prep/package.sh`.

### 4. Load the event record into local KV

```sh
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local
```

Verify:

```sh
npx wrangler kv key get --binding=LIVE_EVENT_RECORDS "demo" --local | head
```

### Update start time (local)

Editing `kv-record.json` alone is not enough — you must reload KV. Use the helper (updates file **and** KV):

```sh
prep/set-start.sh demo now      # live now (started 60s ago)
prep/set-start.sh demo +120     # starts in 2 minutes
prep/set-start.sh demo -30      # started 30 seconds ago
prep/set-start.sh demo 1783504800   # explicit epoch seconds
```

Or manually:

```sh
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local
```

Before go-live, **master** and **media** playlists return **404**; hls.js and other players retry automatically once the event starts:

```sh
curl -s -o /dev/null -w "master %{http_code}\\n" http://localhost:8787/v1/events/demo/master.m3u8
curl -s -o /dev/null -w "media  %{http_code}\\n" http://localhost:8787/v1/events/demo/v/720p.m3u8
```

To update after re-packaging or editing `scheduledStart`, run `kv key put` again (same command). The Worker reads **KV**, not the file on disk — editing `kv-record.json` alone has no effect until you reload it:

```sh
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local
```

To remove:

```sh
npx wrangler kv key delete --binding=LIVE_EVENT_RECORDS "demo" --local
```

### 5. Start the Worker

```sh
pnpm dev
```

### 6. Play or inspect

```sh
# Test player (hls.js; native HLS on Safari)
open http://localhost:8787/player/demo

# Or curl
curl http://localhost:8787/v1/events/demo/master.m3u8
curl http://localhost:8787/v1/events/demo/v/720p.m3u8
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/v1/assets/demo/video/720p/init.mp4
```

The test player loads `master.m3u8` via hls.js. Manifests and segment bytes both come from the Worker
(playlists computed; segments proxied from R2).

Legacy: `prep/serve-cdn.sh` + `storageBaseUrl: http://localhost:9090` if you want a static file
server instead of R2 (pass `--storage-base-url http://localhost:9090` to `build-kv-record.mjs`).

### Timing knobs

`kv-record.json` includes `scheduledStart` (epoch seconds). `prep/package.sh` defaults
to **start in 10 seconds**. To start immediately:

```sh
node prep/build-kv-record.mjs --dir prep/out/demo --slug demo \
  --segment-duration 4 --start-in-seconds -30
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" --path=prep/out/demo/kv-record.json --local
```

Or edit `scheduledStart` directly in the JSON.

| `replayMode` | Behaviour after the event ends |
|---|---|
| `vod` | Full seekable playlist (good for local testing) |
| `none` | Stream over — playlists return **404** (no replay) |
| `loop` | Cycles forever — `MEDIA-SEQUENCE` stays monotonic across cycles and each seam gets `EXT-X-DISCONTINUITY` (+ `EXT-X-DISCONTINUITY-SEQUENCE` once seams roll out of the window). `joinFromStart` is ignored in loop mode. |

| `joinFromStart` | Behaviour during LIVE |
|---|---|
| `false` | Sliding window at live edge (default) |
| `true` | EVENT playlist from segment 0 |

### Unit tests (no CDN or Worker needed)

```sh
pnpm test
```

---

## KV record schema (reference)

```json
{
  "eventId": "evt_demo",
  "slug": "demo",
  "scheduledStart": 1731000000,
  "segmentDuration": 4,
  "totalSegments": 5,
  "durationSeconds": 20,
  "windowSize": 6,
  "joinFromStart": false,
  "replayMode": "vod",
  "gate": "open",
  "storageBaseUrl": "http://localhost:8787/v1/assets/demo",
  "video": [
    { "name": "1080p", "bandwidth": 4128000, "avgBandwidth": 2128000, "codecs": "avc1.640028", "resolution": "1920x1080", "frameRate": 24, "initPath": "video/1080p/init.mp4", "segmentPattern": "video/1080p/seg_%05d.m4s", "audioGroup": "aud" },
    { "name": "720p", "bandwidth": 2128000, "avgBandwidth": 1128000, "codecs": "avc1.64001f", "resolution": "1280x720", "frameRate": 24, "initPath": "video/720p/init.mp4", "segmentPattern": "video/720p/seg_%05d.m4s", "audioGroup": "aud" },
    { "name": "480p", "bandwidth": 1128000, "avgBandwidth": 612000, "codecs": "avc1.4d401f", "resolution": "854x480", "frameRate": 24, "initPath": "video/480p/init.mp4", "segmentPattern": "video/480p/seg_%05d.m4s", "audioGroup": "aud" }
  ],
  "audio": [{ "group": "aud", "name": "English Stereo", "language": "en", "codecs": "mp4a.40.2", "channels": 1, "default": true, "bandwidth": 128000, "initPath": "audio/aac/init.mp4", "segmentPattern": "audio/aac/seg_%05d.m4s" }]
}
```

## Production storage

**Default:** upload `cdn/` to the **SEGMENTS** R2 bucket (`prep/upload-r2.sh demo --remote`) and set
`storageBaseUrl` to your Worker assets URL (`https://your-worker.dev/v1/assets/demo`) or an
[R2 public/custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/) if you
serve bytes without the Worker proxy.

### Bunny CDN (optional)

To use Bunny instead of R2, upload `cdn/` to your pull zone and package with
`--storage-base-url https://your-zone.b-cdn.net/demo`.

1. **CORS** — The pull zone must send permissive CORS headers (`Access-Control-Allow-Origin: *` or your origins) and must not require credentials. Chromecast fetches segments from a different origin than the browser; missing CORS breaks casting while browser playback still works.

2. **Token authentication (paid gate)** — When `gate` is `"paid"`, segment and init URLs are signed with Bunny Token Authentication. Set the pull zone security key as `BUNNY_TOKEN_KEY` via `wrangler secret put BUNNY_TOKEN_KEY`.

Upload packaged `cdn/` contents to your pull zone and set `storageBaseUrl` to the Bunny URL.

## Access gating

| `gate` | Behaviour |
|---|---|
| `open` | No checks |
| `email` | Session required (see below); verified with `SESSION_JWT_SECRET` |
| `paid` | Same session gate **plus** Bunny-signed CDN URLs on external segment/init lines |

The gate applies to **both** playlists (`/v1/events/…`) and segment bytes served by the
Worker (`/v1/assets/…`). If you serve segments from an R2 public/custom domain instead, the
Worker cannot gate those bytes — use Bunny token auth (`paid`) or keep segments behind the Worker.

### How clients authenticate

| Client | Playlists | Segments |
|---|---|---|
| **Website** | HttpOnly `cl_session` cookie (set by your paywall) | Short-lived URL stamps (`se`/`sg`) from the playlist |
| **Mobile app** | `Authorization: Bearer <JWT>` | Same URL stamps (native players send these reliably) |
| **Chromecast** | N/A (no browser cookie) | URL stamps only |
| **Local dev** | `?token=` on the master URL also works | URL stamps |

**Session tokens (JWT, HS256)** are minted by your control plane with `SESSION_JWT_SECRET`:

```json
{ "sub": "viewer-id", "exp": 1731003600, "slug": "jamie-premiere" }
```

- `exp` (required) — set it to event end + replay window + slack.
- `slug` (optional but recommended) — binds the token to one event.

**Web cookie (paywall sets this on the Worker domain):**

```
Set-Cookie: cl_session=<same JWT>; HttpOnly; Secure; Path=/; SameSite=None
```

Use `SameSite=Lax` when the player page is same-site with the Worker. Set `CORS_ORIGINS` in
`wrangler.toml` to your player origins so credentialed fetches work (`Access-Control-Allow-Credentials`).

Avoid `?token=` in production URLs — it leaks in logs and Referer headers. Keep it for the
built-in `/player/:slug` dev page only.

**Segment URLs carry short-lived HMAC signatures, not the session JWT.** Gated playlists stamp each
Worker-hosted segment/init URL with `?se=<expiry>&sg=<HMAC-SHA256(secret, path + expiry)>`:

- Sliding live windows: ~5-minute signatures. A **copied manifest dies within minutes**.
- Seekable playlists (`joinFromStart` EVENT, ended VOD): longer signatures so replay seeking works.

The session JWT never appears in segment request logs, and rendered manifests contain no
per-viewer data — the edge cache shares one manifest across all authorized viewers.

## Secrets

```sh
npx wrangler secret put SESSION_JWT_SECRET
npx wrangler secret put BUNNY_TOKEN_KEY
```

## Deploy

The Worker entrypoint is `src/index.ts` (`wrangler.toml`). There is no custom build
step — `pnpm deploy` bundles TypeScript with Wrangler and uploads it.

```sh
# before first deploy: create bindings and paste the KV id into wrangler.toml
npx wrangler kv namespace create LIVE_EVENT_RECORDS
npx wrangler r2 bucket create calculated-live-segments   # if not already created

# optional secrets for gated events
npx wrangler secret put SESSION_JWT_SECRET
npx wrangler secret put BUNNY_TOKEN_KEY   # paid gate + Bunny CDN only

pnpm check   # tsc --noEmit
pnpm test
pnpm deploy

# production KV (no --local) — binding must be LIVE_EVENT_RECORDS
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "my-event" --path=prep/out/my-event/kv-record.json
```

Smoke-check after deploy:

```sh
curl -sS "https://<your-worker>.workers.dev/health"
curl -sS "https://<your-worker>.workers.dev/v1/events/<slug>/master.m3u8" | head
```

## Legacy ffmpeg prep

`prep/segment.sh` and `prep/build-manifest.mjs` remain as a lighter-weight ffmpeg-only
path. The Worker expects the KV schema above, not `manifest.json` from the old pipeline.
Use Shaka (`prep/package.sh`) for multi-rendition fMP4 output that matches production.
