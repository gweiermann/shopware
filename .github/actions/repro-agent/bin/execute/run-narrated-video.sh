#!/usr/bin/env bash
# Optional evidence-only Playwright pass. It never changes the deterministic verdict: it runs after
# a leg has already classified, writes separate narrated artifacts, and exits successfully when
# video evidence cannot be produced.
set -euo pipefail

REPRO_PLAN=${REPRO_PLAN:-reproduction-plan.json}
LEG_RESULT=${LEG_RESULT:-result.json}
TARGET=${TARGET:-trunk}
OUT=${OUT:-narrated-result.json}
JSON_REPORT=${PW_JSON_REPORT:-pw-report-narrated.json}
OUTPUT_DIR=${PW_OUTPUT_DIR:-test-results-narrated}
HTML_REPORT=${PW_HTML_REPORT:-playwright-report-narrated}
VIDEO_DIR=${REPRO_NARRATED_VIDEO_DIR:-narrated-video}

if [ ! -f "$REPRO_PLAN" ] || [ ! -f "$LEG_RESULT" ]; then
  echo "narrated video: missing plan or reported result; skipping"
  exit 0
fi

executor=$(jq -r '.executor // ""' "$LEG_RESULT" 2>/dev/null || echo "")
status=$(jq -r '.status // ""' "$LEG_RESULT" 2>/dev/null || echo "")
if [ "$executor" != playwright ] || { [ "$status" != reproduced ] && [ "$status" != not_reproduced ]; }; then
  echo "narrated video: $TARGET leg is ${executor:-unknown}/${status:-unknown}; skipping"
  exit 0
fi

if [ -z "${APP_URL:-}" ]; then
  echo "::warning::narrated video: APP_URL is not set; skipping"
  exit 0
fi

rm -rf "$OUTPUT_DIR" "$HTML_REPORT" "$JSON_REPORT" "$OUT" "$VIDEO_DIR" pw-stdout-narrated.txt pw-stderr-narrated.txt

REPRO_VIDEO_MODE=1 \
PW_OUTPUT_DIR="$OUTPUT_DIR" \
PW_HTML_REPORT="$HTML_REPORT" \
PW_JSON_REPORT="$JSON_REPORT" \
PW_STDOUT=pw-stdout-narrated.txt \
PW_STDERR=pw-stderr-narrated.txt \
REPRO_PLAN="$REPRO_PLAN" \
OUT="$OUT" \
TARGET="$TARGET" \
bash .github/actions/repro-agent/bin/execute/run-playwright.sh || {
  echo "::warning::narrated video: Playwright evidence pass failed; keeping deterministic verdict"
  exit 0
}

video=$(find "$OUTPUT_DIR" -name '*.webm' 2>/dev/null | head -1)
if [ -z "$video" ]; then
  echo "::warning::narrated video: no .webm was produced"
  exit 0
fi

mkdir -p "$VIDEO_DIR"
cp "$video" "$VIDEO_DIR/${TARGET}-narrated.webm"
echo "narrated video: wrote $VIDEO_DIR/${TARGET}-narrated.webm"
