#!/usr/bin/env bash
# Live integration test for the admin-API scripts against a REAL Shopware instance.
#
# Exercises lib-admin-api.sh (token / search / resolve_ids), shop-get.sh (GET-by-id + search
# + filter coercion), seed.sh (placeholder resolution + sync upsert, verified by reading the
# entity back) and run-http.sh (store-api auth, admin-api auth, {{placeholder}} resolution).
#
# Usage:
#   APP_URL=http://trunk.shopware.local bash .github/actions/repro/tests/live.sh
# APP_URL defaults to http://trunk.shopware.local. SW_ACCESS_KEY is resolved from the shop
# when not provided. Idempotent: the seeded product uses a fixed id (upsert), so re-runs are
# safe. NOT run in CI — this is a local tool against a dev instance.
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
BIN="$REPO/.github/actions/repro/bin"
export APP_URL="${APP_URL:-http://trunk.shopware.local}"
export ADMIN_USER="${ADMIN_USER:-admin}"
export ADMIN_PASS="${ADMIN_PASS:-shopware}"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT; cd "$WORK"
pass=0; fail=0
ok ()   { echo "  ok   $1"; pass=$((pass+1)); }
bad ()  { echo "  FAIL $1"; fail=$((fail+1)); }
check (){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$2' got '$3'"; fi; }
ge ()   { if [ "${2:-0}" -ge "$3" ] 2>/dev/null; then ok "$1 ($2 >= $3)"; else bad "$1 — got '$2', need >= $3"; fi; }

echo "instance: $APP_URL"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$APP_URL/admin" || echo 000)
[ "$code" != 000 ] || { echo "::error::$APP_URL not reachable (HTTP $code) — is docker compose up?"; exit 1; }

# ── lib-admin-api.sh ────────────────────────────────────────────────────────
echo "lib-admin-api.sh:"
# shellcheck source=../bin/lib-admin-api.sh
source "$BIN/lib-admin-api.sh"
TOK=$(admin_token); [ -n "$TOK" ] && ok "admin_token returns a token" || bad "admin_token empty"
SCJSON=$(admin_search product '{"limit":1}'); check "admin_search returns JSON with .total" true "$(echo "$SCJSON" | jq -e 'has("total")' >/dev/null 2>&1 && echo true || echo false)"
resolve_ids
[ -n "${SC:-}" ]       && ok "resolve_ids → SC"       || bad "resolve_ids SC empty"
[ -n "${NAV_CAT:-}" ]  && ok "resolve_ids → NAV_CAT"  || bad "resolve_ids NAV_CAT empty"
[ -n "${TAX:-}" ]      && ok "resolve_ids → TAX"      || bad "resolve_ids TAX empty"
[ -n "${CURRENCY:-}" ] && ok "resolve_ids → CURRENCY" || bad "resolve_ids CURRENCY empty"

# Store-api access key for the run-http store leg (resolve from the active Storefront SC).
SW_ACCESS_KEY=${SW_ACCESS_KEY:-$(admin_search sales-channel '{"limit":1,"filter":[{"type":"equals","field":"active","value":true},{"type":"equals","field":"typeId","value":"8a243080f92e4c719546314b577cf82b"}]}' | jq -r '.data[0].accessKey // empty')}
[ -n "$SW_ACCESS_KEY" ] || SW_ACCESS_KEY=$(admin_search sales-channel '{"limit":25}' | jq -r '[.data[]|select(.accessKey)][0].accessKey // empty')
export SW_ACCESS_KEY

# ── shop-get.sh ─────────────────────────────────────────────────────────────
echo "shop-get.sh:"
SC_TOTAL=$(bash "$BIN/shop-get.sh" sales-channel | jq -r '.total // 0'); ge "search returns sales channels" "$SC_TOTAL" 1
GOT_ID=$(bash "$BIN/shop-get.sh" sales-channel "$SC" | jq -r '.data.id // empty'); check "GET-by-id returns the entity" "$SC" "$GOT_ID"
FILT_TOTAL=$(bash "$BIN/shop-get.sh" sales-channel --filter active=true | jq -r '.total // 0'); ge "filter active=true (bool coercion)" "$FILT_TOTAL" 1

# ── seed.sh (+ verify via shop-get) ─────────────────────────────────────────
echo "seed.sh:"
PID="0192fa11ce5170008000000000000001"
cat > fixtures.json <<JSON
{ "product": { "entity": "product", "action": "upsert", "payload": [
  { "id": "$PID", "productNumber": "REPRO-IT-1", "name": "Repro Integration Test Product",
    "stock": 10, "taxId": "{{TAX}}",
    "price": [{ "currencyId": "{{CURRENCY}}", "gross": 19.99, "net": 16.8, "linked": true }] } ] } }
JSON
if PAYLOAD=fixtures.json bash "$BIN/seed.sh" >seed.log 2>&1; then ok "seed.sh upsert succeeded"; else bad "seed.sh failed"; sed 's/^/    /' seed.log; fi
SEEDED_PN=$(bash "$BIN/shop-get.sh" product "$PID" | jq -r '.data.productNumber // empty')
check "seeded product reads back (placeholders resolved + synced)" "REPRO-IT-1" "$SEEDED_PN"

# Negative: a HARDCODED install id (literal tax id instead of {{TAX}}) must be REJECTED —
# this is the guard against the FK-1452 failure that only surfaces on a fresh matrix instance.
cat > bad-fixtures.json <<JSON
{ "product": { "entity": "product", "action": "upsert", "payload": [
  { "id": "0192fa11ce5170008000000000000002", "productNumber": "REPRO-IT-2", "name": "Bad",
    "stock": 1, "taxId": "$TAX",
    "price": [{ "currencyId": "{{CURRENCY}}", "gross": 1, "net": 1, "linked": true }] } ] } }
JSON
if PAYLOAD=bad-fixtures.json bash "$BIN/seed.sh" >bad.log 2>&1; then bad "seed.sh accepted a hardcoded install id (should reject)"; else
  grep -q "hardcodes an install-specific id" bad.log && ok "seed.sh rejects a hardcoded install id" || bad "seed.sh failed but not with the hardcoded-id error: $(tail -1 bad.log)"
fi

# ── run-http.sh: store-api auth ─────────────────────────────────────────────
echo "run-http.sh (store-api):"
cat > plan-store.json <<'JSON'
{ "schema_version":"1","issue":0,"executor":"http","version":"test",
  "request": { "method":"GET","path":"/store-api/context","headers":{"Accept":"application/json"} },
  "assertion": { "kind":"http_status","expect":"200","locator":"/store-api/context" } }
JSON
TARGET=builder REPRO_PLAN=plan-store.json OUT=res-store.json bash "$BIN/run-http.sh" >/dev/null 2>&1
check "store-api GET /store-api/context → not_reproduced (200==200)" not_reproduced "$(jq -r .status res-store.json 2>/dev/null)"

# ── run-http.sh: admin-api auth + {{placeholder}} resolution ────────────────
echo "run-http.sh (admin-api + placeholder):"
cat > plan-admin.json <<'JSON'
{ "schema_version":"1","issue":0,"executor":"http","version":"test",
  "request": { "method":"GET","path":"/api/tax/{{TAX}}","headers":{"Accept":"application/json"} },
  "assertion": { "kind":"http_status","expect":"200","locator":"/api/tax/{{TAX}}" } }
JSON
TARGET=builder REPRO_PLAN=plan-admin.json OUT=res-admin.json bash "$BIN/run-http.sh" >/dev/null 2>&1
check "admin GET /api/tax/{{TAX}} → not_reproduced (auth + resolve OK)" not_reproduced "$(jq -r .status res-admin.json 2>/dev/null)"
# The generated script must show the placeholder RESOLVED to a real id, never a literal {{TAX}}.
if jq -r '.evidence.script' res-admin.json 2>/dev/null | grep -q '{{TAX}}'; then bad "placeholder left unresolved in evidence"; else ok "placeholder resolved in the request"; fi

# Cleanup: delete the product the seed test created (keeps the dev instance tidy).
curl -s -o /dev/null -X DELETE "$APP_URL/api/product/$PID" -H "Authorization: Bearer $(admin_token)" || true

echo
echo "PASS: $pass  FAIL: $fail"
[ "$fail" = 0 ]
