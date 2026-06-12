#!/usr/bin/env bash
# Validate Build Repro output before spending reported/trunk matrix capacity.
#
# Env: PLAN (default repro-plan.json), RESULT (default builder-result.json).
set -euo pipefail

PLAN=${PLAN:-repro-plan.json}
RESULT=${RESULT:-builder-result.json}

[ -f "$PLAN" ] || { echo "::error::$PLAN missing"; exit 1; }
[ -f "$RESULT" ] || { echo "::error::$RESULT missing"; exit 1; }

jq -e '.schema_version == "1" and (.executor | type == "string") and (.layer | type == "string") and (.version | type == "string")' "$PLAN" >/dev/null \
  || { echo "::error::$PLAN does not contain the required executable plan fields"; exit 1; }

status=$(jq -r '.status // ""' "$RESULT")
case "$status" in
  reproduced|not_reproduced)
    echo "builder status=$status"
    ;;
  blocked|inconclusive)
    reason=$(jq -r '.blocked_reason // .evidence.reporter_output // "no reason given"' "$RESULT")
    echo "::error::Build Repro did not produce a runnable classified bundle: $status — $reason"
    exit 1
    ;;
  *)
    echo "::error::Unknown builder status '$status'"
    exit 1
    ;;
esac
