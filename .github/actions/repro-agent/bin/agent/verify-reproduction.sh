#!/usr/bin/env bash
# Agent-facing entrypoint — the ONE command the agent runs, and the END of its job.
#
# The Admin + Storefront are ALREADY BUILT on this instance (the provision step did it up front),
# so the agent never waits on a JS build. The agent only has to (1) write reproduction-plan.json
# (+ the test + fixtures.json), and (2) run THIS once. It:
#   1. generates demodata if the plan asks for it (fixtures.demodata=true) — once, idempotently —
#      and re-snapshots the clean DB so the per-attempt reset keeps it;
#   2. runs the deterministic verifier (reset DB → seed → execute → builder-result.json);
#   3. CLASSIFIED (reproduced | not_reproduced) → records the reported leg, HANDS OFF to the
#      deterministic trunk-and-report pipeline (gh-aw safe-output channel), and tells the agent to
#      STOP — it decides nothing further;
#      NOT classified (blocked | inconclusive)  → prints the ONE thing to fix and to re-run.
#
# Usage:
#   bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh          # (demodata if asked) + verify; hand off iff classified
#   bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh giveup   # cannot build → hand off a "could not reproduce"
set -uo pipefail

MODE=${1:-verify}
PLAN=reproduction-plan.json
BIN=.github/actions/repro-agent/bin

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

if [ ! -f "$PLAN" ]; then
  echo "== verify-reproduction: $PLAN not found — write it first (see the runbook). =="
  exit 1
fi

# HARD GATE: a VISUAL bug (screenshots / rendering symptom, classified deterministically) cannot be
# faithfully reproduced over http/direct — the API can be correct while the page renders wrong, so
# an http/direct bundle would post a FALSE verdict. Refuse to verify/hand off anything but
# playwright for a visual issue, no matter how the agent rationalises it ("diagnostic", "more
# stable", …). The agent must make the playwright repro render, or run `giveup`.
if [ "$(cat issue-class.txt 2>/dev/null)" = visual ]; then
  EXV=$(jq -r '.executor // ""' "$PLAN" 2>/dev/null || echo "")
  if [ "$EXV" != playwright ]; then
    cat <<EOF
== verify-reproduction: REFUSED — this issue is classified VISUAL but reproduction-plan.json uses
   executor '$EXV'. An http/direct check cannot faithfully show a rendering defect and would post a
   FALSE verdict, so it will NOT be run or handed off.
   → Use the 'playwright' executor against the rendered page. If your seeded data renders blank
     (empty slider/page), that is a FIXTURE problem — fix visibility / cms-page version /
     variantListingConfig.displayParent (see references/fixtures-cookbook.md + the playwright
     contract). Do NOT switch to http to "diagnose".
   → If you genuinely cannot make it render after honest attempts, run:
     bash .github/actions/repro-agent/bin/agent/verify-reproduction.sh giveup
==
EOF
    exit 1
  fi
fi

# ---- 1. demodata if the plan asks for it (Admin/Storefront are already built by provisioning). --
demodata=$(jq -r '.fixtures.demodata // false' "$PLAN" 2>/dev/null || echo false)

if [ "$demodata" = true ] && [ ! -f .repro-demodata-done ]; then
  # Generate demodata on the clean install, THEN re-snapshot so build-verify's per-attempt DB reset
  # restores the demodata-included state (the original clean snapshot predates it). Done once.
  echo "== verify-reproduction: plan needs demodata — generating + re-snapshotting =="
  if bash "$BIN/execute/gen-demodata.sh" && bash "$BIN/prepare/db-snapshot.sh"; then
    touch .repro-demodata-done
  else
    echo "::error::demodata generation failed — see the log above"; exit 1
  fi
fi

# ---- 2. Verify: reset DB to the (current) clean snapshot → seed → execute → builder-result.json. -
TARGET=builder OUT=builder-result.json bash "$BIN/execute/build-verify.sh"
status=$(jq -r '.status // "blocked"' builder-result.json 2>/dev/null || echo blocked)
executor=$(jq -r '.executor // "http"' "$PLAN" 2>/dev/null || echo http)

# ---- 3. Classify → record + hand off + STOP, or ask for one fix. --------------------------------
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
