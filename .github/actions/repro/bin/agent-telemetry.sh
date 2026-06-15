#!/usr/bin/env bash
# Summarize one agent run's COST from the claude-code-action execution_file (its JSON
# transcript), into the job summary — so the turn caps get tuned from data, not vibes.
#
# Telemetry only: this NEVER fails the build. The transcript shape can change across action
# versions, so every extraction is best-effort jq with a 0 fallback. Numbers are approximate
# (esp. denials, a keyword heuristic) — they exist to spot regressions (a turn-cap that's
# suddenly being hit, denial thrash), not for billing.
#
# Env: EXEC_FILE (path to the execution_file; no-op when empty/missing), PHASE (label).
set -euo pipefail

EXEC=${EXEC_FILE:-}
PHASE=${PHASE:-agent}
[ -n "$EXEC" ] && [ -f "$EXEC" ] || { echo "no execution file ($EXEC) — skipping telemetry"; exit 0; }
jq -e . "$EXEC" >/dev/null 2>&1 || { echo "execution file not parseable JSON — skipping telemetry"; exit 0; }

# Recursive descent over the transcript (an array of SDK messages):
#   turns   = assistant messages · in/out/cache toks = summed usage · denials = errored or
#   permission-denied tool results.
turns=$(jq   '[.. | objects | select(.type?=="assistant" or .role?=="assistant")] | length'      "$EXEC" 2>/dev/null || echo 0)
in_tok=$(jq  '[.. | objects | (.usage?.input_tokens // empty)] | add // 0'                        "$EXEC" 2>/dev/null || echo 0)
out_tok=$(jq '[.. | objects | (.usage?.output_tokens // empty)] | add // 0'                       "$EXEC" 2>/dev/null || echo 0)
cache_r=$(jq '[.. | objects | (.usage?.cache_read_input_tokens // empty)] | add // 0'             "$EXEC" 2>/dev/null || echo 0)
denials=$(jq '[.. | objects | select(.type?=="tool_result") | select((.is_error?==true) or (((.content? // "") | tostring) | test("permission|not allowed|requested permissions|denied"; "i")))] | length' "$EXEC" 2>/dev/null || echo 0)

{
  echo "### ${PHASE} — agent cost (approx)"
  echo
  echo "| turns | input tok | output tok | cache-read tok | tool denials |"
  echo "|---|---|---|---|---|"
  echo "| ${turns:-0} | ${in_tok:-0} | ${out_tok:-0} | ${cache_r:-0} | ${denials:-0} |"
  echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
echo "telemetry: ${PHASE} turns=${turns} in=${in_tok} out=${out_tok} cache_read=${cache_r} denials=${denials}"
