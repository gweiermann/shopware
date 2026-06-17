#!/usr/bin/env bash
# Shared admin-API helpers for the reproduce harness. SOURCE this — do not exec it:
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/lib-admin-api.sh"
#
# Single source of truth for OAuth + install-id resolution, shared by seed.sh, run-http.sh
# and shop-get.sh. The resolver used to be copy-pasted in seed.sh and run-http.sh and they
# diverged once (a real bug); keep it here only.
#
# Requires APP_URL in the environment. ADMIN_USER / ADMIN_PASS default to the install
# defaults (admin / shopware). All requests use Accept: application/json (FLAT response —
# id + nested fields at top level, not JSON:API .attributes).
#
# Provides:
#   admin_token              prints (and caches in $ADMIN_TOKEN) the OAuth access token
#   admin_search <e> <body>  POST /api/search/<e>  → raw JSON
#   admin_get <e> <id>       GET  /api/<e>/<id>     → raw JSON
#   resolve_ids              sets globals SC NAV_CAT STOREFRONT_URL COUNTRY SALUTATION
#                            SALUTATION2 TAX CURRENCY LANGUAGE from the running shop
#
# Efficiency: call `ADMIN_TOKEN=$(admin_token)` (or resolve_ids, which does it) ONCE up
# front — admin_search/admin_get reuse $ADMIN_TOKEN, so the token is fetched a single time.

# Idempotent source guard (explicit if — a bare `&& return` would trip the caller's set -e).
if [ -n "${__LIB_ADMIN_API:-}" ]; then return 0 2>/dev/null || true; fi
__LIB_ADMIN_API=1

ADMIN_API_BASE="${APP_URL:-}"; ADMIN_API_BASE="${ADMIN_API_BASE%/}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-shopware}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

# Fetch + cache the admin OAuth token (first-party password grant; works on a default
# install). Prints it. Returns 1 (with an ::error::) if the grant fails.
admin_token () {
  if [ -n "${ADMIN_TOKEN:-}" ]; then printf '%s' "$ADMIN_TOKEN"; return 0; fi
  : "${ADMIN_API_BASE:?APP_URL is required}"
  local t
  t=$(curl -sS --max-time 30 -X POST "$ADMIN_API_BASE/api/oauth/token" \
        -H 'Content-Type: application/json' \
        -d "{\"grant_type\":\"password\",\"client_id\":\"administration\",\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\",\"scopes\":\"write\"}" \
      | jq -r '.access_token // empty')
  if [ -z "$t" ]; then echo "::error::admin OAuth token request failed ($ADMIN_API_BASE/api/oauth/token)" >&2; return 1; fi
  ADMIN_TOKEN="$t"
  printf '%s' "$t"
}

# Internal: emit the auth headers as curl args on stdout, one per line.
_admin_auth_args () {
  if [ -z "${ADMIN_TOKEN:-}" ]; then ADMIN_TOKEN=$(admin_token) || return 1; fi
}

# admin_search <entity> <json-body> → search response JSON (flat shape).
admin_search () {
  local entity="$1" body="$2"
  _admin_auth_args || return 1
  curl -sS --max-time 30 -X POST "$ADMIN_API_BASE/api/search/$entity" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -d "$body"
}

# admin_get <entity> <id> → single-entity response JSON (flat shape).
admin_get () {
  local entity="$1" id="$2"
  _admin_auth_args || return 1
  curl -sS --max-time 30 "$ADMIN_API_BASE/api/$entity/$id" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Accept: application/json'
}

# resolve_ids → set the canonical install-id globals the {{...}} placeholders map to.
# Fetches the token once, then one search per id family.
resolve_ids () {
  _admin_auth_args || return 1
  local scj sals dom
  scj=$(admin_search sales-channel '{"limit":1,"filter":[{"type":"equals","field":"active","value":true}]}') || return 1
  SC=$(printf '%s' "$scj"  | jq -r '.data[0].id // empty')
  NAV_CAT=$(printf '%s' "$scj" | jq -r '.data[0].navigationCategoryId // empty')
  # storefrontUrl must be a registered SC domain (a headless default SC has none), NOT APP_URL.
  dom=$(admin_search sales-channel-domain '{"limit":1}' | jq -r '.data[0].url // empty')
  STOREFRONT_URL="${dom:-$ADMIN_API_BASE}"
  COUNTRY=$(admin_search country '{"limit":1,"filter":[{"type":"equals","field":"active","value":true}]}' | jq -r '.data[0].id // empty')
  sals=$(admin_search salutation '{"limit":2}')
  SALUTATION=$(printf '%s' "$sals"  | jq -r '.data[0].id // empty')
  SALUTATION2=$(printf '%s' "$sals" | jq -r '.data[1].id // .data[0].id // empty')
  TAX=$(admin_search tax '{"limit":1}' | jq -r '.data[0].id // empty')
  CURRENCY=$(admin_search currency '{"limit":1,"filter":[{"type":"equals","field":"isoCode","value":"EUR"}]}' | jq -r '.data[0].id // empty')
  LANGUAGE=$(admin_search language '{"limit":1}' | jq -r '.data[0].id // empty')
}
