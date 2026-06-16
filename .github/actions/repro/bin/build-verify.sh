#!/usr/bin/env bash
# ONE-command builder self-verification for the Build Repro agent.
#
# WHY THIS EXISTS: the agent's allowedTools entries are command PREFIXES
# (`Bash(bash .github/actions/repro/bin/build-verify.sh:*)`). The moment the agent prepends
# env vars — `TARGET=builder OUT=… bash …/run-leg.sh` — the command no longer *starts* with
# `bash`, so it fails the prefix match and triggers an approval prompt the unattended run can
# never grant. In a real run the agent burned ~34 turns ($) fighting exactly that, and even
# edited run-leg.sh to get around it. This wrapper takes NO arguments and NO env prefix, so a
# single allowedTools entry covers it: the agent runs `bash .github/actions/repro/bin/build-verify.sh`
# and nothing else. It hardcodes the builder semantics that used to be passed as env vars.
#
# It reads the live-shop coordinates already exported on the agent's step (APP_URL,
# SW_ACCESS_KEY, ADMIN_USER, ADMIN_PASS), seeds fixtures.json when present, then runs the
# deterministic executor as the `builder` leg → builder-result.json. Read that file afterward.
#
# GUARANTEE: this ALWAYS writes builder-result.json. On any failure path (no plan, seed
# failed, executor couldn't run) it writes a `blocked` result with the reason, so the
# downstream check reports an actionable cause instead of "builder-result.json missing".
set -uo pipefail # NOT -e: failures are handled explicitly so the result file is always written

PLAN=repro-plan.json
OUT=builder-result.json

emit_blocked () { # <reason> — synthesize a blocked builder-result so the file always exists
  local reason="$1" issue executor
  issue=$(jq -r '.issue // 0' "$PLAN" 2>/dev/null || echo 0)
  executor=$(jq -r '.executor // "unknown"' "$PLAN" 2>/dev/null || echo unknown)
  jq -n --argjson issue "${issue:-0}" --arg executor "${executor:-unknown}" --arg reason "$reason" '{
      schema_version:"1", issue:$issue, target:"builder", version:"builder", executor:$executor,
      status:"blocked", assertion:{expect:null,actual:null,matched:null}, duration_s:0,
      evidence:{script:"", script_lang:"sh", reporter_output:$reason, http:[], artifacts:[], truncated:false},
      blocked_reason:$reason }' > "$OUT"
  echo "::error::build-verify blocked: $reason"
}

if [ -z "${APP_URL:-}" ]; then
  emit_blocked "APP_URL is not set — the live shop coordinates were not exported on this step"; exit 1
fi
if [ ! -f "$PLAN" ]; then
  emit_blocked "repro-plan.json not found — author the bundle (repro-plan.json + any fixtures/script) before self-verifying"; exit 1
fi

# Reset the DB to the clean post-install snapshot so THIS attempt starts fresh — a re-seed then
# never collides with a prior attempt's rows (composite unique keys, duplicate entries). No-op
# when no snapshot was taken; best-effort (a failed reset just seeds onto the current state).
SNAP=repro-clean-db.sql.gz
if [ -f "$SNAP" ] && [ -n "${DATABASE_URL:-}" ]; then
  echo "== build-verify: resetting DB to clean snapshot =="
  if source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh" \
     && gunzip -c "$SNAP" | mysql -h"$DBH" -P"$DBP" -u"$DBU" ${DBPW:+-p"$DBPW"} "$DBN"; then :
  else echo "::warning::DB reset failed — seeding onto the current state"; fi
fi

if [ -f fixtures.json ]; then
  echo "== build-verify: seeding fixtures.json =="
  if ! PAYLOAD=fixtures.json bash .github/actions/repro/bin/seed.sh; then
    emit_blocked "seeding fixtures.json failed: $(head -c 300 seed-error.txt 2>/dev/null | tr -d '\r\n' | tr -s ' ')"; exit 1
  fi
else
  echo "== build-verify: no fixtures.json — skipping seed =="
fi

echo "== build-verify: running the executor as the builder leg =="
TARGET=builder OUT="$OUT" REPRO_PLAN="$PLAN" bash .github/actions/repro/bin/run-leg.sh
rc=$?
# The executor writes $OUT itself (incl. blocked/inconclusive). Only synthesize one if it
# died BEFORE producing any result (e.g. plan missing .executor, transport blew up).
if [ ! -f "$OUT" ]; then
  emit_blocked "the executor exited (code $rc) without producing a result — check repro-plan.json has a valid .executor"; exit 1
fi

echo "== build-verify: done — read builder-result.json for the status (=$(jq -r '.status // "?"' "$OUT")) =="
