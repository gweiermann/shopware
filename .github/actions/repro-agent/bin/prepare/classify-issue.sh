#!/usr/bin/env bash
# Deterministic, conservative issue classifier. Prints `visual` if the bug is about RENDERED output
# (screenshots attached, or clear rendering wording), else `api`.
#
# Used two ways, so a visual bug can NEVER post an http/direct verdict (the recurring false-positive):
#   - build-context.sh injects a "you MUST use playwright" directive into the agent prompt;
#   - verify-reproduction.sh HARD-REFUSES to hand off a non-playwright bundle for a visual issue.
#
# Errs toward `visual`: the cost of a false `visual` is the agent giving up → `inconclusive` (human
# review), which is far better than the cost of a false `api` (a wrong verdict posted to the issue).
#
# Env: ISSUE_MD (default issue.md), ASSETS (default issue-assets).
set -uo pipefail
md=${ISSUE_MD:-issue.md}
assets=${ASSETS:-issue-assets}

# Screenshots attached → treat as visual (a reporter shows a rendering defect with an image).
if [ -d "$assets" ] && [ -n "$(ls -A "$assets" 2>/dev/null)" ]; then printf 'visual'; exit 0; fi

# Otherwise, clear rendering wording. Kept tight — generic words like "show"/"display" are avoided
# because they appear in plenty of API issues.
if [ -f "$md" ] && grep -qiE \
  'screenshot|render(s|ed|ing)?|re-?render|misalign|overlap(ping)?|cut[ -]?off|overflow(ing)?|blank (page|area|space|card)|empty (page|card|slider|box)|not (rendered|displayed on|visible on (the )?(page|storefront|card))|css|styling|stylesheet|\blayout\b|product (card|slider|box)|storefront .*(shows|displays|renders|looks)' \
  "$md"; then printf 'visual'; exit 0; fi

printf 'api'
