#!/usr/bin/env bash
# Assemble the SINGLE context file the Analyze agent reads. ALL prose lives in the template
# (prompts/analyze-context.tpl.md) + the shared references — this script only FILLS placeholders:
# whole-line {{BLOCK}} markers are replaced with file contents / generated blocks, and the
# {{ISSUE}} scalar via sed. Keep prompt text in the .md files, never here.
#
# Env: SKILL (references dir), TPL (template), ISSUE (issue number), OUT (default analyze-context.md).
set -euo pipefail

SKILL=${SKILL:-.claude/skills/reproduce/references}
TPL=${TPL:-$(dirname "${BASH_SOURCE[0]}")/../prompts/analyze-context.tpl.md}
OUT=${OUT:-analyze-context.md}
ISSUE=${ISSUE:-?}

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

sed -e "s/{{ISSUE}}/$ISSUE/g" "$TPL" | while IFS= read -r line; do
  case "$line" in
    '{{SCREENSHOTS}}')     list_screenshots ;;
    '{{ANALYZE_MD}}')      cat "$SKILL/ANALYZE.md" ;;
    '{{SCHEMA_ANALYSIS}}') cat "$SKILL/SCHEMA.analysis.md" ;;
    '{{ISSUE_MD}}')        cat issue.md ;;
    '{{FIXPR}}')           fixpr_section ;;
    *)                     printf '%s\n' "$line" ;;
  esac
done > "$OUT"

echo "wrote $OUT ($(wc -c <"$OUT") bytes)$([ -d issue-assets ] && echo " + $(ls issue-assets | wc -l | tr -d ' ') screenshot(s)")"
