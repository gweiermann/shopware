#!/usr/bin/env bash
# Agent-facing entrypoint — the ONE verify command exposed through reproctl.
#
# The Admin + Storefront are ALREADY BUILT on this instance (the provision step did it up front),
# so the agent never waits on a JS build. The agent only has to (1) write reproduction-plan.json
# (+ the test + fixtures.json), and (2) run THIS once. It:
#   1. generates demodata if the plan asks for it (fixtures.demodata=true) — once, idempotently —
#      and re-snapshots the clean DB so the per-attempt reset keeps it;
#   2. runs the deterministic verifier (reset DB → seed → execute → builder-result.json);
#   3. CLASSIFIED (reproduced | not_reproduced) → records the reported leg, HANDS OFF to the
#      deterministic trunk-and-report pipeline (gh-aw safe-output channel), and tells the agent to
#      STOP — it decides nothing further. In reproctl agent mode the script does NOT publish
#      result.json; deterministic post-agent steps rerun the same verification before upload;
#      NOT classified (blocked | inconclusive)  → prints the ONE thing to fix and to re-run.
#
# Usage through the agent wrapper:
#   node /tmp/reproctl/reproctl.mjs verify   # feedback verify; requests deterministic pipeline iff classified
#   node /tmp/reproctl/reproctl.mjs giveup   # cannot build → request a pipeline-failed result
set -uo pipefail

MODE=${1:-verify}
PLAN=reproduction-plan.json
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BIN=${REPRO_AGENT_BIN:-$(cd "$SCRIPT_DIR/.." && pwd)}
VERIFY_ATTEMPT_LIMIT=${REPRO_VERIFY_ATTEMPT_LIMIT:-3}
VERIFY_ATTEMPT_FILE=${REPRO_VERIFY_ATTEMPT_FILE:-.repro-verify-attempts}
HANDOFF_SENT_FILE=${REPRO_HANDOFF_SENT_FILE:-.repro-handoff-sent}
VERIFY_ATTEMPT=0
DEFER_REPORTED_RESULT=${REPRO_AGENT_DEFER_REPORTED_RESULT:-0}
SKIP_HANDOFF=${REPRO_AGENT_SKIP_HANDOFF:-0}

case "$VERIFY_ATTEMPT_LIMIT" in
  ''|*[!0-9]*|0) VERIFY_ATTEMPT_LIMIT=3 ;;
esac

# Trigger the deterministic trunk-and-report job exactly once through the gh-aw safe-output
# channel (ingested after the agent step). The job re-runs the bundle on trunk and posts the
# verdict; it reads reproduction-plan.json itself, so these fields are informational only.
emit_reproduce_on_trunk () { # <executor> <status>
  local payload
  payload=$(jq -nc --arg executor "$1" --arg status "$2" '{executor:$executor, status:$status}')

  if command -v safeoutputs >/dev/null 2>&1; then
    if printf '%s\n' "$payload" | safeoutputs reproduce_on_trunk .; then
      return 0
    fi
    echo "::warning::safeoutputs CLI handoff failed — trying file fallback"
  fi

  if [ -n "${GH_AW_SAFE_OUTPUTS:-}" ]; then
    local output_dir
    output_dir=$(dirname "$GH_AW_SAFE_OUTPUTS")
    if [ -d "$output_dir" ] && [ -w "$output_dir" ]; then
      jq -nc --arg e "$1" --arg s "$2" '{type:"reproduce_on_trunk", executor:$e, status:$s}' >> "$GH_AW_SAFE_OUTPUTS" && return 0
    fi
    echo "::warning::GH_AW_SAFE_OUTPUTS is not writable: $GH_AW_SAFE_OUTPUTS"
    return 1
  fi

  echo "::warning::no gh-aw safe-output channel is configured; assuming a local verifier run"
  return 0
}

handoff () { # <executor> <status>
  if [ "$SKIP_HANDOFF" = 1 ]; then
    cat <<'EOF'
==================================================================
Reported-version verification is complete. The safe-output handoff
was intentionally skipped for this deterministic post-agent run.
==================================================================
EOF
    return 0
  fi

  if [ -f "$HANDOFF_SENT_FILE" ]; then
    cat <<'EOF'
==================================================================
STOP — your work was already handed off. Do NOT continue or call
any tool. The deterministic pipeline has already taken over.
==================================================================
EOF
    return 0
  fi

  if ! emit_reproduce_on_trunk "$1" "$2"; then
    cat <<'EOF'
==================================================================
STOP — verification reached a terminal state, but the safe-output
handoff could not be emitted. Call report_incomplete with the exact
handoff failure shown above, then stop.
==================================================================
EOF
    return 1
  fi

  touch "$HANDOFF_SENT_FILE" 2>/dev/null || true
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

read_verify_attempts () {
  local value
  value=$(cat "$VERIFY_ATTEMPT_FILE" 2>/dev/null || echo 0)
  case "$value" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$value" ;;
  esac
}

write_verify_attempts () {
  if ! printf '%s\n' "$1" > "$VERIFY_ATTEMPT_FILE"; then
    echo "== verify-reproduction: could not write verifier attempt counter ($VERIFY_ATTEMPT_FILE) =="
    exit 1
  fi
}

begin_verify_attempt () {
  local used remaining
  used=$(read_verify_attempts)

  if [ "$used" -ge "$VERIFY_ATTEMPT_LIMIT" ]; then
    local reason
    reason=$(jq -r '.blocked_reason // .evidence.reporter_output // "see builder-result.json"' builder-result.json 2>/dev/null || echo "see builder-result.json")
    cat <<EOF
== verify-reproduction: REFUSED — verifier budget exhausted ($used/$VERIFY_ATTEMPT_LIMIT attempts used). ==
   Running the verifier again would spend more credits without a new deterministic signal.
   Gracefully handing off a pipeline-failed result now; stop after this command.
==
EOF
    if [ -f "$HANDOFF_SENT_FILE" ]; then
      handoff none giveup
      exit 0
    fi

    normalize_giveup_plan
    if record_possible_fix_reported_leg "$reason"; then
      handoff "$(plan_executor)" inconclusive || exit 1
    else
      handoff none giveup || exit 1
    fi
    exit 0
  fi

  VERIFY_ATTEMPT=$((used + 1))
  write_verify_attempts "$VERIFY_ATTEMPT"
  remaining=$((VERIFY_ATTEMPT_LIMIT - VERIFY_ATTEMPT))

  echo "== verify-reproduction: verifier attempt $VERIFY_ATTEMPT/$VERIFY_ATTEMPT_LIMIT =="
  case "$remaining" in
    0)
      echo "   This is the last verifier try. You cannot run this command again in this workflow." ;;
    1)
      echo "   Verification budget: only 1 verifier try left after this run." ;;
    *)
      echo "   Verification budget: only $remaining verifier tries left after this run." ;;
  esac
}

handle_unclassified_result () { # <status> <reason>
  local status="$1" reason="$2" remaining
  remaining=$((VERIFY_ATTEMPT_LIMIT - VERIFY_ATTEMPT))
  normalize_unclassified_plan "$reason"

  echo "== verify-reproduction: status '$status' — NOT classified yet."

  if [ "$remaining" -le 0 ]; then
    cat <<EOF
   Verification budget: this was your last verifier try. You cannot run this command again in this workflow.
   The bundle is still unclassified, so the workflow is handing off a pipeline-failed result now.
   Stop after this command; do not repair, rerun, or call tools.
==
EOF
    if record_possible_fix_reported_leg "$reason"; then
      handoff "$executor" "$status" || exit 1
    else
      handoff none giveup || exit 1
    fi
    exit 0
  fi

  if [ "$remaining" -eq 1 ]; then
    echo "   Verification budget: only 1 verifier try left."
  else
    echo "   Verification budget: only $remaining verifier tries left."
  fi
  echo "   Fix THIS one thing, then rerun the static validator and verifier: $reason =="
  exit 1
}

plan_executor () {
  jq -r '.executor // "http"' "$PLAN" 2>/dev/null || echo http
}

plan_possible_fix_candidate () {
  [ -f "$PLAN" ] || return 1
  jq -e '(.derived_from // "") | strings | length > 0' "$PLAN" >/dev/null 2>&1
}

reason_says_precondition_absent () {
  printf '%s' "$1" | grep -qiE 'PRECONDITION_NOT_FOUND|precondition[^[:cntrl:]]*(absent|missing|not found|not met)|hazard[^[:cntrl:]]*(absent|missing|not found)|reported[^[:cntrl:]]*(geometry|overlap|intercept|broken state)[^[:cntrl:]]*(absent|missing|not found)|already fixed|appears fixed|fix already'
}

record_possible_fix_reported_leg () { # <reason>
  [ -f builder-result.json ] || return 1
  plan_possible_fix_candidate || return 1
  reason_says_precondition_absent "$1" || return 1

  cp builder-result.json result.json
  echo "== verify-reproduction: possible fixing PR/commit recorded in derived_from; preserving the reported leg for deterministic reporting =="
  return 0
}

normalize_giveup_plan () {
  [ -f "$PLAN" ] || return 0

  local reason
  reason=$(jq -r '
    .blocked_reason
    // .agent_explanation
    // .confidence_reason
    // "Agent gave up before producing a classified reproduction on the reported version."
  ' "$PLAN" 2>/dev/null || echo "Agent gave up before producing a classified reproduction on the reported version.")

  local tmp
  tmp=$(mktemp)
  if jq --arg reason "$reason" '
    .confidence = ((.confidence // 0.4) | if type == "number" and . <= 0.5 then . else 0.4 end)
    | .agent_explanation = (.agent_explanation // .confidence_reason // $reason)
    | .blocked_reason = (.blocked_reason // $reason)
    | del(.confidence_reason)
  ' "$PLAN" > "$tmp"; then
    mv "$tmp" "$PLAN"
  else
    rm -f "$tmp"
  fi
}

normalize_unclassified_plan () {
  [ -f "$PLAN" ] || return 0

  local reason=${1:-"Verifier could not classify the reported version."}
  local tmp
  tmp=$(mktemp)
  if jq --arg reason "$reason" '
    .confidence = ((.confidence // 0.4) | if type == "number" and . <= 0.5 then . else 0.4 end)
    | .agent_explanation = (.agent_explanation // .confidence_reason // $reason)
    | .blocked_reason = (.blocked_reason // $reason)
    | del(.confidence_reason)
  ' "$PLAN" > "$tmp"; then
    mv "$tmp" "$PLAN"
  else
    rm -f "$tmp"
  fi
}

normalize_classified_plan () {
  [ -f "$PLAN" ] || return 0

  local tmp
  tmp=$(mktemp)
  if jq '
    .confidence = ((.confidence // 0.75) | if type == "number" and . > 0.5 then . else 0.75 end)
    | .blocked_reason = null
    | .agent_explanation = (
        (.agent_explanation // .confidence_reason) as $explanation
        | if ($explanation | type) == "string"
          and ($explanation | test("previous run|stale|still blocked|still inconclusive|blocked on setup|precondition missing|setup failure|failed run|failure from a previous"; "i"))
        then null
        else ($explanation // null)
        end
      )
    | del(.confidence_reason)
  ' "$PLAN" > "$tmp"; then
    mv "$tmp" "$PLAN"
  else
    rm -f "$tmp"
  fi
}

if [ "$MODE" = giveup ]; then
  echo "== verify-reproduction: giving up — handing off a 'could not reproduce' result =="
  [ -f "$HANDOFF_SENT_FILE" ] || normalize_giveup_plan
  reason=$(jq -r '.blocked_reason // .evidence.reporter_output // "see builder-result.json"' builder-result.json 2>/dev/null || echo "see builder-result.json")
  if [ "$DEFER_REPORTED_RESULT" = 1 ]; then
    normalize_giveup_plan
    handoff none giveup || exit 1
  elif record_possible_fix_reported_leg "$reason"; then
    handoff "$(plan_executor)" inconclusive || exit 1
  else
    handoff none giveup || exit 1
  fi
  exit 0
fi

if [ ! -f "$PLAN" ]; then
  echo "== verify-reproduction: $PLAN not found — write it first (see build-context.md). =="
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
     (empty slider/page), that is a FIXTURE problem — use the bounded source/test discovery
     budget to derive the relationship shape, visibility/indexing requirements, and technical
     route from nearby tests/entity definitions. Do NOT switch to http to "diagnose".
   → If you genuinely cannot make it render after honest attempts, run:
     node /tmp/reproctl/reproctl.mjs giveup
==
EOF
    exit 1
  fi
fi

if ! node "$BIN/agent/validate-bundle.mjs"; then
  cat <<'EOF'
   Fix the bundle, then re-run reproctl validate and reproctl verify. Do NOT hand off a result until this
   validator passes. The validator catches weak visual reproductions whose tests pass while missing
   the reported selected/specific value.
EOF
  exit 1
fi

# ---- 1. demodata if the plan asks for it (Admin/Storefront are already built by provisioning). --
demodata=$(jq -r '.fixtures.demodata // false' "$PLAN" 2>/dev/null || echo false)

begin_verify_attempt

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
executor=$(plan_executor)

# ---- 3. Classify → record + hand off + STOP, or ask for one fix. --------------------------------
case "$status" in
  reproduced|not_reproduced)
    # A reset+seed+run on this instance IS a clean reported-version leg → adopt it as the result.
    normalize_classified_plan
    if [ "$DEFER_REPORTED_RESULT" = 1 ]; then
      echo "== verify-reproduction: classified '$status' on the reported version — deterministic post-agent verification will record the reported leg =="
    else
      cp builder-result.json result.json
      echo "== verify-reproduction: classified '$status' on the reported version — recorded as the reported leg =="
    fi
    handoff "$executor" "$status" || exit 1
    ;;
  *)
    reason=$(jq -r '.blocked_reason // .evidence.reporter_output // "see builder-result.json"' builder-result.json 2>/dev/null || echo "see builder-result.json")
    handle_unclassified_result "$status" "$reason"
    ;;
esac
