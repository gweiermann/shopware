#!/usr/bin/env bash
# Free-form pre-verify browser exploration for reproduction agents.
#
# Usage:
#   node /tmp/reproctl/reproctl.mjs explore-ui /detail/<id> 1280x900
#   node /tmp/reproctl/reproctl.mjs explore-ui /tmp/repro-explore.mjs 600x800
#
# If fixtures.json exists, seed it first so the exploration sees the same candidate state that
# verify will later validate deterministically. This command is intentionally outside the verifier
# attempt budget: it is for route/selector/timing discovery, not for final classification.
set -euo pipefail

ROOT=$(pwd)
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=${REPRO_AGENT_BIN:-$(cd "$SCRIPT_DIR/.." && pwd)}
APP_URL=${APP_URL:-http://localhost:18080}
TARGET=${1:-}
VIEWPORT=${2:-1280x900}

if [ -z "$TARGET" ]; then
  echo "usage: explore-ui.sh <route-or-local-script> [viewport=1280x900]" >&2
  exit 2
fi

if [ -f fixtures.json ]; then
  echo "== explore-ui: seeding fixtures.json =="
  PAYLOAD=fixtures.json bash "$BIN/execute/seed.sh"
fi

STORAGE=""
if [[ "$TARGET" == /admin* ]] || [[ "$TARGET" == "$APP_URL/admin"* ]]; then
  STORAGE="$ROOT/.repro-admin-explore-state.json"
  node "$SCRIPT_DIR/../execute/login-state.mjs" "$APP_URL" "$STORAGE" >/dev/null
else
  AUTO_COOKIE_CONSENT=true
  if [ -f reproduction-plan.json ]; then
    AUTO_COOKIE_CONSENT=$(jq -r '.browser_state.auto_cookie_consent // true' reproduction-plan.json 2>/dev/null || echo true)
  fi
  if [ "$AUTO_COOKIE_CONSENT" != false ]; then
    STORAGE="$ROOT/.repro-storefront-explore-state.json"
    node "$SCRIPT_DIR/../execute/storefront-consent-state.mjs" "$APP_URL" "$STORAGE" >/dev/null || STORAGE=""
  fi
fi

node "$SCRIPT_DIR/explore-ui.mjs" "$APP_URL" "$TARGET" "$VIEWPORT" "$STORAGE"
