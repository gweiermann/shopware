#!/usr/bin/env bash
# Cookbook self-check — keeps the verified examples from drifting silently.
#
# Each references/cookbook/<name>/ holds a RUNNABLE example: fixtures.json (the seed graph) +
# reproduction-plan.json whose assertions encode the DOCUMENTED HEALTHY response. This seeds each
# example on the running shop and requires the leg to classify `not_reproduced` — i.e. a healthy
# shop still matches what the cookbook documents. If Shopware drifts (a field renamed, a value
# changed, the documented field is actually volatile), an assertion fails, the status flips to
# `reproduced`, and this exits non-zero so the example/cookbook gets fixed.
#
# Reuses the real pipeline (seed.sh + run-leg.sh → run-http.sh) — no separate assertion logic.
#
# Env: APP_URL (req), SW_ACCESS_KEY (store-api key, req for store-api examples),
#      SHOP_DIR (default shop; seed.sh reindexes <SHOP_DIR>/bin/console), ADMIN_USER/ADMIN_PASS.
set -uo pipefail

COOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$COOK/../../bin" && pwd)"
: "${APP_URL:?APP_URL is required}"

fail=0; n=0
for plan in "$COOK"/*/reproduction-plan.json; do
  [ -f "$plan" ] || continue
  dir=$(dirname "$plan"); name=$(basename "$dir"); n=$((n + 1))
  echo "::group::cookbook self-check — $name"
  rm -f fixtures.json reproduction-plan.json result.json
  [ -f "$dir/fixtures.json" ] && cp "$dir/fixtures.json" fixtures.json
  cp "$plan" reproduction-plan.json

  if [ -f fixtures.json ]; then PAYLOAD=fixtures.json bash "$BIN/execute/seed.sh" || { echo "❌ $name — seeding failed"; fail=1; echo "::endgroup::"; continue; }; fi
  TARGET=cookbook OUT=result.json REPRO_PLAN=reproduction-plan.json bash "$BIN/execute/run-leg.sh" >/dev/null 2>&1 || true

  status=$(jq -r '.status // "missing"' result.json 2>/dev/null || echo missing)
  jq -r '.assertion.checks[]? | "  \(.role)/\(.op) \(.subject) expect=\(.expected) got=\(.actual) ok=\(.ok)"' result.json 2>/dev/null || true
  if [ "$status" = not_reproduced ]; then
    echo "✅ $name — matches a healthy shop"
  else
    echo "❌ $name — DRIFT (status=$status). The example no longer matches a healthy shop:"
    echo "   $(jq -r '.evidence.reporter_output // .blocked_reason // ""' result.json 2>/dev/null)"
    echo "   → fix the example (and the cookbook prose it documents), or the underlying behaviour changed."
    fail=1
  fi
  echo "::endgroup::"
done

[ "$n" -gt 0 ] || { echo "::warning::no cookbook examples found under $COOK"; }
[ "$fail" = 0 ] && echo "cookbook self-check: all $n example(s) OK" || echo "::error::cookbook self-check: drift detected"
exit "$fail"
