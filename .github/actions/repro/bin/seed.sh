#!/usr/bin/env bash
# Seed exactly the entities a repro needs, via the admin sync API. NO demodata.
#
# Reads the plan's sync payload (entities the Build Repro phase produced), resolves the
# install-specific placeholders ({{SC}}/{{NAV_CAT}}/{{TAX}}/{{CURRENCY}}) against the
# running shop, and POSTs /api/_action/sync. Idempotent upsert.
#
# Env:
#   APP_URL     base URL of the running shop          (required)
#   PAYLOAD     path to the sync payload JSON          (default: fixtures.json)
#   ADMIN_USER  admin username (default-install: admin)
#   ADMIN_PASS  admin password (default-install: shopware)
set -euo pipefail

: "${APP_URL:?APP_URL is required}"
PAYLOAD="${PAYLOAD:-fixtures.json}"
# shellcheck source=lib-admin-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-admin-api.sh" # admin_token, admin_search, resolve_ids

# A plan with no fixtures is valid (e.g. demodata:false + the bug needs no seed data).
if [ ! -f "$PAYLOAD" ]; then
  echo "no fixtures payload ($PAYLOAD) — nothing to seed"
  exit 0
fi

# The sync API requires an OPERATION envelope per key: {entity, action, payload:[...]}.
# Agents sometimes emit the bare shape {"product": [ {...} ]} instead (a real 400 we hit:
# FRAMEWORK__INVALID_SYNC_OPERATION). Auto-wrap bare entity→array keys into upserts.
WRAPPED=$(mktemp)
jq 'with_entries(if (.value|type) == "array"
      then .value = {entity: .key, action: "upsert", payload: .value}
      else . end)' "$PAYLOAD" > "$WRAPPED" || { echo "::error::fixtures payload is not valid JSON"; exit 1; }
PAYLOAD="$WRAPPED"

# 1. Token + install-id resolution (shared with run-http.sh via lib-admin-api.sh).
TOKEN=$(admin_token) || { echo "::error::admin token request failed"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json')
resolve_ids || { echo "::error::could not resolve install ids"; exit 1; }

# Guard: reject HARDCODED install-specific ids. Pre-existing install entities (tax, currency,
# sales channel, country, salutation, language, nav category) MUST be referenced via the
# {{PLACEHOLDER}}, never by a literal id read off one instance — every provisioned shop
# generates different UUIDs, so a literal id seeds fine on the builder but FK-fails (SQL 1452)
# on the freshly-provisioned reported/trunk legs (a real failure we hit). This runs on the
# builder too (where the ids match), so build-verify catches it before the matrix ever runs.
for kv in "SC:$SC" "NAV_CAT:$NAV_CAT" "TAX:$TAX" "CURRENCY:$CURRENCY" "COUNTRY:$COUNTRY" "SALUTATION:$SALUTATION" "SALUTATION2:$SALUTATION2" "LANGUAGE:$LANGUAGE"; do
  k=${kv%%:*}; v=${kv#*:}
  if [ -n "$v" ] && grep -qF "$v" "$PAYLOAD"; then
    echo "::error::fixtures.json hardcodes an install-specific id ($v) — reference it with the {{$k}} placeholder instead. Each provisioned instance generates different UUIDs, so a literal id seeds on the builder but FK-fails on the reported/trunk legs."
    { printf 'fixtures hardcode the install {{%s}} id (%s); use the placeholder' "$k" "$v"; } > seed-error.txt
    exit 1
  fi
done

# Fail loud if a referenced placeholder resolved to EMPTY (else we'd POST an empty UUID).
for kv in "SC:$SC" "NAV_CAT:$NAV_CAT" "TAX:$TAX" "CURRENCY:$CURRENCY" "COUNTRY:$COUNTRY" "SALUTATION:$SALUTATION" "SALUTATION2:$SALUTATION2" "LANGUAGE:$LANGUAGE"; do
  k=${kv%%:*}; v=${kv#*:}
  if grep -q "{{$k}}" "$PAYLOAD" && [ -z "$v" ]; then
    echo "::error::could not resolve {{$k}} (admin search returned empty)"; exit 1
  fi
done

OUT=$(mktemp)
sed -e "s/{{SC}}/$SC/g" -e "s/{{NAV_CAT}}/$NAV_CAT/g" -e "s/{{TAX}}/$TAX/g" -e "s/{{CURRENCY}}/$CURRENCY/g" \
    -e "s/{{COUNTRY}}/$COUNTRY/g" -e "s/{{SALUTATION2}}/$SALUTATION2/g" -e "s/{{SALUTATION}}/$SALUTATION/g" -e "s/{{LANGUAGE}}/$LANGUAGE/g" "$PAYLOAD" > "$OUT"

# Fail loud if any placeholder is still unresolved (would seed broken entities).
if grep -q '{{' "$OUT"; then
  echo "::error::unresolved placeholder(s) in sync payload:"; grep -o '{{[^}]*}}' "$OUT" | sort -u
  exit 1
fi

# 3. Upsert the entities.
RESP=$(mktemp)
CODE=$(curl -sS --max-time 60 -o "$RESP" -w '%{http_code}' -X POST "$ADMIN_API_BASE/api/_action/sync" "${AUTH[@]}" --data @"$OUT")
if [ "$CODE" != "200" ] && [ "$CODE" != "204" ]; then
  echo "::error::sync failed (HTTP $CODE)"; cat "$RESP"
  # Persist the API's validation detail so leg-blocked.sh can surface it in the report —
  # a buried 400 made repeated invalid-fixture rolls undiagnosable from the issue side.
  { printf 'sync HTTP %s: ' "$CODE"; jq -r '[.errors[]?.detail] | join("; ")' "$RESP" 2>/dev/null || head -c 300 "$RESP"; } \
    | head -c 400 > seed-error.txt
  exit 1
fi
echo "seeded OK (sync HTTP $CODE; SC=$SC nav=$NAV_CAT tax=$TAX cur=$CURRENCY)"
