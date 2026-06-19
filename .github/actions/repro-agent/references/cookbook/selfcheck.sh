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
# Reuses the real verify path (build-verify.sh: reset DB → seed → run). Each example RESETS to the
# clean snapshot first, so examples can't contaminate each other (e.g. one seeding into the nav
# category that another lists). Take the snapshot on a clean install BEFORE running this (the CI
# job does `db-snapshot.sh` right after provision).
#
# Env: APP_URL (req), SW_ACCESS_KEY (store-api key, req for store-api examples),
#      DATABASE_URL (req — build-verify resets to the snapshot), SHOP_DIR (default shop),
#      ADMIN_USER/ADMIN_PASS.
set -uo pipefail

COOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$COOK/../../bin" && pwd)"
: "${APP_URL:?APP_URL is required}"

fail=0; n=0
for plan in "$COOK"/*/reproduction-plan.json; do
  [ -f "$plan" ] || continue
  dir=$(dirname "$plan"); name=$(basename "$dir"); n=$((n + 1))
  echo "::group::cookbook self-check — $name"
  rm -f fixtures.json reproduction-plan.json result.json builder-result.json repro.spec.ts ReproTest.php
  [ -f "$dir/fixtures.json" ] && cp "$dir/fixtures.json" fixtures.json
  cp "$plan" reproduction-plan.json
  # Carry the executor's artifact too (playwright spec / direct PHPUnit test) so build-verify can
  # run it — store-api/http examples have neither.
  [ -f "$dir/repro.spec.ts" ] && cp "$dir/repro.spec.ts" repro.spec.ts
  [ -f "$dir/ReproTest.php" ] && cp "$dir/ReproTest.php" ReproTest.php

  # build-verify resets to the clean snapshot (isolation) → seeds this example → runs the executor.
  TARGET=cookbook OUT=result.json bash "$BIN/execute/build-verify.sh" >/dev/null 2>&1 || true

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
