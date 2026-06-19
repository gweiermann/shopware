#!/usr/bin/env bash
# Assemble the COMPACT context file the Build Repro agent reads first. It carries only the run-
# specific bits (classification, issue, version, screenshots, fix-PR pointer) + a map of WHERE to
# read the heavy references on demand. The references (BUILD.md, fixtures-cookbook.md, executors/*)
# are NOT inlined — the agent Reads the relevant one fresh, at the point of use, so it isn't buried
# in a giant front-loaded blob. Keep prompt prose in the .md files, never here.
#
# Env: TPL (template), ISSUE, VERSION (reported version, "" → trunk), MAX_TURNS (default 40),
#      OUT (default build-context.md).
set -euo pipefail

TPL=${TPL:-$(dirname "${BASH_SOURCE[0]}")/../../prompts/build-context.tpl.md}
OUT=${OUT:-build-context.md}
ISSUE=${ISSUE:-?}
VERSION=${VERSION:-}
VERSION_LABEL=${VERSION:-trunk}
MAX_TURNS=${MAX_TURNS:-40}

# Deterministic visual/api classification. Persist it to issue-class.txt so verify-reproduction.sh
# can HARD-REFUSE a non-playwright handoff for a visual bug; inject a directive so the agent knows
# up front (don't waste turns on an http bundle that will be rejected).
CLASS=$(ISSUE_MD=issue.md ASSETS=issue-assets bash "$(dirname "${BASH_SOURCE[0]}")/classify-issue.sh" 2>/dev/null || echo api)
printf '%s' "$CLASS" > issue-class.txt
classify_block () {
  if [ "$CLASS" = visual ]; then
    cat <<'EOF'
## ⚠️ Classified VISUAL — you MUST use the `playwright` executor
The symptom is about what the page *renders* (screenshots / rendering wording). An `http`/`direct`
bundle is **rejected by verify-reproduction.sh** (the API can be correct while the page renders
wrong — it would post a false verdict). If your seeded data renders blank, that is a FIXTURE problem
(fix visibility / cms-page version / `variantListingConfig` — see the cookbook), NOT a reason to
switch to http. If you truly cannot make it render: `verify-reproduction.sh giveup`.
EOF
  else
    echo "_Classified \`api\` — pick the cheapest faithful executor (service→direct, \*-api→http)._"
  fi
}

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
# Inline index of the cookbook examples (name + one-line `_about`), so the agent knows which to copy
# WITHOUT spending ls/Read round-trips discovering them. Read from each example's reproduction-plan.
cookbook_index () {
  local refs=".github/actions/repro-agent/references/cookbook" d name about
  for d in "$refs"/*/; do
    [ -f "$d/reproduction-plan.json" ] || continue
    name=$(basename "$d"); about=$(jq -r '._about // ""' "$d/reproduction-plan.json" 2>/dev/null || echo "")
    printf -- '  - `%s/` — %s\n' "$name" "$about"
  done
}
# Pointer, not inlined: the prefetched fix-PR diff can be large — the agent Reads it if useful.
fixpr_section () { [ -f fixpr.diff ] || return 0; printf -- '\n_A linked fix PR was prefetched — Read `fixpr.diff` for its intent + diff (a candidate surface, not a test to import)._\n'; }

sed -e "s/{{ISSUE}}/$ISSUE/g" -e "s/{{VERSION}}/$VERSION_LABEL/g" -e "s/{{MAX_TURNS}}/$MAX_TURNS/g" "$TPL" | while IFS= read -r line; do
  case "$line" in
    '{{CLASSIFY}}')         classify_block ;;
    '{{COOKBOOK_INDEX}}')   cookbook_index ;;
    '{{SCREENSHOTS}}')      list_screenshots ;;
    '{{FIXPR}}')            fixpr_section ;;
    *)                      printf '%s\n' "$line" ;;
  esac
done > "$OUT"

echo "wrote $OUT ($(wc -c <"$OUT") bytes; class=$CLASS; version=$VERSION_LABEL)$([ -d issue-assets ] && echo " + $(ls issue-assets | wc -l | tr -d ' ') screenshot(s)")"
