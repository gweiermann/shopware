#!/usr/bin/env bash
# `http` executor (v3). Reads the plan (reproduction-plan.json), runs the request — or a request
# SEQUENCE — against the running shop, and evaluates a LIST of assertions on the FINAL response.
#
# Supports:
#  - auth by surface: admin API (/api/...) → admin OAuth Bearer; store API (/store-api/...)
#    → sw-access-key. Chosen per request from its path; the executor owns auth (any auth
#    header the agent wrote is dropped), so an admin-api request is never sent a store key.
#  - install-specific placeholders in path/body/headers/expect, resolved against the shop:
#    {{SC}} {{NAV_CAT}} {{COUNTRY}} {{SALUTATION}} {{SALUTATION2}} {{TAX}} {{CURRENCY}}
#    {{LANGUAGE}} {{STOREFRONT_URL}} {{SW_ACCESS_KEY}} {{SW_CONTEXT_TOKEN}}
#  - multi-step: `requests: [...]`; sw-context-token captured + carried forward; a non-final
#    setup request that isn't 2xx => blocked.
#  - MULTIPLE assertions: `assertions: [ {kind, field?, expect?, op?}, ... ]` (a single
#    `assertion: {...}` is accepted as sugar). Ops: equals (default) | contains | matches |
#    present | absent | gt | lt. Each `expect` is the HEALTHY value.
#  - combine rule: ALL assertions pass => not_reproduced (healthy); ANY fails => reproduced.
#  - false-positive guards (win over the combine rule): a 401/403 (auth rejected before the
#    symptom ran, and not itself asserted), or a value-comparing assertion whose field is
#    unreadable on a non-2xx response => inconclusive, never a bogus "reproduced".
#
# Env: REPRO_PLAN/ANALYSIS, OUT, APP_URL (req), TARGET (req), SW_ACCESS_KEY, ADMIN_USER, ADMIN_PASS
set -euo pipefail

ANALYSIS=${REPRO_PLAN:-${ANALYSIS:-reproduction-plan.json}}
OUT=${OUT:-result.json}
: "${APP_URL:?APP_URL is required}"
: "${TARGET:?TARGET is required}"
BASE=${APP_URL%/}
ACCESS_KEY=${SW_ACCESS_KEY:-}
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASS=${ADMIN_PASS:-shopware}
# shellcheck source=../lib/lib-admin-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/lib-admin-api.sh" # admin_token + resolve_ids (shared with seed.sh)

VERSION=$(jq -r '.version // "unknown"' "$ANALYSIS")
# Normalize the assertions: prefer `assertions: [...]`, fall back to a single `assertion: {...}`.
ASSERTIONS=$(jq -c 'if .assertions then .assertions elif .assertion then [.assertion] else [] end' "$ANALYSIS")
NASRT=$(echo "$ASSERTIONS" | jq 'length')
# A single `request` is treated as a one-element sequence.
REQS=$(jq -c 'if .requests then .requests else [.request] end' "$ANALYSIS")
NREQ=$(echo "$REQS" | jq 'length')

# Plain vars (no associative array → portable to bash 3.2 + the CI's bash 5).
STOREFRONT_URL="$BASE"
SC=""; NAV_CAT=""; COUNTRY=""; SALUTATION=""; SALUTATION2=""; TAX=""; CURRENCY=""; LANGUAGE=""; CUSTOMER_GROUP=""; PAYMENT_METHOD=""

# Auth by surface: the admin API (/api/...) needs an OAuth Bearer token; the store API
# (/store-api/...) uses sw-access-key. Detect whether ANY request targets the admin API.
is_admin_path() { case "$1" in /store-api/*) return 1 ;; /api/*) return 0 ;; *) return 1 ;; esac; }
is_store_path() { case "$1" in /store-api/*) return 0 ;; *) return 1 ;; esac; }
ADMIN_REQ=0; STORE_REQ=0
while IFS= read -r p; do
  is_admin_path "$p" && ADMIN_REQ=1
  is_store_path "$p" && STORE_REQ=1
done < <(echo "$REQS" | jq -r '.[].path // ""')

# Resolve install-specific ids only if the plan references {{...}} beyond the free ones (admin API).
NEED=$(echo "$REQS$ASSERTIONS" | grep -oE '\{\{[A-Z0-9_]+\}\}' | sort -u | tr -d '{}' || true)
NEED_IDS=0
echo "$NEED" | grep -qvE '^(SW_ACCESS_KEY|STOREFRONT_URL|SW_CONTEXT_TOKEN)?$' && NEED_IDS=1

TOKEN=""
if [ "$ADMIN_REQ" = 1 ] || [ "$NEED_IDS" = 1 ] || { [ "$STORE_REQ" = 1 ] && [ -z "$ACCESS_KEY" ]; }; then
  ADMIN_TOKEN=$(admin_token) || { echo "::error::admin OAuth token request failed (needed for admin-api auth / id resolution)"; exit 1; }
  TOKEN="$ADMIN_TOKEN"
fi
if [ "$STORE_REQ" = 1 ] && [ -z "$ACCESS_KEY" ]; then
  SCJ=$(admin_search sales-channel '{"limit":5,"filter":[{"type":"equals","field":"active","value":true}]}') || { echo "::error::store-api access-key resolution failed"; exit 1; }
  ACCESS_KEY=$(printf '%s' "$SCJ" | jq -r '[.data[] | select(.accessKey != null and .accessKey != "") | .accessKey][0] // empty')
  if [ -z "$ACCESS_KEY" ]; then
    echo "::error::could not resolve an active sales-channel access key for store-api auth"
    exit 1
  fi
fi
if [ "$NEED_IDS" = 1 ]; then
  resolve_ids || { echo "::error::install-id resolution failed"; exit 1; }
fi
SW_ACCESS_KEY_V="$ACCESS_KEY"

CTX=""                       # sw-context-token, carried across the sequence
HEAD=$(mktemp); BODYF=$(mktemp); trap 'rm -f "$HEAD" "$BODYF"' EXIT
SCRIPT=""; CODE=""; blocked=""

resolve() { # substitute {{KEY}} placeholders (SALUTATION2 before SALUTATION)
  local s="$1"
  s="${s//\{\{SW_ACCESS_KEY\}\}/$SW_ACCESS_KEY_V}"
  s="${s//\{\{STOREFRONT_URL\}\}/$STOREFRONT_URL}"
  s="${s//\{\{SC\}\}/$SC}"
  s="${s//\{\{NAV_CAT\}\}/$NAV_CAT}"
  s="${s//\{\{COUNTRY\}\}/$COUNTRY}"
  s="${s//\{\{SALUTATION2\}\}/$SALUTATION2}"
  s="${s//\{\{SALUTATION\}\}/$SALUTATION}"
  s="${s//\{\{TAX\}\}/$TAX}"
  s="${s//\{\{CURRENCY\}\}/$CURRENCY}"
  s="${s//\{\{LANGUAGE\}\}/$LANGUAGE}"
  s="${s//\{\{CUSTOMER_GROUP\}\}/$CUSTOMER_GROUP}"
  s="${s//\{\{PAYMENT_METHOD\}\}/$PAYMENT_METHOD}"
  s="${s//\{\{SW_CONTEXT_TOKEN\}\}/$CTX}"
  printf '%s' "$s"
}

for i in $(seq 0 $((NREQ - 1))); do
  R=$(echo "$REQS" | jq -c ".[$i]")
  M=$(echo "$R" | jq -r '.method // "GET"')
  P=$(resolve "$(echo "$R" | jq -r '.path // ""')")
  B=$(resolve "$(echo "$R" | jq -r '.body // ""')")
  CURL=(curl -sS --max-time 30 -o "$BODYF" -D "$HEAD" -w '%{http_code}' -X "$M" "$BASE$P")
  DISP_H=""
  if is_admin_path "$P"; then
    [ -n "$TOKEN" ] && { CURL+=(-H "Authorization: Bearer $TOKEN"); DISP_H=" -H \"Authorization: Bearer [REDACTED_TOKEN]\""; }
  else
    [ -n "$ACCESS_KEY" ] && { CURL+=(-H "sw-access-key: $ACCESS_KEY"); DISP_H=" -H \"sw-access-key: [REDACTED_KEY]\""; }
  fi
  [ -n "$CTX" ] && CURL+=(-H "sw-context-token: $CTX")
  has_ct=0
  while IFS= read -r h; do
    [ -n "$h" ] || continue
    case "$(printf '%s' "$h" | tr 'A-Z' 'a-z')" in sw-access-key:*|authorization:*) continue;; esac
    case "$(printf '%s' "$h" | tr 'A-Z' 'a-z')" in content-type:*) has_ct=1;; esac
    h=$(resolve "$h"); CURL+=(-H "$h"); DISP_H+=" -H \"$h\""
  done < <(echo "$R" | jq -r '.headers // {} | to_entries[] | "\(.key): \(.value)"')
  if [ -n "$B" ] && [ "$has_ct" = 0 ]; then CURL+=(-H "Content-Type: application/json"); DISP_H+=" -H \"Content-Type: application/json\""; fi
  DISP_B=""; [ -n "$B" ] && { CURL+=(--data "$B"); DISP_B=" --data '$B'"; }
  SCRIPT="${SCRIPT}curl -sS -X $M \"\$APP_URL$P\"${DISP_H}${DISP_B}"$'\n'

  if ! CODE=$("${CURL[@]}" 2>/dev/null); then blocked="request $((i + 1)) ($M $P) — transport failure"; break; fi
  T=$(grep -i '^sw-context-token:' "$HEAD" 2>/dev/null | tail -1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//' || true)
  [ -n "$T" ] && CTX="$T"
  if [ "$i" -lt $((NREQ - 1)) ] && ! [[ "$CODE" =~ ^2 ]]; then
    blocked="setup request $((i + 1)) ($M $P) returned HTTP $CODE — $(head -c 1500 "$BODYF" 2>/dev/null | tr -d '\r\n' | tr -s ' ')"; break
  fi
done

# ---- Evaluate EVERY assertion on the FINAL response -------------------------------------------
is2xx=false; [[ "${CODE:-}" =~ ^2 ]] && is2xx=true
# Does any assertion legitimately expect 401/403? Then that code IS the symptom, not an auth fail.
AUTH_ASSERTED=0
echo "$ASSERTIONS" | jq -e 'any(.[]; (.kind=="http_status") and ((.expect|tostring)=="401" or (.expect|tostring)=="403"))' >/dev/null 2>&1 && AUTH_ASSERTED=1

CHECKS="[]"; PRECOND_OK=true; SYMPTOM_OK=true; UNPARSEABLE_NON2XX=false
if [ -z "$blocked" ] && [ "$NASRT" -gt 0 ]; then
  for j in $(seq 0 $((NASRT - 1))); do
    A=$(echo "$ASSERTIONS" | jq -c ".[$j]")
    op=$(echo "$A" | jq -r '.op // "equals"')
    role=$(echo "$A" | jq -r '.role // "assert"'); [ "$role" = "precondition" ] || role="assert"
    field=$(echo "$A" | jq -r '.field // ""')
    akind=$(echo "$A" | jq -r '.kind // (if .field then "response_field" else "http_status" end)')
    exp=$(resolve "$(echo "$A" | jq -r 'if has("expect") then (.expect|tostring) else "" end')")
    if [ "$akind" = "http_status" ]; then
      subject="status"; actual="$CODE"
    else
      case "$field" in .*) subject="response$field" ;; *) subject="response.$field" ;; esac
      actual=$(jq -r "$field" "$BODYF" 2>/dev/null || true); [ -n "$actual" ] || actual="<unparseable>"
    fi
    ok=false
    case "$op" in
      equals)   [ "$actual" = "$exp" ] && ok=true ;;
      contains) case "$actual" in *"$exp"*) ok=true ;; esac ;;
      matches)  printf '%s' "$actual" | grep -qE "$exp" && ok=true ;;
      present)  { [ "$actual" != "<unparseable>" ] && [ "$actual" != null ] && [ -n "$actual" ]; } && ok=true ;;
      absent)   { [ "$actual" = "<unparseable>" ] || [ "$actual" = null ] || [ -z "$actual" ]; } && ok=true ;;
      gt)       awk "BEGIN{exit !(($actual)+0 > ($exp)+0)}" 2>/dev/null && ok=true ;;
      lt)       awk "BEGIN{exit !(($actual)+0 < ($exp)+0)}" 2>/dev/null && ok=true ;;
      *)        op=equals; [ "$actual" = "$exp" ] && ok=true ;;
    esac
    # A failed PRECONDITION invalidates the run (→ inconclusive); a failed symptom assert → reproduced.
    if [ "$role" = "precondition" ]; then [ "$ok" = true ] || PRECOND_OK=false
    else [ "$ok" = true ] || SYMPTOM_OK=false; fi
    # An unreadable value on a non-2xx response only matters for SYMPTOM asserts (a failed precond
    # already routes to inconclusive with a clearer reason).
    if [ "$role" = "assert" ]; then
      case "$op" in equals|contains|matches|gt|lt) { [ "$actual" = "<unparseable>" ] && [ "$is2xx" = false ]; } && UNPARSEABLE_NON2XX=true ;; esac
    fi
    CHECKS=$(echo "$CHECKS" | jq -c --arg s "$subject" --arg role "$role" --arg op "$op" --arg e "$exp" --arg a "$actual" --argjson ok "$ok" \
      '. + [{subject:$s, role:$role, op:$op, expected:$e, actual:$a, ok:$ok}]')
  done
fi

# ---- Decide the leg status. Order: blocked → auth guard → PRECONDITION → unreadable → symptom. -
# Preconditions gate everything: if the scenario wasn't set up correctly, the symptom verdict can't
# be trusted, so the leg is `inconclusive` (a human looks) — never a bogus `reproduced`.
REASON_TEXT=""
if [ -n "$blocked" ]; then
  STATUS="blocked"; CHECKS="[]"; REASON_TEXT="$blocked"; REPORTER="$blocked"
elif [ "$NASRT" -eq 0 ]; then
  STATUS="inconclusive"; CHECKS="[]"; REASON_TEXT="the plan declares no assertions"; REPORTER="$REASON_TEXT"
elif { [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; } && [ "$AUTH_ASSERTED" = 0 ]; then
  STATUS="inconclusive"; CHECKS="[]"
  REASON_TEXT="request returned HTTP $CODE (authentication/authorization rejected) before the symptom could run — harness-credential failure, not the reported bug. body: $(head -c 500 "$BODYF" 2>/dev/null | tr -d '\r\n' | tr -s ' ')"
  REPORTER="$REASON_TEXT"
elif [ "$PRECOND_OK" = false ]; then
  # A precondition failed → the scenario state is invalid; keep the checks so the human sees which.
  STATUS="inconclusive"
  FAILS=$(echo "$CHECKS" | jq -r '[.[] | select(.role=="precondition" and .ok==false) | .subject + " (expected " + .expected + ", got " + .actual + ")"] | join("; ")')
  BODY_SNIP=""
  if [ "$is2xx" = false ]; then
    BODY_SNIP=" body: $(head -c 1500 "$BODYF" 2>/dev/null | tr -d '\r\n' | tr -s ' ')"
  fi
  REASON_TEXT="precondition(s) not met: $FAILS — the scenario was not set up as expected, so the symptom could not be evaluated faithfully.$BODY_SNIP"
  REPORTER="precondition(s) not met; HTTP $CODE"
elif [ "$UNPARSEABLE_NON2XX" = true ]; then
  STATUS="inconclusive"; CHECKS="[]"
  REASON_TEXT="final request returned HTTP $CODE and an asserted field was unreadable (likely malformed) — body: $(head -c 1500 "$BODYF" 2>/dev/null | tr -d '\r\n' | tr -s ' ')"
  REPORTER="$REASON_TEXT"
elif [ "$SYMPTOM_OK" = true ]; then
  STATUS="not_reproduced"; REPORTER="all assertions passed; HTTP $CODE"
else
  NFAIL=$(echo "$CHECKS" | jq '[.[] | select(.role=="assert" and .ok==false)] | length')
  STATUS="reproduced"; REPORTER="$NFAIL symptom assertion(s) failed; HTTP $CODE"
fi

{ echo '#!/usr/bin/env bash'; echo '# Reproduction request(s) — set $APP_URL (executor injects auth: sw-access-key or admin Bearer, + sw-context-token).'; printf '%s' "$SCRIPT"; } > repro.sh

MATCHED=false; [ "$STATUS" = "not_reproduced" ] && MATCHED=true
jq -n \
  --argjson issue "$(jq -r '.issue' "$ANALYSIS")" \
  --arg target "$TARGET" --arg version "$VERSION" --arg status "$STATUS" \
  --argjson matched "$MATCHED" --arg script "$SCRIPT" --arg reporter "$REPORTER" \
  --argjson code "${CODE:-0}" --argjson checks "$CHECKS" --arg reason_text "$REASON_TEXT" '{
    schema_version: "1", issue: $issue, target: $target, version: $version, executor: "http",
    status: $status,
    assertion: { matched: $matched, checks: $checks },
    duration_s: 0,
    evidence: { script: $script, script_lang: "sh", reporter_output: $reporter,
      http: [{ status: $code }], artifacts: [], truncated: false },
    blocked_reason: (if $reason_text == "" then null else $reason_text end)
  }' > "$OUT"

echo "status=$STATUS  ($REPORTER)"
