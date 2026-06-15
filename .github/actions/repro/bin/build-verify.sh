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
set -euo pipefail

: "${APP_URL:?APP_URL is not set — it should be exported on the build-repro step}"

if [ -f fixtures.json ]; then
  echo "== build-verify: seeding fixtures.json =="
  if ! PAYLOAD=fixtures.json bash .github/actions/repro/bin/seed.sh; then
    echo "::error::build-verify: seeding failed — fix fixtures.json before re-running (see the error above)"
    exit 1
  fi
else
  echo "== build-verify: no fixtures.json — skipping seed =="
fi

echo "== build-verify: running the executor as the builder leg =="
TARGET=builder OUT=builder-result.json REPRO_PLAN=repro-plan.json \
  bash .github/actions/repro/bin/run-leg.sh

echo "== build-verify: done — read builder-result.json for the status =="
