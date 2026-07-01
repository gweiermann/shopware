#!/usr/bin/env bash
# Compact live UI probe for generated repro agents.
#
# Usage:
#   APP_URL=http://localhost:18080 bash .github/actions/repro-agent/bin/agent/probe-ui.sh /admin#/sw/category/index 375x812
#
# For /admin routes this reuses the same deterministic login-state helper as the Playwright
# executor, then prints compact role/text evidence and a screenshot path.
set -euo pipefail

ROOT=$(pwd)
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_URL=${APP_URL:-http://localhost:18080}
ROUTE=${1:-}
VIEWPORT=${2:-1280x900}

if [ -z "$ROUTE" ]; then
  echo "usage: probe-ui.sh <route-or-url> [viewport=1280x900]" >&2
  exit 2
fi

STORAGE=""
if [[ "$ROUTE" == /admin* ]] || [[ "$ROUTE" == "$APP_URL/admin"* ]]; then
  STORAGE="$ROOT/.repro-admin-probe-state.json"
  node "$SCRIPT_DIR/../execute/login-state.mjs" "$APP_URL" "$STORAGE" >/dev/null
else
  AUTO_COOKIE_CONSENT=true
  if [ -f reproduction-plan.json ]; then
    AUTO_COOKIE_CONSENT=$(jq -r '.browser_state.auto_cookie_consent // true' reproduction-plan.json 2>/dev/null || echo true)
  fi
  if [ "$AUTO_COOKIE_CONSENT" != false ]; then
    STORAGE="$ROOT/.repro-storefront-probe-state.json"
    node "$SCRIPT_DIR/../execute/storefront-consent-state.mjs" "$APP_URL" "$STORAGE" >/dev/null || STORAGE=""
  fi
fi

node "$SCRIPT_DIR/probe-ui.mjs" "$APP_URL" "$ROUTE" "$VIEWPORT" "$STORAGE"
