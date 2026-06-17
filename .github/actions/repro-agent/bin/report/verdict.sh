#!/usr/bin/env bash
# Deterministic verdict from two leg results + the repro plan's confidence. No agent.
# Shared by the reproduce and fix-verify workflows; MODE selects the leg names + verdict map.
#
#   MODE=reproduce   legs: reported (A) , trunk (B)
#     reproduced/reproduced → live_bug · reproduced/not_reproduced → fixed_on_trunk
#     not_reproduced/reproduced → regression · not_reproduced/not_reproduced → not_reproducible
#   MODE=fix-verify  legs: base (A) , head (B)   (A = fix ABSENT, B = fix PRESENT)
#     reproduced/not_reproduced → fix_verified · reproduced/reproduced → fix_ineffective
#     not_reproduced/not_reproduced → test_does_not_guard · not_reproduced/reproduced → introduces_symptom
#
# Precedence (both modes): any blocked → blocked; unsure plan (blocked_reason or
# confidence < 0.7) → needs_human_review; any inconclusive → needs_human_review; else the map.
#
# Env: MODE (default reproduce), ART (artifacts dir, default "artifacts").
# Emits KEY=VALUE to $GITHUB_OUTPUT when set (always also to stdout): has_results, verdict,
#   <A_NAME>, <B_NAME>, fix_candidate, unsure_reason.
set -euo pipefail

MODE=${MODE:-reproduce}
ART=${ART:-artifacts}
case "$MODE" in
  reproduce)  A_NAME=reported; B_NAME=trunk ;;
  fix-verify) A_NAME=base;     B_NAME=head  ;;
  *) echo "::error::unknown MODE '$MODE'"; exit 1 ;;
esac
AF="$ART/repro-$A_NAME/result.json"
BF="$ART/repro-$B_NAME/result.json"

out () { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"; echo "$1=$2"; }

# No leg produced a result → no verdict, no comment downstream.
if [ ! -f "$AF" ] && [ ! -f "$BF" ]; then
  out has_results false
  echo "::warning::No $MODE leg produced a result (aborted/cancelled/failed)."
  exit 0
fi
out has_results true

a="null"; b="null"
[ -f "$AF" ] && a=$(jq -r .status "$AF")
[ -f "$BF" ] && b=$(jq -r .status "$BF")
out "$A_NAME" "$a"
out "$B_NAME" "$b"

AN="$ART/repro-plan/reproduction-plan.json"
CONF=$(jq -r '.confidence // 1' "$AN" 2>/dev/null || echo 1)
BLOCKED=$(jq -r '.blocked_reason // ""' "$AN" 2>/dev/null || echo "")
DERIVED=$(jq -r '.derived_from // ""' "$AN" 2>/dev/null || echo "")
CONF_REASON=$(jq -r '.confidence_reason // ""' "$AN" 2>/dev/null || echo "")

# Mid-band plan (0.4–0.7; below 0.4 bailed before provision) or a blocked_reason → don't
# trust the verdict even if the legs ran; route to a human with the reason captured.
unsure=false; UNSURE_REASON=""
if [ -n "$BLOCKED" ] && [ "$BLOCKED" != null ]; then unsure=true; UNSURE_REASON="$BLOCKED"; fi
if awk "BEGIN{exit !($CONF < 0.7)}"; then
  unsure=true
  # ALWAYS record why: when the analyst left confidence_reason null, fall back to a generic
  # confidence note — otherwise the report says "not trusted" with no reason next to a clean
  # leg result, which reads as a contradiction.
  [ -z "$UNSURE_REASON" ] && UNSURE_REASON="${CONF_REASON:-analysis confidence ${CONF} is below the 0.7 trust threshold, so the repro may not faithfully match the report}"
fi

# Precedence: infra → unreliable-plan → indeterminate leg → mode-specific core combos.
V="needs_human_review"
if   [ "$a" = "blocked" ] || [ "$b" = "blocked" ];           then V="blocked"
elif [ "$unsure" = "true" ];                                 then V="needs_human_review"
elif [ "$a" = "inconclusive" ] || [ "$b" = "inconclusive" ]; then V="needs_human_review"
elif [ "$MODE" = "reproduce" ]; then
  if   [ "$a" = "reproduced" ]     && [ "$b" = "reproduced" ];     then V="live_bug"
  elif [ "$a" = "reproduced" ]     && [ "$b" = "not_reproduced" ]; then V="fixed_on_trunk"
  elif [ "$a" = "not_reproduced" ] && [ "$b" = "reproduced" ];     then V="regression"
  elif [ "$a" = "not_reproduced" ] && [ "$b" = "not_reproduced" ]; then V="not_reproducible"
  elif [ "$a" = "null" ]           && [ "$b" = "reproduced" ];     then V="live_bug"
  elif [ "$a" = "null" ]           && [ "$b" = "not_reproduced" ]; then V="not_reproducible"
  fi
else  # fix-verify: A = base (fix absent), B = head (fix present)
  if   [ "$a" = "reproduced" ]     && [ "$b" = "not_reproduced" ]; then V="fix_verified"
  elif [ "$a" = "reproduced" ]     && [ "$b" = "reproduced" ];     then V="fix_ineffective"
  elif [ "$a" = "not_reproduced" ] && [ "$b" = "not_reproduced" ]; then V="test_does_not_guard"
  elif [ "$a" = "not_reproduced" ] && [ "$b" = "reproduced" ];     then V="introduces_symptom"
  fi
fi
out verdict "$V"

# If the verdict is needs_human_review purely because a leg was inconclusive (neither low-confidence
# nor blocked set a reason), surface THAT leg's reason so the summary can explain itself.
if [ "$V" = "needs_human_review" ] && [ -z "$UNSURE_REASON" ]; then
  for f in "$AF" "$BF"; do
    [ -f "$f" ] && [ "$(jq -r .status "$f")" = inconclusive ] && {
      UNSURE_REASON=$(jq -r '.blocked_reason // .evidence.reporter_output // "a leg was inconclusive — the symptom could not be judged"' "$f"); break; }
  done
fi
# Single-line + bounded: this value is written to $GITHUB_OUTPUT (a newline would corrupt it).
UNSURE_REASON=$(printf '%s' "$UNSURE_REASON" | tr '\n\r' '  ' | tr -s ' ' | cut -c1-300)
out unsure_reason "$UNSURE_REASON"

# fixed_on_trunk / fix_verified: the fixing PR/commit is often already known (derived_from).
FIX=""; { [ "$V" = "fixed_on_trunk" ] || [ "$V" = "fix_verified" ]; } && FIX="$DERIVED"
out fix_candidate "$FIX"
echo "MODE=$MODE verdict=$V $A_NAME=$a $B_NAME=$b unsure=$unsure"
