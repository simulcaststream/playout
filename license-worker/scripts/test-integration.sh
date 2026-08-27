#!/usr/bin/env bash
set -euo pipefail

BASE="${LICENSE_API_URL:-http://localhost:8788}"
EMAIL="buyer-test-$(date +%s)@example.com"
DEVICE_A="device-a-$(date +%s)"
DEVICE_B="device-b-$(date +%s)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_code() {
  local got="$1"
  local want="$2"
  local label="$3"
  [[ "$got" == "$want" ]] || fail "$label expected HTTP $want, got $got"
}

echo "License API: $BASE"
curl -sf "$BASE/health" >/dev/null || fail "health check failed"

echo "1. purchase webhook"
curl -sf -X POST "$BASE/webhook/purchase" \
  -H "Content-Type: application/json" \
  ${WEBHOOK_SECRET:+-H "x-webhook-secret: $WEBHOOK_SECRET"} \
  -d "{\"email\":\"$EMAIL\",\"purchase_id\":\"test-purchase-1\"}" >/dev/null

echo "2. unpaid login -> 402"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/license/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"notpaid@example.com"}')
expect_code "$code" "402" "unpaid login"

echo "3. magic link login"
login=$(curl -sf -X POST "$BASE/license/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\"}")
token=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$login")

echo "4. verify login device A"
verify=$(curl -sf -X POST "$BASE/license/verify-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$token\",\"deviceId\":\"$DEVICE_A\"}")
jwt=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$verify")

echo "5. second device within grace -> 409"
login2=$(curl -sf -X POST "$BASE/license/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\"}")
token2=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$login2")
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/license/verify-login" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$token2\",\"deviceId\":\"$DEVICE_B\"}")
expect_code "$code" "409" "grace period seat lock"

echo "6. heartbeat"
curl -sf -X POST "$BASE/license/heartbeat" \
  -H "Authorization: Bearer $jwt" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$DEVICE_A\"}" >/dev/null

if curl -sf "$BASE/health" >/dev/null; then
  dev_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/license/dev-login" \
    -H "Content-Type: application/json" \
    -d '{"email":"dev@example.com","deviceId":"dev-device-test"}')
  if [[ "$dev_code" == "200" ]]; then
    echo "7. dev login ok"
  else
    echo "7. dev login skipped (HTTP $dev_code — set ALLOW_DEV_LOGIN=1 for local dev)"
  fi
fi

echo "PASS: payment + license integration ($EMAIL)"
