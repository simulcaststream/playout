# Local development & testing

How to run the calculated-live Worker on your machine and verify playlists, segments, and gated auth.

Event metadata lives in a Cloudflare KV namespace bound as **`LIVE_EVENT_RECORDS`**
(intentionally not named `EVENTS`, to avoid clashing with other platforms). All Wrangler
KV commands below use `--binding=LIVE_EVENT_RECORDS`.

## Prerequisites

- Node 20+ and [pnpm](https://pnpm.io/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (comes with `pnpm install`)
- Cloudflare account login: `npx wrangler login` (needed once for R2/KV namespace create; local `--local` data stays on disk)
- Python 3 + venv (only if you package video with Shaka)

Secrets for local gated tests live in `.dev.vars` (already gitignored). Example:

```
SESSION_JWT_SECRET=local-dev-secret
```

## One-time setup

```sh
pnpm install

# Python tools for packaging (skip if you already have prep/out/demo/)
python3 -m venv .venv
.venv/bin/pip install --upgrade pip shaka-streamer shaka-streamer-binaries

# Create bindings (first time only)
npx wrangler r2 bucket create calculated-live-segments
npx wrangler kv namespace create LIVE_EVENT_RECORDS
```

Paste the KV namespace id into [`wrangler.toml`](../wrangler.toml) under the
`LIVE_EVENT_RECORDS` binding’s `id` field.

## Fast path (asset already packaged)

If `prep/out/demo/` already exists (cdn + `kv-record.json`):

```sh
# Ensure local KV has the event
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local

# Make it live now (updates file + KV)
prep/set-start.sh demo now

# Start Worker
pnpm dev
```

Open: [http://localhost:8787/player/demo](http://localhost:8787/player/demo)

## Full path (package a new video)

```sh
# usage: prep/package.sh <input-video> [slug] [segment_seconds]
prep/package.sh /path/to/movie.mp4 demo 4
```

That encodes with Shaka, uploads to **local** R2, and writes `prep/out/demo/kv-record.json`.

Then load KV and run:

```sh
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local

prep/set-start.sh demo now
pnpm dev
```

Re-upload without re-encoding:

```sh
prep/upload-r2.sh demo --local
```

## Smoke checks (Worker running)

```sh
# Health
curl -s http://localhost:8787/health

# Master + media playlists (open gate)
curl -s http://localhost:8787/v1/events/demo/master.m3u8 | head
curl -s http://localhost:8787/v1/events/demo/v/720p.m3u8 | head

# Segment / init (expect 200)
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8787/v1/assets/demo/video/720p/init.mp4
```

Before go-live (`scheduledStart` in the future), playlists return **404**. Set start with:

```sh
prep/set-start.sh demo now      # live (started ~60s ago)
prep/set-start.sh demo +120     # starts in 2 minutes
prep/set-start.sh demo -30      # started 30s ago
```

## Unit tests (no Worker needed)

```sh
pnpm test          # once
pnpm test:watch    # watch mode
pnpm check         # TypeScript
```

These cover window math, playlist rendering, JWT/cookie gate, and segment HMAC stamps.

## Gated playback (email / paid)

### Quick: one-command gated session

Packages must already exist under `prep/out/<slug>/`.

```sh
pnpm dev:gated          # slug=demo
pnpm dev:gated my-event # other slug
```

This sets `gate=email`, makes the event live, mints a JWT, prints a tokened player URL, and starts `wrangler dev`.

Example URL:

```
http://localhost:8787/player/demo?token=<JWT>
```

Negative checks printed by the script:

- Player **without** token → playlists **401**
- `node prep/mint-token.mjs demo --expired` → expired JWT

### Manual: mint token + curl

```sh
# Ensure gate=email in KV
jq '.gate = "email"' prep/out/demo/kv-record.json > /tmp/kv.json \
  && mv /tmp/kv.json prep/out/demo/kv-record.json
prep/set-start.sh demo now

TOKEN=$(node prep/mint-token.mjs demo)
echo "$TOKEN"

# Playlist with ?token=
curl -s "http://localhost:8787/v1/events/demo/master.m3u8?token=$TOKEN" | head

# Playlist with Bearer (mobile-style)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/v1/events/demo/master.m3u8 | head

# No auth → 401
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:8787/v1/events/demo/master.m3u8
```

### Cookie (website-style)

Same JWT as above, sent as HttpOnly cookie `cl_session` (paywall sets this in production):

```sh
TOKEN=$(node prep/mint-token.mjs demo)

curl -s -H "Cookie: cl_session=$TOKEN" \
  http://localhost:8787/v1/events/demo/master.m3u8 | head
```

Media playlists stamped with `?se=&sg=` still work **without** the cookie (Cast / mobile segment path):

```sh
# Fetch media playlist with cookie/Bearer, then copy a stamped segment URL and:
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:8787/v1/assets/demo/video/720p/seg_00000.m4s?se=...&sg=..."
```

### Wrong-slug token → 403

```sh
BAD=$(node prep/mint-token.mjs other-slug)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $BAD" \
  http://localhost:8787/v1/events/demo/master.m3u8
```

## Timing & replay knobs

Edit `prep/out/demo/kv-record.json`, then **reload KV** (or use `prep/set-start.sh`):

| Field | Useful local values |
|---|---|
| `scheduledStart` | Epoch seconds; use `set-start.sh` |
| `replayMode` | `vod` (seekable after end), `loop`, `none` (404 after end) |
| `joinFromStart` | `true` = EVENT playlist from segment 0 |
| `gate` | `open`, `email`, `paid` |

Worker reads **KV**, not the file on disk. After edits:

```sh
npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "demo" \
  --path=prep/out/demo/kv-record.json --local
```

## Checklist

| Step | Command / URL |
|---|---|
| Install | `pnpm install` |
| Create KV | `wrangler kv namespace create LIVE_EVENT_RECORDS` |
| Package (once) | `prep/package.sh movie.mp4 demo 4` |
| Load KV | `wrangler kv key put --binding=LIVE_EVENT_RECORDS … --local` |
| Go live | `prep/set-start.sh demo now` |
| Unit tests | `pnpm test` |
| Dev server | `pnpm dev` or `pnpm dev:gated` |
| Player | http://localhost:8787/player/demo |
| OpenAPI | http://localhost:8787/openapi.json |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Playlists 404 | Event not started — `prep/set-start.sh demo now` |
| Playlists 401 | Gated event — use cookie, Bearer, or `?token=` |
| Segment 401 with `se`/`sg` | Signature expired or wrong secret — refresh media playlist |
| Empty / missing video | Re-run `prep/upload-r2.sh demo --local` or `package.sh` |
| KV edits ignored | Must `kv key put --binding=LIVE_EVENT_RECORDS --local` after editing JSON |
| Gate 503 | Missing `SESSION_JWT_SECRET` in `.dev.vars` |
| Wrong KV / clash with other apps | Use binding `LIVE_EVENT_RECORDS`, not `EVENTS` |

More detail on production storage, Bunny, and cookie attributes: [README.md](../README.md).
