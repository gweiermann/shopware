#!/usr/bin/env bash
# Finalize gh-aw's generated prompt with an explicit run-specific task after build-context.md exists.
#
# Env: GH_AW_PROMPT/PROMPT (output path), CONTEXT (default build-context.md), ISSUE.
set -euo pipefail

PROMPT=${PROMPT:-${GH_AW_PROMPT:-/tmp/gh-aw/aw-prompts/prompt.txt}}
CONTEXT=${CONTEXT:-build-context.md}
MARKER_PATH=${MARKER_PATH:-.github/workflows/reproduce.md}
if [ -n "${ISSUE:-}" ]; then
  ISSUE_PHRASE="issue #$ISSUE"
else
  ISSUE_PHRASE="the current issue"
fi

if [ ! -s "$CONTEXT" ]; then
  echo "agent-task-prompt: missing non-empty $CONTEXT" >&2
  exit 1
fi

mkdir -p "$(dirname "$PROMPT")"
TASK=$(mktemp)
NEXT=$(mktemp)
trap 'rm -f "$TASK" "$NEXT"' EXIT

{
  cat <<EOF
Your task is to build and verify one reproduction bundle for ${ISSUE_PHRASE}.

Read \`build-context.md\` first and follow it as the controlling task instructions. Then read \`issue.md\` and listed screenshots. Produce \`reproduction-plan.json\`, optional \`fixtures.json\`, and exactly one executor artifact. Run the validator and verifier. Stop after the verifier classifies the bundle, after the allowed targeted repair, or when the hard verifier budget says no tries remain.

This is reproduction-only. Do not diagnose, fix, or explain the product bug except where needed to choose the fixture/setup/assertion.

The full controlling task contract follows.

EOF
  cat "$CONTEXT"
} > "$TASK"

if [ -s "$PROMPT" ]; then
  if grep -Fq "$MARKER_PATH" "$PROMPT" && grep -Fq '{{#runtime-import' "$PROMPT"; then
    awk -v task="$TASK" -v marker="$MARKER_PATH" '
      BEGIN {
        while ((getline line < task) > 0) {
          replacement = replacement line ORS
        }
        close(task)
      }
      index($0, "{{#runtime-import") && index($0, marker) {
        if (!replaced) {
          printf "%s", replacement
        }
        replaced = 1
        next
      }
      { print }
    ' "$PROMPT" > "$NEXT"
  else
    {
      cat "$PROMPT"
      printf '\n'
      cat "$TASK"
    } > "$NEXT"
  fi
else
  cp "$TASK" "$NEXT"
fi

mv "$NEXT" "$PROMPT"

if grep -Fq "$MARKER_PATH" "$PROMPT" && grep -Fq '{{#runtime-import' "$PROMPT"; then
  echo "agent-task-prompt: unresolved runtime import remained in $PROMPT" >&2
  exit 1
fi
grep -Fq "Your task is to build and verify one reproduction bundle" "$PROMPT" || {
  echo "agent-task-prompt: explicit task missing from $PROMPT" >&2
  exit 1
}
grep -Fq "fixture_contract=" "$PROMPT" || {
  echo "agent-task-prompt: fixture contract missing from $PROMPT" >&2
  exit 1
}

echo "finalized explicit agent task prompt at $PROMPT ($(wc -c <"$PROMPT") bytes)"
