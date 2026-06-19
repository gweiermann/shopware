#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

ISSUE=${ISSUE:-30}
REPO=${REPO:-gweiermann/shopware}
UPSTREAM=${UPSTREAM:-shopware/shopware}
MAX_TURNS=${MAX_TURNS:-12}

bash .github/actions/repro-agent/local/scripts/reset-instance.sh --artifacts-only

if command -v gh >/dev/null 2>&1; then
  echo "Prefetching issue #$ISSUE from $REPO..."
  ISSUE="$ISSUE" REPO="$REPO" UPSTREAM="$UPSTREAM" GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
    bash .github/actions/repro-agent/bin/prepare/prefetch.sh
else
  echo "gh is not installed; writing minimal issue.md. Replace it with real issue context before an agent run."
  printf '# Issue %s\n\n(issue unavailable locally)\n' "$ISSUE" > issue.md
fi

if grep -qx '(issue unavailable)' issue.md; then
  cat <<EOF
Could not fetch issue #$ISSUE from $REPO with gh.
Fix gh authentication or write a real issue.md before running the simulated agent.
EOF
  exit 1
fi

VERSION=${VERSION:-}
if [ -z "$VERSION" ] && command -v gh >/dev/null 2>&1; then
  VERSION=$(ISSUE="$ISSUE" GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" bash .github/actions/repro-agent/bin/prepare/parse-version.sh | sed -n 's/^target_version=//p' | tail -1 || true)
fi

ISSUE="$ISSUE" VERSION="$VERSION" MAX_TURNS="$MAX_TURNS" \
  bash .github/actions/repro-agent/bin/prepare/build-context.sh
