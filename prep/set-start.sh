#!/usr/bin/env bash
# Update scheduledStart in kv-record.json and reload local KV in one step.
#
# usage:
#   prep/set-start.sh demo now              # already live (60s ago)
#   prep/set-start.sh demo +120             # starts in 2 minutes
#   prep/set-start.sh demo 1783504800       # explicit epoch seconds
#   prep/set-start.sh demo -30              # started 30s ago
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG=${1:?usage: prep/set-start.sh <slug> <now|+seconds|-seconds|epoch>}
WHEN=${2:?usage: prep/set-start.sh <slug> <now|+seconds|-seconds|epoch>}
RECORD="$ROOT/prep/out/$SLUG/kv-record.json"

if [ ! -f "$RECORD" ]; then
  echo "missing $RECORD — run prep/package.sh first" >&2
  exit 1
fi

NOW=$(date +%s)
case "$WHEN" in
  now) START=$((NOW - 60)) ;;
  +*) START=$((NOW + ${WHEN#+})) ;;
  -*) START=$((NOW - ${WHEN#-})) ;;
  *) START=$WHEN ;;
esac

jq --argjson start "$START" '.scheduledStart = $start' "$RECORD" > "$RECORD.tmp"
mv "$RECORD.tmp" "$RECORD"

echo "scheduledStart=$START ($(date -r "$START" 2>/dev/null || date -d "@$START" 2>/dev/null || echo epoch))"

npx wrangler kv key put --binding=LIVE_EVENT_RECORDS "$SLUG" --path="$RECORD" --local

echo ""
echo "Verify (404 before go-live, 200 once live):"
echo "  curl -s -o /dev/null -w 'master %{http_code}\\n' http://localhost:8787/v1/events/$SLUG/master.m3u8"
echo "  curl -s -o /dev/null -w 'media  %{http_code}\\n' http://localhost:8787/v1/events/$SLUG/v/720p.m3u8"
