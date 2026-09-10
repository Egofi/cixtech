#!/usr/bin/env bash
# End-to-end smoke test against a running dev server (default http://localhost:3000).
# Exercises the tenant flow + the new money-out guardrails. Usage:  bash apps/api/smoke.sh
set -euo pipefail
B="${BASE_URL:-http://localhost:3000}"
ADMIN="${CIXTECH_ADMIN_TOKEN:-dev-admin-token}"
DEST="TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
jq() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }

echo "# health";  curl -s "$B/health";  echo
echo "# ready";   curl -s "$B/ready";   echo

echo "# admin: create tenant"
T=$(curl -s -X POST "$B/admin/api/tenants" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"acme"}')
KEY=$(echo "$T" | jq '.apiKey'); echo "apiKey=$KEY"

echo "# tenant: chains";  curl -s "$B/v1/chains" -H "x-api-key: $KEY"; echo
echo "# tenant: create account"
AID=$(curl -s -X POST "$B/v1/accounts" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"externalRef":"m1"}' | jq '.id')
echo "accountId=$AID"

echo "# tenant: deposit address"
curl -s -X POST "$B/v1/accounts/$AID/deposit-addresses" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"chain":"TRON","asset":"USDT"}'; echo
echo "# tenant: balance"
curl -s "$B/v1/accounts/$AID/balance?asset=USDT" -H "x-api-key: $KEY"; echo

echo "# tenant: add allow-list dest (cool-down applies)"
curl -s -X POST "$B/v1/accounts/$AID/allowlist" -H "x-api-key: $KEY" -H 'content-type: application/json' -d "{\"chain\":\"TRON\",\"address\":\"$DEST\"}"; echo
echo "# tenant: payout now -> DENIED (still cooling)"
curl -s -X POST "$B/v1/accounts/$AID/withdrawals" -H "x-api-key: $KEY" -H 'idempotency-key: s1' -H 'content-type: application/json' -d "{\"chain\":\"TRON\",\"asset\":\"USDT\",\"amount\":\"1000\",\"destination\":\"$DEST\"}"; echo

echo "# tenant: activity reads (portal surface)"
curl -s "$B/v1/balances" -H "x-api-key: $KEY"; echo
curl -s "$B/v1/payouts?limit=5" -H "x-api-key: $KEY"; echo
curl -s "$B/v1/allowlist" -H "x-api-key: $KEY"; echo

echo "# admin: engage + read + reset kill-switch"
curl -s -X POST "$B/admin/api/killswitch/engage" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"reason":"drill"}'; echo
curl -s "$B/admin/api/overview" -H "authorization: Bearer $ADMIN" | jq '({killSwitch:$.killSwitchEngaged, counts:$.counts})' 2>/dev/null || true; echo
curl -s -X POST "$B/admin/api/killswitch/reset" -H "authorization: Bearer $ADMIN" >/dev/null; echo "reset done"
echo "OK — open $B/admin (Bearer $ADMIN) and $B/docs in a browser"
