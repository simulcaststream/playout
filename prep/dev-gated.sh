#!/usr/bin/env bash
# One-command gated dev session:
#   sets gate=email on the event, makes it live now, mints a scoped viewer JWT,
#   prints the tokened player URL (and copies it to the clipboard on macOS),
#   then starts wrangler dev.
#
# usage: pnpm dev:gated [slug=demo]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG=${1:-demo}
RECORD="$ROOT/prep/out/$SLUG/kv-record.json"

if [ ! -f "$RECORD" ]; then
  echo "missing $RECORD — run prep/package.sh first" >&2
  exit 1
fi

# wrangler dev reads secrets from .dev.vars; make sure the gate has one.
if [ ! -f "$ROOT/.dev.vars" ] || ! grep -q '^SESSION_JWT_SECRET=' "$ROOT/.dev.vars"; then
  echo "SESSION_JWT_SECRET=local-dev-secret" >> "$ROOT/.dev.vars"
  echo "added SESSION_JWT_SECRET=local-dev-secret to .dev.vars"
fi

jq '.gate = "email"' "$RECORD" > "$RECORD.tmp" && mv "$RECORD.tmp" "$RECORD"
"$ROOT/prep/set-start.sh" "$SLUG" now >/dev/null 2>&1

TOKEN=$(node "$ROOT/prep/mint-token.mjs" "$SLUG")
URL="http://localhost:8787/player/$SLUG?token=$TOKEN"

echo ""
echo "gated player ($SLUG, gate=email, live now, token expires in 1h):"
echo ""
echo "  $URL"
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$URL" | pbcopy
  echo "  (copied to clipboard)"
fi
echo ""
echo "negative tests:"
echo "  http://localhost:8787/player/$SLUG                  <- no token, playlists 401"
echo "  node prep/mint-token.mjs $SLUG --expired            <- expired token"
echo ""

exec npx wrangler dev
