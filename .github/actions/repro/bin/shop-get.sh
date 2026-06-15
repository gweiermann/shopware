#!/usr/bin/env bash
# Inspect live-shop state via the admin API — the SANCTIONED alternative to hand-rolling
# OAuth + curl/python during Build Repro (a real run wrote a Python urllib script to fetch a
# token and parse JSON:API `.attributes` by hand; this replaces that).
#
# Pre-approved: run with NO env-var prefix (it reads APP_URL + ADMIN_USER/ADMIN_PASS from the
# environment the build step exports), so a single allowedTools entry covers it. Returns FLAT
# JSON (Accept: application/json — no JSON:API `.attributes` nesting), pretty-printed. Read-only.
#
# Usage:
#   bash .github/actions/repro/bin/shop-get.sh <entity> <id>                 # GET /api/<entity>/<id>
#   bash .github/actions/repro/bin/shop-get.sh <entity>                      # search, first 10
#   bash .github/actions/repro/bin/shop-get.sh <entity> --filter field=value # equals filter (repeatable)
#   bash .github/actions/repro/bin/shop-get.sh <entity> --limit 25 --filter active=true
#
# <entity> is the admin resource, hyphenated: sales-channel, cms-page, category, product, ...
# Filter values are coerced (true/false/123 → JSON; anything else → string).
set -euo pipefail

ENTITY=${1:-}
if [ -z "$ENTITY" ] || [ "$ENTITY" = "-h" ] || [ "$ENTITY" = "--help" ]; then
  echo "usage: shop-get.sh <entity> [<id> | --filter field=value ... | --limit N]"; exit 0
fi
shift

: "${APP_URL:?APP_URL is not set (the build step exports it)}"
BASE=${APP_URL%/}
USER=${ADMIN_USER:-admin}
PASS=${ADMIN_PASS:-shopware}

# Parse args: a bare token = entity id (GET by id); --filter field=value (repeatable); --limit N.
ID=""; LIMIT=10; FILTERS="[]"
while [ $# -gt 0 ]; do
  case "$1" in
    --filter)
      kv=${2:?--filter needs field=value}; shift 2
      f=${kv%%=*}; v=${kv#*=}
      vj=$(jq -nc --arg v "$v" 'try ($v|fromjson) catch $v')  # "true"→true, "12"→12, else string (catch binds . to the error, so use $v)
      FILTERS=$(jq -c --arg f "$f" --argjson v "$vj" '. + [{type:"equals",field:$f,value:$v}]' <<<"$FILTERS") ;;
    --limit) LIMIT=${2:?--limit needs a number}; shift 2 ;;
    --*) echo "::error::unknown option '$1'"; exit 1 ;;
    *) ID=$1; shift ;;
  esac
done

# Admin OAuth (first-party password grant; works on a default install).
TOKEN=$(curl -sS --max-time 30 -X POST "$BASE/api/oauth/token" -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"password\",\"client_id\":\"administration\",\"username\":\"$USER\",\"password\":\"$PASS\",\"scopes\":\"write\"}" \
  | jq -r '.access_token // empty')
[ -n "$TOKEN" ] || { echo "::error::admin OAuth token request failed"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json')

if [ -n "$ID" ]; then
  curl -sS --max-time 30 "$BASE/api/$ENTITY/$ID" "${AUTH[@]}" | jq .
else
  BODY=$(jq -nc --argjson limit "$LIMIT" --argjson filter "$FILTERS" \
    '{limit:$limit} + (if ($filter|length) > 0 then {filter:$filter} else {} end)')
  curl -sS --max-time 30 -X POST "$BASE/api/search/$ENTITY" "${AUTH[@]}" -d "$BODY" \
    | jq '{total: .total, data: (.data // [])}'
fi
