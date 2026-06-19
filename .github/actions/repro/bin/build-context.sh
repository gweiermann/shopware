#!/usr/bin/env bash
# Assemble the SINGLE context file the Build Repro agent reads. ALL prose lives in the template
# (prompts/build-context.tpl.md) + the shared references — this script only FILLS placeholders:
# whole-line {{BLOCK}} markers → file contents / generated blocks; the {{ISSUE}} and {{MAX_TURNS}}
# scalars via sed; the executor contract is selected from analysis.executor. Keep prompt text in
# the .md files, never here.
#
# Env: SKILL (references dir), TPL (template), ISSUE, MAX_TURNS (default 40), OUT (default build-context.md).
set -euo pipefail

SKILL=${SKILL:-.claude/skills/reproduce/references}
TPL=${TPL:-$(dirname "${BASH_SOURCE[0]}")/../prompts/build-context.tpl.md}
OUT=${OUT:-build-context.md}
ISSUE=${ISSUE:-?}
MAX_TURNS=${MAX_TURNS:-40}
EXECUTOR=$(jq -r '.executor // "http"' analysis.json 2>/dev/null || echo http)
CONTRACT="$SKILL/executors/${EXECUTOR}.md"
[ -f "$CONTRACT" ] || CONTRACT="$SKILL/executors/http.md"

# Enumerate the prefetched screenshots so the agent Reads the exact paths directly instead of
# spending a turn globbing issue-assets/ (which the prefetch already populated).
list_screenshots () {
  if [ -d issue-assets ] && [ -n "$(ls -A issue-assets 2>/dev/null)" ]; then
    echo "Read these attached screenshots DIRECTLY (do not glob):"
    for f in issue-assets/*; do [ -f "$f" ] && echo "- \`$f\`"; done
  else
    echo "No screenshots attached to the issue."
  fi
}
fixpr_section () { [ -f fixpr.diff ] || return 0; printf -- '\n---\n\n# LINKED FIX PR — description + diff\n\n'; cat fixpr.diff; }

sed -e "s/{{ISSUE}}/$ISSUE/g" -e "s/{{MAX_TURNS}}/$MAX_TURNS/g" "$TPL" | while IFS= read -r line; do
  case "$line" in
    '{{BUILD_MD}}')      cat "$SKILL/BUILD.md" ;;
    '{{COOKBOOK}}')      cat "$SKILL/fixtures-cookbook.md" ;;
    '{{EXECUTOR_MD}}')   cat "$CONTRACT" ;;
    '{{ANALYSIS_JSON}}') printf '```json\n'; cat analysis.json; printf '\n```\n' ;;
    '{{ISSUE_MD}}')      cat issue.md ;;
    '{{SCREENSHOTS}}')   list_screenshots ;;
    '{{FIXPR}}')         fixpr_section ;;
    *)                   printf '%s\n' "$line" ;;
  esac
done > "$OUT"

echo "wrote $OUT ($(wc -c <"$OUT") bytes; executor=$EXECUTOR)$([ -d issue-assets ] && echo " + $(ls issue-assets | wc -l | tr -d ' ') screenshot(s)")"
