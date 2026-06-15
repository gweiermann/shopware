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

# claude-code-action emits one authoritative `result` entry with the run totals — use it
# (recursive `..` descent double-counts: usage is nested in several places). Fall back to
# summing TOP-LEVEL assistant entries only if no result entry is present.
res=$(jq -c 'last(.[]|select(.type=="result")) // empty' "$EXEC" 2>/dev/null || true)
if [ -n "$res" ]; then
  turns=$(printf '%s' "$res"  | jq -r '.num_turns // 0')
  out_tok=$(printf '%s' "$res"| jq -r '.usage.output_tokens // 0')
  cache_r=$(printf '%s' "$res"| jq -r '.usage.cache_read_input_tokens // 0')
  cost=$(printf '%s' "$res"   | jq -r 'if .total_cost_usd then "$" + (.total_cost_usd|.*100|round/100|tostring) else "?" end')
  endmode=$(printf '%s' "$res"| jq -r '.subtype // "unknown"')
else
  turns=$(jq   '[.[]|select(.type=="assistant")] | length'                                        "$EXEC" 2>/dev/null || echo 0)
  out_tok=$(jq '[.[]|select(.type=="assistant")|.message.usage.output_tokens // empty] | add // 0' "$EXEC" 2>/dev/null || echo 0)
  cache_r=$(jq '[.[]|select(.type=="assistant")|.message.usage.cache_read_input_tokens // empty] | add // 0' "$EXEC" 2>/dev/null || echo 0)
  cost="?"; endmode="unknown"
fi
# Denials: TOP-LEVEL user entries' tool_result blocks that errored or were permission-rejected.
denials=$(jq '[.[]|select(.type=="user")|.message.content[]?|select(.type=="tool_result")|select((.is_error==true) or (((.content // "")|tostring)|test("permission|not allowed|requested permissions|denied";"i")))] | length' "$EXEC" 2>/dev/null || echo 0)

# The agent's final plain-text message — its own words on what it did / why it stopped (the
# "stop-don't-hack" explanation). Prefer the run's result text; fall back to the last
# assistant text block (e.g. when the run ended on error_max_turns, result is null). This is
# what the GITHUB UI shows as a clean callout, instead of leaving it buried in the action's
# verbose auto-summary or the transcript artifact.
why=$(jq -r 'last(.[]|select(.type=="result")|.result // empty) // empty' "$EXEC" 2>/dev/null || true)
[ -n "$why" ] || why=$(jq -r '[.[]|select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text]|last // empty' "$EXEC" 2>/dev/null || true)
# Did the run end cleanly or hit a failure mode (max-turns / error)? Surface it.
endmode=$(jq -r 'last(.[]|select(.type=="result")|.subtype // empty) // "unknown"' "$EXEC" 2>/dev/null || echo unknown)

{
  echo "### ${PHASE} — agent cost"
  echo
  echo "| turns | output tok | cache-read tok | cost | tool denials | end |"
  echo "|---|---|---|---|---|---|"
  echo "| ${turns:-0} | ${out_tok:-0} | ${cache_r:-0} | ${cost:-?} | ${denials:-0} | ${endmode} |"
  echo
  if [ -n "$why" ]; then
    echo "**${PHASE} — agent's final message**"
    echo
    echo '```'
    printf '%s\n' "$why" | head -c 4000
    echo
    echo '```'
    echo
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
echo "telemetry: ${PHASE} turns=${turns} out=${out_tok} cache_read=${cache_r} cost=${cost} denials=${denials} end=${endmode}"
