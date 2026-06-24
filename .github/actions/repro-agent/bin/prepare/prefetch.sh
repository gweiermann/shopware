#!/usr/bin/env bash
# Prefetch the build agent's context so it spends turns authoring, not fetching:
#   issue.md   — issue title + body + human comments (minus prior bot repro reports)
#
# Env: ISSUE (req), GH_TOKEN (req), REPO (issue repo; default $GITHUB_REPOSITORY),
#      UPSTREAM (kept for compatibility; unused)
set -euo pipefail

: "${ISSUE:?ISSUE is required}"
REPO=${REPO:-${GITHUB_REPOSITORY:?REPO or GITHUB_REPOSITORY required}}
UPSTREAM=${UPSTREAM:-shopware/shopware}

# Issue title + body + HUMAN comments — comments often hold real repro clarifications, affected
# version, and links to upstream context. EXCLUDE prior automation comments so the build
# agent cannot learn issue-specific fixtures/tests from earlier repro-agent runs.
gh issue view "$ISSUE" --repo "$REPO" --json title,body,comments \
  --jq '
    def is_repro_bot_comment:
      ((.author.login // "") == "github-actions")
      or ((.body // "") | contains("## AI Report (Reproduction)"))
      or ((.body // "") | contains("gh-aw-comment-type"))
      or ((.body // "") | contains("[Reproduce Issue]"))
      or ((.body // "") | contains("## Reproduction (gh-aw)"));
    "# " + .title + "\n\n" + (.body // "") + "\n\n## Comments\n\n"
    + ([.comments[]? | select(is_repro_bot_comment | not) | "**@" + (.author.login // "?") + ":** " + (.body // "")] | join("\n\n"))
  ' \
  > issue.md 2>/dev/null || echo "(issue unavailable)" > issue.md
head -c 60000 issue.md > issue.cap && mv issue.cap issue.md # bound context
# Screenshot attachments → issue-assets/ so the (multimodal) agent can Read them for UI
# bugs. SECURITY: assets are untrusted user content — fetch UNAUTHENTICATED (never attach
# a token to asset hosts), only from GitHub's own attachment hosts, capped in count+size,
# and keep a file only when its MAGIC BYTES say it is an image (videos/HTML/zip are
# dropped; the model cannot watch videos anyway).
mkdir -p issue-assets
i=0
# NB: `|| true` — an issue with no image URLs makes grep exit 1, which pipefail would
# otherwise turn into a prefetch crash (a real miss: every no-screenshot issue died here).
{ grep -oE 'https://(github\.com/user-attachments/assets/[A-Za-z0-9-]+|user-images\.githubusercontent\.com/[A-Za-z0-9./_-]+)' issue.md || true; } \
  | sort -u | head -3 | while read -r url; do
  i=$((i+1)); tmp="issue-assets/.dl-$i"
  curl -fsSL --proto '=https' --max-time 20 --max-filesize 3145728 -o "$tmp" "$url" 2>/dev/null || { rm -f "$tmp"; continue; }
  mime=$(file -b --mime-type "$tmp" 2>/dev/null || echo unknown)
  case "$mime" in
    image/png)  mv "$tmp" "issue-assets/img-$i.png" ;;
    image/jpeg) mv "$tmp" "issue-assets/img-$i.jpg" ;;
    image/gif)  mv "$tmp" "issue-assets/img-$i.gif" ;;
    image/webp) mv "$tmp" "issue-assets/img-$i.webp" ;;
    *) rm -f "$tmp" ;; # not an image (video/other) — drop
  esac
done
rmdir issue-assets 2>/dev/null || true # remove if nothing image-like was kept
[ -d issue-assets ] && echo "prefetched $(ls issue-assets | wc -l | tr -d ' ') screenshot(s) to issue-assets/"
echo "prefetched issue.md ($(wc -c <issue.md) bytes)"
