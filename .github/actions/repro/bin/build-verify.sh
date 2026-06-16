#!/usr/bin/env bash
# Verify the repro bundle on the CURRENT live instance: reset DB to the clean snapshot (if one
# exists) + clear cache, seed fixtures, run the deterministic executor → write a result JSON.
# The single "run the bundle on this instance" entry point, used three ways:
#   - the agent's self-verify (no args)         → TARGET=builder, OUT=builder-result.json
#   - the reported leg on the builder instance  → TARGET=reported, OUT=result.json (snapshot ⇒ reset)
#   - a fresh-provisioned trunk leg could use it → TARGET=trunk,    OUT=result.json (no snapshot ⇒ no reset)
#
# WHY a no-arg wrapper for the agent: its allowedTools entry is a command PREFIX, so any
# `VAR=value bash …` prefix fails the match and triggers an approval the unattended run can't
# grant. The agent runs `bash …/build-verify.sh` with NO prefix; deterministic workflow steps
# (not the agent) set TARGET/OUT via env, which is fine in a `run:` block.
#
# GUARANTEE: this ALWAYS writes $OUT. On any failure path (no plan, seed failed, executor
# couldn't run) it writes a `blocked` result with the reason, so the caller reports an
# actionable cause instead of a missing file.
set -uo pipefail # NOT -e: failures are handled explicitly so the result file is always written

PLAN=repro-plan.json
TARGET=${TARGET:-builder}
OUT=${OUT:-builder-result.json}

emit_blocked () { # <reason> — synthesize a blocked result so $OUT always exists
  local reason="$1" issue executor version
  issue=$(jq -r '.issue // 0' "$PLAN" 2>/dev/null || echo 0)
  executor=$(jq -r '.executor // "unknown"' "$PLAN" 2>/dev/null || echo unknown)
  version=$(jq -r '.version // "?"' "$PLAN" 2>/dev/null || echo '?')
  jq -n --argjson issue "${issue:-0}" --arg target "$TARGET" --arg version "$version" --arg executor "${executor:-unknown}" --arg reason "$reason" '{
      schema_version:"1", issue:$issue, target:$target, version:$version, executor:$executor,
      status:"blocked", assertion:{expect:null,actual:null,matched:null}, duration_s:0,
      evidence:{script:"", script_lang:"sh", reporter_output:$reason, http:[], artifacts:[], truncated:false},
      blocked_reason:$reason }' > "$OUT"
  echo "::error::build-verify ($TARGET) blocked: $reason"
}

if [ -z "${APP_URL:-}" ]; then
  emit_blocked "APP_URL is not set — the live shop coordinates were not exported on this step"; exit 1
fi
if [ ! -f "$PLAN" ]; then
  emit_blocked "repro-plan.json not found — author the bundle (repro-plan.json + any fixtures/script) before verifying"; exit 1
fi

# Reset the DB to the clean post-install snapshot + clear cache, so THIS run starts fresh — a
# re-seed never collides with a prior run's rows, and no cache entry from a prior run lingers.
# No-op when no snapshot was taken (a freshly-provisioned leg); best-effort (a failed reset just
# runs on the current state).
SNAP=repro-clean-db.sql.gz
if [ -f "$SNAP" ] && [ -n "${DATABASE_URL:-}" ]; then
  echo "== build-verify ($TARGET): resetting DB to clean snapshot + clearing cache =="
  if source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh" \
     && gunzip -c "$SNAP" | mysql -h"$DBH" -P"$DBP" -u"$DBU" ${DBPW:+-p"$DBPW"} "$DBN"; then
    SHOP=${SHOP_DIR:-shop}
    [ -x "$SHOP/bin/console" ] && ( cd "$SHOP" && APP_ENV=prod php bin/console cache:pool:clear --all >/dev/null 2>&1 ) || true
  else
    echo "::warning::DB reset failed — running on the current state"
  fi
fi

if [ -f fixtures.json ]; then
  echo "== build-verify ($TARGET): seeding fixtures.json =="
  if ! PAYLOAD=fixtures.json bash .github/actions/repro/bin/seed.sh; then
    emit_blocked "seeding fixtures.json failed: $(head -c 300 seed-error.txt 2>/dev/null | tr -d '\r\n' | tr -s ' ')"; exit 1
  fi
else
  echo "== build-verify ($TARGET): no fixtures.json — skipping seed =="
fi

echo "== build-verify ($TARGET): running the executor =="
TARGET="$TARGET" OUT="$OUT" REPRO_PLAN="$PLAN" bash .github/actions/repro/bin/run-leg.sh
rc=$?
# The executor writes $OUT itself (incl. blocked/inconclusive). Only synthesize one if it died
# BEFORE producing any result (e.g. plan missing .executor, transport blew up).
if [ ! -f "$OUT" ]; then
  emit_blocked "the executor exited (code $rc) without producing a result — check repro-plan.json has a valid .executor"; exit 1
fi

echo "== build-verify ($TARGET): done — status=$(jq -r '.status // "?"' "$OUT") =="

# Playwright: point the agent straight at the screenshot it MUST review (so it doesn't burn turns
# hunting test-results/). A status is only trustworthy if the screenshot shows the precondition
# state genuinely rendered.
if [ "$(jq -r '.executor // ""' "$PLAN" 2>/dev/null)" = playwright ]; then
  shot=$(find test-results -name '*.png' 2>/dev/null | head -1)
  if [ -n "$shot" ]; then
    echo "== build-verify: REVIEW THE SCREENSHOT before trusting the status — Read $shot =="
  else
    echo "== build-verify: no screenshot captured (env/run problem?) — do not trust a status without visual evidence =="
  fi
fi
