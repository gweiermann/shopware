#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

ARTIFACTS_ONLY=false
if [ "${1:-}" = "--artifacts-only" ]; then
  ARTIFACTS_ONLY=true
fi

node .github/actions/repro-agent/local/scripts/run-eval.mjs cleanup

if [ "$ARTIFACTS_ONLY" = true ]; then
  exit 0
fi

if [ -f repro-clean-db.sql.gz ] && [ -n "${DATABASE_URL:-}" ]; then
  echo "Restoring repro-clean-db.sql.gz through the repro-agent verifier path..."
  mkdir -p .scratch/repro-agent-local/runs
  APP_URL="${APP_URL:-http://localhost:8000}" \
    TARGET=local-reset \
    OUT=.scratch/repro-agent-local/runs/reset-result.json \
    bash .github/actions/repro-agent/bin/execute/build-verify.sh || true
else
  echo "No DB snapshot restore performed. Set DATABASE_URL and keep repro-clean-db.sql.gz to reset the live instance."
fi
