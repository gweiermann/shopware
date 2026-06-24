#!/usr/bin/env bash
# Publish playwright evidence so the issue/PR comment can show it persistently.
#
# A comment can render an image from any URL (`![](…)`) but CANNOT embed a video player — GitHub
# only shows the `<video>` player for human-uploaded attachments and strips `<video>` HTML from
# bot comments. So we publish, to an orphan evidence branch, the leg SCREENSHOT (rendered inline
# via a raw.githubusercontent URL) and the leg RECORDING `.webm` (a clickable link — click to
# watch/download). Both PERSIST past the 7-day artifact expiry; the trace + HTML report stay in
# the run artifacts. The branch is prunable any time (old comments then lose these, like expired
# artifacts). Note: videos are heavier than screenshots — prune the branch periodically.
#
# Same/different rule (two legs): if the two legs reached the SAME outcome (same status) the
# screenshots are redundant → show ONE (the TRUNK one — it's the most up-to-date UI); if the
# outcomes DIFFER they are the before/after → show BOTH. Only playwright legs have screenshots.
#
# Env: COMMENT (default comment.md), ART (default artifacts), BRANCH (evidence branch, req),
#      REPO ("owner/name", req), RUN_ID (req), TOKEN (push token, req unless PUSH=skip),
#      PUSH=skip (testing: append markdown only, no git push).
set -euo pipefail

COMMENT=${COMMENT:-comment.md}
ART=${ART:-artifacts}
: "${BRANCH:?BRANCH (evidence branch) is required}"
: "${REPO:?REPO is required}"
: "${RUN_ID:?RUN_ID is required}"

[ -f "$COMMENT" ] || { echo "::warning::$COMMENT not found — skipping inline evidence"; exit 0; }

# Collect playwright legs that produced a screenshot, plus the leg's video + status (parallel
# indexed arrays — bash 3.2 has no associative arrays). The video is optional (recorded only
# when the config has video on); the screenshot gates inclusion.
NAMES=(); PNGS=(); VIDS=(); STS=()
for d in "$ART"/repro-*/; do
  [ -d "$d" ] || continue # unmatched glob
  leg=$(basename "$d" | sed 's/^repro-//')
  # Only embed a screenshot for a leg that ACTUALLY ran playwright. An http/direct leg never
  # produces verified evidence; guarding on the leg's own executor stops a stale screenshot from an
  # abandoned playwright attempt (left in test-results/) being embedded as if it were this leg's.
  ex=$(jq -r '.executor // ""' "$d/result.json" 2>/dev/null || echo "")
  [ "$ex" = playwright ] || continue
  png=$(find "$d" -name 'test-*.png' 2>/dev/null | head -1)
  [ -n "$png" ] || continue
  vid=""
  [ -d "$d/narrated-video" ] && vid=$(find "$d/narrated-video" -name '*.webm' 2>/dev/null | head -1 || true)
  [ -n "$vid" ] || vid=$(find "$d" -name '*.webm' 2>/dev/null | head -1 || true)
  NAMES+=("$leg"); PNGS+=("$png"); STS+=("$(jq -r '.status // "?"' "$d/result.json" 2>/dev/null || echo '?')")
  VIDS+=("$vid")
done
n=${#NAMES[@]}
[ "$n" -gt 0 ] || { echo "no playwright evidence found — nothing to embed"; exit 0; }

# Indices to show. Default: all. Collapse to one when the two legs share an outcome (same
# status) — the screenshots are then redundant.
SHOW=(); for i in $(seq 0 $((n - 1))); do SHOW+=("$i"); done
COLLAPSED=0
if [ "$n" -eq 2 ] && [ "${STS[0]}" = "${STS[1]}" ]; then
  COLLAPSED=1
  main=0; for j in $(seq 0 $((n - 1))); do [ "${NAMES[$j]}" = trunk ] && main=$j; done # show trunk (current UI)
  SHOW=("$main")
fi

OUT=$(mktemp -d)
for i in "${SHOW[@]}"; do
  cp "${PNGS[$i]}" "$OUT/${NAMES[$i]}.png"
  [ -n "${VIDS[$i]}" ] && cp "${VIDS[$i]}" "$OUT/${NAMES[$i]}.webm" || true
done
if [ "$COLLAPSED" = 1 ]; then
  for i in $(seq 0 $((n - 1))); do
    [ -n "${VIDS[$i]}" ] || continue
    copied=0
    for shown in "${SHOW[@]}"; do [ "$shown" = "$i" ] && copied=1; done
    [ "$copied" = 1 ] || cp "${VIDS[$i]}" "$OUT/${NAMES[$i]}.webm"
  done
fi

if [ "${PUSH:-}" != "skip" ]; then
  : "${TOKEN:?TOKEN is required to push evidence}"
  EV=$(mktemp -d)
  git -C "$EV" init -q
  git -C "$EV" remote add origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  if git -C "$EV" fetch -q --depth 1 origin "$BRANCH" 2>/dev/null; then
    git -C "$EV" checkout -q FETCH_HEAD
  else
    git -C "$EV" checkout -q --orphan "$BRANCH"
    printf '# repro evidence\n\nInline images referenced by reproduce comments. Safe to prune at any\ntime — old comments then lose their inline images (the full evidence was in the run\nartifacts, which expire anyway).\n' > "$EV/README.md"
    git -C "$EV" add README.md
  fi
  mkdir -p "$EV/runs/$RUN_ID"
  cp "$OUT"/* "$EV/runs/$RUN_ID/"
  git -C "$EV" add "runs/$RUN_ID"
  git -C "$EV" -c user.name=github-actions -c user.email=actions@github.com \
    commit -q -m "evidence for run $RUN_ID"
  git -C "$EV" push -q origin "HEAD:refs/heads/$BRANCH"
fi

RAW="https://raw.githubusercontent.com/$REPO/$BRANCH/runs/$RUN_ID"
BLOCK=$(mktemp)
{
  echo
  echo "### Evidence"
  if [ "$COLLAPSED" = 1 ]; then
    i=${SHOW[0]}
    echo
    echo "**reported & trunk** — identical outcome (\`${STS[$i]}\`); showing the **${NAMES[$i]}** evidence (most up-to-date UI)."
    echo "![reported & trunk](${RAW}/${NAMES[$i]}.png)"
    if [ -n "${VIDS[$i]}" ]; then
      echo "▶ [Watch the ${NAMES[$i]} recording](${RAW}/${NAMES[$i]}.webm)"
    else
      for j in $(seq 0 $((n - 1))); do
        [ -n "${VIDS[$j]}" ] || continue
        echo "▶ [Watch the ${NAMES[$j]} narrated recording](${RAW}/${NAMES[$j]}.webm)"
      done
    fi
  else
    for i in "${SHOW[@]}"; do
      echo
      echo "**${NAMES[$i]}** (\`${STS[$i]}\`)"
      echo "![${NAMES[$i]}](${RAW}/${NAMES[$i]}.png)"
      if [ -n "${VIDS[$i]}" ]; then echo "▶ [Watch the ${NAMES[$i]} recording](${RAW}/${NAMES[$i]}.webm)"; fi
    done
  fi
  echo
  echo "_Screenshots + recordings above persist; the trace and interactive Playwright HTML report are in the \`repro-*\` run artifacts (they expire after 7 days)._"
} > "$BLOCK"

# Place the block where report.sh left the marker (right under the verdict); else append.
if grep -q '<!-- EVIDENCE -->' "$COMMENT"; then
  awk -v f="$BLOCK" '/<!-- EVIDENCE -->/{while ((getline l < f) > 0) print l; next} {print}' "$COMMENT" > "$COMMENT.new" && mv "$COMMENT.new" "$COMMENT"
else
  cat "$BLOCK" >> "$COMMENT"
fi
shown=""; for i in "${SHOW[@]}"; do shown="$shown ${NAMES[$i]}"; done
echo "embedded inline evidence:$shown (collapsed=$COLLAPSED)"
