#!/usr/bin/env bash
# Agent-facing verification entrypoint — and the END of the agent's job.
#
# The agent runs THIS (not build-verify.sh directly) to check its bundle. It runs the deterministic
# verifier on the live REPORTED instance, and then:
#   * CLASSIFIED (reproduced | not_reproduced) → records the reported leg, HANDS OFF to the
#     deterministic trunk-and-report pipeline (via the gh-aw safe-output channel), and tells the
#     agent to STOP. The agent decides nothing further.
#   * NOT classified (blocked | inconclusive)  → tells the agent the ONE thing to fix and to
#     re-run. No hand-off, no stop.
#
# Usage:
#   bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh          # verify; hand off iff classified
#   bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh giveup   # cannot build → hand off a "could not reproduce"
set -uo pipefail

MODE=${1:-verify}
PLAN=reproduction-plan.json

# Trigger the deterministic trunk-and-report job exactly once, by appending one item to the gh-aw
# safe-output channel (ingested after the agent step). The job re-runs the bundle on trunk and
# posts the verdict; it reads reproduction-plan.json itself, so these fields are informational only.
handoff () { # <executor> <status>
  if [ -n "${GH_AW_SAFE_OUTPUTS:-}" ]; then
    jq -nc --arg e "$1" --arg s "$2" '{type:"reproduce_on_trunk", executor:$e, status:$s}' >> "$GH_AW_SAFE_OUTPUTS"
  fi
  cat <<'EOF'
==================================================================
STOP — your work is complete. Do NOT continue or call any tool.
The deterministic pipeline now takes over: it re-provisions the
next version from reproduction-plan.json, re-runs your exact bundle,
computes the verdict, and posts the issue comment. You decide
nothing further.
==================================================================
EOF
}

if [ "$MODE" = giveup ]; then
  echo "== verify-reproduction: giving up — handing off a 'could not reproduce' result =="
  handoff none giveup
  exit 0
fi

# Reset DB to the clean snapshot -> seed fixtures.json -> run the chosen executor -> builder-result.json.
TARGET=builder OUT=builder-result.json bash .github/actions/repro-agent/bin/execute/build-verify.sh
status=$(jq -r '.status // "blocked"' builder-result.json 2>/dev/null || echo blocked)
executor=$(jq -r '.executor // "http"' "$PLAN" 2>/dev/null || echo http)

case "$status" in
  reproduced|not_reproduced)
    # A reset+seed+run on this instance IS a clean reported-version leg → adopt it as the result.
    cp builder-result.json result.json
    echo "== verify-reproduction: classified '$status' on the reported version — recorded as the reported leg =="
    handoff "$executor" "$status"
    ;;
  *)
    reason=$(jq -r '.blocked_reason // .evidence.reporter_output // "see builder-result.json"' builder-result.json 2>/dev/null || echo "see builder-result.json")
    echo "== verify-reproduction: status '$status' — NOT classified yet."
    echo "   Fix THIS one thing, then re-run verify-reproduction.sh (do not hand off): $reason =="
    exit 1
    ;;
esac
