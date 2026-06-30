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
source "$(dirname "${BASH_SOURCE[0]}")/../lib/lib-admin-api.sh" # admin_token, admin_search, resolve_ids

php_can_run_shopware_cli () {
  command -v php >/dev/null 2>&1 || return 1
  php -r 'exit(extension_loaded("pdo_mysql") && extension_loaded("mbstring") ? 0 : 1);' >/dev/null 2>&1
}

refresh_indexer_via_admin_api () {
  local indexer="$1"
  local offset=0
  local steps=0
  local max_steps=${REPRO_INDEX_MAX_STEPS:-1000}

  case "$max_steps" in
    ''|*[!0-9]*|0) max_steps=1000 ;;
  esac

  while :; do
    steps=$((steps + 1))
    if [ "$steps" -gt "$max_steps" ]; then
      echo "::warning::indexer $indexer did not finish after $max_steps HTTP iterations"
      return 1
    fi

    local req resp code finish next_offset
    req=$(jq -nc --argjson offset "$offset" '{offset:$offset}')
    resp=$(mktemp)
    code=$(curl -sS --max-time 120 -o "$resp" -w '%{http_code}' \
      -X POST "$ADMIN_API_BASE/api/_action/indexing/$indexer" "${AUTH[@]}" --data "$req")

    if [ "$code" != "200" ]; then
      echo "::warning::indexer $indexer HTTP refresh failed (HTTP $code): $(head -c 300 "$resp" | tr -d '\r\n' | tr -s ' ')"
      rm -f "$resp"
      return 1
    fi

    finish=$(jq -r '.finish // false' "$resp" 2>/dev/null || echo false)
    if [ "$finish" = true ]; then
      rm -f "$resp"
      return 0
    fi

    next_offset=$(jq -c '.offset.offset // .offset // null' "$resp" 2>/dev/null || echo null)
    rm -f "$resp"
    if [ "$next_offset" = null ]; then
      echo "::warning::indexer $indexer HTTP refresh returned no next offset"
      return 1
    fi
    offset="$next_offset"
  done
}

refresh_indexes_via_admin_api () {
  local indexers=${REPRO_INDEXERS:-"category.indexer product.indexer product_stream.indexer landing_page.indexer"}
  local indexer
  local failed=0

  echo "refreshing storefront indexes via admin API..."
  for indexer in $indexers; do
    refresh_indexer_via_admin_api "$indexer" || failed=1
  done
  return "$failed"
}

# A plan with no fixtures is valid (e.g. demodata:false + the bug needs no seed data).
if [ ! -f "$PAYLOAD" ]; then
  echo "no fixtures payload ($PAYLOAD) — nothing to seed"
  exit 0
fi

ORIGINAL_PAYLOAD="$PAYLOAD"

# The sync API requires an OPERATION envelope per key: {entity, action, payload:[...]}.
# Normalize each operation to the sync API's shape, forgiving two recurring agent mistakes:
#  - bare shape {"product": [ {...} ]} (a real 400: FRAMEWORK__INVALID_SYNC_OPERATION) → wrap as
#    an upsert envelope;
#  - hyphenated entity names like "property-group" (a real 500: FRAMEWORK__DEFINITION_NOT_FOUND)
#    → snake_case. No Shopware entity name contains a hyphen, so the substitution is always safe.
WRAPPED=$(mktemp)
jq 'del(._repro_media_uploads) | with_entries(
      if (.value | type) == "array"
      then .value = { entity: (.key | gsub("-"; "_")), action: "upsert", payload: .value }
      else .value.entity = ((.value.entity // .key) | gsub("-"; "_"))
      end
    )' "$PAYLOAD" > "$WRAPPED" || { echo "::error::fixtures payload is not valid JSON"; exit 1; }
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
for kv in "SC:$SC" "NAV_CAT:$NAV_CAT" "TAX:$TAX" "CURRENCY:$CURRENCY" "COUNTRY:$COUNTRY" "SALUTATION:$SALUTATION" "SALUTATION2:$SALUTATION2" "LANGUAGE:$LANGUAGE" "CUSTOMER_GROUP:$CUSTOMER_GROUP" "PAYMENT_METHOD:$PAYMENT_METHOD" "SHIPPING_METHOD:$SHIPPING_METHOD" "ORDER_STATE_OPEN:$ORDER_STATE_OPEN" "ORDER_DELIVERY_STATE_OPEN:$ORDER_DELIVERY_STATE_OPEN" "ORDER_TRANSACTION_STATE_OPEN:$ORDER_TRANSACTION_STATE_OPEN"; do
  k=${kv%%:*}; v=${kv#*:}
  if [ -n "$v" ] && grep -qF "$v" "$PAYLOAD"; then
    echo "::error::fixtures.json hardcodes an install-specific id ($v) — reference it with the {{$k}} placeholder instead. Each provisioned instance generates different UUIDs, so a literal id seeds on the builder but FK-fails on the reported/trunk legs."
    { printf 'fixtures hardcode the install {{%s}} id (%s); use the placeholder' "$k" "$v"; } > seed-error.txt
    exit 1
  fi
done

# Fail loud if a referenced placeholder resolved to EMPTY (else we'd POST an empty UUID).
for kv in "SC:$SC" "NAV_CAT:$NAV_CAT" "TAX:$TAX" "CURRENCY:$CURRENCY" "COUNTRY:$COUNTRY" "SALUTATION:$SALUTATION" "SALUTATION2:$SALUTATION2" "LANGUAGE:$LANGUAGE" "CUSTOMER_GROUP:$CUSTOMER_GROUP" "PAYMENT_METHOD:$PAYMENT_METHOD" "SHIPPING_METHOD:$SHIPPING_METHOD" "ORDER_STATE_OPEN:$ORDER_STATE_OPEN" "ORDER_DELIVERY_STATE_OPEN:$ORDER_DELIVERY_STATE_OPEN" "ORDER_TRANSACTION_STATE_OPEN:$ORDER_TRANSACTION_STATE_OPEN"; do
  k=${kv%%:*}; v=${kv#*:}
  if grep -q "{{$k}}" "$PAYLOAD" && [ -z "$v" ]; then
    echo "::error::could not resolve {{$k}} (admin search returned empty)"; exit 1
  fi
done

OUT=$(mktemp)
ORIGINAL_OUT=$(mktemp)
sed -e "s/{{SC}}/$SC/g" -e "s/{{NAV_CAT}}/$NAV_CAT/g" -e "s/{{TAX}}/$TAX/g" -e "s/{{CURRENCY}}/$CURRENCY/g" \
    -e "s/{{COUNTRY}}/$COUNTRY/g" -e "s/{{SALUTATION2}}/$SALUTATION2/g" -e "s/{{SALUTATION}}/$SALUTATION/g" -e "s/{{LANGUAGE}}/$LANGUAGE/g" \
    -e "s/{{CUSTOMER_GROUP}}/$CUSTOMER_GROUP/g" -e "s/{{PAYMENT_METHOD}}/$PAYMENT_METHOD/g" -e "s/{{SHIPPING_METHOD}}/$SHIPPING_METHOD/g" \
    -e "s/{{ORDER_STATE_OPEN}}/$ORDER_STATE_OPEN/g" -e "s/{{ORDER_DELIVERY_STATE_OPEN}}/$ORDER_DELIVERY_STATE_OPEN/g" \
    -e "s/{{ORDER_TRANSACTION_STATE_OPEN}}/$ORDER_TRANSACTION_STATE_OPEN/g" "$PAYLOAD" > "$OUT"
sed -e "s/{{SC}}/$SC/g" -e "s/{{NAV_CAT}}/$NAV_CAT/g" -e "s/{{TAX}}/$TAX/g" -e "s/{{CURRENCY}}/$CURRENCY/g" \
    -e "s/{{COUNTRY}}/$COUNTRY/g" -e "s/{{SALUTATION2}}/$SALUTATION2/g" -e "s/{{SALUTATION}}/$SALUTATION/g" -e "s/{{LANGUAGE}}/$LANGUAGE/g" \
    -e "s/{{CUSTOMER_GROUP}}/$CUSTOMER_GROUP/g" -e "s/{{PAYMENT_METHOD}}/$PAYMENT_METHOD/g" -e "s/{{SHIPPING_METHOD}}/$SHIPPING_METHOD/g" \
    -e "s/{{ORDER_STATE_OPEN}}/$ORDER_STATE_OPEN/g" -e "s/{{ORDER_DELIVERY_STATE_OPEN}}/$ORDER_DELIVERY_STATE_OPEN/g" \
    -e "s/{{ORDER_TRANSACTION_STATE_OPEN}}/$ORDER_TRANSACTION_STATE_OPEN/g" "$ORIGINAL_PAYLOAD" > "$ORIGINAL_OUT"

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

UPLOAD_COUNT=$(jq -r '._repro_media_uploads // [] | length' "$ORIGINAL_OUT")
if [ "$UPLOAD_COUNT" != "0" ]; then
  echo "uploading $UPLOAD_COUNT fixture media file(s)…"
  for i in $(seq 0 $((UPLOAD_COUNT - 1))); do
    media_id=$(jq -r --argjson i "$i" '._repro_media_uploads[$i].mediaId // empty' "$ORIGINAL_OUT")
    file_path=$(jq -r --argjson i "$i" '._repro_media_uploads[$i].path // empty' "$ORIGINAL_OUT")
    extension=$(jq -r --argjson i "$i" '._repro_media_uploads[$i].extension // empty' "$ORIGINAL_OUT")
    mime_type=$(jq -r --argjson i "$i" '._repro_media_uploads[$i].mimeType // empty' "$ORIGINAL_OUT")
    file_name=$(jq -r --argjson i "$i" '._repro_media_uploads[$i].fileName // empty' "$ORIGINAL_OUT")

    if [ -z "$media_id" ] || [ -z "$file_path" ] || [ -z "$extension" ] || [ -z "$mime_type" ]; then
      echo "::error::_repro_media_uploads[$i] requires mediaId, path, extension, and mimeType"
      exit 1
    fi
    if [ ! -f "$file_path" ]; then
      echo "::error::_repro_media_uploads[$i].path does not exist: $file_path"
      exit 1
    fi

    query="extension=$extension"
    if [ -n "$file_name" ]; then
      query="${query}&fileName=$(jq -rn --arg v "$file_name" '$v|@uri')"
    fi

    RESP_UPLOAD=$(mktemp)
    CODE_UPLOAD=$(curl -sS --max-time 60 -o "$RESP_UPLOAD" -w '%{http_code}' \
      -X POST "$ADMIN_API_BASE/api/_action/media/$media_id/upload?$query" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: $mime_type" -H 'Accept: application/json' \
      --data-binary @"$file_path")
    if [ "$CODE_UPLOAD" != "200" ] && [ "$CODE_UPLOAD" != "204" ] && [ "$CODE_UPLOAD" != "302" ]; then
      echo "::error::media upload failed for $media_id (HTTP $CODE_UPLOAD)"; cat "$RESP_UPLOAD"
      { printf 'media upload HTTP %s for %s: ' "$CODE_UPLOAD" "$media_id"; jq -r '[.errors[]?.detail] | join("; ")' "$RESP_UPLOAD" 2>/dev/null || head -c 300 "$RESP_UPLOAD"; } \
        | head -c 400 > seed-error.txt
      exit 1
    fi
  done
fi

# Storefront indexers don't run on their own in CI (no queue worker), so a freshly-synced
# product/category/CMS page won't appear in listings, sliders, nav or SEO URLs until indexed.
# Prefer the admin API because it runs inside the live Shopware process and still works from the
# gh-aw sandbox. Fall back to the local CLI only when the API path is unavailable.
if refresh_indexes_via_admin_api; then
  echo "refreshed storefront indexes via admin API"
else
  echo "::warning::admin API index refresh failed — trying local Shopware CLI fallback"
  SHOP=${SHOP_DIR:-shop}
  if [ ! -x "$SHOP/bin/console" ]; then
    echo "::warning::no local Shopware console found; seeded entities may not be indexed/visible"
    exit 0
  fi
  if php_can_run_shopware_cli; then
    echo "refreshing DAL index so seeded entities are visible in the storefront…"
    ( cd "$SHOP" && APP_ENV=prod php bin/console dal:refresh:index --no-interaction ) \
      || echo "::warning::dal:refresh:index failed — seeded entities may not be indexed/visible"
  else
    echo "::warning::skipping dal:refresh:index because this shell's PHP cannot run Shopware CLI (missing pdo_mysql or mbstring); seeded entities may not be indexed/visible"
  fi
fi
