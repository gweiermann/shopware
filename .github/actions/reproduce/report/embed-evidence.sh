#!/usr/bin/env bash
# Publish Playwright evidence so the issue comment can show it persistently. A bot comment can render
# an image from a URL but GitHub strips <video> from bot comments — so we push each leg's SCREENSHOT
# (shown inline) and RECORDING .webm (a clickable link) to an orphan evidence branch and reference
# them by raw URL. These persist past the 7-day artifact expiry; the branch is prunable any time.
#
# When both legs reached the SAME status the screenshots are redundant → show one (trunk, the most
# current UI); when they differ, show both (before/after). Only playwright legs have screenshots.
#
# Env: COMMENT(=comment.md), ART(=artifacts), BRANCH(req), REPO(req), RUN_ID(req),
#      TOKEN(req unless PUSH=skip), PUSH=skip (testing: append markdown only, no git push).
set -euo pipefail

COMMENT=${COMMENT:-comment.md}
ART=${ART:-artifacts}
: "${BRANCH:?BRANCH is required}"; : "${REPO:?REPO is required}"; : "${RUN_ID:?RUN_ID is required}"
[ -f "$COMMENT" ] || { echo "::warning::$COMMENT not found — skipping evidence"; exit 0; }

# Gather playwright legs that produced a screenshot (parallel arrays: name / png / webm / status).
names=(); pngs=(); vids=(); stats=()
for dir in "$ART"/repro-*/; do
  [ -d "$dir" ] || continue
  [ "$(jq -r '.executor // ""' "$dir/result.json" 2>/dev/null)" = playwright ] || continue
  png=$(find "$dir" -name 'test-*.png' 2>/dev/null | head -1); [ -n "$png" ] || continue
  vid=$(find "$dir" -name '*.webm' 2>/dev/null | head -1 || true)   # present only when record_video opted in
  names+=("$(basename "$dir" | sed 's/^repro-//')"); pngs+=("$png"); vids+=("$vid")
  stats+=("$(jq -r '.status // "?"' "$dir/result.json" 2>/dev/null || echo '?')")
done
n=${#names[@]}
[ "$n" -gt 0 ] || { echo "no playwright evidence — nothing to embed"; exit 0; }

# Collapse to the trunk leg when both legs share an outcome.
collapsed=0; show=(); for i in $(seq 0 $((n - 1))); do show+=("$i"); done
if [ "$n" -eq 2 ] && [ "${stats[0]}" = "${stats[1]}" ]; then
  collapsed=1; main=0; for j in $(seq 0 $((n - 1))); do [ "${names[$j]}" = trunk ] && main=$j; done; show=("$main")
fi

# When collapsed (both legs same outcome), show ONE video — the shown leg's, or any leg's as fallback.
vidleg=""
if [ "$collapsed" = 1 ]; then
  vidleg=${show[0]}; [ -n "${vids[$vidleg]}" ] || for j in $(seq 0 $((n - 1))); do [ -n "${vids[$j]}" ] && vidleg="$j" && break; done
fi

staged=$(mktemp -d)
for i in "${show[@]}"; do
  cp "${pngs[$i]}" "$staged/${names[$i]}.png"
  [ -n "${vids[$i]}" ] && cp "${vids[$i]}" "$staged/${names[$i]}.webm" || true
done
# Ensure the single collapsed video is staged even if it belongs to a non-shown leg.
[ -n "$vidleg" ] && [ -n "${vids[$vidleg]}" ] && [ ! -f "$staged/${names[$vidleg]}.webm" ] && cp "${vids[$vidleg]}" "$staged/${names[$vidleg]}.webm" || true

if [ "${PUSH:-}" != skip ]; then
  : "${TOKEN:?TOKEN is required to push evidence}"
  repo=$(mktemp -d)
  git -C "$repo" init -q
  git -C "$repo" remote add origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  if git -C "$repo" fetch -q --depth 1 origin "$BRANCH" 2>/dev/null; then
    git -C "$repo" checkout -q FETCH_HEAD
  else
    git -C "$repo" checkout -q --orphan "$BRANCH"
    printf '# repro evidence\n\nInline images/recordings referenced by reproduce comments. Safe to prune any time.\n' > "$repo/README.md"
    git -C "$repo" add README.md
  fi
  mkdir -p "$repo/runs/$RUN_ID"
  cp "$staged"/* "$repo/runs/$RUN_ID/"
  git -C "$repo" add "runs/$RUN_ID"
  git -C "$repo" -c user.name=github-actions -c user.email=actions@github.com commit -q -m "evidence for run $RUN_ID"
  git -C "$repo" push -q origin "HEAD:refs/heads/$BRANCH"
fi

raw="https://raw.githubusercontent.com/$REPO/$BRANCH/runs/$RUN_ID"
block=$(mktemp)
{
  echo; echo "### Evidence"
  if [ "$collapsed" = 1 ]; then
    i=${show[0]}
    echo; echo "**reported & trunk** — identical outcome (\`${stats[$i]}\`); showing the **${names[$i]}** evidence (most up-to-date UI)."
    echo "![reported & trunk](${raw}/${names[$i]}.png)"
    [ -n "$vidleg" ] && [ -n "${vids[$vidleg]}" ] && echo "▶ [Watch the recording](${raw}/${names[$vidleg]}.webm)"
  else
    for i in "${show[@]}"; do
      echo; echo "**${names[$i]}** (\`${stats[$i]}\`)"
      echo "![${names[$i]}](${raw}/${names[$i]}.png)"
      [ -n "${vids[$i]}" ] && echo "▶ [Watch the ${names[$i]} recording](${raw}/${names[$i]}.webm)"
    done
  fi
} > "$block"

# Insert the block at report's marker; else append.
if grep -q '<!-- EVIDENCE -->' "$COMMENT"; then
  awk -v f="$block" '/<!-- EVIDENCE -->/{while ((getline l < f) > 0) print l; next} {print}' "$COMMENT" > "$COMMENT.new" && mv "$COMMENT.new" "$COMMENT"
else
  cat "$block" >> "$COMMENT"
fi
echo "embedded inline evidence (collapsed=$collapsed)"
