#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../../.." && pwd)
classifier="$repo/.github/actions/repro-agent/bin/prepare/classify-issue.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/repro-agent-classify.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/assets"
printf 'fake screenshot\n' > "$tmp/assets/screenshot.txt"

cat > "$tmp/api.md" <<'MD'
# Admin API route returns wrong billing address

Calling `/api/order/01234567890123456789012345678901/billing-address` returns a JSON response
with status 500 instead of the expected billing address payload.
MD

api_class=$(ISSUE_MD="$tmp/api.md" ASSETS="$tmp/assets" bash "$classifier")
if [ "$api_class" != api ]; then
  echo "Expected raw API route with API/error wording and assets to classify as api, got $api_class"
  exit 1
fi

cat > "$tmp/visual.md" <<'MD'
# Storefront product slider card renders the wrong variant

The product slider on the storefront page renders the parent product card instead of the selected
variant. A screenshot is attached.
MD

visual_class=$(ISSUE_MD="$tmp/visual.md" ASSETS="$tmp/assets" bash "$classifier")
if [ "$visual_class" != visual ]; then
  echo "Expected screenshot-backed storefront rendering issue to classify as visual, got $visual_class"
  exit 1
fi

echo 'classify-issue tests passed'
