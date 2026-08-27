# Desktop app — shipping & licensing

## Product

**Calculated Live** is a $49 one-time desktop app (Tauri). Buyers Shaka-pack locally and deploy the HLS Worker to **their** Cloudflare account. You host a tiny license Worker only — not their video.

## Purchase flow (Stripe)

1. Create a **$49 one-time** product in [Stripe Dashboard](https://dashboard.stripe.com/products) (or use dynamic `price_data` — default $49 USD).
2. Deploy the license Worker and set secrets:

   ```sh
   cd license-worker
   pnpm install
   npx wrangler kv namespace create LICENSE_DATA   # paste id into wrangler.toml
   npx wrangler secret put LICENSE_JWT_SECRET
   npx wrangler secret put STRIPE_SECRET_KEY       # sk_test_... or sk_live_...
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... from Stripe webhook endpoint
   # optional: npx wrangler secret put STRIPE_PRICE_ID
   # optional: npx wrangler secret put RESEND_API_KEY
   npx wrangler deploy
   ```

3. In Stripe Dashboard → **Developers → Webhooks**, add endpoint:

   ```
   POST https://<license-worker>/webhook/stripe
   Events: checkout.session.completed
   ```

4. Desktop app: user enters email → **Buy with Stripe ($49)** → completes Checkout → **Send magic link** with same email.

**Local Stripe testing:**

```sh
pnpm dev:license
stripe listen --forward-to localhost:8788/webhook/stripe
# paste whsec_... into license-worker/.dev.vars as STRIPE_WEBHOOK_SECRET
# add sk_test_... as STRIPE_SECRET_KEY
```

Legacy manual webhook (dev only): `POST /webhook/purchase` with optional `x-webhook-secret` header.

5. Set `ALLOW_DEV_LOGIN=1` in wrangler.toml vars for local dev only.

## Desktop build

```sh
pnpm install
pnpm --dir desktop install
pnpm build:worker-bundle    # bundles HLS worker into desktop resources
pnpm build:desktop-resources  # Shaka + prep scripts into desktop resources
# Dev: Shaka from repo .venv
python3 -m venv .venv && .venv/bin/pip install shaka-streamer shaka-streamer-binaries
pnpm desktop:build          # bundles Python/Shaka + .dmg (see tauri.release.conf.json)
```

**Packaging engine:** Shaka Streamer (`prep/pack-shaka.sh`) with source-matched ladder. Release `.dmg` bundles standalone Python + Shaka under `resources/python/`, prep scripts under `resources/prep/`, and KV normalization in Rust (no Node at runtime). Dev uses repo `.venv` and `prep/`.

Set `LICENSE_API_URL` when running the desktop app:

```sh
LICENSE_API_URL=https://license.yourdomain.com pnpm desktop:dev
```

## App license (one device)

- Magic link login → `POST /license/verify-login` with `deviceId`
- Second machine while heartbeat is fresh (<72h) → **409**
- **Transfer seat** on Live screen → `POST /license/transfer` (7-day cooldown)
- Offline grace: 72h after last heartbeat; JWT cached 7 days

## Viewer PPV (V2 — on buyer's Worker)

V1 ships `gate: "open"`. For PPV:

1. Set `gate: "email"` in KV EventRecord
2. `wrangler secret put SESSION_JWT_SECRET` on **their** Worker
3. `wrangler secret put OPERATOR_SECRET` on **their** Worker
4. Their Stripe webhook calls:

   ```
   POST https://<their-worker>/v1/operator/mint
   Authorization: Bearer <OPERATOR_SECRET>
   { "slug": "my-event", "ttl": 7200, "sub": "order_123" }
   ```

5. Player uses `?token=` or `Authorization: Bearer` (see README access gating)

Keep segments on `/v1/assets/{slug}/` — public R2 URLs bypass the paywall.

## Marketing copy

**Headline:** 24/7 live HLS on *your* Cloudflare. $0 transcoding. $49 once.

**Pitch:** Shaka-pack a local MP4 into ABR CMAF segments on your R2, deploy a Worker that writes a sliding-window `m3u8` from UTC math. No Elemental, no Mux. Buy once; major updates sold separately.

**X thread:** See plan section 2 in `.cursor/plans/72-hour_vod-to-live_4bed80c7.plan.md`

## Programmatic SEO titles

1. Replace AWS Elemental MediaLive with FFmpeg and a Cloudflare Worker you deploy yourself
2. Deploy HLS from your own Cloudflare R2 without a transcoder: desktop packer + dynamic live playlist
3. Add JWT PPV in front of a simulated live HLS stream (Cloudflare Worker + FFmpeg fMP4)
